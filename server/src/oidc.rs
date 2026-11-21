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
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get};
use axum_extra::extract::CookieJar;
use openidconnect::core::{
    CoreAuthenticationFlow, CoreClient, CoreIdTokenClaims, CoreProviderMetadata,
};
use openidconnect::{
    AsyncHttpClient, AuthorizationCode, ClientId, ClientSecret, CsrfToken, HttpClientError,
    HttpRequest, HttpResponse, IssuerUrl, Nonce, PkceCodeChallenge, PkceCodeVerifier, RedirectUrl,
    Scope, TokenResponse,
};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::AppState;
use crate::auth::{self, FLOW, Kind, Principal, SESSION, User};
use crate::error::{ApiError, ApiResult};

/// An OIDC attempt has this long from leaving for the provider to coming back.
pub const FLOW_TTL: Duration = Duration::from_secs(600);
pub const GOOGLE_ISSUER: &str = "https://accounts.google.com";

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
pub fn providers_from_env(
    vars: impl IntoIterator<Item = (String, String)>,
) -> Result<Vec<ProviderConfig>, String> {
    const FIELDS: [&str; 4] = ["_CLIENT_SECRET", "_CLIENT_ID", "_ISSUER", "_NAME"];
    let mut found: HashMap<String, HashMap<&str, String>> = HashMap::new();
    for (key, value) in vars {
        let Some(rest) = key.strip_prefix("VISARIUM_OIDC_") else {
            continue;
        };
        let Some(field) = FIELDS.iter().find(|f| rest.ends_with(*f)) else {
            return Err(format!(
                "{key}: expected it to end in one of {}",
                FIELDS.join(", ")
            ));
        };
        let id = rest[..rest.len() - field.len()]
            .to_ascii_lowercase()
            .replace('_', "-");
        if id.is_empty()
            || !id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return Err(format!(
                "{key}: a provider id may hold letters, digits and underscores"
            ));
        }
        if !value.trim().is_empty() {
            found
                .entry(id)
                .or_default()
                .insert(field, value.trim().to_string());
        }
    }
    let mut providers = found
        .into_iter()
        .map(|(id, mut f)| {
            let google = id == "google";
            let var = |field: &str| {
                format!(
                    "VISARIUM_OIDC_{}{field}",
                    id.to_ascii_uppercase().replace('-', "_")
                )
            };
            let mut need = |field: &'static str| {
                f.remove(field)
                    .ok_or_else(|| format!("{} is required", var(field)))
            };
            let client_id = need("_CLIENT_ID")?;
            let client_secret = need("_CLIENT_SECRET")?;
            let issuer = match f.remove("_ISSUER") {
                Some(issuer) => issuer,
                None if google => GOOGLE_ISSUER.into(),
                None => return Err(format!("{} is required", var("_ISSUER"))),
            };
            let name = f
                .remove("_NAME")
                .unwrap_or_else(|| if google { "Google".into() } else { id.clone() });
            Ok(ProviderConfig {
                id,
                name,
                issuer,
                client_id,
                client_secret,
            })
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
            let response = self
                .0
                .execute(request.try_into().map_err(Box::new)?)
                .await
                .map_err(Box::new)?;
            let mut builder = axum::http::Response::builder().status(response.status());
            for (name, value) in response.headers() {
                builder = builder.header(name, value);
            }
            builder
                .body(response.bytes().await.map_err(Box::new)?.to_vec())
                .map_err(HttpClientError::Http)
        })
    }
}

pub struct Provider {
    pub id: String,
    pub name: String,
    /// Set by `VISARIUM_OIDC_*`: read-only in the app, and wins over a stored
    /// provider of the same id.
    pub from_env: bool,
    config: ProviderConfig,
    /// Discovery document and JWKS. Fetched at startup if the provider
    /// answers, otherwise on first use; fetched again when an ID token is
    /// signed with a key it does not hold (key rotation).
    metadata: RwLock<Option<CoreProviderMetadata>>,
}

impl Provider {
    pub async fn new(config: ProviderConfig, http: &Http, from_env: bool) -> Self {
        let provider = Self {
            id: config.id.clone(),
            name: config.name.clone(),
            from_env,
            config,
            metadata: RwLock::new(None),
        };
        if let Err(e) = provider.refresh(http).await {
            tracing::warn!(provider = %provider.id, error = %e, "could not reach the provider yet; will retry on first sign-in");
        }
        provider
    }

