//! Instance Settings: what moderators and admins change about the instance
//! itself, under `/api/instance/*`. For now, the sign-in providers an admin
//! sets up in the app (OpenID Connect; Google built in).
//!
//! A provider's client secret goes in and never comes out: no response here
//! carries it, only `hasSecret`. It is stored as is in SQLite, beside the
//! password hashes. ponytail: plaintext at rest; encrypt with a
//! VISARIUM_SECRET_KEY if database backups ever leave the host.

use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::auth::{self, User};
use crate::error::{ApiError, ApiResult, Json};
use crate::oidc::{self, GOOGLE_ISSUER};
use crate::{AppState, NOW};

pub fn routes() -> Router<AppState> {
    Router::new().route("/instance/providers", get(list)).route(
        "/instance/providers/{id}",
        axum::routing::put(save).delete(remove),
    )
}

fn require_multi_user(app: &AppState) -> ApiResult<()> {
    if app.local_user.is_some() {
        return Err(ApiError::not_found(
            "there are no instance settings in single-user mode",
        ));
    }
    Ok(())
}

fn redirect_uri(app: &AppState, id: &str) -> Option<String> {
    app.config
        .public_url
        .as_deref()
        .map(|u| format!("{}/auth/oidc/{id}/callback", u.trim_end_matches('/')))
}

async fn linked(app: &AppState, id: &str) -> sqlx::Result<i64> {
    sqlx::query_scalar("SELECT count(DISTINCT user_id) FROM user_identity WHERE provider = ?")
        .bind(id)
        .fetch_one(&app.db)
        .await
}

