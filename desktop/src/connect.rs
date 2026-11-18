//! The greeting screen's work that has nothing to do with windows: reading the
//! local library's recent boards, signing in to a server, and the list of
//! recent connections. Plain HTTP against the same API the SPA uses, so it is
//! tested against a real embedded server.
//!
//! Signing in yields a **device token** (ADR-0027): a `device` session on the
//! server that survives its restarts and that the person can revoke from any
//! browser. The token, never the password, is what the keychain keeps.

use std::path::Path;
use std::time::Duration;

use reqwest::{StatusCode, Url, header};
use serde::{Deserialize, Serialize};

pub const RECENT_BOARDS: usize = 8;
pub const RECENT_CONNECTIONS: usize = 5;
pub const TIMEOUT: Duration = Duration::from_secs(10);
pub const SESSION_COOKIE: &str = "VISARIUM_SESSION";
/// What the server calls the same cookie over https (ADR-0025).
const SECURE_SESSION_COOKIE: &str = "__Host-visarium_session";
/// How long the browser sign-in waits for the person to finish.
pub const BROWSER_SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);
/// Double-submit CSRF only checks that cookie and header agree; this request
/// is not a browser's, so any non-empty value it sends in both will do.
const CSRF: &str = "visarium-desktop";

/// What the greeting page shows when something goes wrong: `kind` picks the
/// page's reaction, `message` is for the person.
#[derive(Debug, Serialize, PartialEq)]
pub struct Problem {
    pub kind: &'static str,
    pub message: String,
}

impl Problem {
    pub fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }
}

fn unreachable(e: reqwest::Error) -> Problem {
    let why = if e.is_timeout() { "it did not answer in time" } else { "nothing answered at that address" };
    Problem::new("unreachable", format!("could not reach the server: {why}"))
}

pub fn client() -> reqwest::Client {
    reqwest::Client::builder().timeout(TIMEOUT).build().expect("http client")
}

/// An address as typed, to the origin it names. No scheme means https.
pub fn normalise(address: &str) -> Result<Url, Problem> {
    let text = address.trim();
    let has_scheme = text.split_once("://").is_some_and(|(s, _)| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphabetic()));
    let url = Url::parse(&if has_scheme { text.to_string() } else { format!("https://{text}") })
        .ok()
        .filter(|u| u.host_str().is_some_and(|h| !h.is_empty()))
        .ok_or_else(|| Problem::new("invalid", "that is not a web address"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(Problem::new("invalid", "use an http or https address"));
    }
    Ok(Url::parse(&url.origin().ascii_serialization()).expect("an origin is a url"))
}

#[derive(Debug, PartialEq)]
pub enum SignIn {
    /// The server has no accounts yet; its own setup screen claims it.
    Setup,
    /// A device token: the session's cookie value.
    Session(String),
}

/// What a server says about itself before anyone signs in.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub setup_required: bool,
    /// False on an SSO-only server: the form offers the browser only.
    pub password_enabled: bool,
    /// The sign-in providers this server has configured, each one a button.
    pub providers: Vec<Provider>,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct Provider {
    pub id: String,
    pub name: String,
}

/// `GET /api/session`: is this a Visarium server, and what does it offer.
pub async fn probe(http: &reqwest::Client, origin: &Url) -> Result<Probe, Problem> {
    let not_visarium = || Problem::new("not-visarium", "that address is not a Visarium server");
    let reply = http.get(origin.join("api/session").expect("relative path")).send().await.map_err(unreachable)?;
    let state: serde_json::Value = reply.json().await.map_err(|_| not_visarium())?;
    let setup_required = state.get("setupRequired").and_then(|v| v.as_bool()).ok_or_else(not_visarium)?;
    // A server from before ADR-0025 does not say, and has passwords.
    let password_enabled = state.get("passwordEnabled").and_then(|v| v.as_bool()).unwrap_or(true);
    let providers = state.get("providers").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
    Ok(Probe { setup_required, password_enabled, providers })
}

