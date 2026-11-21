//! Invitations (ADR-0025): after first run, an account comes into being only
//! by redeeming one. An admin makes a link, copies it and sends it however
//! they like; there is no email. The same table carries one-time
//! password-reset links.
//!
//! The token travels in the link's fragment (`/invite#…`), which browsers
//! never send, and reaches the server only in POST bodies, so it never lands
//! in an access log. Only its hash is stored.

use axum::Router;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::auth::{self, Kind, Principal, Role, User};
use crate::error::{ApiError, ApiResult, Json};
use crate::oidc::{self, Intent};
use crate::{AppState, NOW, new_id};

pub const JOIN_SECS: i64 = 7 * 86_400;
pub const RESET_SECS: i64 = 86_400;

/// Moderators and admins: make, list and revoke. A moderator's reach is
/// members only (`auth::require_staff_over`).
pub fn admin_routes() -> Router<AppState> {
    Router::new()
        .route("/invitations", get(list).post(create))
        .route("/invitations/{id}", delete(revoke))
}

/// Open: what a link is, and redeeming it.
pub fn public_routes() -> Router<AppState> {
    Router::new()
        .route("/invitations/inspect", post(inspect))
        .route("/invitations/redeem", post(redeem))
        .route("/invitations/redeem/{provider}", post(redeem_with_provider))
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct InvitationView {
    id: String,
    purpose: String,
    role: Role,
    /// `role == admin`, for clients that predate roles.
    admin: bool,
    note: Option<String>,
    /// reset: whose password.
    username: Option<String>,
    created_at: String,
    expires_at: String,
}

const VIEW_SQL: &str = "SELECT i.id, i.purpose, i.role, i.role = 'admin' AS admin, i.note, u.username, i.created_at, i.expires_at \
                          FROM invitation i LEFT JOIN app_user u ON u.id = i.user_id";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewInvitation {
    purpose: Option<String>,
    /// join: the new account's role. `admin: true` is the older spelling.
    role: Option<Role>,
    #[serde(default)]
    admin: bool,
    note: Option<String>,
    /// reset: the member whose password the link resets.
    user_id: Option<Uuid>,
}

async fn create(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
    Json(body): Json<NewInvitation>,
) -> ApiResult<(StatusCode, axum::Json<serde_json::Value>)> {
    let role = body.role.unwrap_or(if body.admin {
        Role::Admin
    } else {
        Role::Member
    });
    let note = body
        .note
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(|n| n.chars().take(120).collect::<String>());
    let (purpose, user_id, secs) = match body.purpose.as_deref().unwrap_or("join") {
        "join" => ("join", None, JOIN_SECS),
        "reset" => {
            let id = body
                .user_id
                .ok_or_else(|| ApiError::bad_request("a reset link needs the account it resets"))?
                .to_string();
            let user = auth::find_user(&app.db, &id)
                .await?
                .ok_or_else(|| ApiError::not_found(format!("no account {id}")))?;
            auth::require_staff_over(&me, user.role)?;
            if user.deactivated_at.is_some() {
                return Err(ApiError::conflict("that account is deactivated"));
            }
            ("reset", Some(id), RESET_SECS)
        }
        other => {
            return Err(ApiError::bad_request(format!(
                "'{other}' is not an invitation purpose; use join or reset"
            )));
        }
    };
    if purpose == "join" {
        auth::require_staff_over(&me, role)?;
    }
    let token = auth::random_token();
    let id = new_id();
    sqlx::query(
        "INSERT INTO invitation (id, token_hash, purpose, user_id, role, note, created_by, expires_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?))",
    )
    .bind(&id)
    .bind(auth::hash_token(&token))
    .bind(purpose)
    .bind(&user_id)
    .bind(if purpose == "join" { role } else { Role::Member })
    .bind(&note)
    .bind(&me.id)
    .bind(format!("+{secs} seconds"))
    .execute(&app.db)
    .await?;
    let view: InvitationView =
        sqlx::query_as(sqlx::AssertSqlSafe(format!("{VIEW_SQL} WHERE i.id = ?")))
            .bind(&id)
            .fetch_one(&app.db)
            .await?;
    tracing::info!(invitation = %id, purpose, role = role.as_str(), by = %me.id, "invitation created");
    // The only time the token exists outside the invitee's hands.
    let mut out = serde_json::to_value(view).unwrap();
    out["link"] = json!(format!("/invite#{token}"));
    Ok((StatusCode::CREATED, axum::Json(out)))
}

/// Unused and unexpired, newest first.
async fn list(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
) -> ApiResult<axum::Json<Vec<InvitationView>>> {
    auth::require_role(&me, Role::Moderator)?;
    Ok(axum::Json(
        sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "{VIEW_SQL} WHERE i.used_at IS NULL AND i.expires_at > {NOW} ORDER BY i.created_at DESC"
        )))
        .fetch_all(&app.db)
        .await?,
    ))
}

