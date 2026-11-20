use std::collections::VecDeque;
use std::fs::OpenOptions;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::ipc::CapabilityBuilder;
use tauri::{AppHandle, Manager, State, Url, WebviewWindow};
use tracing_subscriber::Layer;
use tracing_subscriber::layer::{Context, SubscriberExt};

use crate::local_port::LocalPort;

const LOG_CAPACITY: usize = 256;

#[derive(Clone, Default)]
pub struct Diagnostics(Arc<Mutex<VecDeque<LogEntry>>>);

#[derive(Serialize)]
struct LogEntry {
    unix_time_ms: u128,
    level: &'static str,
    source: String,
    line: Option<u32>,
}

fn unix_time() -> std::time::Duration {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
}

impl Diagnostics {
    pub fn record(&self, level: &'static str, source: impl Into<String>, line: Option<u32>) {
        let mut entries = self.0.lock().unwrap();
        if entries.len() == LOG_CAPACITY {
            entries.pop_front();
        }
        entries.push_back(LogEntry {
            unix_time_ms: unix_time().as_millis(),
            level,
            source: source.into(),
            line,
        });
    }
}

impl<S: tracing::Subscriber> Layer<S> for Diagnostics {
    fn on_event(&self, event: &tracing::Event<'_>, _: Context<'_, S>) {
        let meta = event.metadata();
        let level = match *meta.level() {
            tracing::Level::ERROR => "error",
            tracing::Level::WARN => "warn",
            _ => return,
        };
        // Event fields and formatted messages can contain data or credentials.
        if meta.target().starts_with("visarium") {
            self.record(level, meta.target(), meta.line());
        }
    }
}

pub fn setup(app: &mut tauri::App) -> tauri::Result<()> {
    let diagnostics = Diagnostics::default();
    diagnostics.record("info", "desktop.start", None);
    let _ = tracing::subscriber::set_global_default(
        tracing_subscriber::registry().with(diagnostics.clone()),
    );
    app.manage(diagnostics);
    #[cfg(all(target_os = "macos", feature = "alpha-updater"))]
    crate::alpha_update::setup(app)?;
    Ok(())
}

pub fn allow(app: &AppHandle, origin: &Url) -> tauri::Result<()> {
    // The custom IPC transport supplies only the origin. Each About command
    // checks the webview's current Settings path before doing any work.
    app.add_capability(
        CapabilityBuilder::new("desktop-about")
            .local(false)
            .remote(format!("{origin}*"))
            .window("main")
            .permission("allow-check-for-updates")
            .permission("allow-install-update")
            .permission("allow-collect-diagnostics")
            .permission("allow-mark-library-opened"),
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

#[tauri::command]
pub async fn check_for_updates(window: WebviewWindow) -> Result<serde_json::Value, String> {
    require_settings(&window)?;
    #[cfg(all(target_os = "macos", feature = "alpha-updater"))]
    {
        crate::alpha_update::check(window.app_handle()).await
    }
    #[cfg(not(all(target_os = "macos", feature = "alpha-updater")))]
    Ok(serde_json::json!({ "status": "unconfigured" }))
}

#[tauri::command]
pub async fn install_update(window: WebviewWindow, version: String) -> Result<(), String> {
    require_settings(&window)?;
    #[cfg(all(target_os = "macos", feature = "alpha-updater"))]
    {
        crate::alpha_update::install(&window, &version).await
    }
    #[cfg(not(all(target_os = "macos", feature = "alpha-updater")))]
    {
        let _ = version;
        Err("Updates are unavailable in this build.".into())
    }
}

#[tauri::command]
pub fn mark_library_opened(app: AppHandle, window: WebviewWindow) {
    #[cfg(all(target_os = "macos", feature = "alpha-updater"))]
    if window
        .url()
        .is_ok_and(|url| app.state::<LocalPort>().library().origin() == url.origin())
    {
        crate::alpha_update::mark_library_opened(&app);
    }
    #[cfg(not(all(target_os = "macos", feature = "alpha-updater")))]
    let _ = (app, window);
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
    let name = format!("visarium-diagnostics-{}.zip", unix_time().as_nanos());
    diagnostics.record("info", "desktop.collect_diagnostics", None);
    let manifest = serde_json::json!({
        "version": app.package_info().version.to_string(),
        "build": build,
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "protocolVersion": visarium::PROTOCOL_VERSION,
    });
    let entries = diagnostics.0.lock().unwrap();
    let path = directory.join(&name);
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|_| "Could not save the diagnostic bundle in Downloads.")?;
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        let mut archive = zip::ZipWriter::new(file);
        archive.start_file("system.json", zip::write::SimpleFileOptions::default())?;
        serde_json::to_writer_pretty(&mut archive, &manifest)?;
        archive.start_file("events.json", zip::write::SimpleFileOptions::default())?;
        serde_json::to_writer_pretty(&mut archive, &*entries)?;
        archive.finish()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(path);
        return Err("Could not write the diagnostic bundle.".into());
    }
    Ok(name)
}
