use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use chrono::{Datelike, Timelike};
use tauri::ipc::CapabilityBuilder;
use tauri::{AppHandle, Manager, State, Url, WebviewWindow};

use crate::local_port::LocalPort;

/// How many daily log files a diagnostics bundle carries.
const BUNDLE_LOG_FILES: usize = 3;

/// Where the logs are and when the app started, for the diagnostics bundle.
pub struct Diagnostics {
    logs: PathBuf,
    started: Instant,
}

pub fn setup(app: &mut tauri::App) -> tauri::Result<()> {
    let logs = app.path().app_log_dir()?;
    std::fs::create_dir_all(&logs)?;
    let level = std::env::var("VISARIUM_LOG_LEVEL")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "info".into());
    if let Err(e) = visarium::telemetry::init(visarium::telemetry::Options {
        level: &level,
        format: visarium::telemetry::Format::Text,
        file_dir: Some(&logs),
    }) {
        // There is no logger to tell; the app still works without one.
        eprintln!("logging is off: {e}");
    }
    tracing::info!(
        version = %app.package_info().version,
        os = std::env::consts::OS,
        arch = std::env::consts::ARCH,
        "desktop started"
    );
    app.manage(Diagnostics {
        logs,
        started: Instant::now(),
    });
    app.manage(ClientErrors::default());
    crate::update::setup(app)?;
    Ok(())
}

/// Lets `origin`'s pages report their uncaught errors to the desktop log: the
/// library's and every connected server's.
pub fn allow_client_errors(app: &AppHandle, origin: &Url) -> tauri::Result<()> {
    let id: String = origin
        .as_str()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    app.add_capability(
        CapabilityBuilder::new(format!("client-errors-{id}"))
            .local(false)
            .remote(format!("{origin}*"))
            .window("main")
            .permission("allow-log-client-error"),
    )
}

/// How many web UI errors a minute reach the log; a storm is counted instead.
const CLIENT_ERRORS_PER_MINUTE: u32 = 20;

#[derive(Default)]
pub struct ClientErrors(Mutex<Budget>);

#[derive(Default)]
struct Budget {
    minute: u64,
    logged: u32,
    dropped: u32,
}

impl ClientErrors {
    /// Whether an error in `minute` may be logged, and how many the previous
    /// minute dropped when this is the first of a new one.
    fn admit(&self, minute: u64) -> (bool, Option<u32>) {
        let mut budget = self.0.lock().unwrap();
        let mut dropped = None;
        if budget.minute != minute {
            dropped = Some(budget.dropped).filter(|n| *n > 0);
            *budget = Budget {
                minute,
                ..Default::default()
            };
        }
        if budget.logged < CLIENT_ERRORS_PER_MINUTE {
            budget.logged += 1;
            (true, dropped)
        } else {
            budget.dropped += 1;
            (false, dropped)
        }
    }
}

