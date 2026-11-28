//! The agent interface (ADR-0031): the Model Context Protocol over HTTP, and
//! the tools behind it.
//!
//! Stateless per the 2026-07-28 specification: one JSON-RPC request per
//! `POST /mcp`, no session, no handshake required. `initialize` is still
//! answered, for clients that send it, from the same discovery result. Tool
//! failures come back as readable results (`isError`), not protocol errors,
//! because the agent is the one who has to act on them.
//!
//! Who is calling is decided before this module runs: `auth::session_layer`
//! resolves a bearer agent token on `/mcp` and nothing else, and
//! `require_agent` admits that agent, or the local account in single-user mode.

pub mod blocks;
pub mod board;
pub mod boards;
pub mod confirm;
pub mod diagram;
pub mod import;
pub mod place;
pub mod read;
pub mod status;
pub mod write;

use std::collections::HashMap;
use std::sync::Mutex;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::auth::{self, Kind, Principal, User};
use crate::boards::Actor;
use crate::error::{ApiError, ApiResult, Json};
use crate::{AppState, NOW};

/// The newest protocol revision spoken here, and older ones still answered.
pub const PROTOCOL: &str = "2026-07-28";
const ALSO_SPOKEN: [&str; 3] = ["2025-11-25", "2025-06-18", "2025-03-26"];
/// How long a client may cache the tool and resource lists.
const LIST_TTL_MS: u64 = 3_600_000;
/// The tool list without board management, cached briefly: a person who turns
/// the grant on expects the agent to see the tools soon.
const GRANT_TTL_MS: u64 = 60_000;
/// The tools that need the *Manage boards* grant.
const BOARD_TOOLS: [&str; 4] = [
    "board_create",
    "board_rename",
    "board_duplicate",
    "board_delete",
];

// --- the caller and a tool's answer --------------------------------------------

/// An agent, and the person it acts for.
#[derive(Clone)]
pub struct Caller {
    pub user: User,
    /// What its changes are credited to: the token's label, or the client's
    /// own name in single-user mode.
    pub agent: String,
    /// The agent session, for idempotent retries and rate limits. None for the
    /// desktop's local agent, which is keyed by its account.
    pub session: Option<String>,
}

impl Caller {
    /// The person, as an agent is told about them: their name, or "your
    /// person" for single-user mode's unnamed account ("You"), so a message
    /// never reads "needs You's confirmation".
    pub fn person(&self) -> String {
        match self.user.display_name.as_str() {
            "You" | "" => "your person".into(),
            name => name.into(),
        }
    }

    pub fn actor(&self) -> Actor {
        Actor {
            user_id: self.user.id.clone(),
            agent: Some(self.agent.clone()),
        }
    }
    /// One stable key per agent: its session, or its account when local.
    pub fn key(&self) -> String {
        self.session
            .clone()
            .unwrap_or_else(|| format!("local:{}", self.user.id))
    }
    /// Its presence id on a board: the same for every call it makes.
    pub fn presence_id(&self) -> Uuid {
        Uuid::new_v5(&Uuid::NAMESPACE_OID, self.key().as_bytes())
    }
}

/// What a tool hands back: Markdown for the model, optional structured facts,
/// an optional image, and the item it looked at or changed (for presence).
#[derive(Default)]
pub struct Out {
    pub text: String,
    pub structured: Option<Value>,
    pub image: Option<(String, String)>,
    pub touched: Option<(Uuid, Option<String>, &'static str)>,
}

impl Out {
    pub fn text(text: impl Into<String>) -> Out {
        Out {
            text: text.into(),
            ..Default::default()
        }
    }
    pub fn with(mut self, structured: Value) -> Out {
        self.structured = Some(structured);
        self
    }
    pub fn touch(mut self, board: Uuid, item: Option<String>, verb: &'static str) -> Out {
        self.touched = Some((board, item, verb));
        self
    }
}

pub fn arg_str<'a>(args: &'a Value, name: &str) -> Result<&'a str, String> {
    args.get(name)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| format!("'{name}' is required (a string)."))
}

pub fn opt_str<'a>(args: &'a Value, name: &str) -> Option<&'a str> {
    args.get(name)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
}

pub fn arg_i64(args: &Value, name: &str) -> Option<i64> {
    args.get(name).and_then(|v| {
        v.as_i64()
            .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
    })
}

// --- routes ----------------------------------------------------------------------

/// `/mcp`, behind `require_agent`.
pub fn routes() -> Router<AppState> {
    Router::new().route(auth::MCP_PATH, post(mcp).get(only_post).delete(only_post))
}

/// Minting, listing and revoking agent tokens: for signed-in members.
pub fn member_routes() -> Router<AppState> {
    Router::new()
        .route("/agent-tokens", get(list_tokens).post(create_token))
        .route(
            "/agent-tokens/{id}",
            delete(revoke_token).patch(set_token_grant),
        )
        .route(
            "/agent-settings",
            get(local_settings).patch(set_local_settings),
        )
}

async fn only_post() -> Response {
    (
        StatusCode::METHOD_NOT_ALLOWED,
        [(header::ALLOW, "POST")],
        "this endpoint takes one JSON-RPC request per POST; it opens no stream",
    )
        .into_response()
}

/// Admits an agent with a valid token, or the local account in single-user
/// mode (where the session layer already refused non-loopback hosts).
pub async fn require_agent(State(app): State<AppState>, mut req: Request, next: Next) -> Response {
    let caller = match req.extensions().get::<Principal>() {
        Some(Principal::Agent {
            user,
            session,
            label,
        }) => Caller {
            user: user.clone(),
            agent: label.clone(),
            session: Some(session.id.clone()),
        },
        Some(Principal::Local(user)) => Caller {
            user: user.clone(),
            agent: crate::auth::agent_of(&user.display_name),
            session: None,
        },
        _ => {
            let tried = req.headers().contains_key(header::AUTHORIZATION);
            let challenge = crate::oauth::challenge(&app, tried);
            let detail = match (tried, challenge.is_some()) {
                (true, true) => {
                    "this token is not valid: it expired or was revoked. Refresh it or sign in again, or create an agent token under Account → Agents."
                }
                (true, false) => {
                    "this agent token is not valid: it was revoked, or never existed. Create a new one under Account → Agents."
                }
                (false, true) => {
                    "this endpoint needs sign-in. Add this server's URL in a client that supports sign-in, or create an agent token under Account → Agents and send it as `Authorization: Bearer <token>`."
                }
                (false, false) => {
                    "this endpoint needs an agent token. Create one under Account → Agents and send it as `Authorization: Bearer <token>`."
                }
            };
            let mut response = ApiError::unauthorized(detail)
                .titled("Agent token required")
                .into_response();
            if let Some(value) = challenge {
                response
                    .headers_mut()
                    .insert(header::WWW_AUTHENTICATE, value);
            }
            return response;
        }
    };
    req.extensions_mut().insert(caller);
    next.run(req).await
}