    async fn refresh(&self, http: &Http) -> Result<CoreProviderMetadata, String> {
        let issuer = IssuerUrl::new(self.config.issuer.clone()).map_err(|e| e.to_string())?;
        let metadata = CoreProviderMetadata::discover_async(issuer, http)
            .await
            .map_err(|e| format!("discovery failed: {e}"))?;
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
        let redirect = format!(
            "{}/auth/oidc/{}/callback",
            public_url.trim_end_matches('/'),
            self.id
        );
        Ok(CoreClient::from_provider_metadata(
            metadata,
            ClientId::new(self.config.client_id.clone()),
            Some(ClientSecret::new(self.config.client_secret.clone())),
        )
        .set_redirect_uri(RedirectUrl::new(redirect).map_err(|e| e.to_string())?))
    }
}

/// The providers sign-in offers right now. Swapped whole when an admin changes
/// one (`reload`); a flow in progress looks its provider up again by id.
pub type Providers = std::sync::RwLock<Vec<Arc<Provider>>>;

/// A provider an admin set up in the app (`oidc_provider`).
#[derive(Clone, Debug, sqlx::FromRow)]
pub struct Stored {
    pub id: String,
    pub name: String,
    pub issuer: String,
    pub client_id: String,
    pub client_secret: String,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

impl Stored {
    fn config(&self) -> ProviderConfig {
        ProviderConfig {
            id: self.id.clone(),
            name: self.name.clone(),
            issuer: self.issuer.clone(),
            client_id: self.client_id.clone(),
            client_secret: self.client_secret.clone(),
        }
    }
}

pub async fn stored(db: &sqlx::SqlitePool) -> sqlx::Result<Vec<Stored>> {
    sqlx::query_as("SELECT * FROM oidc_provider ORDER BY id <> 'google', id")
        .fetch_all(db)
        .await
}

/// The active list: environment providers, then enabled stored ones whose id
/// the environment does not use. A provider whose settings did not change is
/// kept as it is, with the discovery document it already fetched.
pub async fn build(
    env: &[ProviderConfig],
    stored: &[Stored],
    old: &[Arc<Provider>],
    http: &Http,
) -> Vec<Arc<Provider>> {
    let wanted = env.iter().map(|c| (c.clone(), true)).chain(
        stored
            .iter()
            .filter(|s| s.enabled && !env.iter().any(|e| e.id == s.id))
            .map(|s| (s.config(), false)),
    );
    let mut out = Vec::new();
    for (config, from_env) in wanted {
        match old
            .iter()
            .find(|p| p.config == config && p.from_env == from_env)
        {
            Some(p) => out.push(p.clone()),
            None => out.push(Arc::new(Provider::new(config, http, from_env).await)),
        }
    }
    out
}

/// Re-reads stored providers and swaps the active list.
pub async fn reload(app: &AppState) -> sqlx::Result<()> {
    let stored = stored(&app.db).await?;
    let old = active(app);
    let next = build(&app.config.providers, &stored, &old, &app.http).await;
    *app.oidc.write().unwrap() = next;
    Ok(())
}

/// A snapshot of the active providers; empty in single-user mode.
pub fn active(app: &AppState) -> Vec<Arc<Provider>> {
    if app.local_user.is_some() {
        return Vec::new();
    }
    app.oidc.read().unwrap().clone()
}

/// Fetches an issuer's discovery document, to refuse a provider that would
/// never work before it is saved.
pub async fn discover(issuer: &str, http: &Http) -> Result<(), String> {
    let url = IssuerUrl::new(issuer.to_string())
        .map_err(|e| format!("\"{issuer}\" is not a valid issuer URL: {e}"))?;
    CoreProviderMetadata::discover_async(url, http)
        .await
        .map(|_| ())
        .map_err(|e| {
            format!("could not read the OpenID Connect discovery document at {issuer}/.well-known/openid-configuration: {e}")
        })
}

/// Whether anybody, and the admin making a change, could still sign in with
/// these methods. Used at startup and before every provider change.
/// `actor`: the admin's password (if any) and their linked provider ids.
pub fn way_in(
    password_enabled: bool,
    providers: &[String],
    actor: Option<(bool, &[String])>,
) -> Result<(), &'static str> {
    if !password_enabled && providers.is_empty() {
        return Err(
            "password sign-in is off and no sign-in provider would be left, so nobody could sign in",
        );
    }
    if let Some((has_password, linked)) = actor {
        let keeps_one =
            (password_enabled && has_password) || linked.iter().any(|l| providers.contains(l));
        if !keeps_one {
            return Err(
                "you would lose your own way in: set a password or link another provider first",
            );
        }
    }
    Ok(())
}

