//! Who the caller is: accounts, sessions, passwords and CSRF.
//!
//! Session-cookie authentication for a same-origin SPA (ADR-0010, ADR-0025):
//! an opaque random token in an HttpOnly cookie. Only its SHA-256 is stored, in
//! `session`, so sessions survive a restart and a copy of the database signs
//! nobody in.
//!
//! Every request resolves to one `Principal`, once, in `session_layer`:
//!   * `Local`: single-user mode (the desktop's own library), no sign-in.
//!   * `Member`: a signed-in account.
//!   * `Viewer`: someone holding a read-only share link to one board
//!     (ADR-0026, `sharing.rs`).
//!   * `Agent`: an AI agent holding an agent token, on `/mcp` and nowhere
//!     else (ADR-0031, `agent/`). Cookies are never read there, so CSRF does
//!     not apply to it.
//!
//! What a route admits is decided by **where it is mounted**, never by a check
//! inside the handler: `require_user` (applied to `private_api` in
//! `lib.rs::router`) lets in `Local` and `Member` only, and `require_viewer`
//! guards `shared_api`, which holds read handlers and nothing else. A new
//! route is member-only unless it is mounted in `shared_api`, and nothing that
//! writes may be mounted there.
//!
//! CSRF is the double-submit cookie: a readable `XSRF-TOKEN` cookie the client
//! echoes in `X-XSRF-TOKEN` on every unsafe request
//! (packages/api-client/src/client.ts). Sign-in included: a forged sign-in
//! would put the victim in the attacker's account.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use axum::Router;
use axum::extract::{Path, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use axum_extra::extract::CookieJar;
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult, Json, is_unique_violation};
use crate::sharing::ShareLink;
use crate::{AppState, NOW, new_id};

const CSRF_COOKIE: &str = "XSRF-TOKEN";
const CSRF_HEADER: &str = "x-xsrf-token";
const REFUSED: &str = "that username and password do not match an account";
const USERNAME_RULE: &str =
    "a username may hold lower-case letters, digits, dot, underscore and hyphen";
const MIN_PASSWORD_CHARS: usize = 12;
/// Bounds the hashing work one request can ask for. argon2 has no 72-byte
/// cliff the way bcrypt did, so this is about cost, not correctness.
const MAX_PASSWORD_BYTES: usize = 1024;
const BCRYPT_COST: u32 = 10;

// --- cookies ----------------------------------------------------------------

/// A cookie that is `__Host-`-prefixed over https and keeps its old plain name
/// on http (loopback, a home network). `__Host-` requires `Secure`, and pins
/// the cookie to this exact host with `Path=/`: a sibling subdomain cannot set
/// or shadow it.
pub struct CookieName {
    pub plain: &'static str,
    pub secure: &'static str,
}

pub const SESSION: CookieName = CookieName {
    plain: "VISARIUM_SESSION",
    secure: "__Host-visarium_session",
};
pub const SHARE: CookieName = CookieName {
    plain: "VISARIUM_SHARE",
    secure: "__Host-visarium_share",
};
pub const FLOW: CookieName = CookieName {
    plain: "VISARIUM_FLOW",
    secure: "__Host-visarium_flow",
};

/// Kept for the desktop app, which hands a session to its webview by name.
pub const SESSION_COOKIE: &str = SESSION.plain;

impl CookieName {
    pub fn read(&self, jar: &CookieJar) -> Option<String> {
        jar.get(self.secure)
            .or_else(|| jar.get(self.plain))
            .map(|c| c.value().to_string())
            .filter(|v| !v.is_empty())
    }
    pub fn set(&self, value: &str, secure: bool, max_age: i64) -> HeaderValue {
        let name = if secure { self.secure } else { self.plain };
        HeaderValue::from_str(&format!(
            "{name}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{}",
            secure_attr(secure)
        ))
        .unwrap()
    }
    /// Clears both spellings: a cookie set before the instance moved behind
    /// https would otherwise linger under its plain name.
    pub fn clear(&self, secure: bool) -> [HeaderValue; 2] {
        let gone = |name: &str, secure: bool| {
            HeaderValue::from_str(&format!(
                "{name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{}",
                secure_attr(secure)
            ))
            .unwrap()
        };
        [gone(self.plain, false), gone(self.secure, secure)]
    }
}

pub fn is_secure(headers: &HeaderMap) -> bool {
    headers
        .get("x-forwarded-proto")
        .is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"https"))
}

fn secure_attr(secure: bool) -> &'static str {
    if secure { "; Secure" } else { "" }
}

// --- accounts ---------------------------------------------------------------

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub role: Role,
    /// `role == admin`, kept for clients that predate roles (older desktop
    /// builds read it). Drop a release after roles ship.
    pub admin: bool,
    pub deactivated_at: Option<String>,
    pub created_at: String,
}

/// An account's rank, lowest first: the derived order is the rank order.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, sqlx::Type,
)]
#[serde(rename_all = "lowercase")]
#[sqlx(rename_all = "lowercase")]
pub enum Role {
    Member,
    Moderator,
    Admin,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Member => "member",
            Role::Moderator => "moderator",
            Role::Admin => "admin",
        }
    }
}

const COLUMNS: &str =
    "id, username, display_name, role, role = 'admin' AS admin, deactivated_at, created_at";

pub async fn find_user(db: &SqlitePool, id: &str) -> sqlx::Result<Option<User>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {COLUMNS} FROM app_user WHERE id = ?"
    )))
    .bind(id)
    .fetch_optional(db)
    .await
}

pub async fn any_account(db: &SqlitePool) -> sqlx::Result<bool> {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM app_user)")
        .fetch_one(db)
        .await
}

/// The desktop app's implicit account: created once, admin, no password.
pub async fn ensure_local_user(db: &SqlitePool) -> sqlx::Result<String> {
    if let Some(id) = sqlx::query_scalar("SELECT id FROM app_user WHERE username = 'local'")
        .fetch_optional(db)
        .await?
    {
        return Ok(id);
    }
    let id = new_id();
    sqlx::query(
        "INSERT INTO app_user (id, username, display_name, role) VALUES (?, 'local', 'You', 'admin')",
    )
    .bind(&id)
    .execute(db)
    .await?;
    Ok(id)
}

