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
#[derive(Serialize, Deserialize)]
pub struct AppBody {
    pub title: String,
    pub html: String,
}

/// Who ran an app and when, as the server stamped it.
pub struct Run<'a> {
    pub by: Option<&'a str>,
    pub by_agent: Option<&'a str>,
    pub at: Option<&'a str>,
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
) -> ApiResult<()> {
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
) -> ApiResult<()> {
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
        "INSERT INTO app_output (item_id, version, outputs, text, input_revs, status, error, run_by, run_by_agent, run_at)
         VALUES (?1, (SELECT coalesce(max(version), 0) + 1 FROM app_output WHERE item_id = ?1), ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                 coalesce(?9, {NOW}))"
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
    let stamps: Vec<(String, i64)> = sqlx::query_as(
        "SELECT l.from_item, i.content_rev FROM canvas_link l JOIN canvas_item i ON i.id = l.from_item
          WHERE l.canvas_id = ? AND l.to_item = ? AND l.link_type = 'feeds'",
    )
    .bind(board)
    .bind(item.to_string())
    .fetch_all(&mut **tx)
    .await?;
    let input_revs: serde_json::Map<String, Value> = stamps
        .into_iter()
        .map(|(id, rev)| (id, json!(rev)))
        .collect();
    let input_revs = Value::Object(input_revs).to_string();
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
        })
    }
}

/// Every app's latest output on a board, by item id.
pub async fn latest_outputs(
    conn: &mut sqlx::SqliteConnection,
    board: &str,
) -> sqlx::Result<HashMap<String, Output>> {
    let rows: Vec<Output> = sqlx::query_as(
        "SELECT o.item_id, o.version, o.outputs, o.text, o.input_revs, o.status, o.error, o.run_by, o.run_by_agent, o.run_at
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
    fn behind(&self) -> bool {
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

/// Every app's state, from every app on the board, each item's content revision, the
/// `feeds` links (from, to) and the latest outputs. Pure: the same board
/// always gives the same answer.
pub fn status(
    apps: &[&str],
    content_rev: &HashMap<&str, i64>,
    feeds: &[(&str, &str)],
    outputs: &HashMap<String, Output>,
) -> HashMap<String, State> {
    let mut done: HashMap<String, State> = HashMap::new();
    let all: HashSet<&str> = apps.iter().copied().collect();
    for app in apps {
        state_of(
            app,
            &all,
            content_rev,
            feeds,
            outputs,
            &mut done,
            &mut HashSet::new(),
        );
    }
    done
}

fn state_of(
    app: &str,
    apps: &HashSet<&str>,
    content_rev: &HashMap<&str, i64>,
    feeds: &[(&str, &str)],
    outputs: &HashMap<String, Output>,
    done: &mut HashMap<String, State>,
    visiting: &mut HashSet<String>,
) -> State {
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
                .filter(|k| !sources.contains(&k.as_str()))
                .collect();
            gone.sort();
            moved.extend(gone.into_iter().map(|k| Moved {
                item: k.clone(),
                was: revs.get(k).copied(),
                now: None,
            }));
            if !moved.is_empty() {
                State::Stale(moved)
            } else if out.status == "error" {
                State::Error(out.error.clone().unwrap_or_default())
            } else {
                let (mut failed, mut behind) = (Vec::new(), Vec::new());
                for s in sources.iter().filter(|s| apps.contains(**s)) {
                    let up = state_of(s, apps, content_rev, feeds, outputs, done, visiting);
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
        let s = status(&["a1", "a2"], &revs, &feeds, &outputs);
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
        let s = status(&["a1", "a2"], &revs, &feeds, &outputs);
        assert_eq!(s["a1"], State::Fresh);
        assert_eq!(s["a2"], State::NeverRun);
    }

    #[test]
    fn a_new_or_removed_feed_makes_an_app_stale() {
        let revs = HashMap::from([("n3", 7), ("n4", 1)]);
        let outputs = HashMap::from([("a1".to_string(), out("a1", json!({ "n3": 7 }), "ok"))]);
        let added = status(&["a1"], &revs, &[("n3", "a1"), ("n4", "a1")], &outputs);
        assert_eq!(
            added["a1"],
            State::Stale(vec![Moved {
                item: "n4".into(),
                was: None,
                now: Some(1)
            }])
        );
        let removed = status(&["a1"], &revs, &[], &outputs);
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
        let s = status(&["a1", "a2"], &revs, &feeds, &outputs);
        assert_eq!(s["a1"], State::Error("boom".into()));
        assert_eq!(s["a2"], State::UpstreamError(vec!["a1".into()]));
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
/// nested frames, no forms. Framed only from loopback pages: the library's
/// port can change while it runs, and a token is still needed to load anything.
// ponytail: loopback frame-ancestors fits the desktop; a self-hosted sandbox
// hostname (Phase 2) frames from its instance's public URL instead.
pub const APP_CSP: &str = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; \
img-src 'self' data:; font-src 'self'; media-src 'self' data:; connect-src 'none'; frame-src 'none'; \
object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors http://127.0.0.1:* http://localhost:*";

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
const KIT_TOKENS: [&str; 10] = [
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
        "<meta name=\"color-scheme\" content=\"{scheme}\"><style>:root{{{vars}}}</style><link rel=\"stylesheet\" href=\"/kit.css\">"
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
        ApiError::not_found("apps run in the desktop app: this server has no sandbox origin")
    })?;
    let is_app: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM canvas_item WHERE id = ? AND canvas_id = ? AND kind = 'app')",
    )
    .bind(item.to_string())
    .bind(board.to_string())
    .fetch_one(&app.db)
    .await?;
    if !is_app {
        return Err(ApiError::not_found(format!(
            "no app {item} on board {board}"
        )));
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
    let Some(html) = body
        .and_then(|b| serde_json::from_str::<AppBody>(&b).ok())
        .map(|b| b.html)
    else {
        return (StatusCode::NOT_FOUND, "no such view").into_response();
    };
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CONTENT_SECURITY_POLICY, APP_CSP),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::CACHE_CONTROL, "no-store"),
            (header::REFERRER_POLICY, "no-referrer"),
        ],
        with_kit(&html, &kit),
    )
        .into_response()
}

