//! Visarium's server: the API, the realtime socket, the image pipeline and the
//! SPA, in one process over one SQLite file and one directory of originals.
//!
//! The same library runs two ways:
//!   * self-hosted (`visarium` binary): accounts, sessions, several people,
//!     sign-in by password and/or OpenID Connect, read-only share links;
//!   * embedded in the desktop app: `single_user`, one implicit account, bound
//!     to loopback, and no sign-in screen.

pub mod agent;
pub mod assets;
pub mod auth;
pub mod boards;
pub mod collections;
pub mod collision;
pub mod device;
pub mod error;
pub mod instance;
pub mod invitations;
pub mod oauth;
pub mod oidc;
pub mod realtime;
pub mod sharing;
pub mod telemetry;
pub mod vision;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{DefaultBodyLimit, State};
use axum::http::{StatusCode, Uri, header};
use axum::middleware::{from_fn, from_fn_with_state};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;
use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use tower_http::compression::CompressionLayer;

use crate::error::ApiError;

/// Must match PROTOCOL_VERSION in packages/canvas-core/src/protocol.ts.
pub const PROTOCOL_VERSION: i64 = 4;

#[derive(Clone, Debug, Default)]
pub struct Config {
    /// The SQLite file. Canonical data, with `assets`.
    pub database: PathBuf,
    /// Originals, content-addressed. Canonical data.
    pub assets: PathBuf,
    /// The WebP ladder. A regenerable cache.
    pub derivatives: PathBuf,
    pub version: String,
    /// One implicit admin, every request already signed in as them. For the
    /// desktop app and for development; refused on a non-loopback bind.
    pub single_user: bool,
    /// SSO only: no password sign-in, set-up or reset.
    pub password_disabled: bool,
    /// No share links.
    pub sharing_disabled: bool,
    /// The address people reach this instance at, e.g.
    /// `https://visarium.example.net`. Needed to tell providers where to send
    /// people back: behind a proxy, `Host` is not trustworthy enough.
    pub public_url: Option<String>,
    pub providers: Vec<oidc::ProviderConfig>,
    /// OAuth clients may not identify by a Client ID Metadata Document: for a
    /// server that cannot reach the internet to fetch one. They register.
    pub client_documents_disabled: bool,
    /// The vision model from VISARIUM_VISION_*; when set, the app cannot change it.
    pub vision: Option<vision::Setting>,
}

pub struct App {
    pub db: SqlitePool,
    pub config: Config,
    pub throttle: auth::LoginThrottle,
    pub oidc: oidc::Providers,
    pub http: oidc::Http,
    pub flows: oidc::Flows,
    pub device_codes: device::Codes,
    /// OAuth sign-ins waiting for consent, and codes waiting to be redeemed.
    pub oauth: oauth::Pending,
    pub oauth_registrations: oauth::Registrations,
    /// The vision model in force, and the describer's wake-up signal.
    pub vision: vision::Vision,
    pub rooms: realtime::Rooms,
    /// Writes per agent per minute (ADR-0031).
    pub agent_writes: agent::Limiter,
    /// Bounds how many images decode at once: a 12-megapixel decode is ~50 MB
    /// of pixels, and a dropped folder should not be forty of them in parallel.
    pub image_permits: tokio::sync::Semaphore,
    /// Serialises claiming a fresh instance, so two first requests cannot both
    /// become its admin.
    pub setup_lock: tokio::sync::Mutex<()>,
    /// The single-user account's id, when `single_user`.
    pub local_user: Option<String>,
    /// Lets agents import images from private addresses. Off, and only ever
    /// turned on by tests that serve images from loopback.
    pub allow_private_imports: std::sync::atomic::AtomicBool,
}

pub type AppState = Arc<App>;

/// ISO-8601 UTC with milliseconds — the same text SQLite's defaults write, so
/// timestamps compare as strings.
pub const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/// How often expired sessions are cleared out.
const SWEEP_EVERY: Duration = Duration::from_secs(3600);

