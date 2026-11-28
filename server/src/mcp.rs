//! MCP servers as a source for canvas apps (canvas/app-sources; openspec
//! canvas-apps-live design §10).
//!
//! A person adds a connection to a board: a Streamable HTTP URL, or on the
//! desktop a local stdio command. An app made from one shows the server's
//! `ui://` resource, pinned by hash, and, when it names a tool, runs on the
//! server with no view open: its inputs become the tool's arguments and the
//! tool's structured content its outputs.
//!
//! - A self-hosted server reaches only the hosts its operator lists in
//!   `VISARIUM_MCP_ALLOW`. Names are resolved first and the connection goes to
//!   those addresses only; a loopback, private or link-local one needs its IP
//!   listed. No redirects to another host.
//! - A connection's token stays in the database: no response, read or view
//!   carries it.
//! - Every call has 30 seconds and 10 MB.
//!
//! ponytail: one connection per call, closed after it. Pool them per
//! connection if a board's apps call one server often.

use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use axum::Json;
use axum::extract::{Path, State};
use rmcp::service::RunningService;
use rmcp::{RoleClient, ServiceExt};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::AppState;
use crate::apps::{AppBody, McpSource};
use crate::error::{ApiError, ApiResult};

/// How long one call to an MCP server may take, connecting included.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(30);
/// The most one response may hold.
pub const MAX_RESPONSE: usize = 10 * 1024 * 1024;

pub fn routes() -> axum::Router<AppState> {
    use axum::routing::{delete, get, post};
    axum::Router::new()
        .route("/boards/{id}/mcp", get(list).post(add))
        .route("/boards/{id}/mcp/{conn}", delete(remove))
        .route("/boards/{id}/mcp/{conn}/tools", get(tools_of))
        .route("/boards/{id}/mcp/{conn}/resource", post(pin))
        .route("/boards/{id}/items/{item}/mcp", post(proxy))
}

// --- where a connection may go ----------------------------------------------

/// No route to the instance itself, the machine it runs on, or its network.
fn is_private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            v.is_loopback()
                || v.is_private()
                || v.is_link_local()
                || v.is_unspecified()
                || v.is_broadcast()
                || v.octets()[0] == 100 && (v.octets()[1] & 0xc0) == 64 // 100.64/10, shared
        }
        IpAddr::V6(v) => {
            v.is_loopback()
                || v.is_unspecified()
                || (v.segments()[0] & 0xfe00) == 0xfc00 // unique local
                || (v.segments()[0] & 0xffc0) == 0xfe80 // link local
                || v.to_ipv4_mapped().is_some_and(|m| is_private(IpAddr::V4(m)))
        }
    }
}

/// Where `url` may be reached from this server: its host checked against the
/// operator's list, and the addresses it resolves to now, which the client
/// then uses and nothing else. Nothing is contacted when this fails.
pub async fn check_url(
    config: &crate::Config,
    url: &str,
) -> Result<(reqwest::Url, Vec<SocketAddr>), String> {
    let u = reqwest::Url::parse(url.trim()).map_err(|_| format!("'{url}' is not a URL"))?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return Err("an MCP server is reached over http or https".into());
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err("put credentials in the token, not the URL".into());
    }
    let host = u
        .host_str()
        .ok_or("the URL has no host")?
        .trim_matches(['[', ']'])
        .to_ascii_lowercase();
    let listed = |h: &str| config.mcp_allow.iter().any(|a| a == h);
    if !config.mcp_local && !listed(&host) {
        return Err(if config.mcp_allow.is_empty() {
            "this server connects to no MCP servers: its operator has set no VISARIUM_MCP_ALLOW"
                .into()
        } else {
            format!(
                "{host} is not among the MCP hosts this server may reach (VISARIUM_MCP_ALLOW: {})",
                config.mcp_allow.join(", ")
            )
        });
    }
    let port = u.port_or_known_default().unwrap_or(443);
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|e| format!("{host} does not resolve: {e}"))?
        .collect();
    if addrs.is_empty() {
        return Err(format!("{host} does not resolve"));
    }
    if !config.mcp_local
        && let Some(a) = addrs
            .iter()
            .find(|a| is_private(a.ip()) && !listed(&a.ip().to_string()))
    {
        return Err(format!(
            "{host} resolves to {}, a private address; list that address in VISARIUM_MCP_ALLOW to allow it",
            a.ip()
        ));
    }
    Ok((u, addrs))
}

