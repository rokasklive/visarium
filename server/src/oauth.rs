//! OAuth 2.1 for `/mcp` (mcp-oauth), as the MCP authorization specification
//! asks: protected resource metadata (RFC 9728), authorization server
//! metadata (RFC 8414), the authorization code grant with PKCE S256 only,
//! resource indicators (RFC 8707), `iss` on the redirect (RFC 9207), Client ID
//! Metadata Documents, and Dynamic Client Registration (RFC 7591) for clients
//! that have not moved to documents yet.
//!
//! A client that signs in becomes an ordinary agent `session`: its label, its
//! *Manage boards* grant, its last use and its revoke button are the minted
//! token's. Access and refresh tokens live in `oauth_token` and point at that
//! session, so revoking the agent ends them by cascade.
//!
//! Offered only when the server knows its public address and is not the
//! desktop's single-user server. Minted bearer tokens keep working regardless.

// A handler's error here is the finished OAuth error response; boxing it would
// only move the allocation.
#![allow(clippy::result_large_err)]

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Mutex;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use axum::Router;
use axum::extract::rejection::{FormRejection, JsonRejection};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{Html, IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use base64::Engine;
use reqwest::Url;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

use crate::auth::{self, Kind, User};
use crate::error::{ApiError, ApiResult};
use crate::{AppState, NOW};

pub const SCOPE: &str = "mcp";
const ACCESS_SECS: i64 = 3_600;
const REFRESH_SECS: i64 = 90 * 86_400;
/// How long a person has between following a client's link and approving it.
const REQUEST_TTL: Duration = Duration::from_secs(600);
const CODE_TTL: Duration = Duration::from_secs(60);
/// A Client ID Metadata Document is fetched again after this long.
/// ponytail: fixed, Cache-Control ignored; honour it if a client needs fresher.
const DOCUMENT_TTL_SECS: i64 = 3_600;
const DOCUMENT_MAX_BYTES: usize = 64 * 1024;
const DOCUMENT_TIMEOUT: Duration = Duration::from_secs(5);
const REGISTRATIONS_PER_HOUR: u32 = 10;

// --- where OAuth lives ---------------------------------------------------------------

/// The issuer, `https://visarium.example.com`, when OAuth is offered.
pub fn issuer(app: &AppState) -> Option<String> {
    if app.config.single_user {
        return None;
    }
    let url = app.config.public_url.as_deref()?.trim_end_matches('/');
    (!url.is_empty()).then(|| url.to_string())
}

/// The resource tokens are for: `/mcp` at the public address.
fn resource(issuer: &str) -> String {
    format!("{issuer}{}", auth::MCP_PATH)
}

fn resource_metadata_url(issuer: &str) -> String {
    format!(
        "{issuer}/.well-known/oauth-protected-resource{}",
        auth::MCP_PATH
    )
}

/// The `WWW-Authenticate` value for a refused `/mcp` call, when OAuth is
/// offered. `tried` adds `error="invalid_token"`, which tells a client its
/// token expired or was revoked and that it should refresh or sign in again.
pub fn challenge(app: &AppState, tried: bool) -> Option<HeaderValue> {
    let issuer = issuer(app)?;
    let error = if tried {
        ", error=\"invalid_token\""
    } else {
        ""
    };
    HeaderValue::from_str(&format!(
        "Bearer resource_metadata=\"{}\", scope=\"{SCOPE}\"{error}",
        resource_metadata_url(&issuer)
    ))
    .ok()
}

/// Browser navigations and machine endpoints outside `/api`. Each answers
/// `404` while OAuth is not offered.
pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/.well-known/oauth-protected-resource",
            get(resource_metadata).options(preflight),
        )
        .route(
            "/.well-known/oauth-protected-resource/mcp",
            get(resource_metadata).options(preflight),
        )
        .route(
            "/.well-known/oauth-authorization-server",
            get(server_metadata).options(preflight),
        )
        .route("/oauth/authorize", get(authorize))
        .route("/oauth/token", post(token).options(preflight))
        .route("/oauth/register", post(register).options(preflight))
}

/// Signed-in members: the consent page's two calls.
pub fn member_routes() -> Router<AppState> {
    Router::new()
        .route("/oauth/requests/{id}", get(pending_request))
        .route("/oauth/consent", post(consent))
}

