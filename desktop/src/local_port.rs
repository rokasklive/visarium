//! The embedded library's port, fixed and changeable while it runs.
//!
//! An agent configured against `http://127.0.0.1:47821/mcp` (ADR-0031) and
//! the SPA's own browser storage both depend on the port staying the same from
//! one launch to the next. So the port is a preference, kept in
//! `local-server.json` and changed from the library's Settings. Taken by
//! something else at launch, any free port will do for that run, and Settings
//! says so.
//!
//! A change applies at once: the same server state starts serving on the new
//! port, the window follows to the same page there, and the old listener
//! stops. Only the address changes; the library, its database and everything
//! open in it are the same objects throughout.
//!
//! The commands are granted at runtime to the embedded library's origin and
//! to nothing else (`allow`): no server's pages may move the local port.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::async_runtime::JoinHandle;
use tauri::ipc::CapabilityBuilder;
use tauri::{AppHandle, Manager, State, Url, WebviewWindow};

use crate::connect::Problem;
use crate::drag_out;

/// What the port is when nobody has chosen one.
pub const DEFAULT_PORT: u16 = 47821;

/// The running library: what it serves, where, and the task serving it.
pub struct LocalPort {
    state: visarium::AppState,
    file: PathBuf,
    live: Mutex<Live>,
}

struct Live {
    port: u16,
    server: JoinHandle<std::io::Result<()>>,
    /// Sending or dropping it stops the listener; requests in flight finish.
    stop: Option<tokio::sync::oneshot::Sender<()>>,
}

impl Live {
    /// Stops listening and closes idle connections once requests in flight
    /// are answered. (Aborting the task would leave its connections open.)
    fn close(mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}

fn serve(state: visarium::AppState, listener: tokio::net::TcpListener, port: u16) -> Live {
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let server = tauri::async_runtime::spawn(visarium::serve_until(state, listener, async move {
        let _ = stopped.await;
    }));
    Live {
        port,
        server,
        stop: Some(stop),
    }
}

#[derive(serde::Deserialize, Serialize)]
struct Saved {
    port: u16,
}

/// The chosen port, or the default when none is saved or the file is unreadable.
pub fn preferred(file: &Path) -> u16 {
    std::fs::read(file)
        .ok()
        .and_then(|b| serde_json::from_slice::<Saved>(&b).ok())
        .map(|s| s.port)
        .filter(|p| *p >= 1024)
        .unwrap_or(DEFAULT_PORT)
}

fn save(file: &Path, port: u16) -> Result<(), Problem> {
    let failed = |e: std::io::Error| Problem::new("local", format!("could not save the port: {e}"));
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(failed)?;
    }
    std::fs::write(
        file,
        serde_json::to_vec_pretty(&Saved { port }).expect("a port serialises"),
    )
    .map_err(failed)
}

fn origin(port: u16) -> Url {
    format!("http://127.0.0.1:{port}/")
        .parse()
        .expect("a loopback URL")
}

impl LocalPort {
    /// Starts serving `state` on `listener`.
    pub fn start(
        state: visarium::AppState,
        file: PathBuf,
        listener: tokio::net::TcpListener,
    ) -> std::io::Result<LocalPort> {
        let port = listener.local_addr()?.port();
        let live = serve(state.clone(), listener, port);
        Ok(LocalPort {
            state,
            file,
            live: Mutex::new(live),
        })
    }

    /// The library's address now: `http://127.0.0.1:{port}/`.
    pub fn library(&self) -> Url {
        origin(self.live.lock().unwrap().port)
    }

    /// Serves the same state on `listener` from now on, and hands back what
    /// served until now, still running: the caller stops it once nothing needs it.
    fn swap(&self, listener: tokio::net::TcpListener) -> std::io::Result<Live> {
        let port = listener.local_addr()?.port();
        let live = serve(self.state.clone(), listener, port);
        Ok(std::mem::replace(&mut *self.live.lock().unwrap(), live))
    }