async fn revoke(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    // Whose rank the link carries: the joiner's role, or the reset account's.
    let target: Option<Role> = sqlx::query_scalar(
        "SELECT CASE WHEN i.purpose = 'reset' THEN u.role ELSE i.role END \
           FROM invitation i LEFT JOIN app_user u ON u.id = i.user_id \
          WHERE i.id = ? AND i.used_at IS NULL",
    )
    .bind(id.to_string())
    .fetch_optional(&app.db)
    .await?
    .flatten();
    let Some(target) = target else {
        return Err(ApiError::not_found(format!("no unused invitation {id}")));
    };
    auth::require_staff_over(&me, target)?;
    let done = sqlx::query("DELETE FROM invitation WHERE id = ? AND used_at IS NULL")
        .bind(id.to_string())
        .execute(&app.db)
        .await?;
    if done.rows_affected() == 0 {
        return Err(ApiError::not_found(format!("no unused invitation {id}")));
    }
    tracing::info!(invitation = %id, by = %me.id, "invitation revoked");
    Ok(StatusCode::NO_CONTENT)
}

// --- redeeming --------------------------------------------------------------

#[derive(Debug, sqlx::FromRow)]
struct Row {
    id: String,
    purpose: String,
    user_id: Option<String>,
    role: Role,
    note: Option<String>,
    expires_at: String,
    used: bool,
    expired: bool,
}

async fn find<'e>(
    db: impl sqlx::SqliteExecutor<'e>,
    token_hash: &str,
) -> sqlx::Result<Option<Row>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT id, purpose, user_id, role, note, expires_at, used_at IS NOT NULL AS used, expires_at <= {NOW} AS expired \
           FROM invitation WHERE token_hash = ?"
    )))
    .bind(token_hash)
    .fetch_optional(db)
    .await
}

/// The three ways a link can be dead, each with a code the SPA words, and the
/// same codes `oidc.rs` puts on its error redirect.
fn usable(row: Option<Row>, purpose: &str) -> ApiResult<Row> {
    let dead = |code: &str, detail: &str| {
        ApiError::new(StatusCode::GONE, detail)
            .titled("Link not usable")
            .with("code", json!(code))
    };
    match row {
        Some(r) if r.purpose != purpose => Err(dead("invite-invalid", "this link is not valid")),
        Some(r) if r.used => Err(dead("invite-used", "this link has already been used")),
        Some(r) if r.expired => Err(dead(
            "invite-expired",
            "this link has expired; ask an admin for a new one",
        )),
        Some(r) => Ok(r),
        None => Err(dead(
            "invite-invalid",
            "this link is not valid; it may have been revoked",
        )),
    }
}

/// A link carries no more authority than its issuer has now: the issuer is
/// still active and could still issue it — to the join link's role, or over
/// the reset account's current role. Checked at redemption, not only when the
/// link was made, so a promotion or a demotion in between is honoured.
async fn require_authority<'e>(
    db: impl sqlx::SqliteExecutor<'e>,
    invitation: &str,
) -> ApiResult<()> {
    let row: Option<(Option<Role>, Option<bool>, Option<Role>)> = sqlx::query_as(
        "SELECT u.role, u.deactivated_at IS NULL, CASE WHEN i.purpose = 'reset' THEN t.role ELSE i.role END \
           FROM invitation i LEFT JOIN app_user u ON u.id = i.created_by LEFT JOIN app_user t ON t.id = i.user_id \
          WHERE i.id = ?",
    )
    .bind(invitation)
    .fetch_optional(db)
    .await?;
    match row {
        Some((Some(issuer), Some(true), Some(target))) if auth::may_act_on(issuer, target) => {
            Ok(())
        }
        _ => {
            tracing::warn!(
                invitation,
                reason = "issuer no longer has the authority",
                "invitation refused"
            );
            Err(ApiError::new(
                StatusCode::GONE,
                "this link is no longer valid; ask for a new one",
            )
            .titled("Link not usable")
            .with("code", json!("invite-invalid")))
        }
    }
}

/// The error-redirect code for a refused join, for `oidc.rs`.
pub fn reason(e: &ApiError) -> &'static str {
    match e.extra.get("code").and_then(|c| c.as_str()) {
        Some("invite-used") => "invite-used",
        Some("invite-expired") => "invite-expired",
        Some("invite-invalid") => "invite-invalid",
        _ => "server-error",
    }
}

#[derive(Deserialize)]
struct TokenBody {
    token: String,
}

/// What the `/invite` page needs to draw itself: join or reset, and for
/// whom. Says why a dead link is dead.
async fn inspect(
    State(app): State<AppState>,
    Json(body): Json<TokenBody>,
) -> ApiResult<axum::Json<serde_json::Value>> {
    let row = find(&app.db, &auth::hash_token(&body.token)).await?;
    let purpose = row.as_ref().map(|r| r.purpose.clone()).unwrap_or_default();
    let row = usable(row, &purpose)?;
    require_authority(&app.db, &row.id).await?;
    let username: Option<String> = match &row.user_id {
        Some(id) => auth::find_user(&app.db, id).await?.map(|u| u.username),
        None => None,
    };
    Ok(axum::Json(json!({
        "purpose": row.purpose, "role": row.role, "admin": row.role == Role::Admin, "note": row.note, "username": username, "expiresAt": row.expires_at,
        "passwordEnabled": !app.config.password_disabled,
    })))
}