// --- agent tokens ---------------------------------------------------------------------

#[derive(Deserialize)]
struct NewToken {
    label: String,
}

async fn create_token(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
    Json(body): Json<NewToken>,
) -> ApiResult<(StatusCode, axum::Json<Value>)> {
    let label = body.label.trim();
    if label.is_empty() || label.chars().count() > 120 {
        return Err(ApiError::bad_request(
            "a label is 1-120 characters, e.g. \"Claude Code on laptop\"",
        ));
    }
    let token =
        auth::create_session(&app.db, Kind::Agent, Some(&me.id), None, None, Some(label)).await?;
    let (id, created_at): (String, String) =
        sqlx::query_as("SELECT id, created_at FROM session WHERE token_hash = ?")
            .bind(auth::hash_token(&token))
            .fetch_one(&app.db)
            .await?;
    tracing::info!(token = %id, user = %me.id, "agent token created");
    Ok((
        StatusCode::CREATED,
        axum::Json(json!({ "id": id, "label": label, "token": token, "createdAt": created_at })),
    ))
}

async fn list_tokens(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
) -> ApiResult<axum::Json<Value>> {
    let rows: Vec<(String, Option<String>, String, String, bool, bool)> =
        sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT id, label, created_at, last_seen_at, manage_boards, oauth_client_id IS NOT NULL FROM session
          WHERE user_id = ? AND kind = 'agent' AND expires_at > {NOW} ORDER BY created_at DESC"
        )))
        .bind(&me.id)
        .fetch_all(&app.db)
        .await?;
    Ok(axum::Json(Value::Array(
        rows.into_iter()
            .map(|(id, label, created, seen, manage_boards, signed_in)| {
                // A token never used has the last-seen its creation wrote.
                let used = (seen != created).then_some(seen);
                json!({ "id": id, "label": label, "createdAt": created, "lastUsedAt": used, "manageBoards": manage_boards, "connectedBySignIn": signed_in })
            })
            .collect(),
    )))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Grant {
    manage_boards: bool,
}

/// Turns the *Manage boards* grant on or off for one of the member's tokens.
/// Read on every call, so it applies from the agent's next call.
async fn set_token_grant(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
    Path(id): Path<Uuid>,
    Json(body): Json<Grant>,
) -> ApiResult<StatusCode> {
    let done = sqlx::query(
        "UPDATE session SET manage_boards = ? WHERE id = ? AND user_id = ? AND kind = 'agent'",
    )
    .bind(body.manage_boards)
    .bind(id.to_string())
    .bind(&me.id)
    .execute(&app.db)
    .await?;
    if done.rows_affected() == 0 {
        return Err(ApiError::not_found(format!("no agent token {id}")));
    }
    tracing::info!(token = %id, user = %me.id, manage_boards = body.manage_boards, "agent token grant changed");
    Ok(StatusCode::NO_CONTENT)
}

/// The grant for the desktop's tokenless local agents, kept on the account.
async fn local_settings(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
) -> ApiResult<axum::Json<Value>> {
    let on: bool =
        sqlx::query_scalar("SELECT local_agents_manage_boards FROM app_user WHERE id = ?")
            .bind(&me.id)
            .fetch_one(&app.db)
            .await?;
    Ok(axum::Json(json!({ "localAgentsManageBoards": on })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalGrant {
    local_agents_manage_boards: bool,
}

async fn set_local_settings(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
    Json(body): Json<LocalGrant>,
) -> ApiResult<axum::Json<Value>> {
    sqlx::query("UPDATE app_user SET local_agents_manage_boards = ? WHERE id = ?")
        .bind(body.local_agents_manage_boards)
        .bind(&me.id)
        .execute(&app.db)
        .await?;
    Ok(axum::Json(
        json!({ "localAgentsManageBoards": body.local_agents_manage_boards }),
    ))
}

/// Whether this caller may manage boards: its token's grant, or the local
/// account's switch. Read per call, never cached.
async fn may_manage_boards(app: &AppState, caller: &Caller) -> bool {
    let q = match &caller.session {
        Some(session) => sqlx::query_scalar("SELECT manage_boards FROM session WHERE id = ?")
            .bind(session.clone()),
        None => sqlx::query_scalar("SELECT local_agents_manage_boards FROM app_user WHERE id = ?")
            .bind(caller.user.id.clone()),
    };
    q.fetch_optional(&app.db)
        .await
        .ok()
        .flatten()
        .unwrap_or(false)
}

async fn revoke_token(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let done = sqlx::query("DELETE FROM session WHERE id = ? AND user_id = ? AND kind = 'agent'")
        .bind(id.to_string())
        .bind(&me.id)
        .execute(&app.db)
        .await?;
    if done.rows_affected() == 0 {
        return Err(ApiError::not_found(format!("no agent token {id}")));
    }
    tracing::info!(token = %id, user = %me.id, "agent token revoked");
    Ok(StatusCode::NO_CONTENT)
}

// --- write limits --------------------------------------------------------------------

/// Writes per agent per minute, so a runaway loop cannot bury a board. A
/// hypothesis; see OPEN_QUESTIONS.md.
pub const AGENT_WRITES_PER_MINUTE: u32 = 120;

/// ponytail: one mutex, a map of minute counters. Per-key sharding if agents
/// ever number in the thousands.
#[derive(Default)]
pub struct Limiter(Mutex<HashMap<String, (u64, u32)>>);

impl Limiter {
    /// Ok, or the seconds until the minute rolls over.
    pub fn take(&self, key: &str) -> Result<(), u64> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let minute = now / 60;
        let mut map = self.0.lock().unwrap();
        map.retain(|_, (m, _)| *m == minute);
        let entry = map.entry(key.to_string()).or_insert((minute, 0));
        if entry.1 >= AGENT_WRITES_PER_MINUTE {
            return Err(60 - now % 60);
        }
        entry.1 += 1;
        Ok(())
    }
}

// --- the endpoint ---------------------------------------------------------------------

fn rpc_error(id: &Value, code: i64, message: &str) -> Response {
    axum::Json(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }))
        .into_response()
}