/// Cross-origin reads for browser-based clients. No credentials: none of these
/// endpoints reads a cookie.
fn cors(mut response: Response) -> Response {
    let h = response.headers_mut();
    h.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    h.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("authorization, content-type, mcp-protocol-version"),
    );
    h.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    response
}

async fn preflight(State(app): State<AppState>) -> Response {
    if issuer(&app).is_none() {
        return not_offered();
    }
    cors(StatusCode::NO_CONTENT.into_response())
}

fn not_offered() -> Response {
    ApiError::not_found("this server does not offer OAuth sign-in; use an agent token")
        .into_response()
}

// --- discovery -----------------------------------------------------------------------

async fn resource_metadata(State(app): State<AppState>) -> Response {
    let Some(issuer) = issuer(&app) else {
        return not_offered();
    };
    cors(
        axum::Json(json!({
            "resource": resource(&issuer),
            "authorization_servers": [issuer],
            "scopes_supported": [SCOPE],
            "bearer_methods_supported": ["header"],
            "resource_name": "Visarium",
        }))
        .into_response(),
    )
}

async fn server_metadata(State(app): State<AppState>) -> Response {
    let Some(issuer) = issuer(&app) else {
        return not_offered();
    };
    cors(
        axum::Json(json!({
            "issuer": issuer,
            "authorization_endpoint": format!("{issuer}/oauth/authorize"),
            "token_endpoint": format!("{issuer}/oauth/token"),
            "registration_endpoint": format!("{issuer}/oauth/register"),
            "scopes_supported": [SCOPE],
            "response_types_supported": ["code"],
            "response_modes_supported": ["query"],
            "grant_types_supported": ["authorization_code", "refresh_token"],
            "code_challenge_methods_supported": ["S256"],
            "token_endpoint_auth_methods_supported": ["none"],
            "client_id_metadata_document_supported": true,
            "authorization_response_iss_parameter_supported": true,
        }))
        .into_response(),
    )
}

// --- redirect URIs -------------------------------------------------------------------

/// Private-use schemes of clients known to need one. Any scheme with a dot
/// (reverse domain, RFC 8252 §7.1) is also accepted.
const KNOWN_SCHEMES: [&str; 6] = [
    "cursor",
    "vscode",
    "vscode-insiders",
    "claude",
    "windsurf",
    "zed",
];

/// A redirect URI a client may declare: HTTPS, `http` on a loopback host, or
/// a private-use scheme. Never one that runs code or reads files.
pub fn redirect_allowed(raw: &str) -> bool {
    let Ok(url) = Url::parse(raw) else {
        return false;
    };
    if url.fragment().is_some() {
        return false;
    }
    match url.scheme() {
        "https" => url.host_str().is_some_and(|h| !h.is_empty()),
        "http" => is_loopback(&url),
        "javascript" | "data" | "file" | "vbscript" | "blob" | "about" | "ftp" | "ws" | "wss" => {
            false
        }
        scheme => scheme.contains('.') || KNOWN_SCHEMES.contains(&scheme),
    }
}

fn is_loopback(url: &Url) -> bool {
    matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
}

/// Whether a requested redirect URI is one of the client's: exactly, or a
/// loopback URI that differs only in its port (RFC 8252 §7.3).
pub fn redirect_matches(registered: &[String], requested: &str) -> bool {
    registered.iter().any(|r| {
        if r == requested {
            return true;
        }
        let (Ok(a), Ok(b)) = (Url::parse(r), Url::parse(requested)) else {
            return false;
        };
        a.scheme() == "http"
            && b.scheme() == "http"
            && is_loopback(&a)
            && a.host_str() == b.host_str()
            && a.path() == b.path()
            && a.query() == b.query()
            && b.fragment().is_none()
    })
}

// --- clients -------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct Client {
    pub id: String,
    pub name: String,
    pub redirect_uris: Vec<String>,
    pub from_document: bool,
}

fn is_document_id(app: &AppState, id: &str) -> bool {
    id.starts_with("https://")
        || (app.allow_private_imports.load(Ordering::Relaxed) && id.starts_with("http://"))
}

