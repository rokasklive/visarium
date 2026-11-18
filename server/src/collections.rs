//! Logical collections: rows, not directories. An asset may be in many, and
//! adding it to one moves no bytes.

use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::auth::User;
use crate::error::{ApiError, ApiResult, Json, is_unique_violation};
use crate::{AppState, new_id};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/collections", get(list).post(create))
        .route("/collections/{id}", get(get_one).patch(rename).delete(delete))
        .route("/collections/{id}/assets", put(add_many).delete(remove_many))
        .route("/collections/{id}/assets/{asset_id}", put(add_one).delete(remove_one))
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct Collection {
    id: String,
    name: String,
    owner_id: Option<String>,
    asset_count: i64,
    created_at: String,
}

const SELECT: &str = "SELECT c.id, c.name, c.owner_id, c.created_at,
                             (SELECT count(*) FROM asset_collection ac WHERE ac.collection_id = c.id) AS asset_count
                        FROM collection c";

fn not_found(id: impl std::fmt::Display) -> ApiError {
    ApiError::not_found(format!("no collection {id}"))
}

fn taken(e: sqlx::Error) -> ApiError {
    if is_unique_violation(&e) {
        ApiError::conflict("a collection with this name already exists").titled("That collection name is taken")
    } else {
        e.into()
    }
}

#[derive(Deserialize)]
struct CollectionName {
    name: String,
}

fn valid_name(name: &str) -> ApiResult<&str> {
    if name.trim().is_empty() || name.chars().count() > 200 {
        return Err(ApiError::bad_request("a collection name must be 1–200 characters"));
    }
    Ok(name)
}

async fn find(app: &AppState, id: &str) -> ApiResult<Collection> {
    sqlx::query_as(&format!("{SELECT} WHERE c.id = ?")).bind(id).fetch_optional(&app.db).await?.ok_or_else(|| not_found(id))
}

async fn require_exists(app: &AppState, id: &Uuid) -> ApiResult<String> {
    let id = id.to_string();
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM collection WHERE id = ?)").bind(&id).fetch_one(&app.db).await?;
    if exists { Ok(id) } else { Err(not_found(id)) }
}

async fn list(State(app): State<AppState>) -> ApiResult<axum::Json<Vec<Collection>>> {
    Ok(axum::Json(sqlx::query_as(&format!("{SELECT} ORDER BY c.name")).fetch_all(&app.db).await?))
}

async fn create(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
    Json(body): Json<CollectionName>,
) -> ApiResult<(StatusCode, axum::Json<Collection>)> {
    let id = new_id();
    sqlx::query("INSERT INTO collection (id, name, owner_id) VALUES (?, ?, ?)")
        .bind(&id)
        .bind(valid_name(&body.name)?)
        .bind(&me.id)
        .execute(&app.db)
        .await
        .map_err(taken)?;
    Ok((StatusCode::CREATED, axum::Json(find(&app, &id).await?)))
}

async fn get_one(State(app): State<AppState>, Path(id): Path<Uuid>) -> ApiResult<axum::Json<Collection>> {
    Ok(axum::Json(find(&app, &id.to_string()).await?))
}

async fn rename(
    State(app): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<CollectionName>,
) -> ApiResult<axum::Json<Collection>> {
    let id = id.to_string();
    let done = sqlx::query("UPDATE collection SET name = ? WHERE id = ?")
        .bind(valid_name(&body.name)?)
        .bind(&id)
        .execute(&app.db)
        .await
        .map_err(taken)?;
    if done.rows_affected() == 0 {
        return Err(not_found(id));
    }
    Ok(axum::Json(find(&app, &id).await?))
}

async fn delete(State(app): State<AppState>, Path(id): Path<Uuid>) -> ApiResult<StatusCode> {
    let done = sqlx::query("DELETE FROM collection WHERE id = ?").bind(id.to_string()).execute(&app.db).await?;
    if done.rows_affected() == 0 {
        return Err(not_found(id));
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn require_asset(app: &AppState, asset: &Uuid) -> ApiResult<String> {
    let id = asset.to_string();
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM asset WHERE id = ?)").bind(&id).fetch_one(&app.db).await?;
    if exists { Ok(id) } else { Err(ApiError::not_found(format!("no asset {id}"))) }
}

/// Already a member is success, not conflict.
async fn add_one(State(app): State<AppState>, Path((id, asset)): Path<(Uuid, Uuid)>) -> ApiResult<StatusCode> {
    let id = require_exists(&app, &id).await?;
    let asset = require_asset(&app, &asset).await?;
    sqlx::query("INSERT OR IGNORE INTO asset_collection (collection_id, asset_id) VALUES (?, ?)")
        .bind(id)
        .bind(asset)
        .execute(&app.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn remove_one(State(app): State<AppState>, Path((id, asset)): Path<(Uuid, Uuid)>) -> ApiResult<StatusCode> {
    let id = require_exists(&app, &id).await?;
    let asset = require_asset(&app, &asset).await?;
    sqlx::query("DELETE FROM asset_collection WHERE collection_id = ? AND asset_id = ?")
        .bind(id)
        .bind(asset)
        .execute(&app.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssetIds {
    asset_ids: Vec<Uuid>,
}

/// The requested ids that match no asset, so the client can say which.
async fn skipped(app: &AppState, ids: &str) -> sqlx::Result<Vec<String>> {
    sqlx::query_scalar("SELECT value FROM json_each(?) WHERE value NOT IN (SELECT id FROM asset)")
        .bind(ids)
        .fetch_all(&app.db)
        .await
}

fn ids_json(body: &AssetIds) -> ApiResult<String> {
    if body.asset_ids.is_empty() {
        return Err(ApiError::bad_request("assetIds must not be empty"));
    }
    Ok(serde_json::to_string(&body.asset_ids).unwrap())
}

async fn add_many(
    State(app): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<AssetIds>,
) -> ApiResult<axum::Json<serde_json::Value>> {
    let id = require_exists(&app, &id).await?;
    let ids = ids_json(&body)?;
    sqlx::query(
        "INSERT OR IGNORE INTO asset_collection (collection_id, asset_id)
         SELECT ?, a.id FROM asset a WHERE a.id IN (SELECT value FROM json_each(?))",
    )
    .bind(&id)
    .bind(&ids)
    .execute(&app.db)
    .await?;
    Ok(axum::Json(json!({ "skipped": skipped(&app, &ids).await? })))
}

async fn remove_many(
    State(app): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<AssetIds>,
) -> ApiResult<axum::Json<serde_json::Value>> {
    let id = require_exists(&app, &id).await?;
    let ids = ids_json(&body)?;
    sqlx::query("DELETE FROM asset_collection WHERE collection_id = ? AND asset_id IN (SELECT value FROM json_each(?))")
        .bind(&id)
        .bind(&ids)
        .execute(&app.db)
        .await?;
    Ok(axum::Json(json!({ "skipped": skipped(&app, &ids).await? })))
}
