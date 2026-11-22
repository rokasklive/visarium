//! Demo mode (`VISARIUM_DEMO=on`): a public place to try Visarium that cannot
//! be used for work or abuse.
//!
//! Every visitor gets a sandbox of their own: a whole single-user instance
//! (its own SQLite file and image folder under `VISARIUM_DEMO_ROOT`), opened in
//! this process when they press Start, routed to by a cookie only they hold,
//! and deleted when it ends. Nothing a visitor adds is reachable by anyone
//! else, so the demo is worthless as file hosting, and nobody sees anybody
//! else's boards. Inside a sandbox everything is the real product; around it,
//! the gateway here decides who reaches which sandbox, how many exist, how
//! fast each may be called, and when each ends.
//!
//! One process, one container: a sandbox is a few file handles and a few
//! hundred kilobytes until its visitor adds images, and their total is capped.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::Body;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header};
use axum::response::{Html, IntoResponse, Response};
use serde_json::{Value, json};
use sqlx::SqliteConnection;
use tower::ServiceExt;

use crate::error::{ApiError, ApiResult};
use crate::{AppState, Config};

// --- the policy one sandbox runs under ---------------------------------------------

/// What one sandbox may hold, and when it ends. Set on its `Config`.
#[derive(Clone, Debug)]
pub struct Policy {
    /// When the sandbox is deleted, ISO-8601 UTC, as the SPA counts down to.
    pub ends_at: String,
    pub max_boards: i64,
    /// Items across all its boards.
    pub max_items: i64,
    /// Bytes of images a visitor may add, on top of the seed's.
    pub storage_bytes: u64,
}

impl Policy {
    pub fn view(&self) -> Value {
        json!({
            "endsAt": self.ends_at,
            "maxBoards": self.max_boards,
            "maxItems": self.max_items,
            "storageBytes": self.storage_bytes,
        })
    }
}

fn limit(detail: String) -> ApiError {
    ApiError::new(StatusCode::FORBIDDEN, detail).titled("Demo limit")
}

/// Refuses a new board past the sandbox's allowance. Nothing on a real instance.
pub async fn boards_fit(app: &AppState) -> ApiResult<()> {
    let Some(p) = &app.config.demo else {
        return Ok(());
    };
    let boards: i64 = sqlx::query_scalar("SELECT count(*) FROM canvas")
        .fetch_one(&app.db)
        .await?;
    if boards >= p.max_boards {
        return Err(limit(format!(
            "The demo holds up to {} boards. Delete one to make another.",
            p.max_boards
        )));
    }
    Ok(())
}

/// Refuses `adding` more items past the sandbox's allowance, inside the
/// transaction that would add them. Nothing on a real instance.
pub async fn items_fit(app: &AppState, tx: &mut SqliteConnection, adding: i64) -> ApiResult<()> {
    let Some(p) = &app.config.demo else {
        return Ok(());
    };
    if adding == 0 {
        return Ok(());
    }
    let items: i64 = sqlx::query_scalar("SELECT count(*) FROM canvas_item")
        .fetch_one(&mut *tx)
        .await?;
    if items + adding > p.max_items {
        return Err(limit(format!(
            "The demo holds up to {} items across its boards. Delete some to add more.",
            p.max_items
        )));
    }
    Ok(())
}

// --- the gateway -------------------------------------------------------------------

/// The gateway's settings, from `VISARIUM_DEMO_*`.
#[derive(Clone, Debug)]
pub struct Settings {
    /// Where sandboxes live; emptied at start. A tmpfs is ideal.
    pub root: PathBuf,
    /// An instance's data directory (`db/visarium.db`, `assets/`,
    /// `derivatives/`) every sandbox starts as a copy of: the curated boards.
    pub seed: Option<PathBuf>,
    pub lifetime: Duration,
    pub max_sandboxes: usize,
    /// Sandboxes one address may start per hour.
    pub starts_per_hour: u32,
    /// Requests per second one sandbox may make, and the burst above it.
    pub requests_per_second: f64,
    pub burst: f64,
    /// The header that carries the visitor's address when a proxy is in
    /// front (`Cf-Connecting-IP`); the peer address otherwise.
    pub ip_header: Option<HeaderName>,
    pub policy: PolicyLimits,
    pub version: String,
    /// How often ended sandboxes are cleared away; tests shorten it.
    pub sweep_every: Duration,
}