// --- flows in progress ------------------------------------------------------

#[derive(Clone, Debug)]
pub enum Intent {
    SignIn,
    /// Add this identity to the signed-in account `user_id`.
    Link {
        user_id: String,
    },
    /// Become the first admin of an empty instance.
    Claim,
    /// Join through an invitation (the token's hash, never the token).
    Invite {
        token_hash: String,
    },
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

/// Sign-ins in progress at most. Anyone can start one, so the table is capped.
const MAX_FLOWS: usize = 10_000;

impl Flows {
    /// ponytail: at the cap, an O(n) scan for the oldest; fine at 10 000, an
    /// ordered map if the cap ever grows by orders of magnitude.
    fn insert(&self, id: String, flow: Flow) {
        let mut flows = self.0.lock().unwrap();
        flows.retain(|_, f| f.started.elapsed() < FLOW_TTL);
        if flows.len() >= MAX_FLOWS
            && let Some(oldest) = flows
                .iter()
                .min_by_key(|(_, f)| f.started)
                .map(|(k, _)| k.clone())
        {
            flows.remove(&oldest);
        }
        flows.insert(id, flow);
    }
    /// Removes and returns the flow: each is usable once.
    fn take(&self, id: &str) -> Option<Flow> {
        self.0
            .lock()
            .unwrap()
            .remove(id)
            .filter(|f| f.started.elapsed() < FLOW_TTL)
    }
}

/// Only a path on this origin: `/boards/x`, never `//evil.example`,
/// `https://evil.example`, or `/\t/evil.example` (browsers drop tabs and
/// newlines while parsing, so that one would leave). Judged the way a browser
/// will read it: resolved against an origin and compared. Which origin does
/// not matter, only that the path cannot leave it.
pub fn safe_return(path: Option<&str>) -> String {
    match path {
        Some(p) if same_origin_path(p) => p.into(),
        _ => "/".into(),
    }
}

pub fn same_origin_path(p: &str) -> bool {
    let base = reqwest::Url::parse("https://visarium.invalid/").expect("a URL");
    p.starts_with('/')
        && !p.chars().any(char::is_control)
        && base.join(p).is_ok_and(|u| u.origin() == base.origin())
}

fn redirect(to: &str) -> Response {
    (
        StatusCode::FOUND,
        [(
            header::LOCATION,
            HeaderValue::from_str(to).unwrap_or(HeaderValue::from_static("/")),
        )],
    )
        .into_response()
}

/// Every failure lands on the sign-in page with a code the SPA turns into a
/// sentence; the details go to the log, not the address bar.
fn failed(code: &str) -> Response {
    tracing::warn!(method = "oidc", reason = code, "sign-in refused");
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

fn find(app: &AppState, id: &str) -> Option<Arc<Provider>> {
    active(app).into_iter().find(|p| p.id == id)
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
            Some(user) => Intent::Link {
                user_id: user.id.clone(),
            },
            None => return failed("signed-out"),
        },
        _ => return failed("bad-request"),
    };
    match begin(
        &app,
        &headers,
        &provider,
        intent,
        safe_return(q.return_to.as_deref()),
    )
    .await
    {
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
    let client = p
        .metadata(&app.http)
        .await
        .and_then(|m| p.client(m, public_url))
        .map_err(|e| {
            tracing::warn!(provider = %p.id, error = %e, "could not reach the provider");
            "provider-unreachable"
        })?;
    let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
    let (url, state, nonce) = client
        .authorize_url(
            CoreAuthenticationFlow::AuthorizationCode,
            CsrfToken::new_random,
            Nonce::new_random,
        )
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
    Ok((
        url.to_string(),
        FLOW.set(
            &flow_id,
            auth::is_secure(headers),
            FLOW_TTL.as_secs() as i64,
        ),
    ))
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
    /// The `iss` that verified this ID token.
    pub issuer: String,
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
            } else if find(&app, &provider).is_none() {
                // Turned off or removed while this sign-in was at the provider.
                failed("provider-gone")
            } else {
                match verify(&app, &provider, q.code.unwrap_or_default(), &flow).await {
                    Ok(identity) => finish(&app, &headers, &principal, identity, flow).await,
                    Err(e) => {
                        tracing::debug!(provider, error = %e, "provider's answer did not verify");
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
async fn verify(
    app: &AppState,
    provider: &str,
    code: String,
    flow: &Flow,
) -> Result<Identity, String> {
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
            id_token
                .claims(&client.id_token_verifier(), &nonce)
                .map_err(|e| e.to_string())?
                .clone()
        }
        Err(e) => return Err(e.to_string()),
    };
    let email = claims
        .email()
        .filter(|_| claims.email_verified() == Some(true))
        .map(|e| e.as_str().to_lowercase());
    Ok(Identity {
        provider: provider.into(),
        subject: claims.subject().as_str().into(),
        issuer: claims.issuer().as_str().into(),
        email,
        name: claims
            .name()
            .and_then(|n| n.get(None))
            .map(|n| n.as_str().to_string()),
        preferred_username: claims.preferred_username().map(|u| u.as_str().to_string()),
    })
}

/// Who an identity is linked to, by `(provider, sub)` and the issuer that
/// vouched for it. A link from before issuers were recorded adopts this one.
enum Linked {
    None,
    To(String),
    /// The provider id now names a different issuer: not this account.
    OtherIssuer,
}

async fn linked_user(db: &sqlx::SqlitePool, identity: &Identity) -> sqlx::Result<Linked> {
    let row: Option<(String, Option<String>)> = sqlx::query_as(
        "SELECT user_id, issuer FROM user_identity WHERE provider = ? AND subject = ?",
    )
    .bind(&identity.provider)
    .bind(&identity.subject)
    .fetch_optional(db)
    .await?;
    Ok(match row {
        None => Linked::None,
        Some((user, Some(issuer))) if issuer == identity.issuer => Linked::To(user),
        Some((_, Some(_))) => {
            tracing::warn!(provider = %identity.provider, "an identity from a different issuer than the one it was linked through");
            Linked::OtherIssuer
        }
        Some((user, None)) => {
            sqlx::query("UPDATE user_identity SET issuer = ? WHERE provider = ? AND subject = ? AND issuer IS NULL")
                .bind(&identity.issuer)
                .bind(&identity.provider)
                .bind(&identity.subject)
                .execute(db)
                .await?;
            Linked::To(user)
        }
    })
}

pub async fn link<'e>(
    db: impl sqlx::SqliteExecutor<'e>,
    user_id: &str,
    identity: &Identity,
) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO user_identity (provider, subject, user_id, email, issuer) VALUES (?, ?, ?, ?, ?)")
        .bind(&identity.provider)
        .bind(&identity.subject)
        .bind(user_id)
        .bind(&identity.email)
        .bind(&identity.issuer)
        .execute(db)
        .await
        .map(|_| ())
}

