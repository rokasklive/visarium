//! Updates: found on their own, announced in a prompt window, installed when
//! the user chooses (openspec desktop/updates).
//!
//! Release builds check the GitHub release feed (`plugins.updater` in
//! tauri.conf.json); the `alpha-updater` feature points the same flow at the
//! loopback rehearsal feed and trusts only its pinned CA.
//!
//! Everything lives here, natively: the schedule, the preferences, the
//! download and the install. The prompt (`static/update.html`, its own
//! window, so it shows over any page) renders [`View`] and sends choices.
//! Before the app is replaced, the library page's pending edits are sent and
//! the embedded library answers what is in flight.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{App, AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::local_port::LocalPort;

const FIRST_CHECK: Duration = Duration::from_secs(10);
const EVERY: Duration = Duration::from_secs(6 * 3600);
const REMIND_AFTER_SECS: u64 = 24 * 3600;
const FLUSH_WAIT: Duration = Duration::from_secs(10);
const DRAIN_WAIT: Duration = Duration::from_secs(10);
const PROMPT: &str = "update";
pub const RELEASES: &str = "https://github.com/rokasklive/visarium/releases";

pub struct Updates {
    file: PathBuf,
    state: Mutex<State>,
    /// The library page's answer to "are your edits saved?", during a restart.
    flushed: Mutex<Option<tokio::sync::oneshot::Sender<bool>>>,
}

#[derive(Default)]
struct State {
    prefs: Prefs,
    offer: Option<Offer>,
    phase: Phase,
    message: Option<String>,
    progress: (u64, Option<u64>),
    /// Update on Quit was chosen: install whatever is staged at exit.
    on_quit: bool,
    /// Downloaded and verified, not yet installed.
    staged: Option<(Update, Vec<u8>)>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Phase {
    #[default]
    Idle,
    /// An offer, waiting for a choice.
    Available,
    /// Nothing to offer, or the check failed: `message` says which.
    Current,
    Downloading,
    /// Verified and waiting for quit.
    Staged,
    Saving,
    Installing,
}

#[derive(Clone)]
struct Offer {
    update: Update,
    notes: Vec<Section>,
    truncated: bool,
}

/// What the prompt shows.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    phase: Phase,
    version: Option<String>,
    current: String,
    notes: Vec<Section>,
    truncated: bool,
    can_install: bool,
    message: Option<String>,
    received: u64,
    total: Option<u64>,
    on_quit: bool,
    releases: &'static str,
}

// ---------------------------------------------------------------- preferences

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Prefs {
    automatic: bool,
    skipped: Option<String>,
    /// Unix seconds before which automatic checks stay quiet.
    remind_after: Option<u64>,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs {
            automatic: true,
            skipped: None,
            remind_after: None,
        }
    }
}

fn load(file: &Path) -> Prefs {
    match std::fs::read(file) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
            tracing::warn!(error = %e, "update preferences unreadable; using defaults");
            Prefs::default()
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Prefs::default(),
        Err(e) => {
            tracing::warn!(error = %e, "update preferences unreadable; using defaults");
            Prefs::default()
        }
    }
}

fn save(file: &Path, prefs: &Prefs) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let temp = file.with_extension("json.tmp");
    std::fs::write(&temp, serde_json::to_vec_pretty(prefs)?)?;
    std::fs::rename(temp, file)
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// `major.minor.patch`, with or without a `v`.
// ponytail: pre-release and build suffixes are ignored; releases have none.
fn parse(version: &str) -> Option<(u64, u64, u64)> {
    let core = version
        .trim()
        .trim_start_matches('v')
        .split(['-', '+'])
        .next()?;
    let mut parts = core.split('.').map(|p| p.parse().ok());
    Some((parts.next()??, parts.next()??, parts.next()??))
}

fn newer(a: &str, b: &str) -> bool {
    matches!((parse(a), parse(b)), (Some(a), Some(b)) if a > b)
}