pub async fn open(config: Config) -> anyhow_lite::Result<AppState> {
    if !config.single_user && !config.providers.is_empty() && config.public_url.is_none() {
        return Err("VISARIUM_PUBLIC_URL is required when a sign-in provider is configured".into());
    }
    for dir in [&config.assets, &config.derivatives] {
        std::fs::create_dir_all(dir)?;
    }
    if let Some(parent) = config.database.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let options = SqliteConnectOptions::new()
        .filename(&config.database)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(10));
    let db = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await?;
    let migrator = sqlx::migrate!("./migrations");
    // A fresh file has no table yet: everything is about to be applied.
    let applied: Vec<i64> = sqlx::query_scalar("SELECT version FROM _sqlx_migrations")
        .fetch_all(&db)
        .await
        .unwrap_or_default();
    migrator.run(&db).await?;
    for m in migrator.iter().filter(|m| !applied.contains(&m.version)) {
        tracing::info!(version = m.version, description = %m.description, "migration applied");
    }

    let local_user = if config.single_user {
        Some(auth::ensure_local_user(&db).await?)
    } else {
        None
    };
    let http = oidc::Http::default();
    let mut providers = Vec::new();
    if !config.single_user {
        let stored = oidc::stored(&db).await?;
        providers = oidc::build(&config.providers, &stored, &[], &http).await;
        let ids: Vec<String> = providers.iter().map(|p| p.id.clone()).collect();
        if oidc::way_in(!config.password_disabled, &ids, None).is_err() {
            return Err(NO_WAY_IN.into());
        }
        if config.password_disabled {
            warn_unreachable_accounts(&db, &ids).await?;
        }
        let db = db.clone();
        tokio::spawn(async move {
            let mut every = tokio::time::interval(SWEEP_EVERY);
            loop {
                every.tick().await;
                let started = std::time::Instant::now();
                match auth::sweep(&db).await {
                    Ok(()) => tracing::debug!(
                        duration_ms = started.elapsed().as_millis() as u64,
                        "session sweep done"
                    ),
                    Err(e) => tracing::warn!(error = %e, "session sweep failed"),
                }
                if let Err(e) = oauth::sweep(&db).await {
                    tracing::warn!(error = %e, "oauth sweep failed");
                }
            }
        });
    }
    // What this instance is, for whoever reads the log first. No secrets.
    tracing::info!(
        version = %config.version,
        protocol = PROTOCOL_VERSION,
        single_user = config.single_user,
        password_sign_in = !config.single_user && !config.password_disabled,
        providers = %providers.iter().map(|p| p.id.as_str()).collect::<Vec<_>>().join(","),
        sharing = !config.single_user && !config.sharing_disabled,
        public_url = config.public_url.as_deref().unwrap_or("-"),
        "server ready"
    );
    let cpus = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2);
    let app = Arc::new(App {
        db,
        config,
        throttle: Default::default(),
        oidc: std::sync::RwLock::new(providers),
        http,
        flows: Default::default(),
        device_codes: Default::default(),
        oauth: Default::default(),
        oauth_registrations: Default::default(),
        vision: Default::default(),
        rooms: Default::default(),
        agent_writes: Default::default(),
        image_permits: tokio::sync::Semaphore::new(cpus.clamp(1, 4)),
        setup_lock: Default::default(),
        local_user,
        allow_private_imports: Default::default(),
    });
    vision::load(&app).await?;
    vision::spawn(Arc::downgrade(&app));
    // An agent stays on a board's participant list while it keeps calling;
    // this drops the ones that went quiet. Weak, so it ends with the app.
    let weak = Arc::downgrade(&app);
    tokio::spawn(async move {
        let mut every = tokio::time::interval(Duration::from_secs(5));
        loop {
            every.tick().await;
            let Some(app) = weak.upgrade() else { break };
            app.rooms.sweep_agents();
        }
    });
    Ok(app)
}

/// Why a server with no way to sign in refuses to start, and what to do.
pub const NO_WAY_IN: &str = "Visarium did not start: nobody could sign in.

Password sign-in is off unless VISARIUM_AUTH_PASSWORD=on is set, and no sign-in
provider is configured: none in the environment (VISARIUM_OIDC_*) and none added
in Instance Settings. With neither, no one could sign in, and a new instance
could not even be claimed by its first admin.

