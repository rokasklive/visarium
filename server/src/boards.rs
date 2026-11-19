//! Boards, their snapshot, and the durable operations that change them.
//!
//! An operation batch is applied atomically and bumps the board's revision by
//! its length; the committed range is then broadcast to everyone else watching
//! (ADR-0017, ADR-0019 — broadcast after commit, never before).

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{Sqlite, Transaction};
use uuid::Uuid;

use crate::auth::User;
use crate::error::{ApiError, ApiResult, Json, is_foreign_key_violation};
use crate::{AppState, NOW, new_id};

pub const ACTOR_HEADER: &str = "x-visarium-actor";

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/boards", get(list).post(create))
        .route("/boards/{id}", get(get_board).patch(rename).delete(delete))
        .route("/boards/{id}/duplicate", post(duplicate))
        .route("/boards/{id}/snapshot", get(snapshot))
        .route("/boards/{id}/operations", post(operations))
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    id: String,
    title: String,
    owner_id: Option<String>,
    revision: i64,
    created_at: String,
    updated_at: String,
}

const COLUMNS: &str = "id, title, owner_id, revision, created_at, updated_at";

fn not_found(id: impl std::fmt::Display) -> ApiError {
    ApiError::not_found(format!("no board {id}"))
}

pub async fn exists(db: &sqlx::SqlitePool, id: &Uuid) -> sqlx::Result<bool> {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM canvas WHERE id = ?)").bind(id.to_string()).fetch_one(db).await
}

pub async fn revision(db: &sqlx::SqlitePool, id: &Uuid) -> sqlx::Result<Option<i64>> {
    sqlx::query_scalar("SELECT revision FROM canvas WHERE id = ?").bind(id.to_string()).fetch_optional(db).await
}

// --- the operation model ----------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Transform {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub rotation: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetRef {
    pub asset_id: Option<Uuid>,
    #[serde(default)]
    pub intrinsic_width: i64,
    #[serde(default)]
    pub intrinsic_height: i64,
}

/// What an item shows. `kind` says which of the other fields apply: `asset`
/// for an image, `source` for a note, `lang` + `source` for a diagram, `title`
/// + `tasks` for a checklist. Absent kind is an image, as before kinds existed.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Content {
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset: Option<AssetRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tasks: Option<Vec<Task>>,
}

/// One task of a checklist. `by` and `at` are stamped by the server from the
/// session; whatever a client sends there is overwritten.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub text: String,
    #[serde(default = "todo")]
    pub state: String,
    #[serde(default)]
    pub by: Option<String>,
    #[serde(default)]
    pub at: Option<String>,
}

fn todo() -> String {
    "todo".into()
}

/// A checklist's `body` column.
#[derive(Serialize, Deserialize)]
struct Checklist {
    title: String,
    tasks: Vec<Task>,
}

/// One end of a link: a whole item, or one named element inside a diagram.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    pub item_id: Uuid,
    #[serde(default)]
    pub element: Option<String>,
}

const MAX_BODY: usize = 64 * 1024;
const MAX_TASKS: usize = 200;
const MAX_TASK_TEXT: usize = 500;
const MAX_TITLE: usize = 200;
const MAX_ELEMENT: usize = 200;
const TASK_STATES: [&str; 4] = ["todo", "doing", "done", "blocked"];
const LINK_TYPES: [&str; 4] = ["describes", "comments", "implements", "depends-on"];
const LANGS: [&str; 2] = ["mermaid", "plantuml"];

fn check_body(body: &str) -> ApiResult<()> {
    if body.len() > MAX_BODY {
        return Err(ApiError::bad_request(format!("an item's text is limited to {MAX_BODY} bytes; this one is {}", body.len())));
    }
    Ok(())
}

fn check_task(t: &Task) -> ApiResult<()> {
    let id_ok = (1..=40).contains(&t.id.len()) && t.id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !id_ok {
        return Err(ApiError::bad_request(format!("task id '{}' must be 1-40 letters, digits, '-' or '_'", t.id)));
    }
    check_task_text(&t.text)?;
    check_state(&t.state)
}

fn check_task_text(text: &str) -> ApiResult<()> {
    if text.trim().is_empty() || text.chars().count() > MAX_TASK_TEXT {
        return Err(ApiError::bad_request(format!("task text must be 1-{MAX_TASK_TEXT} characters")));
    }
    Ok(())
}

fn check_state(state: &str) -> ApiResult<()> {
    if !TASK_STATES.contains(&state) {
        return Err(ApiError::bad_request(format!("task state must be one of {}", TASK_STATES.join(", "))));
    }
    Ok(())
}

fn check_tasks(tasks: &[Task]) -> ApiResult<()> {
    if tasks.len() > MAX_TASKS {
        return Err(ApiError::bad_request(format!("a checklist holds at most {MAX_TASKS} tasks")));
    }
    let mut seen = std::collections::HashSet::new();
    for t in tasks {
        check_task(t)?;
        if !seen.insert(t.id.as_str()) {
            return Err(ApiError::bad_request(format!("task id '{}' is used twice in one checklist", t.id)));
        }
    }
    Ok(())
}

fn check_title(title: &str) -> ApiResult<()> {
    if title.chars().count() > MAX_TITLE {
        return Err(ApiError::bad_request(format!("a checklist title is at most {MAX_TITLE} characters")));
    }
    Ok(())
}