/// Whether an automatic check keeps quiet about `version`.
fn suppressed(prefs: &Prefs, version: &str, now: u64) -> bool {
    prefs
        .skipped
        .as_deref()
        .is_some_and(|skipped| !newer(version, skipped))
        || prefs.remind_after.is_some_and(|after| now < after)
}

// ---------------------------------------------------------------- notes

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Section {
    version: String,
    lines: Vec<String>,
}

/// The feed's notes (`## vX.Y.Z` sections, newest first) cut to what a user
/// on `installed` gains from `offered`, and whether older ones are missing.
fn sections(notes: &str, installed: &str, offered: &str) -> (Vec<Section>, bool) {
    let mut all: Vec<Section> = Vec::new();
    for line in notes.lines() {
        let line = line.trim_end();
        if let Some(heading) = line.strip_prefix("## ") {
            let version = heading.split_whitespace().next().unwrap_or("");
            if parse(version).is_some() {
                all.push(Section {
                    version: version.trim_start_matches('v').to_string(),
                    lines: Vec::new(),
                });
                continue;
            }
        }
        if line.trim().is_empty() {
            continue;
        }
        match all.last_mut() {
            Some(section) => section.lines.push(line.to_string()),
            // Notes without headings: all of it is the offered version's.
            None => all.push(Section {
                version: offered.trim_start_matches('v').to_string(),
                lines: vec![line.to_string()],
            }),
        }
    }
    let headed = notes.lines().any(|l| {
        l.strip_prefix("## ")
            .and_then(|h| h.split_whitespace().next())
            .and_then(parse)
            .is_some()
    });
    // The feed reaches back far enough when it holds the installed version or older.
    let complete = headed && all.iter().any(|s| !newer(&s.version, installed));
    let mut kept: Vec<Section> = all
        .into_iter()
        .filter(|s| newer(&s.version, installed) && !newer(&s.version, offered))
        .collect();
    kept.sort_by_key(|s| std::cmp::Reverse(parse(&s.version)));
    (kept, !complete)
}

// ---------------------------------------------------------------- setup

pub fn setup(app: &mut App) -> tauri::Result<()> {
    app.handle()
        .plugin(tauri_plugin_updater::Builder::new().build())?;
    let file = app.path().app_config_dir()?.join("updates.json");
    let prefs = load(&file);
    app.manage(Updates {
        file,
        state: Mutex::new(State {
            prefs,
            ..Default::default()
        }),
        flushed: Mutex::new(None),
    });
    let app = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            let automatic = app.state::<Updates>().state.lock().unwrap().prefs.automatic;
            if automatic {
                let _ = check(&app, false).await;
            }
            tokio::time::sleep(EVERY).await;
        }
    });
    Ok(())
}

/// Refuses navigation while the app is being replaced.
pub fn allow_navigation(app: &AppHandle, _url: &Url) -> bool {
    app.state::<Updates>().state.lock().unwrap().phase != Phase::Installing
}

fn view(app: &AppHandle, s: &State) -> View {
    View {
        phase: s.phase,
        version: s.offer.as_ref().map(|o| o.update.version.clone()),
        current: app.package_info().version.to_string(),
        notes: s
            .offer
            .as_ref()
            .map(|o| o.notes.clone())
            .unwrap_or_default(),
        truncated: s.offer.as_ref().is_some_and(|o| o.truncated),
        can_install: can_replace_itself(),
        message: s.message.clone(),
        received: s.progress.0,
        total: s.progress.1,
        on_quit: s.on_quit,
        releases: RELEASES,
    }
}

/// Changes the state and tells the prompt.
fn change<R>(app: &AppHandle, f: impl FnOnce(&mut State) -> R) -> R {
    let updates = app.state::<Updates>();
    let (result, view) = {
        let mut state = updates.state.lock().unwrap();
        let result = f(&mut state);
        (result, view(app, &state))
    };
    let _ = app.emit_to(PROMPT, "update://state", view);
    result
}

fn persist(app: &AppHandle) {
    let updates = app.state::<Updates>();
    let prefs = updates.state.lock().unwrap().prefs.clone();
    if let Err(e) = save(&updates.file, &prefs) {
        tracing::warn!(error = %e, "could not save update preferences");
    }
}