/// The client by its id: a registered one, or the metadata document at that
/// URL (cached for an hour).
async fn find_client(app: &AppState, id: &str) -> Result<Client, String> {
    let row: Option<(String, String, bool, bool)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT name, redirect_uris, from_document, \
                coalesce(fetched_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-{DOCUMENT_TTL_SECS} seconds'), 0) \
           FROM oauth_client WHERE id = ?"
    )))
    .bind(id)
    .fetch_optional(&app.db)
    .await
    .map_err(|e| e.to_string())?;
    let document = is_document_id(app, id);
    match row {
        Some((name, uris, from_document, fresh)) if !document || (from_document && fresh) => {
            Ok(Client {
                id: id.to_string(),
                name,
                redirect_uris: serde_json::from_str(&uris).unwrap_or_default(),
                from_document,
            })
        }
        _ if document => fetch_document(app, id).await,
        _ => Err("this client is not registered here; register it again".into()),
    }
}

/// Fetches and checks a Client ID Metadata Document, then caches it.
async fn fetch_document(app: &AppState, id: &str) -> Result<Client, String> {
    let url = Url::parse(id).map_err(|_| "the client_id is not a URL".to_string())?;
    let host = url
        .host_str()
        .ok_or("the client_id URL has no host")?
        .to_string();
    let port = url.port_or_known_default().unwrap_or(443);
    let addrs: Vec<SocketAddr> = match host.trim_matches(['[', ']']).parse::<IpAddr>() {
        Ok(ip) => vec![SocketAddr::new(ip, port)],
        Err(_) => tokio::net::lookup_host((host.as_str(), port))
            .await
            .map_err(|e| format!("{host} could not be resolved ({e})"))?
            .collect(),
    };
    let first = *addrs.first().ok_or(format!("{host} has no address"))?;
    let allow_private = app.allow_private_imports.load(Ordering::Relaxed);
    if !allow_private && addrs.iter().any(|a| crate::agent::import::refused(a.ip())) {
        return Err(format!(
            "{host} is a private address; client metadata is fetched only from public ones"
        ));
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(DOCUMENT_TIMEOUT)
        .resolve(&host, first)
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(url)
        .header(header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| format!("fetching the client's metadata failed ({e})"))?;
    if !response.status().is_success() {
        return Err(format!(
            "the client's metadata answered {}",
            response.status()
        ));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        body.extend_from_slice(&chunk);
        if body.len() > DOCUMENT_MAX_BYTES {
            return Err("the client's metadata is larger than 64 KB".into());
        }
    }
    let doc: Value =
        serde_json::from_slice(&body).map_err(|_| "the client's metadata is not JSON")?;
    if doc.get("client_id").and_then(Value::as_str) != Some(id) {
        return Err("the client's metadata names a different client_id".into());
    }
    if let Some(method) = doc
        .get("token_endpoint_auth_method")
        .and_then(Value::as_str)
        && method != "none"
    {
        return Err(format!(
            "the client wants token_endpoint_auth_method {method}; this server takes public clients only"
        ));
    }
    let redirect_uris: Vec<String> = doc
        .get("redirect_uris")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();
    if redirect_uris.is_empty() || !redirect_uris.iter().all(|u| redirect_allowed(u)) {
        return Err("the client's metadata has no usable redirect_uris".into());
    }
    let name = client_name(doc.get("client_name").and_then(Value::as_str), &host);
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "INSERT INTO oauth_client (id, name, redirect_uris, from_document, fetched_at) VALUES (?1, ?2, ?3, 1, {NOW}) \
         ON CONFLICT (id) DO UPDATE SET name = ?2, redirect_uris = ?3, from_document = 1, fetched_at = {NOW}"
    )))
    .bind(id)
    .bind(&name)
    .bind(json!(redirect_uris).to_string())
    .execute(&app.db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(Client {
        id: id.to_string(),
        name,
        redirect_uris,
        from_document: true,
    })
}

fn client_name(given: Option<&str>, fallback: &str) -> String {
    let name: String = given
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or(fallback)
        .chars()
        .filter(|c| !c.is_control())
        .take(80)
        .collect();
    if name.is_empty() {
        "MCP client".into()
    } else {
        name
    }
}

/// Registrations per address per hour. ponytail: in memory, keyed by the
/// proxy's last `X-Forwarded-For` hop; without a proxy every caller shares
/// one key, which only makes the limit stricter.
#[derive(Default)]
pub struct Registrations(Mutex<HashMap<String, (u32, Instant)>>);