/// Inserts an account. `password_hash` is null for one that signs in only
/// through a provider. Takes an executor so first-run and invitations can do
/// it inside their own transaction.
pub async fn insert_user<'e>(
    db: impl sqlx::SqliteExecutor<'e>,
    username: &str,
    display_name: &str,
    password_hash: Option<&str>,
    role: Role,
) -> ApiResult<User> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "INSERT INTO app_user (id, username, display_name, password_hash, role) VALUES (?, ?, ?, ?, ?) RETURNING {COLUMNS}"
    )))
    .bind(new_id())
    .bind(username)
    .bind(display_name.trim())
    .bind(password_hash)
    .bind(role)
    .fetch_one(db)
    .await
    .map_err(taken)
    .inspect(|user: &User| tracing::info!(user = %user.id, role = role.as_str(), "account created"))
}

// --- sessions ---------------------------------------------------------------

/// How long each kind of session lasts without being used. Use extends it.
/// Guesses, listed in OPEN_QUESTIONS.md.
pub const BROWSER_SESSION_IDLE_SECS: i64 = 30 * 86_400;
pub const DEVICE_SESSION_IDLE_SECS: i64 = 90 * 86_400;
pub const SHARE_SESSION_IDLE_SECS: i64 = 86_400;
/// An agent token lives until it is revoked: a hundred years is "never".
pub const AGENT_SESSION_IDLE_SECS: i64 = 100 * 365 * 86_400;
/// A session's `last_seen_at` is written at most this often, so reading a
/// page does not turn every request into a database write.
pub const SESSION_TOUCH_SECS: i64 = 300;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Browser,
    Device,
    Share,
    Agent,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Browser => "browser",
            Kind::Device => "device",
            Kind::Share => "share",
            Kind::Agent => "agent",
        }
    }
    fn parse(s: &str) -> Self {
        match s {
            "device" => Kind::Device,
            "share" => Kind::Share,
            "agent" => Kind::Agent,
            _ => Kind::Browser,
        }
    }
    pub fn idle_secs(self) -> i64 {
        match self {
            Kind::Browser => BROWSER_SESSION_IDLE_SECS,
            Kind::Device => DEVICE_SESSION_IDLE_SECS,
            Kind::Share => SHARE_SESSION_IDLE_SECS,
            Kind::Agent => AGENT_SESSION_IDLE_SECS,
        }
    }
}

pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

pub fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// `now + idle`, but never past `cap` (a share link's own expiry).
/// Binds: ?1 = "+N seconds", ?2 = cap or null.
const EXPIRY_SQL: &str = "CASE WHEN ?2 IS NOT NULL AND ?2 < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?1) \
     THEN ?2 ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?1) END";

fn idle_offset(kind: Kind) -> String {
    format!("+{} seconds", kind.idle_secs())
}

/// A session that resolved: what the caller holds, minus the token itself.
#[derive(Clone, Debug)]
pub struct Session {
    pub id: String,
    pub token_hash: String,
    pub kind: Kind,
}

/// Creates a session and returns its token, which exists from here on only in
/// the caller's cookie or keychain.
pub async fn create_session(
    db: &SqlitePool,
    kind: Kind,
    user_id: Option<&str>,
    share_id: Option<&str>,
    cap: Option<&str>,
    label: Option<&str>,
) -> sqlx::Result<String> {
    let token = random_token();
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "INSERT INTO session (token_hash, id, kind, user_id, share_id, label, expires_at) \
         VALUES (?3, ?4, ?5, ?6, ?7, ?8, {EXPIRY_SQL})"
    )))
    .bind(idle_offset(kind))
    .bind(cap)
    .bind(hash_token(&token))
    .bind(new_id())
    .bind(kind.as_str())
    .bind(user_id)
    .bind(share_id)
    .bind(label.map(|l| l.chars().take(120).collect::<String>()))
    .execute(db)
    .await?;
    Ok(token)
}

#[derive(sqlx::FromRow)]
struct SessionRow {
    id: String,
    token_hash: String,
    kind: String,
    user_id: Option<String>,
    share_id: Option<String>,
    stale: bool,
}

/// Looks a token up, and renews it when it was last renewed more than
/// `SESSION_TOUCH_SECS` ago. Returns whether it was renewed, so the cookie's
/// own Max-Age can be renewed with it.
async fn lookup(db: &SqlitePool, token: &str) -> sqlx::Result<Option<(SessionRow, bool)>> {
    let row: Option<SessionRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT id, token_hash, kind, user_id, share_id, \
                last_seen_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-{SESSION_TOUCH_SECS} seconds') AS stale \
         FROM session WHERE token_hash = ? AND expires_at > {NOW}"
    )))
    .bind(hash_token(token))
    .fetch_optional(db)
    .await?;
    let Some(row) = row else { return Ok(None) };
    let touched = row.stale;
    if touched {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "UPDATE session SET last_seen_at = {NOW}, expires_at = {} WHERE token_hash = ?2",
            EXPIRY_SQL.replace(
                "?2",
                "(SELECT expires_at FROM share_link WHERE id = session.share_id)"
            )
        )))
        .bind(idle_offset(Kind::parse(&row.kind)))
        .bind(&row.token_hash)
        .execute(db)
        .await?;
    }
    Ok(Some((row, touched)))
}

pub async fn end_session(db: &SqlitePool, token_hash: &str) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM session WHERE token_hash = ?")
        .bind(token_hash)
        .execute(db)
        .await
        .map(|_| ())
}

/// Ends every session of one account except `keep` (a token hash): on
/// password change (keep the caller's), deactivation and reset (keep none).
pub async fn end_sessions_of(
    db: &SqlitePool,
    user_id: &str,
    keep: Option<&str>,
) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM session WHERE user_id = ? AND token_hash IS NOT ?")
        .bind(user_id)
        .bind(keep)
        .execute(db)
        .await
        .map(|_| ())
}

/// Deletes expired sessions, and invitations a month past their expiry (kept
/// that long so a late click is told "expired" rather than "not valid").
pub async fn sweep(db: &SqlitePool) -> sqlx::Result<()> {
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "DELETE FROM session WHERE expires_at <= {NOW}"
    )))
    .execute(db)
    .await?;
    sqlx::query("DELETE FROM invitation WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')")
        .execute(db)
        .await?;
    Ok(())
}

