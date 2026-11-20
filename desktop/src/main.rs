//! Visarium for the desktop: the same server and the same SPA, in one window.
//!
//! On launch an embedded server starts on loopback in single-user mode, with
//! its library in the OS app-data directory, and the window opens on the
//! greeting page (desktop/static): the local library's recent boards on the
//! left, a sign-in form for a self-hosted server on the right.
//!
//! A local board is a plain navigation to the embedded server, where every
//! request is already signed in. A server is signed in to from here (see
//! `connect.rs`) — with a password from the form, or through the system
//! browser for any method the server offers (ADR-0027) — and the resulting
//! device token handed to the webview as its session cookie. The window then
//! navigates to the server, an ordinary same-origin client of it.
//!
//! Device tokens live in the OS credential store; the recent list beside them
//! holds addresses and usernames only. Passwords are kept nowhere.
//!
//! Server ▸ Home comes back to the greeting page from anywhere.
//!
//! Take out on a board drags the originals out as real files, through a native
//! drag (`drag_out.rs`): the one thing a server's pages may ask of this app.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod about;
#[cfg(all(target_os = "macos", feature = "alpha-updater"))]
mod alpha_update;
mod connect;
mod drag_out;
mod local_port;

use std::path::PathBuf;

use connect::{Connection, Problem, SignIn};
use serde::Serialize;
use tauri::menu::{Menu, MenuItem, Submenu};
use tauri::webview::cookie::{Cookie, SameSite};
use tauri::{Manager, State, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// The bundled greeting page (desktop/static), at the app's own origin.
#[cfg(windows)]
const GREETING: &str = "http://tauri.localhost/";
#[cfg(not(windows))]
const GREETING: &str = "tauri://localhost/";

/// The keychain service every device token is filed under.
#[cfg(not(all(target_os = "macos", feature = "alpha-updater")))]
const KEYCHAIN: &str = "dev.visarium.desktop";
#[cfg(all(target_os = "macos", feature = "alpha-updater"))]
const KEYCHAIN: &str = "dev.visarium.desktop.alpha";

struct Desktop {
    http: reqwest::Client,
    connections: PathBuf,
}

fn keychain(c: &Connection) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN, &format!("token:{}@{}", c.username, c.origin))
}

/// Where a version before ADR-0027 kept the password itself. Read once, to
/// get a device token, and then deleted.
fn saved_password(c: &Connection) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN, &format!("{}@{}", c.username, c.origin))
}

/// "Visarium Desktop on studio-mac": what the person sees in the server's
/// session list when deciding which device to sign out.
fn device_label() -> String {
    let host = std::process::Command::new("hostname")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|h| h.trim().trim_end_matches(".local").to_string())
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| std::env::consts::OS.to_string());
    format!("Visarium Desktop on {host}")
}

/// The system browser, never a webview: Google refuses OAuth in an embedded
/// one, and RFC 8252 says a native app must not ask for one there.
fn open_in_browser(url: &Url) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    // Not `cmd /C start`: cmd would read the `&` between query parameters.
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut c = std::process::Command::new("rundll32");
        c.arg("url.dll,FileProtocolHandler");
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = std::process::Command::new("xdg-open");
    command.arg(url.as_str()).spawn().map(|_| ())
}

#[derive(Serialize)]
struct LocalBoards {
    library: Url,
    boards: Vec<connect::Board>,
}

#[tauri::command]
async fn local_boards(
    desktop: State<'_, Desktop>,
    port: State<'_, local_port::LocalPort>,
) -> Result<LocalBoards, Problem> {
    let library = port.library();
    let boards = connect::recent_boards(&desktop.http, &library).await?;
    Ok(LocalBoards { library, boards })
}

#[derive(Serialize)]
struct Connected {
    /// Where the page navigates next; the session is already in the webview.
    open: Url,
    /// Connected, but something worth saying first (the password not saved).
    warning: Option<String>,
}

/// What the server at `address` offers, so the form can hide the password
/// fields on an SSO-only server.
#[tauri::command]
async fn probe(desktop: State<'_, Desktop>, address: String) -> Result<connect::Probe, Problem> {
    connect::probe(&desktop.http, &connect::normalise(&address)?).await
}

