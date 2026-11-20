//! Logging setup, shared by the server binary and the desktop app, and the
//! rules every log event in this codebase follows.
//!
//! Levels mean one thing each:
//!   * `error` — a person needs to act (a 5xx, a panic, data at risk);
//!   * `warn`  — something failed and was handled (a retry, a dropped client);
//!   * `info`  — few, lifecycle and business events: startup, a request, a
//!     sign-in, a socket opening or closing, an agent tool call;
//!   * `debug` — detail for each operation (4xx, background runs, health);
//!   * `trace` — payload-level detail. Never on in a release by default.
//!
//! Values go in named fields with a fixed message:
//! `warn!(asset = %id, error = %e, "could not pre-generate derivatives")`,
//! not `warn!("could not ... {id}: {e}")`. The names in use: `board`, `item`,
//! `user`, `asset`, `share`, `invitation`, `token`, `conn`, `request_id`,
//! `route`, `tool`, `agent`, `provider`, `method`, `reason`, `error`,
//! `duration_ms`.
//!
//! Never logged, at any level: passwords or their hashes, session, agent or
//! share tokens, cookies, OIDC codes, client secrets, email addresses, raw
//! request URIs (they carry share and invitation secrets), request bodies,
//! header maps, and the text of notes, diagrams, checklists or board titles.
//! People and objects are named by their opaque IDs. Do not `Debug`-print a
//! struct that holds any of these. `tests/logging.rs` checks the common paths.
//!
//! An error is logged once, where it is handled, with its cause in `error`.
//! `let _ = fallible()` is only for failures that cannot affect the user or
//! data (a window title, a close frame to a peer already gone), and says why
//! in a comment.

use std::path::Path;

use tracing::Subscriber;
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    /// One readable line per event; the default.
    Text,
    /// One JSON object per line, for container log collectors.
    Json,
}

impl Format {
    /// `VISARIUM_LOG_FORMAT`: `json`, or anything else for text.
    pub fn parse(value: &str) -> Self {
        if value.eq_ignore_ascii_case("json") {
            Self::Json
        } else {
            Self::Text
        }
    }
}

pub struct Options<'a> {
    /// `VISARIUM_LOG_LEVEL`: error, warn, info, debug or trace.
    pub level: &'a str,
    pub format: Format,
    /// A folder for daily log files, kept for 7 days (the desktop app).
    pub file_dir: Option<&'a Path>,
}

/// The prefix of every log file name: `visarium.2026-11-20.log`.
pub const LOG_FILE_PREFIX: &str = "visarium";

/// What is recorded: `RUST_LOG` when set, otherwise this codebase at `level`
/// and the libraries it uses only when they warn.
pub fn filter(level: &str) -> EnvFilter {
    EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        EnvFilter::new(format!(
            "warn,visarium={level},visarium_desktop={level},tower_http=warn"
        ))
    })
}

/// The formatting layer for one destination.
pub fn layer<S, W>(format: Format, writer: W, ansi: bool) -> Box<dyn Layer<S> + Send + Sync>
where
    S: Subscriber + for<'a> LookupSpan<'a>,
    W: for<'w> MakeWriter<'w> + Send + Sync + 'static,
{
    let base = tracing_subscriber::fmt::layer()
        .with_writer(writer)
        .with_ansi(ansi);
    match format {
        Format::Text => base.boxed(),
        Format::Json => base
            .json()
            .with_current_span(true)
            .with_span_list(false)
            .boxed(),
    }
}

/// Installs logging for the whole process, and a panic hook that logs.
pub fn init(options: Options<'_>) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use std::io::IsTerminal;
    // Colour only for a person at a terminal, not for `docker logs` or a file.
    let ansi = options.format == Format::Text && std::io::stdout().is_terminal();
    let mut layers = vec![layer(options.format, std::io::stdout, ansi)];
    if let Some(dir) = options.file_dir {
        // ponytail: written synchronously. One person's desktop logs little,
        // and a crash must not take its last lines with it.
        let files = tracing_appender::rolling::Builder::new()
            .rotation(tracing_appender::rolling::Rotation::DAILY)
            .filename_prefix(LOG_FILE_PREFIX)
            .filename_suffix("log")
            .max_log_files(7)
            .build(dir)?;
        layers.push(layer(Format::Text, files, false));
    }
    tracing_subscriber::registry()
        .with(filter(options.level))
        .with(layers)
        .try_init()?;
    log_panics();
    Ok(())
}