fn clipped(text: &str, max: usize) -> &str {
    let mut end = text.len().min(max);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// An uncaught error or unhandled rejection in the web UI, to the desktop log.
/// Any page of the library or a connected server may call it, so everything
/// is clipped and rationed here rather than trusted to the page.
#[tauri::command]
pub fn log_client_error(
    errors: State<'_, ClientErrors>,
    message: String,
    stack: Option<String>,
    route: String,
) {
    let minute = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        / 60;
    let (admitted, dropped) = errors.admit(minute);
    if let Some(dropped) = dropped {
        tracing::warn!(
            dropped,
            "more web UI errors than the log takes; these were dropped"
        );
    }
    if admitted {
        tracing::error!(
            message = clipped(&message, 1024),
            stack = clipped(stack.as_deref().unwrap_or(""), 8 * 1024),
            route = clipped(&route, 200),
            "web UI error"
        );
    }
}

pub fn allow(app: &AppHandle, origin: &Url) -> tauri::Result<()> {
    // The custom IPC transport supplies only the origin. Each About command
    // checks the webview's current Settings path before doing any work;
    // `update_flushed` only answers a question the app asked the library page.
    app.add_capability(
        CapabilityBuilder::new("desktop-about")
            .local(false)
            .remote(format!("{origin}*"))
            .window("main")
            .permission("allow-check-for-updates")
            .permission("allow-update-preferences")
            .permission("allow-update-flushed")
            .permission("allow-collect-diagnostics"),
    )
}

pub fn is_settings(app: &AppHandle, url: &Url) -> bool {
    app.try_state::<LocalPort>()
        .is_some_and(|port| port.library().origin() == url.origin() && url.path() == "/settings")
}

fn require_settings(window: &WebviewWindow) -> Result<(), String> {
    if window
        .url()
        .is_ok_and(|url| is_settings(window.app_handle(), &url))
    {
        Ok(())
    } else {
        Err("Open Settings in the desktop library to use this action.".into())
    }
}

/// Settings' Check for Updates. When there is one, the prompt window shows it.
#[tauri::command]
pub async fn check_for_updates(window: WebviewWindow) -> Result<serde_json::Value, String> {
    require_settings(&window)?;
    let available = crate::update::check(window.app_handle(), true).await?;
    Ok(serde_json::json!({ "status": if available { "available" } else { "current" } }))
}

/// Whether the app checks for updates on its own; `automatic` changes it.
#[tauri::command]
pub fn update_preferences(
    window: WebviewWindow,
    automatic: Option<bool>,
) -> Result<serde_json::Value, String> {
    require_settings(&window)?;
    let automatic = crate::update::automatic(window.app_handle(), automatic);
    Ok(serde_json::json!({ "automatic": automatic }))
}

/// The library page's answer when asked to save before a restart.
#[tauri::command]
pub fn update_flushed(app: AppHandle, window: WebviewWindow, pending: u32, failing: bool) {
    if window
        .url()
        .is_ok_and(|url| app.state::<LocalPort>().library().origin() == url.origin())
    {
        crate::update::flushed(&app, pending, failing);
    }
}

/// The prompt window's: what to show. Granted to that window only (capabilities/update.json).
#[tauri::command]
pub fn update_state(app: AppHandle) -> crate::update::View {
    crate::update::state(&app)
}

/// The prompt window's: restart, quit, later, skip or download, for `version`.
#[tauri::command]
pub async fn update_choose(app: AppHandle, choice: String, version: String) -> Result<(), String> {
    crate::update::choose(&app, &choice, &version).await
}

#[tauri::command]
pub fn collect_diagnostics(
    window: WebviewWindow,
    diagnostics: State<'_, Diagnostics>,
    build: String,
) -> Result<String, String> {
    require_settings(&window)?;
    if build.len() != 15
        || !build
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'.')
    {
        return Err("The build identifier is invalid.".into());
    }
    let app = window.app_handle();
    let directory = app
        .path()
        .download_dir()
        .map_err(|_| "Downloads is unavailable.")?;
    let unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let name = format!("visarium-diagnostics-{}.zip", unix.as_nanos());
    let now = chrono::Local::now();
    let manifest = serde_json::json!({
        "version": app.package_info().version.to_string(),
        "build": build,
        "os": std::env::consts::OS,
        "osVersion": os_version(),
        "arch": std::env::consts::ARCH,
        "protocolVersion": visarium::PROTOCOL_VERSION,
        "utcOffset": now.offset().to_string(),
        "createdAt": now.to_utc().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        "uptimeSeconds": diagnostics.started.elapsed().as_secs(),
    });
    let path = directory.join(&name);
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| {
            tracing::warn!(error = %e, "could not create the diagnostics bundle");
            "Could not save the diagnostic bundle in Downloads."
        })?;
    let result = write_bundle(file, &manifest, &diagnostics.logs, now);
    if let Err(e) = result {
        tracing::warn!(error = %e, "could not write the diagnostics bundle");
        // Best effort: a half-written zip in Downloads is only clutter.
        let _ = std::fs::remove_file(path);
        return Err("Could not write the diagnostic bundle.".into());
    }
    tracing::info!("diagnostics bundle saved");
    Ok(name)
}

