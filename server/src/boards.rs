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

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Content {
    pub kind: Option<String>,
    pub asset: Option<AssetRef>,
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
    },
    #[serde(rename = "item.delete", rename_all = "camelCase")]
    ItemDelete { item_id: Uuid },
    #[serde(rename = "item.transform", rename_all = "camelCase")]
    ItemTransform { item_id: Uuid, transform: Transform },
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
}

fn check_appearance(a: &Appearance) -> ApiResult<()> {
    if (0.0..=1.0).contains(&a.opacity) {
        Ok(())
    } else {
        Err(ApiError::bad_request("opacity must be between 0 and 1"))
    }
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
    sqlx::query(&format!(
        "UPDATE canvas_item SET group_id = ?, updated_at = {NOW}
          WHERE canvas_id = ? AND id IN (SELECT value FROM json_each(?))"
    ))
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
        Op::ItemCreate { item_id, transform: t, z, content, group_id, appearance } => {
            let a = appearance.clone().unwrap_or(Appearance { opacity: 1.0, flip_x: false, flip_y: false });
            check_appearance(&a)?;
            sqlx::query(
                "INSERT INTO canvas_item (id, canvas_id, asset_id, group_id, x, y, width, height, rotation, z,
                                          opacity, flip_x, flip_y)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (id) DO NOTHING",
            )
            .bind(item_id.to_string())
            .bind(board)
            .bind(content.asset_id()?)
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
        Op::ItemTransform { item_id, transform: t } => {
            sqlx::query(&format!(
                "UPDATE canvas_item SET x = ?, y = ?, width = ?, height = ?, rotation = ?, {bump}
                  WHERE id = ? AND canvas_id = ?"
            ))
            .bind(t.x)
            .bind(t.y)
            .bind(t.width)
            .bind(t.height)
            .bind(t.rotation)
            .bind(item_id.to_string())
            .bind(board)
            .execute(&mut **tx)
            .await
            .map_err(integrity)?;
        }
        Op::ItemContent { item_id, content } => {
            sqlx::query(&format!("UPDATE canvas_item SET asset_id = ?, {bump} WHERE id = ? AND canvas_id = ?"))
                .bind(content.asset_id()?)
                .bind(item_id.to_string())
                .bind(board)
                .execute(&mut **tx)
                .await
                .map_err(integrity)?;
        }
        Op::ItemZ { item_id, z } => {
            sqlx::query(&format!("UPDATE canvas_item SET z = ?, {bump} WHERE id = ? AND canvas_id = ?"))
                .bind(z)
                .bind(item_id.to_string())
                .bind(board)
                .execute(&mut **tx)
                .await?;
        }
        Op::ItemAppearance { item_id, appearance: a } => {
            check_appearance(a)?;
            sqlx::query(&format!(
                "UPDATE canvas_item SET opacity = ?, flip_x = ?, flip_y = ?, {bump} WHERE id = ? AND canvas_id = ?"
            ))
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
    }
    Ok(())
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
    let to: i64 = sqlx::query_scalar(&format!(
        "UPDATE canvas SET revision = revision + ?, updated_at = {NOW} WHERE id = ? RETURNING revision"
    ))
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
    sqlx::query_as(&format!("SELECT {COLUMNS} FROM canvas WHERE id = ?"))
        .bind(id)
        .fetch_optional(&app.db)
        .await?
        .ok_or_else(|| not_found(id))
}

async fn list(State(app): State<AppState>) -> ApiResult<axum::Json<Vec<Board>>> {
    Ok(axum::Json(
        sqlx::query_as(&format!("SELECT {COLUMNS} FROM canvas ORDER BY updated_at DESC")).fetch_all(&app.db).await?,
    ))
}

async fn create(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
    Json(body): Json<BoardTitle>,
) -> ApiResult<(StatusCode, axum::Json<Board>)> {
    let board = sqlx::query_as(&format!("INSERT INTO canvas (id, title, owner_id) VALUES (?, ?, ?) RETURNING {COLUMNS}"))
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
        sqlx::query_as(&format!("UPDATE canvas SET title = ?, updated_at = {NOW} WHERE id = ? RETURNING {COLUMNS}"))
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
    for i in items {
        sqlx::query(
            "INSERT INTO canvas_item (id, canvas_id, asset_id, group_id, x, y, width, height, rotation, z,
                                      opacity, flip_x, flip_y)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(new_id())
        .bind(&copy)
        .bind(&i.asset_id)
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
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok((StatusCode::CREATED, axum::Json(find(&app, &copy).await?)))
}

#[derive(sqlx::FromRow)]
struct ItemRow {
    id: String,
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
    asset_id: String,
    intrinsic_width: i64,
    intrinsic_height: i64,
}

const ITEMS_SQL: &str = "SELECT i.id, i.group_id, i.x, i.y, i.width, i.height, i.rotation, i.z,
                                i.opacity, i.flip_x, i.flip_y,
                                i.asset_id, a.width AS intrinsic_width, a.height AS intrinsic_height
                           FROM canvas_item i JOIN asset a ON a.id = i.asset_id
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
    let items: Vec<_> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.id,
                "transform": { "x": r.x, "y": r.y, "width": r.width, "height": r.height, "rotation": r.rotation },
                "z": r.z,
                "groupId": r.group_id,
                "content": { "kind": "image", "asset": {
                    "assetId": r.asset_id, "intrinsicWidth": r.intrinsic_width, "intrinsicHeight": r.intrinsic_height } },
                "appearance": { "opacity": r.opacity, "flipX": r.flip_x, "flipY": r.flip_y },
            })
        })
        .collect();
    Ok(json!({ "revision": revision, "items": items, "groups": groups }))
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
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(batch): Json<Batch>,
) -> ApiResult<axum::Json<serde_json::Value>> {
    if batch.operations.is_empty() {
        return Err(ApiError::bad_request("a batch needs at least one operation"));
    }
    let ops: Vec<Op> = batch.operations.into_iter().map(|p| p.body).collect();
    let (from, to) = apply(&app, &id, &ops).await?;
    // The author already applied these optimistically; everyone else hears them.
    let actor = headers.get(ACTOR_HEADER).and_then(|v| v.to_str().ok()).and_then(|v| Uuid::parse_str(v).ok());
    app.rooms.announce(&id, actor, from, to, &ops);
    Ok(axum::Json(json!({ "revision": to })))
}