fn post(http: &reqwest::Client, url: Url) -> reqwest::RequestBuilder {
    http.post(url).header(header::COOKIE, format!("XSRF-TOKEN={CSRF}")).header("X-XSRF-TOKEN", CSRF)
}

/// Checks this is a Visarium server, then `POST /api/session` with the
/// credentials, asking for a device session labelled `label`.
pub async fn sign_in(http: &reqwest::Client, origin: &Url, username: &str, password: &str, label: &str) -> Result<SignIn, Problem> {
    let found = probe(http, origin).await?;
    if found.setup_required {
        return Ok(SignIn::Setup);
    }
    if !found.password_enabled {
        return Err(Problem::new("no-password", "this server signs in through a provider only; use Sign in with browser"));
    }
    let reply = post(http, origin.join("api/session").expect("relative path"))
        .json(&serde_json::json!({ "username": username, "password": password, "device": { "label": label } }))
        .send()
        .await
        .map_err(unreachable)?;
    let status = reply.status();
    if status.is_success() {
        let token = reply
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok()?.split(';').next()?.split_once('='))
            .find(|(name, _)| [SESSION_COOKIE, SECURE_SESSION_COOKIE].contains(&name.trim()))
            .map(|(_, value)| value.trim().to_string());
        return token
            .filter(|t| !t.is_empty())
            .map(SignIn::Session)
            .ok_or_else(|| Problem::new("no-session", "the server accepted the sign-in but sent no session back"));
    }
    let detail = reply.json::<serde_json::Value>().await.ok().and_then(|b| b.get("detail")?.as_str().map(str::to_string));
    match (status, detail) {
        (StatusCode::UNAUTHORIZED | StatusCode::BAD_REQUEST, Some(detail)) => Err(Problem::new("refused", detail)),
        (status, detail) => Err(Problem::new("refused", detail.unwrap_or_else(|| format!("the server answered {status}")))),
    }
}

/// Who a device token signs in as, or `None` once the server no longer
/// accepts it (revoked, expired, the account deactivated).
pub async fn session_user(http: &reqwest::Client, origin: &Url, token: &str) -> Result<Option<String>, Problem> {
    let reply = http
        .get(origin.join("api/session").expect("relative path"))
        .header(header::COOKIE, format!("{SESSION_COOKIE}={token}"))
        .send()
        .await
        .map_err(unreachable)?;
    let state: serde_json::Value = reply.json().await.map_err(|_| Problem::new("not-visarium", "that address is not a Visarium server"))?;
    Ok(state.pointer("/user/username").and_then(|u| u.as_str()).map(str::to_string))
}

/// Ends a device token on the server. Best effort: forgetting a connection
/// must work when the server is gone.
pub async fn revoke(http: &reqwest::Client, origin: &Url, token: &str) {
    let _ = http
        .delete(origin.join("api/session").expect("relative path"))
        .header(header::COOKIE, format!("XSRF-TOKEN={CSRF}; {SESSION_COOKIE}={token}"))
        .header("X-XSRF-TOKEN", CSRF)
        .send()
        .await;
}

// --- signing in through the system browser (ADR-0027) -------------------------