#[derive(Clone, Debug)]
pub struct PolicyLimits {
    pub max_boards: i64,
    pub max_items: i64,
    pub storage_bytes: u64,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            root: PathBuf::from("data/demo"),
            seed: None,
            lifetime: Duration::from_secs(2 * 3600),
            max_sandboxes: 100,
            starts_per_hour: 5,
            requests_per_second: 20.0,
            burst: 200.0,
            ip_header: None,
            policy: PolicyLimits {
                max_boards: 10,
                max_items: 1000,
                storage_bytes: 50_000_000,
            },
            version: String::new(),
            sweep_every: Duration::from_secs(30),
        }
    }
}

/// The name of the cookie that says which sandbox is yours.
const COOKIE: &str = "visarium_demo";

struct Sandbox {
    router: Router,
    app: AppState,
    dir: PathBuf,
    ends: Instant,
    /// For eviction when full: the longest unseen goes first.
    seen: Mutex<Instant>,
    /// Token bucket: (tokens, last refill).
    bucket: Mutex<(f64, Instant)>,
}

pub struct Gateway {
    settings: Settings,
    sandboxes: Mutex<HashMap<String, Arc<Sandbox>>>,
    /// Start times per address, the last hour's.
    starts: Mutex<HashMap<String, Vec<Instant>>>,
    /// One decode budget for every sandbox: memory is the process's.
    decode: Arc<tokio::sync::Semaphore>,
    /// The seed, copied once at start so a running seed instance is read
    /// consistently (`VACUUM INTO`); each sandbox copies this.
    template: Option<PathBuf>,
    /// Serialises starts, so the capacity check and the insert agree.
    starting: tokio::sync::Mutex<()>,
}

pub type GatewayState = Arc<Gateway>;

/// Prepares the root (emptied: sandboxes do not outlive the process) and the
/// seed template, and starts the sweeper.
pub async fn open(settings: Settings) -> crate::anyhow_lite::Result<GatewayState> {
    if settings.root.exists() {
        std::fs::remove_dir_all(&settings.root)?;
    }
    std::fs::create_dir_all(&settings.root)?;
    let template = match &settings.seed {
        None => None,
        Some(seed) => {
            let db = seed.join("db").join("visarium.db");
            if !db.exists() {
                return Err(format!(
                    "VISARIUM_DEMO_SEED is {}, which has no db/visarium.db",
                    seed.display()
                )
                .into());
            }
            let out = settings.root.join(".template.db");
            let options = sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&db)
                .read_only(true);
            let mut conn = sqlx::ConnectOptions::connect(&options).await?;
            sqlx::query("VACUUM INTO ?")
                .bind(out.to_string_lossy().to_string())
                .execute(&mut conn)
                .await?;
            Some(out)
        }
    };
    let gateway = Arc::new(Gateway {
        decode: Arc::new(tokio::sync::Semaphore::new(
            crate::assets::DECODE_BUDGET_MIB as usize,
        )),
        settings,
        sandboxes: Default::default(),
        starts: Default::default(),
        template,
        starting: Default::default(),
    });
    let weak = Arc::downgrade(&gateway);
    tokio::spawn(async move {
        let Some(g) = weak.upgrade() else { return };
        let mut every = tokio::time::interval(g.settings.sweep_every);
        drop(g);
        loop {
            every.tick().await;
            let Some(g) = weak.upgrade() else { break };
            g.sweep();
        }
    });
    tracing::info!(
        root = %gateway.settings.root.display(),
        seeded = gateway.template.is_some(),
        max_sandboxes = gateway.settings.max_sandboxes,
        lifetime_mins = gateway.settings.lifetime.as_secs() / 60,
        "demo gateway ready"
    );
    Ok(gateway)
}

impl Gateway {
    /// Ends the sandboxes whose time is up.
    fn sweep(&self) {
        let now = Instant::now();
        let ended: Vec<(String, Arc<Sandbox>)> = {
            let mut map = self.sandboxes.lock().unwrap();
            let keys: Vec<String> = map
                .iter()
                .filter(|(_, s)| s.ends <= now)
                .map(|(k, _)| k.clone())
                .collect();
            keys.into_iter()
                .filter_map(|k| map.remove(&k).map(|s| (k, s)))
                .collect()
        };
        for (_, s) in ended {
            close(s, "ended");
        }
        let hour_ago = now.checked_sub(Duration::from_secs(3600));
        self.starts.lock().unwrap().retain(|_, times| {
            times.retain(|t| hour_ago.is_none_or(|h| *t > h));
            !times.is_empty()
        });
    }

    pub fn count(&self) -> usize {
        self.sandboxes.lock().unwrap().len()
    }