fn check_link_type(t: &str) -> ApiResult<()> {
    if !LINK_TYPES.contains(&t) {
        return Err(ApiError::bad_request(format!("link type must be one of {}", LINK_TYPES.join(", "))));
    }
    Ok(())
}

/// The stored columns for a piece of content: (kind, asset_id, lang, body).
type ContentColumns = (&'static str, Option<String>, Option<String>, Option<String>);

fn content_columns(c: &Content) -> ApiResult<ContentColumns> {
    let missing_source = |kind: &str| ApiError::bad_request(format!("a {kind} needs its source text"));
    match c.kind.as_deref() {
        None | Some("image") | Some("placeholder") => Ok(("image", Some(c.asset_id()?), None, None)),
        Some("note") => {
            let source = c.source.clone().ok_or_else(|| missing_source("note"))?;
            check_body(&source)?;
            Ok(("note", None, None, Some(source)))
        }
        Some("diagram") => {
            let lang = c.lang.as_deref().filter(|l| LANGS.contains(l)).ok_or_else(|| {
                ApiError::bad_request(format!("a diagram's lang must be one of {}", LANGS.join(", ")))
            })?;
            let source = c.source.clone().ok_or_else(|| missing_source("diagram"))?;
            check_body(&source)?;
            Ok(("diagram", None, Some(lang.to_string()), Some(source)))
        }
        Some("checklist") => {
            let title = c.title.clone().unwrap_or_default();
            check_title(&title)?;
            let tasks = c.tasks.clone().unwrap_or_default();
            check_tasks(&tasks)?;
            let body = serde_json::to_string(&Checklist { title, tasks }).unwrap();
            check_body(&body)?;
            Ok(("checklist", None, None, Some(body)))
        }
        Some(other) => Err(ApiError::bad_request(format!(
            "unknown item kind '{other}'; use image, note, diagram or checklist"
        ))),
    }
}

impl Content {
    /// A placeholder (an image still uploading) has no asset and cannot be
    /// stored; the client sends `item.content` once the upload lands.
    fn asset_id(&self) -> ApiResult<String> {
        self.asset.as_ref().and_then(|a| a.asset_id).map(|id| id.to_string()).ok_or_else(|| {
            ApiError::bad_request(format!(
                "item content of kind '{}' has no asset; a placeholder is not persistable",
                self.kind.as_deref().unwrap_or("null")
            ))
            .titled("Operation cannot be persisted")
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Appearance {
    #[serde(default)]
    pub opacity: f64,
    #[serde(default)]
    pub flip_x: bool,
    #[serde(default)]
    pub flip_y: bool,
}

/// The window on the original an item shows, as fractions of it (ADR-0029).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Crop {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Op {
    #[serde(rename = "item.create", rename_all = "camelCase")]
    ItemCreate {
        item_id: Uuid,
        transform: Transform,
        #[serde(default)]
        z: f64,
        content: Content,
        group_id: Option<Uuid>,
        appearance: Option<Appearance>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        crop: Option<Crop>,
    },
    #[serde(rename = "item.delete", rename_all = "camelCase")]
    ItemDelete { item_id: Uuid },
    #[serde(rename = "item.transform", rename_all = "camelCase")]
    ItemTransform {
        item_id: Uuid,
        transform: Transform,
        /// Absent leaves the stored crop alone; present replaces it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        crop: Option<Crop>,
    },
    #[serde(rename = "item.content", rename_all = "camelCase")]
    ItemContent { item_id: Uuid, content: Content },
    #[serde(rename = "item.z", rename_all = "camelCase")]
    ItemZ {
        item_id: Uuid,
        #[serde(default)]
        z: f64,
    },
    #[serde(rename = "item.appearance", rename_all = "camelCase")]
    ItemAppearance { item_id: Uuid, appearance: Appearance },
    #[serde(rename = "group.create", rename_all = "camelCase")]
    GroupCreate { group_id: Uuid, member_ids: Option<Vec<Uuid>>, label: Option<String>, frame: Option<bool> },
    #[serde(rename = "group.delete", rename_all = "camelCase")]
    GroupDelete { group_id: Uuid },
    #[serde(rename = "group.members", rename_all = "camelCase")]
    GroupMembers { group_id: Uuid, member_ids: Option<Vec<Uuid>> },
    #[serde(rename = "group.label", rename_all = "camelCase")]
    GroupLabel { group_id: Uuid, label: Option<String> },
    #[serde(rename = "group.frame", rename_all = "camelCase")]
    GroupFrame {
        group_id: Uuid,
        #[serde(default)]
        frame: bool,
    },
    /// Replaces a note's or diagram's source. With `baseRevision`, it is
    /// refused unless the item is still at that revision.
    #[serde(rename = "item.source", rename_all = "camelCase")]
    ItemSource {
        item_id: Uuid,
        source: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        base_revision: Option<i64>,
    },
    #[serde(rename = "checklist.title", rename_all = "camelCase")]
    ChecklistTitle { item_id: Uuid, title: String },
    /// Inserts a task at `index` (clamped), or at the end without one.
    #[serde(rename = "task.add", rename_all = "camelCase")]
    TaskAdd {
        item_id: Uuid,
        task: Task,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        index: Option<usize>,
    },
    /// Changes a task's text and/or state; absent fields are left alone.
    #[serde(rename = "task.set", rename_all = "camelCase")]
    TaskSet {
        item_id: Uuid,
        task_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        state: Option<String>,
        #[serde(default)]
        by: Option<String>,
        #[serde(default)]
        at: Option<String>,
    },
    #[serde(rename = "task.remove", rename_all = "camelCase")]
    TaskRemove { item_id: Uuid, task_id: String },
    #[serde(rename = "link.add", rename_all = "camelCase")]
    LinkAdd {
        link_id: Uuid,
        from: Anchor,
        to: Anchor,
        link_type: String,
        #[serde(default)]
        by: Option<String>,
        #[serde(default)]
        at: Option<String>,
    },
    #[serde(rename = "link.set", rename_all = "camelCase")]
    LinkSet { link_id: Uuid, link_type: String },
    #[serde(rename = "link.delete", rename_all = "camelCase")]
    LinkDelete { link_id: Uuid },
}

impl Op {
    /// Writes the session's account and the time onto everything that records
    /// who changed it. Runs before apply, so the database, the author's
    /// response and every peer's broadcast carry the same stamp.
    ///
    /// ponytail: an `item.create` that restores a deleted checklist (undo)
    /// re-stamps its tasks with whoever pressed undo. Carry the original
    /// stamps through history if that ever matters.
    pub fn stamp(&mut self, by: &str, at: &str) {
        let mark = |b: &mut Option<String>, a: &mut Option<String>| {
            *b = Some(by.to_string());
            *a = Some(at.to_string());
        };
        match self {
            Op::ItemCreate { content, .. } => {
                for t in content.tasks.iter_mut().flatten() {
                    mark(&mut t.by, &mut t.at);
                }
            }
            Op::TaskAdd { task, .. } => mark(&mut task.by, &mut task.at),
            Op::TaskSet { by: b, at: a, .. } | Op::LinkAdd { by: b, at: a, .. } => mark(b, a),
            _ => {}
        }
    }
}

fn check_appearance(a: &Appearance) -> ApiResult<()> {
    if (0.0..=1.0).contains(&a.opacity) {
        Ok(())
    } else {
        Err(ApiError::bad_request("opacity must be between 0 and 1"))
    }
}

/// The four columns for a crop: `None` for the whole image, which is stored as
/// NULL so the default stays the meaning. Float drift up to 1e-9 past an edge is
/// clamped away; anything further is the caller's mistake.
type CropColumns = Option<(f64, f64, f64, f64)>;

fn check_crop(c: &Crop) -> ApiResult<CropColumns> {
    const TOLERANCE: f64 = 1e-9;
    let finite = [c.x, c.y, c.width, c.height].iter().all(|v| v.is_finite());
    let fits = c.x >= 0.0
        && c.y >= 0.0
        && c.width > 0.0
        && c.height > 0.0
        && c.x + c.width <= 1.0 + TOLERANCE
        && c.y + c.height <= 1.0 + TOLERANCE;
    if !finite || !fits {
        return Err(ApiError::bad_request("crop must be a non-empty rectangle inside the original (fractions 0 to 1)"));
    }
    let (w, h) = ((1.0 - c.x).min(c.width), (1.0 - c.y).min(c.height));
    let full = c.x < TOLERANCE && c.y < TOLERANCE && w > 1.0 - TOLERANCE && h > 1.0 - TOLERANCE;
    Ok(if full { None } else { Some((c.x, c.y, w, h)) })
}

/// A broken reference (an asset or group that is not stored) or a value the
/// schema refuses is the caller's mistake, not the server's.
fn integrity(e: sqlx::Error) -> ApiError {
    let constraint = e.as_database_error().is_some_and(|d| d.is_check_violation()) || is_foreign_key_violation(&e);
    if constraint {
        ApiError::bad_request("an operation referenced an asset or group that is not stored")
            .titled("Operation references something that does not exist")
    } else {
        e.into()
    }
}

async fn join(tx: &mut Transaction<'_, Sqlite>, board: &str, group: &Uuid, members: &Option<Vec<Uuid>>) -> sqlx::Result<()> {
    let Some(members) = members.as_ref().filter(|m| !m.is_empty()) else { return Ok(()) };
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE canvas_item SET group_id = ?, updated_at = {NOW}
          WHERE canvas_id = ? AND id IN (SELECT value FROM json_each(?))"
    )))
    .bind(group.to_string())
    .bind(board)
    .bind(serde_json::to_string(members).unwrap())
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn apply_one(tx: &mut Transaction<'_, Sqlite>, board: &str, op: &Op) -> ApiResult<()> {
    let bump = format!("revision = revision + 1, updated_at = {NOW}");
    match op {
        Op::ItemCreate { item_id, transform: t, z, content, group_id, appearance, crop } => {
            let a = appearance.clone().unwrap_or(Appearance { opacity: 1.0, flip_x: false, flip_y: false });
            check_appearance(&a)?;
            let c = crop.as_ref().map(check_crop).transpose()?.flatten();
            let (kind, asset_id, lang, body) = content_columns(content)?;
            if kind != "image" && c.is_some() {
                return Err(ApiError::bad_request("only an image can be cropped"));
            }
            sqlx::query(
                "INSERT INTO canvas_item (id, canvas_id, kind, asset_id, lang, body, group_id, x, y, width, height, rotation, z,
                                          opacity, flip_x, flip_y, crop_x, crop_y, crop_w, crop_h)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (id) DO NOTHING",
            )
            .bind(item_id.to_string())
            .bind(board)
            .bind(kind)
            .bind(asset_id)
            .bind(lang)
            .bind(body)
            .bind(group_id.map(|g| g.to_string()))
            .bind(t.x)
            .bind(t.y)
            .bind(t.width)
            .bind(t.height)
            .bind(t.rotation)
            .bind(z)
            .bind(a.opacity)
            .bind(a.flip_x)
            .bind(a.flip_y)
            .bind(c.map(|c| c.0))
            .bind(c.map(|c| c.1))
            .bind(c.map(|c| c.2))
            .bind(c.map(|c| c.3))
            .execute(&mut **tx)
            .await
            .map_err(integrity)?;
        }
        Op::ItemDelete { item_id } => {
            sqlx::query("DELETE FROM canvas_item WHERE id = ? AND canvas_id = ?")
                .bind(item_id.to_string())
                .bind(board)
                .execute(&mut **tx)
                .await?;
        }
        Op::ItemTransform { item_id, transform: t, crop } => {
            // Absent crop: the columns are not in the statement at all, so a
            // plain move can never undo someone else's crop.
            let c = crop.as_ref().map(check_crop).transpose()?;
            let set_crop = if c.is_some() { "crop_x = ?, crop_y = ?, crop_w = ?, crop_h = ?," } else { "" };
            let mut q = sqlx::query(sqlx::AssertSqlSafe(format!(
                "UPDATE canvas_item SET x = ?, y = ?, width = ?, height = ?, rotation = ?, {set_crop} {bump}
                  WHERE id = ? AND canvas_id = ?"
            )))
            .bind(t.x)
            .bind(t.y)
            .bind(t.width)
            .bind(t.height)
            .bind(t.rotation);
            if let Some(c) = c {
                q = q.bind(c.map(|c| c.0)).bind(c.map(|c| c.1)).bind(c.map(|c| c.2)).bind(c.map(|c| c.3));
            }
            q.bind(item_id.to_string())
            .bind(board)
            .execute(&mut **tx)
            .await
            .map_err(integrity)?;
        }
        Op::ItemContent { item_id, content } => {
            sqlx::query(sqlx::AssertSqlSafe(format!("UPDATE canvas_item SET asset_id = ?, {bump} WHERE id = ? AND canvas_id = ?")))
                .bind(content.asset_id()?)
                .bind(item_id.to_string())
                .bind(board)
                .execute(&mut **tx)
                .await
                .map_err(integrity)?;
        }
        Op::ItemZ { item_id, z } => {
            sqlx::query(sqlx::AssertSqlSafe(format!("UPDATE canvas_item SET z = ?, {bump} WHERE id = ? AND canvas_id = ?")))
                .bind(z)
                .bind(item_id.to_string())
                .bind(board)
                .execute(&mut **tx)
                .await?;
        }
        Op::ItemAppearance { item_id, appearance: a } => {
            check_appearance(a)?;
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "UPDATE canvas_item SET opacity = ?, flip_x = ?, flip_y = ?, {bump} WHERE id = ? AND canvas_id = ?"
            )))
            .bind(a.opacity)
            .bind(a.flip_x)
            .bind(a.flip_y)
            .bind(item_id.to_string())
            .bind(board)
            .execute(&mut **tx)
            .await
            .map_err(integrity)?;
        }
        Op::GroupCreate { group_id, member_ids, label, frame } => {
            sqlx::query(
                "INSERT INTO canvas_group (id, canvas_id, label, frame) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
            )
            .bind(group_id.to_string())
            .bind(board)
            .bind(label)
            .bind(frame.unwrap_or(false))
            .execute(&mut **tx)
            .await
            .map_err(integrity)?;
            join(tx, board, group_id, member_ids).await.map_err(integrity)?;
        }
        Op::GroupDelete { group_id } => {
            sqlx::query("DELETE FROM canvas_group WHERE id = ? AND canvas_id = ?")
                .bind(group_id.to_string())
                .bind(board)
                .execute(&mut **tx)
                .await?;
        }
        Op::GroupMembers { group_id, member_ids } => {
            sqlx::query("UPDATE canvas_item SET group_id = NULL WHERE group_id = ? AND canvas_id = ?")
                .bind(group_id.to_string())
                .bind(board)
                .execute(&mut **tx)
                .await?;
            join(tx, board, group_id, member_ids).await.map_err(integrity)?;
        }
        Op::GroupLabel { group_id, label } => {
            sqlx::query("UPDATE canvas_group SET label = ? WHERE id = ? AND canvas_id = ?")
                .bind(label)
                .bind(group_id.to_string())
                .bind(board)
                .execute(&mut **tx)
                .await?;
        }
        Op::GroupFrame { group_id, frame } => {
            sqlx::query("UPDATE canvas_group SET frame = ? WHERE id = ? AND canvas_id = ?")
                .bind(frame)
                .bind(group_id.to_string())
                .bind(board)
                .execute(&mut **tx)
                .await?;
        }
        Op::ItemSource { item_id, source, base_revision } => {
            let Some((kind, revision)) = item_kind(tx, board, item_id).await? else { return Ok(()) };
            if kind != "note" && kind != "diagram" {
                return Err(ApiError::bad_request(format!("item {item_id} is a {kind}; only notes and diagrams have source")));
            }
            if base_revision.is_some_and(|b| b != revision) {
                return Err(ApiError::conflict(format!(
                    "item {item_id} changed since this edit began: the edit is based on revision {}, the item is at revision {revision}. Re-read it and apply the edit again.",
                    base_revision.unwrap()
                ))
                .titled("Stale edit"));
            }
            check_body(source)?;
            set_body(tx, board, item_id, source).await?;
        }
        Op::ChecklistTitle { item_id, title } => {
            check_title(title)?;
            let Some(mut list) = checklist(tx, board, item_id).await? else { return Ok(()) };
            list.title = title.clone();
            save_checklist(tx, board, item_id, &list).await?;
        }
        Op::TaskAdd { item_id, task, index } => {
            check_task(task)?;
            let Some(mut list) = checklist(tx, board, item_id).await? else { return Ok(()) };
            if list.tasks.len() >= MAX_TASKS {
                return Err(ApiError::bad_request(format!("a checklist holds at most {MAX_TASKS} tasks")));
            }
            if list.tasks.iter().any(|t| t.id == task.id) {
                return Err(ApiError::bad_request(format!("task id '{}' is already in this checklist", task.id)));
            }
            let at = index.unwrap_or(list.tasks.len()).min(list.tasks.len());
            list.tasks.insert(at, task.clone());
            save_checklist(tx, board, item_id, &list).await?;
        }
        Op::TaskSet { item_id, task_id, text, state, by, at } => {
            if let Some(t) = text {
                check_task_text(t)?;
            }
            if let Some(s) = state {
                check_state(s)?;
            }
            let Some(mut list) = checklist(tx, board, item_id).await? else { return Ok(()) };
            // Tolerant like every update: a task removed meanwhile is nothing to change.
            let Some(task) = list.tasks.iter_mut().find(|t| &t.id == task_id) else { return Ok(()) };
            if let Some(t) = text {
                task.text = t.clone();
            }
            if let Some(s) = state {
                task.state = s.clone();
            }
            task.by = by.clone();
            task.at = at.clone();
            save_checklist(tx, board, item_id, &list).await?;
        }
        Op::TaskRemove { item_id, task_id } => {
            let Some(mut list) = checklist(tx, board, item_id).await? else { return Ok(()) };
            let before = list.tasks.len();
            list.tasks.retain(|t| &t.id != task_id);
            if list.tasks.len() != before {
                save_checklist(tx, board, item_id, &list).await?;
            }
        }
        Op::LinkAdd { link_id, from, to, link_type, by, at } => {
            check_link_type(link_type)?;
            for (end, a) in [("from", from), ("to", to)] {
                // A link is a create: an end that is not on this board is refused, as
                // item.create refuses a missing asset.
                let (kind, _) = item_kind(tx, board, &a.item_id).await?.ok_or_else(|| no_item(&a.item_id))?;
                if let Some(e) = &a.element {
                    if kind != "diagram" {
                        return Err(ApiError::bad_request(format!(
                            "link {end}: only a diagram has named elements, and item {} is a {kind}",
                            a.item_id
                        )));
                    }
                    if e.is_empty() || e.chars().count() > MAX_ELEMENT {
                        return Err(ApiError::bad_request(format!("link {end}: an element name is 1-{MAX_ELEMENT} characters")));
                    }
                }
            }
            if from.item_id == to.item_id && from.element == to.element {
                return Err(ApiError::bad_request("a link needs two different ends"));
            }
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "INSERT INTO canvas_link (id, canvas_id, from_item, from_element, to_item, to_element, link_type, created_by, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, coalesce(?, {NOW}))
                 ON CONFLICT (id) DO NOTHING"
            )))
            .bind(link_id.to_string())
            .bind(board)
            .bind(from.item_id.to_string())
            .bind(&from.element)
            .bind(to.item_id.to_string())
            .bind(&to.element)
            .bind(link_type)
            .bind(by)
            .bind(at)
            .execute(&mut **tx)
            .await
            .map_err(integrity)?;
        }
        Op::LinkSet { link_id, link_type } => {
            check_link_type(link_type)?;
            sqlx::query("UPDATE canvas_link SET link_type = ? WHERE id = ? AND canvas_id = ?")
                .bind(link_type)
                .bind(link_id.to_string())
                .bind(board)
                .execute(&mut **tx)
                .await?;
        }
        Op::LinkDelete { link_id } => {
            sqlx::query("DELETE FROM canvas_link WHERE id = ? AND canvas_id = ?")
                .bind(link_id.to_string())
                .bind(board)
                .execute(&mut **tx)
                .await?;
        }
    }
    Ok(())
}

