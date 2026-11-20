//! Read-only share links for one board (ADR-0026).
//!
//! A link is `{origin}/s#{token}`. The fragment never leaves the browser, so
//! the token stays out of access logs and `Referer`. The SPA redeems it with a
//! POST for a share session cookie that ends no later than the link.
//!
//! What a viewer can reach is decided by where routes are mounted: the
//! routes in `viewer_routes` and `/ws/shared`, all of them reads, scoped to
//! the link's board. `require_user` admits no viewer, so every other route
//! refuses them without a check of its own. **Nothing that writes may be
//! mounted in `viewer_routes`.**

use axum::Router;
use axum::extract::{Path, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::auth::{self, Kind, Principal, SHARE, User};
use crate::error::{ApiError, ApiResult, Json};
use crate::{AppState, NOW, new_id};

/// The expiry presets a member can pick, in days. `None` is permanent.
pub const EXPIRY_DAYS: [i64; 3] = [1, 7, 30];
const MIN_PASSPHRASE_CHARS: usize = 4;

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ShareLink {
    pub id: String,
    pub canvas_id: String,
    pub label: Option<String>,
    pub created_by: Option<String>,
    pub created_by_name: Option<String>,
    pub created_at: String,
    pub expires_at: Option<String>,
    pub has_passphrase: bool,
    pub revoked_at: Option<String>,
    pub last_used_at: Option<String>,
}

const LINK_SQL: &str = "SELECT l.id, l.canvas_id, l.label, l.created_by, u.display_name AS created_by_name, l.created_at, \
                               l.expires_at, l.passphrase_hash IS NOT NULL AS has_passphrase, l.revoked_at, l.last_used_at \
                          FROM share_link l LEFT JOIN app_user u ON u.id = l.created_by";

fn active() -> String {
    format!("l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > {NOW})")
}

/// The link, if it may still be used. Checked on every viewer request, not
/// only when the link is redeemed.
pub async fn active_link(db: &sqlx::SqlitePool, id: &str) -> sqlx::Result<Option<ShareLink>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{LINK_SQL} WHERE l.id = ? AND {}",
        active()
    )))
    .bind(id)
    .fetch_optional(db)
    .await
}

fn require_sharing(app: &AppState) -> ApiResult<()> {
    if app.local_user.is_some() || app.config.sharing_disabled {
        return Err(ApiError::not_found(
            "sharing is turned off on this instance",
        ));
    }
    Ok(())
}

// --- members: making and revoking links -------------------------------------

pub fn member_routes() -> Router<AppState> {
    Router::new()
        .route("/boards/{id}/shares", get(list_for_board).post(create))
        .route("/shares", get(list_all))
        .route("/shares/{id}", delete(revoke).patch(change_passphrase))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewShare {
    label: Option<String>,
    /// 1, 7 or 30; absent or null for a link that does not expire.
    expires_in_days: Option<i64>,
    passphrase: Option<String>,
}

async fn hash_passphrase(passphrase: Option<String>) -> ApiResult<Option<String>> {
    match passphrase.filter(|p| !p.is_empty()) {
        None => Ok(None),
        Some(p) if p.chars().count() < MIN_PASSPHRASE_CHARS => Err(ApiError::bad_request(format!(
            "a passphrase must be at least {MIN_PASSPHRASE_CHARS} characters"
        ))),
        Some(p) if p.len() > 1024 => Err(ApiError::bad_request(
            "a passphrase must be at most 1024 bytes",
        )),
        Some(p) => Ok(Some(auth::hash_password(p).await?)),
    }
}

async fn create(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
    Path(board): Path<Uuid>,
    Json(body): Json<NewShare>,
) -> ApiResult<(StatusCode, axum::Json<serde_json::Value>)> {
    require_sharing(&app)?;
    if !crate::boards::exists(&app.db, &board).await? {
        return Err(ApiError::not_found(format!("no board {board}")));
    }
    let expires = match body.expires_in_days {
        None => None,
        Some(d) if EXPIRY_DAYS.contains(&d) => Some(format!("+{d} days")),
        Some(d) => {
            return Err(ApiError::bad_request(format!(
                "a link expires after {EXPIRY_DAYS:?} days or never, not {d}"
            )));
        }
    };
    let label = body
        .label
        .as_deref()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(|l| l.chars().take(80).collect::<String>());
    let passphrase = hash_passphrase(body.passphrase).await?;
    let token = auth::random_token();
    let id = new_id();
    sqlx::query(
        "INSERT INTO share_link (id, canvas_id, token_hash, label, created_by, expires_at, passphrase_hash) \
         VALUES (?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) END, ?)",
    )
    .bind(&id)
    .bind(board.to_string())
    .bind(auth::hash_token(&token))
    .bind(&label)
    .bind(&me.id)
    .bind(&expires)
    .bind(&expires)
    .bind(&passphrase)
    .execute(&app.db)
    .await?;
    let link: ShareLink = sqlx::query_as(sqlx::AssertSqlSafe(format!("{LINK_SQL} WHERE l.id = ?")))
        .bind(&id)
        .fetch_one(&app.db)
        .await?;
    tracing::info!(share = %id, board = %board, by = %me.id, "share link created");
    // The only time the token exists outside the person who shares it.
    let mut out = serde_json::to_value(link).unwrap();
    out["link"] = json!(format!("/s#{token}"));
    Ok((StatusCode::CREATED, axum::Json(out)))
}

/// A board's links that still work, with how many people hold each open.
async fn list_for_board(
    State(app): State<AppState>,
    Path(board): Path<Uuid>,
) -> ApiResult<axum::Json<Vec<ShareLink>>> {
    require_sharing(&app)?;
    Ok(axum::Json(
        sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "{LINK_SQL} WHERE l.canvas_id = ? AND {} ORDER BY l.created_at DESC",
            active()
        )))
        .bind(board.to_string())
        .fetch_all(&app.db)
        .await?,
    ))
}