    fn find(&self, token: &str) -> Option<Arc<Sandbox>> {
        let s = self.sandboxes.lock().unwrap().get(token).cloned()?;
        (s.ends > Instant::now()).then_some(s)
    }

    /// A start is allowed for this address, and there is room (making room
    /// by ending the longest-unseen sandbox, if it has been quiet a while).
    fn admit(&self, address: &str) -> Result<(), &'static str> {
        let now = Instant::now();
        {
            let mut starts = self.starts.lock().unwrap();
            let times = starts.entry(address.to_string()).or_default();
            if times.len() as u32 >= self.settings.starts_per_hour {
                return Err(TOO_MANY_STARTS);
            }
            times.push(now);
        }
        let mut map = self.sandboxes.lock().unwrap();
        if map.len() < self.settings.max_sandboxes {
            return Ok(());
        }
        let quiet = map
            .iter()
            .map(|(k, s)| (k.clone(), *s.seen.lock().unwrap()))
            .min_by_key(|(_, seen)| *seen)
            .filter(|(_, seen)| now.duration_since(*seen) > Duration::from_secs(600));
        match quiet.and_then(|(k, _)| map.remove(&k)) {
            Some(evicted) => {
                drop(map);
                close(evicted, "evicted to make room");
                Ok(())
            }
            None => Err(FULL),
        }
    }

    async fn start(&self) -> crate::anyhow_lite::Result<(String, Arc<Sandbox>)> {
        let token = crate::auth::random_token();
        let dir = self.settings.root.join(crate::new_id());
        std::fs::create_dir_all(dir.join("db"))?;
        if let (Some(template), Some(seed)) = (&self.template, &self.settings.seed) {
            std::fs::copy(template, dir.join("db").join("visarium.db"))?;
            // Originals are content-addressed and never rewritten, and
            // derivatives are replaced by rename: links are safe, and free.
            for part in ["assets", "derivatives"] {
                link_tree(&seed.join(part), &dir.join(part))?;
            }
        }
        let ends_in = self.settings.lifetime;
        let ends_at = (std::time::SystemTime::now() + ends_in)
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let limits = &self.settings.policy;
        let config = Config {
            database: dir.join("db").join("visarium.db"),
            assets: dir.join("assets"),
            derivatives: dir.join("derivatives"),
            version: self.settings.version.clone(),
            single_user: true,
            password_disabled: true,
            sharing_disabled: true,
            client_documents_disabled: true,
            demo: Some(Policy {
                ends_at: iso_millis(ends_at),
                max_boards: limits.max_boards,
                max_items: limits.max_items,
                storage_bytes: limits.storage_bytes,
            }),
            decode_permits: Some(self.decode.clone()),
            ..Default::default()
        };
        let app = crate::open(config).await?;
        // The visitor's allowance sits on top of what the seed already holds.
        let seeded: i64 = sqlx::query_scalar("SELECT coalesce(sum(byte_size), 0) FROM asset")
            .fetch_one(&app.db)
            .await?;
        sqlx::query(
            "INSERT INTO storage_setting (id, limit_bytes) VALUES (1, ?1) \
             ON CONFLICT (id) DO UPDATE SET limit_bytes = ?1",
        )
        .bind(seeded + limits.storage_bytes as i64)
        .execute(&app.db)
        .await?;
        let now = Instant::now();
        let sandbox = Arc::new(Sandbox {
            router: crate::router(app.clone()),
            app,
            dir,
            ends: now + ends_in,
            seen: Mutex::new(now),
            bucket: Mutex::new((self.settings.burst, now)),
        });
        self.sandboxes
            .lock()
            .unwrap()
            .insert(token.clone(), sandbox.clone());
        Ok((token, sandbox))
    }
}

const TOO_MANY_STARTS: &str =
    "This address has started several demos in the last hour. Try again later.";
const FULL: &str = "The demo is full right now. Try again in a few minutes.";