// --- talking to one --------------------------------------------------------

/// A board's connection, token included: for this module's use only.
struct Conn {
    url: Option<String>,
    command: Option<String>,
    token: Option<String>,
}

async fn conn(db: &sqlx::SqlitePool, board: &str, id: &str) -> ApiResult<Conn> {
    let row: Option<(Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT url, command, token FROM mcp_connection WHERE id = ? AND canvas_id = ?",
    )
    .bind(id)
    .bind(board)
    .fetch_optional(db)
    .await?;
    let (url, command, token) =
        row.ok_or_else(|| ApiError::not_found(format!("no MCP connection {id} on this board")))?;
    Ok(Conn {
        url,
        command,
        token,
    })
}

type Client = RunningService<RoleClient, ()>;

async fn open(config: &crate::Config, c: &Conn) -> Result<Client, String> {
    use rmcp::transport::StreamableHttpClientTransport;
    use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
    if let Some(url) = &c.url {
        let (u, addrs) = check_url(config, url).await?;
        let host = u.host_str().unwrap_or_default().to_string();
        let same = host.clone();
        let http = reqwest::Client::builder()
            // The addresses just checked, not whatever the name says next.
            .resolve_to_addrs(&host, &addrs)
            .redirect(reqwest::redirect::Policy::custom(move |a| {
                if a.previous().len() < 5 && a.url().host_str() == Some(same.as_str()) {
                    a.follow()
                } else {
                    a.stop()
                }
            }))
            .timeout(CALL_TIMEOUT)
            .build()
            .map_err(|e| e.to_string())?;
        let mut cfg = StreamableHttpClientTransportConfig::with_uri(u.to_string());
        cfg.allow_stateless = true;
        cfg.auth_header = c.token.clone();
        cfg.max_json_response_size = MAX_RESPONSE;
        cfg.max_sse_event_size = MAX_RESPONSE;
        let transport = StreamableHttpClientTransport::with_client(http, cfg);
        return ().serve(transport).await.map_err(|e| e.to_string());
    }
    let command = c.command.as_deref().unwrap_or_default();
    if !config.mcp_local {
        return Err("local MCP servers run only in the desktop app".into());
    }
    // ponytail: words split on spaces, no quoting; a wrapper script covers the rest.
    let mut words = command.split_whitespace();
    let program = words.next().ok_or("the command is empty")?;
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(words);
    let transport =
        rmcp::transport::TokioChildProcess::new(cmd).map_err(|e| format!("{program}: {e}"))?;
    ().serve(transport).await.map_err(|e| e.to_string())
}

/// One request to a connection's server, within [`CALL_TIMEOUT`].
async fn call<T, F, Fut>(config: &crate::Config, c: &Conn, f: F) -> Result<T, String>
where
    F: FnOnce(Client) -> Fut,
    Fut: std::future::Future<Output = (Client, Result<T, String>)>,
{
    let work = async {
        let client = open(config, c).await?;
        let (client, out) = f(client).await;
        let _ = client.cancel().await;
        out
    };
    tokio::time::timeout(CALL_TIMEOUT, work)
        .await
        .unwrap_or_else(|_| Err(format!("no answer in {} s", CALL_TIMEOUT.as_secs())))
}

async fn list_tools(config: &crate::Config, c: &Conn) -> Result<Vec<Value>, String> {
    call(config, c, |client| async move {
        let r = client.list_all_tools().await.map_err(|e| e.to_string());
        let r = r.map(|tools| {
            tools
                .into_iter()
                .filter_map(|t| serde_json::to_value(t).ok())
                .collect()
        });
        (client, r)
    })
    .await
}

async fn call_tool(
    config: &crate::Config,
    c: &Conn,
    name: &str,
    arguments: Value,
) -> Result<Value, String> {
    let params = serde_json::from_value(json!({ "name": name, "arguments": arguments }))
        .map_err(|e| e.to_string())?;
    call(config, c, |client| async move {
        let r = client.call_tool(params).await.map_err(|e| e.to_string());
        (
            client,
            r.and_then(|r| serde_json::to_value(r).map_err(|e| e.to_string())),
        )
    })
    .await
}

