//! Canvas apps (ADR-0034, canvas/apps): data links, durable outputs, and
//! whether an app's outputs still match its inputs.
//!
//! Outputs are durable and execution is not: a run ends in one `app.output`
//! operation, stamped here with the content revision of every item that feeds
//! the app. Staleness is never stored; [`status`] derives it from those stamps
//! and the board as it is now.

use std::collections::{HashMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Sqlite, Transaction};
use uuid::Uuid;

use crate::NOW;
use crate::boards::Anchor;
use crate::error::{ApiError, ApiResult};

/// An app item's `body` column.
#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppBody {
    pub title: String,
    pub html: String,
    /// Named values the app reads with no link (canvas/app-inspector).
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub literals: serde_json::Map<String, Value>,
    /// `manual`, or absent for `auto`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<String>,
    /// Count changes to the source, and to how the inputs are set up
    /// (literals, a `feeds` link's view, field or name). Outputs stamp both.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub source_rev: i64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub setup_rev: i64,
    /// Where its view (and, with a tool, its logic) comes from instead of
    /// `html`: an MCP server connection (canvas/app-sources).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp: Option<McpSource>,
}

/// An app's MCP source: the board's connection, the `ui://` resource its view
/// is, pinned by hash, and the tool that makes it tool-backed (run on the
/// server, with no view) when there is one.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpSource {
    pub connection: String,
    pub resource_uri: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    pub sha256: String,
}

/// An MCP source names a connection on this board and a resource it pinned.
pub async fn check_mcp(
    tx: &mut Transaction<'_, Sqlite>,
    board: &str,
    m: &McpSource,
) -> ApiResult<()> {
    let ok: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM mcp_connection WHERE id = ? AND canvas_id = ?)
            AND EXISTS (SELECT 1 FROM app_resource WHERE sha256 = ?)",
    )
    .bind(&m.connection)
    .bind(board)
    .bind(&m.sha256)
    .fetch_one(&mut **tx)
    .await?;
    if !ok {
        return Err(ApiError::bad_request(
            "an MCP app names a connection on its board and a resource fetched through it",
        ));
    }
    if m.tool
        .as_ref()
        .is_some_and(|t| t.is_empty() || t.len() > 200)
    {
        return Err(ApiError::bad_request("an MCP app's tool is a tool name"));
    }
    Ok(())
}

fn is_zero(n: &i64) -> bool {
    *n == 0
}

impl AppBody {
    pub fn parse(body: Option<&str>) -> Self {
        serde_json::from_str(body.unwrap_or_default()).unwrap_or_default()
    }
}

/// The stamps of an app's own source and input setup, beside its inputs' item ids.
pub const OWN_SOURCE: &str = "#source";
pub const OWN_SETUP: &str = "#setup";

const MAX_LITERAL: usize = 4 * 1024;

/// A whole HTML document: what an app's source must be.
pub fn check_html(html: &str) -> Result<(), String> {
    let head = html
        .trim_start()
        .get(..200)
        .unwrap_or(html.trim_start())
        .to_ascii_lowercase();
    if head.starts_with("<!doctype html") || head.starts_with("<html") {
        Ok(())
    } else {
        Err("an app's source must be a whole HTML document, starting with <!doctype html> or <html>".into())
    }
}

/// An input's name, as a link or a literal gives it.
pub fn check_input_name(name: &str) -> ApiResult<()> {
    let ok = (1..=64).contains(&name.len())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'));
    if ok {
        Ok(())
    } else {
        Err(ApiError::bad_request(format!(
            "an input name is 1-64 letters, digits, '_', '-' or '.'; '{name}' is not"
        )))
    }
}

/// A field within a view: keys and array indices joined by dots (`rows.0.age`).
pub fn check_path(path: &str) -> ApiResult<()> {
    let ok = path.len() <= 200
        && path.split('.').all(|k| {
            !k.is_empty()
                && k.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
        });
    if ok {
        Ok(())
    } else {
        Err(ApiError::bad_request(format!(
            "a field path is keys or indices joined by dots, like age or rows.0.total; '{path}' is not"
        )))
    }
}

/// An app's literals: valid names, each value at most 4 KiB of JSON.
pub fn check_literals(literals: &serde_json::Map<String, Value>) -> ApiResult<()> {
    for (k, v) in literals {
        check_input_name(k)?;
        if v.to_string().len() > MAX_LITERAL {
            return Err(ApiError::bad_request(format!(
                "a literal is at most {MAX_LITERAL} bytes of JSON; '{k}' is larger"
            )));
        }
    }
    Ok(())
}

/// The value at `path` within `value`, or None when the path names nothing.
pub fn at_path<'v>(value: &'v Value, path: &str) -> Option<&'v Value> {
    path.split('.').try_fold(value, |v, k| match v {
        Value::Object(m) => m.get(k),
        Value::Array(a) => k.parse::<usize>().ok().and_then(|i| a.get(i)),
        _ => None,
    })
}

/// Who ran an app and when, as the server stamped it.
pub struct Run<'a> {
    pub by: Option<&'a str>,
    pub by_agent: Option<&'a str>,
    pub at: Option<&'a str>,
    /// An automatic run's cause, as JSON.
    pub cause: Option<&'a str>,
}

const MAX_OUTPUTS: usize = 16 * 1024;
const MAX_TEXT: usize = 16 * 1024;
const MAX_ERROR: usize = 2000;

/// The link types that grant an app access (canvas/links).
pub fn is_data(link_type: &str) -> bool {
    link_type == "feeds" || link_type == "updates"
}

async fn kind_and_ref(
    tx: &mut Transaction<'_, Sqlite>,
    board: &str,
    item: &str,
) -> ApiResult<Option<(String, String)>> {
    let row: Option<(String, i64)> =
        sqlx::query_as("SELECT kind, ref_no FROM canvas_item WHERE id = ? AND canvas_id = ?")
            .bind(item)
            .bind(board)
            .fetch_optional(&mut **tx)
            .await?;
    Ok(row.map(|(kind, n)| {
        let r = format!("{}{n}", crate::boards::ref_letter(&kind));
        (kind, r)
    }))
}

async fn named(
    tx: &mut Transaction<'_, Sqlite>,
    board: &str,
    item: &str,
) -> ApiResult<(String, String)> {
    kind_and_ref(tx, board, item)
        .await?
        .ok_or_else(|| ApiError::bad_request(format!("no item {item} on this board")))
}

fn check_view(kind: &str, r: &str, view: &str) -> ApiResult<()> {
    let offers = crate::views::offered(kind);
    if offers.contains(&view) {
        Ok(())
    } else {
        Err(ApiError::bad_request(format!(
            "{r} is a {kind}; it has no '{view}' view. Its views: {}.",
            offers.join(", ")
        )))
    }
}

/// The ends and view of a new link, and for a data link, that it closes no
/// loop: an app never reads, directly or through other apps, what it produces.
pub async fn check_link(
    tx: &mut Transaction<'_, Sqlite>,
    board: &str,
    from: &Anchor,
    to: &Anchor,
    link_type: &str,
    view: Option<&str>,
    carries: (Option<&str>, Option<&str>),
) -> ApiResult<()> {
    let (path, name) = carries;
    if link_type != "feeds" && (path.is_some() || name.is_some()) {
        return Err(ApiError::bad_request(
            "only a feeds link carries a field or an input name",
        ));
    }
    path.map(check_path).transpose()?;
    name.map(check_input_name).transpose()?;
    if !is_data(link_type) {
        if view.is_some() {
            return Err(ApiError::bad_request("only a feeds link carries a view"));
        }
        return Ok(());
    }
    if from.element.is_some() || to.element.is_some() {
        return Err(ApiError::bad_request(format!(
            "a {link_type} link joins whole items, not elements"
        )));
    }
    let (from_id, to_id) = (from.item_id.to_string(), to.item_id.to_string());
    let (from_kind, from_ref) = named(tx, board, &from_id).await?;
    let (to_kind, to_ref) = named(tx, board, &to_id).await?;
    if link_type == "feeds" {
        if to_kind != "app" {
            return Err(ApiError::bad_request(format!(
                "a feeds link ends at an app; {to_ref} is a {to_kind}"
            )));
        }
        let view =
            view.ok_or_else(|| ApiError::bad_request("a feeds link needs the view it carries"))?;
        check_view(&from_kind, &from_ref, view)?;
        if from_kind == "app"
            && let Some(path) = feeds_path(tx, board, &to_id, &from_id).await?
        {
            let mut names = Vec::new();
            for id in path.iter().chain(std::iter::once(&to_id)) {
                names.push(named(tx, board, id).await?.1);
            }
            return Err(ApiError::bad_request(format!(
                "this link would make an app read its own output: {}",
                names.join(" → ")
            )));
        }
        if linked(tx, board, &to_id, &from_id, "updates").await? {
            return Err(ApiError::bad_request(format!(
                "{to_ref} updates {from_ref}, so {from_ref} cannot also feed it"
            )));
        }
    } else {
        if view.is_some() {
            return Err(ApiError::bad_request("only a feeds link carries a view"));
        }
        if from_kind != "app" || to_kind != "checklist" {
            return Err(ApiError::bad_request(format!(
                "an updates link runs from an app to a checklist; this one runs from a {from_kind} to a {to_kind}"
            )));
        }
        if linked(tx, board, &to_id, &from_id, "feeds").await? {
            return Err(ApiError::bad_request(format!(
                "{to_ref} feeds {from_ref}, so {from_ref} cannot also update it"
            )));
        }
    }
    Ok(())
}