    /// Stops taking requests and waits, up to `wait`, for those in flight to
    /// be answered: before the app is replaced by an update. Whether they all were.
    pub async fn shutdown(&self, wait: Duration) -> bool {
        if let Some(stop) = self.live.lock().unwrap().stop.take() {
            let _ = stop.send(());
        }
        let deadline = std::time::Instant::now() + wait;
        loop {
            if self.live.lock().unwrap().server.inner().is_finished() {
                return true;
            }
            if std::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    fn info(&self) -> PortInfo {
        PortInfo {
            preferred: preferred(&self.file),
            actual: self.live.lock().unwrap().port,
            default: DEFAULT_PORT,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortInfo {
    /// What a launch tries.
    preferred: u16,
    /// What the library is on: differs when the preferred one was taken at launch.
    actual: u16,
    default: u16,
}

/// Whether a page at `caller` is the library as it runs now. Tauri grants
/// accumulate (a grant to an old port is never withdrawn), so the commands
/// check this themselves: a program that takes over a port the library left
/// gets nothing from them.
fn is_current(library: &Url, caller: &Url) -> bool {
    caller.origin() == library.origin()
}

fn require_current(port: &LocalPort, window: &WebviewWindow) -> Result<(), Problem> {
    match window.url() {
        Ok(url) if is_current(&port.library(), &url) => Ok(()),
        _ => Err(Problem::new(
            "local",
            "only the local library at its current address can do that",
        )),
    }
}

#[tauri::command]
pub fn local_port(window: WebviewWindow, port: State<'_, LocalPort>) -> Result<PortInfo, Problem> {
    require_current(&port, &window)?;
    Ok(port.info())
}

/// Moves the library to `value` now, and from then on.
#[tauri::command]
pub async fn set_local_port(
    app: AppHandle,
    window: WebviewWindow,
    port: State<'_, LocalPort>,
    value: u16,
) -> Result<PortInfo, Problem> {
    require_current(&port, &window)?;
    if value < 1024 {
        return Err(Problem::new(
            "local",
            "choose a port from 1024 to 65535; lower ones need administrator rights",
        ));
    }
    if value == port.live.lock().unwrap().port {
        save(&port.file, value)?;
        return Ok(port.info());
    }
    // Bound before anything changes: a port that is not free leaves all as it was.
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", value))
        .await
        .map_err(|e| {
            Problem::new(
                "local",
                format!("port {value} is not free ({e}); choose another"),
            )
        })?;
    save(&port.file, value)?;
    let old = port
        .swap(listener)
        .map_err(|e| Problem::new("local", e.to_string()))?;
    let library = origin(value);
    allow(&app, &library).map_err(|e| Problem::new("local", e.to_string()))?;
    drag_out::allow(&app, &library).map_err(|e| Problem::new("local", e.to_string()))?;

    // The page that asked lives at the old address. Once this answer has
    // reached it, the window moves to the same page at the new one, and only
    // then does the old listener stop.
    if let Some(window) = app.get_webview_window("main") {
        let here = window.url().ok();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            let mut next = library.clone();
            if let Some(here) = here.filter(|h| h.port() == Some(old.port)) {
                next.set_path(here.path());
                next.set_query(here.query());
            }
            if let Err(e) = window.navigate(next) {
                tracing::warn!(error = %e, "could not move the window to the new port");
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
            old.close();
        });
    } else {
        old.close();
    }
    Ok(port.info())
}

/// Lets the embedded library at `origin` read and move its port. Tauri adds
/// each grant to the ones before it and never withdraws one, so after a move
/// the old origin still holds this grant; `require_current` is what refuses it.
pub fn allow(app: &AppHandle, origin: &Url) -> tauri::Result<()> {
    crate::about::allow(app, origin)?;
    app.add_capability(
        CapabilityBuilder::new("local-port")
            .local(false)
            .remote(format!("{origin}*"))
            .window("main")
            .permission("allow-local-port")
            .permission("allow-set-local-port"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "multi_thread")]
    async fn the_same_library_moves_to_a_new_port_and_the_old_one_closes() {
        let dir = std::env::temp_dir().join(format!("visarium-port-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let state = visarium::open(visarium::Config {
            database: dir.join("visarium.db"),
            assets: dir.join("assets"),
            derivatives: dir.join("derivatives"),
            version: "test".into(),
            single_user: true,
            ..Default::default()
        })
        .await
        .unwrap();
        sqlx::query("INSERT INTO canvas (id, title) VALUES ('b1', 'Kept across the move')")
            .execute(&state.db)
            .await
            .unwrap();
        let first = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let local = LocalPort::start(state, dir.join("local-server.json"), first).unwrap();
        let before = local.library();
        let http = reqwest::Client::new();
        let boards = |url: Url| {
            let http = http.clone();
            async move { http.get(url.join("api/boards").unwrap()).send().await }
        };
        assert!(
            boards(before.clone())
                .await
                .unwrap()
                .text()
                .await
                .unwrap()
                .contains("Kept across the move")
        );

        let second = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let old = local.swap(second).unwrap();
        let after = local.library();
        assert_ne!(after, before);
        assert_eq!(old.port, before.port().unwrap());
        assert!(
            boards(after.clone())
                .await
                .unwrap()
                .text()
                .await
                .unwrap()
                .contains("Kept across the move"),
            "the same library answers at the new address"
        );

        old.close();
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(
            boards(before).await.is_err(),
            "the old address no longer answers"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn shutdown_answers_the_request_in_flight_then_stops_listening() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let dir = std::env::temp_dir().join(format!("visarium-drain-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let state = visarium::open(visarium::Config {
            database: dir.join("visarium.db"),
            assets: dir.join("assets"),
            derivatives: dir.join("derivatives"),
            version: "test".into(),
            single_user: true,
            ..Default::default()
        })
        .await
        .unwrap();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let local = std::sync::Arc::new(
            LocalPort::start(state, dir.join("local-server.json"), listener).unwrap(),
        );

        // Half a request on the wire when the shutdown starts.
        let mut socket = tokio::net::TcpStream::connect(addr).await.unwrap();
        socket
            .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n")
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        let draining = {
            let local = local.clone();
            tokio::spawn(async move { local.shutdown(Duration::from_secs(5)).await })
        };
        tokio::time::sleep(Duration::from_millis(100)).await;
        socket
            .write_all(b"Connection: close\r\n\r\n")
            .await
            .unwrap();
        let mut reply = String::new();
        socket.read_to_string(&mut reply).await.unwrap();
        assert!(reply.starts_with("HTTP/1.1 200"), "{reply}");

        assert!(
            draining.await.unwrap(),
            "the server stopped within the wait"
        );
        assert!(
            tokio::net::TcpStream::connect(addr).await.is_err(),
            "no new connections"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn only_the_current_library_origin_may_use_the_port_commands() {
        let library = origin(48000);
        let at = |u: &str| is_current(&library, &u.parse().unwrap());
        assert!(at("http://127.0.0.1:48000/settings"));
        assert!(!at("http://127.0.0.1:47821/settings"), "a port it left");
        assert!(!at("https://visarium.example.net/settings"), "a server");
        assert!(!at("http://localhost:48000/settings"), "another host name");
    }

    #[test]
    fn a_saved_port_is_read_back_and_a_bad_one_ignored() {
        let file =
            std::env::temp_dir().join(format!("visarium-port-file-{}.json", std::process::id()));
        assert_eq!(preferred(&file.with_extension("missing")), DEFAULT_PORT);
        save(&file, 48000).unwrap();
        assert_eq!(preferred(&file), 48000);
        std::fs::write(&file, b"{\"port\": 80}").unwrap();
        assert_eq!(
            preferred(&file),
            DEFAULT_PORT,
            "a privileged port is not used"
        );
        let _ = std::fs::remove_file(file);
    }
}