impl Registrations {
    fn allow(&self, key: &str) -> bool {
        let mut map = self.0.lock().unwrap();
        if map.len() > 10_000 {
            map.retain(|_, (_, at)| at.elapsed() < Duration::from_secs(3600));
        }
        let entry = map.entry(key.into()).or_insert((0, Instant::now()));
        if entry.1.elapsed() >= Duration::from_secs(3600) {
            *entry = (0, Instant::now());
        }
        entry.0 += 1;
        entry.0 <= REGISTRATIONS_PER_HOUR
    }
}

fn caller_address(headers: &HeaderMap) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.rsplit(',').next())
        .map(|v| v.trim().to_string())
        .unwrap_or_else(|| "direct".into())
}

/// RFC 7591, for public clients only.
async fn register(
    State(app): State<AppState>,
    headers: HeaderMap,
    body: Result<axum::Json<Value>, JsonRejection>,
) -> Response {
    if issuer(&app).is_none() {
        return not_offered();
    }
    cors(
        register_inner(&app, &headers, body)
            .await
            .unwrap_or_else(|e| e),
    )
}

async fn register_inner(
    app: &AppState,
    headers: &HeaderMap,
    body: Result<axum::Json<Value>, JsonRejection>,
) -> Result<Response, Response> {
    let bad = |code: &str, why: &str| oauth_error(StatusCode::BAD_REQUEST, code, why);
    let axum::Json(body) = body.map_err(|_| {
        bad(
            "invalid_client_metadata",
            "the body must be JSON client metadata",
        )
    })?;
    if !app.oauth_registrations.allow(&caller_address(headers)) {
        return Err(oauth_error(
            StatusCode::TOO_MANY_REQUESTS,
            "invalid_request",
            "too many registrations from this address; try again in an hour",
        ));
    }
    let method = body
        .get("token_endpoint_auth_method")
        .and_then(Value::as_str)
        .unwrap_or("none");
    if method != "none" {
        return Err(bad(
            "invalid_client_metadata",
            "only public clients (token_endpoint_auth_method none) can register here",
        ));
    }
    if let Some(grants) = body.get("grant_types").and_then(Value::as_array)
        && grants
            .iter()
            .any(|g| !matches!(g.as_str(), Some("authorization_code" | "refresh_token")))
    {
        return Err(bad(
            "invalid_client_metadata",
            "grant_types may be authorization_code and refresh_token only",
        ));
    }
    let uris: Vec<String> = body
        .get("redirect_uris")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();
    if uris.is_empty() || uris.len() > 10 {
        return Err(bad("invalid_redirect_uri", "give one to ten redirect_uris"));
    }
    if let Some(wrong) = uris.iter().find(|u| !redirect_allowed(u)) {
        tracing::info!(redirect_uri = %wrong, "oauth registration refused");
        return Err(bad(
            "invalid_redirect_uri",
            "a redirect URI must be https, http on localhost, or a private-use scheme",
        ));
    }
    let name = client_name(
        body.get("client_name").and_then(Value::as_str),
        "MCP client",
    );
    let id = auth::random_token();
    sqlx::query("INSERT INTO oauth_client (id, name, redirect_uris) VALUES (?, ?, ?)")
        .bind(&id)
        .bind(&name)
        .bind(json!(uris).to_string())
        .execute(&app.db)
        .await
        .map_err(|e| server_error(&e))?;
    tracing::info!(client = %name, "oauth client registered");
    Ok((
        StatusCode::CREATED,
        axum::Json(json!({
            "client_id": id,
            "client_id_issued_at": chrono_now_secs(),
            "client_name": name,
            "redirect_uris": uris,
            "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
        })),
    )
        .into_response())
}

fn chrono_now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// --- authorize and consent -----------------------------------------------------------

/// A validated authorization request, waiting for the person's answer.
#[derive(Clone)]
struct Request {
    client: Client,
    redirect_uri: String,
    state: String,
    challenge: String,
    issued: Instant,
}

/// A code waiting to be redeemed.
#[derive(Clone)]
struct Code {
    user_id: String,
    client: Client,
    redirect_uri: String,
    challenge: String,
    manage_boards: bool,
    issued: Instant,
}

/// Requests and codes. ponytail: in memory; a restart during the minute of a
/// sign-in means signing in again.
#[derive(Default)]
pub struct Pending {
    requests: Mutex<HashMap<String, Request>>,
    codes: Mutex<HashMap<String, Code>>,
}