async fn linked(
    tx: &mut Transaction<'_, Sqlite>,
    board: &str,
    from: &str,
    to: &str,
    link_type: &str,
) -> ApiResult<bool> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM canvas_link WHERE canvas_id = ? AND from_item = ? AND to_item = ? AND link_type = ?)",
    )
    .bind(board)
    .bind(from)
    .bind(to)
    .bind(link_type)
    .fetch_one(&mut **tx)
    .await?)
}

/// The items along existing `feeds` links from `start` to `goal`, both
/// included, when there is such a path.
async fn feeds_path(
    tx: &mut Transaction<'_, Sqlite>,
    board: &str,
    start: &str,
    goal: &str,
) -> ApiResult<Option<Vec<String>>> {
    let edges: Vec<(String, String)> = sqlx::query_as(
        "SELECT from_item, to_item FROM canvas_link WHERE canvas_id = ? AND link_type = 'feeds'",
    )
    .bind(board)
    .fetch_all(&mut **tx)
    .await?;
    Ok(path(&edges, start, goal))
}

fn path(edges: &[(String, String)], start: &str, goal: &str) -> Option<Vec<String>> {
    let mut came_from: HashMap<&str, &str> = HashMap::new();
    let mut queue = VecDeque::from([start]);
    let mut seen = HashSet::from([start]);
    while let Some(at) = queue.pop_front() {
        if at == goal {
            let mut out = vec![goal.to_string()];
            let mut cur = goal;
            while let Some(prev) = came_from.get(cur) {
                out.push(prev.to_string());
                cur = prev;
            }
            out.reverse();
            return Some(out);
        }
        for (from, to) in edges.iter().filter(|(f, _)| f == at) {
            if seen.insert(to) {
                came_from.insert(to, from);
                queue.push_back(to);
            }
        }
    }
    None
}

/// `link.set` keeps a link semantic or data: a type change across that line
/// would grant or revoke access silently. A view may change on `feeds` only.
pub async fn check_link_set(
    tx: &mut Transaction<'_, Sqlite>,
    board: &str,
    link: &Uuid,
    link_type: &str,
    view: Option<&str>,
    carries: (Option<&str>, Option<&str>),
) -> ApiResult<()> {
    let (path, name) = carries;
    if link_type != "feeds" && (path.is_some() || name.is_some()) {
        return Err(ApiError::bad_request(
            "only a feeds link carries a field or an input name",
        ));
    }
    path.filter(|p| !p.is_empty()).map(check_path).transpose()?;
    name.filter(|n| !n.is_empty())
        .map(check_input_name)
        .transpose()?;
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT link_type, from_item FROM canvas_link WHERE id = ? AND canvas_id = ?",
    )
    .bind(link.to_string())
    .bind(board)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((current, from)) = row else {
        return Ok(());
    };
    if (is_data(&current) || is_data(link_type)) && current != link_type {
        return Err(ApiError::bad_request(format!(
            "a {current} link cannot become a {link_type} link; delete it and draw a new one"
        )));
    }
    if let Some(v) = view {
        if link_type != "feeds" {
            return Err(ApiError::bad_request("only a feeds link carries a view"));
        }
        let (kind, r) = named(tx, board, &from).await?;
        check_view(&kind, &r, v)?;
    }
    Ok(())
}

/// Changes a link's type, and a `feeds` link's view, field or input name. When
/// what a `feeds` link carries changed, the app it feeds is behind: its setup
/// counter moves.
#[allow(clippy::too_many_arguments)]
pub async fn set_link(
    tx: &mut Transaction<'_, Sqlite>,
    board: &str,
    link: &Uuid,
    link_type: &str,
    view: &Option<String>,
    path: &Option<String>,
    name: &Option<String>,
) -> ApiResult<()> {
    type Carried = (String, Option<String>, Option<String>, Option<String>);
    const CARRIED: &str =
        "SELECT to_item, view, path, name FROM canvas_link WHERE id = ? AND canvas_id = ?";
    let Some(before): Option<Carried> = sqlx::query_as(CARRIED)
        .bind(link.to_string())
        .bind(board)
        .fetch_optional(&mut **tx)
        .await?
    else {
        return Ok(());
    };
    sqlx::query(
        "UPDATE canvas_link SET link_type = ?1, view = coalesce(?2, view),
                path = CASE WHEN ?3 IS NULL THEN path ELSE nullif(?3, '') END,
                name = CASE WHEN ?4 IS NULL THEN name ELSE nullif(?4, '') END
          WHERE id = ?5 AND canvas_id = ?6",
    )
    .bind(link_type)
    .bind(view)
    .bind(path)
    .bind(name)
    .bind(link.to_string())
    .bind(board)
    .execute(&mut **tx)
    .await?;
    let after: Option<Carried> = sqlx::query_as(CARRIED)
        .bind(link.to_string())
        .bind(board)
        .fetch_optional(&mut **tx)
        .await?;
    if link_type == "feeds" && after.as_ref() != Some(&before) {
        let app = before.0;
        let body: Option<String> =
            sqlx::query_scalar("SELECT body FROM canvas_item WHERE id = ? AND canvas_id = ?")
                .bind(&app)
                .bind(board)
                .fetch_one(&mut **tx)
                .await?;
        let mut b = AppBody::parse(body.as_deref());
        b.setup_rev += 1;
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "UPDATE canvas_item SET body = ?, revision = revision + 1, updated_at = {NOW} WHERE id = ? AND canvas_id = ?"
        )))
        .bind(serde_json::to_string(&b).unwrap())
        .bind(&app)
        .bind(board)
        .execute(&mut **tx)
        .await?;
        check_names(tx, board, &app).await?;
    }
    Ok(())
}

/// No two inputs of an app share a name, between its links and its literals.
pub async fn check_names(
    tx: &mut Transaction<'_, Sqlite>,
    board: &str,
    app: &str,
) -> ApiResult<()> {
    let links: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT from_item, view, name FROM canvas_link WHERE canvas_id = ? AND to_item = ? AND link_type = 'feeds'",
    )
    .bind(board)
    .bind(app)
    .fetch_all(&mut **tx)
    .await?;
    let body: Option<Option<String>> =
        sqlx::query_scalar("SELECT body FROM canvas_item WHERE id = ? AND canvas_id = ?")
            .bind(app)
            .bind(board)
            .fetch_optional(&mut **tx)
            .await?;
    let mut seen: HashMap<String, String> = HashMap::new();
    for (from, view, name) in links {
        let r = named(tx, board, &from).await?.1;
        let n = name.unwrap_or_else(|| format!("{r}.{}", view.unwrap_or_default()));
        if let Some(other) = seen.insert(n.clone(), format!("the link from {r}")) {
            return Err(ApiError::bad_request(format!(
                "this app already has an input named '{n}' ({other}); give one of them another name"
            )));
        }
    }
    for k in AppBody::parse(body.flatten().as_deref()).literals.keys() {
        if let Some(other) = seen.get(k) {
            return Err(ApiError::bad_request(format!(
                "this app already has an input named '{k}' ({other}); give the literal another name"
            )));
        }
    }
    Ok(())
}

const MAX_CARD: usize = 64 * 1024;

/// Sets the card of an app's latest output. A card for an older version is
/// left out: a newer run is on its way to drawing its own.
pub async fn set_card(
    tx: &mut Transaction<'_, Sqlite>,
    board: &str,
    item: &Uuid,
    version: i64,
    html: &str,
) -> ApiResult<()> {
    if html.len() > MAX_CARD {
        return Err(ApiError::bad_request(format!(
            "an app's card is at most {MAX_CARD} bytes; this one is {}",
            html.len()
        )));
    }
    if !app_exists(tx, board, item).await? {
        return Ok(());
    }
    sqlx::query(
        "UPDATE app_output SET card = ?1 WHERE item_id = ?2 AND version = ?3
            AND version = (SELECT max(version) FROM app_output WHERE item_id = ?2)",
    )
    .bind(html)
    .bind(item.to_string())
    .bind(version)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn app_exists(tx: &mut Transaction<'_, Sqlite>, board: &str, item: &Uuid) -> ApiResult<bool> {
    let kind: Option<String> =
        sqlx::query_scalar("SELECT kind FROM canvas_item WHERE id = ? AND canvas_id = ?")
            .bind(item.to_string())
            .bind(board)
            .fetch_optional(&mut **tx)
            .await?;
    match kind.as_deref() {
        None => Ok(false),
        Some("app") => Ok(true),
        Some(k) => Err(ApiError::bad_request(format!(
            "item {item} is a {k}; only an app has outputs"
        ))),
    }
}

#[allow(clippy::too_many_arguments)]
async fn insert_output(
    tx: &mut Transaction<'_, Sqlite>,
    board: &str,
    item: &Uuid,
    outputs: &str,
    text: Option<&str>,
    input_revs: &str,
    status: &str,
    error: Option<&str>,
    run: &Run<'_>,
) -> ApiResult<()> {
    let id = item.to_string();
    let last: Option<(String, Option<String>)> = sqlx::query_as(
        "SELECT outputs, text FROM app_output WHERE item_id = ? ORDER BY version DESC LIMIT 1",
    )
    .bind(&id)
    .fetch_optional(&mut **tx)
    .await?;
    let changed = last.as_ref().is_none_or(|(o, t)| {
        serde_json::from_str::<Value>(o).ok() != serde_json::from_str::<Value>(outputs).ok()
            || t.as_deref() != text
    });
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "INSERT INTO app_output (item_id, version, outputs, text, input_revs, status, error, run_by, run_by_agent, run_at, cause)
         VALUES (?1, (SELECT coalesce(max(version), 0) + 1 FROM app_output WHERE item_id = ?1), ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                 coalesce(?9, {NOW}), ?10)"
    )))
    .bind(&id)
    .bind(outputs)
    .bind(text)
    .bind(input_revs)
    .bind(status)
    .bind(error)
    .bind(run.by)
    .bind(run.by_agent)
    .bind(run.at)
    .bind(run.cause)
    .execute(&mut **tx)
    .await?;
    // When the values changed, what the app shows changed: anything they feed
    // is now behind. A failed run that kept the last values moves nothing.
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE canvas_item SET revision = revision + 1, content_rev = content_rev + ?, updated_at = {NOW}
          WHERE id = ? AND canvas_id = ?"
    )))
    .bind(i64::from(changed))
    .bind(&id)
    .bind(board)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Commits a run's outputs as the app's next version, stamped with the