/// A browser on another origin cannot get here with a token, but in
/// single-user mode there is no token: refuse any other origin outright.
fn foreign_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|o| o.to_str().ok()) else {
        return false;
    };
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    let origin_host = origin
        .split_once("://")
        .map_or(origin, |(_, rest)| rest.trim_end_matches('/'));
    !origin_host.eq_ignore_ascii_case(host)
}

/// The client's name, when its request carries one in `_meta`.
fn client_name(params: &Value) -> Option<String> {
    let meta = params.get("_meta")?.as_object()?;
    meta.iter()
        .find(|(k, _)| k.ends_with("clientInfo") || k.ends_with("client"))
        .and_then(|(_, v)| v.get("title").or_else(|| v.get("name")))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// `claude-code/2.1.181 (…)` → `Claude Code`: the product, made readable.
fn user_agent_name(headers: &HeaderMap) -> Option<String> {
    let ua = headers.get(header::USER_AGENT)?.to_str().ok()?;
    let product = ua.split(['/', ' ']).next()?.trim();
    if product.is_empty()
        || matches!(
            product,
            "node" | "undici" | "Mozilla" | "curl" | "python-requests"
        )
    {
        return None;
    }
    let words: Vec<String> = product
        .split(['-', '_'])
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            c.next()
                .map(|f| f.to_uppercase().chain(c).collect())
                .unwrap_or_default()
        })
        .collect();
    Some(words.join(" "))
}

async fn mcp(
    State(app): State<AppState>,
    axum::Extension(mut caller): axum::Extension<Caller>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if foreign_origin(&headers) {
        return ApiError::forbidden("requests from another origin are refused").into_response();
    }
    let json_body = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("application/json"));
    if !json_body {
        return (
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "send Content-Type: application/json",
        )
            .into_response();
    }
    let Ok(request) = serde_json::from_slice::<Value>(&body) else {
        return rpc_error(&Value::Null, -32700, "the body is not JSON");
    };
    if request.is_array() {
        return rpc_error(
            &Value::Null,
            -32600,
            "batches are not supported: one request per POST",
        );
    }
    let id = request.get("id").cloned();
    let Some(method) = request.get("method").and_then(Value::as_str) else {
        return rpc_error(
            &id.unwrap_or(Value::Null),
            -32600,
            "a request needs a method",
        );
    };
    if let Some(declared) = headers.get("mcp-method").and_then(|v| v.to_str().ok())
        && declared != method
    {
        return (
            StatusCode::BAD_REQUEST,
            "the Mcp-Method header does not match the body's method",
        )
            .into_response();
    }
    // A notification gets no answer.
    let Some(id) = id else {
        return StatusCode::ACCEPTED.into_response();
    };
    let params = request.get("params").cloned().unwrap_or(json!({}));
    // Which protocol and capabilities a client brings: what decides whether
    // it can be asked to confirm a delete.
    tracing::debug!(
        method,
        version = headers.get("mcp-protocol-version").and_then(|v| v.to_str().ok()).unwrap_or("-"),
        capabilities = %params.pointer("/_meta/io.modelcontextprotocol~1clientCapabilities").or_else(|| params.get("capabilities")).unwrap_or(&serde_json::Value::Null),
        agent = headers.get(header::USER_AGENT).and_then(|v| v.to_str().ok()).unwrap_or("-"),
        "mcp request"
    );
    // The local agent has no token label: its client says who it is, in the
    // request's `_meta` or, failing that, its User-Agent ("claude-code/2.1").
    if caller.session.is_none()
        && let Some(name) = client_name(&params).or_else(|| user_agent_name(&headers))
    {
        caller.agent = name;
    }
    let result = match method {
        "initialize" => initialize(&app, &params),
        "server/discover" => discover(&app),
        "ping" => json!({}),
        "tools/list" => {
            // Not cached for long: the grant can change between calls.
            let manage = may_manage_boards(&app, &caller).await;
            // Private: the list depends on this caller's grant.
            json!({ "tools": tools(manage), "ttlMs": if manage { LIST_TTL_MS } else { GRANT_TTL_MS }, "cacheScope": "private" })
        }
        "tools/call" => call(&app, &caller, &params).await,
        "resources/list" => json!({ "resources": [{
            "uri": "visarium://guide", "name": "guide", "title": "How to work on a Visarium board",
            "mimeType": "text/markdown", "description": "The longer guide, with an example call for every tool."
        }], "ttlMs": LIST_TTL_MS, "cacheScope": "public" }),
        "resources/read" => match params.get("uri").and_then(Value::as_str) {
            Some("visarium://guide") => {
                json!({ "contents": [{ "uri": "visarium://guide", "mimeType": "text/markdown", "text": guide() }] })
            }
            _ => {
                return rpc_error(
                    &id,
                    -32002,
                    "no such resource; the one resource is visarium://guide",
                );
            }
        },
        "prompts/list" => json!({ "prompts": [], "ttlMs": LIST_TTL_MS, "cacheScope": "public" }),
        _ => {
            return rpc_error(
                &id,
                -32601,
                &format!("method '{method}' is not supported here"),
            );
        }
    };
    // 2026-07-28: every result says whether it is complete; one that asks the
    // person first (`input_required`) already says so. Older clients ignore it.
    let mut result = result;
    if let Some(fields) = result.as_object_mut() {
        fields
            .entry("resultType")
            .or_insert_with(|| json!("complete"));
    }
    axum::Json(json!({ "jsonrpc": "2.0", "id": id, "result": result })).into_response()
}

fn capabilities() -> Value {
    json!({ "tools": { "listChanged": false }, "resources": { "listChanged": false } })
}

fn server_info() -> Value {
    json!({ "name": "visarium", "title": "Visarium", "version": env!("CARGO_PKG_VERSION") })
}

/// The pre-2026 handshake, for clients that still send `initialize`.
fn initialize(app: &AppState, params: &Value) -> Value {
    let asked = params
        .get("protocolVersion")
        .and_then(Value::as_str)
        .unwrap_or(PROTOCOL);
    let version = if asked == PROTOCOL || ALSO_SPOKEN.contains(&asked) {
        asked
    } else {
        PROTOCOL
    };
    json!({
        "protocolVersion": version,
        "capabilities": capabilities(),
        "serverInfo": server_info(),
        "instructions": instructions(app),
    })
}

/// A 2026-07-28 `DiscoverResult`. A client that cannot read it as one falls
/// back to `initialize` and the old protocol, and then cannot ask its person
/// anything mid-call, so every required field matters: `supportedVersions`,
/// `ttlMs`, `cacheScope`, and (added for every result) `resultType`. The
/// server's name goes in `_meta`, not at the top level.
fn discover(app: &AppState) -> Value {
    json!({
        "supportedVersions": [PROTOCOL],
        "capabilities": capabilities(),
        "instructions": instructions(app),
        "ttlMs": LIST_TTL_MS,
        "cacheScope": "public",
        "_meta": { "io.modelcontextprotocol/serverInfo": server_info() },
    })
}