/// Ends a sandbox: its sockets are told, and once nothing holds it, its
/// database is closed and its folder deleted.
fn close(s: Arc<Sandbox>, why: &'static str) {
    s.app.closing.cancel();
    tokio::spawn(async move {
        // Requests in flight hold the sandbox, open sockets the app; give
        // both a moment. The router holds the app too, so it goes first.
        let mut s = s;
        let give_up = Instant::now() + Duration::from_secs(30);
        let sandbox = loop {
            match Arc::try_unwrap(s) {
                Ok(sandbox) => break Some(sandbox),
                Err(again) => s = again,
            }
            if Instant::now() > give_up {
                break None;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        };
        let Some(Sandbox {
            router, app, dir, ..
        }) = sandbox
        else {
            tracing::warn!(
                why,
                "demo sandbox still in use; its folder is left for the next start"
            );
            return;
        };
        drop(router);
        for _ in 0..100 {
            if Arc::strong_count(&app) <= 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        app.db.close().await;
        drop(app);
        let removed = tokio::task::spawn_blocking(move || std::fs::remove_dir_all(dir)).await;
        match removed {
            Ok(Ok(())) => tracing::info!(why, "demo sandbox ended"),
            other => tracing::warn!(why, result = ?other, "demo sandbox folder not removed"),
        }
    });
}

/// Hard-links every file under `from` into the same place under `to`,
/// copying where a link is not possible (another filesystem).
fn link_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    if !from.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            link_tree(&entry.path(), &target)?;
        } else if std::fs::hard_link(entry.path(), &target).is_err() {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Milliseconds since the epoch as `2026-11-21T17:04:44.918Z`.
fn iso_millis(ms: u128) -> String {
    let secs = (ms / 1000) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Howard Hinnant's days-to-civil.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        ms % 1000
    )
}

fn cookie_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|c| c.trim().split_once('='))
        .find(|(k, _)| *k == COOKIE)
        .map(|(_, v)| v.to_string())
}

fn address(g: &Gateway, req: &Request) -> String {
    if let Some(name) = &g.settings.ip_header
        && let Some(v) = req.headers().get(name).and_then(|v| v.to_str().ok())
    {
        return v.split(',').next().unwrap_or("").trim().to_string();
    }
    req.extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|c| c.0.ip().to_string())
        .unwrap_or_default()
}

/// What no sandbox may reach: agents and the sign-in machinery they need, and
/// every account and instance setting. A sandbox's one account is the
/// single-user admin, so without this a visitor could lift their own storage
/// limit or point the vision model at any address.
/// ponytail: agents in the demo are a later step (a token per sandbox).
fn blocked(path: &str) -> bool {
    [
        "/mcp",
        "/oauth",
        "/.well-known",
        "/auth",
        "/api/instance",
        "/api/accounts",
        "/api/agent-tokens",
        "/api/agent-settings",
        "/api/sessions",
        "/api/invitations",
        "/api/shares",
        "/api/setup",
    ]
    .iter()
    .any(|p| path == *p || path.starts_with(&format!("{p}/")))
}

pub fn router(gateway: GatewayState) -> Router {
    Router::new()
        .route(
            "/health",
            axum::routing::get(|| async { axum::Json(json!({ "status": "UP" })) }),
        )
        .route("/demo/start", axum::routing::post(start))
        .fallback(forward)
        // The start page gets the app's headers; a sandbox's answers have them.
        .layer(axum::middleware::from_fn(crate::security_headers))
        .with_state(gateway)
}

async fn start(State(g): State<GatewayState>, req: Request) -> Response {
    let address = address(&g, &req);
    let secure = crate::auth::is_secure(req.headers());
    let _one_at_a_time = g.starting.lock().await;
    if let Err(why) = g.admit(&address) {
        return page(StatusCode::TOO_MANY_REQUESTS, Some(why));
    }
    match g.start().await {
        Ok((token, _)) => {
            tracing::info!(sandboxes = g.count(), "demo sandbox started");
            let max_age = g.settings.lifetime.as_secs();
            let cookie = format!(
                "{COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{}",
                if secure { "; Secure" } else { "" }
            );
            Response::builder()
                .status(StatusCode::SEE_OTHER)
                .header(header::LOCATION, "/")
                .header(header::SET_COOKIE, HeaderValue::from_str(&cookie).unwrap())
                .header(header::CACHE_CONTROL, "no-store")
                .body(Body::empty())
                .unwrap()
        }
        Err(e) => {
            tracing::error!(error = %e, "demo sandbox could not start");
            page(
                StatusCode::SERVICE_UNAVAILABLE,
                Some("The demo could not start. Try again in a moment."),
            )
        }
    }
}