/// Every working link on the instance: moderators and admins.
async fn list_all(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
) -> ApiResult<axum::Json<Vec<ShareLink>>> {
    require_sharing(&app)?;
    auth::require_role(&me, auth::Role::Moderator)?;
    Ok(axum::Json(
        sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "{LINK_SQL} WHERE {} ORDER BY l.created_at DESC",
            active()
        )))
        .fetch_all(&app.db)
        .await?,
    ))
}

/// Ends a link's viewers at once: their sessions, and their open sockets.
async fn end_viewers(app: &AppState, id: &str) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM session WHERE share_id = ?")
        .bind(id)
        .execute(&app.db)
        .await?;
    app.rooms.close_share(id);
    Ok(())
}

async fn revoke(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    require_sharing(&app)?;
    let id = id.to_string();
    let done = sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE share_link SET revoked_at = {NOW} WHERE id = ? AND revoked_at IS NULL"
    )))
    .bind(&id)
    .execute(&app.db)
    .await?;
    if done.rows_affected() == 0 {
        return Err(ApiError::not_found(format!("no active link {id}")));
    }
    end_viewers(&app, &id).await?;
    tracing::info!(share = %id, by = %me.id, "share link revoked");
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct PassphraseChange {
    /// A new passphrase, or null to remove it.
    passphrase: Option<String>,
}

/// Changing or removing a passphrase ends the link's viewers, the same as
/// revoking: whoever was let in by the old one has to come in by the new one.
async fn change_passphrase(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
    Path(id): Path<Uuid>,
    Json(body): Json<PassphraseChange>,
) -> ApiResult<axum::Json<ShareLink>> {
    require_sharing(&app)?;
    let id = id.to_string();
    let hash = hash_passphrase(body.passphrase).await?;
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE share_link SET passphrase_hash = ? WHERE id = ? AND {}",
        active().replace("l.", "")
    )))
    .bind(&hash)
    .bind(&id)
    .execute(&app.db)
    .await?;
    let link = active_link(&app.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("no active link {id}")))?;
    end_viewers(&app, &id).await?;
    tracing::info!(share = %id, board = %link.canvas_id, by = %me.id, "share link passphrase changed; viewers ended");
    Ok(axum::Json(link))
}

// --- viewers ----------------------------------------------------------------

#[derive(Deserialize)]
pub struct Redeem {
    token: String,
    passphrase: Option<String>,
}

#[derive(sqlx::FromRow)]
struct Secret {
    id: String,
    canvas_id: String,
    expires_at: Option<String>,
    passphrase_hash: Option<String>,
    live: bool,
    expired: bool,
}