We recommend signing in through an OpenID Connect provider (Google, Authentik,
Microsoft Entra, Okta, Keycloak, ...). To get there, either:

  - Set a provider in the environment and restart:
      VISARIUM_PUBLIC_URL=https://visarium.example.net
      VISARIUM_OIDC_GOOGLE_CLIENT_ID=...
      VISARIUM_OIDC_GOOGLE_CLIENT_SECRET=...
    (any other provider also needs VISARIUM_OIDC_{ID}_ISSUER), or

  - Turn password sign-in on for a moment: set VISARIUM_AUTH_PASSWORD=on and
    restart; sign in (or claim the instance) as an admin; add a provider under
    Instance Settings > Sign-in and link it to your account under Settings;
    then remove VISARIUM_AUTH_PASSWORD and restart.

If you mean to keep password sign-in, leave VISARIUM_AUTH_PASSWORD=on.";

/// With password sign-in off, accounts linked to none of the configured
/// providers cannot sign in. Not a reason to refuse to start (a provider may
/// be linked later), but worth saying loudly, admins first.
async fn warn_unreachable_accounts(db: &SqlitePool, providers: &[String]) -> sqlx::Result<()> {
    let placeholders = vec!["?"; providers.len()].join(", ");
    let sql = format!(
        "SELECT username, role = 'admin' FROM app_user u
          WHERE u.deactivated_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM user_identity i WHERE i.user_id = u.id AND i.provider IN ({placeholders}))
          ORDER BY role = 'admin' DESC, username"
    );
    let mut q = sqlx::query_as::<_, (String, bool)>(sqlx::AssertSqlSafe(sql));
    for p in providers {
        q = q.bind(p);
    }
    let stranded = q.fetch_all(db).await?;
    if stranded.is_empty() {
        return Ok(());
    }
    let admins: Vec<&str> = stranded
        .iter()
        .filter(|(_, admin)| *admin)
        .map(|(u, _)| u.as_str())
        .collect();
    let all: Vec<&str> = stranded.iter().map(|(u, _)| u.as_str()).collect();
    tracing::warn!(
        accounts = all.len(),
        usernames = %all.join(","),
        admins = %admins.join(","),
        "password sign-in is off (VISARIUM_AUTH_PASSWORD), and these accounts are linked to no configured provider, so they cannot sign in. Set VISARIUM_AUTH_PASSWORD=on until each has linked a provider under Settings."
    );
    Ok(())
}

pub fn router(state: AppState) -> Router {
    let require_user = from_fn(auth::require_user);
    let require_viewer = from_fn(auth::require_viewer);

    // Members (and the single-user local account). Everything is here unless
    // it has a reason not to be.
    let private_api = Router::new()
        .route("/meta", get(meta))
        .merge(auth::account_routes())
        .merge(oidc::identity_routes())
        .merge(invitations::admin_routes())
        .merge(instance::routes())
        .merge(vision::routes())
        .merge(sharing::member_routes())
        .merge(device::member_routes())
        .merge(agent::member_routes())
        .merge(oauth::member_routes())
        .merge(boards::routes())
        .merge(collections::routes())
        .merge(assets::routes())
        .route_layer(require_user.clone());

    // Share-link viewers: reads of one board, nothing that writes (ADR-0026).
    let shared_api = sharing::viewer_routes()
        .route_layer(require_viewer.clone())
        .layer(from_fn(sharing::private_headers));

    // Open: who am I, signing in, and redeeming the secrets that grant access.
    let api = Router::new()
        .route(
            "/session",
            get(auth::current)
                .post(auth::sign_in)
                .delete(auth::sign_out),
        )
        .route("/setup", post(auth::claim))
        .route("/shared/session", post(sharing::redeem))
        .merge(invitations::public_routes())
        .merge(device::public_routes())
        .merge(shared_api)
        .merge(private_api)
        .fallback(|| async { ApiError::not_found("no such endpoint") })
        .layer(DefaultBodyLimit::max(32 * 1024 * 1024));

    // Agents: bearer token or the local account, never a cookie (ADR-0031).
    // Room for an image passed as data: 8 MB is about 11 MB of base64.
    let agents = agent::routes()
        .route_layer(from_fn_with_state(state.clone(), agent::require_agent))
        .layer(DefaultBodyLimit::max(16 * 1024 * 1024));

    Router::new()
        .nest("/api", api)
        .merge(agents)
        .route(
            "/ws/canvas/{id}",
            get(realtime::upgrade).route_layer(require_user),
        )
        .route(
            "/ws/shared",
            get(realtime::upgrade_viewer).route_layer(require_viewer),
        )
        .merge(oidc::routes())
        .merge(oauth::routes())
        .route("/health", get(health))
        .route("/health/{probe}", get(health))
        .fallback(spa)
        .layer(from_fn_with_state(state.clone(), auth::session_layer))
        .layer(from_fn(auth::csrf_layer))
        .layer(from_fn(security_headers))
        .layer(CompressionLayer::new())
        .layer(from_fn(telemetry::http))
        .with_state(state)
}

