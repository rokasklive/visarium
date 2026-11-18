//! OpenID Connect sign-in (ADR-0025): any number of providers, Google built
//! in. The server is a confidential client using the authorization code flow
//! with PKCE (RFC 9700), `state` and `nonce`.
//!
//! An SSO login finds its account by `(provider, sub)` and by nothing else. A
//! matching email never signs in to, or links, an existing account: that would
//! hand every configured provider the power to take over any account whose
//! email it is willing to vouch for.
//!
//! These endpoints are browser navigations, so they answer with redirects; the
//! `/api/*` rule (401 problem+json, never a redirect) is untouched.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get};
use axum_extra::extract::CookieJar;
use openidconnect::core::{CoreAuthenticationFlow, CoreClient, CoreIdTokenClaims, CoreProviderMetadata};
use openidconnect::{
    AsyncHttpClient, AuthorizationCode, ClientId, ClientSecret, CsrfToken, HttpClientError, HttpRequest, HttpResponse, IssuerUrl,
    Nonce, PkceCodeChallenge, PkceCodeVerifier, RedirectUrl, Scope, TokenResponse,
};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::auth::{self, FLOW, Kind, Principal, SESSION, User};
use crate::error::{ApiError, ApiResult};
use crate::AppState;

/// An OIDC attempt has this long from leaving for the provider to coming back.
pub const FLOW_TTL: Duration = Duration::from_secs(600);
const GOOGLE_ISSUER: &str = "https://accounts.google.com";

// --- configuration ----------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub struct ProviderConfig {
    /// The key in `VISARIUM_OIDC_{ID}_*`, lower-cased: also the URL segment
    /// and what `user_identity.provider` stores.
    pub id: String,
    pub name: String,
    pub issuer: String,
    pub client_id: String,
    pub client_secret: String,
}

/// Reads `VISARIUM_OIDC_{ID}_{ISSUER|CLIENT_ID|CLIENT_SECRET|NAME}`. `GOOGLE`
/// needs no issuer or name.
pub fn providers_from_env(vars: impl IntoIterator<Item = (String, String)>) -> Result<Vec<ProviderConfig>, String> {
    const FIELDS: [&str; 4] = ["_CLIENT_SECRET", "_CLIENT_ID", "_ISSUER", "_NAME"];
    let mut found: HashMap<String, HashMap<&str, String>> = HashMap::new();
    for (key, value) in vars {
        let Some(rest) = key.strip_prefix("VISARIUM_OIDC_") else { continue };
        let Some(field) = FIELDS.iter().find(|f| rest.ends_with(*f)) else {
            return Err(format!("{key}: expected it to end in one of {}", FIELDS.join(", ")));
        };
        let id = rest[..rest.len() - field.len()].to_ascii_lowercase().replace('_', "-");
        if id.is_empty() || !id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
            return Err(format!("{key}: a provider id may hold letters, digits and underscores"));
        }
        if !value.trim().is_empty() {
            found.entry(id).or_default().insert(field, value.trim().to_string());
        }
    }
    let mut providers = found
        .into_iter()
        .map(|(id, mut f)| {
            let google = id == "google";
            let var = |field: &str| format!("VISARIUM_OIDC_{}{field}", id.to_ascii_uppercase().replace('-', "_"));
            let mut need = |field: &'static str| f.remove(field).ok_or_else(|| format!("{} is required", var(field)));
            let client_id = need("_CLIENT_ID")?;
            let client_secret = need("_CLIENT_SECRET")?;
            let issuer = match f.remove("_ISSUER") {
                Some(issuer) => issuer,
                None if google => GOOGLE_ISSUER.into(),
                None => return Err(format!("{} is required", var("_ISSUER"))),
            };
            let name = f.remove("_NAME").unwrap_or_else(|| if google { "Google".into() } else { id.clone() });
            Ok(ProviderConfig { id, name, issuer, client_id, client_secret })
        })
        .collect::<Result<Vec<_>, String>>()?;
    providers.sort_by(|a, b| (a.id != "google", &a.id).cmp(&(b.id != "google", &b.id)));
    Ok(providers)
}

// --- providers --------------------------------------------------------------

/// reqwest behind openidconnect's client trait, with the one setting that
/// matters for security: redirects are never followed (SSRF).
#[derive(Clone)]
pub struct Http(reqwest::Client);

impl Default for Http {
    fn default() -> Self {
        Self(
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(10))
                .build()
                .expect("http client"),
        )
    }
}