/// Trades a share token (and passphrase, if the link has one) for a share
/// session. A member of this instance is told the board's id instead, and the
/// SPA takes them to the board itself.
pub async fn redeem(
    State(app): State<AppState>,
    headers: HeaderMap,
    axum::Extension(principal): axum::Extension<Principal>,
    Json(body): Json<Redeem>,
) -> ApiResult<Response> {
    require_sharing(&app)?;
    let secret: Option<Secret> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT id, canvas_id, expires_at, passphrase_hash, revoked_at IS NULL AS live, \
                expires_at IS NOT NULL AND expires_at <= {NOW} AS expired \
           FROM share_link WHERE token_hash = ?"
    )))
    .bind(auth::hash_token(&body.token))
    .fetch_optional(&app.db)
    .await?;
    let gone = |code: &str, detail: &str| {
        ApiError::new(StatusCode::GONE, detail)
            .titled("Link not active")
            .with("code", json!(code))
    };
    let secret = match secret {
        None => return Err(gone("invalid", "this link is not valid")),
        Some(s) if !s.live => return Err(gone("revoked", "this link is no longer active")),
        Some(s) if s.expired => return Err(gone("expired", "this link has expired")),
        Some(s) => s,
    };
    if principal.user().is_some() {
        return Ok(
            axum::Json(json!({ "member": true, "boardId": secret.canvas_id })).into_response(),
        );
    }
    // A locked link says that it is locked, and nothing else: no title, no
    // owner. Wrong guesses slow down this link and no other.
    if let Some(hash) = secret.passphrase_hash {
        let key = format!("share:{}", secret.id);
        let Some(passphrase) = body.passphrase.filter(|p| !p.is_empty()) else {
            return Err(ApiError::unauthorized("this link needs a passphrase")
                .titled("Passphrase required")
                .with("passphraseRequired", json!(true)));
        };
        tokio::time::sleep(app.throttle.delay(&key)).await;
        if auth::verify_password(passphrase, Some(hash)).await == auth::Verified::No {
            tracing::warn!(share = %secret.id, reason = "bad passphrase", "share link refused");
            app.throttle.failed(&key);
            return Err(ApiError::unauthorized("that passphrase is not right")
                .titled("Passphrase required")
                .with("passphraseRequired", json!(true)));
        }
        app.throttle.succeeded(&key);
    }
    if let Some(old) = principal.session_hash() {
        auth::end_session(&app.db, old).await?;
    }
    let token = auth::create_session(
        &app.db,
        Kind::Share,
        None,
        Some(&secret.id),
        secret.expires_at.as_deref(),
        None,
    )
    .await?;
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE share_link SET last_used_at = {NOW} WHERE id = ?"
    )))
    .bind(&secret.id)
    .execute(&app.db)
    .await?;
    let link = active_link(&app.db, &secret.id)
        .await?
        .ok_or_else(|| gone("revoked", "this link is no longer active"))?;
    tracing::info!(share = %link.id, board = %link.canvas_id, "share link opened");
    let title: Option<String> = sqlx::query_scalar("SELECT title FROM canvas WHERE id = ?")
        .bind(&link.canvas_id)
        .fetch_optional(&app.db)
        .await?;
    let mut response = axum::Json(json!({ "member": false, "boardId": link.canvas_id, "title": title, "sharedBy": link.created_by_name }))
        .into_response();
    let max_age = auth::SHARE_SESSION_IDLE_SECS;
    response.headers_mut().append(
        header::SET_COOKIE,
        SHARE.set(&token, auth::is_secure(&headers), max_age),
    );
    Ok(response)
}

/// Read handlers only, every one scoped to the link's board.
pub fn viewer_routes() -> Router<AppState> {
    Router::new()
        .route("/shared/board", get(board))
        .route("/shared/assets/{id}/derivatives/{width}", get(derivative))
}

/// Applied to everything a viewer is served: never indexed, never leaking the
/// page address onwards, and the snapshot never cached by anything shared.
pub async fn private_headers(req: Request, next: Next) -> Response {
    let mut response = next.run(req).await;
    let h = response.headers_mut();
    h.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    h.insert("x-robots-tag", HeaderValue::from_static("noindex"));
    h.entry(header::CACHE_CONTROL)
        .or_insert(HeaderValue::from_static("private, no-store"));
    response
}

async fn board(
    State(app): State<AppState>,
    axum::Extension(link): axum::Extension<ShareLink>,
) -> ApiResult<Response> {
    let title: String = sqlx::query_scalar("SELECT title FROM canvas WHERE id = ?")
        .bind(&link.canvas_id)
        .fetch_one(&app.db)
        .await?;
    let mut snapshot = crate::boards::snapshot_of(&app.db, &link.canvas_id).await?;
    // Collaborators' names are for members; a link viewer sees the work, not who did it.
    snapshot.as_object_mut().map(|s| s.remove("people"));
    snapshot["id"] = json!(link.canvas_id);
    snapshot["title"] = json!(title);
    snapshot["sharedBy"] = json!(link.created_by_name);
    snapshot["expiresAt"] = json!(link.expires_at);
    let mut response = axum::Json(snapshot).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    Ok(response)
}

/// A derivative of an image that is on the shared board right now. Anything
/// else in the library is a 404, indistinguishable from not existing.
async fn derivative(
    State(app): State<AppState>,
    axum::Extension(link): axum::Extension<ShareLink>,
    Path((id, width)): Path<(Uuid, u32)>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let on_board: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM canvas_item WHERE canvas_id = ? AND asset_id = ?)",
    )
    .bind(&link.canvas_id)
    .bind(id.to_string())
    .fetch_one(&app.db)
    .await?;
    if !on_board {
        return Err(ApiError::not_found(format!("no asset {id}")));
    }
    let mut response = crate::assets::serve_derivative(&app, &id, width, &headers).await?;
    // The derivative's own long cache is right for members; a viewer's copy
    // must not outlive their access in a shared cache.
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=3600"),
    );
    Ok(response)
}