/// Joins through an invitation inside the caller's transaction: checks it,
/// creates the account with its role, and uses it up. The `used_at IS NULL`
/// guard makes two simultaneous redemptions produce one account.
pub async fn join_in(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    token_hash: &str,
    username: &str,
    display_name: &str,
    password_hash: Option<&str>,
) -> ApiResult<User> {
    let row = usable(find(&mut **tx, token_hash).await?, "join")?;
    require_authority(&mut **tx, &row.id).await?;
    let user =
        auth::insert_user(&mut **tx, username, display_name, password_hash, row.role).await?;
    let used = sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE invitation SET used_at = {NOW}, user_id = ? WHERE id = ? AND used_at IS NULL"
    )))
    .bind(&user.id)
    .bind(&row.id)
    .execute(&mut **tx)
    .await?;
    if used.rows_affected() != 1 {
        return Err(usable(Some(Row { used: true, ..row }), "join").unwrap_err());
    }
    tracing::info!(invitation = %row.id, user = %user.id, "invitation accepted");
    Ok(user)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Redeem {
    token: String,
    password: String,
    /// join only.
    username: Option<String>,
    display_name: Option<String>,
}

/// Join with a password (201, signed in), or reset one (204; sign in with
/// it next). A reset ends every session the account had.
async fn redeem(
    State(app): State<AppState>,
    headers: HeaderMap,
    axum::Extension(principal): axum::Extension<Principal>,
    Json(body): Json<Redeem>,
) -> ApiResult<Response> {
    auth::require_password_sign_in(&app)?;
    auth::require_valid_password(&body.password)?;
    let hash_of_token = auth::hash_token(&body.token);
    // Everything that could refuse this comes before the password is hashed:
    // hashing is the expensive part, and anyone can post here.
    let found = find(&app.db, &hash_of_token).await?;
    let purpose = found
        .as_ref()
        .map(|r| r.purpose.clone())
        .unwrap_or_default();
    if purpose == "reset" {
        let row = usable(found, "reset")?;
        require_authority(&app.db, &row.id).await?;
        let password = auth::hash_password(body.password).await?;
        let mut tx = app.db.begin().await?;
        let row = usable(find(&mut *tx, &hash_of_token).await?, "reset")?;
        require_authority(&mut *tx, &row.id).await?;
        let user_id = row.user_id.clone().unwrap_or_default();
        sqlx::query("UPDATE app_user SET password_hash = ? WHERE id = ?")
            .bind(password)
            .bind(&user_id)
            .execute(&mut *tx)
            .await?;
        let used = sqlx::query(sqlx::AssertSqlSafe(format!(
            "UPDATE invitation SET used_at = {NOW} WHERE id = ? AND used_at IS NULL"
        )))
        .bind(&row.id)
        .execute(&mut *tx)
        .await?;
        if used.rows_affected() != 1 {
            return Err(usable(Some(Row { used: true, ..row }), "reset").unwrap_err());
        }
        tx.commit().await?;
        auth::end_sessions_of(&app.db, &user_id, None).await?;
        tracing::info!(invitation = %row.id, user = %user_id, "password reset; sessions ended");
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    let row = usable(found, "join")?;
    require_authority(&app.db, &row.id).await?;
    let username = body.username.unwrap_or_default();
    let display_name = body.display_name.unwrap_or_default();
    auth::require_username(&username)?;
    auth::require_display_name(&display_name)?;
    let password = auth::hash_password(body.password).await?;
    let mut tx = app.db.begin().await?;
    let user = join_in(
        &mut tx,
        &hash_of_token,
        &username,
        &display_name,
        Some(&password),
    )
    .await?;
    tx.commit().await?;
    auth::establish(
        &app,
        &headers,
        principal.session_hash(),
        &user.id,
        Kind::Browser,
        &auth::browser_label(&headers),
        StatusCode::CREATED,
    )
    .await
}

/// Join through a provider: checks the link now (so a dead one is refused on
/// the page rather than after a trip to Google), then hands the SPA the
/// provider's address and the flow cookie. The join itself happens on the way
/// back, in `oidc.rs`, where the link is checked again.
async fn redeem_with_provider(
    State(app): State<AppState>,
    headers: HeaderMap,
    Path(provider): Path<String>,
    Json(body): Json<TokenBody>,
) -> ApiResult<Response> {
    let token_hash = auth::hash_token(&body.token);
    let row = usable(find(&app.db, &token_hash).await?, "join")?;
    require_authority(&app.db, &row.id).await?;
    match oidc::begin(
        &app,
        &headers,
        &provider,
        Intent::Invite { token_hash },
        "/".into(),
    )
    .await
    {
        Ok((url, cookie)) => {
            let mut response = axum::Json(json!({ "redirect": url })).into_response();
            response.headers_mut().append(header::SET_COOKIE, cookie);
            Ok(response)
        }
        Err("unknown-provider") => Err(ApiError::not_found(format!(
            "no sign-in provider '{provider}' on this instance"
        ))),
        Err(code) => Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            format!("could not start sign-in ({code})"),
        )),
    }
}