fn random_base64url(bytes: usize) -> String {
    use base64::Engine;
    use rand::Rng;
    let mut buf = vec![0u8; bytes];
    rand::rng().fill_bytes(&mut buf);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

/// A browser sign-in in progress: where to send the browser, and what the
/// answer must match.
pub struct Handoff {
    pub url: Url,
    listener: tokio::net::TcpListener,
    verifier: String,
    state: String,
}

/// Listens on a random loopback port and builds the server's `/device`
/// address: PKCE challenge, state and a label for the session list. With a
/// `provider`, a browser that is not signed in goes straight to that provider
/// rather than the server's sign-in page.
pub async fn start_handoff(origin: &Url, label: &str, provider: Option<&str>) -> Result<Handoff, Problem> {
    use base64::Engine;
    use sha2::Digest;
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| Problem::new("local", format!("could not listen for the browser: {e}")))?;
    let port = listener.local_addr().map_err(|e| Problem::new("local", e.to_string()))?.port();
    let verifier = random_base64url(32);
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sha2::Sha256::digest(verifier.as_bytes()));
    let state = random_base64url(16);
    let mut url = origin.join("device").expect("relative path");
    url.query_pairs_mut()
        .append_pair("port", &port.to_string())
        .append_pair("challenge", &challenge)
        .append_pair("state", &state)
        .append_pair("label", label);
    if let Some(provider) = provider {
        url.query_pairs_mut().append_pair("provider", provider);
    }
    Ok(Handoff { url, listener, verifier, state })
}

/// A server's `/auth/oidc/{provider}/start?intent=…&return=…` link: where
/// provider sign-in begins, and what the window must hand to the browser.
#[derive(Debug, PartialEq)]
pub struct ProviderLink {
    pub origin: Url,
    pub provider: String,
    /// `sign-in`, `claim` or `link`.
    pub intent: String,
    /// The path to show afterwards: same-origin, or `/`.
    pub back: String,
}

pub fn provider_link(url: &Url) -> Option<ProviderLink> {
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let mut path = url.path_segments()?;
    let ["auth", "oidc", provider, "start"] = [path.next()?, path.next()?, path.next()?, path.next()?] else { return None };
    if path.next().is_some() || provider.is_empty() {
        return None;
    }
    let query = |key: &str| url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned());
    let back = query("return").filter(|r| r.starts_with('/') && !r.starts_with("//") && !r.starts_with("/\\"));
    Some(ProviderLink {
        origin: url.join("/").ok()?,
        provider: provider.to_string(),
        intent: query("intent").unwrap_or_else(|| "sign-in".into()),
        back: back.unwrap_or_else(|| "/".into()),
    })
}

/// What the browser lands on at 127.0.0.1 when it is done.
const DONE_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Visarium</title>\
<body style=\"font:14px system-ui;background:#16171b;color:#e8e9ec;display:grid;place-items:center;height:90vh\">\
<p>Signed in. You can close this tab and return to Visarium.</p>";

/// Waits for the browser to come back to the loopback port with a code, then
/// trades code + verifier for a device token. Returns the token and the
/// username it signs in as.
pub async fn finish_handoff(http: &reqwest::Client, origin: &Url, handoff: Handoff, wait: Duration) -> Result<(String, String), Problem> {
    let code = tokio::time::timeout(wait, accept_code(&handoff.listener, &handoff.state))
        .await
        .map_err(|_| Problem::new("timeout", "the browser sign-in was not finished in time; try again"))??;
    let reply = post(http, origin.join("api/device-tokens").expect("relative path"))
        .json(&serde_json::json!({ "code": code, "verifier": handoff.verifier }))
        .send()
        .await
        .map_err(unreachable)?;
    if !reply.status().is_success() {
        let detail = reply.json::<serde_json::Value>().await.ok().and_then(|b| b.get("detail")?.as_str().map(str::to_string));
        return Err(Problem::new("refused", detail.unwrap_or_else(|| "the server refused the sign-in".into())));
    }
    let body: serde_json::Value = reply.json().await.map_err(|e| Problem::new("refused", e.to_string()))?;
    let token = body["token"].as_str().unwrap_or_default().to_string();
    let username = body.pointer("/user/username").and_then(|u| u.as_str()).unwrap_or_default().to_string();
    if token.is_empty() {
        return Err(Problem::new("no-session", "the server accepted the sign-in but sent no session back"));
    }
    Ok((token, username))
}