async fn serve_kit() -> axum::response::Response {
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
        "SELECT item_id, version, outputs, text, input_revs, status, error, run_by, run_by_agent, run_at
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

// --- runs (canvas/apps: one executor per run) --------------------------------

/// Every item feeding `app`, with its content revision now.
pub async fn input_stamps<'c, E>(
    db: E,
    board: &str,
    app: &str,
) -> sqlx::Result<serde_json::Map<String, Value>>
where
    E: sqlx::Executor<'c, Database = Sqlite>,
{
    let stamps: Vec<(String, i64)> = sqlx::query_as(
        "SELECT l.from_item, i.content_rev FROM canvas_link l JOIN canvas_item i ON i.id = l.from_item
          WHERE l.canvas_id = ? AND l.to_item = ? AND l.link_type = 'feeds'",
    )
    .bind(board)
    .bind(app)
    .fetch_all(db)
    .await?;
    Ok(stamps
        .into_iter()
        .map(|(id, rev)| (id, json!(rev)))
        .collect())
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
    let stamps = input_stamps(db, &board, &app).await?;
    let last: Option<(String, String)> = sqlx::query_as(
        "SELECT input_revs, status FROM app_output WHERE item_id = ? ORDER BY version DESC LIMIT 1",
    )
    .bind(&app)
    .fetch_optional(db)
    .await?;
    let fresh = last.is_some_and(|(revs, status)| {
        status == "ok"
            && serde_json::from_str::<serde_json::Map<String, Value>>(&revs)
                .ok()
                .as_ref()
                == Some(&stamps)
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
                ..
            } => {
                let item_id = &*item_id;
                let socket = socket.ok_or_else(|| no_lease("an app's output"))?;
                let granted = app
                    .rooms
                    .held_run(board, *item_id, socket)
                    .ok_or_else(|| no_lease("an app's output"))?;
                if input_stamps(&app.db, &b, &item_id.to_string()).await? != granted {
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
