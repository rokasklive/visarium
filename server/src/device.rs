//! Signing the desktop app in through the system browser (ADR-0027).
//!
//! Google refuses OAuth inside embedded webviews, and RFC 8252 says native
//! apps must not do authorization in one, so the desktop opens the system
//! browser at the SPA's `/device` page. There the person signs in by any
//! method and allows the device; the SPA asks `authorize` for a one-time code
//! and goes to `http://127.0.0.1:{port}/callback`, where the desktop is
//! listening. The desktop trades code + PKCE verifier for a device session.
//!
//! The server takes a port and nothing else, so it can only ever send the
//! browser to 127.0.0.1: this cannot be bent into an open redirect. A local
//! program that intercepts the code cannot use it without the verifier, which
//! never left the desktop process.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::Router;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use base64::Engine;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::AppState;
use crate::auth::{self, Kind, User};
use crate::error::{ApiError, ApiResult, Json};

/// A code is good for this long, once.
pub const CODE_TTL: Duration = Duration::from_secs(60);

struct Pending {
    user_id: String,
    challenge: String,
    label: String,
    issued: Instant,
}

/// Codes waiting to be redeemed. ponytail: in memory; they live a minute.
#[derive(Default)]
pub struct Codes(Mutex<HashMap<String, Pending>>);

impl Codes {
    fn insert(&self, code: String, pending: Pending) {
        let mut codes = self.0.lock().unwrap();
        codes.retain(|_, p| p.issued.elapsed() < CODE_TTL);
        codes.insert(code, pending);
    }
    /// Removes it whatever happens next: a code is single-use even when the
    /// verifier turns out wrong.
    fn take(&self, code: &str) -> Option<Pending> {
        self.0
            .lock()
            .unwrap()
            .remove(code)
            .filter(|p| p.issued.elapsed() < CODE_TTL)
    }
}

/// Signed-in member: allow a device.
pub fn member_routes() -> Router<AppState> {
    Router::new().route("/device/authorize", post(authorize))
}

/// Open: the desktop redeems its code.
pub fn public_routes() -> Router<AppState> {
    Router::new().route("/device-tokens", post(exchange))
}

#[derive(Deserialize)]
struct Authorize {
    port: u16,
    /// base64url(SHA-256(verifier)), no padding: 43 characters.
    challenge: String,
    state: String,
    label: Option<String>,
}

fn is_base64url(s: &str) -> bool {
    s.bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

async fn authorize(
    State(app): State<AppState>,
    axum::Extension(me): axum::Extension<User>,
    Json(body): Json<Authorize>,
) -> ApiResult<axum::Json<serde_json::Value>> {
    if body.port < 1024 {
        return Err(ApiError::bad_request(
            "the desktop app listens on a port above 1023",
        ));
    }
    if body.challenge.len() != 43 || !is_base64url(&body.challenge) {
        return Err(ApiError::bad_request(
            "the challenge must be an S256 PKCE challenge",
        ));
    }
    if body.state.is_empty() || body.state.len() > 128 || !is_base64url(&body.state) {
        return Err(ApiError::bad_request(
            "the state must be 1–128 base64url characters",
        ));
    }
    let label = body
        .label
        .as_deref()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .unwrap_or("Visarium Desktop");
    let code = auth::random_token();
    app.device_codes.insert(
        code.clone(),
        Pending {
            user_id: me.id,
            challenge: body.challenge,
            label: label.chars().take(80).collect(),
            issued: Instant::now(),
        },
    );
    Ok(axum::Json(
        json!({ "redirect": format!("http://127.0.0.1:{}/callback?code={code}&state={}", body.port, body.state) }),
    ))
}

#[derive(Deserialize)]
struct Exchange {
    code: String,
    verifier: String,
}

/// Code + verifier → a device token: a `device` session the member can see
/// and revoke from any browser, which survives server restarts.
async fn exchange(
    State(app): State<AppState>,
    Json(body): Json<Exchange>,
) -> ApiResult<(StatusCode, axum::Json<serde_json::Value>)> {
    let refused = || {
        ApiError::unauthorized("that sign-in code is not valid; sign in again from the desktop app")
    };
    let pending = app.device_codes.take(&body.code).ok_or_else(refused)?;
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(Sha256::digest(body.verifier.as_bytes()));
    if challenge != pending.challenge {
        return Err(refused());
    }
    let user = auth::find_user(&app.db, &pending.user_id)
        .await?
        .filter(|u| u.deactivated_at.is_none())
        .ok_or_else(refused)?;
    let token = auth::create_session(
        &app.db,
        Kind::Device,
        Some(&user.id),
        None,
        None,
        Some(&pending.label),
    )
    .await?;
    Ok((
        StatusCode::CREATED,
        axum::Json(json!({ "token": token, "user": user })),
    ))
}

#[cfg(test)]
mod tests {
    #[test]
    fn rfc7636_appendix_b_challenge() {
        use base64::Engine;
        use sha2::{Digest, Sha256};
        let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(
            b"dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
        ));
        assert_eq!(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }
}