impl<'c> AsyncHttpClient<'c> for Http {
    type Error = HttpClientError<reqwest::Error>;
    type Future = Pin<Box<dyn Future<Output = Result<HttpResponse, Self::Error>> + Send + 'c>>;

    fn call(&'c self, request: HttpRequest) -> Self::Future {
        Box::pin(async move {
            let response = self.0.execute(request.try_into().map_err(Box::new)?).await.map_err(Box::new)?;
            let mut builder = axum::http::Response::builder().status(response.status());
            for (name, value) in response.headers() {
                builder = builder.header(name, value);
            }
            builder.body(response.bytes().await.map_err(Box::new)?.to_vec()).map_err(HttpClientError::Http)
        })
    }
}

pub struct Provider {
    pub id: String,
    pub name: String,
    config: ProviderConfig,
    /// Discovery document and JWKS. Fetched at startup if the provider
    /// answers, otherwise on first use; fetched again when an ID token is
    /// signed with a key it does not hold (key rotation).
    metadata: RwLock<Option<CoreProviderMetadata>>,
}

impl Provider {
    pub async fn new(config: ProviderConfig, http: &Http) -> Self {
        let provider = Self { id: config.id.clone(), name: config.name.clone(), config, metadata: RwLock::new(None) };
        if let Err(e) = provider.refresh(http).await {
            tracing::warn!(provider = %provider.id, "could not reach the provider yet ({e}); will retry on first sign-in");
        }
        provider
    }

    async fn refresh(&self, http: &Http) -> Result<CoreProviderMetadata, String> {
        let issuer = IssuerUrl::new(self.config.issuer.clone()).map_err(|e| e.to_string())?;
        let metadata = CoreProviderMetadata::discover_async(issuer, http).await.map_err(|e| format!("discovery failed: {e}"))?;
        *self.metadata.write().await = Some(metadata.clone());
        Ok(metadata)
    }

    async fn metadata(&self, http: &Http) -> Result<CoreProviderMetadata, String> {
        match self.metadata.read().await.clone() {
            Some(m) => Ok(m),
            None => self.refresh(http).await,
        }
    }

    fn client(
        &self,
        metadata: CoreProviderMetadata,
        public_url: &str,
    ) -> Result<
        CoreClient<
            openidconnect::EndpointSet,
            openidconnect::EndpointNotSet,
            openidconnect::EndpointNotSet,
            openidconnect::EndpointNotSet,
            openidconnect::EndpointMaybeSet,
            openidconnect::EndpointMaybeSet,
        >,
        String,
    > {
        let redirect = format!("{}/auth/oidc/{}/callback", public_url.trim_end_matches('/'), self.id);
        Ok(CoreClient::from_provider_metadata(
            metadata,
            ClientId::new(self.config.client_id.clone()),
            Some(ClientSecret::new(self.config.client_secret.clone())),
        )
        .set_redirect_uri(RedirectUrl::new(redirect).map_err(|e| e.to_string())?))
    }
}

// --- flows in progress ------------------------------------------------------

#[derive(Clone, Debug)]
pub enum Intent {
    SignIn,
    /// Add this identity to the signed-in account `user_id`.
    Link { user_id: String },
    /// Become the first admin of an empty instance.
    Claim,
    /// Join through an invitation (the token's hash, never the token).
    Invite { token_hash: String },
}

struct Flow {
    provider: String,
    state: String,
    nonce: String,
    verifier: String,
    intent: Intent,
    return_to: String,
    started: Instant,
}

/// OIDC attempts in progress, keyed by the id in the flow cookie.
/// ponytail: in memory, so a restart in the middle of a sign-in sends that one
/// person back to the sign-in page; a table if this ever runs as more than one
/// process.
#[derive(Default)]
pub struct Flows(Mutex<HashMap<String, Flow>>);

impl Flows {
    fn insert(&self, id: String, flow: Flow) {
        let mut flows = self.0.lock().unwrap();
        flows.retain(|_, f| f.started.elapsed() < FLOW_TTL);
        flows.insert(id, flow);
    }
    /// Removes and returns the flow: each is usable once.
    fn take(&self, id: &str) -> Option<Flow> {
        self.0.lock().unwrap().remove(id).filter(|f| f.started.elapsed() < FLOW_TTL)
    }
}