fn no_item(item: &Uuid) -> ApiError {
    ApiError::bad_request(format!("no item {item} on this board")).titled("Operation references something that does not exist")
}

/// An item's kind and revision, or None when it is not on this board. Updates
/// treat None as nothing to do (the API's tolerance rule); creates refuse it.
async fn item_kind(tx: &mut Transaction<'_, Sqlite>, board: &str, item: &Uuid) -> ApiResult<Option<(String, i64)>> {
    Ok(sqlx::query_as("SELECT kind, revision FROM canvas_item WHERE id = ? AND canvas_id = ?")
        .bind(item.to_string())
        .bind(board)
        .fetch_optional(&mut **tx)
        .await?)
}

async fn set_body(tx: &mut Transaction<'_, Sqlite>, board: &str, item: &Uuid, body: &str) -> ApiResult<()> {
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE canvas_item SET body = ?, revision = revision + 1, updated_at = {NOW} WHERE id = ? AND canvas_id = ?"
    )))
    .bind(body)
    .bind(item.to_string())
    .bind(board)
    .execute(&mut **tx)
    .await
    .map_err(integrity)?;
    Ok(())
}

/// Reads a checklist inside the batch's transaction, or None when the item is
/// gone. The batch already holds SQLite's write lock (the revision bump runs
/// first), so read-modify-write here cannot interleave with another batch.
async fn checklist(tx: &mut Transaction<'_, Sqlite>, board: &str, item: &Uuid) -> ApiResult<Option<Checklist>> {
    let Some((kind, _)) = item_kind(tx, board, item).await? else { return Ok(None) };
    if kind != "checklist" {
        return Err(ApiError::bad_request(format!("item {item} is a {kind}, not a checklist")));
    }
    let body: String = sqlx::query_scalar("SELECT body FROM canvas_item WHERE id = ?").bind(item.to_string()).fetch_one(&mut **tx).await?;
    serde_json::from_str(&body).map(Some).map_err(|e| ApiError::internal(format!("checklist {item} is stored unreadably: {e}")))
}