impl Pending {
    fn put_request(&self, id: String, r: Request) {
        let mut m = self.requests.lock().unwrap();
        m.retain(|_, r| r.issued.elapsed() < REQUEST_TTL);
        m.insert(id, r);
    }
    fn request(&self, id: &str) -> Option<Request> {
        self.requests
            .lock()
            .unwrap()
            .get(id)
            .filter(|r| r.issued.elapsed() < REQUEST_TTL)
            .cloned()
    }
    fn take_request(&self, id: &str) -> Option<Request> {
        self.requests
            .lock()
            .unwrap()
            .remove(id)
            .filter(|r| r.issued.elapsed() < REQUEST_TTL)
    }
    fn put_code(&self, code: String, c: Code) {
        let mut m = self.codes.lock().unwrap();
        m.retain(|_, c| c.issued.elapsed() < CODE_TTL);
        m.insert(code, c);
    }
    /// Single-use even when the rest of the exchange turns out wrong.
    fn take_code(&self, code: &str) -> Option<Code> {
        self.codes
            .lock()
            .unwrap()
            .remove(code)
            .filter(|c| c.issued.elapsed() < CODE_TTL)
    }
}

#[derive(Deserialize, Default)]
struct AuthorizeQuery {
    response_type: Option<String>,
    client_id: Option<String>,
    redirect_uri: Option<String>,
    state: Option<String>,
    code_challenge: Option<String>,
    code_challenge_method: Option<String>,
    resource: Option<String>,
}

/// Validates the client and redirect URI first: until both are known good,
/// an error is a page here, never a redirect. Later errors go back to the
/// client. A good request goes on to the SPA's consent page.
async fn authorize(State(app): State<AppState>, Query(q): Query<AuthorizeQuery>) -> Response {
    let Some(issuer) = issuer(&app) else {
        return not_offered();
    };
    let Some(client_id) = q.client_id.as_deref().filter(|c| !c.is_empty()) else {
        return error_page("The sign-in link has no client_id.");
    };
    let client = match find_client(&app, client_id).await {
        Ok(c) => c,
        Err(why) => {
            tracing::info!(reason = %why, "oauth authorize refused");
            return error_page(&format!("This app cannot sign in here: {why}."));
        }
    };
    let redirect_uri = match q.redirect_uri.as_deref() {
        Some(r) if redirect_matches(&client.redirect_uris, r) => r.to_string(),
        None if client.redirect_uris.len() == 1 => client.redirect_uris[0].clone(),
        _ => {
            return error_page(&format!(
                "{} asked to return to an address it did not register.",
                client.name
            ));
        }
    };
    let state = q.state.clone().unwrap_or_default();
    let back = |error: &str, description: &str| {
        Redirect::to(&with_params(
            &redirect_uri,
            &[
                ("error", error),
                ("error_description", description),
                ("state", &state),
                ("iss", &issuer),
            ],
        ))
        .into_response()
    };
    if q.response_type.as_deref() != Some("code") {
        return back(
            "unsupported_response_type",
            "only response_type=code is supported",
        );
    }
    if state.is_empty() || state.len() > 512 {
        return back("invalid_request", "state is required");
    }
    let challenge = q.code_challenge.clone().unwrap_or_default();
    if q.code_challenge_method.as_deref() != Some("S256")
        || challenge.len() != 43
        || !challenge
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return back(
            "invalid_request",
            "PKCE is required: code_challenge with code_challenge_method=S256",
        );
    }
    if let Some(r) = q.resource.as_deref()
        && r.trim_end_matches('/') != resource(&issuer)
    {
        return back(
            "invalid_target",
            "tokens here are only for this server's /mcp",
        );
    }
    let id = auth::random_token();
    app.oauth.put_request(
        id.clone(),
        Request {
            client,
            redirect_uri,
            state,
            challenge,
            issued: Instant::now(),
        },
    );
    Redirect::to(&format!("/oauth/consent?request={id}")).into_response()
}

fn with_params(base: &str, params: &[(&str, &str)]) -> String {
    let Ok(mut url) = Url::parse(base) else {
        return base.to_string();
    };
    {
        let mut q = url.query_pairs_mut();
        for (k, v) in params {
            q.append_pair(k, v);
        }
    }
    url.to_string()
}

fn error_page(message: &str) -> Response {
    let escaped = message
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;");
    (
        StatusCode::BAD_REQUEST,
        Html(format!(
            "<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width\">\
             <title>Sign-in refused</title><body style=\"font:14px system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem\">\
             <h1 style=\"font-size:16px\">Sign-in refused</h1><p>{escaped}</p><p>Nothing was shared with the app. You can close this tab.</p>"
        )),
    )
        .into_response()
}