/// "Safari on macOS": enough to recognise a session in the list, and no more
/// of the user agent than that.
pub fn browser_label(headers: &HeaderMap) -> String {
    let ua = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let browser = [
        ("Edg/", "Edge"),
        ("Firefox/", "Firefox"),
        ("Chrome/", "Chrome"),
        ("Safari/", "Safari"),
    ]
    .iter()
    .find(|(needle, _)| ua.contains(needle))
    .map_or("A browser", |(_, name)| name);
    let os = [
        ("iPhone", "iOS"),
        ("iPad", "iPadOS"),
        ("Android", "Android"),
        ("Mac OS X", "macOS"),
        ("Windows", "Windows"),
        ("Linux", "Linux"),
    ]
    .iter()
    .find(|(needle, _)| ua.contains(needle))
    .map(|(_, name)| format!(" on {name}"))
    .unwrap_or_default();
    format!("{browser}{os}")
}

/// Failed attempts per key, and the pause they earn: free for five, then half
/// a second more per failure up to five seconds. Keyed per username for
/// passwords and per link for share passphrases, rather than per address,
/// because behind a proxy every address is the proxy's.
///
/// Keys are whatever a caller types, so the table is capped: when full, it
/// drops entries idle for a minute, then the oldest.
#[derive(Default)]
pub struct LoginThrottle(Mutex<HashMap<String, (u32, std::time::Instant)>>);

impl LoginThrottle {
    const FREE_ATTEMPTS: u32 = 5;
    pub const MAX_KEYS: usize = 10_000;
    const IDLE: Duration = Duration::from_secs(60);

    pub fn delay(&self, key: &str) -> Duration {
        let count = self.0.lock().unwrap().get(key).map_or(0, |e| e.0);
        let over = count.saturating_sub(Self::FREE_ATTEMPTS) as u64;
        Duration::from_millis((over * 500).min(5_000))
    }
    /// ponytail: at the cap, an O(n) pass; fine at 10 000 keys.
    pub fn failed(&self, key: &str) {
        let mut map = self.0.lock().unwrap();
        if !map.contains_key(key) && map.len() >= Self::MAX_KEYS {
            map.retain(|_, (_, at)| at.elapsed() < Self::IDLE);
            if map.len() >= Self::MAX_KEYS
                && let Some(oldest) = map.iter().min_by_key(|(_, e)| e.1).map(|(k, _)| k.clone())
            {
                map.remove(&oldest);
            }
        }
        let entry = map
            .entry(key.into())
            .or_insert((0, std::time::Instant::now()));
        entry.0 += 1;
        entry.1 = std::time::Instant::now();
    }
    pub fn succeeded(&self, key: &str) {
        self.0.lock().unwrap().remove(key);
    }
}

// --- who is calling ---------------------------------------------------------

#[derive(Clone)]
pub enum Principal {
    Anonymous,
    Local(User),
    Member {
        user: User,
        session: Session,
    },
    Viewer {
        link: ShareLink,
        session: Session,
    },
    /// On `/mcp` only. Deliberately not a `user()`: nothing mounted under
    /// `require_user` can be reached with an agent token.
    Agent {
        user: User,
        session: Session,
        label: String,
    },
}

impl Principal {
    pub fn user(&self) -> Option<&User> {
        match self {
            Principal::Local(user) | Principal::Member { user, .. } => Some(user),
            _ => None,
        }
    }
    /// The session the request arrived with, member or viewer.
    pub fn session_hash(&self) -> Option<&str> {
        match self {
            Principal::Member { session, .. }
            | Principal::Viewer { session, .. }
            | Principal::Agent { session, .. } => Some(&session.token_hash),
            _ => None,
        }
    }
}

fn is_loopback_host(headers: &HeaderMap) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|h| h.to_str().ok()) else {
        return false;
    };
    let name = host.rsplit_once(':').map_or(
        host,
        |(name, port)| if port.ends_with(']') { host } else { name },
    );
    matches!(name, "127.0.0.1" | "localhost" | "[::1]")
}

/// Resolves the caller once per request. A renewed session gets its cookie
/// renewed too, so an active session's cookie never runs out before it does.
pub async fn session_layer(
    State(app): State<AppState>,
    jar: CookieJar,
    mut req: Request,
    next: Next,
) -> Response {
    if let Some(local) = &app.local_user {
        // Single-user mode has no password between a request and the library,
        // so a page that resolves some hostname to 127.0.0.1 (DNS rebinding)
        // must not be able to reach it. Loopback names only.
        // A demo sandbox is the exception: its gateway checked who is asking.
        if app.config.demo.is_none() && !is_loopback_host(req.headers()) {
            return ApiError::forbidden("this instance only answers on localhost").into_response();
        }
        let principal = match find_user(&app.db, local).await.ok().flatten() {
            Some(user) => Principal::Local(user),
            None => Principal::Anonymous,
        };
        req.extensions_mut().insert(principal);
        return next.run(req).await;
    }

    if req.uri().path() == MCP_PATH {
        let principal = agent_principal(&app.db, req.headers()).await;
        req.extensions_mut().insert(principal);
        return next.run(req).await;
    }

    let secure = is_secure(req.headers());
    let mut renew: Option<HeaderValue> = None;
    let mut principal = Principal::Anonymous;
    // Only browser and device sessions sign in by cookie: an agent token is a
    // bearer credential for `/mcp` alone, whatever cookie it arrives in.
    if let Some(token) = SESSION.read(&jar)
        && let Ok(Some((row, touched))) = lookup(&app.db, &token).await
        && matches!(Kind::parse(&row.kind), Kind::Browser | Kind::Device)
        && let Some(user_id) = &row.user_id
        && let Ok(Some(user)) = find_user(&app.db, user_id).await
        && user.deactivated_at.is_none()
    {
        let kind = Kind::parse(&row.kind);
        if touched && kind == Kind::Browser {
            renew = Some(SESSION.set(&token, secure, kind.idle_secs()));
        }
        principal = Principal::Member {
            user,
            session: Session {
                id: row.id,
                token_hash: row.token_hash,
                kind,
            },
        };
    } else if let Some(token) = SHARE.read(&jar)
        && let Ok(Some((row, touched))) = lookup(&app.db, &token).await
        && let Some(share_id) = &row.share_id
        && let Ok(Some(link)) = crate::sharing::active_link(&app.db, share_id).await
    {
        if touched {
            renew = Some(SHARE.set(&token, secure, SHARE_SESSION_IDLE_SECS));
        }
        principal = Principal::Viewer {
            link,
            session: Session {
                id: row.id,
                token_hash: row.token_hash,
                kind: Kind::Share,
            },
        };
    }
    req.extensions_mut().insert(principal);
    let mut response = next.run(req).await;
    // A handler that set its own session cookie (sign-in, sign-out) wins.
    let own = |c: &HeaderValue| {
        [SESSION.plain, SESSION.secure, SHARE.plain, SHARE.secure]
            .iter()
            .any(|n| c.as_bytes().starts_with(n.as_bytes()))
    };
    if let Some(cookie) = renew
        && !response
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .any(own)
    {
        response.headers_mut().append(header::SET_COOKIE, cookie);
    }
    response
}