/// Only a path on this origin: `/boards/x`, never `//evil.example` or
/// `https://evil.example`.
pub fn safe_return(path: Option<&str>) -> String {
    match path {
        Some(p) if p.starts_with('/') && !p.starts_with("//") && !p.starts_with("/\\") && !p.contains(['\r', '\n']) => p.into(),
        _ => "/".into(),
    }
}

fn redirect(to: &str) -> Response {
    (StatusCode::FOUND, [(header::LOCATION, HeaderValue::from_str(to).unwrap_or(HeaderValue::from_static("/")))]).into_response()
}

/// Every failure lands on the sign-in page with a code the SPA turns into a
/// sentence; the details go to the log, not the address bar.
fn failed(code: &str) -> Response {
    redirect(&format!("/sign-in?error={code}"))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/auth/oidc/{provider}/start", get(start))
        .route("/auth/oidc/{provider}/callback", get(callback))
}

pub fn identity_routes() -> Router<AppState> {
    Router::new()
        .route("/accounts/me/identities", get(list_identities))
        .route("/accounts/me/identities/{provider}", delete(unlink))
}

#[derive(Deserialize)]
pub struct StartQuery {
    intent: Option<String>,
    #[serde(rename = "return")]
    return_to: Option<String>,
}

fn find<'a>(app: &'a AppState, id: &str) -> Option<&'a Provider> {
    if app.local_user.is_some() {
        return None;
    }
    app.oidc.iter().find(|p| p.id == id)
}

async fn start(
    State(app): State<AppState>,
    headers: HeaderMap,
    Path(provider): Path<String>,
    axum::Extension(principal): axum::Extension<Principal>,
    Query(q): Query<StartQuery>,
) -> Response {
    let intent = match q.intent.as_deref().unwrap_or("sign-in") {
        "sign-in" => Intent::SignIn,
        "claim" => Intent::Claim,
        "link" => match principal.user() {
            Some(user) => Intent::Link { user_id: user.id.clone() },
            None => return failed("signed-out"),
        },
        _ => return failed("bad-request"),
    };
    match begin(&app, &headers, &provider, intent, safe_return(q.return_to.as_deref())).await {
        Ok((url, cookie)) => {
            let mut response = redirect(&url);
            response.headers_mut().append(header::SET_COOKIE, cookie);
            response
        }
        Err(code) => failed(code),
    }
}

/// Prepares leaving for the provider: remembers the attempt and returns the
/// provider's URL with the flow cookie that binds the attempt to this
/// browser. `start` turns that into a redirect; invitations, whose token
/// arrives in a POST body rather than a URL, hand the URL to the SPA instead.
pub async fn begin(
    app: &AppState,
    headers: &HeaderMap,
    provider: &str,
    intent: Intent,
    return_to: String,
) -> Result<(String, HeaderValue), &'static str> {
    let p = find(app, provider).ok_or("unknown-provider")?;
    let public_url = app.config.public_url.as_ref().ok_or("not-configured")?;
    let client = p.metadata(&app.http).await.and_then(|m| p.client(m, public_url)).map_err(|e| {
        tracing::warn!(provider = %p.id, "{e}");
        "provider-unreachable"
    })?;
    let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
    let (url, state, nonce) = client
        .authorize_url(CoreAuthenticationFlow::AuthorizationCode, CsrfToken::new_random, Nonce::new_random)
        .add_scope(Scope::new("email".into()))
        .add_scope(Scope::new("profile".into()))
        .set_pkce_challenge(challenge)
        .url();
    let flow_id = auth::random_token();
    app.flows.insert(
        flow_id.clone(),
        Flow {
            provider: p.id.clone(),
            state: state.secret().clone(),
            nonce: nonce.secret().clone(),
            verifier: verifier.secret().clone(),
            intent,
            return_to,
            started: Instant::now(),
        },
    );
    Ok((url.to_string(), FLOW.set(&flow_id, auth::is_secure(headers), FLOW_TTL.as_secs() as i64)))
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

/// What a verified ID token tells us.
pub struct Identity {
    pub provider: String,
    pub subject: String,
    /// Only when the provider says it is verified.
    pub email: Option<String>,
    pub name: Option<String>,
    pub preferred_username: Option<String>,
}