/// What the consent page shows: who is asking, and where the answer goes.
async fn pending_request(
    State(app): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<axum::Json<Value>> {
    let r = app.oauth.request(&id).ok_or_else(|| {
        ApiError::not_found("this sign-in request has expired; start again from the app")
    })?;
    Ok(axum::Json(json!({
        "clientName": r.client.name,
        "redirectHost": shown_host(&r.redirect_uri),
        "clientHost": r.client.from_document.then(|| shown_host(&r.client.id)),
    })))
}

/// `claude.ai`, `127.0.0.1`, `cursor://anysphere.cursor-mcp`.
fn shown_host(uri: &str) -> String {
    match Url::parse(uri) {
        Ok(u) if matches!(u.scheme(), "http" | "https") => {
            u.host_str().unwrap_or_default().to_string()
        }
        Ok(u) => format!("{}://{}", u.scheme(), u.host_str().unwrap_or_default()),
        Err(_) => uri.to_string(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Consent {
    request: String,
    approve: bool,
    #[serde(default)]
    manage_boards: bool,
}

async fn consent(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
    crate::error::Json(body): crate::error::Json<Consent>,
) -> ApiResult<axum::Json<Value>> {
    let issuer = issuer(&app).ok_or_else(|| ApiError::not_found("OAuth is not offered here"))?;
    let r = app.oauth.take_request(&body.request).ok_or_else(|| {
        ApiError::not_found("this sign-in request has expired; start again from the app")
    })?;
    let redirect = if body.approve {
        let code = auth::random_token();
        app.oauth.put_code(
            code.clone(),
            Code {
                user_id: me.id.clone(),
                client: r.client.clone(),
                redirect_uri: r.redirect_uri.clone(),
                challenge: r.challenge,
                manage_boards: body.manage_boards,
                issued: Instant::now(),
            },
        );
        tracing::info!(user = %me.id, client = %r.client.name, "oauth client approved");
        with_params(
            &r.redirect_uri,
            &[("code", &code), ("state", &r.state), ("iss", &issuer)],
        )
    } else {
        with_params(
            &r.redirect_uri,
            &[
                ("error", "access_denied"),
                ("error_description", "the person declined"),
                ("state", &r.state),
                ("iss", &issuer),
            ],
        )
    };
    Ok(axum::Json(json!({ "redirect": redirect })))
}

// --- tokens --------------------------------------------------------------------------

fn oauth_error(status: StatusCode, code: &str, description: &str) -> Response {
    (
        status,
        [(header::CACHE_CONTROL, "no-store")],
        axum::Json(json!({ "error": code, "error_description": description })),
    )
        .into_response()
}

fn server_error(e: &dyn std::fmt::Display) -> Response {
    tracing::error!(error = %e, "oauth request failed");
    oauth_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "server_error",
        "the server could not complete this request",
    )
}

async fn token(
    State(app): State<AppState>,
    form: Result<axum::Form<HashMap<String, String>>, FormRejection>,
) -> Response {
    let Some(issuer) = issuer(&app) else {
        return not_offered();
    };
    let result = match form {
        Err(_) => Err(oauth_error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "send the token request as application/x-www-form-urlencoded",
        )),
        Ok(axum::Form(f)) => match f.get("grant_type").map(String::as_str) {
            Some("authorization_code") => redeem_code(&app, &issuer, &f).await,
            Some("refresh_token") => refresh(&app, &issuer, &f).await,
            _ => Err(oauth_error(
                StatusCode::BAD_REQUEST,
                "unsupported_grant_type",
                "grant_type must be authorization_code or refresh_token",
            )),
        },
    };
    cors(result.unwrap_or_else(|e| e))
}

fn grant_error(description: &str) -> Response {
    oauth_error(StatusCode::BAD_REQUEST, "invalid_grant", description)
}

fn check_resource(issuer: &str, f: &HashMap<String, String>) -> Result<(), Response> {
    match f.get("resource") {
        Some(r) if r.trim_end_matches('/') != resource(issuer) => Err(oauth_error(
            StatusCode::BAD_REQUEST,
            "invalid_target",
            "tokens here are only for this server's /mcp",
        )),
        _ => Ok(()),
    }
}

async fn redeem_code(
    app: &AppState,
    issuer: &str,
    f: &HashMap<String, String>,
) -> Result<Response, Response> {
    let get = |k: &str| f.get(k).map(String::as_str).unwrap_or("");
    let code = app
        .oauth
        .take_code(get("code"))
        .ok_or_else(|| grant_error("the code is not valid: it expired, or was already used"))?;
    let verifier_challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(Sha256::digest(get("code_verifier").as_bytes()));
    if verifier_challenge != code.challenge {
        tracing::warn!(client = %code.client.name, reason = "bad verifier", "oauth token refused");
        return Err(grant_error(
            "the code_verifier does not match the code_challenge",
        ));
    }
    if get("client_id") != code.client.id {
        return Err(grant_error("the code was issued to another client"));
    }
    if get("redirect_uri") != code.redirect_uri {
        return Err(grant_error(
            "redirect_uri must be the one the authorization request used",
        ));
    }
    check_resource(issuer, f)?;
    let user = auth::find_user(&app.db, &code.user_id)
        .await
        .map_err(|e| server_error(&e))?
        .filter(|u| u.deactivated_at.is_none())
        .ok_or_else(|| grant_error("the account that approved this is no longer active"))?;
    // The connection: an agent session no one holds the secret of. Its
    // tokens are the ones issued below.
    let unheld = auth::create_session(
        &app.db,
        Kind::Agent,
        Some(&user.id),
        None,
        None,
        Some(&code.client.name),
    )
    .await
    .map_err(|e| server_error(&e))?;
    let session_id: String = sqlx::query_scalar("SELECT id FROM session WHERE token_hash = ?")
        .bind(auth::hash_token(&unheld))
        .fetch_one(&app.db)
        .await
        .map_err(|e| server_error(&e))?;
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE session SET oauth_client_id = ?, manage_boards = ?, \
                expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+{REFRESH_SECS} seconds') WHERE id = ?"
    )))
    .bind(&code.client.id)
    .bind(code.manage_boards)
    .bind(&session_id)
    .execute(&app.db)
    .await
    .map_err(|e| server_error(&e))?;
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE oauth_client SET used_at = coalesce(used_at, {NOW}) WHERE id = ?"
    )))
    .bind(&code.client.id)
    .execute(&app.db)
    .await
    .map_err(|e| server_error(&e))?;
    tracing::info!(user = %user.id, session = %session_id, client = %code.client.name, "oauth client connected");
    issue(&app.db, &session_id).await
}