/// The agent endpoint. It authenticates by bearer token alone.
pub const MCP_PATH: &str = "/mcp";

/// `Authorization: Bearer <agent token>` → the agent and its person, or
/// Anonymous. Only a live session of kind `agent`, of an active account, counts.
async fn agent_principal(db: &SqlitePool, headers: &HeaderMap) -> Principal {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.strip_prefix("Bearer ")
                .or_else(|| v.strip_prefix("bearer "))
        })
        .map(str::trim)
        .filter(|t| !t.is_empty());
    let Some(token) = token else {
        return Principal::Anonymous;
    };
    // A minted agent token is the session's own secret. An OAuth access token
    // is a short-lived pointer at the agent session its client signed in as.
    let row: Option<(String, String, String, Option<String>)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT id, token_hash, user_id, label FROM session WHERE token_hash = ?1 AND kind = 'agent' AND expires_at > {NOW}
         UNION ALL
         SELECT s.id, s.token_hash, s.user_id, s.label FROM oauth_token t JOIN session s ON s.id = t.session_id
          WHERE t.token_hash = ?1 AND t.kind = 'access' AND t.expires_at > {NOW} AND s.kind = 'agent' AND s.expires_at > {NOW}
         LIMIT 1"
    )))
    .bind(hash_token(token))
    .fetch_optional(db)
    .await
    .ok()
    .flatten();
    let Some((id, token_hash, user_id, label)) = row else {
        return Principal::Anonymous;
    };
    let Ok(Some(user)) = find_user(db, &user_id).await else {
        return Principal::Anonymous;
    };
    if user.deactivated_at.is_some() {
        return Principal::Anonymous;
    }
    // "Last used" is what the Agents list shows, so the first use is written
    // at once, and later ones at most every SESSION_TOUCH_SECS.
    if let Err(e) = sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE session SET last_seen_at = {NOW} WHERE token_hash = ?
            AND (last_seen_at = created_at OR last_seen_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-{SESSION_TOUCH_SECS} seconds'))"
    )))
    .bind(&token_hash)
    .execute(db)
    .await
    {
        // The request goes ahead; only the Agents list's "last used" lags.
        tracing::warn!(session = %id, error = %e, "could not record an agent token's last use");
    }
    let label = label.unwrap_or_else(|| agent_of(&user.display_name));
    Principal::Agent {
        user,
        session: Session {
            id,
            token_hash,
            kind: Kind::Agent,
        },
        label,
    }
}

/// An unnamed agent goes by its person's first name: "Rokas' Agent", "Ana's Agent".
pub fn agent_of(person: &str) -> String {
    let first = person.split_whitespace().next().unwrap_or("");
    match first {
        "" => "Agent".into(),
        f if f.ends_with(['s', 'S']) => format!("{f}' Agent"),
        f => format!("{f}'s Agent"),
    }
}

#[test]
fn agent_names_its_person() {
    assert_eq!(agent_of("Rokas Kučinskas"), "Rokas' Agent");
    assert_eq!(agent_of("Ana"), "Ana's Agent");
    assert_eq!(agent_of("  "), "Agent");
}

pub async fn require_user(mut req: Request, next: Next) -> Response {
    let user = req
        .extensions()
        .get::<Principal>()
        .and_then(|p| p.user().cloned());
    match user {
        Some(user) => {
            req.extensions_mut().insert(user);
            next.run(req).await
        }
        None => ApiError::unauthorized("this request needs an account; sign in and try again")
            .into_response(),
    }
}

pub async fn require_viewer(mut req: Request, next: Next) -> Response {
    let link = match req.extensions().get::<Principal>() {
        Some(Principal::Viewer { link, .. }) => link.clone(),
        _ => {
            return ApiError::unauthorized(
                "this link is no longer active; ask whoever shared it for a new one",
            )
            .titled("Link not active")
            .into_response();
        }
    };
    req.extensions_mut().insert(link);
    next.run(req).await
}

/// Double-submit CSRF. Issues the cookie on any response that lacks it, and
/// refuses an unsafe request whose header does not echo it.
pub async fn csrf_layer(jar: CookieJar, req: Request, next: Next) -> Response {
    let cookie = jar.get(CSRF_COOKIE).map(|c| c.value().to_string());
    let safe = matches!(
        *req.method(),
        Method::GET | Method::HEAD | Method::OPTIONS | Method::TRACE
    );
    // `/mcp` reads no cookie, so there is no ambient credential to forge a
    // request with; it checks Origin and content type itself (agent::mcp).
    // Neither do the OAuth token and registration endpoints: their callers
    // are apps, authenticated by PKCE verifier or not at all.
    let cookieless = matches!(
        req.uri().path(),
        MCP_PATH | "/oauth/token" | "/oauth/register"
    );
    if !safe && !cookieless {
        let header = req.headers().get(CSRF_HEADER).and_then(|v| v.to_str().ok());
        let ok = matches!((&cookie, header), (Some(c), Some(h)) if !c.is_empty() && c == h);
        if !ok {
            return ApiError::forbidden("missing or mismatched CSRF token; reload and try again")
                .titled("Forbidden")
                .into_response();
        }
    }
    let secure = is_secure(req.headers());
    let mut response = next.run(req).await;
    if cookie.is_none() {
        let value = format!(
            "{CSRF_COOKIE}={}; Path=/; SameSite=Lax{}",
            random_token(),
            secure_attr(secure)
        );
        response
            .headers_mut()
            .append(header::SET_COOKIE, HeaderValue::from_str(&value).unwrap());
    }
    response
}

// --- passwords --------------------------------------------------------------

