//! Canvas images dragged out of the window as real files (ADR-0028).
//!
//! A page in a webview cannot hand the OS a file: a `File` added to a
//! `DataTransfer` never leaves it, and Visarium's content URLs need a session
//! no other app has (docs/research/drag-out-images.md). So the SPA stages each
//! original here while the selection settles — the same head start its
//! browser warm already takes — and a press-and-move on Take out starts a
//! native drag of the staged file. What arrives is a file URL with the asset's
//! own name, which Finder, Preview and chat apps all read as the image.
//!
//! The two commands are granted at runtime, to the embedded library and to each
//! server once this app has signed in to it, and to nothing else (`allow`).
//! Staged files live in the OS temp directory, one folder per asset, and are
//! cleared on launch rather than after a drag: a drop target may still be
//! reading one after the drag has ended.

use std::path::{Component, Path, PathBuf};

use base64::Engine as _;
use tauri::ipc::CapabilityBuilder;
use tauri::{AppHandle, Manager, Url, WebviewWindow};

/// The longest edge of the picture that follows the pointer.
const ICON_EDGE: u32 = 160;

fn root() -> PathBuf {
    std::env::temp_dir().join("visarium-drag-out")
}

/// Lets the SPA at `origin` stage files and drag them out of the main window.
/// Re-granting the same origin replaces the earlier grant.
pub fn allow(app: &AppHandle, origin: &Url) -> tauri::Result<()> {
    let id: String = origin.as_str().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    app.add_capability(
        CapabilityBuilder::new(format!("drag-out-{id}"))
            .local(false)
            .remote(format!("{origin}*"))
            .window("main")
            .permission("allow-drag-stage")
            .permission("allow-drag-out"),
    )
}

/// What a previous run staged. Nothing is reading those files any more.
pub fn clear() {
    let _ = std::fs::remove_dir_all(root());
}

/// A path segment a page may name: no separators, no leading dot.
fn segment(raw: &str) -> Option<String> {
    let clean: String = raw.chars().map(|c| if c.is_ascii_alphanumeric() || "._- ()".contains(c) { c } else { '_' }).collect();
    let clean = clean.trim_start_matches('.').trim().to_string();
    (!clean.is_empty()).then_some(clean)
}

/// A file this module staged, and nothing else on the disk.
fn staged(root: &Path, path: &Path) -> bool {
    path.starts_with(root) && !path.components().any(|c| matches!(c, Component::ParentDir)) && path.is_file()
}

/// Writes `<temp>/visarium-drag-out/<asset>/<name>` and a small icon beside
/// it, and answers the file's path.
///
/// The bytes come as base64 in plain JSON, not as a raw body. An https page
/// cannot fetch Tauri's `ipc://` scheme, so its calls fall back to
/// `postMessage`, which turns an `ArrayBuffer` into an array of numbers; the
/// plain-http local library never noticed.
#[tauri::command]
pub async fn drag_stage(asset: String, name: String, data: String) -> Result<PathBuf, String> {
    let stage = || -> Result<PathBuf, String> {
        let asset = segment(&asset).ok_or("no asset id")?;
        let name = segment(&name).unwrap_or_else(|| "image".into());
        let dir = root().join(asset);
        let file = dir.join(name);
        if file.is_file() {
            return Ok(file);
        }
        let bytes = base64::engine::general_purpose::STANDARD.decode(&data).map_err(|e| format!("not base64: {e}"))?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        // Decoding a large original costs a few hundred milliseconds; it
        // happens here, while the selection settles, never once the pointer is
        // moving — and off the main thread, because this command is async.
        let icon = image::load_from_memory(&bytes).map_err(|e| format!("not an image: {e}"))?.thumbnail(ICON_EDGE, ICON_EDGE);
        icon.save_with_format(dir.join("icon.png"), image::ImageFormat::Png).map_err(|e| e.to_string())?;
        std::fs::write(&file, &bytes).map_err(|e| e.to_string())?;
        Ok(file)
    };
    stage().inspect_err(|e| eprintln!("drag stage failed for {asset}: {e}"))
}

/// Starts a native drag of files `drag_stage` wrote, with the pointer still
/// held. Any other path is refused: server pages reach this command, and it
/// must not become a way to drag an arbitrary file off the disk.
#[tauri::command]
pub fn drag_out(window: WebviewWindow, paths: Vec<PathBuf>) -> Result<(), String> {
    let root = root();
    if paths.is_empty() || !paths.iter().all(|p| staged(&root, p)) {
        return Err("only staged files can be dragged".into());
    }
    let icon = paths.last().expect("not empty").with_file_name("icon.png");
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            if let Err(e) = start(&target, paths, icon) {
                eprintln!("drag out failed: {e}");
            }
        })
        .map_err(|e| e.to_string())
}

fn start(window: &WebviewWindow, paths: Vec<PathBuf>, icon: PathBuf) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    let window = window.gtk_window().map_err(|e| e.to_string())?;
    drag::start_drag(&window, drag::DragItem::Files(paths), drag::Image::File(icon), |_, _| {}, drag::Options::default())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{segment, staged};

    #[test]
    fn segments_cannot_climb_out() {
        assert_eq!(segment("../../etc/passwd").as_deref(), Some("_.._etc_passwd"));
        assert_eq!(segment("photo (2).JPG").as_deref(), Some("photo (2).JPG"));
        assert_eq!(segment(".."), None);
        assert_eq!(segment("/"), Some("_".into()));
    }

    #[test]
    fn only_staged_files_can_be_dragged() {
        let root = std::env::temp_dir().join(format!("visarium-drag-out-test-{}", std::process::id()));
        let inside = root.join("asset").join("a.png");
        std::fs::create_dir_all(inside.parent().unwrap()).unwrap();
        std::fs::write(&inside, b"png").unwrap();

        assert!(staged(&root, &inside));
        assert!(!staged(&root, &root.join("asset").join("missing.png")));
        assert!(!staged(&root, &root.join("asset").join("..").join("..").join("etc").join("hosts")));
        assert!(!staged(&root, std::path::Path::new("/etc/hosts")));

        std::fs::remove_dir_all(&root).unwrap();
    }
}