pub fn automatic(app: &AppHandle, value: Option<bool>) -> bool {
    let Some(value) = value else {
        return app.state::<Updates>().state.lock().unwrap().prefs.automatic;
    };
    change(app, |s| s.prefs.automatic = value);
    persist(app);
    value
}

// ---------------------------------------------------------------- the prompt

fn open_prompt(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(PROMPT) {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let builder = || {
        WebviewWindowBuilder::new(app, PROMPT, WebviewUrl::App("update.html".into()))
            .title("Software Update")
            .inner_size(560.0, 600.0)
            .min_inner_size(440.0, 420.0)
            .center()
            .focused(true)
            // Only the bundled prompt; its links go to the system browser.
            .on_navigation(|url| {
                !matches!(url.scheme(), "http" | "https")
                    || url.host_str() == Some("tauri.localhost")
            })
            .on_new_window(|url, _| {
                if url.scheme() == "https" {
                    crate::open_in_browser_or_log(&url);
                }
                tauri::webview::NewWindowResponse::Deny
            })
    };
    // In front of the main window, and moving with it.
    let builder = match app.get_webview_window("main") {
        Some(main) => builder().parent(&main).unwrap_or_else(|_| builder()),
        None => builder(),
    };
    if let Err(e) = builder.build() {
        tracing::warn!(error = %e, "could not open the update prompt");
    }
}

fn close_prompt(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(PROMPT) {
        let _ = window.destroy();
    }
}

/// The prompt's close control and Escape: Remind Me Later, unless a choice is
/// already under way. Closing the main window closes the prompt too.
pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    let app = window.app_handle();
    if window.label() == "main" {
        close_prompt(app);
    } else if window.label() == PROMPT {
        api.prevent_close();
        dismiss(app);
    }
}

fn dismiss(app: &AppHandle) {
    let close = change(app, |s| match s.phase {
        Phase::Available => {
            s.prefs.remind_after = Some(now() + REMIND_AFTER_SECS);
            s.offer = None;
            s.phase = Phase::Idle;
            true
        }
        // Keeps downloading, and installs at quit instead.
        Phase::Downloading => {
            s.on_quit = true;
            true
        }
        Phase::Saving | Phase::Installing => false,
        Phase::Current | Phase::Idle | Phase::Staged => {
            if s.phase == Phase::Current {
                s.phase = Phase::Idle;
            }
            true
        }
    });
    persist(app);
    if close {
        close_prompt(app);
    }
}

pub fn state(app: &AppHandle) -> View {
    let updates = app.state::<Updates>();
    let state = updates.state.lock().unwrap();
    view(app, &state)
}

// ---------------------------------------------------------------- checking

async fn offered_update(
    app: &AppHandle,
) -> Result<Option<Update>, Box<dyn std::error::Error + Send + Sync>> {
    let builder = app.updater_builder().timeout(Duration::from_secs(30));
    #[cfg(feature = "alpha-updater")]
    let builder = {
        let ca = std::fs::read(app.path().resource_dir()?.join("alpha-feed.pem"))?;
        let certificate = reqwest::Certificate::from_pem(&ca)?;
        builder.configure_client(move |client| {
            client
                .tls_certs_only([certificate.clone()])
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
        })
    };
    Ok(builder.build()?.check().await?)
}