/// content revision of everything that feeds it now.
#[allow(clippy::too_many_arguments)]
pub async fn commit_output(
    tx: &mut Transaction<'_, Sqlite>,
    board: &str,
    item: &Uuid,
    outputs: &serde_json::Map<String, Value>,
    text: Option<&str>,
    status: &str,
    error: Option<&str>,
    run: &Run<'_>,
) -> ApiResult<()> {
    if !app_exists(tx, board, item).await? {
        return Ok(());
    }
    if status != "ok" && status != "error" {
        return Err(ApiError::bad_request("an output's status is ok or error"));
    }
    let mut outputs = serde_json::to_string(outputs).unwrap();
    let mut text = text.map(str::to_string);
    // A failed run produced nothing: its version keeps the last values, so
    // they stay readable beside the error (canvas/apps).
    if status == "error" && outputs == "{}" {
        let last: Option<(String, Option<String>)> = sqlx::query_as(
            "SELECT outputs, text FROM app_output WHERE item_id = ? ORDER BY version DESC LIMIT 1",
        )
        .bind(item.to_string())
        .fetch_optional(&mut **tx)
        .await?;
        if let Some((o, t)) = last {
            outputs = o;
            text = text.or(t);
        }
    }
    let text = text.as_deref();
    if outputs.len() > MAX_OUTPUTS {
        return Err(ApiError::bad_request(format!(
            "an app's outputs are limited to {MAX_OUTPUTS} bytes of JSON; these are {}",
            outputs.len()
        )));
    }
    if text.is_some_and(|t| t.len() > MAX_TEXT) {
        return Err(ApiError::bad_request(format!(
            "an output's text is limited to {MAX_TEXT} bytes"
        )));
    }
    let error: Option<String> = error.map(|e| e.chars().take(MAX_ERROR).collect());
    let input_revs = Value::Object(input_stamps(tx, board, &item.to_string()).await?).to_string();
    insert_output(
        tx,
        board,
        item,
        &outputs,
        text,
        &input_revs,
        status,
        error.as_deref(),
        run,
    )
    .await
}

/// outputs, text, input_revs, status, error: one stored run.
type StoredRun = (String, Option<String>, String, String, Option<String>);

/// Commits an earlier version's values again as the next version, with the
/// input revisions they were computed from.
pub async fn revert_output(
    tx: &mut Transaction<'_, Sqlite>,
    board: &str,
    item: &Uuid,
    to_version: i64,
    run: &Run<'_>,
) -> ApiResult<()> {
    if !app_exists(tx, board, item).await? {
        return Ok(());
    }
    let row: Option<StoredRun> = sqlx::query_as(
        "SELECT outputs, text, input_revs, status, error FROM app_output WHERE item_id = ? AND version = ?",
    )
    .bind(item.to_string())
    .bind(to_version)
    .fetch_optional(&mut **tx)
    .await?;
    let (outputs, text, input_revs, status, error) = row.ok_or_else(|| {
        ApiError::bad_request(format!("app {item} has no output version {to_version}"))
    })?;
    insert_output(
        tx,
        board,
        item,
        &outputs,
        text.as_deref(),
        &input_revs,
        &status,
        error.as_deref(),
        run,
    )
    .await
}

/// An app's latest output.
#[derive(Clone, Debug, sqlx::FromRow)]
pub struct Output {
    pub item_id: String,
    pub version: i64,
    pub outputs: String,
    pub text: Option<String>,
    pub input_revs: String,
    pub status: String,
    pub error: Option<String>,
    pub run_by: Option<String>,
    pub run_by_agent: Option<String>,
    pub run_at: String,
    /// A snapshot of the view as it drew this version (canvas/apps).
    pub card: Option<String>,
    /// An automatic run's cause, as JSON: `{ auto, by, agent?, item? }`.
    pub cause: Option<String>,
}

impl Output {
    pub fn revs(&self) -> HashMap<String, i64> {
        serde_json::from_str(&self.input_revs).unwrap_or_default()
    }

    pub fn to_json(&self) -> Value {
        json!({
            "version": self.version,
            "outputs": serde_json::from_str::<Value>(&self.outputs).unwrap_or(json!({})),
            "text": self.text,
            "inputRevs": serde_json::from_str::<Value>(&self.input_revs).unwrap_or(json!({})),
            "status": self.status,
            "error": self.error,
            "by": self.run_by,
            "byAgent": self.run_by_agent,
            "at": self.run_at,
            "card": self.card,
            "cause": self.cause.as_deref().and_then(|c| serde_json::from_str::<Value>(c).ok()),
        })
    }
}

/// Every app's latest output on a board, by item id.
pub async fn latest_outputs(
    conn: &mut sqlx::SqliteConnection,
    board: &str,
) -> sqlx::Result<HashMap<String, Output>> {
    let rows: Vec<Output> = sqlx::query_as(
        "SELECT o.item_id, o.version, o.outputs, o.text, o.input_revs, o.status, o.error, o.run_by, o.run_by_agent, o.run_at,
                o.card, o.cause
           FROM app_output o JOIN canvas_item i ON i.id = o.item_id
          WHERE i.canvas_id = ?
            AND o.version = (SELECT max(version) FROM app_output WHERE item_id = o.item_id)",
    )
    .bind(board)
    .fetch_all(conn)
    .await?;
    Ok(rows.into_iter().map(|o| (o.item_id.clone(), o)).collect())
}

/// One input that moved since the output was computed: `was` is absent for an
/// input connected since, `now` for one disconnected since.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Moved {
    pub item: String,
    pub was: Option<i64>,
    pub now: Option<i64>,
}

/// Where an app's outputs stand (canvas/apps).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum State {
    NeverRun,
    Fresh,
    Stale(Vec<Moved>),
    Error(String),
    /// Fresh itself, but these apps feeding it are stale or never ran.
    UpstreamStale(Vec<String>),
    /// Fresh itself, but these apps feeding it failed.
    UpstreamError(Vec<String>),
}

impl State {
    pub fn behind(&self) -> bool {
        matches!(
            self,
            State::NeverRun | State::Stale(_) | State::UpstreamStale(_)
        )
    }
    fn failed(&self) -> bool {
        matches!(self, State::Error(_) | State::UpstreamError(_))
    }

    pub fn to_json(&self) -> Value {
        match self {
            State::NeverRun => json!({ "state": "never run" }),
            State::Fresh => json!({ "state": "fresh" }),
            State::Stale(moved) => {
                json!({ "state": "stale", "moved": moved.iter().map(|m| json!({ "itemId": m.item, "was": m.was, "now": m.now })).collect::<Vec<_>>() })
            }
            State::Error(e) => json!({ "state": "error", "error": e }),
            State::UpstreamStale(from) => json!({ "state": "upstream stale", "from": from }),
            State::UpstreamError(from) => json!({ "state": "upstream error", "from": from }),
        }
    }
}

/// Every app's source and setup counters, by item id, from their bodies.
pub fn own_revs<'a>(
    apps: impl IntoIterator<Item = (&'a str, Option<&'a str>)>,
) -> HashMap<&'a str, (i64, i64)> {
    apps.into_iter()
        .map(|(id, body)| {
            let b = AppBody::parse(body);
            (id, (b.source_rev, b.setup_rev))
        })
        .collect()
}

/// Every app's state, from every app on the board, each item's content
/// revision, each app's own source and setup counters, the `feeds` links
/// (from, to) and the latest outputs. Pure: the same board always gives the
/// same answer.
pub fn status(
    apps: &[&str],
    content_rev: &HashMap<&str, i64>,
    own: &HashMap<&str, (i64, i64)>,
    feeds: &[(&str, &str)],
    outputs: &HashMap<String, Output>,
) -> HashMap<String, State> {
    let mut done: HashMap<String, State> = HashMap::new();
    let all: HashSet<&str> = apps.iter().copied().collect();
    for app in apps {
        state_of(
            app,
            &all,
            &Board {
                content_rev,
                own,
                feeds,
                outputs,
            },
            &mut done,
            &mut HashSet::new(),
        );
    }
    done
}