async fn refresh(
    app: &AppState,
    issuer: &str,
    f: &HashMap<String, String>,
) -> Result<Response, Response> {
    let presented = f.get("refresh_token").map(String::as_str).unwrap_or("");
    let hash = auth::hash_token(presented);
    type Row = (String, Option<String>, bool, Option<String>, String);
    let row: Option<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT t.session_id, t.used_at, t.expires_at > {NOW}, s.oauth_client_id, s.user_id
               FROM oauth_token t JOIN session s ON s.id = t.session_id
              WHERE t.token_hash = ? AND t.kind = 'refresh' AND s.kind = 'agent'"
    )))
    .bind(&hash)
    .fetch_optional(&app.db)
    .await
    .map_err(|e| server_error(&e))?;
    let Some((session_id, used_at, live, client_id, user_id)) = row else {
        return Err(grant_error("the refresh token is not valid; sign in again"));
    };
    if f.get("client_id").map(String::as_str) != client_id.as_deref() {
        return Err(grant_error(
            "the refresh token was issued to another client",
        ));
    }
    if used_at.is_some() {
        revoke_stolen(&app.db, &session_id).await;
        return Err(grant_error(
            "this refresh token was already used, so the connection was ended; sign in again",
        ));
    }
    if !live {
        return Err(grant_error("the refresh token expired; sign in again"));
    }
    check_resource(issuer, f)?;
    // Used once: a second, concurrent refresh with the same token finds it
    // used and ends the connection, as a replay would.
    let claimed = sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE oauth_token SET used_at = {NOW} WHERE token_hash = ? AND used_at IS NULL"
    )))
    .bind(&hash)
    .execute(&app.db)
    .await
    .map_err(|e| server_error(&e))?;
    if claimed.rows_affected() == 0 {
        revoke_stolen(&app.db, &session_id).await;
        return Err(grant_error(
            "this refresh token was already used, so the connection was ended; sign in again",
        ));
    }
    let active = auth::find_user(&app.db, &user_id)
        .await
        .map_err(|e| server_error(&e))?
        .is_some_and(|u| u.deactivated_at.is_none());
    if !active {
        return Err(grant_error("the account is no longer active"));
    }
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE session SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+{REFRESH_SECS} seconds') WHERE id = ?"
    )))
    .bind(&session_id)
    .execute(&app.db)
    .await
    .map_err(|e| server_error(&e))?;
    issue(&app.db, &session_id).await
}