/// Connects with a password from the form, or, with none, with the saved
/// device token. A connection saved before device tokens existed still has
/// its password in the keychain: used once, to get a token, then deleted.
/// Async, because `set_cookie` from a synchronous command deadlocks on Windows.
#[tauri::command]
async fn connect(
    window: WebviewWindow,
    desktop: State<'_, Desktop>,
    address: String,
    username: String,
    password: Option<String>,
) -> Result<Connected, Problem> {
    let origin = connect::normalise(&address)?;
    let username = username.trim().to_string();
    if username.is_empty() {
        return Err(Problem::new("invalid", "enter a username"));
    }
    let entry = Connection {
        origin: origin.to_string(),
        username: username.clone(),
    };
    let typed = password.filter(|p| !p.is_empty());
    let saved_token = keychain(&entry).and_then(|k| k.get_password()).ok();
    let token = match (typed, saved_token) {
        (Some(password), _) => match connect::sign_in(
            &desktop.http,
            &origin,
            &username,
            &password,
            &device_label(),
        )
        .await?
        {
            SignIn::Setup => {
                return Ok(Connected {
                    open: origin,
                    warning: None,
                });
            }
            SignIn::Session(token) => token,
        },
        (None, Some(token)) => match connect::session_user(&desktop.http, &origin, &token).await? {
            Some(_) => token,
            None => {
                return Err(Problem::new(
                    "signed-out",
                    "this computer was signed out of the server (a password change, or signed out from another device); sign in again",
                ));
            }
        },
        (None, None) => {
            let legacy = saved_password(&entry).and_then(|k| k.get_password()).map_err(|_| {
                Problem::new("no-password", "this connection has no saved sign-in; enter the password or sign in with the browser")
            })?;
            let SignIn::Session(token) =
                connect::sign_in(&desktop.http, &origin, &username, &legacy, &device_label())
                    .await?
            else {
                return Ok(Connected {
                    open: origin,
                    warning: None,
                });
            };
            let _ = saved_password(&entry).and_then(|k| k.delete_credential());
            token
        }
    };
    open_signed_in(&window, &desktop, origin, username, token).await
}

/// Signs in through the system browser — with `provider`, straight through that
/// provider — and connects with the device token it yields. An unclaimed
/// server is claimed there too: its setup page comes first, then the device.
#[tauri::command]
async fn connect_browser(
    window: WebviewWindow,
    desktop: State<'_, Desktop>,
    address: String,
    provider: Option<String>,
) -> Result<Connected, Problem> {
    browser_sign_in(
        &window,
        &desktop,
        connect::normalise(&address)?,
        provider.as_deref(),
    )
    .await
}

async fn browser_sign_in(
    window: &WebviewWindow,
    desktop: &Desktop,
    origin: Url,
    provider: Option<&str>,
) -> Result<Connected, Problem> {
    let handoff = connect::start_handoff(&origin, &device_label(), provider).await?;
    open_in_browser(&handoff.url)
        .map_err(|e| Problem::new("local", format!("could not open the browser: {e}")))?;
    let (token, username) = connect::finish_handoff(
        &desktop.http,
        &origin,
        handoff,
        connect::BROWSER_SIGN_IN_TIMEOUT,
    )
    .await?;
    let _ = window.set_focus();
    open_signed_in(window, desktop, origin, username, token).await
}

/// A server page in the window followed a "Continue with …" link (its sign-in
/// or setup screen, or Settings). Provider sign-in never runs in the window:
/// passkeys and password managers live in the system browser, and Google
/// refuses embedded webviews. Sign-in and claim become the browser hand-off,
/// then the window goes where the link would have; linking an identity needs
/// the browser signed in, so Settings opens there.
fn provider_link_in_browser(app: &tauri::AppHandle, link: connect::ProviderLink) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let (Some(window), Some(desktop)) =
            (app.get_webview_window("main"), app.try_state::<Desktop>())
        else {
            return;
        };
        if link.intent == "link" {
            let _ = open_in_browser(&link.origin.join("settings").expect("relative path"));
            return;
        }
        match browser_sign_in(&window, &desktop, link.origin.clone(), Some(&link.provider)).await {
            Ok(_) => {
                let _ = window.navigate(link.origin.join(&link.back).unwrap_or(link.origin));
            }
            Err(problem) => eprintln!("browser sign-in failed: {}", problem.message),
        }
    });
}

/// Hands the token to the webview as its session, keeps it in the keychain,
/// remembers the connection.
async fn open_signed_in(
    window: &WebviewWindow,
    desktop: &Desktop,
    origin: Url,
    username: String,
    token: String,
) -> Result<Connected, Problem> {
    let entry = Connection {
        origin: origin.to_string(),
        username,
    };
    let host = origin.host_str().unwrap_or_default().to_string();
    let cookie = Cookie::build((connect::SESSION_COOKIE, token.clone()))
        .domain(host.clone())
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(origin.scheme() == "https")
        .build();
    window.set_cookie(cookie).map_err(|e| {
        Problem::new(
            "no-session",
            format!("signed in, but the window would not take the session: {e}"),
        )
    })?;
    if let Err(e) = drag_out::allow(window.app_handle(), &origin) {
        eprintln!("drag out stays off for {origin}: {e}");
    }

    let mut warning = None;
    if let Err(e) = keychain(&entry).and_then(|k| k.set_password(&token)) {
        warning = Some(format!(
            "connected, but this computer could not keep the sign-in, so you will be asked again next time ({e})"
        ));
    }
    let (list, dropped) = connect::remember(connect::load(&desktop.connections), entry);
    for gone in &dropped {
        let _ = keychain(gone).and_then(|k| k.delete_credential());
    }
    if let Err(e) = connect::save(&desktop.connections, &list) {
        warning.get_or_insert(format!(
            "connected, but this connection could not be remembered ({e})"
        ));
    }
    let _ = window.set_title(&format!("Visarium — {host}"));
    Ok(Connected {
        open: origin,
        warning,
    })
}