/// Answers requests on the loopback port until one is `/callback` with the
/// right state. A browser may ask for `/favicon.ico` first; anything else is
/// answered and ignored.
async fn accept_code(listener: &tokio::net::TcpListener, state: &str) -> Result<String, Problem> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    loop {
        let (mut socket, _) = listener.accept().await.map_err(|e| Problem::new("local", e.to_string()))?;
        let mut buf = vec![0u8; 8192];
        let n = socket.read(&mut buf).await.unwrap_or(0);
        let request = String::from_utf8_lossy(&buf[..n]);
        let target = request.lines().next().and_then(|line| line.split(' ').nth(1)).unwrap_or("/");
        let url = Url::parse(&format!("http://127.0.0.1{target}")).ok();
        let found = url.filter(|u| u.path() == "/callback").map(|u| {
            let get = |k: &str| u.query_pairs().find(|(n, _)| n == k).map(|(_, v)| v.into_owned());
            (get("code"), get("state"))
        });
        let (status, body) = if found.is_some() { ("200 OK", DONE_PAGE) } else { ("404 Not Found", "") };
        let _ = socket
            .write_all(format!("HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes())
            .await;
        match found {
            Some((Some(code), Some(got))) if got == state => return Ok(code),
            Some(_) => return Err(Problem::new("refused", "the browser came back from a different sign-in; try again")),
            None => continue,
        }
    }
}

// --- the local library --------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    pub id: String,
    pub title: String,
    pub updated_at: String,
}

/// The embedded single-user server answers this with no session: a loopback
/// `Host`, and a GET needs no CSRF.
pub async fn recent_boards(http: &reqwest::Client, library: &Url) -> Result<Vec<Board>, Problem> {
    let reply = http.get(library.join("api/boards").expect("relative path")).send().await.map_err(unreachable)?;
    let mut boards: Vec<Board> = reply
        .error_for_status()
        .map_err(|e| Problem::new("local", format!("the local library did not answer: {e}")))?
        .json()
        .await
        .map_err(|e| Problem::new("local", format!("the local library answered oddly: {e}")))?;
    // ponytail: the list arrives whole and newest first; add ?limit= to /api/boards if a library ever has thousands.
    boards.truncate(RECENT_BOARDS);
    Ok(boards)
}

// --- recent connections -------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub origin: String,
    pub username: String,
}

/// `entry` to the top, no duplicates, five at most. Returns the new list and
/// whatever fell off the end, whose saved passwords should go with it.
pub fn remember(list: Vec<Connection>, entry: Connection) -> (Vec<Connection>, Vec<Connection>) {
    let mut list: Vec<_> = std::iter::once(entry.clone()).chain(list.into_iter().filter(|c| *c != entry)).collect();
    let dropped = list.split_off(list.len().min(RECENT_CONNECTIONS));
    (list, dropped)
}

pub fn load(file: &Path) -> Vec<Connection> {
    std::fs::read(file).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}

