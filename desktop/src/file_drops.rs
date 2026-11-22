//! Files dragged in from a Linux file manager.
//!
//! WebKitGTK delivers such a drop to the page with an empty `files` list, so
//! the board never sees the image, and then its default action is to navigate
//! to the file. `on_navigation` catches that navigation; this reads the file
//! and replays it into the page as the ordinary drop the board already handles.

use base64::{Engine, engine::general_purpose::STANDARD};
use tauri::{AppHandle, Manager, Url};

pub fn replay(app: &AppHandle, url: &Url) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(path) = url.to_file_path() else {
        return;
    };
    let mime = match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
    {
        Some(e) => match e.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "bmp" => "image/bmp",
            "tif" | "tiff" => "image/tiff",
            "md" | "markdown" => "text/markdown",
            "mmd" | "mermaid" | "puml" | "plantuml" => "text/plain",
            _ => return,
        },
        None => return,
    };
    // ponytail: one file per navigation, whole file through eval, dropped at
    // the window centre (the navigation carries no pointer position).
    let Ok(bytes) = std::fs::read(&path) else {
        return;
    };
    let name = serde_json::to_string(&path.file_name().unwrap_or_default().to_string_lossy())
        .unwrap_or_default();
    let script = format!(
        "(()=>{{const a=Uint8Array.from(atob('{}'),c=>c.charCodeAt(0));\
         const dt=new DataTransfer();dt.items.add(new File([a],{name},{{type:'{mime}'}}));\
         const x=innerWidth/2,y=innerHeight/2;\
         (document.elementFromPoint(x,y)||document.body).dispatchEvent(\
         new DragEvent('drop',{{dataTransfer:dt,clientX:x,clientY:y,bubbles:true,cancelable:true}}));}})()",
        STANDARD.encode(bytes)
    );
    tracing::info!(path = %path.display(), "replaying a dropped file into the page");
    if let Err(e) = window.eval(script) {
        tracing::warn!(error = %e, "could not hand a dropped file to the page");
    }
}