async fn save_checklist(tx: &mut Transaction<'_, Sqlite>, board: &str, item: &Uuid, list: &Checklist) -> ApiResult<()> {
    let body = serde_json::to_string(list).unwrap();
    check_body(&body)?;
    set_body(tx, board, item, &body).await
}

/// Applies a batch atomically and returns the committed revision range.
///
/// The revision bump runs FIRST: it takes SQLite's write lock at the start of
/// the transaction, so a concurrent batch waits on `busy_timeout` rather than
/// failing on a read-to-write lock upgrade halfway through.
pub async fn apply(app: &AppState, board: &Uuid, ops: &[Op]) -> ApiResult<(i64, i64)> {
    let n = ops.len() as i64;
    let id = board.to_string();
    let mut tx = app.db.begin().await?;
    let to: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "UPDATE canvas SET revision = revision + ?, updated_at = {NOW} WHERE id = ? RETURNING revision"
    )))
    .bind(n)
    .bind(&id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| not_found(board))?;
    for op in ops {
        apply_one(&mut tx, &id, op).await?;
    }
    tx.commit().await?;
    Ok((to - n, to))
}

// --- handlers ---------------------------------------------------------------

#[derive(Deserialize)]
struct BoardTitle {
    title: String,
}

fn valid_title(title: &str) -> ApiResult<&str> {
    let t = title.trim();
    if t.is_empty() || title.chars().count() > 200 {
        return Err(ApiError::bad_request("a title must be 1–200 characters"));
    }
    Ok(title)
}