pub fn require_valid_password(password: &str) -> ApiResult<()> {
    if password.chars().count() < MIN_PASSWORD_CHARS {
        return Err(ApiError::bad_request(format!(
            "a password must be at least {MIN_PASSWORD_CHARS} characters"
        )));
    }
    if password.len() > MAX_PASSWORD_BYTES {
        return Err(ApiError::bad_request(format!(
            "a password must be at most {MAX_PASSWORD_BYTES} bytes"
        )));
    }
    Ok(())
}

/// How many password hashes or checks run at once, instance-wide. Each one
/// holds about 19 MiB, so an anonymous burst of sign-ins, setups or
/// redemptions waits its turn instead of growing memory.
pub fn password_permits() -> &'static tokio::sync::Semaphore {
    static PERMITS: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    PERMITS.get_or_init(|| tokio::sync::Semaphore::new(password_concurrency()))
}

fn password_concurrency() -> usize {
    std::thread::available_parallelism()
        .map_or(2, |n| n.get())
        .clamp(1, 4)
}

fn argon2() -> argon2::Argon2<'static> {
    // The crate's default is argon2id v19, m = 19 MiB, t = 2, p = 1: the
    // OWASP minimum.
    argon2::Argon2::default()
}

/// argon2id, stored as `{argon2id}$argon2id$v=19$…`. The prefix is what lets
/// the algorithm change again later without a reset.
pub async fn hash_password(password: String) -> ApiResult<String> {
    use argon2::password_hash::PasswordHasher;
    let _permit = password_permits()
        .acquire()
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    tokio::task::spawn_blocking(move || {
        argon2()
            .hash_password(password.as_bytes())
            .map(|h| format!("{{argon2id}}{h}"))
    })
    .await
    .map_err(|e| ApiError::internal(e.to_string()))?
    .map_err(|e| ApiError::internal(e.to_string()))
}

#[derive(Debug, PartialEq)]
pub enum Verified {
    No,
    Yes,
    /// Right, but stored in an algorithm we are moving away from.
    YesRehash,
}

/// Checks a password against a stored `{argon2id}` or `{bcrypt}` hash. With
/// none, checks against a dummy so "no such account" costs the same time as
/// "wrong password".
pub async fn verify_password(password: String, stored: Option<String>) -> Verified {
    use argon2::password_hash::{PasswordVerifier, phc::PasswordHash};
    static DUMMY: OnceLock<String> = OnceLock::new();
    // Never closed, so acquiring cannot fail.
    let Ok(_permit) = password_permits().acquire().await else {
        return Verified::No;
    };
    tokio::task::spawn_blocking(move || {
        let stored = stored.unwrap_or_default();
        if let Some(phc) = stored.strip_prefix("{argon2id}") {
            let ok = PasswordHash::new(phc)
                .is_ok_and(|h| argon2().verify_password(password.as_bytes(), &h).is_ok());
            return if ok { Verified::Yes } else { Verified::No };
        }
        if let Some(hash) = stored.strip_prefix("{bcrypt}") {
            return if bcrypt::verify(&password, hash).unwrap_or(false) {
                Verified::YesRehash
            } else {
                Verified::No
            };
        }
        let dummy = DUMMY.get_or_init(|| {
            use argon2::password_hash::PasswordHasher;
            argon2()
                .hash_password(b"not-a-password")
                .unwrap()
                .to_string()
        });
        // Only the time it takes matters: an unknown name costs as much as a
        // wrong password, so timing does not tell which accounts exist.
        let _ = argon2().verify_password(password.as_bytes(), &PasswordHash::new(dummy).unwrap());
        Verified::No
    })
    .await
    .unwrap_or(Verified::No)
}

/// For tests and imports that still produce bcrypt.
pub fn bcrypt_hash_for_tests(password: &str) -> String {
    format!("{{bcrypt}}{}", bcrypt::hash(password, BCRYPT_COST).unwrap())
}

// --- validation -------------------------------------------------------------

pub fn require_username(username: &str) -> ApiResult<()> {
    let ok_chars = username
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b));
    if !(2..=64).contains(&username.len()) || !ok_chars {
        return Err(ApiError::bad_request(USERNAME_RULE));
    }
    Ok(())
}

pub fn require_display_name(name: &str) -> ApiResult<()> {
    if name.trim().is_empty() || name.chars().count() > 64 {
        return Err(ApiError::bad_request(
            "a display name must be 1–64 characters",
        ));
    }
    Ok(())
}

fn taken(e: sqlx::Error) -> ApiError {
    if is_unique_violation(&e) {
        ApiError::conflict("an account with this username already exists")
            .titled("That username is taken")
    } else {
        e.into()
    }
}

// --- session and setup ------------------------------------------------------

pub async fn current(
    State(app): State<AppState>,
    axum::Extension(principal): axum::Extension<Principal>,
) -> ApiResult<axum::Json<serde_json::Value>> {
    let user = principal.user();
    let setup_required = user.is_none() && !any_account(&app.db).await?;
    let multi = app.local_user.is_none();
    let providers: Vec<_> = crate::oidc::active(&app)
        .iter()
        .map(|p| json!({ "id": p.id, "name": p.name }))
        .collect();
    // `singleUser`: there is no sign-in to return to, so the SPA hides Sign out.
    let mut body = json!({
        "setupRequired": setup_required,
        "user": user,
        "singleUser": !multi,
        "passwordEnabled": multi && !app.config.password_disabled,
        "providers": providers,
        "sharingEnabled": multi && !app.config.sharing_disabled,
    });
    // Present only on a demo sandbox: when it ends, and what it holds.
    if let Some(demo) = &app.config.demo {
        body["demo"] = demo.view();
    }
    Ok(axum::Json(body))
}

#[derive(Deserialize)]
pub struct DeviceRequest {
    label: Option<String>,
}

#[derive(Deserialize)]
pub struct Credentials {
    username: String,
    password: String,
    /// The desktop app asks for a long-lived device session (ADR-0027).
    device: Option<DeviceRequest>,
}

pub fn require_password_sign_in(app: &AppState) -> ApiResult<()> {
    if app.config.password_disabled {
        return Err(ApiError::not_found(
            "password sign-in is turned off on this instance; use a sign-in provider",
        ));
    }
    Ok(())
}