/// `system.json` and the newest log files, every entry dated `now`.
fn write_bundle(
    file: File,
    manifest: &serde_json::Value,
    logs: &Path,
    now: chrono::DateTime<chrono::Local>,
) -> Result<(), Box<dyn std::error::Error>> {
    // Zip keeps local time with no zone, which is how Finder shows it.
    let stamp = zip::DateTime::from_date_and_time(
        now.year() as u16,
        now.month() as u8,
        now.day() as u8,
        now.hour() as u8,
        now.minute() as u8,
        now.second() as u8,
    )?;
    let options = zip::write::SimpleFileOptions::default().last_modified_time(stamp);
    let mut archive = zip::ZipWriter::new(file);
    archive.start_file("system.json", options)?;
    serde_json::to_writer_pretty(&mut archive, manifest)?;
    for log in recent_logs(logs)? {
        let name = log.file_name().unwrap_or_default().to_string_lossy();
        archive.start_file(format!("logs/{name}"), options)?;
        // Today's file may still be growing; a cut last line is fine.
        std::io::copy(&mut File::open(&log)?, &mut archive)?;
    }
    archive.finish()?;
    Ok(())
}

/// The newest daily log files, oldest first.
fn recent_logs(dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    let prefix = format!("{}.", visarium::telemetry::LOG_FILE_PREFIX);
    let mut logs: Vec<PathBuf> = std::fs::read_dir(dir)?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| {
            path.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(&prefix) && n.ends_with(".log"))
        })
        .collect();
    // Named by date (visarium.2026-11-20.log), so names sort by day.
    logs.sort();
    let skip = logs.len().saturating_sub(BUNDLE_LOG_FILES);
    Ok(logs.split_off(skip))
}

fn os_version() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("sw_vers")
            .arg("-productVersion")
            .output()
            .ok()?;
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }
    #[cfg(not(target_os = "macos"))]
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bundle_holds_system_json_and_the_logs_dated_now() {
        let dir = std::env::temp_dir().join(format!("visarium-bundle-{}", std::process::id()));
        let logs = dir.join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(logs.join("visarium.2026-11-20.log"), "a line\n").unwrap();
        let path = dir.join("bundle.zip");
        let now = chrono::Local::now();
        write_bundle(
            File::create(&path).unwrap(),
            &serde_json::json!({ "version": "1" }),
            &logs,
            now,
        )
        .unwrap();

        let mut zip = zip::ZipArchive::new(File::open(&path).unwrap()).unwrap();
        let names: Vec<String> = (0..zip.len())
            .map(|i| zip.by_index(i).unwrap().name().unwrap().to_string())
            .collect();
        assert_eq!(names, ["system.json", "logs/visarium.2026-11-20.log"]);
        for i in 0..zip.len() {
            let entry = zip.by_index(i).unwrap();
            let dated = entry.last_modified().unwrap();
            assert_eq!(
                (dated.year(), dated.month(), dated.day(), dated.hour()),
                (
                    now.year() as u16,
                    now.month() as u8,
                    now.day() as u8,
                    now.hour() as u8
                ),
                "{} is dated {dated:?}, not now",
                entry.name().unwrap()
            );
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_storm_of_web_errors_is_rationed_and_counted() {
        let errors = ClientErrors::default();
        let admitted: Vec<bool> = (0..25).map(|_| errors.admit(7).0).collect();
        assert_eq!(admitted.iter().filter(|a| **a).count(), 20);
        assert!(admitted[..20].iter().all(|a| *a), "the first 20 get in");
        assert_eq!(
            errors.admit(8),
            (true, Some(5)),
            "the next minute reports 5 dropped"
        );
        assert_eq!(
            errors.admit(9),
            (true, None),
            "a quiet minute reports nothing"
        );
    }

    #[test]
    fn clipping_keeps_whole_characters() {
        assert_eq!(clipped("héllo", 2), "h");
        assert_eq!(clipped("abc", 10), "abc");
    }

    #[test]
    fn a_bundle_takes_the_three_newest_log_files() {
        let dir = std::env::temp_dir().join(format!("visarium-logs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for name in [
            "visarium.2026-11-16.log",
            "visarium.2026-11-17.log",
            "visarium.2026-11-18.log",
            "visarium.2026-11-19.log",
            "other.log",
            "visarium.2026-11-19.txt",
        ] {
            std::fs::write(dir.join(name), "").unwrap();
        }
        let names: Vec<String> = recent_logs(&dir)
            .unwrap()
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(
            names,
            [
                "visarium.2026-11-17.log",
                "visarium.2026-11-18.log",
                "visarium.2026-11-19.log"
            ]
        );
    }
}