async fn callback(
    State(app): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Path(provider): Path<String>,
    axum::Extension(principal): axum::Extension<Principal>,
    Query(q): Query<CallbackQuery>,
) -> Response {
    let secure = auth::is_secure(&headers);
    // The flow cookie is what ties this callback to the browser that started
    // it; without it a stranger could finish someone else's sign-in (login
    // CSRF). Taking the flow also makes it single-use.
    let flow = FLOW.read(&jar).and_then(|id| app.flows.take(&id));
    let mut response = match flow {
        Some(flow) if flow.provider == provider => {
            if q.error.is_some() {
                failed("cancelled")
            } else if q.state.as_deref() != Some(flow.state.as_str()) {
                failed("expired")
            } else {
                match verify(&app, &provider, q.code.unwrap_or_default(), &flow).await {
                    Ok(identity) => finish(&app, &headers, &principal, identity, flow).await,
                    Err(e) => {
                        tracing::warn!(provider, "sign-in refused: {e}");
                        failed("refused")
                    }
                }
            }
        }
        _ => failed("expired"),
    };
    for cookie in FLOW.clear(secure) {
        response.headers_mut().append(header::SET_COOKIE, cookie);
    }
    response
}

/// Exchanges the code (with the PKCE verifier) and verifies the ID token's
/// signature, `iss`, `aud`, `exp` and `nonce`. A signature that does not check
/// out against the keys we hold gets one retry after refetching them, for
/// providers that have rotated keys since we last looked.
async fn verify(app: &AppState, provider: &str, code: String, flow: &Flow) -> Result<Identity, String> {
    let p = find(app, provider).ok_or("unknown provider")?;
    let public_url = app.config.public_url.as_deref().ok_or("no public url")?;
    let client = p.client(p.metadata(&app.http).await?, public_url)?;
    let token = client
        .exchange_code(AuthorizationCode::new(code))
        .map_err(|e| e.to_string())?
        .set_pkce_verifier(PkceCodeVerifier::new(flow.verifier.clone()))
        .request_async(&app.http)
        .await
        .map_err(|e| format!("code exchange failed: {e}"))?;
    let id_token = token.id_token().ok_or("the provider sent no ID token")?;
    let nonce = Nonce::new(flow.nonce.clone());
    let claims: CoreIdTokenClaims = match id_token.claims(&client.id_token_verifier(), &nonce) {
        Ok(c) => c.clone(),
        Err(openidconnect::ClaimsVerificationError::SignatureVerification(_)) => {
            let client = p.client(p.refresh(&app.http).await?, public_url)?;
            id_token.claims(&client.id_token_verifier(), &nonce).map_err(|e| e.to_string())?.clone()
        }
        Err(e) => return Err(e.to_string()),
    };
    let email = claims.email().filter(|_| claims.email_verified() == Some(true)).map(|e| e.as_str().to_lowercase());
    Ok(Identity {
        provider: provider.into(),
        subject: claims.subject().as_str().into(),
        email,
        name: claims.name().and_then(|n| n.get(None)).map(|n| n.as_str().to_string()),
        preferred_username: claims.preferred_username().map(|u| u.as_str().to_string()),
    })
}

async fn linked_user(db: &sqlx::SqlitePool, identity: &Identity) -> sqlx::Result<Option<String>> {
    sqlx::query_scalar("SELECT user_id FROM user_identity WHERE provider = ? AND subject = ?")
        .bind(&identity.provider)
        .bind(&identity.subject)
        .fetch_optional(db)
        .await
}

pub async fn link<'e>(db: impl sqlx::SqliteExecutor<'e>, user_id: &str, identity: &Identity) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO user_identity (provider, subject, user_id, email) VALUES (?, ?, ?, ?)")
        .bind(&identity.provider)
        .bind(&identity.subject)
        .bind(user_id)
        .bind(&identity.email)
        .execute(db)
        .await
        .map(|_| ())
}

/// Resolves the account, in order: an identity already linked; linking to the
/// signed-in account; an invitation; claiming an empty instance. Nothing else
/// creates or finds an account — in particular, not a matching email.
async fn finish(app: &AppState, headers: &HeaderMap, principal: &Principal, identity: Identity, flow: Flow) -> Response {
    match resolve(app, &identity, &flow.intent, principal).await {
        Ok(Resolved::SignIn(user_id)) => {
            // Keep the address book current; nothing ever matches on it.
            let _ = sqlx::query("UPDATE user_identity SET email = coalesce(?, email) WHERE provider = ? AND subject = ?")
                .bind(&identity.email)
                .bind(&identity.provider)
                .bind(&identity.subject)
                .execute(&app.db)
                .await;
            match auth::start_session(app, principal.session_hash(), &user_id, Kind::Browser, &auth::browser_label(headers)).await {
                Ok(token) => {
                    let mut response = redirect(&flow.return_to);
                    response.headers_mut().append(header::SET_COOKIE, SESSION.set(&token, auth::is_secure(headers), Kind::Browser.idle_secs()));
                    response
                }
                Err(e) => {
                    tracing::error!("could not start a session: {}", e.detail);
                    failed("server-error")
                }
            }
        }
        Ok(Resolved::Linked) => redirect(&flow.return_to),
        Err(code) => failed(code),
    }
}