pub async fn sign_in(
    State(app): State<AppState>,
    headers: HeaderMap,
    axum::Extension(principal): axum::Extension<Principal>,
    Json(body): Json<Credentials>,
) -> ApiResult<Response> {
    require_password_sign_in(&app)?;
    if body.username.trim().is_empty()
        || body.password.is_empty()
        || body.username.len() > 200
        || body.password.len() > MAX_PASSWORD_BYTES
    {
        return Err(ApiError::bad_request("username and password are required"));
    }
    tokio::time::sleep(app.throttle.delay(&body.username)).await;
    let row: Option<(String, Option<String>, Option<String>)> =
        sqlx::query_as("SELECT id, password_hash, deactivated_at FROM app_user WHERE username = ?")
            .bind(&body.username)
            .fetch_optional(&app.db)
            .await?;
    let (id, hash, deactivated) = match row {
        Some((id, hash, deactivated)) => (Some(id), hash, deactivated),
        None => (None, None, None),
    };
    let verified = verify_password(body.password.clone(), hash).await;
    let Some(id) = id.filter(|_| verified != Verified::No && deactivated.is_none()) else {
        // Never the username: it may be a mistyped password or an address.
        let reason = if deactivated.is_some() && verified != Verified::No {
            "deactivated"
        } else {
            "bad credentials"
        };
        tracing::warn!(method = "password", reason, "sign-in refused");
        app.throttle.failed(&body.username);
        return Err(ApiError::unauthorized(REFUSED));
    };
    app.throttle.succeeded(&body.username);
    tracing::info!(user = %id, method = "password", "signed in");
    if verified == Verified::YesRehash {
        let upgraded = hash_password(body.password).await?;
        sqlx::query("UPDATE app_user SET password_hash = ? WHERE id = ?")
            .bind(upgraded)
            .bind(&id)
            .execute(&app.db)
            .await?;
    }
    let (kind, label) = match body.device {
        Some(d) => (
            Kind::Device,
            d.label.unwrap_or_else(|| "Visarium Desktop".into()),
        ),
        None => (Kind::Browser, browser_label(&headers)),
    };
    establish(
        &app,
        &headers,
        principal.session_hash(),
        &id,
        kind,
        &label,
        StatusCode::OK,
    )
    .await
}

/// A new token on every sign-in (no session fixation), replacing whatever
/// session the request arrived with.
pub async fn establish(
    app: &AppState,
    headers: &HeaderMap,
    previous: Option<&str>,
    user_id: &str,
    kind: Kind,
    label: &str,
    status: StatusCode,
) -> ApiResult<Response> {
    let token = start_session(app, previous, user_id, kind, label).await?;
    let user = find_user(&app.db, user_id)
        .await?
        .ok_or_else(|| ApiError::internal("account vanished"))?;
    let mut response = (status, axum::Json(user)).into_response();
    response.headers_mut().append(
        header::SET_COOKIE,
        SESSION.set(&token, is_secure(headers), kind.idle_secs()),
    );
    Ok(response)
}

/// The part of `establish` a redirecting flow (OIDC) needs: the token, to put
/// in a cookie on a 302 rather than a JSON body.
pub async fn start_session(
    app: &AppState,
    previous: Option<&str>,
    user_id: &str,
    kind: Kind,
    label: &str,
) -> ApiResult<String> {
    if let Some(old) = previous {
        end_session(&app.db, old).await?;
    }
    Ok(create_session(&app.db, kind, Some(user_id), None, None, Some(label)).await?)
}

