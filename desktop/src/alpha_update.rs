//! Only the local Settings page can use this rehearsal feed. Checks and
//! installation stay inside the app, with no privileged installer fallback.

use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{App, AppHandle, Manager, Url, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::about::{self, Diagnostics};

#[derive(Default)]
struct UpdateState {
    opened_library: bool,
    installing: bool,
}

pub fn setup(app: &mut App) -> tauri::Result<()> {
    app.handle()
        .plugin(tauri_plugin_updater::Builder::new().build())?;
    app.manage(Mutex::new(UpdateState::default()));
    Ok(())
}

pub fn allow_navigation(app: &AppHandle, url: &Url) -> bool {
    let state = app.state::<Mutex<UpdateState>>();
    let mut state = state.lock().unwrap();
    if state.installing {
        return false;
    }
    if !is_home_url(url) && url.as_str() != "about:blank" && !about::is_settings(app, url) {
        state.opened_library = true;
    }
    true
}

pub fn mark_library_opened(app: &AppHandle) {
    app.state::<Mutex<UpdateState>>()
        .lock()
        .unwrap()
        .opened_library = true;
}

fn is_home_url(url: &Url) -> bool {
    // WebKit can report the custom-scheme root with an empty path.
    url.as_str() == crate::GREETING || url.as_str() == crate::GREETING.trim_end_matches('/')
}

async fn offered_update(
    app: &AppHandle,
) -> Result<Option<Update>, Box<dyn std::error::Error + Send + Sync>> {
    let ca = std::fs::read(app.path().resource_dir()?.join("alpha-feed.pem"))?;
    let certificate = reqwest::Certificate::from_pem(&ca)?;
    let updater = app
        .updater_builder()
        .configure_client(move |client| {
            client
                .tls_certs_only([certificate.clone()])
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
        })
        .timeout(Duration::from_secs(30))
        .build()?;
    Ok(updater.check().await?)
}

pub async fn check(app: &AppHandle) -> Result<serde_json::Value, String> {
    let log = app.state::<Diagnostics>();
    match offered_update(app).await {
        Ok(Some(update)) => {
            log.record("info", "update.available", None);
            let can_install = !app
                .state::<Mutex<UpdateState>>()
                .lock()
                .unwrap()
                .opened_library;
            Ok(
                serde_json::json!({ "status": "available", "version": update.version, "canInstall": can_install }),
            )
        }
        Ok(None) => {
            log.record("info", "update.current", None);
            Ok(serde_json::json!({ "status": "current" }))
        }
        Err(_) => {
            log.record("error", "update.check_failed", None);
            Err(
                "Could not check for updates. Check that the alpha feed is running and try again."
                    .into(),
            )
        }
    }
}

pub async fn install(window: &WebviewWindow, version: &str) -> Result<(), String> {
    let app = window.app_handle();
    let state = app.state::<Mutex<UpdateState>>();
    let log = app.state::<Diagnostics>();
    if state.lock().unwrap().opened_library {
        return Err(reopen_message());
    }
    let update = offered_update(app)
        .await
        .map_err(|_| {
            log.record("error", "update.recheck_failed", None);
            "Could not reach the alpha feed. Check for updates again."
        })?
        .filter(|update| update.version == version)
        .ok_or("The offered version changed. Check for updates again.")?;

    let bytes = update.download(|_, _| {}, || {}).await.map_err(|_| {
        log.record("error", "update.download_failed", None);
        "The update could not be downloaded or verified."
    })?;

    // Prevent a bundle swap while the library has edits or uploads in flight.
    let in_settings = window.url().is_ok_and(|url| about::is_settings(app, &url));
    {
        let mut state = state.lock().unwrap();
        if state.installing {
            return Err("An update is already being installed.".into());
        }
        if state.opened_library || !in_settings {
            return Err(reopen_message());
        }
        state.installing = true;
    }
    let result = tauri::async_runtime::spawn_blocking(move || swap_verified_app(&bytes)).await;
    if !matches!(result, Ok(Ok(()))) {
        state.lock().unwrap().installing = false;
        log.record("error", "update.install_failed", None);
        return Err("Could not replace Visarium. The app must be in a writable location on a volume that supports atomic replacement.".into());
    }
    log.record("info", "update.installed", None);
    app.request_restart();
    Ok(())
}

fn reopen_message() -> String {
    "Finish saving your work, reopen Visarium, and choose Settings from the startup screen.".into()
}

fn swap_verified_app(bytes: &[u8]) -> std::io::Result<()> {
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
    swap_paths(&replacement, app)
}

fn swap_paths(replacement: &Path, current: &Path) -> std::io::Result<()> {
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
    fn recognizes_only_the_bundled_startup_page() {
        for home in ["tauri://localhost", "tauri://localhost/"] {
            assert!(is_home_url(&Url::parse(home).unwrap()));
        }
        for other in ["tauri://localhost/board", "http://127.0.0.1:47821/"] {
            assert!(!is_home_url(&Url::parse(other).unwrap()));
        }
    }

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