enum Resolved {
    SignIn(String),
    Linked,
}

async fn resolve(app: &AppState, identity: &Identity, intent: &Intent, principal: &Principal) -> Result<Resolved, &'static str> {
    let db = &app.db;
    let linked = linked_user(db, identity).await.map_err(|_| "server-error")?;
    match (intent, linked) {
        (Intent::Link { user_id }, Some(owner)) => {
            if &owner == user_id { Ok(Resolved::Linked) } else { Err("linked-elsewhere") }
        }
        (Intent::Link { user_id }, None) => {
            // The account that asked must still be the one signed in here.
            if principal.user().map(|u| &u.id) != Some(user_id) {
                return Err("signed-out");
            }
            link(db, user_id, identity).await.map_err(|_| "server-error")?;
            Ok(Resolved::Linked)
        }
        (Intent::Invite { .. } | Intent::Claim, Some(_)) => Err("already-registered"),
        (_, Some(user_id)) => {
            let user = auth::find_user(db, &user_id).await.map_err(|_| "server-error")?.ok_or("server-error")?;
            if user.deactivated_at.is_some() { Err("deactivated") } else { Ok(Resolved::SignIn(user_id)) }
        }
        (Intent::Invite { token_hash }, None) => {
            let mut tx = db.begin().await.map_err(|_| "server-error")?;
            let user = crate::invitations::join_in(&mut tx, token_hash, &username_for(db, identity).await, &display_name_for(identity), None)
                .await
                .map_err(|e| crate::invitations::reason(&e))?;
            link(&mut *tx, &user.id, identity).await.map_err(|_| "server-error")?;
            tx.commit().await.map_err(|_| "server-error")?;
            Ok(Resolved::SignIn(user.id))
        }
        (Intent::Claim, None) => {
            let _guard = app.setup_lock.lock().await;
            let mut tx = db.begin().await.map_err(|_| "server-error")?;
            let user = auth::claim_in(&mut tx, &username_for(db, identity).await, &display_name_for(identity), None)
                .await
                .map_err(|_| "already-claimed")?;
            link(&mut *tx, &user.id, identity).await.map_err(|_| "server-error")?;
            tx.commit().await.map_err(|_| "server-error")?;
            Ok(Resolved::SignIn(user.id))
        }
        (Intent::SignIn, None) => Err("no-account"),
    }
}

/// A username for a new SSO account: the email's local part (or the
/// provider's preferred username), squeezed into the username rule, made
/// unique with a suffix. Editable afterwards.
async fn username_for(db: &sqlx::SqlitePool, identity: &Identity) -> String {
    let source = identity
        .email
        .as_deref()
        .and_then(|e| e.split('@').next())
        .or(identity.preferred_username.as_deref())
        .or(identity.name.as_deref())
        .unwrap_or("member");
    let mut base: String = source
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_lowercase() || c.is_ascii_digit() || "._-".contains(c) { c } else { '-' })
        .take(56)
        .collect();
    base = base.trim_matches(['-', '.', '_']).to_string();
    if base.len() < 2 {
        base = "member".into();
    }
    for n in 1.. {
        let candidate = if n == 1 { base.clone() } else { format!("{base}-{n}") };
        let taken: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM app_user WHERE username = ?)")
            .bind(&candidate)
            .fetch_one(db)
            .await
            .unwrap_or(false);
        if !taken {
            return candidate;
        }
    }
    unreachable!()
}

fn display_name_for(identity: &Identity) -> String {
    let name = identity
        .name
        .clone()
        .or_else(|| identity.email.as_deref().and_then(|e| e.split('@').next()).map(str::to_string))
        .unwrap_or_else(|| "Member".into());
    let name: String = name.trim().chars().take(64).collect();
    if name.is_empty() { "Member".into() } else { name }
}

// --- my sign-in methods -----------------------------------------------------

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct IdentityView {
    provider: String,
    email: Option<String>,
    created_at: String,
}