async fn read_resource(config: &crate::Config, c: &Conn, uri: &str) -> Result<Value, String> {
    let params = serde_json::from_value(json!({ "uri": uri })).map_err(|e| e.to_string())?;
    call(config, c, |client| async move {
        let r = client
            .read_resource(params)
            .await
            .map_err(|e| e.to_string());
        (
            client,
            r.and_then(|r| serde_json::to_value(r).map_err(|e| e.to_string())),
        )
    })
    .await
}

/// The `ui://` resource a tool's view is, if it has one.
pub fn ui_of(tool: &Value) -> Option<&str> {
    let meta = &tool["_meta"];
    meta["ui"]["resourceUri"]
        .as_str()
        .or_else(|| meta["ui/resourceUri"].as_str())
}

/// Whether an app's view may call this tool: unless the tool says otherwise,
/// both the model and apps may.
pub fn app_visible(tool: &Value) -> bool {
    match tool["_meta"]["ui"]["visibility"].as_array() {
        Some(v) => v.iter().any(|x| x == "app"),
        None => true,
    }
}

fn bad_gateway(e: String) -> ApiError {
    ApiError::new(
        axum::http::StatusCode::BAD_GATEWAY,
        format!("the MCP server: {e}"),
    )
}

// --- the board's connections -------------------------------------------------

