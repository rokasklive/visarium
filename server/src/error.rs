//! Every refusal is RFC 9457 `application/problem+json`, never HTML and never a
//! redirect: `openapi-fetch` parses every response as JSON, and the SPA reads
//! `detail` to say why something failed.

use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value, json};

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub title: Option<String>,
    pub detail: String,
    pub extra: Map<String, Value>,
}

pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    pub fn new(status: StatusCode, detail: impl Into<String>) -> Self {
        Self {
            status,
            title: None,
            detail: detail.into(),
            extra: Map::new(),
        }
    }
    pub fn titled(mut self, title: &str) -> Self {
        self.title = Some(title.into());
        self
    }
    pub fn with(mut self, key: &str, value: Value) -> Self {
        self.extra.insert(key.into(), value);
        self
    }
    pub fn bad_request(detail: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, detail)
    }
    pub fn not_found(detail: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, detail)
    }
    pub fn forbidden(detail: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, detail)
    }
    pub fn conflict(detail: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, detail)
    }
    pub fn unauthorized(detail: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, detail).titled("Not signed in")
    }
    pub fn internal(detail: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, detail)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        // Logged once, on the access line (telemetry::http), with this cause.
        let cause = self
            .status
            .is_server_error()
            .then(|| crate::telemetry::ErrorCause(self.detail.clone()));
        let mut body = json!({
            "type": "about:blank",
            "title": self.title.unwrap_or_else(|| self.status.canonical_reason().unwrap_or("Error").into()),
            "status": self.status.as_u16(),
            "detail": self.detail,
        });
        body.as_object_mut().unwrap().extend(self.extra);
        if let Some(id) = crate::telemetry::request_id() {
            body["requestId"] = id.into();
        }
        let mut response = (
            self.status,
            [(header::CONTENT_TYPE, "application/problem+json")],
            body.to_string(),
        )
            .into_response();
        if let Some(cause) = cause {
            response.extensions_mut().insert(cause);
        }
        response
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        Self::internal(format!("database error: {e}"))
    }
}

impl From<std::io::Error> for ApiError {
    fn from(e: std::io::Error) -> Self {
        Self::internal(format!("i/o error: {e}"))
    }
}

pub fn is_unique_violation(e: &sqlx::Error) -> bool {
    e.as_database_error()
        .is_some_and(|d| d.is_unique_violation())
}

pub fn is_foreign_key_violation(e: &sqlx::Error) -> bool {
    e.as_database_error()
        .is_some_and(|d| d.is_foreign_key_violation())
}

/// A JSON body that answers 400 problem+json when malformed, instead of axum's
/// plain-text rejection.
pub struct Json<T>(pub T);

impl<S, T> axum::extract::FromRequest<S> for Json<T>
where
    T: serde::de::DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;
    async fn from_request(req: axum::extract::Request, state: &S) -> Result<Self, ApiError> {
        axum::Json::<T>::from_request(req, state)
            .await
            .map(|axum::Json(v)| Json(v))
            .map_err(|e| ApiError::bad_request(e.body_text()))
    }
}
