//! A minimal OpenID provider, in process, for the sign-in tests: discovery,
//! JWKS, an authorization endpoint that signs in whoever the test says, and a
//! token endpoint that checks PKCE and signs real RS256 ID tokens. Everything
//! `oidc.rs` does against Google it does against this, with no network.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::extract::{Form, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use openidconnect::core::{
    CoreIdToken, CoreIdTokenClaims, CoreJsonWebKeySet, CoreJwsSigningAlgorithm,
    CoreProviderMetadata, CoreResponseType, CoreRsaPrivateSigningKey, CoreSubjectIdentifierType,
};
use openidconnect::{
    Audience, AuthUrl, EmptyAdditionalClaims, EmptyAdditionalProviderMetadata, EndUserEmail,
    EndUserName, IssuerUrl, JsonWebKeyId, JsonWebKeySetUrl, LocalizedClaim, Nonce,
    PrivateSigningKey, ResponseTypes, StandardClaims, SubjectIdentifier, TokenUrl,
};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

pub const CLIENT_ID: &str = "visarium-test";
pub const CLIENT_SECRET: &str = "test-secret";

#[derive(Clone)]
pub struct Person {
    pub sub: String,
    pub email: Option<String>,
    pub email_verified: bool,
    pub name: Option<String>,
}

impl Person {
    pub fn new(sub: &str, email: &str) -> Self {
        Self {
            sub: sub.into(),
            email: Some(email.into()),
            email_verified: true,
            name: Some(sub.to_uppercase()),
        }
    }
}

struct Pending {
    person: Person,
    nonce: String,
    challenge: String,
}

#[derive(Default)]
struct Inner {
    /// Who signs in at the next authorization request.
    next: Option<Person>,
    codes: HashMap<String, Pending>,
}

#[derive(Clone)]
pub struct Issuer {
    pub url: String,
    inner: Arc<Mutex<Inner>>,
    key: Arc<CoreRsaPrivateSigningKey>,
}

impl Issuer {
    pub async fn start() -> Self {
        use rsa::pkcs1::EncodeRsaPrivateKey;
        let private = rsa::PrivateKey::new(&mut rand::rng(), 2048).unwrap();
        let pem = private.to_pkcs1_pem(rsa::pkcs1::LineEnding::LF).unwrap();
        let key =
            CoreRsaPrivateSigningKey::from_pem(&pem, Some(JsonWebKeyId::new("k1".into()))).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        let issuer = Self {
            url: format!("http://{addr}"),
            inner: Default::default(),
            key: Arc::new(key),
        };
        let app = Router::new()
            .route("/.well-known/openid-configuration", get(discovery))
            .route("/jwks", get(jwks))
            .route("/authorize", get(authorize))
            .route("/token", post(token))
            .with_state(issuer.clone());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        issuer
    }

    /// The next authorization request signs this person in.
    pub fn next(&self, person: Person) {
        self.inner.lock().unwrap().next = Some(person);
    }

    pub fn provider(&self, id: &str) -> visarium::oidc::ProviderConfig {
        visarium::oidc::ProviderConfig {
            id: id.into(),
            name: "Test SSO".into(),
            issuer: self.url.clone(),
            client_id: CLIENT_ID.into(),
            client_secret: CLIENT_SECRET.into(),
        }
    }
}

async fn discovery(State(i): State<Issuer>) -> Json<CoreProviderMetadata> {
    Json(
        CoreProviderMetadata::new(
            IssuerUrl::new(i.url.clone()).unwrap(),
            AuthUrl::new(format!("{}/authorize", i.url)).unwrap(),
            JsonWebKeySetUrl::new(format!("{}/jwks", i.url)).unwrap(),
            vec![ResponseTypes::new(vec![CoreResponseType::Code])],
            vec![CoreSubjectIdentifierType::Public],
            vec![CoreJwsSigningAlgorithm::RsaSsaPkcs1V15Sha256],
            EmptyAdditionalProviderMetadata {},
        )
        .set_token_endpoint(Some(TokenUrl::new(format!("{}/token", i.url)).unwrap())),
    )
}

async fn jwks(State(i): State<Issuer>) -> Json<CoreJsonWebKeySet> {
    Json(CoreJsonWebKeySet::new(vec![i.key.as_verification_key()]))
}

#[derive(Deserialize)]
struct AuthorizeQuery {
    client_id: String,
    redirect_uri: String,
    state: String,
    nonce: String,
    code_challenge: String,
    code_challenge_method: String,
}

async fn authorize(State(i): State<Issuer>, Query(q): Query<AuthorizeQuery>) -> Response {
    assert_eq!(q.client_id, CLIENT_ID);
    assert_eq!(q.code_challenge_method, "S256", "PKCE must be S256");
    let Some(person) = i.inner.lock().unwrap().next.take() else {
        return (
            StatusCode::FOUND,
            [(
                header::LOCATION,
                format!("{}?error=access_denied&state={}", q.redirect_uri, q.state),
            )],
        )
            .into_response();
    };
    let code = uuid::Uuid::new_v4().to_string();
    i.inner.lock().unwrap().codes.insert(
        code.clone(),
        Pending {
            person,
            nonce: q.nonce,
            challenge: q.code_challenge,
        },
    );
    (
        StatusCode::FOUND,
        [(
            header::LOCATION,
            format!("{}?code={code}&state={}", q.redirect_uri, q.state),
        )],
    )
        .into_response()
}

#[derive(Deserialize)]
struct TokenForm {
    code: String,
    code_verifier: String,
}

async fn token(State(i): State<Issuer>, Form(f): Form<TokenForm>) -> Response {
    let Some(p) = i.inner.lock().unwrap().codes.remove(&f.code) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid_grant" })),
        )
            .into_response();
    };
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(Sha256::digest(f.code_verifier.as_bytes()));
    if challenge != p.challenge {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid_grant", "error_description": "PKCE" })),
        )
            .into_response();
    }
    let now = chrono::Utc::now();
    let mut standard = StandardClaims::new(SubjectIdentifier::new(p.person.sub.clone()));
    standard = standard
        .set_email(p.person.email.clone().map(EndUserEmail::new))
        .set_email_verified(Some(p.person.email_verified))
        .set_name(
            p.person
                .name
                .clone()
                .map(|n| LocalizedClaim::from(EndUserName::new(n))),
        );
    let claims = CoreIdTokenClaims::new(
        IssuerUrl::new(i.url.clone()).unwrap(),
        vec![Audience::new(CLIENT_ID.into())],
        now + chrono::Duration::minutes(5),
        now,
        standard,
        EmptyAdditionalClaims {},
    )
    .set_nonce(Some(Nonce::new(p.nonce)));
    let id_token = CoreIdToken::new(
        claims,
        i.key.as_ref(),
        CoreJwsSigningAlgorithm::RsaSsaPkcs1V15Sha256,
        None,
        None,
    )
    .unwrap();
    Json(json!({ "access_token": "at", "token_type": "Bearer", "expires_in": 300, "id_token": id_token.to_string() })).into_response()
}