async fn forward(State(g): State<GatewayState>, req: Request) -> Response {
    let path = req.uri().path().to_string();
    if blocked(&path) {
        return ApiError::not_found("not part of the demo").into_response();
    }
    let token = cookie_token(req.headers());
    let Some(sandbox) = token.as_deref().and_then(|t| g.find(t)) else {
        // A page shows the start screen; anything else says why plainly.
        if req.method() == Method::GET && !path.starts_with("/api/") && !path.starts_with("/ws/") {
            let ended = token.is_some().then_some(
                "Your demo has ended, and everything in it was deleted. Start a new one whenever you like.",
            );
            return page(StatusCode::OK, ended);
        }
        return ApiError::unauthorized("this demo has ended; reload the page to start a new one")
            .titled("Demo ended")
            .into_response();
    };
    if !take(&sandbox, &g.settings) {
        return ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "too many requests from this demo at once; slow down a little",
        )
        .into_response();
    }
    *sandbox.seen.lock().unwrap() = Instant::now();
    match sandbox.router.clone().oneshot(req).await {
        Ok(response) => response,
        Err(never) => match never {},
    }
}

/// One request from this sandbox's bucket, refilled at the steady rate.
fn take(s: &Sandbox, settings: &Settings) -> bool {
    let mut bucket = s.bucket.lock().unwrap();
    let now = Instant::now();
    let refill = now.duration_since(bucket.1).as_secs_f64() * settings.requests_per_second;
    bucket.0 = (bucket.0 + refill).min(settings.burst);
    bucket.1 = now;
    if bucket.0 < 1.0 {
        return false;
    }
    bucket.0 -= 1.0;
    true
}

/// The start screen: what this is, what it is not, and one button. Plain
/// HTML with the product's own colours, no script.
fn page(status: StatusCode, notice: Option<&str>) -> Response {
    let notice = notice
        .map(|n| format!("<p class=\"notice\" role=\"status\">{}</p>", html_escape(n)))
        .unwrap_or_default();
    let body = START_PAGE.replace("{notice}", &notice);
    let mut response = (status, Html(body)).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

const START_PAGE: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Try Visarium</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: oklch(0.18 0.006 265); color: oklch(0.92 0.004 265);
         font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 440px; padding: 24px; }
  h1 { font-size: 16px; font-weight: 600; margin: 0 0 12px; }
  p { margin: 0 0 12px; color: oklch(0.66 0.006 265); }
  ul { margin: 0 0 20px; padding-left: 18px; color: oklch(0.66 0.006 265); }
  .notice { color: oklch(0.92 0.004 265); border: 1px solid oklch(0.3 0.008 265);
            border-radius: 2px; padding: 8px; }
  button { font: inherit; color: oklch(0.92 0.004 265); background: transparent;
           border: 1px solid oklch(0.51 0.008 265); border-radius: 2px; padding: 4px 12px; cursor: pointer; }
  button:hover { background: oklch(0.22 0.006 265); }
  button:focus-visible { outline: 2px solid oklch(0.72 0.15 215); outline-offset: 2px; }
</style>
</head>
<body>
<main>
  <h1>Try Visarium</h1>
  {notice}
  <p>A board for images, notes, diagrams and checklists, linked together. This demo is the real thing, with nothing to sign up for.</p>
  <ul>
    <li>It is yours alone: nobody else can see what you add.</li>
    <li>Everything in it is deleted after two hours.</li>
    <li>It holds a few boards and some images, enough to get a feel for it, not to work in.</li>
  </ul>
  <form method="post" action="/demo/start"><button type="submit">Start the demo</button></form>
</main>
</body>
</html>
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_dates_are_right() {
        assert_eq!(iso_millis(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_millis(1_795_272_284_918), "2026-11-21T14:44:44.918Z");
        assert_eq!(iso_millis(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn agents_sign_in_and_settings_are_not_part_of_the_demo() {
        for p in [
            "/mcp",
            "/oauth/token",
            "/.well-known/oauth-protected-resource",
            "/auth/oidc/x/start",
            "/api/instance/storage",
            "/api/instance/vision/test",
            "/api/accounts/me",
            "/api/agent-tokens",
            "/api/agent-settings",
            "/api/sessions",
            "/api/shares/x",
            "/api/setup",
        ] {
            assert!(blocked(p), "{p}");
        }
        // The board app itself, including the session it starts from.
        for p in [
            "/",
            "/settings",
            "/api/boards",
            "/api/session",
            "/api/shared/x",
            "/ws/canvas/x",
            "/authors",
        ] {
            assert!(!blocked(p), "{p}");
        }
    }

    #[test]
    fn the_cookie_is_found_among_others() {
        let mut h = HeaderMap::new();
        h.insert(
            header::COOKIE,
            HeaderValue::from_static("XSRF-TOKEN=a; visarium_demo=tok; x=y"),
        );
        assert_eq!(cookie_token(&h).as_deref(), Some("tok"));
    }
}