/// Checks the feed. A manual check offers even a skipped or deferred version;
/// an automatic one keeps quiet about those and about failures. Whether there
/// is an update, in which case the prompt is open.
pub async fn check(app: &AppHandle, manual: bool) -> Result<bool, String> {
    let updates = app.state::<Updates>();
    let busy = {
        let s = updates.state.lock().unwrap();
        s.on_quit || !matches!(s.phase, Phase::Idle | Phase::Available | Phase::Current)
    };
    if busy {
        if manual {
            open_prompt(app);
        }
        return Ok(true);
    }
    match offered_update(app).await {
        Err(e) => {
            tracing::warn!(error = %e, manual, "update check failed");
            Err(CHECK_FAILED.into())
        }
        Ok(None) => {
            tracing::info!(manual, "no update available");
            Ok(false)
        }
        Ok(Some(update)) => {
            tracing::info!(version = %update.version, manual, "update available");
            let quiet = {
                let s = updates.state.lock().unwrap();
                !manual && suppressed(&s.prefs, &update.version, now())
            };
            if quiet {
                tracing::info!(version = %update.version, "update skipped or deferred");
                return Ok(true);
            }
            let (notes, truncated) = sections(
                update.body.as_deref().unwrap_or(""),
                &update.current_version,
                &update.version,
            );
            change(app, |s| {
                s.offer = Some(Offer {
                    update,
                    notes,
                    truncated,
                });
                s.phase = Phase::Available;
                s.message = None;
            });
            open_prompt(app);
            Ok(true)
        }
    }
}

/// The app menu's Check for Updates…: the prompt opens whatever the answer.
pub fn check_from_menu(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let message = match check(&app, true).await {
            Ok(true) => return,
            Ok(false) => "Visarium is up to date.".to_string(),
            Err(message) => message,
        };
        change(&app, |s| {
            s.offer = None;
            s.phase = Phase::Current;
            s.message = Some(message);
        });
        open_prompt(&app);
    });
}

// ---------------------------------------------------------------- choosing

pub async fn choose(app: &AppHandle, choice: &str, version: &str) -> Result<(), String> {
    if choice == "later" {
        dismiss(app);
        return Ok(());
    }
    let offer = app.state::<Updates>().state.lock().unwrap().offer.clone();
    let offer = offer
        .filter(|o| o.update.version == version)
        .ok_or("The offered version changed. Check for updates again.")?;
    match choice {
        "skip" => {
            change(app, |s| {
                s.prefs.skipped = Some(offer.update.version.clone());
                s.prefs.remind_after = None;
                s.offer = None;
                s.phase = Phase::Idle;
            });
            persist(app);
            close_prompt(app);
            tracing::info!(version, "update skipped");
        }
        "download" => {
            crate::open_in_browser_or_log(&RELEASES.parse().expect("a URL"));
            dismiss(app);
        }
        "quit" => {
            let staged = change(app, |s| {
                s.on_quit = true;
                s.message = None;
                if s.staged.is_some() {
                    s.phase = Phase::Staged;
                }
                s.staged.is_some()
            });
            close_prompt(app);
            if !staged {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    match download(&app, &offer.update).await {
                        Ok(bytes) => change(&app, |s| {
                            s.staged = Some((offer.update, bytes));
                            s.phase = Phase::Staged;
                        }),
                        Err(message) => change(&app, |s| {
                            s.on_quit = false;
                            s.offer = None;
                            s.phase = Phase::Idle;
                            s.message = Some(message);
                        }),
                    }
                });
            }
        }
        "restart" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { restart(&app, offer.update).await });
        }
        _ => return Err("Unknown choice.".into()),
    }
    Ok(())
}

async fn download(app: &AppHandle, update: &Update) -> Result<Vec<u8>, String> {
    change(app, |s| {
        s.phase = Phase::Downloading;
        s.progress = (0, None);
        s.message = None;
    });
    let mut received = 0u64;
    let mut told = 0u64;
    let progress = app.clone();
    // The plugin verifies the signature before handing the bytes back.
    let bytes = update
        .download(
            move |chunk, total| {
                received += chunk as u64;
                if received - told >= 256 * 1024 || Some(received) == total {
                    told = received;
                    change(&progress, |s| s.progress = (received, total));
                }
            },
            || {},
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, version = %update.version, "update download failed");
            DOWNLOAD_FAILED.to_string()
        })?;
    tracing::info!(version = %update.version, "update downloaded and verified");
    Ok(bytes)
}