/// Resolves the account, in order: an identity already linked; linking to the
/// signed-in account; an invitation; claiming an empty instance. Nothing else
/// creates or finds an account — in particular, not a matching email.
async fn finish(
    app: &AppState,
    headers: &HeaderMap,
    principal: &Principal,
    identity: Identity,
    flow: Flow,
) -> Response {
    match resolve(app, &identity, &flow.intent, principal).await {
        Ok(Resolved::SignIn(user_id)) => {
            // Keep the address book current; nothing ever matches on it.
            if let Err(e) = sqlx::query("UPDATE user_identity SET email = coalesce(?, email) WHERE provider = ? AND subject = ?")
                .bind(&identity.email)
                .bind(&identity.provider)
                .bind(&identity.subject)
                .execute(&app.db)
                .await
            {
                // Sign-in goes ahead; Settings shows the old address.
                tracing::warn!(provider = %identity.provider, error = %e, "could not update a linked identity's address");
            }
            match auth::start_session(
                app,
                principal.session_hash(),
                &user_id,
                Kind::Browser,
                &auth::browser_label(headers),
            )
            .await
            {
                Ok(token) => {
                    tracing::info!(user = %user_id, method = "oidc", provider = %identity.provider, "signed in");
                    let mut response = redirect(&flow.return_to);
                    response.headers_mut().append(
                        header::SET_COOKIE,
                        SESSION.set(&token, auth::is_secure(headers), Kind::Browser.idle_secs()),
                    );
                    response
                }
                Err(e) => {
                    tracing::error!(error = %e.detail, "could not start a session");
                    failed("server-error")
                }
            }
        }
        Ok(Resolved::Linked) => {
            tracing::info!(provider = %identity.provider, "sign-in method linked");
            redirect(&flow.return_to)
        }
        Err(code) => failed(code),
    }
}

enum Resolved {
    SignIn(String),
    Linked,
}