/// A refresh token presented twice: one of the two holders is not the
/// client. End the connection; the person can sign the client in again.
async fn revoke_stolen(db: &SqlitePool, session_id: &str) {
    tracing::warn!(session = %session_id, "oauth refresh token reused; connection ended");
    if let Err(e) = sqlx::query("DELETE FROM session WHERE id = ?")
        .bind(session_id)
        .execute(db)
        .await
    {
        tracing::error!(session = %session_id, error = %e, "could not end a connection whose refresh token was reused");
    }
}

/// A fresh access token and refresh token for a connection.
async fn issue(db: &SqlitePool, session_id: &str) -> Result<Response, Response> {
    let access = auth::random_token();
    let refresh = auth::random_token();
    for (token, kind, secs) in [
        (&access, "access", ACCESS_SECS),
        (&refresh, "refresh", REFRESH_SECS),
    ] {
        sqlx::query(
            "INSERT INTO oauth_token (token_hash, session_id, kind, expires_at) \
             VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?))",
        )
        .bind(auth::hash_token(token))
        .bind(session_id)
        .bind(kind)
        .bind(format!("+{secs} seconds"))
        .execute(db)
        .await
        .map_err(|e| server_error(&e))?;
    }
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        axum::Json(json!({
            "access_token": access,
            "token_type": "Bearer",
            "expires_in": ACCESS_SECS,
            "refresh_token": refresh,
            "scope": SCOPE,
        })),
    )
        .into_response())
}

/// Expired tokens, and clients registered a day ago and never used.
pub async fn sweep(db: &SqlitePool) -> sqlx::Result<()> {
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "DELETE FROM oauth_token WHERE expires_at <= {NOW}"
    )))
    .execute(db)
    .await?;
    sqlx::query(
        "DELETE FROM oauth_client WHERE used_at IS NULL \
           AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')",
    )
    .execute(db)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redirect_uris_allowed_and_refused() {
        for ok in [
            "https://claude.ai/api/mcp/auth_callback",
            "http://localhost:8787/callback",
            "http://127.0.0.1/callback",
            "http://[::1]:5000/cb",
            "cursor://anysphere.cursor-mcp/oauth/callback",
            "com.example.app:/oauth",
        ] {
            assert!(redirect_allowed(ok), "{ok} should be allowed");
        }
        for bad in [
            "http://evil.example.com/cb",
            "javascript:alert(1)",
            "data:text/html,hi",
            "file:///etc/passwd",
            "https://claude.ai/cb#frag",
            "myapp://cb",
            "not a url",
        ] {
            assert!(!redirect_allowed(bad), "{bad} should be refused");
        }
    }

    #[test]
    fn loopback_port_may_differ_nothing_else() {
        let reg = vec!["http://127.0.0.1/callback".to_string()];
        assert!(redirect_matches(&reg, "http://127.0.0.1:8787/callback"));
        assert!(!redirect_matches(&reg, "http://127.0.0.1:8787/other"));
        assert!(!redirect_matches(&reg, "http://localhost:8787/callback"));
        let reg = vec!["https://claude.ai/api/mcp/auth_callback".to_string()];
        assert!(redirect_matches(
            &reg,
            "https://claude.ai/api/mcp/auth_callback"
        ));
        assert!(!redirect_matches(
            &reg,
            "https://claude.ai:444/api/mcp/auth_callback"
        ));
        let reg = vec!["cursor://anysphere.cursor-mcp/oauth/callback".to_string()];
        assert!(redirect_matches(
            &reg,
            "cursor://anysphere.cursor-mcp/oauth/callback"
        ));
    }

    #[test]
    fn registrations_are_limited() {
        let r = Registrations::default();
        for _ in 0..REGISTRATIONS_PER_HOUR {
            assert!(r.allow("a"));
        }
        assert!(!r.allow("a"));
        assert!(r.allow("b"));
    }
}