async fn restart(app: &AppHandle, update: Update) {
    let staged = change(app, |s| {
        s.on_quit = false;
        s.staged.take()
    });
    let (update, bytes) = match staged {
        Some(staged) => staged,
        None => match download(app, &update).await {
            Ok(bytes) => (update, bytes),
            Err(message) => {
                change(app, |s| {
                    s.phase = Phase::Available;
                    s.message = Some(message);
                });
                return;
            }
        },
    };
    // The prompt was closed while downloading: that made it Update on Quit.
    let later = change(app, |s| {
        if s.on_quit {
            s.phase = Phase::Staged;
            s.staged = Some((update.clone(), bytes.clone()));
        }
        s.on_quit
    });
    if later {
        return;
    }
    change(app, |s| s.phase = Phase::Saving);
    let prepared = match prepare(&bytes) {
        Ok(prepared) => prepared,
        Err(e) => {
            tracing::error!(error = %e, version = %update.version, "update could not be prepared");
            change(app, |s| {
                s.phase = Phase::Available;
                s.message = Some(INSTALL_FAILED.into());
            });
            return;
        }
    };
    if let Err(message) = save_work(app).await {
        change(app, |s| {
            s.phase = Phase::Available;
            s.message = Some(message);
            s.staged = Some((update, bytes));
        });
        return;
    }
    change(app, |s| s.phase = Phase::Installing);
    let version = update.version.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || commit(prepared, &update, &bytes)).await;
    match result {
        Ok(Ok(())) => tracing::info!(version, "update installed; restarting"),
        // The library has stopped serving, so the app restarts either way:
        // as the version it was, which offers the update again.
        Ok(Err(e)) => tracing::error!(error = %e, version, "update install failed; restarting"),
        Err(e) => tracing::error!(error = %e, version, "update install failed; restarting"),
    }
    app.request_restart();
}