async fn resolve(
    app: &AppState,
    identity: &Identity,
    intent: &Intent,
    principal: &Principal,
) -> Result<Resolved, &'static str> {
    let db = &app.db;
    let linked = match linked_user(db, identity)
        .await
        .map_err(|_| "server-error")?
    {
        Linked::None => None,
        Linked::To(user) => Some(user),
        // `(provider, sub)` is taken by another issuer's identity: nobody's
        // account, and nothing new can be linked under it.
        Linked::OtherIssuer => {
            return Err(match intent {
                Intent::SignIn => "no-account",
                Intent::Link { .. } => "linked-elsewhere",
                _ => "already-registered",
            });
        }
    };
    match (intent, linked) {
        (Intent::Link { user_id }, Some(owner)) => {
            if &owner == user_id {
                Ok(Resolved::Linked)
            } else {
                Err("linked-elsewhere")
            }
        }
        (Intent::Link { user_id }, None) => {
            // The account that asked must still be the one signed in here.
            if principal.user().map(|u| &u.id) != Some(user_id) {
                return Err("signed-out");
            }
            link(db, user_id, identity)
                .await
                .map_err(|_| "server-error")?;
            Ok(Resolved::Linked)
        }
        (Intent::Invite { .. } | Intent::Claim, Some(_)) => Err("already-registered"),
        (_, Some(user_id)) => {
            let user = auth::find_user(db, &user_id)
                .await
                .map_err(|_| "server-error")?
                .ok_or("server-error")?;
            if user.deactivated_at.is_some() {
                Err("deactivated")
            } else {
                Ok(Resolved::SignIn(user_id))
            }
        }
        (Intent::Invite { token_hash }, None) => {
            let mut tx = db.begin().await.map_err(|_| "server-error")?;
            let user = crate::invitations::join_in(
                &mut tx,
                token_hash,
                &username_for(db, identity).await,
                &display_name_for(identity),
                None,
            )
            .await
            .map_err(|e| crate::invitations::reason(&e))?;
            link(&mut *tx, &user.id, identity)
                .await
                .map_err(|_| "server-error")?;
            tx.commit().await.map_err(|_| "server-error")?;
            Ok(Resolved::SignIn(user.id))
        }
        (Intent::Claim, None) => {
            let _guard = app.setup_lock.lock().await;
            let mut tx = db.begin().await.map_err(|_| "server-error")?;
            let user = auth::claim_in(
                &mut tx,
                &username_for(db, identity).await,
                &display_name_for(identity),
                None,
            )
            .await
            .map_err(|_| "already-claimed")?;
            link(&mut *tx, &user.id, identity)
                .await
                .map_err(|_| "server-error")?;
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
        .map(|c| {
            if c.is_ascii_lowercase() || c.is_ascii_digit() || "._-".contains(c) {
                c
            } else {
                '-'
            }
        })
        .take(56)
        .collect();
    base = base.trim_matches(['-', '.', '_']).to_string();
    if base.len() < 2 {
        base = "member".into();
    }
    for n in 1.. {
        let candidate = if n == 1 {
            base.clone()
        } else {
            format!("{base}-{n}")
        };
        let taken: bool =
            sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM app_user WHERE username = ?)")
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
        .or_else(|| {
            identity
                .email
                .as_deref()
                .and_then(|e| e.split('@').next())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "Member".into());
    let name: String = name.trim().chars().take(64).collect();
    if name.is_empty() {
        "Member".into()
    } else {
        name
    }
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
    let has_password: bool =
        sqlx::query_scalar("SELECT password_hash IS NOT NULL FROM app_user WHERE id = ?")
            .bind(&me.id)
            .fetch_one(&app.db)
            .await?;
    let named: Vec<_> = identities
        .into_iter()
        .map(|i| {
            let name = find(&app, &i.provider).map_or(i.provider.clone(), |p| p.name.clone());
            serde_json::json!({ "provider": i.provider, "name": name, "email": i.email, "createdAt": i.created_at })
        })
        .collect();
    Ok(axum::Json(
        serde_json::json!({ "hasPassword": has_password, "identities": named }),
    ))
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
        return Err(ApiError::conflict(
            "this is your last way to sign in; add a password or another provider first",
        )
        .titled("Cannot remove your last sign-in method"));
    }
    let done = sqlx::query("DELETE FROM user_identity WHERE user_id = ? AND provider = ?")
        .bind(&me.id)
        .bind(&provider)
        .execute(&app.db)
        .await?;
    if done.rows_affected() == 0 {
        return Err(ApiError::not_found(format!(
            "no {provider} sign-in on this account"
        )));
    }
    tracing::info!(user = %me.id, provider, "sign-in method removed");
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn way_in_needs_a_method_for_everyone_and_for_the_admin() {
        let google = vec!["google".to_string()];
        assert!(
            way_in(false, &[], None).is_err(),
            "passwords off, no provider"
        );
        assert!(way_in(true, &[], None).is_ok());
        assert!(way_in(false, &google, None).is_ok());
        // An admin with only Google, removing Google, passwords on.
        assert!(way_in(true, &[], Some((false, &google))).is_err());
        // The same admin with a password keeps a way in.
        assert!(way_in(true, &[], Some((true, &google))).is_ok());
        // A password does not count while passwords are off.
        assert!(way_in(false, &["authentik".into()], Some((true, &google))).is_err());
        assert!(way_in(false, &google, Some((false, &google))).is_ok());
    }

    fn vars(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn google_is_a_preset_and_others_need_an_issuer() {
        let got = providers_from_env(vars(&[
            ("VISARIUM_OIDC_GOOGLE_CLIENT_ID", "g-id"),
            ("VISARIUM_OIDC_GOOGLE_CLIENT_SECRET", "g-secret"),
            (
                "VISARIUM_OIDC_STUDIO_SSO_ISSUER",
                "https://id.example/o/visarium/",
            ),
            ("VISARIUM_OIDC_STUDIO_SSO_CLIENT_ID", "s-id"),
            ("VISARIUM_OIDC_STUDIO_SSO_CLIENT_SECRET", "s-secret"),
            ("VISARIUM_OIDC_STUDIO_SSO_NAME", "Studio SSO"),
            ("VISARIUM_PORT", "8080"),
        ]))
        .unwrap();
        assert_eq!(
            got[0],
            ProviderConfig {
                id: "google".into(),
                name: "Google".into(),
                issuer: GOOGLE_ISSUER.into(),
                client_id: "g-id".into(),
                client_secret: "g-secret".into(),
            }
        );
        assert_eq!(
            (got[1].id.as_str(), got[1].name.as_str()),
            ("studio-sso", "Studio SSO")
        );

        let no_issuer = providers_from_env(vars(&[
            ("VISARIUM_OIDC_AUTH_CLIENT_ID", "a"),
            ("VISARIUM_OIDC_AUTH_CLIENT_SECRET", "b"),
        ]));
        assert_eq!(
            no_issuer.unwrap_err(),
            "VISARIUM_OIDC_AUTH_ISSUER is required"
        );
        let no_secret = providers_from_env(vars(&[("VISARIUM_OIDC_GOOGLE_CLIENT_ID", "a")]));
        assert_eq!(
            no_secret.unwrap_err(),
            "VISARIUM_OIDC_GOOGLE_CLIENT_SECRET is required"
        );
        assert!(
            providers_from_env(vars(&[("VISARIUM_OIDC_GOOGLE_SECRET", "x")])).is_err(),
            "a typo is loud"
        );
    }

    #[test]
    fn pending_flows_are_capped_and_keep_the_newest() {
        let flows = Flows::default();
        let flow = || Flow {
            provider: "p".into(),
            state: String::new(),
            nonce: String::new(),
            verifier: String::new(),
            intent: Intent::SignIn,
            return_to: "/".into(),
            started: Instant::now(),
        };
        for n in 0..MAX_FLOWS + 5 {
            flows.insert(n.to_string(), flow());
        }
        assert_eq!(flows.0.lock().unwrap().len(), MAX_FLOWS);
        assert!(
            flows.take(&(MAX_FLOWS + 4).to_string()).is_some(),
            "the newest is kept"
        );
        assert!(flows.take("0").is_none(), "the oldest went first");
    }

    #[test]
    fn return_paths_stay_on_this_origin() {
        assert_eq!(safe_return(Some("/boards/abc?x=1")), "/boards/abc?x=1");
        for bad in [
            "https://evil.example/",
            "//evil.example",
            "/\\evil.example",
            "boards",
            "/a\r\nSet-Cookie: x",
            "/\t/evil.example",
            "/\n/evil.example",
            "/\u{0}x",
            "/\\/evil.example",
        ] {
            assert_eq!(safe_return(Some(bad)), "/", "{bad}");
        }
        assert_eq!(safe_return(None), "/");
    }
}