#[tauri::command]
fn connections(desktop: State<'_, Desktop>) -> Vec<Connection> {
    connect::load(&desktop.connections)
}

/// Removes the connection, signs this device out on the server (when it can
/// be reached), and deletes the token — and any password an older version
/// left behind.
#[tauri::command]
async fn forget(
    desktop: State<'_, Desktop>,
    origin: String,
    username: String,
) -> Result<(), Problem> {
    let entry = Connection { origin, username };
    let list: Vec<_> = connect::load(&desktop.connections)
        .into_iter()
        .filter(|c| *c != entry)
        .collect();
    connect::save(&desktop.connections, &list)
        .map_err(|e| Problem::new("local", format!("could not update the list: {e}")))?;
    if let (Ok(token), Ok(origin)) = (
        keychain(&entry).and_then(|k| k.get_password()),
        entry.origin.parse::<Url>(),
    ) {
        connect::revoke(&desktop.http, &origin, &token).await;
    }
    let _ = saved_password(&entry).and_then(|k| k.delete_credential());
    match keychain(&entry).and_then(|k| k.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(Problem::new(
            "keychain",
            format!("removed from the list, but the saved sign-in could not be deleted ({e})"),
        )),
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            local_boards,
            probe,
            connect,
            connect_browser,
            connections,
            forget,
            drag_out::drag_stage,
            drag_out::drag_out,
            local_port::local_port,
            local_port::set_local_port,
            about::check_for_updates,
            about::install_update,
            about::collect_diagnostics,
            about::mark_library_opened
        ])
        .setup(|app| {
            about::setup(app)?;
            let data = app.path().app_data_dir()?;
            let cache = app.path().app_cache_dir()?;
            let config = visarium::Config {
                database: data.join("visarium.db"),
                assets: data.join("assets"),
                derivatives: cache.join("derivatives"),
                version: app.package_info().version.to_string(),
                single_user: true,
                ..Default::default()
            };
            // A stable port keeps the SPA's origin (and the browser storage
            // it remembers view preferences in) and an agent's /mcp address the
            // same from one launch to the next. Chosen in Settings.
            let port_file = app.path().app_config_dir()?.join("local-server.json");
            let preferred = local_port::preferred(&port_file);
            let (state, listener) = tauri::async_runtime::block_on(async {
                let state = visarium::open(config).await?;
                let listener = match tokio::net::TcpListener::bind(("127.0.0.1", preferred)).await {
                    Ok(l) => l,
                    Err(_) => tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?,
                };
                Ok::<_, Box<dyn std::error::Error + Send + Sync>>((state, listener))
            })
            .map_err(|e| e.to_string())?;
            let library: Url =
                format!("http://127.0.0.1:{}/", listener.local_addr()?.port()).parse()?;
            drag_out::clear();
            drag_out::allow(app.handle(), &library)?;
            local_port::allow(app.handle(), &library)?;
            app.manage(local_port::LocalPort::start(state, port_file, listener)?);

            let server = Submenu::with_items(
                app,
                "Server",
                true,
                &[
                    &MenuItem::with_id(app, "home", "Home", true, Some("CmdOrCtrl+Shift+H"))?,
                    &MenuItem::with_id(
                        app,
                        "local",
                        "Local Library",
                        true,
                        Some("CmdOrCtrl+Shift+L"),
                    )?,
                ],
            )?;
            // The default menu carries Edit ▸ Copy/Paste, without which the
            // webview gets no clipboard shortcuts on macOS.
            let menu = Menu::default(app.handle())?;
            menu.append(&server)?;
            app.set_menu(menu)?;

            let handle = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .on_navigation(move |url| {
                    #[cfg(all(target_os = "macos", feature = "alpha-updater"))]
                    if !alpha_update::allow_navigation(&handle, url) {
                        return false;
                    }
                    match connect::provider_link(url) {
                        Some(link) => {
                            provider_link_in_browser(&handle, link);
                            false
                        }
                        None => true,
                    }
                })
                .title("Visarium")
                .inner_size(1440.0, 900.0)
                .min_inner_size(800.0, 500.0)
                // Files dropped from Finder must reach the page as HTML5 drop
                // events — that is how images get onto a board.
                .disable_drag_drop_handler()
                .build()?;
            app.manage(Desktop {
                http: connect::client(),
                connections: app.path().app_config_dir()?.join("connections.json"),
            });
            Ok(())
        })
        .on_menu_event(|app, event| {
            let Some(window) = app.get_webview_window("main") else {
                return;
            };
            let target = match event.id().as_ref() {
                "home" => GREETING.parse().unwrap(),
                "local" => app.state::<local_port::LocalPort>().library(),
                _ => return,
            };
            #[cfg(all(target_os = "macos", feature = "alpha-updater"))]
            if !alpha_update::allow_navigation(app, &target) {
                return;
            }
            let _ = window.set_title("Visarium");
            let _ = window.navigate(target);
        })
        .run(tauri::generate_context!())
        .expect("error while running Visarium");
}