/// One line per tool call: which tool, for whom, how it ended and how long it
/// took. Never its arguments: they hold board titles and item text.
async fn call(app: &AppState, caller: &Caller, params: &Value) -> Value {
    use tracing::Instrument;
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    // An unknown name is the client's text, so it is not recorded as is.
    let tool = if TOOL_NAMES.contains(&name) || BOARD_TOOLS.contains(&name) {
        name
    } else {
        "unknown"
    };
    let span = tracing::info_span!(
        "tool",
        tool,
        agent = %caller.agent,
        user = %caller.user.id,
        board = tracing::field::Empty
    );
    let started = std::time::Instant::now();
    let result = run_tool(app, caller, params).instrument(span.clone()).await;
    let _entered = span.enter();
    let duration_ms = started.elapsed().as_millis() as u64;
    let ok = result.get("isError") != Some(&Value::Bool(true));
    tracing::info!(ok, duration_ms, "tool call");
    result
}

async fn run_tool(app: &AppState, caller: &Caller, params: &Value) -> Value {
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    let args = params.get("arguments").cloned().unwrap_or(json!({}));
    if BOARD_TOOLS.contains(&name) {
        let outcome = if may_manage_boards(app, caller).await {
            boards::run(app, caller, name, params).await
        } else {
            Err(format!(
                "{name} needs the *Manage boards* grant, which is off for this agent. {} can turn it on under Settings → Agents{}. Nothing was changed.",
                caller.user.display_name,
                if caller.session.is_some() {
                    ", on this agent's token"
                } else {
                    " (\"Let local agents manage boards\")"
                }
            ))
        };
        return match outcome {
            Ok(boards::Step::Ask(result)) => result,
            Ok(boards::Step::Done(out)) => answer(app, caller, Ok(out)),
            Err(text) => answer(app, caller, Err(text)),
        };
    }
    let outcome = match name {
        "desk" => read::desk(app).await,
        "board_read" => read::board_read(app, caller, &args).await,
        "item_read" => read::item_read(app, &args).await,
        "trace" => read::trace(app, &args).await,
        "search" => read::search(app, &args).await,
        "changes" => read::changes(app, &args).await,
        "item_view" => read::item_view(app, &args).await,
        "item_views" => read::item_views(app, &args).await,
        "item_create" | "app_create" | "app_run" | "item_edit" | "tasks" | "link" | "unlink"
        | "arrange" | "group_create" | "item_delete" => {
            match write::run(app, caller, name, params).await {
                Ok(boards::Step::Ask(result)) => return result,
                Ok(boards::Step::Done(out)) => Ok(out),
                Err(e) => Err(e),
            }
        }
        _ => Err(format!(
            "There is no tool '{name}'. The tools: {}.",
            TOOL_NAMES.join(", ")
        )),
    };
    answer(app, caller, outcome)
}

/// A tool's outcome as a `tools/call` result, with the agent shown on the
/// board it touched.
fn answer(app: &AppState, caller: &Caller, outcome: Result<Out, String>) -> Value {
    match outcome {
        Ok(out) => {
            if let Some((board, item, verb)) = &out.touched {
                tracing::Span::current().record("board", tracing::field::display(board));
                app.rooms.agent_seen(
                    board,
                    caller.presence_id(),
                    &caller.agent,
                    &caller.user.display_name,
                    item.as_deref(),
                    verb,
                );
            }
            let mut content = vec![json!({ "type": "text", "text": out.text })];
            if let Some((mime, data)) = out.image {
                content.push(json!({ "type": "image", "mimeType": mime, "data": data }));
            }
            // Text only. A client that finds `structuredContent` may show the
            // model that instead of the text (Claude Code does), and these
            // facts are already in the text. `out.structured` stays internal
            // (a retried request's stored answer) until a tool declares an
            // output schema the structure fully meets.
            json!({ "content": content, "isError": false })
        }
        Err(text) => json!({ "content": [{ "type": "text", "text": text }], "isError": true }),
    }
}

// --- what the agent is told ----------------------------------------------------------

const TOOL_NAMES: [&str; 18] = [
    "desk",
    "board_read",
    "item_read",
    "trace",
    "search",
    "changes",
    "item_view",
    "item_views",
    "item_create",
    "app_create",
    "app_run",
    "item_edit",
    "tasks",
    "link",
    "unlink",
    "arrange",
    "group_create",
    "item_delete",
];

pub const INSTRUCTIONS: &str = "Visarium is a shared desk of boards. A board holds notes (Markdown), diagrams (Mermaid or PlantUML source), checklists and images, and typed links between them. People work on the same boards live and see what you do.

Read in layers: desk lists boards; board_read gives a board's overview; item_read gives one item in full; trace follows one item or diagram element to everything linked to it. search finds text across boards. changes says what happened since a revision.

Refs: every item has a short ref on its board — n (note), d (diagram), c (checklist), i (image), g (group or frame) and a number, e.g. d2. An element inside a diagram is d2#Server (the node, participant or class name). A task is c1/t3, and a link can end at one.

Links have a type and a direction. A link from A to B of type `describes` means A describes B; `comments` means A comments on B; `implements` means A implements B; `depends-on` means A depends on B. Point a note at what it explains, a checklist at what it builds.

Decisions and questions: a note whose source has a `Status:` line just under its title, or `status:` in frontmatter, is a decision (proposed, accepted, rejected, deprecated, superseded) or a question (open, answered). Reads show it as [decision · accepted]. Agents propose; your person decides: write a new decision as proposed and leave a question open. Changing or deleting an accepted decision, or settling any status, needs your person's confirmation.

