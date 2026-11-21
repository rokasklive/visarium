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
//! Staged files live in this app's cache directory, one folder per asset, and
//! are cleared on launch rather than after a drag: a drop target may still be
//! reading one after the drag has ended. That directory is per-user on every
//! OS (a shared `/tmp` is not), and is made owner-only besides: the files are
//! originals from the library.

use std::path::{Component, Path, PathBuf};

use base64::Engine as _;
use tauri::ipc::CapabilityBuilder;
use tauri::{AppHandle, Manager, Url, WebviewWindow};

/// The longest edge of the picture that follows the pointer.
const ICON_EDGE: u32 = 160;

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|d| d.join("drag-out"))
        .map_err(|e| e.to_string())
}

/// Creates `dir`, or tightens it if it exists, readable by this user only.
fn private_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)?;
        // A directory that already existed keeps its old mode otherwise.
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
    }
    #[cfg(not(unix))]
    std::fs::create_dir_all(dir)
}

/// Writes a fresh file at `path`. Whatever was there that is not this app's
/// own regular file (a link, say) is removed first, never written through.
fn write_new(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    if std::fs::symlink_metadata(path).is_ok() {
        std::fs::remove_file(path)?;
    }
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?
        .write_all(bytes)
}

/// Lets the SPA at `origin` stage files and drag them out of the main window.
/// Re-granting the same origin replaces the earlier grant.
pub fn allow(app: &AppHandle, origin: &Url) -> tauri::Result<()> {
    let id: String = origin
        .as_str()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
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
pub fn clear(app: &AppHandle) {
    // Usually there is nothing to clear.
    if let Ok(root) = root(app) {
        let _ = std::fs::remove_dir_all(root);
    }
    // Where builds before 0.1.0 staged, in the shared temp directory.
    let _ = std::fs::remove_dir_all(std::env::temp_dir().join("visarium-drag-out"));
}

/// A path segment a page may name: no separators, no leading dot.
fn segment(raw: &str) -> Option<String> {
    let clean: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "._- ()".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    let clean = clean.trim_start_matches('.').trim().to_string();
    (!clean.is_empty()).then_some(clean)
}

/// A file this module staged, and nothing else on the disk.
fn staged(root: &Path, path: &Path) -> bool {
    path.starts_with(root)
        && !path.components().any(|c| matches!(c, Component::ParentDir))
        && path.is_file()
}

/// Writes `<temp>/visarium-drag-out/<asset>/<name>` and a small icon beside
/// it, and answers the file's path.
///
/// The bytes come as base64 in plain JSON, not as a raw body. An https page
/// cannot fetch Tauri's `ipc://` scheme, so its calls fall back to
/// `postMessage`, which turns an `ArrayBuffer` into an array of numbers; the
/// plain-http local library never noticed.
#[tauri::command]
pub async fn drag_stage(
    app: AppHandle,
    asset: String,
    name: String,
    data: String,
) -> Result<PathBuf, String> {
    let root = root(&app)?;
    stage(&root, &asset, &name, &data)
        .inspect_err(|e| tracing::warn!(asset = %asset, error = %e, "drag stage failed"))
}

/// The body of `drag_stage`, given its root, so tests can run it.
fn stage(root: &Path, asset: &str, name: &str, data: &str) -> Result<PathBuf, String> {
    let asset = segment(asset).ok_or("no asset id")?;
    let name = segment(name).unwrap_or_else(|| "image".into());
    let dir = root.join(asset);
    let file = dir.join(name);
    // Only a regular file this app wrote counts as already staged.
    if std::fs::symlink_metadata(&file).is_ok_and(|m| m.file_type().is_file()) {
        return Ok(file);
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("not base64: {e}"))?;
    for d in [root, dir.as_path()] {
        private_dir(d).map_err(|e| e.to_string())?;
    }
    // Decoding a large original costs a few hundred milliseconds; it happens
    // here, while the selection settles, never once the pointer is moving —
    // and off the main thread, because this command is async.
    let icon = image::load_from_memory(&bytes)
        .map_err(|e| format!("not an image: {e}"))?
        .thumbnail(ICON_EDGE, ICON_EDGE);
    let mut png = std::io::Cursor::new(Vec::new());
    icon.write_to(&mut png, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    write_new(&dir.join("icon.png"), png.get_ref()).map_err(|e| e.to_string())?;
    write_new(&file, &bytes).map_err(|e| e.to_string())?;
    Ok(file)
}

/// Starts a native drag of files `drag_stage` wrote, with the pointer still
/// held. Any other path is refused: server pages reach this command, and it
/// must not become a way to drag an arbitrary file off the disk.
#[tauri::command]
pub fn drag_out(window: WebviewWindow, paths: Vec<PathBuf>) -> Result<(), String> {
    let root = root(window.app_handle())?;
    if paths.is_empty() || !paths.iter().all(|p| staged(&root, p)) {
        return Err("only staged files can be dragged".into());
    }
    let icon = paths.last().expect("not empty").with_file_name("icon.png");
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            if let Err(e) = start(&target, paths, icon) {
                tracing::warn!(error = %e, "drag out failed");
            }
        })
        .map_err(|e| e.to_string())
}