async fn find(app: &AppState, id: &str) -> ApiResult<Board> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!("SELECT {COLUMNS} FROM canvas WHERE id = ?")))
        .bind(id)
        .fetch_optional(&app.db)
        .await?
        .ok_or_else(|| not_found(id))
}

async fn list(State(app): State<AppState>) -> ApiResult<axum::Json<Vec<Board>>> {
    Ok(axum::Json(
        sqlx::query_as(sqlx::AssertSqlSafe(format!("SELECT {COLUMNS} FROM canvas ORDER BY updated_at DESC"))).fetch_all(&app.db).await?,
    ))
}

async fn create(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
    Json(body): Json<BoardTitle>,
) -> ApiResult<(StatusCode, axum::Json<Board>)> {
    let board = sqlx::query_as(sqlx::AssertSqlSafe(format!("INSERT INTO canvas (id, title, owner_id) VALUES (?, ?, ?) RETURNING {COLUMNS}")))
        .bind(new_id())
        .bind(valid_title(&body.title)?)
        .bind(&me.id)
        .fetch_one(&app.db)
        .await?;
    Ok((StatusCode::CREATED, axum::Json(board)))
}

async fn get_board(State(app): State<AppState>, Path(id): Path<Uuid>) -> ApiResult<axum::Json<Board>> {
    Ok(axum::Json(find(&app, &id.to_string()).await?))
}