/// Sends the library page's pending edits, leaves whatever page is open, and
/// lets the embedded library answer what is in flight.
async fn save_work(app: &AppHandle) -> Result<(), String> {
    if let Some(main) = app.get_webview_window("main") {
        let library = app.state::<LocalPort>().library();
        if main.url().is_ok_and(|url| url.origin() == library.origin()) {
            let (tx, rx) = tokio::sync::oneshot::channel();
            *app.state::<Updates>().flushed.lock().unwrap() = Some(tx);
            if let Err(e) = main.eval(FLUSH) {
                tracing::warn!(error = %e, "could not ask the library page to save");
                return Err(EDITS_NOT_SAVED.into());
            }
            if !matches!(tokio::time::timeout(FLUSH_WAIT, rx).await, Ok(Ok(true))) {
                tracing::warn!("the library page's edits were not saved; update deferred");
                return Err(EDITS_NOT_SAVED.into());
            }
        }
        crate::navigate_or_log(&main, crate::GREETING.parse().expect("a URL"));
        // A server's page sends what it holds as it unloads (keepalive).
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    if !app.state::<LocalPort>().shutdown(DRAIN_WAIT).await {
        tracing::warn!("the library still had requests in flight when the update began");
    }
    Ok(())
}

/// Sent to the library page: run its pre-restart hook (`web/src/api/desktop.ts`)
/// and say whether everything is saved.
const FLUSH: &str = "(async () => {\
  let r = { pending: 0, failing: false };\
  try { if (window.__visariumBeforeRestart) r = await window.__visariumBeforeRestart(); }\
  catch { r = { pending: 1, failing: true }; }\
  await window.__TAURI_INTERNALS__.invoke('update_flushed', { pending: r.pending, failing: r.failing });\
})();";

/// The library page's answer to [`FLUSH`].
pub fn flushed(app: &AppHandle, pending: u32, failing: bool) {
    if let Some(tx) = app.state::<Updates>().flushed.lock().unwrap().take() {
        let _ = tx.send(pending == 0 && !failing);
    }
}

/// Update on Quit: installs what is staged as the app exits.
pub fn install_on_exit(app: &AppHandle) {
    let updates = app.state::<Updates>();
    let staged = {
        let mut s = updates.state.lock().unwrap();
        if !s.on_quit {
            return;
        }
        s.staged.take()
    };
    let Some((update, bytes)) = staged else {
        tracing::info!("quit before the update was ready; it is offered again next launch");
        return;
    };
    tauri::async_runtime::block_on(app.state::<LocalPort>().shutdown(DRAIN_WAIT));
    let version = update.version.clone();
    match prepare(&bytes).and_then(|prepared| commit(prepared, &update, &bytes)) {
        Ok(()) => tracing::info!(version, "update installed at quit"),
        Err(e) => tracing::error!(error = %e, version, "update install at quit failed"),
    }
}

// ---------------------------------------------------------------- installing

#[cfg(feature = "alpha-updater")]
const CHECK_FAILED: &str =
    "Could not check for updates. Check that the alpha feed is running and try again.";
#[cfg(not(feature = "alpha-updater"))]
const CHECK_FAILED: &str = "Could not check for updates. Check your connection and try again.";

const DOWNLOAD_FAILED: &str =
    "The update could not be downloaded or verified. Visarium is unchanged.";
const EDITS_NOT_SAVED: &str = "Your latest edits could not be saved yet, so Visarium did not restart. Choose Update on Quit, or try again in a moment.";

#[cfg(target_os = "macos")]
const INSTALL_FAILED: &str = "Could not replace Visarium. The app must be in a writable location on a volume that supports atomic replacement.";
#[cfg(not(target_os = "macos"))]
const INSTALL_FAILED: &str =
    "Could not install the update. Download it from the releases page instead.";

/// The updater replaces a macOS bundle, a Windows install or an AppImage, but
/// not a .deb: a package manager owns that file.
fn can_replace_itself() -> bool {
    cfg!(not(target_os = "linux")) || std::env::var_os("APPIMAGE").is_some()
}

/// The verified bundle unpacked beside the running one, ready to swap in, so
/// a location that cannot take it fails before anything has stopped.
#[cfg(target_os = "macos")]
struct Prepared {
    _staging: tempfile::TempDir,
    replacement: PathBuf,
    current: PathBuf,
}
#[cfg(not(target_os = "macos"))]
struct Prepared;

#[cfg(target_os = "macos")]
fn prepare(bytes: &[u8]) -> std::io::Result<Prepared> {
    let executable = std::env::current_exe()?;
    let app = executable
        .ancestors()
        .nth(3)
        .filter(|path| path.extension().is_some_and(|ext| ext == "app"))
        .ok_or_else(|| {
            std::io::Error::other("Visarium is not running from an application bundle")
        })?;
    let parent = app
        .parent()
        .ok_or_else(|| std::io::Error::other("Missing app parent"))?;
    let staging = tempfile::tempdir_in(parent)?;
    tar::Archive::new(flate2::read::GzDecoder::new(bytes)).unpack(staging.path())?;
    let replacement = staging.path().join(app.file_name().unwrap());
    if !replacement.join("Contents/Info.plist").is_file() {
        return Err(std::io::Error::other("Missing replacement application"));
    }
    Ok(Prepared {
        replacement,
        current: app.to_path_buf(),
        _staging: staging,
    })
}

#[cfg(not(target_os = "macos"))]
fn prepare(_bytes: &[u8]) -> std::io::Result<Prepared> {
    Ok(Prepared)
}

#[cfg(target_os = "macos")]
fn commit(prepared: Prepared, _update: &Update, _bytes: &[u8]) -> std::io::Result<()> {
    swap_paths(&prepared.replacement, &prepared.current)
}

/// Windows runs the NSIS installer, which closes the app; Linux replaces the AppImage.
#[cfg(not(target_os = "macos"))]
fn commit(_prepared: Prepared, update: &Update, bytes: &[u8]) -> std::io::Result<()> {
    update.install(bytes).map_err(std::io::Error::other)
}

#[cfg(target_os = "macos")]
fn swap_paths(replacement: &std::path::Path, current: &std::path::Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let replacement = CString::new(replacement.as_os_str().as_bytes())?;
    let current = CString::new(current.as_os_str().as_bytes())?;
    // Both complete bundles are on the same volume. If the swap fails, the
    // current bundle is still in place and there is no elevation attempt.
    let result = unsafe {
        libc::renameatx_np(
            libc::AT_FDCWD,
            replacement.as_ptr(),
            libc::AT_FDCWD,
            current.as_ptr(),
            libc::RENAME_SWAP,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preferences_default_when_missing_or_corrupt_and_round_trip() {
        let dir = tempfile_dir();
        let file = dir.join("updates.json");
        assert_eq!(load(&file), Prefs::default());
        assert!(Prefs::default().automatic);
        std::fs::write(&file, "{not json").unwrap();
        assert_eq!(load(&file), Prefs::default());
        let prefs = Prefs {
            automatic: false,
            skipped: Some("0.3.0".into()),
            remind_after: Some(42),
        };
        save(&file, &prefs).unwrap();
        assert_eq!(load(&file), prefs);
        // A file from a build that knew fewer fields keeps the defaults for the rest.
        std::fs::write(&file, r#"{"skipped":"0.3.0"}"#).unwrap();
        assert!(load(&file).automatic);
        let _ = std::fs::remove_dir_all(dir);
    }

    fn tempfile_dir() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("visarium-updates-{}-{}", std::process::id(), now()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn compares_versions() {
        assert!(newer("0.3.1", "0.3.0"));
        assert!(newer("v1.0.0", "0.9.9"));
        assert!(newer("0.10.0", "0.9.0"));
        assert!(!newer("0.3.0", "0.3.0"));
        assert!(!newer("junk", "0.1.0"));
    }

    #[test]
    fn a_skip_or_a_deferral_quiets_only_what_it_should() {
        let skipped = Prefs {
            skipped: Some("0.3.0".into()),
            ..Default::default()
        };
        assert!(suppressed(&skipped, "0.3.0", 0));
        assert!(
            !suppressed(&skipped, "0.3.1", 0),
            "a newer version than the skipped one prompts"
        );
        let deferred = Prefs {
            remind_after: Some(100),
            ..Default::default()
        };
        assert!(suppressed(&deferred, "0.3.0", 99));
        assert!(!suppressed(&deferred, "0.3.0", 100));
        assert!(!suppressed(&Prefs::default(), "0.3.0", 0));
    }

    const FEED: &str = "## v0.4.0\n\n- Four\n- Four again\n\n## v0.3.0\n\n- Three\n\n## v0.2.0\n\n- Two\n\n## v0.1.0\n\n- One";

    #[test]
    fn notes_cover_every_version_gained_newest_first() {
        let (notes, truncated) = sections(FEED, "0.1.0", "0.4.0");
        let versions: Vec<_> = notes.iter().map(|s| s.version.as_str()).collect();
        assert_eq!(versions, ["0.4.0", "0.3.0", "0.2.0"]);
        assert_eq!(notes[0].lines, ["- Four", "- Four again"]);
        assert!(!truncated);
    }

    #[test]
    fn notes_that_do_not_reach_the_installed_version_are_truncated() {
        let (notes, truncated) = sections(FEED, "0.0.5", "0.4.0");
        assert_eq!(notes.len(), 4);
        assert!(truncated);
    }

    #[test]
    fn notes_without_headings_belong_to_the_offered_version() {
        let (notes, truncated) = sections("- Something\n- Else", "0.1.0", "v0.2.0");
        assert_eq!(
            notes,
            [Section {
                version: "0.2.0".into(),
                lines: vec!["- Something".into(), "- Else".into()]
            }]
        );
        assert!(truncated);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn swaps_bundles_without_leaving_the_install_path_empty() {
        let dir = tempfile::tempdir().unwrap();
        let current = dir.path().join("current.app");
        let replacement = dir.path().join("replacement.app");
        std::fs::write(&current, "old").unwrap();
        std::fs::write(&replacement, "new").unwrap();
        assert!(swap_paths(&dir.path().join("absent.app"), &current).is_err());
        assert_eq!(std::fs::read_to_string(&current).unwrap(), "old");
        swap_paths(&replacement, &current).unwrap();
        assert_eq!(std::fs::read_to_string(&current).unwrap(), "new");
        assert_eq!(std::fs::read_to_string(&replacement).unwrap(), "old");
    }
}