pub async fn sign_out(
    State(app): State<AppState>,
    headers: HeaderMap,
    axum::Extension(principal): axum::Extension<Principal>,
) -> ApiResult<Response> {
    if let Principal::Member { user, session } = &principal {
        end_session(&app.db, &session.token_hash).await?;
        tracing::info!(user = %user.id, "signed out");
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    for cookie in SESSION.clear(is_secure(&headers)) {
        response.headers_mut().append(header::SET_COOKIE, cookie);
    }
    Ok(response)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FirstAdmin {
    username: String,
    display_name: String,
    password: String,
}

/// Claims a fresh instance with a password: the first account, an admin,
/// signed in. 409 forever after. (`oidc.rs` claims through a provider.)
pub async fn claim(
    State(app): State<AppState>,
    headers: HeaderMap,
    axum::Extension(principal): axum::Extension<Principal>,
    Json(body): Json<FirstAdmin>,
) -> ApiResult<Response> {
    require_password_sign_in(&app)?;
    require_username(&body.username)?;
    require_display_name(&body.display_name)?;
    require_valid_password(&body.password)?;
    // Refused before hashing: anyone can post here, and a claimed instance is
    // the usual case. The transaction below still decides a race.
    if any_account(&app.db).await? {
        return Err(ApiError::conflict("this instance already has an account"));
    }
    let hash = hash_password(body.password).await?;
    let _guard = app.setup_lock.lock().await;
    let mut tx = app.db.begin().await?;
    let user = claim_in(&mut tx, &body.username, &body.display_name, Some(&hash)).await?;
    tx.commit().await?;
    tracing::info!(user = %user.id, method = "password", "instance claimed");
    establish(
        &app,
        &headers,
        principal.session_hash(),
        &user.id,
        Kind::Browser,
        &browser_label(&headers),
        StatusCode::CREATED,
    )
    .await
}

/// The first admin, inside the caller's transaction and under `setup_lock`.
/// Adopts any ownerless rows (an import from before accounts).
pub async fn claim_in(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    username: &str,
    display_name: &str,
    password_hash: Option<&str>,
) -> ApiResult<User> {
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM app_user)")
        .fetch_one(&mut **tx)
        .await?;
    if exists {
        return Err(ApiError::conflict("this instance already has an account"));
    }
    let user = insert_user(
        &mut **tx,
        username,
        display_name,
        password_hash,
        Role::Admin,
    )
    .await?;
    for sql in [
        "UPDATE canvas SET owner_id = ? WHERE owner_id IS NULL",
        "UPDATE collection SET owner_id = ? WHERE owner_id IS NULL",
        "UPDATE asset SET uploaded_by = ? WHERE uploaded_by IS NULL",
    ] {
        sqlx::query(sql).bind(&user.id).execute(&mut **tx).await?;
    }
    Ok(user)
}

// --- accounts ---------------------------------------------------------------

pub fn account_routes() -> Router<AppState> {
    Router::new()
        .route("/accounts", get(list_accounts))
        .route("/accounts/me", patch(edit_self))
        .route("/accounts/me/password", put(change_password))
        .route("/accounts/{id}/role", put(set_role))
        .route(
            "/accounts/{id}/deactivation",
            post(deactivate).delete(reactivate),
        )
        .route("/sessions", get(list_sessions).delete(end_other_sessions))
        .route("/sessions/{id}", delete(end_one_session))
}

pub fn require_admin(user: &User) -> ApiResult<()> {
    require_role(user, Role::Admin)
}

/// At least `role`: `require_role(me, Moderator)` admits moderators and admins.
pub fn require_role(user: &User, role: Role) -> ApiResult<()> {
    if user.role >= role {
        Ok(())
    } else {
        Err(ApiError::forbidden("this account may not do that").titled("Not allowed"))
    }
}

/// Whether `me` may act on an account of rank `target`: an admin on anyone,
/// a moderator only on members. Moderators never act on each other.
pub fn may_act_on(me: Role, target: Role) -> bool {
    me == Role::Admin || (me == Role::Moderator && target == Role::Member)
}

/// `require_role(Moderator)` plus `may_act_on` the target account.
pub fn require_staff_over(me: &User, target: Role) -> ApiResult<()> {
    require_role(me, Role::Moderator)?;
    if may_act_on(me.role, target) {
        Ok(())
    } else {
        Err(ApiError::forbidden(format!(
            "a {} cannot do that to a {}'s account; ask an admin",
            me.role.as_str(),
            target.as_str()
        ))
        .titled("Not allowed"))
    }
}

fn gone(id: impl std::fmt::Display) -> ApiError {
    ApiError::not_found(format!("no account {id}"))
}

async fn list_accounts(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
) -> ApiResult<axum::Json<Vec<User>>> {
    require_role(&me, Role::Moderator)?;
    Ok(axum::Json(
        sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT {COLUMNS} FROM app_user ORDER BY created_at"
        )))
        .fetch_all(&app.db)
        .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SelfEdit {
    display_name: Option<String>,
    username: Option<String>,
}

async fn edit_self(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
    Json(body): Json<SelfEdit>,
) -> ApiResult<axum::Json<User>> {
    if let Some(name) = body
        .display_name
        .as_deref()
        .filter(|n| !n.trim().is_empty())
    {
        require_display_name(name)?;
        sqlx::query("UPDATE app_user SET display_name = ? WHERE id = ?")
            .bind(name.trim())
            .bind(&me.id)
            .execute(&app.db)
            .await?;
    }
    if let Some(username) = body.username.as_deref().filter(|u| *u != me.username) {
        // ensure_local_user finds the desktop's one account by the name `local`;
        // renamed, the next launch would make a fresh, empty one.
        if app.local_user.is_some() {
            return Err(ApiError::bad_request(
                "the local account's username cannot change",
            ));
        }
        require_username(username)?;
        sqlx::query("UPDATE app_user SET username = ? WHERE id = ?")
            .bind(username)
            .bind(&me.id)
            .execute(&app.db)
            .await
            .map_err(taken)?;
    }
    Ok(axum::Json(
        find_user(&app.db, &me.id)
            .await?
            .ok_or_else(|| gone(&me.id))?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PasswordChange {
    #[serde(default)]
    current_password: String,
    new_password: String,
}

/// Changes a password, or sets the first one on an account that so far signs
/// in only through a provider (there is no current password to ask for).
async fn change_password(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
    axum::Extension(principal): axum::Extension<Principal>,
    Json(body): Json<PasswordChange>,
) -> ApiResult<StatusCode> {
    require_password_sign_in(&app)?;
    let stored: Option<String> =
        sqlx::query_scalar("SELECT password_hash FROM app_user WHERE id = ?")
            .bind(&me.id)
            .fetch_one(&app.db)
            .await?;
    if stored.is_some() && verify_password(body.current_password, stored).await == Verified::No {
        return Err(ApiError::forbidden("that is not your current password"));
    }
    require_valid_password(&body.new_password)?;
    let hash = hash_password(body.new_password).await?;
    sqlx::query("UPDATE app_user SET password_hash = ? WHERE id = ?")
        .bind(hash)
        .bind(&me.id)
        .execute(&app.db)
        .await?;
    end_sessions_of(&app.db, &me.id, principal.session_hash()).await?;
    tracing::info!(user = %me.id, "password changed; other sessions ended");
    Ok(StatusCode::NO_CONTENT)
}

/// The last active admin can be neither demoted nor deactivated: the instance
/// would be left with nobody who can invite anyone.
async fn require_another_admin_besides(db: &SqlitePool, target: &User) -> ApiResult<()> {
    if target.role != Role::Admin || target.deactivated_at.is_some() {
        return Ok(());
    }
    let admins: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM app_user WHERE role = 'admin' AND deactivated_at IS NULL",
    )
    .fetch_one(db)
    .await?;
    if admins > 1 {
        return Ok(());
    }
    Err(ApiError::conflict(
        "this is the only admin left; promote somebody else first, or this instance would have nobody who can invite anyone",
    ))
}

#[derive(Deserialize)]
struct RoleChange {
    role: Role,
}

/// Admins only. Takes effect on the account's next request: `User` is read
/// fresh from the database for each one, so nobody is signed out.
async fn set_role(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
    Path(id): Path<Uuid>,
    Json(body): Json<RoleChange>,
) -> ApiResult<axum::Json<User>> {
    require_admin(&me)?;
    let id = id.to_string();
    let target = find_user(&app.db, &id).await?.ok_or_else(|| gone(&id))?;
    if body.role != Role::Admin {
        require_another_admin_besides(&app.db, &target).await?;
    }
    sqlx::query("UPDATE app_user SET role = ? WHERE id = ?")
        .bind(body.role)
        .bind(&id)
        .execute(&app.db)
        .await?;
    // A reset link was issued against the old rank; it does not carry over.
    sqlx::query(
        "DELETE FROM invitation WHERE purpose = 'reset' AND user_id = ? AND used_at IS NULL",
    )
    .bind(&id)
    .execute(&app.db)
    .await?;
    tracing::info!(user = %id, role = body.role.as_str(), from = target.role.as_str(), by = %me.id, "role changed");
    Ok(axum::Json(
        find_user(&app.db, &id).await?.ok_or_else(|| gone(&id))?,
    ))
}

async fn deactivate(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
    Path(id): Path<Uuid>,
) -> ApiResult<axum::Json<User>> {
    let id = id.to_string();
    let target = find_user(&app.db, &id).await?.ok_or_else(|| gone(&id))?;
    require_staff_over(&me, target.role)?;
    require_another_admin_besides(&app.db, &target).await?;
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE app_user SET deactivated_at = coalesce(deactivated_at, {NOW}) WHERE id = ?"
    )))
    .bind(&id)
    .execute(&app.db)
    .await?;
    end_sessions_of(&app.db, &id, None).await?;
    tracing::info!(user = %id, by = %me.id, "account deactivated");
    Ok(axum::Json(
        find_user(&app.db, &id).await?.ok_or_else(|| gone(&id))?,
    ))
}