async fn list_identities(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
) -> ApiResult<axum::Json<serde_json::Value>> {
    let identities: Vec<IdentityView> =
        sqlx::query_as("SELECT provider, email, created_at FROM user_identity WHERE user_id = ? ORDER BY created_at")
            .bind(&me.id)
            .fetch_all(&app.db)
            .await?;
    let has_password: bool = sqlx::query_scalar("SELECT password_hash IS NOT NULL FROM app_user WHERE id = ?")
        .bind(&me.id)
        .fetch_one(&app.db)
        .await?;
    let named: Vec<_> = identities
        .into_iter()
        .map(|i| {
            let name = app.oidc.iter().find(|p| p.id == i.provider).map_or(i.provider.clone(), |p| p.name.clone());
            serde_json::json!({ "provider": i.provider, "name": name, "email": i.email, "createdAt": i.created_at })
        })
        .collect();
    Ok(axum::Json(serde_json::json!({ "hasPassword": has_password, "identities": named })))
}

/// Refused when it would leave the account with no way in at all.
async fn unlink(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
    Path(provider): Path<String>,
) -> ApiResult<StatusCode> {
    let (has_password, others): (bool, i64) = sqlx::query_as(
        "SELECT (SELECT password_hash IS NOT NULL FROM app_user WHERE id = ?1) \
                    AND NOT ?3, \
                (SELECT count(*) FROM user_identity WHERE user_id = ?1 AND provider != ?2)",
    )
    .bind(&me.id)
    .bind(&provider)
    .bind(app.config.password_disabled)
    .fetch_one(&app.db)
    .await?;
    if !has_password && others == 0 {
        return Err(ApiError::conflict("this is your last way to sign in; add a password or another provider first")
            .titled("Cannot remove your last sign-in method"));
    }
    let done = sqlx::query("DELETE FROM user_identity WHERE user_id = ? AND provider = ?").bind(&me.id).bind(&provider).execute(&app.db).await?;
    if done.rows_affected() == 0 {
        return Err(ApiError::not_found(format!("no {provider} sign-in on this account")));
    }
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn google_is_a_preset_and_others_need_an_issuer() {
        let got = providers_from_env(vars(&[
            ("VISARIUM_OIDC_GOOGLE_CLIENT_ID", "g-id"),
            ("VISARIUM_OIDC_GOOGLE_CLIENT_SECRET", "g-secret"),
            ("VISARIUM_OIDC_STUDIO_SSO_ISSUER", "https://id.example/o/visarium/"),
            ("VISARIUM_OIDC_STUDIO_SSO_CLIENT_ID", "s-id"),
            ("VISARIUM_OIDC_STUDIO_SSO_CLIENT_SECRET", "s-secret"),
            ("VISARIUM_OIDC_STUDIO_SSO_NAME", "Studio SSO"),
            ("VISARIUM_PORT", "8080"),
        ]))
        .unwrap();
        assert_eq!(got[0], ProviderConfig {
            id: "google".into(),
            name: "Google".into(),
            issuer: GOOGLE_ISSUER.into(),
            client_id: "g-id".into(),
            client_secret: "g-secret".into(),
        });
        assert_eq!((got[1].id.as_str(), got[1].name.as_str()), ("studio-sso", "Studio SSO"));

        let no_issuer = providers_from_env(vars(&[("VISARIUM_OIDC_AUTH_CLIENT_ID", "a"), ("VISARIUM_OIDC_AUTH_CLIENT_SECRET", "b")]));
        assert_eq!(no_issuer.unwrap_err(), "VISARIUM_OIDC_AUTH_ISSUER is required");
        let no_secret = providers_from_env(vars(&[("VISARIUM_OIDC_GOOGLE_CLIENT_ID", "a")]));
        assert_eq!(no_secret.unwrap_err(), "VISARIUM_OIDC_GOOGLE_CLIENT_SECRET is required");
        assert!(providers_from_env(vars(&[("VISARIUM_OIDC_GOOGLE_SECRET", "x")])).is_err(), "a typo is loud");
    }

    #[test]
    fn return_paths_stay_on_this_origin() {
        assert_eq!(safe_return(Some("/boards/abc?x=1")), "/boards/abc?x=1");
        for bad in ["https://evil.example/", "//evil.example", "/\\evil.example", "boards", "/a\r\nSet-Cookie: x"] {
            assert_eq!(safe_return(Some(bad)), "/", "{bad}");
        }
        assert_eq!(safe_return(None), "/");
    }
}