/// On every response: no MIME sniffing, framed only by this origin, and an
/// API answer that says nothing about caching is kept out of shared caches.
async fn security_headers(req: axum::extract::Request, next: axum::middleware::Next) -> Response {
    let api = req.uri().path().starts_with("/api/");
    let mut response = next.run(req).await;
    let h = response.headers_mut();
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        header::HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        header::HeaderValue::from_static("frame-ancestors 'self'"),
    );
    if api {
        h.entry(header::CACHE_CONTROL)
            .or_insert(header::HeaderValue::from_static("private, no-cache"));
    }
    response
}

/// Runs until the listener closes or the process ends.
pub async fn serve(state: AppState, listener: tokio::net::TcpListener) -> std::io::Result<()> {
    axum::serve(listener, router(state)).await
}

async fn meta(State(app): State<AppState>) -> Json<serde_json::Value> {
    Json(
        json!({ "name": "visarium", "version": app.config.version, "protocolVersion": PROTOCOL_VERSION }),
    )
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({ "status": "UP" }))
}

/// The built SPA, embedded in release builds and read from `web/dist` in debug
/// ones. Missing entirely in development, where Vite serves it instead.
#[derive(rust_embed::Embed)]
#[folder = "$CARGO_MANIFEST_DIR/../web/dist"]
#[allow_missing = true]
struct Web;

/// A file from the bundle, or `index.html` for a client-side route such as
/// `/boards/abc`. Paths that belong to the server 404 honestly rather than
/// answering HTML to something expecting JSON.
async fn spa(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    if ["health", "ws", "auth", "mcp", ".well-known"]
        .iter()
        .any(|p| path == *p || path.starts_with(&format!("{p}/")))
    {
        return ApiError::not_found("no such endpoint").into_response();
    }
    if let Some(file) = Web::get(path) {
        let mime = mime_guess::from_path(path).first_or_octet_stream();
        // Vite fingerprints everything under /assets, so those never change.
        let cache = if path.starts_with("assets/") {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        };
        return (
            [
                (header::CONTENT_TYPE, mime.as_ref()),
                (header::CACHE_CONTROL, cache),
            ],
            file.data,
        )
            .into_response();
    }
    let last = path.rsplit('/').next().unwrap_or("");
    match Web::get("index.html") {
        Some(index) if !last.contains('.') => {
            let mut page = (
                [
                    (header::CONTENT_TYPE, "text/html; charset=utf-8"),
                    (header::CACHE_CONTROL, "no-cache"),
                ],
                index.data,
            )
                .into_response();
            // Pages whose address carries a secret in its fragment: never
            // indexed, never sending the address onwards (ADR-0026).
            if matches!(path, "s" | "invite" | "device") {
                page.headers_mut().insert(
                    "referrer-policy",
                    header::HeaderValue::from_static("no-referrer"),
                );
                page.headers_mut()
                    .insert("x-robots-tag", header::HeaderValue::from_static("noindex"));
            }
            page
        }
        Some(_) => StatusCode::NOT_FOUND.into_response(),
        None => (
            StatusCode::NOT_FOUND,
            "this build has no web bundle; run `pnpm build` or use `pnpm dev`",
        )
            .into_response(),
    }
}

/// A tiny boxed-error alias, so `open` can use `?` across sqlx, migrate and io.
pub mod anyhow_lite {
    pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
}

pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}