/// Undoes a deactivation. Sessions and agent tokens it ended stay ended.
async fn reactivate(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
    Path(id): Path<Uuid>,
) -> ApiResult<axum::Json<User>> {
    let id = id.to_string();
    let target = find_user(&app.db, &id).await?.ok_or_else(|| gone(&id))?;
    require_staff_over(&me, target.role)?;
    sqlx::query("UPDATE app_user SET deactivated_at = NULL WHERE id = ?")
        .bind(&id)
        .execute(&app.db)
        .await?;
    tracing::info!(user = %id, by = %me.id, "account reactivated");
    Ok(axum::Json(
        find_user(&app.db, &id).await?.ok_or_else(|| gone(&id))?,
    ))
}

// --- my sessions ------------------------------------------------------------

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct SessionView {
    id: String,
    kind: String,
    label: Option<String>,
    created_at: String,
    last_seen_at: String,
    expires_at: String,
    current: bool,
}

async fn list_sessions(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
    axum::Extension(principal): axum::Extension<Principal>,
) -> ApiResult<axum::Json<Vec<SessionView>>> {
    Ok(axum::Json(
        sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT id, kind, label, created_at, last_seen_at, expires_at, token_hash IS ? AS current \
             FROM session WHERE user_id = ? AND kind <> 'agent' AND expires_at > {NOW} ORDER BY last_seen_at DESC"
        )))
        .bind(principal.session_hash())
        .bind(&me.id)
        .fetch_all(&app.db)
        .await?,
    ))
}

async fn end_one_session(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let done = sqlx::query("DELETE FROM session WHERE id = ? AND user_id = ? AND kind <> 'agent'")
        .bind(id.to_string())
        .bind(&me.id)
        .execute(&app.db)
        .await?;
    if done.rows_affected() == 0 {
        return Err(ApiError::not_found(format!("no session {id}")));
    }
    tracing::info!(user = %me.id, session = %id, "session revoked");
    Ok(StatusCode::NO_CONTENT)
}

/// "Sign out other sessions": every session of mine except this one.
async fn end_other_sessions(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
    axum::Extension(principal): axum::Extension<Principal>,
) -> ApiResult<StatusCode> {
    // Agent tokens are listed and revoked in their own place, not here. A
    // password change still ends them (end_sessions_of): that is a reset.
    sqlx::query(
        "DELETE FROM session WHERE user_id = ? AND token_hash IS NOT ? AND kind <> 'agent'",
    )
    .bind(&me.id)
    .bind(principal.session_hash())
    .execute(&app.db)
    .await?;
    tracing::info!(user = %me.id, "other sessions revoked");
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn staff_act_only_on_lower_ranks_and_admins_on_all() {
        use Role::*;
        let allowed = [
            (Admin, Admin),
            (Admin, Moderator),
            (Admin, Member),
            (Moderator, Member),
        ];
        for me in [Member, Moderator, Admin] {
            for target in [Member, Moderator, Admin] {
                assert_eq!(
                    may_act_on(me, target),
                    allowed.contains(&(me, target)),
                    "{me:?} on {target:?}"
                );
            }
        }
        assert!(Member < Moderator && Moderator < Admin);
    }

    #[test]
    fn labels_name_browser_and_system_only() {
        let mut h = HeaderMap::new();
        h.insert(
            header::USER_AGENT,
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
                .parse()
                .unwrap(),
        );
        assert_eq!(browser_label(&h), "Safari on macOS");
        h.insert(
            header::USER_AGENT,
            "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0"
                .parse()
                .unwrap(),
        );
        assert_eq!(browser_label(&h), "Edge on Windows");
        assert_eq!(browser_label(&HeaderMap::new()), "A browser");
    }

    #[test]
    fn the_throttle_is_capped_and_keeps_the_newest() {
        let t = LoginThrottle::default();
        for _ in 0..7 {
            t.failed("victim");
        }
        for n in 0..LoginThrottle::MAX_KEYS + 5 {
            t.failed(&n.to_string());
        }
        assert_eq!(t.0.lock().unwrap().len(), LoginThrottle::MAX_KEYS);
        assert!(
            t.delay(&(LoginThrottle::MAX_KEYS + 4).to_string())
                .is_zero()
        );
        assert!(
            t.0.lock()
                .unwrap()
                .contains_key(&(LoginThrottle::MAX_KEYS + 4).to_string())
        );
        assert!(
            !t.0.lock().unwrap().contains_key("victim"),
            "the oldest went first"
        );
    }

    /// With every permit held, a password check waits instead of running.
    #[tokio::test]
    async fn password_checks_wait_for_a_permit() {
        let permits = password_permits();
        let held = permits
            .acquire_many(password_concurrency() as u32)
            .await
            .unwrap();
        let check = tokio::spawn(verify_password("x".into(), None));
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!check.is_finished(), "ran without a permit");
        drop(held);
        assert_eq!(check.await.unwrap(), Verified::No);
    }

    #[tokio::test]
    async fn passwords_verify_and_bcrypt_asks_for_a_rehash() {
        let hash = hash_password("correct horse battery".into()).await.unwrap();
        assert!(hash.starts_with("{argon2id}$argon2id$v=19$"));
        assert_eq!(
            verify_password("correct horse battery".into(), Some(hash.clone())).await,
            Verified::Yes
        );
        assert_eq!(
            verify_password("correct horse batterz".into(), Some(hash)).await,
            Verified::No
        );
        let old = bcrypt_hash_for_tests("correct horse battery");
        assert_eq!(
            verify_password("correct horse battery".into(), Some(old)).await,
            Verified::YesRehash
        );
        assert_eq!(verify_password("anything".into(), None).await, Verified::No);
    }
}