/// What [`status`] reads, in one place.
struct Board<'b, 'a> {
    content_rev: &'b HashMap<&'a str, i64>,
    own: &'b HashMap<&'a str, (i64, i64)>,
    feeds: &'b [(&'a str, &'a str)],
    outputs: &'b HashMap<String, Output>,
}

fn state_of(
    app: &str,
    apps: &HashSet<&str>,
    b: &Board,
    done: &mut HashMap<String, State>,
    visiting: &mut HashSet<String>,
) -> State {
    let (content_rev, feeds, outputs) = (b.content_rev, b.feeds, b.outputs);
    if let Some(s) = done.get(app) {
        return s.clone();
    }
    // Links refuse cycles; a corrupted board still must not recurse forever.
    if !visiting.insert(app.to_string()) {
        return State::Fresh;
    }
    let sources: Vec<&str> = feeds
        .iter()
        .filter(|(_, to)| *to == app)
        .map(|(f, _)| *f)
        .collect();
    let state = match outputs.get(app) {
        None => State::NeverRun,
        Some(out) => {
            let revs = out.revs();
            let mut moved: Vec<Moved> = sources
                .iter()
                .filter_map(|s| {
                    let now = content_rev.get(s).copied();
                    let was = revs.get(*s).copied();
                    (was != now).then(|| Moved {
                        item: s.to_string(),
                        was,
                        now,
                    })
                })
                .collect();
            let mut gone: Vec<&String> = revs
                .keys()
                .filter(|k| !k.starts_with('#') && !sources.contains(&k.as_str()))
                .collect();
            gone.sort();
            moved.extend(gone.into_iter().map(|k| Moved {
                item: k.clone(),
                was: revs.get(k).copied(),
                now: None,
            }));
            // Its own source and setup. An output stamped before they were
            // counted has neither, and matches.
            let (source, setup) = b.own.get(app).copied().unwrap_or_default();
            for (k, now) in [(OWN_SOURCE, source), (OWN_SETUP, setup)] {
                if let Some(was) = revs.get(k).copied().filter(|w| *w != now) {
                    moved.push(Moved {
                        item: k.into(),
                        was: Some(was),
                        now: Some(now),
                    });
                }
            }
            if !moved.is_empty() {
                State::Stale(moved)
            } else if out.status == "error" {
                State::Error(out.error.clone().unwrap_or_default())
            } else {
                let (mut failed, mut behind) = (Vec::new(), Vec::new());
                for s in sources.iter().filter(|s| apps.contains(**s)) {
                    let up = state_of(s, apps, b, done, visiting);
                    if up.failed() {
                        failed.push(s.to_string());
                    } else if up.behind() {
                        behind.push(s.to_string());
                    }
                }
                if !failed.is_empty() {
                    State::UpstreamError(failed)
                } else if !behind.is_empty() {
                    State::UpstreamStale(behind)
                } else {
                    State::Fresh
                }
            }
        }
    };
    visiting.remove(app);
    done.insert(app.to_string(), state.clone());
    state
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_kit_goes_first_in_the_head_and_carries_only_colours() {
        let theme = KitTheme {
            theme: Some("light".into()),
            tokens: HashMap::from([
                ("ink".into(), "oklch(0.24 0.008 265)".into()),
                ("series-3".into(), "oklch(0.6 0.13 170)".into()),
                (
                    "surface".into(),
                    "red}</style><script>alert(1)</script>".into(),
                ),
                ("not-a-token".into(), "#fff".into()),
            ]),
        };
        let head = kit_head(Some(&theme));
        assert!(
            head.contains(r#"<meta name="color-scheme" content="light">"#),
            "{head}"
        );
        assert!(head.contains("--vk-ink:oklch(0.24 0.008 265);"), "{head}");
        assert!(
            head.contains("--vk-series-3:oklch(0.6 0.13 170);"),
            "{head}"
        );
        assert!(
            !head.contains("alert") && !head.contains("not-a-token"),
            "{head}"
        );
        assert!(kit_head(None).contains(r#"content="dark""#));

        let page = with_kit(
            "<!doctype html><HTML><Head><title>x</title><style>p{}</style>",
            "KIT",
        );
        assert_eq!(
            page,
            "<!doctype html><HTML><Head>KIT<title>x</title><style>p{}</style>"
        );
        assert_eq!(
            with_kit("<!doctype html><html lang=\"en\"><p>x", "KIT"),
            "<!doctype html><html lang=\"en\">KIT<p>x"
        );
        assert_eq!(with_kit("<p>bare</p>", "KIT"), "KIT<p>bare</p>");
        assert_eq!(
            with_kit("<header>h</header>", "KIT"),
            "KIT<header>h</header>"
        );
    }

    fn out(app: &str, revs: Value, status: &str) -> Output {
        Output {
            item_id: app.into(),
            version: 1,
            outputs: "{}".into(),
            text: None,
            input_revs: revs.to_string(),
            status: status.into(),
            error: (status == "error").then(|| "boom".into()),
            run_by: None,
            run_by_agent: None,
            run_at: "now".into(),
            card: None,
            cause: None,
        }
    }

    #[test]
    fn an_edit_makes_an_app_stale_and_its_dependents_upstream_stale() {
        let revs = HashMap::from([("n3", 9), ("a1", 4), ("a2", 2)]);
        let feeds = [("n3", "a1"), ("a1", "a2")];
        let outputs = HashMap::from([
            ("a1".to_string(), out("a1", json!({ "n3": 7 }), "ok")),
            ("a2".to_string(), out("a2", json!({ "a1": 4 }), "ok")),
        ]);
        let s = status(&["a1", "a2"], &revs, &HashMap::new(), &feeds, &outputs);
        assert_eq!(
            s["a1"],
            State::Stale(vec![Moved {
                item: "n3".into(),
                was: Some(7),
                now: Some(9)
            }])
        );
        assert_eq!(s["a2"], State::UpstreamStale(vec!["a1".into()]));
    }

    #[test]
    fn matching_inputs_are_fresh_and_a_missing_output_never_ran() {
        let revs = HashMap::from([("n3", 7)]);
        let feeds = [("n3", "a1"), ("n3", "a2")];
        let outputs = HashMap::from([("a1".to_string(), out("a1", json!({ "n3": 7 }), "ok"))]);
        let s = status(&["a1", "a2"], &revs, &HashMap::new(), &feeds, &outputs);
        assert_eq!(s["a1"], State::Fresh);
        assert_eq!(s["a2"], State::NeverRun);
    }

    #[test]
    fn a_new_or_removed_feed_makes_an_app_stale() {
        let revs = HashMap::from([("n3", 7), ("n4", 1)]);
        let outputs = HashMap::from([("a1".to_string(), out("a1", json!({ "n3": 7 }), "ok"))]);
        let added = status(
            &["a1"],
            &revs,
            &HashMap::new(),
            &[("n3", "a1"), ("n4", "a1")],
            &outputs,
        );
        assert_eq!(
            added["a1"],
            State::Stale(vec![Moved {
                item: "n4".into(),
                was: None,
                now: Some(1)
            }])
        );
        let removed = status(&["a1"], &revs, &HashMap::new(), &[], &outputs);
        assert_eq!(
            removed["a1"],
            State::Stale(vec![Moved {
                item: "n3".into(),
                was: Some(7),
                now: None
            }])
        );
    }

    #[test]
    fn errors_show_on_the_app_and_downstream() {
        let revs = HashMap::from([("n3", 7), ("a1", 2)]);
        let feeds = [("n3", "a1"), ("a1", "a2")];
        let outputs = HashMap::from([
            ("a1".to_string(), out("a1", json!({ "n3": 7 }), "error")),
            ("a2".to_string(), out("a2", json!({ "a1": 2 }), "ok")),
        ]);
        let s = status(&["a1", "a2"], &revs, &HashMap::new(), &feeds, &outputs);
        assert_eq!(s["a1"], State::Error("boom".into()));
        assert_eq!(s["a2"], State::UpstreamError(vec!["a1".into()]));
    }

    #[test]
    fn its_own_source_and_setup_count_and_an_older_output_matches() {
        let revs = HashMap::from([("n3", 7)]);
        let feeds = [("n3", "a1")];
        let own = HashMap::from([("a1", (2, 1))]);
        // Stamped before the counters existed: matches whatever they are now.
        let old = HashMap::from([("a1".to_string(), out("a1", json!({ "n3": 7 }), "ok"))]);
        assert_eq!(
            status(&["a1"], &revs, &own, &feeds, &old)["a1"],
            State::Fresh
        );
        let stamped = HashMap::from([(
            "a1".to_string(),
            out("a1", json!({ "n3": 7, "#source": 1, "#setup": 1 }), "ok"),
        )]);
        assert_eq!(
            status(&["a1"], &revs, &own, &feeds, &stamped)["a1"],
            State::Stale(vec![Moved {
                item: OWN_SOURCE.into(),
                was: Some(1),
                now: Some(2)
            }])
        );
        let was = json!({ "n3": 7 }).as_object().unwrap().clone();
        let now = json!({ "n3": 7, "#source": 2, "#setup": 1 })
            .as_object()
            .unwrap()
            .clone();
        assert!(same_inputs(&was, &now));
        assert!(!same_inputs(
            &now,
            &json!({ "n3": 8, "#source": 2, "#setup": 1 })
                .as_object()
                .unwrap()
                .clone()
        ));
        assert!(!same_inputs(
            &json!({ "n3": 7, "n4": 1 }).as_object().unwrap().clone(),
            &now
        ));
    }

    #[test]
    fn a_sandbox_hostname_is_an_origin_of_its_own() {
        let public = Some("https://board.example.net/");
        assert_eq!(
            check_apps_origin("https://Apps.example.net", public),
            Ok("https://apps.example.net".into())
        );
        assert!(check_apps_origin("https://apps.example.net/", public).is_ok());
        for bad in [
            "apps.example.net",
            "https://apps.example.net/x",
            "ftp://apps.example.net",
        ] {
            assert!(
                check_apps_origin(bad, public)
                    .unwrap_err()
                    .contains("no path"),
                "{bad}"
            );
        }
        assert!(
            check_apps_origin("https://board.example.net", public)
                .unwrap_err()
                .contains("must differ")
        );
        assert!(
            check_apps_origin("https://apps.example.net", None)
                .unwrap_err()
                .contains("needs VISARIUM_PUBLIC_URL")
        );
        assert!(app_csp(public).ends_with(
            "frame-ancestors http://127.0.0.1:* http://localhost:* https://board.example.net"
        ));
        assert!(app_csp(None).ends_with("http://localhost:*"));
    }

    #[test]
    fn a_path_names_a_field_or_nothing() {
        let v = json!({ "age": 40, "rows": [{ "total": 3 }] });
        assert_eq!(at_path(&v, "age"), Some(&json!(40)));
        assert_eq!(at_path(&v, "rows.0.total"), Some(&json!(3)));
        assert_eq!(at_path(&v, "rows.1.total"), None);
        assert_eq!(at_path(&v, "age.x"), None);
        assert!(check_path("rows.0.total").is_ok());
        assert!(check_path("a..b").is_err() && check_path("").is_err());
        assert!(check_input_name("n3.frontmatter").is_ok() && check_input_name("a b").is_err());
        assert!(check_html("<!DOCTYPE html><p>").is_ok() && check_html("<p>").is_err());
    }

    #[test]
    fn a_path_is_found_and_named_in_order() {
        let e = |a: &str, b: &str| (a.to_string(), b.to_string());
        let edges = [e("a1", "a2"), e("a2", "a3")];
        assert_eq!(
            path(&edges, "a1", "a3"),
            Some(vec!["a1".into(), "a2".into(), "a3".into()])
        );
        assert_eq!(path(&edges, "a3", "a1"), None);
    }
}

// --- the sandbox origin (canvas/apps, design §6) -----------------------------

/// How long a view may be (re)loaded with one mount token.
const MOUNT_TTL: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// What a view's iframe may do. Scripts and styles inline only, no network, no
/// nested frames, no forms. Framed from loopback pages (the desktop: the
/// library's port can change while it runs) and from the instance's public
/// URL when it has one (a self-hosted sandbox hostname). A token is still
/// needed to load anything.
pub fn app_csp(public_url: Option<&str>) -> String {
    let public = public_url.and_then(origin_of).unwrap_or_default();
    format!(
        "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; \
img-src 'self' data:; font-src 'self'; media-src 'self' data:; connect-src 'none'; frame-src 'none'; \
object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors http://127.0.0.1:* http://localhost:* {public}"
    )
    .trim_end()
    .to_string()
}

/// A URL's origin, `scheme://host[:port]` in lower case, when it is an http(s)
/// URL with no more than a path.
pub fn origin_of(url: &str) -> Option<String> {
    let url = url.trim();
    let (scheme, rest) = url.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let host = rest.split(['/', '?', '#']).next()?.to_ascii_lowercase();
    if host.is_empty() || host.contains('@') {
        return None;
    }
    Some(format!("{scheme}://{host}"))
}

/// A self-hosted sandbox hostname (`VISARIUM_APPS_ORIGIN`), as the server
/// serves views from it: an http(s) origin and nothing more, beside a public
/// URL it differs from. App views on the board's own origin could reach the
/// board's cookies and pages, which the second origin exists to prevent.
pub fn check_apps_origin(apps_origin: &str, public_url: Option<&str>) -> Result<String, String> {
    let origin = origin_of(apps_origin)
        .filter(|o| apps_origin.trim().trim_end_matches('/').eq_ignore_ascii_case(o))
        .ok_or_else(|| {
            format!("VISARIUM_APPS_ORIGIN must be an origin like https://apps.example.net, with no path; it is '{apps_origin}'")
        })?;
    let public = public_url.and_then(origin_of).ok_or(
        "VISARIUM_APPS_ORIGIN needs VISARIUM_PUBLIC_URL: app views are framed only from the board's own address",
    )?;
    if origin == public {
        return Err(format!(
            "VISARIUM_APPS_ORIGIN must differ from VISARIUM_PUBLIC_URL ({public}): app views run on an origin of their own"
        ));
    }
    Ok(origin)
}

struct Mount {
    board: String,
    item: String,
    until: std::time::Instant,
    /// What goes at the top of the view's `<head>`: the kit, themed.
    kit: String,
}

/// Grants to load one app's view: a random token, good for [`MOUNT_TTL`],
/// issued only to someone who can open the board. The sandbox origin has no
/// session and reads no cookie, so the token is the whole of its access.
#[derive(Default)]
pub struct Mounts(std::sync::Mutex<HashMap<String, Mount>>);

impl Mounts {
    pub fn issue(&self, board: &str, item: &str) -> String {
        self.issue_with(board, item, kit_head(None))
    }

    fn issue_with(&self, board: &str, item: &str, kit: String) -> String {
        let token = crate::auth::random_token();
        let now = std::time::Instant::now();
        let mut all = self.0.lock().unwrap();
        all.retain(|_, m| m.until > now);
        all.insert(
            token.clone(),
            Mount {
                board: board.into(),
                item: item.into(),
                until: now + MOUNT_TTL,
                kit,
            },
        );
        token
    }

    fn get(&self, token: &str) -> Option<(String, String, String)> {
        let all = self.0.lock().unwrap();
        all.get(token)
            .filter(|m| m.until > std::time::Instant::now())
            .map(|m| (m.board.clone(), m.item.clone(), m.kit.clone()))
    }
}

/// The app kit (`/kit.css`): what every view is dressed in (canvas/apps).
pub const APP_KIT: &str = include_str!("app_kit.css");
/// The kit's script (`/kit.js`): sends the board a snapshot of the view when
/// it settles, for the app's card (canvas/apps).
pub const APP_KIT_JS: &str = include_str!("app_kit.js");

/// The board's look, as the person's client has it when it opens a view: the
/// resolved theme and its colour tokens. The kit chooses no colour; these do.
#[derive(Deserialize, Default)]
pub struct KitTheme {
    #[serde(default)]
    theme: Option<String>,
    #[serde(default)]
    tokens: HashMap<String, String>,
}

/// The tokens the kit reads, as `--vk-<name>`.
const KIT_TOKENS: [&str; 16] = [
    "surface",
    "raised",
    "sunken",
    "line",
    "line-strong",
    "ink",
    "ink-dim",
    "ink-disabled",
    "accent",
    "accent-wash",
    "series-1",
    "series-2",
    "series-3",
    "series-4",
    "series-5",
    "series-6",
];

/// What the view's `<head>` starts with: its colour scheme, the board's tokens
/// and the kit. A token value is a colour and nothing else; one that is not
/// (anything that could close the style element) is left out, and the kit
/// falls back to the platform's colours for it.
fn kit_head(theme: Option<&KitTheme>) -> String {
    let scheme = match theme.and_then(|t| t.theme.as_deref()) {
        Some("light") => "light",
        _ => "dark",
    };
    let colour = |v: &str| {
        !v.is_empty()
            && v.len() <= 64
            && v.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b" .%()/,#-".contains(&b))
    };
    let vars: String = theme
        .map(|t| {
            KIT_TOKENS
                .iter()
                .filter_map(|n| {
                    t.tokens
                        .get(*n)
                        .filter(|v| colour(v))
                        .map(|v| format!("--vk-{n}:{v};"))
                })
                .collect()
        })
        .unwrap_or_default();
    format!(
        "<meta name=\"color-scheme\" content=\"{scheme}\"><style data-visarium-kit>:root{{{vars}}}</style><link rel=\"stylesheet\" href=\"/kit.css\"><script src=\"/kit.js\"></script>"
    )
}

/// The app's HTML with the kit at the top of its `<head>`, so the app's own
/// styles come after it and win.
fn with_kit(html: &str, kit: &str) -> String {
    let lower = html.to_ascii_lowercase();
    // The tag itself, not a longer one that starts the same (`<header>`).
    let after = |tag: &str| {
        lower
            .match_indices(tag)
            .map(|(at, _)| at)
            .find(|at| {
                matches!(
                    lower.as_bytes().get(at + tag.len()),
                    Some(b'>' | b' ' | b'\t' | b'\n' | b'\r')
                )
            })
            .and_then(|at| lower[at..].find('>').map(|end| at + end + 1))
    };
    match after("<head").or_else(|| after("<html")) {
        Some(at) => format!("{}{kit}{}", &html[..at], &html[at..]),
        None => format!("{kit}{html}"),
    }
}

/// `POST /api/boards/{id}/items/{item}/mount`: where to load this app's view
/// from, for a person who can open the board.
pub async fn mount(
    axum::extract::State(app): axum::extract::State<crate::AppState>,
    axum::extract::Path((board, item)): axum::extract::Path<(Uuid, Uuid)>,
    body: axum::body::Bytes,
) -> ApiResult<axum::Json<Value>> {
    // The board's look is optional: absent, null or unreadable, the kit uses its defaults.
    let theme = serde_json::from_slice::<Option<KitTheme>>(&body)
        .ok()
        .flatten();
    let origin = app.config.apps_origin.as_deref().ok_or_else(|| {
        ApiError::not_found(
            "apps need a sandbox origin to run, and this server has none: open the board in the desktop app, or ask its operator to set VISARIUM_APPS_ORIGIN",
        )
    })?;
    let body: Option<Option<String>> = sqlx::query_scalar(
        "SELECT body FROM canvas_item WHERE id = ? AND canvas_id = ? AND kind = 'app'",
    )
    .bind(item.to_string())
    .bind(board.to_string())
    .fetch_optional(&app.db)
    .await?;
    let Some(body) = body else {
        return Err(ApiError::not_found(format!(
            "no app {item} on board {board}"
        )));
    };
    // An MCP app's resource is fetched again: a new one is offered as an update.
    if let Some(m) = AppBody::parse(body.as_deref()).mcp {
        crate::mcp::refresh(&app, &board.to_string(), &m);
    }
    let token = app.mounts.issue_with(
        &board.to_string(),
        &item.to_string(),
        kit_head(theme.as_ref()),
    );
    Ok(axum::Json(
        json!({ "url": format!("{origin}/app/{token}"), "origin": origin }),
    ))
}

/// The sandbox origin's whole surface: one app's HTML per mount token, with
/// the app CSP. No session layer, no cookies, nothing else.
pub fn sandbox_router(state: crate::AppState) -> axum::Router {
    axum::Router::new()
        .route("/app/{token}", axum::routing::get(serve_app))
        .route("/kit.css", axum::routing::get(serve_kit))
        .route("/kit.js", axum::routing::get(serve_kit_js))
        .fallback(|| async { (axum::http::StatusCode::NOT_FOUND, "not found") })
        .with_state(state)
}

async fn serve_app(
    axum::extract::State(app): axum::extract::State<crate::AppState>,
    axum::extract::Path(token): axum::extract::Path<String>,
) -> axum::response::Response {
    use axum::http::{StatusCode, header};
    use axum::response::IntoResponse;
    let Some((board, item, kit)) = app.mounts.get(&token) else {
        return (StatusCode::NOT_FOUND, "no such view").into_response();
    };
    let body: Option<String> = sqlx::query_scalar(
        "SELECT body FROM canvas_item WHERE id = ? AND canvas_id = ? AND kind = 'app'",
    )
    .bind(&item)
    .bind(&board)
    .fetch_optional(&app.db)
    .await
    .ok()
    .flatten();
    let Some(body) = body.and_then(|b| serde_json::from_str::<AppBody>(&b).ok()) else {
        return (StatusCode::NOT_FOUND, "no such view").into_response();
    };
    let public = app.config.public_url.as_deref();
    // An MCP app shows its pinned resource, under the policy it declares.
    let (html, csp) = match &body.mcp {
        None => (body.html, app_csp(public)),
        Some(m) => match crate::mcp::view_of(&app.db, m).await {
            Some((html, declared)) => (html, crate::mcp::view_csp(public, &declared)),
            None => return (StatusCode::NOT_FOUND, "no such view").into_response(),
        },
    };
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CONTENT_SECURITY_POLICY, csp.as_str()),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::CACHE_CONTROL, "no-store"),
            (header::REFERRER_POLICY, "no-referrer"),
        ],
        with_kit(&html, &kit),
    )
        .into_response()
}