pub fn save(file: &Path, list: &[Connection]) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(file, serde_json::to_vec_pretty(list)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    async fn server(single_user: bool) -> Url {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!("visarium-desktop-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        let _ = std::fs::remove_dir_all(&dir);
        let state = visarium::open(visarium::Config {
            database: dir.join("visarium.db"),
            assets: dir.join("assets"),
            derivatives: dir.join("derivatives"),
            version: "test".into(),
            single_user,
            ..Default::default()
        })
        .await
        .unwrap();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let url = format!("http://127.0.0.1:{}/", listener.local_addr().unwrap().port()).parse().unwrap();
        tokio::spawn(visarium::serve(state, listener));
        url
    }

    async fn post_json(http: &reqwest::Client, url: Url, body: serde_json::Value) -> reqwest::Response {
        post(http, url).json(&body).send().await.unwrap()
    }

    #[test]
    fn addresses_normalise_to_origins() {
        assert_eq!(normalise("visarium.example.net/boards").unwrap().as_str(), "https://visarium.example.net/");
        assert_eq!(normalise(" http://nas.local:8080/x?y ").unwrap().as_str(), "http://nas.local:8080/");
        assert_eq!(normalise("nas.local:8080").unwrap().as_str(), "https://nas.local:8080/");
        assert_eq!(normalise("ftp://nas.local").unwrap_err().kind, "invalid");
        assert_eq!(normalise("not an address").unwrap_err().kind, "invalid");
        assert_eq!(normalise("").unwrap_err().kind, "invalid");
    }

    #[test]
    fn provider_links_are_recognised() {
        let link = |u: &str| provider_link(&u.parse().unwrap());
        assert_eq!(
            link("https://v.example.net/auth/oidc/authentik/start?intent=claim&return=%2Fdevice%3Fport%3D1"),
            Some(ProviderLink {
                origin: "https://v.example.net/".parse().unwrap(),
                provider: "authentik".into(),
                intent: "claim".into(),
                back: "/device?port=1".into(),
            })
        );
        assert_eq!(link("https://v.example.net/auth/oidc/google/start?return=//evil.example").unwrap().back, "/");
        assert_eq!(link("https://v.example.net/auth/oidc/google/start").unwrap().intent, "sign-in");
        assert_eq!(link("https://v.example.net/auth/oidc/google/callback?code=x"), None);
        assert_eq!(link("https://v.example.net/boards/abc"), None);
        assert_eq!(link("tauri://localhost/auth/oidc/x/start"), None);
    }

    #[test]
    fn remembering_dedupes_and_keeps_five() {
        let c = |n: usize| Connection { origin: format!("https://s{n}/"), username: "rokas".into() };
        let (list, dropped) = remember((1..=5).map(c).collect(), c(6));
        assert_eq!(list, [6, 1, 2, 3, 4].map(c));
        assert_eq!(dropped, [c(5)]);
        let (list, dropped) = remember(list, c(3));
        assert_eq!(list, [3, 6, 1, 2, 4].map(c));
        assert!(dropped.is_empty());
        let other_user = Connection { username: "ada".into(), ..c(3) };
        assert_eq!(remember(list, other_user.clone()).0[0..2], [other_user, c(3)]);
    }

    #[tokio::test]
    async fn signs_in_to_a_server() {
        let http = client();
        let origin = server(false).await;
        assert_eq!(sign_in(&http, &origin, "rokas", "whatever-password", "test").await, Ok(SignIn::Setup));
        let found = probe(&http, &origin).await.unwrap();
        assert!(found.password_enabled && found.providers.is_empty(), "{found:?}");

        let claim = json_setup();
        assert_eq!(post_json(&http, origin.join("api/setup").unwrap(), claim).await.status(), 201);
        let Ok(SignIn::Session(token)) = sign_in(&http, &origin, "rokas", "correct horse battery", "test").await else { panic!("no session") };
        let me: serde_json::Value = http
            .get(origin.join("api/session").unwrap())
            .header(header::COOKIE, format!("{SESSION_COOKIE}={token}"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(me["user"]["username"], "rokas");

        assert_eq!(session_user(&http, &origin, &token).await.unwrap().as_deref(), Some("rokas"));
        revoke(&http, &origin, &token).await;
        assert_eq!(session_user(&http, &origin, &token).await.unwrap(), None, "forgetting revokes the device");

        let refused = sign_in(&http, &origin, "rokas", "wrong password!!", "test").await.unwrap_err();
        assert_eq!(refused.kind, "refused");
        assert!(refused.message.contains("do not match"), "{}", refused.message);
    }

    fn json_setup() -> serde_json::Value {
        serde_json::json!({ "username": "rokas", "displayName": "Rokas", "password": "correct horse battery" })
    }

    #[tokio::test]
    async fn refuses_what_is_not_visarium() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let origin: Url = format!("http://127.0.0.1:{}/", listener.local_addr().unwrap().port()).parse().unwrap();
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            while let Ok((mut socket, _)) = listener.accept().await {
                let _ = socket.read(&mut [0; 4096]).await;
                let _ = socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi").await;
            }
        });
        assert_eq!(sign_in(&client(), &origin, "a", "b", "t").await.unwrap_err().kind, "not-visarium");

        let closed: Url = "http://127.0.0.1:9/".parse().unwrap();
        assert_eq!(sign_in(&client(), &closed, "a", "b", "t").await.unwrap_err().kind, "unreachable");
    }

    /// The browser half played by the test: sign in on the server, allow the
    /// device the way the SPA's /device page does, follow the redirect.
    #[tokio::test]
    async fn signs_in_through_the_browser() {
        let http = client();
        let origin = server(false).await;
        assert_eq!(post_json(&http, origin.join("api/setup").unwrap(), json_setup()).await.status(), 201);
        let handoff = start_handoff(&origin, "Visarium Desktop on test-mac", None).await.unwrap();
        let query: std::collections::HashMap<_, _> = handoff.url.query_pairs().into_owned().collect();
        assert_eq!(handoff.url.path(), "/device");

        let browser = client();
        let signed = post(&browser, origin.join("api/session").unwrap())
            .json(&serde_json::json!({ "username": "rokas", "password": "correct horse battery" }))
            .send()
            .await
            .unwrap();
        let cookie = signed.headers()[header::SET_COOKIE].to_str().unwrap().split(';').next().unwrap().to_string();
        let allowed: serde_json::Value = browser
            .post(origin.join("api/device/authorize").unwrap())
            .header(header::COOKIE, format!("XSRF-TOKEN={CSRF}; {cookie}"))
            .header("X-XSRF-TOKEN", CSRF)
            .json(&serde_json::json!({ "port": query["port"].parse::<u16>().unwrap(), "challenge": query["challenge"], "state": query["state"], "label": query["label"] }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let redirect = allowed["redirect"].as_str().unwrap().to_string();
        let follow = tokio::spawn(async move {
            // A browser often asks for the favicon first.
            let base = redirect.split("/callback").next().unwrap().to_string();
            let _ = reqwest::get(format!("{base}/favicon.ico")).await;
            reqwest::get(redirect).await.unwrap().text().await.unwrap()
        });
        let (token, username) = finish_handoff(&http, &origin, handoff, Duration::from_secs(10)).await.unwrap();
        assert!(follow.await.unwrap().contains("You can close this tab"));
        assert_eq!(username, "rokas");
        assert_eq!(session_user(&http, &origin, &token).await.unwrap().as_deref(), Some("rokas"));
    }

    #[tokio::test]
    async fn a_browser_answer_for_another_sign_in_is_refused() {
        let origin: Url = "http://127.0.0.1:9/".parse().unwrap();
        let handoff = start_handoff(&origin, "x", Some("corp")).await.unwrap();
        assert!(handoff.url.query_pairs().any(|(k, v)| k == "provider" && v == "corp"));
        let port = handoff.url.query_pairs().find(|(k, _)| k == "port").unwrap().1.to_string();
        tokio::spawn(async move { reqwest::get(format!("http://127.0.0.1:{port}/callback?code=c&state=not-ours")).await });
        let refused = finish_handoff(&client(), &origin, handoff, Duration::from_secs(10)).await.unwrap_err();
        assert_eq!(refused.kind, "refused");
    }

    #[tokio::test]
    async fn lists_the_newest_local_boards() {
        let http = client();
        let library = server(true).await;
        for n in 0..10 {
            let reply = post_json(&http, library.join("api/boards").unwrap(), serde_json::json!({ "title": format!("b{n}") })).await;
            assert_eq!(reply.status(), 201);
            tokio::time::sleep(Duration::from_millis(3)).await;
        }
        let titles: Vec<_> = recent_boards(&http, &library).await.unwrap().into_iter().map(|b| b.title).collect();
        assert_eq!(titles, ["b9", "b8", "b7", "b6", "b5", "b4", "b3", "b2"]);
    }
}