/// `GET /api/boards/{id}/mcp`: the board's connections, never their tokens.
async fn list(State(app): State<AppState>, Path(board): Path<Uuid>) -> ApiResult<Json<Value>> {
    type Row = (String, Option<String>, Option<String>, bool, String);
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT id, url, command, token IS NOT NULL, created_at FROM mcp_connection
          WHERE canvas_id = ? ORDER BY created_at",
    )
    .bind(board.to_string())
    .fetch_all(&app.db)
    .await?;
    Ok(Json(json!({
        "local": app.config.mcp_local,
        "connections": rows.into_iter().map(|(id, url, command, token, at)| json!({
            "id": id, "url": url, "command": command, "hasToken": token, "createdAt": at,
        })).collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize)]
struct NewConnection {
    url: Option<String>,
    command: Option<String>,
    token: Option<String>,
}

/// A tool as the add menu shows it.
fn tool_entry(t: &Value) -> Value {
    json!({
        "name": t["name"], "title": t["title"], "description": t["description"],
        "resourceUri": ui_of(t), "headless": ui_of(t).is_none(),
    })
}

/// `POST /api/boards/{id}/mcp`: adds a connection once its server answers,
/// with the tools it offers. A refused host is never contacted.
async fn add(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<crate::auth::User>,
    Path(board): Path<Uuid>,
    Json(new): Json<NewConnection>,
) -> ApiResult<Json<Value>> {
    let blank = |s: Option<String>| s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let (url, command, token) = (blank(new.url), blank(new.command), blank(new.token));
    let c = match (&url, &command) {
        (Some(u), None) => {
            check_url(&app.config, u)
                .await
                .map_err(ApiError::bad_request)?;
            Conn {
                url: url.clone(),
                command: None,
                token: token.clone(),
            }
        }
        (None, Some(_)) if app.config.mcp_local => Conn {
            url: None,
            command: command.clone(),
            token: None,
        },
        (None, Some(_)) => {
            return Err(ApiError::bad_request(
                "local MCP servers run only in the desktop app",
            ));
        }
        _ => {
            return Err(ApiError::bad_request(
                "an MCP connection is a url or, on the desktop, a command",
            ));
        }
    };
    if url.as_ref().is_some_and(|u| u.len() > 2000)
        || command.as_ref().is_some_and(|u| u.len() > 2000)
        || token.as_ref().is_some_and(|t| t.len() > 4000)
    {
        return Err(ApiError::bad_request("that is too long for a connection"));
    }
    let tools = list_tools(&app.config, &c).await.map_err(bad_gateway)?;
    let id = Uuid::now_v7().to_string();
    sqlx::query(
        "INSERT INTO mcp_connection (id, canvas_id, url, command, token, created_by) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(board.to_string())
    .bind(&c.url)
    .bind(&c.command)
    .bind(&c.token)
    .bind(&me.id)
    .execute(&app.db)
    .await?;
    Ok(Json(
        json!({ "id": id, "tools": tools.iter().map(tool_entry).collect::<Vec<_>>() }),
    ))
}

/// `DELETE /api/boards/{id}/mcp/{conn}`: apps made from it keep their pinned
/// views and last outputs; their runs end `unavailable`.
async fn remove(
    State(app): State<AppState>,
    Path((board, c)): Path<(Uuid, String)>,
) -> ApiResult<axum::http::StatusCode> {
    sqlx::query("DELETE FROM mcp_connection WHERE id = ? AND canvas_id = ?")
        .bind(&c)
        .bind(board.to_string())
        .execute(&app.db)
        .await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

/// `GET /api/boards/{id}/mcp/{conn}/tools`.
async fn tools_of(
    State(app): State<AppState>,
    Path((board, c)): Path<(Uuid, String)>,
) -> ApiResult<Json<Value>> {
    let c = conn(&app.db, &board.to_string(), &c).await?;
    let tools = list_tools(&app.config, &c).await.map_err(bad_gateway)?;
    Ok(Json(
        json!({ "tools": tools.iter().map(tool_entry).collect::<Vec<_>>() }),
    ))
}

// --- views: fetched, pinned, served ------------------------------------------

/// The resource's HTML and its declared policy (`_meta.ui.csp`), pinned by
/// hash; the newest hash is also recorded for the connection, so apps on an
/// older one say an update is available.
pub async fn fetch(app: &AppState, board: &str, connection: &str, uri: &str) -> ApiResult<String> {
    let c = conn(&app.db, board, connection).await?;
    let r = read_resource(&app.config, &c, uri)
        .await
        .map_err(bad_gateway)?;
    let first = &r["contents"][0];
    let html = first["text"]
        .as_str()
        .ok_or_else(|| bad_gateway(format!("{uri} has no HTML text")))?;
    if html.len() > MAX_RESPONSE {
        return Err(bad_gateway(format!("{uri} is over 10 MB")));
    }
    let csp = first["_meta"]["ui"]["csp"].clone();
    let csp = if csp.is_object() { csp } else { json!({}) };
    let sha = hex::encode(Sha256::digest(html.as_bytes()));
    sqlx::query("INSERT OR IGNORE INTO app_resource (sha256, html, csp) VALUES (?, ?, ?)")
        .bind(&sha)
        .bind(html)
        .bind(csp.to_string())
        .execute(&app.db)
        .await?;
    sqlx::query(
        "INSERT INTO mcp_resource_head (connection_id, uri, sha256) VALUES (?, ?, ?)
         ON CONFLICT (connection_id, uri) DO UPDATE SET sha256 = excluded.sha256",
    )
    .bind(connection)
    .bind(uri)
    .bind(&sha)
    .execute(&app.db)
    .await?;
    Ok(sha)
}

#[derive(Deserialize)]
struct Pin {
    uri: String,
}

/// `POST /api/boards/{id}/mcp/{conn}/resource`: fetches and pins a view, for
/// an app about to be made from it.
async fn pin(
    State(app): State<AppState>,
    Path((board, c)): Path<(Uuid, String)>,
    Json(p): Json<Pin>,
) -> ApiResult<Json<Value>> {
    if !p.uri.starts_with("ui://") {
        return Err(ApiError::bad_request("an app's view is a ui:// resource"));
    }
    let sha = fetch(&app, &board.to_string(), &c, &p.uri).await?;
    Ok(Json(json!({ "sha256": sha })))
}

/// The HTML and policy of an MCP app's pinned view.
pub async fn view_of(db: &sqlx::SqlitePool, m: &McpSource) -> Option<(String, Value)> {
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT html, csp FROM app_resource WHERE sha256 = ?")
            .bind(&m.sha256)
            .fetch_optional(db)
            .await
            .ok()
            .flatten();
    row.map(|(html, csp)| (html, serde_json::from_str(&csp).unwrap_or(json!({}))))
}

/// A newer hash of the app's resource than the one it pins, when one was seen.
pub async fn update_of(db: &sqlx::SqlitePool, m: &McpSource) -> Option<String> {
    sqlx::query_scalar::<_, String>(
        "SELECT sha256 FROM mcp_resource_head WHERE connection_id = ? AND uri = ?",
    )
    .bind(&m.connection)
    .bind(&m.resource_uri)
    .fetch_optional(db)
    .await
    .ok()
    .flatten()
    .filter(|h| *h != m.sha256)
}

/// An MCP app's source as people and agents see it: its server (never the
/// token), resource and tool, and a newer view when one was fetched.
pub async fn describe(db: &sqlx::SqlitePool, m: &McpSource) -> Value {
    let server: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("SELECT url, command FROM mcp_connection WHERE id = ?")
            .bind(&m.connection)
            .fetch_optional(db)
            .await
            .ok()
            .flatten();
    let server = server.and_then(|(u, c)| u.or(c));
    json!({
        "connection": m.connection, "server": server, "resourceUri": m.resource_uri,
        "tool": m.tool, "sha256": m.sha256, "updateAvailable": update_of(db, m).await,
    })
}

/// The view's policy: the app CSP, widened only by the domains its resource
/// declares (`connectDomains`, `resourceDomains`), each an http(s) origin.
pub fn view_csp(public_url: Option<&str>, declared: &Value) -> String {
    let list = |key: &str| -> String {
        declared[key]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter_map(crate::apps::origin_of)
            .collect::<Vec<_>>()
            .join(" ")
    };
    let (connect, resources) = (list("connectDomains"), list("resourceDomains"));
    let mut csp = crate::apps::app_csp(public_url);
    if !connect.is_empty() {
        csp = csp.replace("connect-src 'none'", &format!("connect-src {connect}"));
    }
    if !resources.is_empty() {
        for d in [
            "script-src 'self'",
            "style-src 'self'",
            "img-src 'self'",
            "font-src 'self'",
            "media-src 'self'",
        ] {
            csp = csp.replace(d, &format!("{d} {resources}"));
        }
    }
    csp
}

/// When a view mounts, its resource is fetched again in the background: a
/// different hash shows `update available` until a person applies it.
pub fn refresh(app: &AppState, board: &str, m: &McpSource) {
    let (app, board, m) = (app.clone(), board.to_string(), m.clone());
    tokio::spawn(async move {
        if let Err(e) = fetch(&app, &board, &m.connection, &m.resource_uri).await {
            tracing::debug!(error = %e.detail, "an MCP app's resource could not be fetched again");
        }
    });
}

// --- a view's requests -------------------------------------------------------

#[derive(Deserialize)]
struct ViewRequest {
    method: String,
    #[serde(default)]
    params: Value,
}

/// `POST /api/boards/{id}/items/{item}/mcp`: an MCP app's view calls a tool or
/// reads a resource on its own connection, and only tools visible to apps.
async fn proxy(
    State(app): State<AppState>,
    Path((board, item)): Path<(Uuid, Uuid)>,
    Json(r): Json<ViewRequest>,
) -> ApiResult<Json<Value>> {
    let body: Option<String> = sqlx::query_scalar(
        "SELECT body FROM canvas_item WHERE id = ? AND canvas_id = ? AND kind = 'app'",
    )
    .bind(item.to_string())
    .bind(board.to_string())
    .fetch_optional(&app.db)
    .await?;
    let m = AppBody::parse(body.as_deref())
        .mcp
        .ok_or_else(|| ApiError::not_found("not an MCP app"))?;
    let c = conn(&app.db, &board.to_string(), &m.connection).await?;
    match r.method.as_str() {
        "tools/call" => {
            let name = r.params["name"]
                .as_str()
                .ok_or_else(|| ApiError::bad_request("tools/call needs a name"))?;
            let tools = list_tools(&app.config, &c).await.map_err(bad_gateway)?;
            let visible = tools
                .iter()
                .find(|t| t["name"] == name)
                .is_some_and(app_visible);
            if !visible {
                return Err(ApiError::forbidden(format!(
                    "{name} is not a tool this app's view may call"
                )));
            }
            let args = r.params.get("arguments").cloned().unwrap_or(json!({}));
            Ok(Json(
                call_tool(&app.config, &c, name, args)
                    .await
                    .map_err(bad_gateway)?,
            ))
        }
        "resources/read" => {
            let uri = r.params["uri"]
                .as_str()
                .ok_or_else(|| ApiError::bad_request("resources/read needs a uri"))?;
            Ok(Json(
                read_resource(&app.config, &c, uri)
                    .await
                    .map_err(bad_gateway)?,
            ))
        }
        other => Err(ApiError::bad_request(format!(
            "an app's view may ask its server for tools/call and resources/read, not {other}"
        ))),
    }
}

// --- tool-backed runs ----------------------------------------------------------

/// The MCP source of a tool-backed app: one the server runs itself.
pub async fn tool_backed(db: &sqlx::SqlitePool, board: &Uuid, id: &Uuid) -> Option<McpSource> {
    let body: Option<String> = sqlx::query_scalar(
        "SELECT body FROM canvas_item WHERE id = ? AND canvas_id = ? AND kind = 'app'",
    )
    .bind(id.to_string())
    .bind(board.to_string())
    .fetch_optional(db)
    .await
    .ok()
    .flatten();
    AppBody::parse(body.as_deref())
        .mcp
        .filter(|m| m.tool.is_some())
}

/// Grants a tool-backed app's run to the server and starts it. `None` when
/// the app is not tool-backed: its run goes to a client as before.
pub async fn grant(
    app: &AppState,
    board: &Uuid,
    id: Uuid,
    credit: (String, Option<String>),
    auto: Option<(Value, u32)>,
    stamps: serde_json::Map<String, Value>,
) -> Option<crate::realtime::RunGrant> {
    let m = tool_backed(&app.db, board, &id).await?;
    let g = app
        .rooms
        .lease_server(board, id, credit.clone(), auto, stamps);
    if matches!(g, crate::realtime::RunGrant::Leased(_)) {
        let (app, board) = (app.clone(), *board);
        tokio::spawn(async move { run(app, board, id, m, credit).await });
    }
    Some(g)
}

async fn run(app: AppState, board: Uuid, id: Uuid, m: McpSource, credit: (String, Option<String>)) {
    let outcome = async {
        let title: String = sqlx::query_scalar("SELECT title FROM canvas WHERE id = ?")
            .bind(board.to_string())
            .fetch_one(&app.db)
            .await
            .map_err(|e| e.to_string())?;
        let b = crate::agent::board::BoardData::load(
            &app.db,
            &crate::agent::board::Board { id: board, title },
        )
        .await
        .map_err(|e| e.to_string())?;
        let item = b
            .items
            .iter()
            .find(|i| i.id == id.to_string())
            .ok_or("the app is gone")?;
        let values = crate::apps::inputs(&b, item)["values"].clone();
        let c = conn(&app.db, &board.to_string(), &m.connection)
            .await
            .map_err(|_| "unavailable: its connection was removed".to_string())?;
        call_tool(
            &app.config,
            &c,
            m.tool.as_deref().unwrap_or_default(),
            values,
        )
        .await
        .map_err(|e| format!("unavailable: {e}"))
    }
    .await;
    let (outputs, text, error) = match outcome {
        Ok(r) => {
            let text: Vec<&str> = r["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|c| c["text"].as_str())
                .collect();
            let text = text.join("\n");
            if r["isError"] == true {
                (
                    json!({}),
                    None,
                    Some(if text.is_empty() {
                        "the tool failed".into()
                    } else {
                        text
                    }),
                )
            } else {
                let outputs = r["structuredContent"].clone();
                let outputs = if outputs.is_object() {
                    outputs
                } else {
                    json!({})
                };
                (outputs, (!text.is_empty()).then_some(text), None)
            }
        }
        Err(e) => (json!({}), None, Some(e)),
    };
    let commit = |outputs: Value, text: Option<String>, error: Option<String>| {
        let app = app.clone();
        let credit = credit.clone();
        async move {
            let mut op: crate::boards::Op = serde_json::from_value(json!({
                "type": "app.output", "itemId": id, "outputs": outputs,
                "status": if error.is_some() { "error" } else { "ok" },
                "text": text, "error": error,
            }))
            .map_err(|e| ApiError::internal(e.to_string()))?;
            let actor = crate::boards::Actor {
                user_id: credit.0,
                agent: credit.1,
            };
            let at: String =
                sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT {}", crate::NOW)))
                    .fetch_one(&app.db)
                    .await?;
            op.stamp(&actor, &at);
            let mut ops = vec![op];
            crate::apps::check_runs(&app, &board, Some(crate::realtime::SERVER), &mut ops).await?;
            let (from, to) = crate::boards::apply(&app, &board, &mut ops, &actor).await?;
            // Everyone with the board open hears the output, its view included.
            app.rooms.announce(&board, None, from, to, &ops);
            crate::apps::end_runs(&app, &board, &ops);
            Ok::<_, ApiError>(())
        }
    };
    if let Err(e) = commit(outputs, text, error).await {
        // Outputs the board refuses (too large, not an object) are an error
        // run too, so the app does not wait for a run that never lands.
        if let Err(again) = commit(json!({}), None, Some(e.detail.to_string())).await {
            tracing::warn!(error = %again.detail, "a tool-backed app's run could not be committed");
            app.rooms.end_run(&board, id);
        }
    }
}