Writing: say where, never coordinates — item_create(near: \"d1\") or (in: \"g2\"), and the server places it. Edit source with item_edit, passing the base_rev you read; it refuses a stale edit. Every write tells you what it changed, including links it broke. Pass request_id on writes so a retry after a timeout does not apply twice. Your changes are credited to you and your person, and everyone on the board sees them as they land.

Apps (when your person's board uses them): an app (ref a1) is a self-contained HTML document that runs sandboxed on the board, with no network. It reads only what feeds it — link(type: \"feeds\") from an item, with the view it reads and optionally one field path and an input name — plus its own literals, and publishes outputs that other apps can read; link an app to a checklist with `updates` to let its runs set tasks. Apps run automatically about a second after what they read changes, unless set to manual; app_run runs one now. item_read shows an app's inventory (inputs, outputs, who ran it) and, with source: true, its HTML as data. Edit an app with item_edit: title, source (old and new), literals, run.
- Declare inputs in the source as <script type=\"application/json\" id=\"visarium-inputs\">[{ \"name\": \"age\", \"description\": \"…\" }]</script>; the board lists what is not yet connected.
- Keep an app's own data in one <script type=\"application/json\" id=\"data\"> block, so a quick edit lands in one place.
- Do not wait on requestAnimationFrame for a result: an app runs in a hidden view when nobody shows it, where browsers pause it. Draw and publish from the message handler or a timer.

These tools are your whole interface to Visarium. Do not drive the web or desktop app, or call its HTTP API, to do what a tool does not. When a task needs something no tool offers, tell your person which capability is missing instead of working around it.

Board management (board_create, board_rename, board_duplicate, board_delete) appears only when your person has turned on *Manage boards* for you; deleting a board also asks them to confirm.

The visarium://guide resource has an example call for every tool.";

/// The instructions, with a line about image descriptions while they are on.
fn instructions(app: &AppState) -> String {
    format!(
        "{INSTRUCTIONS}{}",
        crate::vision::instructions_line(app).unwrap_or_default()
    )
}

fn tools(manage_boards: bool) -> Value {
    let board = json!({ "type": "string", "description": "The board's exact name, or its id." });
    let r = |d: &str| json!({ "type": "string", "description": d });
    let read_only = json!({ "readOnlyHint": true, "openWorldHint": false });
    let request_id = json!({ "type": "string", "description": "Optional. Any unique string; a repeat with the same request_id returns the first result instead of applying again." });
    let placement = |schema: &mut Value| {
        for (k, d) in [
            ("near", "Put it beside this item or frame (a ref)."),
            ("below", "Put it below this item or frame (a ref)."),
            (
                "right_of",
                "Put it to the right of this item or frame (a ref).",
            ),
            (
                "in",
                "Put it inside this group or frame (g ref), as a member.",
            ),
        ] {
            schema["properties"][k] = json!({ "type": "string", "description": d });
        }
    };
    let mut create = json!({
        "type": "object",
        "properties": {
            "board": board, "kind": { "type": "string", "enum": ["note", "diagram", "checklist", "image"] },
            "url": r("For an image: an http or https URL to fetch it from (public addresses only). PNG, JPEG, GIF (animated too), WebP, TIFF or BMP."),
            "data": r("For an image, instead of url: the file's bytes as base64, at most 8 MB."),
            "filename": r("For an image from data: its file name, shown in the library."),
            "source": r("For a note: Markdown. For a diagram: Mermaid or PlantUML source (PlantUML between @startuml and @enduml)."),
            "lang": { "type": "string", "enum": ["mermaid", "plantuml"], "description": "For a diagram." },
            "title": r("For a checklist."),
            "tasks": { "type": "array", "items": { "type": "string" }, "description": "For a checklist: task texts, in order." },
            "link": { "type": "object", "description": "Optional link from the new item, e.g. { \"type\": \"describes\", \"to\": \"d1#OpQueue\" }.",
                "properties": { "type": { "type": "string", "enum": ["describes", "comments", "implements", "depends-on", "feeds", "updates"] }, "to": r("A ref or element ref."), "view": r("For feeds into an app: the view of the new item it reads, e.g. frontmatter.") },
                "required": ["type", "to"] },
            "collides": { "type": "boolean", "description": "Optional, default true: the board moves the item aside when something lands on it. False fixes it in place." },
            "request_id": request_id,
        },
        "required": ["board", "kind"],
    });
    let mut app_create = json!({
        "type": "object",
        "properties": {
            "board": board, "title": r("The app's title, shown on its card."),
            "html": r("The whole HTML document, at most 256 KiB, starting with <!doctype html>. It speaks the MCP Apps bridge; scripts and styles inline, no network. Visarium dresses it in its app kit, themed to the board: plain HTML (headings, p, dl readouts, tables, buttons, inputs, select, range, progress) already looks right, so write semantic HTML and add few or no styles of your own. Kit classes: .figure (the key number), .unit, .label, .muted, .num, .row/.stack/.grid, .badge with .is-good/.is-pending/.is-bad, .notice, .empty, .field, .bars (li style=\"--v:0.6\", .is-key), tables (th, td.num, caption, tfoot), svg.chart with .line/.area/.axis/.grid/.mark. Charts: give each series' marks .series-1 to .series-6 (the board's chart palette, in that order, the same series always the same number; a seventh folds into \"Other\") and name them in a ul.legend of li.series-N with a span.swatch; text stays in ink. Declare inputs in <script type=\"application/json\" id=\"visarium-inputs\">, keep the app's own data in <script type=\"application/json\" id=\"data\">, and never wait on requestAnimationFrame for a result (hidden views pause it)."),
            "run": { "type": "string", "enum": ["auto", "manual"], "description": "auto (default): runs about a second after what it reads changes. manual: runs only when asked." },
            "literals": { "type": "object", "description": "Optional named values the app reads with no link, e.g. { \"rate\": 0.05 }." },
            "link": { "type": "object", "description": "Optional link from the new app, e.g. { \"type\": \"updates\", \"to\": \"c1\" }.",
                "properties": { "type": { "type": "string", "enum": ["describes", "comments", "implements", "depends-on", "feeds", "updates"] }, "to": r("A ref."), "view": r("For feeds: outputs.") },
                "required": ["type", "to"] },
            "request_id": request_id,
        },
        "required": ["board", "title", "html"],
    });
    placement(&mut app_create);
    placement(&mut create);
    let layout = |schema: &mut Value| {
        schema["properties"]["layout"] = json!({ "type": "string", "enum": ["row", "column", "grid"], "description": "Line the items up in reading order, as one block." });
        schema["properties"]["columns"] = json!({ "type": "integer", "description": "For a grid: how many across (default: about square)." });
        schema["properties"]["gap"] = json!({ "type": "number", "description": "Space between items in a layout, default 24." });
    };
    let mut arrange = json!({
        "type": "object",
        "properties": {
            "board": board, "refs": { "type": "array", "items": { "type": "string" }, "description": "Items to move, e.g. [\"n3\", \"n4\"]." },
            "out_of_group": { "type": "boolean", "description": "Take the items out of their group (they stay where they are)." },
            "collides": { "type": "boolean", "description": "Turn collision on (the board moves them aside when something lands on them) or off (they never move)." },
            "centerpiece": { "type": "string", "description": "Make one item or group the board's centerpiece, e.g. \"g1\": people open the board framed on it. An empty string clears it. With this, refs may be omitted." },
            "request_id": request_id,
        },
        "required": ["board"],
    });
    placement(&mut arrange);
    layout(&mut arrange);
    let mut group_create = json!({
        "type": "object",
        "properties": {
            "board": board, "refs": { "type": "array", "items": { "type": "string" }, "description": "Items to group, e.g. [\"i1\", \"i2\", \"n4\"]. Items in another group move to this one." },
            "title": r("Optional: the group's title."),
            "frame": { "type": "boolean", "description": "Draw a frame around the group, default true." },
            "collides": { "type": "boolean", "description": "Optional, default true: the board moves the group aside, as one, when something lands on it." },
            "request_id": request_id,
        },
        "required": ["board", "refs"],
    });
    for k in ["near", "below", "right_of"] {
        let mut one = json!({ "properties": {} });
        placement(&mut one);
        group_create["properties"][k] = one["properties"][k].clone();
    }
    layout(&mut group_create);
    let mut tools = json!([
        { "name": "desk", "title": "List boards",
          "description": "Every board on the desk, most recently changed first: what it holds, open and blocked tasks, and its last change. Start here when you do not know the board's name.",
          "inputSchema": { "type": "object", "properties": {} }, "annotations": read_only },
        { "name": "board_read", "title": "Read a board's overview",
          "description": "A board as a table of contents in Markdown: frames and groups as sections, one line per item (ref, kind, title, size, links in and out), checklist progress, broken links, the revision and the last change. No source; read items with item_read. Pass focus: \"g3\" to list one frame in full when the overview says it was cut short.",
          "inputSchema": { "type": "object", "properties": { "board": board, "focus": r("Optional: a group ref to list in full.") }, "required": ["board"] }, "annotations": read_only },
        { "name": "item_read", "title": "Read one item",
          "description": "One item in full: a note's or diagram's numbered source (100 lines at a time; pass offset for more), a diagram's elements, edges and the links on each element, a checklist's tasks with their state and who changed them, an image's text description and visible text when the server has a vision model, an app's inventory (each input with where it comes from, inputs it declares that nothing supplies, its run mode, its latest outputs and who ran them, what it feeds and updates; its HTML only with source: true), and the item's revision (pass it to item_edit as base_rev). A note's status (decision or question) is on the first line; an accepted decision ends with how to treat it.",
          "inputSchema": { "type": "object", "properties": { "board": board, "ref": r("e.g. d2, n4, c1."), "offset": { "type": "integer", "description": "First line to show, 0-based." }, "source": { "type": "boolean", "description": "For an app: also show its HTML source, as data." } }, "required": ["board", "ref"] }, "annotations": read_only },
        { "name": "trace", "title": "Follow an item or element",
          "description": "Everything around one thing. For a diagram element (d1#OpQueue): its edges in the diagram, what links to it, and name matches elsewhere (the same name in another diagram, a note or a task — matches, not links). For an item: every link in and out, with the item at the other end. Linked decisions and open questions come first, with their status.",
          "inputSchema": { "type": "object", "properties": { "board": board, "ref": r("An item ref (c1) or element ref (d1#OpQueue).") }, "required": ["board", "ref"] }, "annotations": read_only },
        { "name": "search", "title": "Search text",
          "description": "Finds words in notes, diagram sources (so element names), checklist titles and task texts, across every board or one. Returns refs with a snippet. Plain words, all of which must match.",
          "inputSchema": { "type": "object", "properties": { "query": r("Words to find, e.g. \"IndexedDB schema\"."), "board": r("Optional: one board."), "kind": { "type": "string", "enum": ["note", "diagram", "checklist", "image"] } }, "required": ["query"] }, "annotations": read_only },
        { "name": "changes", "title": "What changed since a revision",
          "description": "What happened on a board after since_rev, oldest first, as short sentences naming who did what to which ref. Use it to catch up instead of re-reading the board.",
          "inputSchema": { "type": "object", "properties": { "board": board, "since_rev": { "type": "integer", "description": "The revision you last saw (board_read shows it)." } }, "required": ["board", "since_rev"] }, "annotations": read_only },
        { "name": "item_view", "title": "Look at an image",
          "description": "An image item's pixels, as the board shows it (cropped if cropped), at about the width you ask for, after its text description when the server has one. Only images: read everything else with item_read.",
          "inputSchema": { "type": "object", "properties": { "board": board, "ref": r("An image ref, e.g. i1."), "width": { "type": "integer", "description": "Pixels wide, default 1024." } }, "required": ["board", "ref"] }, "annotations": read_only },
        { "name": "item_views", "title": "Read an item as data",
          "description": "An item as structured data rather than source: a note's text, markdown, frontmatter (an object) or tables (rows keyed by their headers); a diagram's text or graph (elements and edges); a checklist's text or tasks; an image's text (its description) or asset (type, size, URL); a group's members. Without view, lists the views the item offers. Each answer carries the revision it was derived from.",
          "inputSchema": { "type": "object", "properties": { "board": board, "ref": r("An item or group ref, e.g. n3 or g2."), "view": r("Optional: e.g. frontmatter, tables, graph, tasks, members.") }, "required": ["board", "ref"] }, "annotations": read_only },
        { "name": "item_create", "title": "Add a note, diagram, checklist or image",
          "description": "Adds an item, placed by the server next to (near, below, right_of) or inside (in) something you name, optionally with a link from it, all in one step. Example: a note that explains a node — kind \"note\", source \"…\", near \"d1\", link { type \"describes\", to \"d1#OpQueue\" }. Returns the new ref.",
          "inputSchema": create, "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false } },
        { "name": "app_create", "title": "Add an app",
          "description": "Adds an app: a self-contained HTML document that runs in a sandboxed view on the board, reads the items that feed it and publishes outputs. Placed like item_create, optionally with a link from it (e.g. { type \"updates\", to \"c1\" }). Connect its inputs afterwards with link(type: \"feeds\", view: …). Returns the new ref.",
          "inputSchema": app_create, "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false } },
        { "name": "app_run", "title": "Run an app",
          "description": "Runs an app on what feeds it now and waits up to 30 seconds for its outputs. An app runs in the client of a person who has the board open with canvas apps on, on screen or hidden: when nobody does, the result is needs_viewer and nothing changes. An app already up to date returns its current output without running. Its output and any tasks it sets are credited to you for your person.",
          "inputSchema": { "type": "object", "properties": { "board": board, "ref": r("The app, e.g. a1."), "request_id": request_id }, "required": ["board", "ref"] },
          "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false } },
        { "name": "item_edit", "title": "Edit a note, diagram or app",
          "description": "Changes source, either by replacing one exact passage (old → new; old must occur exactly once) or with the whole new source. base_rev is the revision you read; if someone changed the item since, the edit is refused and you are told what changed. For diagrams the result lists elements added and removed and links broken or repaired. Changing an accepted decision, or moving a note's status anywhere but proposed or open, waits for your person's confirmation; when they cannot be asked, write a proposed decision that supersedes it instead. For an app: title, its HTML (old and new, or html with base_rev), literals (null clears one) and run, any of them in one call; base_rev is needed only with html.",
          "inputSchema": { "type": "object", "properties": {
              "board": board, "ref": r("A note, diagram or app ref."), "base_rev": { "type": "integer", "description": "The item revision item_read showed. For an app, only with html." },
              "old": r("An exact passage of the current source, occurring once."),
              "new": r("What replaces old (may be empty)."),
              "source": r("The whole new source, instead of old and new."),
              "title": r("For an app: a new title."),
              "html": r("For an app: the whole new HTML document, instead of old and new."),
              "literals": { "type": "object", "description": "For an app: literals to set; a null value clears that one." },
              "run": { "type": "string", "enum": ["auto", "manual"], "description": "For an app: its run mode." },
              "request_id": request_id },
            "required": ["board", "ref"] },
          "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false } },
        { "name": "tasks", "title": "Change a checklist",
          "description": "Several changes to one checklist at once, applied together: add tasks, set a task's state (todo, doing, done, blocked) or text, remove tasks, retitle. Each change touches only its own task, so people can work on the same list.",
          "inputSchema": { "type": "object", "properties": {
              "board": board, "ref": r("The checklist, e.g. c1."),
              "add": { "type": "array", "items": { "type": "object", "properties": { "text": { "type": "string" }, "state": { "type": "string", "enum": ["todo", "doing", "done", "blocked"] }, "after": { "type": "string", "description": "Insert after this task id (t3); default is at the end." } }, "required": ["text"] } },
              "set": { "type": "array", "items": { "type": "object", "properties": { "task": { "type": "string", "description": "t3 or c1/t3" }, "state": { "type": "string", "enum": ["todo", "doing", "done", "blocked"] }, "text": { "type": "string" } }, "required": ["task"] } },
              "remove": { "type": "array", "items": { "type": "string" }, "description": "Task ids to remove." },
              "title": r("A new title."), "request_id": request_id },
            "required": ["board", "ref"] },
          "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false } },
        { "name": "link", "title": "Link two things",
          "description": "A typed link from one ref to another; either end may be a diagram element (d1#OpQueue). from describes / comments on / implements / depends on to. Two link types carry data between whole items: from feeds an app (with view: the view of from it reads, e.g. frontmatter or outputs; optionally path, one field within it such as age or 0.rows, and name, the input name the app reads it under), and an app updates a checklist (its runs may set that checklist's tasks). A feeds link that would make an app read its own output is refused. If the two are already linked, the link's type is changed instead.",
          "inputSchema": { "type": "object", "properties": { "board": board, "from": r("e.g. n4"), "to": r("e.g. d3#RetryPolicy"),
              "type": { "type": "string", "enum": ["describes", "comments", "implements", "depends-on", "feeds", "updates"] },
              "view": r("For feeds: the view of from the app reads (item_views lists them)."),
              "path": r("For feeds, optional: one field within the view, dot-separated, e.g. age or 0.rows. Empty clears it."),
              "name": r("For feeds, optional: the input name the app reads it under, e.g. age. Empty clears it."),
              "request_id": request_id },
            "required": ["board", "from", "to", "type"] },
          "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false } },
        { "name": "unlink", "title": "Remove a link",
          "description": "Removes the link between two refs (both directions are checked).",
          "inputSchema": { "type": "object", "properties": { "board": board, "from": r("One end."), "to": r("The other end."), "request_id": request_id }, "required": ["board", "from", "to"] },
          "annotations": { "readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false } },
        { "name": "arrange", "title": "Move items",
          "description": "Moves items next to (near, below, right_of) or into (in) something else, without coordinates; lines them up as a row, column or grid (layout); turns their collision on or off; or takes them out of their group. Also sets the board's centerpiece, what people open it on. Items with links are placed to keep those links short. The result says where each went, how long its links are and what they cross, and what was moved aside.",
          "inputSchema": arrange, "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false } },
        { "name": "group_create", "title": "Group or frame items",
          "description": "Puts items into a new group, framed and titled if you like, packed together in reading order (a grid by default, or layout: row or column). The group then moves as one; anything it now covers is moved aside. Returns the group's ref.",
          "inputSchema": group_create, "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false } },
        { "name": "item_delete", "title": "Delete an item",
          "description": "Deletes an item and every link to or from it. The result includes the deleted content, so it can be recreated if asked. Prefer editing.",
          "inputSchema": { "type": "object", "properties": { "board": board, "ref": r("The item."), "request_id": request_id }, "required": ["board", "ref"] },
          "annotations": { "readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false } },
    ]);
    if manage_boards {
        let list = tools.as_array_mut().unwrap();
        list.extend([
            json!({ "name": "board_create", "title": "Create a board",
              "description": "A new, empty board with this title, owned by your person. Returns its id; name it by id if another board has the same title.",
              "inputSchema": { "type": "object", "properties": { "title": r("The new board's title."), "request_id": request_id }, "required": ["title"] },
              "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false } }),
            json!({ "name": "board_rename", "title": "Rename a board",
              "description": "Gives a board a new title. People on it see the change live.",
              "inputSchema": { "type": "object", "properties": { "board": board, "title": r("The new title.") }, "required": ["board", "title"] },
              "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false } }),
            json!({ "name": "board_duplicate", "title": "Duplicate a board",
              "description": "Copies a board, items, groups and links, into a new board owned by your person. Refs are kept: d2 in the copy is the copy of d2. Default title: \"<title> copy\".",
              "inputSchema": { "type": "object", "properties": { "board": board, "title": r("Optional: the copy's title."), "request_id": request_id }, "required": ["board"] },
              "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false } }),
            json!({ "name": "board_delete", "title": "Delete a board",
              "description": "Deletes a board for good, after your person confirms in your client; nothing is deleted without their yes. Only the board's owner, a moderator or an admin can delete it.",
              "inputSchema": { "type": "object", "properties": { "board": board }, "required": ["board"] },
              "annotations": { "readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false } }),
        ]);
    }
    tools
}

fn guide() -> String {
    format!(
        "# Working on a Visarium board\n\n{INSTRUCTIONS}\n\n## Example calls\n\n\
- desk {{}}\n\
- board_read {{ \"board\": \"Offline sync\" }}\n\
- board_read {{ \"board\": \"Offline sync\", \"focus\": \"g2\" }}\n\
- item_read {{ \"board\": \"Offline sync\", \"ref\": \"d2\" }}\n\
- trace {{ \"board\": \"Offline sync\", \"ref\": \"d1#OpQueue\" }}\n\
- search {{ \"query\": \"IndexedDB\" }}\n\
- changes {{ \"board\": \"Offline sync\", \"since_rev\": 412 }}\n\
- item_read {{ \"board\": \"Offline sync\", \"ref\": \"i1\" }} (an image: its description and visible text, when the server has a vision model)\n\
- item_view {{ \"board\": \"Offline sync\", \"ref\": \"i1\", \"width\": 1024 }}\n\
- item_views {{ \"board\": \"Offline sync\", \"ref\": \"n2\", \"view\": \"tables\" }}\n\
- item_create {{ \"board\": \"Offline sync\", \"kind\": \"note\", \"source\": \"OpQueue drains on reconnect.\", \"near\": \"d1\", \"link\": {{ \"type\": \"describes\", \"to\": \"d1#OpQueue\" }}, \"request_id\": \"note-opqueue-1\" }}\n\
- item_create {{ \"board\": \"Offline sync\", \"kind\": \"image\", \"url\": \"https://example.com/light.jpg\", \"near\": \"n2\", \"link\": {{ \"type\": \"comments\", \"to\": \"n2\" }} }}\n\
- item_create {{ \"board\": \"Offline sync\", \"kind\": \"checklist\", \"title\": \"Plan\", \"tasks\": [\"Spike\", \"Ship\"], \"below\": \"d2\", \"link\": {{ \"type\": \"implements\", \"to\": \"d2\" }} }}\n\
- item_edit {{ \"board\": \"Offline sync\", \"ref\": \"d3\", \"base_rev\": 4, \"old\": \"RetryLoop[\", \"new\": \"RetryPolicy[\" }}\n\
- tasks {{ \"board\": \"Offline sync\", \"ref\": \"c1\", \"set\": [{{ \"task\": \"t6\", \"state\": \"done\" }}], \"add\": [{{ \"text\": \"Write the runbook\" }}] }}\n\
- link {{ \"board\": \"Offline sync\", \"from\": \"n4\", \"to\": \"d3#RetryPolicy\", \"type\": \"describes\" }}\n\
- app_create {{ \"board\": \"Offline sync\", \"title\": \"Premium\", \"html\": \"<!doctype html>…\", \"near\": \"n3\", \"link\": {{ \"type\": \"updates\", \"to\": \"c1\" }} }}\n\
- app_create {{ \"board\": \"Offline sync\", \"title\": \"Rack A1\", \"html\": \"<!doctype html>… <script type=\\\"application/json\\\" id=\\\"data\\\">{{…}}</script> …\", \"right_of\": \"d1\", \"run\": \"manual\", \"literals\": {{ \"units\": 42 }} }}\n\
- link {{ \"board\": \"Offline sync\", \"from\": \"n3\", \"to\": \"a1\", \"type\": \"feeds\", \"view\": \"frontmatter\" }}\n\
- link {{ \"board\": \"Offline sync\", \"from\": \"n3\", \"to\": \"a1\", \"type\": \"feeds\", \"view\": \"frontmatter\", \"path\": \"age\", \"name\": \"age\" }}\n\
- app_run {{ \"board\": \"Offline sync\", \"ref\": \"a1\" }}\n\
- item_read {{ \"board\": \"Offline sync\", \"ref\": \"a1\", \"source\": true }}\n\
- item_edit {{ \"board\": \"Offline sync\", \"ref\": \"a1\", \"old\": \"Premuim\", \"new\": \"Premium\" }}\n\
- item_edit {{ \"board\": \"Offline sync\", \"ref\": \"a1\", \"literals\": {{ \"rate\": 0.05 }}, \"run\": \"manual\" }}\n\
- unlink {{ \"board\": \"Offline sync\", \"from\": \"n4\", \"to\": \"d3#Backoff\" }}\n\
- arrange {{ \"board\": \"Offline sync\", \"refs\": [\"n3\", \"n4\"], \"in\": \"g2\" }}\n\
- arrange {{ \"board\": \"Offline sync\", \"refs\": [\"i1\", \"i2\", \"i3\", \"i4\"], \"layout\": \"grid\", \"columns\": 2, \"below\": \"n1\" }}\n\
- arrange {{ \"board\": \"Offline sync\", \"refs\": [\"n3\"], \"collides\": false }}\n\
- arrange {{ \"board\": \"Offline sync\", \"centerpiece\": \"g1\" }}\n\
- group_create {{ \"board\": \"Offline sync\", \"refs\": [\"i1\", \"i2\", \"n4\"], \"title\": \"Moodboard\" }}\n\
- item_delete {{ \"board\": \"Offline sync\", \"ref\": \"n5\" }}\n\
- board_create {{ \"title\": \"Offline sync, v2\", \"request_id\": \"board-v2-1\" }}\n\
- board_rename {{ \"board\": \"Offline sync\", \"title\": \"Offline sync (archived)\" }}\n\
- board_duplicate {{ \"board\": \"Offline sync\", \"title\": \"Offline sync, experiment\" }}\n\
- board_delete {{ \"board\": \"Offline sync, experiment\" }}\n\n\
## When a tool is missing\n\n\
The tools are your whole interface. If a task needs something they cannot do, or cannot show you, stop and say so to your person, naming the gap. For example: \"I can't see whether people on the board saw my change: no tool reports what reached them.\" Do not open the app in a browser or call its HTTP API instead.\n\n\
Board management tools are listed only with the *Manage boards* grant (Settings → Agents). Without it, say that you need it rather than asking your person to make the board for you by hand.\n\n\
## Habits that work\n\n\
- Read the overview first, then only the items you need.\n\
- Keep the revision board_read shows; changes(since_rev) catches you up later.\n\
- When an edit breaks a link, the result says which: repair it with link, or tell your person.\n\
- Put notes beside what they explain and link them; put plans in checklists, not notes.\n\
- Create an item with its link in one call: the server places it to keep the link short.\n\
- Your items have collision on: when something grows into them or lands on them, the board moves them aside, and the result says so. Items people place have it off and never move. Items made before collision existed have it off too; arrange(collides: true) turns it on.\n\
- Write results and board_read describe layout in words — link lengths, crossings, overlaps — so you never need to look at the board.\n"
    )
}