async fn serve_kit_js() -> axum::response::Response {
    use axum::http::header;
    use axum::response::IntoResponse;
    (
        [
            (header::CONTENT_TYPE, "text/javascript; charset=utf-8"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        APP_KIT_JS,
    )
        .into_response()
}

pub async fn serve_kit() -> axum::response::Response {
    use axum::http::header;
    use axum::response::IntoResponse;
    (
        [
            (header::CONTENT_TYPE, "text/css; charset=utf-8"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        APP_KIT,
    )
        .into_response()
}

/// Writes what an applied `app.output` or `app.output.revert` stored onto the
/// operation itself, so the log, the author's response and every peer carry
/// the version, input revisions and content revision the server chose.
pub async fn record(tx: &mut Transaction<'_, Sqlite>, op: &mut crate::boards::Op) -> ApiResult<()> {
    use crate::boards::Op;
    let (item, slot) = match op {
        Op::AppOutput {
            item_id, record, ..
        }
        | Op::AppOutputRevert {
            item_id, record, ..
        } => (item_id.to_string(), record),
        _ => return Ok(()),
    };
    let row: Option<Output> = sqlx::query_as(
        "SELECT item_id, version, outputs, text, input_revs, status, error, run_by, run_by_agent, run_at, card, cause
           FROM app_output WHERE item_id = ? ORDER BY version DESC LIMIT 1",
    )
    .bind(&item)
    .fetch_optional(&mut **tx)
    .await?;
    let content_rev: Option<i64> =
        sqlx::query_scalar("SELECT content_rev FROM canvas_item WHERE id = ?")
            .bind(&item)
            .fetch_optional(&mut **tx)
            .await?;
    *slot = row.zip(content_rev).map(|(o, rev)| {
        let mut v = o.to_json();
        v["contentRev"] = json!(rev);
        v
    });
    Ok(())
}

// --- inputs (canvas/apps, canvas/app-inspector) ------------------------------

/// An input an app's source says it expects (canvas/app-inspector).
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Declared {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<Value>,
}

/// The inputs an app declares in its source, in a
/// `<script type="application/json" id="visarium-inputs">` element: a JSON
/// array of `{ name, description?, schema? }`. Read, never run; anything
/// unreadable declares nothing.
pub fn declared(html: &str) -> Vec<Declared> {
    let lower = html.to_ascii_lowercase();
    let Some(at) = ["id=\"visarium-inputs\"", "id='visarium-inputs'"]
        .iter()
        .find_map(|needle| lower.find(needle))
    else {
        return vec![];
    };
    let (Some(open), Some(close)) = (lower[..at].rfind("<script"), lower[at..].find('>')) else {
        return vec![];
    };
    let start = at + close + 1;
    let Some(end) = lower[start..].find("</script") else {
        return vec![];
    };
    if lower[open..at].contains('>') {
        return vec![];
    }
    let mut found: Vec<Declared> =
        serde_json::from_str(&html[start..start + end]).unwrap_or_default();
    found.retain(|d| check_input_name(&d.name).is_ok());
    found
}

/// The field paths a picker offers within a view's value: keys and the first
/// few indices, three levels deep, at most 50.
fn fields(v: &Value, prefix: &str, depth: usize, out: &mut Vec<String>) {
    if depth == 0 {
        return;
    }
    let children: Vec<(String, &Value)> = match v {
        Value::Object(m) => m.iter().map(|(k, x)| (k.clone(), x)).collect(),
        Value::Array(a) => a
            .iter()
            .take(3)
            .enumerate()
            .map(|(i, x)| (i.to_string(), x))
            .collect(),
        _ => return,
    };
    for (k, x) in children {
        let p = if prefix.is_empty() {
            k
        } else {
            format!("{prefix}.{k}")
        };
        if out.len() >= 50 || check_path(&p).is_err() {
            continue;
        }
        out.push(p.clone());
        fields(x, &p, depth - 1, out);
    }
}

/// What an app reads now and where its outputs go, for its view and its
/// inspector:
/// - `inputs`: each input's name, origin and value, with the fields a picker
///   offers within a linked view. Linked inputs first, in the order their
///   links were drawn, then literals by name.
/// - `values`: the same as name → value, what its view receives.
/// - `declared`: the inputs its source declares, and whether anything
///   supplies them.
/// - `stamps`: what a run is held to.
/// - `feeds` / `updates`: the apps and checklists its outputs reach, and
///   `ranBy` and `ranAt`, who ran its latest output and when.
pub fn inputs(b: &crate::agent::board::BoardData, app: &crate::boards::ItemRow) -> Value {
    use crate::views::{Target, view};
    let body = AppBody::parse(app.body.as_deref());
    let mut rows: Vec<Value> = Vec::new();
    let mut values = serde_json::Map::new();
    let mut stamps = serde_json::Map::new();
    for l in b
        .links
        .iter()
        .filter(|l| l.link_type == "feeds" && l.to_item == app.id)
    {
        let Some(src) = b.items.iter().find(|i| i.id == l.from_item) else {
            continue;
        };
        let v = l.view.clone().unwrap_or_default();
        let whole = view(b, &Target::Item(src), &v)
            .map(|o| o["value"].clone())
            .unwrap_or(Value::Null);
        let (value, missing) = match l.path.as_deref() {
            Some(p) => at_path(&whole, p).map_or((Value::Null, true), |x| (x.clone(), false)),
            None => (whole.clone(), false),
        };
        let name = l
            .name
            .clone()
            .unwrap_or_else(|| format!("{}.{v}", src.short_ref()));
        stamps.insert(src.id.clone(), json!(src.content_rev));
        values.insert(name.clone(), value.clone());
        let mut offered = Vec::new();
        fields(&whole, "", 3, &mut offered);
        let mut row = json!({
            "name": name, "origin": "link", "linkId": l.id, "itemId": src.id, "ref": src.short_ref(),
            "view": v, "path": l.path, "revision": src.content_rev, "value": value, "fields": offered,
        });
        if missing {
            row["missing"] = json!(true);
        }
        rows.push(row);
    }
    for (k, v) in &body.literals {
        values.insert(k.clone(), v.clone());
        rows.push(json!({ "name": k, "origin": "literal", "value": v }));
    }
    stamps.insert(OWN_SOURCE.into(), json!(body.source_rev));
    stamps.insert(OWN_SETUP.into(), json!(body.setup_rev));
    let declared: Vec<Value> = declared(&body.html)
        .into_iter()
        .map(|d| {
            let connected = values.contains_key(&d.name);
            let mut v = serde_json::to_value(&d).unwrap();
            v["connected"] = json!(connected);
            v
        })
        .collect();
    let reach = |ty: &str| -> Vec<Value> {
        b.links
            .iter()
            .filter(|l| l.link_type == ty && l.from_item == app.id)
            .filter_map(|l| b.items.iter().find(|i| i.id == l.to_item))
            .map(|i| json!({ "itemId": i.id, "ref": i.short_ref() }))
            .collect()
    };
    let latest = b.outputs.get(&app.id);
    let ran_by = latest.map(|o| b.ran_by(&app.id, o));
    let ran_at = latest.map(|o| o.run_at.clone());
    json!({
        "values": values, "inputs": rows, "declared": declared, "stamps": stamps,
        "feeds": reach("feeds"), "updates": reach("updates"), "ranBy": ran_by, "ranAt": ran_at,
    })
}

/// `GET /api/boards/{id}/items/{item}/inputs`: what an app reads now, for its
/// view and its inspector (canvas/apps). Signed in is access (ADR-0020).
pub async fn get_inputs(
    axum::extract::State(app): axum::extract::State<crate::AppState>,
    axum::extract::Path((board, item)): axum::extract::Path<(Uuid, Uuid)>,
) -> ApiResult<axum::Json<Value>> {
    let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM canvas WHERE id = ?")
        .bind(board.to_string())
        .fetch_optional(&app.db)
        .await?;
    if exists.is_none() {
        return Err(ApiError::not_found(format!("no board {board}")));
    }
    let b = crate::agent::board::BoardData::load(
        &app.db,
        &crate::agent::board::Board {
            id: board,
            title: String::new(),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let id = item.to_string();
    let i = b
        .items
        .iter()
        .find(|i| i.id == id)
        .ok_or_else(|| ApiError::not_found(format!("no item {item} on this board")))?;
    if i.kind != "app" {
        return Err(ApiError::bad_request(format!(
            "{} is a {}; only an app has inputs",
            i.short_ref(),
            i.kind
        )));
    }
    let mut v = inputs(&b, i);
    // Why it was not run automatically, until it runs again.
    v["held"] = json!(app.rooms.held(&board, item));
    if let Some(m) = AppBody::parse(i.body.as_deref()).mcp {
        v["mcp"] = crate::mcp::describe(&app.db, &m).await;
    }
    Ok(axum::Json(v))
}

// --- runs (canvas/apps: one executor per run) --------------------------------

/// Every item feeding `app`, with its content revision now, and the app's own
/// source and setup counters (`#source`, `#setup`).
pub async fn input_stamps(
    db: &mut sqlx::SqliteConnection,
    board: &str,
    app: &str,
) -> sqlx::Result<serde_json::Map<String, Value>> {
    let stamps: Vec<(String, i64)> = sqlx::query_as(
        "SELECT l.from_item, i.content_rev FROM canvas_link l JOIN canvas_item i ON i.id = l.from_item
          WHERE l.canvas_id = ? AND l.to_item = ? AND l.link_type = 'feeds'",
    )
    .bind(board)
    .bind(app)
    .fetch_all(&mut *db)
    .await?;
    let body: Option<Option<String>> =
        sqlx::query_scalar("SELECT body FROM canvas_item WHERE id = ? AND canvas_id = ?")
            .bind(app)
            .bind(board)
            .fetch_optional(&mut *db)
            .await?;
    let own = AppBody::parse(body.flatten().as_deref());
    let mut out: serde_json::Map<String, Value> = stamps
        .into_iter()
        .map(|(id, rev)| (id, json!(rev)))
        .collect();
    out.insert(OWN_SOURCE.into(), json!(own.source_rev));
    out.insert(OWN_SETUP.into(), json!(own.setup_rev));
    Ok(out)
}

/// Whether an output stamped `was` was computed from the inputs `now`. An
/// output from before the app's own counters existed lacks them, and matches.
pub fn same_inputs(
    was: &serde_json::Map<String, Value>,
    now: &serde_json::Map<String, Value>,
) -> bool {
    let item = |k: &String| !k.starts_with('#');
    was.keys().filter(|k| item(k)).count() == now.keys().filter(|k| item(k)).count()
        && now
            .iter()
            .all(|(k, v)| was.get(k).map_or(!item(k), |w| w == v))
}

/// For an app on this board: its inputs now, and whether its latest output is
/// an `ok` one computed from exactly them, so running it again would change
/// nothing. None when it is not an app here.
pub async fn run_state(
    db: &sqlx::SqlitePool,
    board: &Uuid,
    app: &Uuid,
) -> sqlx::Result<Option<(serde_json::Map<String, Value>, bool)>> {
    let (board, app) = (board.to_string(), app.to_string());
    let is_app: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM canvas_item WHERE id = ? AND canvas_id = ? AND kind = 'app')",
    )
    .bind(&app)
    .bind(&board)
    .fetch_one(db)
    .await?;
    if !is_app {
        return Ok(None);
    }
    let mut conn = db.acquire().await?;
    let stamps = input_stamps(&mut conn, &board, &app).await?;
    let last: Option<(String, String)> = sqlx::query_as(
        "SELECT input_revs, status FROM app_output WHERE item_id = ? ORDER BY version DESC LIMIT 1",
    )
    .bind(&app)
    .fetch_optional(&mut *conn)
    .await?;
    let fresh = last.is_some_and(|(revs, status)| {
        status == "ok"
            && serde_json::from_str::<serde_json::Map<String, Value>>(&revs)
                .is_ok_and(|was| same_inputs(&was, &stamps))
    });
    Ok(Some((stamps, fresh)))
}

fn no_lease(what: &str) -> ApiError {
    ApiError::conflict(format!(
        "no_lease: {what} commits only from the client holding the app's run; request a run first"
    ))
    .titled("No run")
}

/// Before a batch from a person's client is applied: an app's output, and a
/// task change made in an app's name, commit only from the socket holding that
/// app's run, for the inputs it was granted (canvas/apps). Task changes also
/// need the app's `updates` link to their checklist, and stay within the run's
/// allowance.
///
/// ponytail: checked just before the batch's own transaction, so an edit landing
/// in between is missed; the next run sees it as stale. Move into `apply` if
/// that window ever matters.
pub async fn check_runs(
    app: &crate::AppState,
    board: &Uuid,
    socket: Option<Uuid>,
    ops: &mut [crate::boards::Op],
) -> ApiResult<()> {
    use crate::boards::Op;
    let b = board.to_string();
    let mut proposals: HashMap<Uuid, (u32, Vec<Uuid>)> = HashMap::new();
    for op in ops.iter_mut() {
        // A run an agent asked for is the agent's work, for its person (agents/apps).
        let ran_for = |app_id: Uuid| socket.and_then(|s| app.rooms.run_credit(board, app_id, s));
        match op {
            Op::AppOutput {
                item_id,
                by,
                by_agent,
                cause,
                ..
            } => {
                // Only the server says a run was automatic, from its lease.
                *cause = app.rooms.run_auto(board, *item_id).map(|(c, _)| c);
                let item_id = &*item_id;
                let socket = socket.ok_or_else(|| no_lease("an app's output"))?;
                let granted = app
                    .rooms
                    .held_run(board, *item_id, socket)
                    .ok_or_else(|| no_lease("an app's output"))?;
                let mut conn = app.db.acquire().await?;
                if input_stamps(&mut conn, &b, &item_id.to_string()).await? != granted {
                    app.rooms.end_run(board, *item_id);
                    return Err(ApiError::conflict(
                        "superseded: what feeds this app changed during the run; run it again",
                    )
                    .titled("Run superseded"));
                }
                if let Some((who, agent)) = ran_for(*item_id) {
                    (*by, *by_agent) = (Some(who), agent);
                }
            }
            Op::TaskAdd { item_id, task, .. } if task.by_app.is_some() => {
                let a = by_app(task.by_app.as_deref())?;
                if let Some((who, agent)) = ran_for(a) {
                    (task.by, task.by_agent) = (Some(who), agent);
                }
                let e = proposals.entry(a).or_default();
                e.0 += 1;
                e.1.push(*item_id);
            }
            Op::TaskSet {
                item_id,
                by_app: Some(a),
                by,
                by_agent,
                ..
            } => {
                let a = by_app(Some(a))?;
                if let Some((who, agent)) = ran_for(a) {
                    (*by, *by_agent) = (Some(who), agent);
                }
                let e = proposals.entry(a).or_default();
                e.0 += 1;
                e.1.push(*item_id);
            }
            _ => {}
        }
    }
    for (by, (n, targets)) in proposals {
        let socket = socket.ok_or_else(|| no_lease("a task change in an app's name"))?;
        for list in targets {
            let granted: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM canvas_link WHERE canvas_id = ? AND from_item = ? AND to_item = ? AND link_type = 'updates')",
            )
            .bind(&b)
            .bind(by.to_string())
            .bind(list.to_string())
            .fetch_one(&app.db)
            .await?;
            if !granted {
                return Err(ApiError::forbidden(format!(
                    "app {by} has no updates link to checklist {list}"
                )));
            }
        }
        if app.rooms.held_run(board, by, socket).is_none() {
            return Err(no_lease("a task change in an app's name"));
        }
        if !app.rooms.propose(board, by, socket, n) {
            return Err(ApiError::bad_request(format!(
                "a run may change at most {} tasks",
                crate::realtime::MAX_PROPOSALS
            )));
        }
    }
    Ok(())
}

fn by_app(id: Option<&str>) -> ApiResult<Uuid> {
    id.and_then(|s| Uuid::parse_str(s).ok())
        .ok_or_else(|| ApiError::bad_request("byApp must be an app's id"))
}

/// After a batch committed: an app that produced its output has finished its run.
pub fn end_runs(app: &crate::AppState, board: &Uuid, ops: &[crate::boards::Op]) {
    for op in ops {
        if let crate::boards::Op::AppOutput { item_id, .. } = op {
            app.rooms.end_run(board, *item_id);
        }
    }
}

// --- automatic runs (canvas/apps: reactive by default; design §8) -------------

/// How long an app's inputs must keep still before it runs on its own.
const AUTO_SETTLE_MS: u64 = 1000;
/// How deep a chain of automatic runs goes before it stops.
pub const AUTO_DEPTH: u32 = 16;
/// How many automatic runs a board starts in a minute, at most.
pub const AUTO_PER_MINUTE: usize = 60;
/// How many times an automatic run waits out a run already under way.
const AUTO_BUSY_TRIES: u32 = 30;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// After a batch commits: every automatic app it left stale or never run is
/// armed to run once its inputs settle, credited to whoever made the batch.
/// An app only behind because something upstream is stale waits for that run
/// to land, which arms it in turn: a chain runs in order.
///
/// ponytail: re-reads the whole board for any batch that touches content,
/// links or apps; trace the feeds graph from what changed if boards of
/// hundreds of apps ever make this show.
pub fn schedule(
    app: &crate::AppState,
    board: &Uuid,
    ops: &[crate::boards::Op],
    actor: &crate::boards::Actor,
) {
    use crate::boards::Op;
    let mut item = None;
    let mut depth = 0;
    let mut relevant = false;
    for op in ops {
        match op {
            Op::AppOutput { item_id, .. } | Op::AppOutputRevert { item_id, .. } => {
                // What an automatic run produced carries its chain one step on.
                if let Some((_, d)) = app.rooms.run_auto(board, *item_id) {
                    depth = depth.max(d + 1);
                }
                item.get_or_insert(*item_id);
                relevant = true;
            }
            Op::ItemSource { item_id, .. }
            | Op::ItemContent { item_id, .. }
            | Op::ChecklistTitle { item_id, .. }
            | Op::TaskAdd { item_id, .. }
            | Op::TaskSet { item_id, .. }
            | Op::TaskRemove { item_id, .. }
            | Op::AppSet { item_id, .. } => {
                item.get_or_insert(*item_id);
                relevant = true;
            }
            Op::ItemCreate { content, .. } if content.kind.as_deref() == Some("app") => {
                relevant = true
            }
            Op::LinkAdd { .. }
            | Op::LinkSet { .. }
            | Op::LinkDelete { .. }
            | Op::ItemDelete { .. } => relevant = true,
            _ => {}
        }
    }
    if !relevant {
        return;
    }
    let mut cause = json!({ "auto": true, "by": actor.user_id });
    if let Some(a) = &actor.agent {
        cause["agent"] = json!(a);
    }
    if let Some(i) = item {
        cause["item"] = json!(i.to_string());
    }
    arm_stale(app.clone(), *board, cause, depth);
}

/// A board nobody could run apps on became runnable: its stale automatic apps
/// run now, credited to the person whose client can run them.
pub fn run_stale(app: &crate::AppState, board: &Uuid, user: &str) {
    arm_stale(app.clone(), *board, json!({ "auto": true, "by": user }), 0);
}

fn arm_stale(app: crate::AppState, board: Uuid, cause: Value, depth: u32) {
    tokio::spawn(async move {
        let Ok(b) = crate::agent::board::BoardData::load(
            &app.db,
            &crate::agent::board::Board {
                id: board,
                title: String::new(),
            },
        )
        .await
        else {
            return;
        };
        for i in b.items.iter().filter(|i| i.kind == "app") {
            if AppBody::parse(i.body.as_deref()).run.as_deref() == Some("manual") {
                continue;
            }
            if !matches!(
                b.app_states.get(&i.id),
                None | Some(State::NeverRun) | Some(State::Stale(_))
            ) {
                continue;
            }
            // Behind an app that is behind itself: it runs after that one lands.
            let upstream_behind = b
                .links
                .iter()
                .filter(|l| l.link_type == "feeds" && l.to_item == i.id)
                .any(|l| b.app_states.get(&l.from_item).is_some_and(State::behind));
            if upstream_behind {
                continue;
            }
            let Ok(id) = Uuid::parse_str(&i.id) else {
                continue;
            };
            let token = app.rooms.arm_auto(&board, id, cause.clone(), depth);
            fire_later(app.clone(), board, id, token, 0);
        }
    });
}

/// Whether an app feeding `id` has yet to run on what it reads (or failed).
async fn upstream_behind(db: &sqlx::SqlitePool, board: &Uuid, id: &Uuid) -> bool {
    let feeding: Vec<String> = sqlx::query_scalar(
        "SELECT l.from_item FROM canvas_link l JOIN canvas_item i ON i.id = l.from_item
          WHERE l.canvas_id = ? AND l.to_item = ? AND l.link_type = 'feeds' AND i.kind = 'app'",
    )
    .bind(board.to_string())
    .bind(id.to_string())
    .fetch_all(db)
    .await
    .unwrap_or_default();
    for f in feeding {
        let Ok(up) = Uuid::parse_str(&f) else {
            continue;
        };
        if !matches!(run_state(db, board, &up).await, Ok(Some((_, true)))) {
            return true;
        }
    }
    false
}

/// Runs `id` once its inputs have kept still, unless a later change re-armed it.
fn fire_later(app: crate::AppState, board: Uuid, id: Uuid, token: u64, tries: u32) {
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(AUTO_SETTLE_MS)).await;
        let Some((cause, depth)) = app.rooms.take_auto(&board, id, token) else {
            return;
        };
        let Ok(Some((stamps, fresh))) = run_state(&app.db, &board, &id).await else {
            return;
        };
        // A tool-backed app runs on the server, so with nobody around too.
        let server = crate::mcp::tool_backed(&app.db, &board, &id)
            .await
            .is_some();
        if fresh || !(server || app.rooms.can_run(&board, id)) {
            return;
        }
        // Things changed since it was armed: switched to manual, it waits for a
        // person; an app upstream that is behind runs first, and its output
        // arms this one again.
        let body: Option<Option<String>> =
            sqlx::query_scalar("SELECT body FROM canvas_item WHERE id = ?")
                .bind(id.to_string())
                .fetch_optional(&app.db)
                .await
                .unwrap_or_default();
        if AppBody::parse(body.flatten().as_deref()).run.as_deref() == Some("manual")
            || upstream_behind(&app.db, &board, &id).await
        {
            return;
        }
        if app.rooms.running(&board, id) {
            // A run already under way may end superseded: try again after it.
            if tries < AUTO_BUSY_TRIES {
                let token = app.rooms.arm_auto(&board, id, cause, depth);
                fire_later(app, board, id, token, tries + 1);
            }
            return;
        }
        if depth > AUTO_DEPTH {
            app.rooms.hold(
                &board,
                id,
                &format!("a chain of {AUTO_DEPTH} automatic runs stopped here"),
            );
            return;
        }
        if !app.rooms.auto_allowed_at(&board, AUTO_PER_MINUTE, now_ms()) {
            app.rooms.hold(
                &board,
                id,
                &format!("this board started {AUTO_PER_MINUTE} automatic runs in the last minute"),
            );
            return;
        }
        let credit = (
            cause["by"].as_str().unwrap_or_default().to_string(),
            cause["agent"].as_str().map(str::to_string),
        );
        if crate::mcp::grant(
            &app,
            &board,
            id,
            credit.clone(),
            Some((cause.clone(), depth)),
            stamps.clone(),
        )
        .await
        .is_none()
        {
            app.rooms
                .request_auto(&board, id, credit, cause, depth, stamps);
        }
    });
}