fn log_panics() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info.location().map(ToString::to_string).unwrap_or_default();
        tracing::error!(
            panic = info.payload_as_str().unwrap_or("(not a string)"),
            location,
            "panic"
        );
        previous(info);
    }));
}

// --- HTTP: request IDs and the access log ------------------------------------

tokio::task_local! {
    static REQUEST_ID: String;
}

/// The ID of the request being handled, if any (for problem+json bodies).
pub fn request_id() -> Option<String> {
    REQUEST_ID.try_with(Clone::clone).ok()
}

/// What a 5xx failed on, carried from the error to the access log line so the
/// failure is logged once, with its cause.
#[derive(Clone)]
pub struct ErrorCause(pub String);

const REQUEST_ID_HEADER: &str = "x-request-id";

/// Keeps a proxy's ID when it is plain and short, so the two logs line up.
fn usable_request_id(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Gives every request an ID (answered in `x-request-id`), a `request` span
/// for everything logged while handling it, and one line when it is answered.
pub async fn http(
    mut request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::http::HeaderValue;
    use tracing::Instrument;

    let id = request
        .headers()
        .get(REQUEST_ID_HEADER)
        .and_then(|v| v.to_str().ok())
        .filter(|v| usable_request_id(v))
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
    let header = HeaderValue::from_str(&id).expect("checked or generated ASCII");
    request
        .headers_mut()
        .insert(REQUEST_ID_HEADER, header.clone());
    // The route pattern, never the URI: paths carry share and invite secrets.
    let route = request
        .extensions()
        .get::<axum::extract::MatchedPath>()
        .map(|m| m.as_str().to_owned());
    let quiet = match &route {
        Some(r) => r.starts_with("/health"),
        // The SPA's files and pages.
        None => !request.uri().path().starts_with("/api/"),
    };
    let route = route.unwrap_or_else(|| "fallback".into());
    let method = request.method().clone();
    let span = tracing::info_span!("request", request_id = %id, %method, %route);
    let started = std::time::Instant::now();
    let mut response = REQUEST_ID
        .scope(id, next.run(request))
        .instrument(span.clone())
        .await;
    response.headers_mut().insert(REQUEST_ID_HEADER, header);

    let _entered = span.enter();
    let status = response.status().as_u16();
    let duration_ms = started.elapsed().as_millis() as u64;
    if response.status().is_server_error() {
        let error = response
            .extensions()
            .get::<ErrorCause>()
            .map(|c| c.0.as_str());
        tracing::error!(status, duration_ms, error, "request failed");
    } else if response.status().is_client_error() || quiet {
        tracing::debug!(status, duration_ms, "request");
    } else {
        tracing::info!(status, duration_ms, "request");
    }
    response
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    #[derive(Clone, Default)]
    struct Buffer(Arc<Mutex<Vec<u8>>>);

    impl std::io::Write for Buffer {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn json_lines_carry_timestamp_level_target_fields_and_span() {
        let buffer = Buffer::default();
        let writer = buffer.clone();
        let subscriber =
            tracing_subscriber::registry().with(layer(Format::Json, move || writer.clone(), false));
        tracing::subscriber::with_default(subscriber, || {
            let span = tracing::info_span!("request", request_id = "r1");
            let _entered = span.enter();
            tracing::info!(board = "b1", "board read");
        });
        let text = String::from_utf8(buffer.0.lock().unwrap().clone()).unwrap();
        let line: serde_json::Value = serde_json::from_str(text.trim()).unwrap();
        assert!(line["timestamp"].as_str().unwrap().ends_with('Z'));
        assert_eq!(line["level"], "INFO");
        assert_eq!(line["target"], "visarium::telemetry::tests");
        assert_eq!(line["fields"]["board"], "b1");
        assert_eq!(line["fields"]["message"], "board read");
        assert_eq!(line["span"]["request_id"], "r1");
    }

    #[test]
    fn a_panic_is_logged_with_its_message_and_location() {
        let buffer = Buffer::default();
        let writer = buffer.clone();
        let subscriber =
            tracing_subscriber::registry().with(layer(Format::Text, move || writer.clone(), false));
        tracing::subscriber::with_default(subscriber, || {
            log_panics();
            let _ = std::panic::catch_unwind(|| panic!("boom at the test"));
        });
        let text = String::from_utf8(buffer.0.lock().unwrap().clone()).unwrap();
        assert!(text.contains("ERROR"), "{text}");
        assert!(text.contains("boom at the test"), "{text}");
        assert!(text.contains("telemetry.rs:"), "{text}");
    }
}