async fn rename(State(app): State<AppState>, Path(id): Path<Uuid>, Json(body): Json<BoardTitle>) -> ApiResult<axum::Json<Board>> {
    let board: Option<Board> =
        sqlx::query_as(sqlx::AssertSqlSafe(format!("UPDATE canvas SET title = ?, updated_at = {NOW} WHERE id = ? RETURNING {COLUMNS}")))
            .bind(valid_title(&body.title)?)
            .bind(id.to_string())
            .fetch_optional(&app.db)
            .await?;
    Ok(axum::Json(board.ok_or_else(|| not_found(id))?))
}

async fn delete(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let board = find(&app, &id.to_string()).await?;
    if !me.admin && board.owner_id.as_deref() != Some(me.id.as_str()) {
        return Err(ApiError::forbidden("only the person who made this board, or an admin, can delete it"));
    }
    sqlx::query("DELETE FROM canvas WHERE id = ?").bind(&board.id).execute(&app.db).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Copies items and groups under fresh ids into a new board owned by the
/// caller. The images are shared, not copied.
async fn duplicate(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
    Path(id): Path<Uuid>,
    body: Bytes,
) -> ApiResult<(StatusCode, axum::Json<Board>)> {
    let requested: Option<String> = if body.is_empty() {
        None
    } else {
        serde_json::from_slice::<Option<BoardTitle>>(&body)
            .map_err(|e| ApiError::bad_request(e.to_string()))?
            .map(|b| b.title)
    };
    let source = find(&app, &id.to_string()).await?;
    let title = match requested.filter(|t| !t.trim().is_empty()) {
        Some(t) => valid_title(&t)?.to_string(),
        None => format!("{} copy", source.title),
    };
    let copy = new_id();
    let mut tx = app.db.begin().await?;
    sqlx::query("INSERT INTO canvas (id, title, owner_id) VALUES (?, ?, ?)")
        .bind(&copy)
        .bind(&title)
        .bind(&me.id)
        .execute(&mut *tx)
        .await?;
    let groups: Vec<(String, Option<String>, bool)> =
        sqlx::query_as("SELECT id, label, frame FROM canvas_group WHERE canvas_id = ?").bind(&source.id).fetch_all(&mut *tx).await?;
    let mut group_map = std::collections::HashMap::new();
    for (old, label, frame) in groups {
        let new = new_id();
        sqlx::query("INSERT INTO canvas_group (id, canvas_id, label, frame) VALUES (?, ?, ?, ?)")
            .bind(&new)
            .bind(&copy)
            .bind(label)
            .bind(frame)
            .execute(&mut *tx)
            .await?;
        group_map.insert(old, new);
    }
    let items: Vec<ItemRow> = sqlx::query_as(ITEMS_SQL).bind(&source.id).fetch_all(&mut *tx).await?;
    let mut item_map = std::collections::HashMap::new();
    for i in items {
        let new = new_id();
        item_map.insert(i.id.clone(), new.clone());
        sqlx::query(
            "INSERT INTO canvas_item (id, canvas_id, kind, asset_id, lang, body, group_id, x, y, width, height, rotation, z,
                                      opacity, flip_x, flip_y, crop_x, crop_y, crop_w, crop_h)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(new)
        .bind(&copy)
        .bind(&i.kind)
        .bind(&i.asset_id)
        .bind(&i.lang)
        .bind(&i.body)
        .bind(i.group_id.and_then(|g| group_map.get(&g).cloned()))
        .bind(i.x)
        .bind(i.y)
        .bind(i.width)
        .bind(i.height)
        .bind(i.rotation)
        .bind(i.z)
        .bind(i.opacity)
        .bind(i.flip_x)
        .bind(i.flip_y)
        .bind(i.crop_x)
        .bind(i.crop_y)
        .bind(i.crop_w)
        .bind(i.crop_h)
        .execute(&mut *tx)
        .await?;
    }
    // Links follow their items to the copy; both ends are on the source board,
    // so both are in the map.
    for l in links_of(&mut tx, &source.id).await? {
        sqlx::query(
            "INSERT INTO canvas_link (id, canvas_id, from_item, from_element, to_item, to_element, link_type, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(new_id())
        .bind(&copy)
        .bind(&item_map[&l.from_item])
        .bind(&l.from_element)
        .bind(&item_map[&l.to_item])
        .bind(&l.to_element)
        .bind(&l.link_type)
        .bind(&l.created_by)
        .bind(&l.created_at)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok((StatusCode::CREATED, axum::Json(find(&app, &copy).await?)))
}

#[derive(sqlx::FromRow)]
struct LinkRow {
    id: String,
    from_item: String,
    from_element: Option<String>,
    to_item: String,
    to_element: Option<String>,
    link_type: String,
    created_by: Option<String>,
    created_at: String,
}

async fn links_of(tx: &mut Transaction<'_, Sqlite>, board: &str) -> sqlx::Result<Vec<LinkRow>> {
    sqlx::query_as(
        "SELECT id, from_item, from_element, to_item, to_element, link_type, created_by, created_at
           FROM canvas_link WHERE canvas_id = ? ORDER BY created_at, id",
    )
    .bind(board)
    .fetch_all(&mut **tx)
    .await
}

#[derive(sqlx::FromRow)]
struct ItemRow {
    id: String,
    kind: String,
    lang: Option<String>,
    body: Option<String>,
    revision: i64,
    group_id: Option<String>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    rotation: f64,
    z: f64,
    opacity: f64,
    flip_x: bool,
    flip_y: bool,
    crop_x: Option<f64>,
    crop_y: Option<f64>,
    crop_w: Option<f64>,
    crop_h: Option<f64>,
    asset_id: Option<String>,
    intrinsic_width: Option<i64>,
    intrinsic_height: Option<i64>,
}

impl ItemRow {
    /// The item's content as canvas-core models it.
    fn content(&self) -> serde_json::Value {
        match self.kind.as_str() {
            "note" => json!({ "kind": "note", "source": self.body }),
            "diagram" => json!({ "kind": "diagram", "lang": self.lang, "source": self.body }),
            "checklist" => {
                let list: Checklist = serde_json::from_str(self.body.as_deref().unwrap_or_default())
                    .unwrap_or(Checklist { title: String::new(), tasks: vec![] });
                json!({ "kind": "checklist", "title": list.title, "tasks": list.tasks })
            }
            _ => json!({ "kind": "image", "asset": {
                "assetId": self.asset_id, "intrinsicWidth": self.intrinsic_width, "intrinsicHeight": self.intrinsic_height } }),
        }
    }
}

const ITEMS_SQL: &str = "SELECT i.id, i.kind, i.lang, i.body, i.revision, i.group_id, i.x, i.y, i.width, i.height, i.rotation, i.z,
                                i.opacity, i.flip_x, i.flip_y, i.crop_x, i.crop_y, i.crop_w, i.crop_h,
                                i.asset_id, a.width AS intrinsic_width, a.height AS intrinsic_height
                           FROM canvas_item i LEFT JOIN asset a ON a.id = i.asset_id
                          WHERE i.canvas_id = ? ORDER BY i.z";

/// Everything on the board in paint order, at one revision — read in one
/// transaction so the revision and the rows agree.
async fn snapshot(State(app): State<AppState>, Path(id): Path<Uuid>) -> ApiResult<axum::Json<serde_json::Value>> {
    Ok(axum::Json(snapshot_of(&app.db, &id.to_string()).await?))
}

/// The snapshot body, for members and for share-link viewers alike.
pub async fn snapshot_of(db: &sqlx::SqlitePool, id: &str) -> ApiResult<serde_json::Value> {
    let mut tx = db.begin().await?;
    let revision: i64 = sqlx::query_scalar("SELECT revision FROM canvas WHERE id = ?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| not_found(id))?;
    let rows: Vec<ItemRow> = sqlx::query_as(ITEMS_SQL).bind(id).fetch_all(&mut *tx).await?;
    let groups: Vec<(String, Option<String>, bool)> =
        sqlx::query_as("SELECT id, label, frame FROM canvas_group WHERE canvas_id = ?").bind(id).fetch_all(&mut *tx).await?;
    let link_rows = links_of(&mut tx, id).await?;
    let items: Vec<_> = rows.iter().map(|r| (r, r.content())).collect();
    // Display names for everyone the board credits, so a hover can say who
    // finished a task without a second request.
    let mut credited: Vec<&str> = link_rows.iter().filter_map(|l| l.created_by.as_deref()).collect();
    for (_, c) in &items {
        for t in c["tasks"].as_array().into_iter().flatten() {
            credited.extend(t["by"].as_str());
        }
    }
    let people: Vec<(String, String)> = sqlx::query_as("SELECT id, display_name FROM app_user WHERE id IN (SELECT value FROM json_each(?))")
        .bind(serde_json::to_string(&credited).unwrap())
        .fetch_all(&mut *tx)
        .await?;
    tx.commit().await?;

    let mut members: std::collections::HashMap<&str, Vec<&str>> = Default::default();
    for r in &rows {
        if let Some(g) = &r.group_id {
            members.entry(g).or_default().push(&r.id);
        }
    }
    let groups: Vec<_> = groups
        .iter()
        .map(|(gid, label, frame)| {
            json!({ "id": gid, "label": label, "frame": frame, "memberIds": members.get(gid.as_str()).cloned().unwrap_or_default() })
        })
        .collect();
    let items: Vec<_> = items
        .into_iter()
        .map(|(r, content)| {
            let mut item = json!({
                "id": r.id,
                "transform": { "x": r.x, "y": r.y, "width": r.width, "height": r.height, "rotation": r.rotation },
                "z": r.z,
                "revision": r.revision,
                "groupId": r.group_id,
                "content": content,
                "appearance": { "opacity": r.opacity, "flipX": r.flip_x, "flipY": r.flip_y },
            });
            // Absent is the whole image; the CHECK keeps the four all-or-nothing.
            if let (Some(x), Some(y), Some(w), Some(h)) = (r.crop_x, r.crop_y, r.crop_w, r.crop_h) {
                item["crop"] = json!({ "x": x, "y": y, "width": w, "height": h });
            }
            item
        })
        .collect();
    let links: Vec<_> = link_rows
        .iter()
        .map(|l| {
            json!({
                "id": l.id,
                "from": { "itemId": l.from_item, "element": l.from_element },
                "to": { "itemId": l.to_item, "element": l.to_element },
                "linkType": l.link_type, "by": l.created_by, "at": l.created_at,
            })
        })
        .collect();
    let people: serde_json::Map<String, serde_json::Value> = people.into_iter().map(|(id, name)| (id, json!(name))).collect();
    Ok(json!({ "revision": revision, "items": items, "groups": groups, "links": links, "people": people }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PostedOperation {
    #[allow(dead_code)]
    operation_id: Option<Uuid>,
    #[allow(dead_code)]
    #[serde(default)]
    base_revision: i64,
    body: Op,
}

#[derive(Deserialize)]
struct Batch {
    operations: Vec<PostedOperation>,
}

async fn operations(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(batch): Json<Batch>,
) -> ApiResult<axum::Json<serde_json::Value>> {
    if batch.operations.is_empty() {
        return Err(ApiError::bad_request("a batch needs at least one operation"));
    }
    // Who and when come from the session, never from the body.
    let at: String = sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT {NOW}"))).fetch_one(&app.db).await?;
    let mut ops: Vec<Op> = batch.operations.into_iter().map(|p| p.body).collect();
    for op in &mut ops {
        op.stamp(&me.id, &at);
    }
    let (from, to) = apply(&app, &id, &ops).await?;
    // The author already applied these optimistically; everyone else hears them,
    // stamped. The author takes the stamps from the applied bodies returned here.
    let actor = headers.get(ACTOR_HEADER).and_then(|v| v.to_str().ok()).and_then(|v| Uuid::parse_str(v).ok());
    app.rooms.announce(&id, actor, from, to, &ops);
    Ok(axum::Json(json!({ "revision": to, "operations": ops })))
}