fn start(window: &WebviewWindow, paths: Vec<PathBuf>, icon: PathBuf) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    let window = window.gtk_window().map_err(|e| e.to_string())?;
    drag::start_drag(
        &window,
        drag::DragItem::Files(paths),
        drag::Image::File(icon),
        |_, _| {},
        drag::Options::default(),
    )
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{segment, stage, staged};
    use base64::Engine as _;

    fn tiny_png() -> String {
        let img = image::RgbaImage::new(4, 4);
        let mut png = std::io::Cursor::new(Vec::new());
        img.write_to(&mut png, image::ImageFormat::Png).unwrap();
        base64::engine::general_purpose::STANDARD.encode(png.get_ref())
    }

    #[cfg(unix)]
    #[test]
    fn staging_is_owner_only_and_never_writes_through_a_link() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("visarium-stage-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let outside = root.with_extension("victim");
        std::fs::write(&outside, b"keep me").unwrap();

        let dir = root.join("asset");
        std::fs::create_dir_all(&dir).unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("a.png")).unwrap();

        let staged_file = stage(&root, "asset", "a.png", &tiny_png()).unwrap();
        assert_eq!(
            std::fs::read(&outside).unwrap(),
            b"keep me",
            "not written through"
        );
        assert!(
            std::fs::symlink_metadata(&staged_file)
                .unwrap()
                .file_type()
                .is_file()
        );
        for d in [&root, &dir] {
            let mode = std::fs::metadata(d).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700, "{}", d.display());
        }
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn segments_cannot_climb_out() {
        assert_eq!(
            segment("../../etc/passwd").as_deref(),
            Some("_.._etc_passwd")
        );
        assert_eq!(segment("photo (2).JPG").as_deref(), Some("photo (2).JPG"));
        assert_eq!(segment(".."), None);
        assert_eq!(segment("/"), Some("_".into()));
    }

    #[test]
    fn only_staged_files_can_be_dragged() {
        let root =
            std::env::temp_dir().join(format!("visarium-drag-out-test-{}", std::process::id()));
        let inside = root.join("asset").join("a.png");
        std::fs::create_dir_all(inside.parent().unwrap()).unwrap();
        std::fs::write(&inside, b"png").unwrap();

        assert!(staged(&root, &inside));
        assert!(!staged(&root, &root.join("asset").join("missing.png")));
        assert!(!staged(
            &root,
            &root
                .join("asset")
                .join("..")
                .join("..")
                .join("etc")
                .join("hosts")
        ));
        assert!(!staged(&root, std::path::Path::new("/etc/hosts")));

        std::fs::remove_dir_all(&root).unwrap();
    }
}