/// Every provider, environment ones first, without secrets.
async fn list(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
) -> ApiResult<axum::Json<Value>> {
    require_multi_user(&app)?;
    auth::require_admin(&me)?;
    let mut out = Vec::new();
    for c in &app.config.providers {
        out.push(json!({
            "id": c.id, "name": c.name, "issuer": c.issuer, "clientId": c.client_id,
            "hasSecret": true, "enabled": true, "fromEnv": true,
            "redirectUri": redirect_uri(&app, &c.id), "linkedAccounts": linked(&app, &c.id).await?,
        }));
    }
    for s in oidc::stored(&app.db).await? {
        if app.config.providers.iter().any(|c| c.id == s.id) {
            continue;
        }
        out.push(json!({
            "id": s.id, "name": s.name, "issuer": s.issuer, "clientId": s.client_id,
            "hasSecret": !s.client_secret.is_empty(), "enabled": s.enabled, "fromEnv": false,
            "redirectUri": redirect_uri(&app, &s.id), "linkedAccounts": linked(&app, &s.id).await?,
            "createdAt": s.created_at, "updatedAt": s.updated_at,
        }));
    }
    Ok(axum::Json(json!({
        "providers": out,
        "publicUrl": app.config.public_url,
        "passwordEnabled": !app.config.password_disabled,
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderBody {
    name: Option<String>,
    /// Not needed for `google`.
    issuer: Option<String>,
    client_id: Option<String>,
    /// Empty or missing on an edit keeps the stored one.
    client_secret: Option<String>,
    enabled: Option<bool>,
}

fn valid_id(id: &str) -> ApiResult<()> {
    let ok = !id.is_empty()
        && id.len() <= 32
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !id.starts_with('-');
    if ok {
        Ok(())
    } else {
        Err(ApiError::bad_request(
            "a provider id is 1 to 32 lower-case letters, digits and dashes, not starting with a dash",
        ))
    }
}

fn given(s: Option<String>) -> Option<String> {
    s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// The account's own ways in: whether it has a password, and its linked
/// provider ids.
async fn own_methods(app: &AppState, me: &User) -> sqlx::Result<(bool, Vec<String>)> {
    let has_password: bool =
        sqlx::query_scalar("SELECT password_hash IS NOT NULL FROM app_user WHERE id = ?")
            .bind(&me.id)
            .fetch_one(&app.db)
            .await?;
    let linked = sqlx::query_scalar("SELECT provider FROM user_identity WHERE user_id = ?")
        .bind(&me.id)
        .fetch_all(&app.db)
        .await?;
    Ok((has_password, linked))
}

/// Refuses a change after which `remaining` would leave nobody, or the admin
/// making it, a way to sign in.
async fn guard(app: &AppState, me: &User, remaining: &[String]) -> ApiResult<()> {
    let (has_password, linked) = own_methods(app, me).await?;
    oidc::way_in(
        !app.config.password_disabled,
        remaining,
        Some((has_password, &linked)),
    )
    .map_err(|why| ApiError::conflict(why).titled("Nobody could sign in"))
}

/// Active provider ids once `id` is turned off or removed.
fn without(app: &AppState, id: &str) -> Vec<String> {
    oidc::active(app)
        .iter()
        .map(|p| p.id.clone())
        .filter(|p| p != id)
        .collect()
}

/// Adds a provider, or edits a stored one. The issuer is checked by fetching
/// its discovery document before anything is written.
async fn save(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
    Path(id): Path<String>,
    Json(body): Json<ProviderBody>,
) -> ApiResult<axum::Json<Value>> {
    require_multi_user(&app)?;
    auth::require_admin(&me)?;
    valid_id(&id)?;
    if app.config.providers.iter().any(|c| c.id == id) {
        return Err(ApiError::conflict(format!(
            "\"{id}\" is set by the server's environment (VISARIUM_OIDC_*) and cannot be changed here"
        )));
    }
    if app.config.public_url.is_none() {
        return Err(ApiError::conflict(
            "set VISARIUM_PUBLIC_URL first: the provider has to send people back to an address this server knows",
        ));
    }
    let old = oidc::stored(&app.db)
        .await?
        .into_iter()
        .find(|s| s.id == id);
    let google = id == "google";
    let issuer = given(body.issuer)
        .or_else(|| old.as_ref().map(|o| o.issuer.clone()))
        .or_else(|| google.then(|| GOOGLE_ISSUER.to_string()))
        .ok_or_else(|| {
            ApiError::bad_request("an issuer URL is needed for any provider but Google")
        })?;
    let client_id = given(body.client_id)
        .or_else(|| old.as_ref().map(|o| o.client_id.clone()))
        .ok_or_else(|| ApiError::bad_request("a client id is needed"))?;
    let client_secret = given(body.client_secret)
        .or_else(|| old.as_ref().map(|o| o.client_secret.clone()))
        .ok_or_else(|| ApiError::bad_request("a client secret is needed"))?;
    let name = given(body.name)
        .or_else(|| old.as_ref().map(|o| o.name.clone()))
        .unwrap_or_else(|| if google { "Google".into() } else { id.clone() });
    let name: String = name.chars().take(60).collect();
    let enabled = body
        .enabled
        .or(old.as_ref().map(|o| o.enabled))
        .unwrap_or(true);
    if !enabled && old.as_ref().is_none_or(|o| o.enabled) {
        guard(&app, &me, &without(&app, &id)).await?;
    }
    if old.as_ref().is_none_or(|o| o.issuer != issuer) {
        oidc::discover(&issuer, &app.http)
            .await
            .map_err(|e| ApiError::bad_request(e).titled("Issuer not reachable"))?;
    }
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "INSERT INTO oidc_provider (id, name, issuer, client_id, client_secret, enabled) VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
         ON CONFLICT (id) DO UPDATE SET name = ?2, issuer = ?3, client_id = ?4, client_secret = ?5, enabled = ?6, updated_at = {NOW}"
    )))
    .bind(&id)
    .bind(&name)
    .bind(&issuer)
    .bind(&client_id)
    .bind(&client_secret)
    .bind(enabled)
    .execute(&app.db)
    .await?;
    oidc::reload(&app).await?;
    tracing::info!(provider = %id, enabled, created = old.is_none(), by = %me.id, "sign-in provider saved");
    Ok(axum::Json(json!({
        "id": id, "name": name, "issuer": issuer, "clientId": client_id, "hasSecret": true,
        "enabled": enabled, "fromEnv": false, "redirectUri": redirect_uri(&app, &id),
    })))
}

#[derive(Deserialize)]
struct Confirm {
    #[serde(default)]
    confirm: bool,
}

/// Removes a stored provider. Without `?confirm=true`, answers 409 with how
/// many accounts are linked and how many would be left with no way in.
/// Linked identities are kept: the same id added again signs them in.
async fn remove(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
    Path(id): Path<String>,
    Query(q): Query<Confirm>,
) -> ApiResult<StatusCode> {
    require_multi_user(&app)?;
    auth::require_admin(&me)?;
    if app.config.providers.iter().any(|c| c.id == id) {
        return Err(ApiError::conflict(format!(
            "\"{id}\" is set by the server's environment (VISARIUM_OIDC_*) and cannot be removed here"
        )));
    }
    if !oidc::stored(&app.db).await?.iter().any(|s| s.id == id) {
        return Err(ApiError::not_found(format!("no provider {id}")));
    }
    let remaining = without(&app, &id);
    guard(&app, &me, &remaining).await?;
    if !q.confirm {
        let stranded: i64 = sqlx::query_scalar(
            "SELECT count(DISTINCT i.user_id) FROM user_identity i JOIN app_user u ON u.id = i.user_id \
              WHERE i.provider = ?1 AND u.deactivated_at IS NULL \
                AND (u.password_hash IS NULL OR ?3) \
                AND NOT EXISTS (SELECT 1 FROM user_identity j WHERE j.user_id = i.user_id \
                                   AND j.provider IN (SELECT value FROM json_each(?2)))",
        )
        .bind(&id)
        .bind(serde_json::to_string(&remaining).unwrap())
        .bind(app.config.password_disabled)
        .fetch_one(&app.db)
        .await?;
        let linked = linked(&app, &id).await?;
        return Err(ApiError::conflict(format!(
            "{linked} account(s) sign in with {id}, and {stranded} of them would have no other way in. Send confirm=true to remove it."
        ))
        .titled("Confirm removal")
        .with("linkedAccounts", json!(linked))
        .with("strandedAccounts", json!(stranded)));
    }
    sqlx::query("DELETE FROM oidc_provider WHERE id = ?")
        .bind(&id)
        .execute(&app.db)
        .await?;
    oidc::reload(&app).await?;
    tracing::info!(provider = %id, by = %me.id, "sign-in provider removed");
    Ok(StatusCode::NO_CONTENT)
}
