//! What the server writes to its log (server/logging): request IDs, the
//! access log, and that secrets and board content never reach it.

use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest};
use tower::ServiceExt;
use tracing_subscriber::layer::SubscriberExt;
use visarium::telemetry::{self, Format};

/// Everything logged at `trace` while the guard lives, as text.
#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Captured {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Captured {
    /// Captures this thread's events (a current-thread test runtime: all of them).
    fn start() -> (Self, tracing::subscriber::DefaultGuard) {
        let captured = Self::default();
        let writer = captured.clone();
        let subscriber = tracing_subscriber::registry()
            .with(telemetry::filter("trace"))
            .with(telemetry::layer(
                Format::Json,
                move || writer.clone(),
                false,
            ));
        (captured, tracing::subscriber::set_default(subscriber))
    }
    fn text(&self) -> String {
        String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
    }
    fn lines(&self) -> Vec<Value> {
        self.text()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }
}

async fn instance() -> axum::Router {
    visarium::router(state().await)
}

async fn state() -> visarium::AppState {
    state_with(true).await
}

async fn state_with(single_user: bool) -> visarium::AppState {
    let dir = std::env::temp_dir().join(format!("visarium-log-{}", uuid::Uuid::new_v4()));
    let config = visarium::Config {
        database: dir.join("visarium.db"),
        assets: dir.join("assets"),
        derivatives: dir.join("derivatives"),
        version: "test".into(),
        single_user,
        public_url: Some("http://localhost:8080".into()),
        ..Default::default()
    };
    visarium::open(config).await.unwrap()
}

type Reply = (StatusCode, axum::http::HeaderMap, Value);

/// One request, with the CSRF pair a browser would send.
async fn send(
    router: &axum::Router,
    method: &str,
    uri: &str,
    body: Option<Value>,
    headers: &[(&str, &str)],
) -> Reply {
    let mut req = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::HOST, "localhost:8080")
        .header(header::COOKIE, "XSRF-TOKEN=t")
        .header("X-XSRF-TOKEN", "t")
        .header(header::CONTENT_TYPE, "application/json");
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let body = body.map_or_else(Body::empty, |b| Body::from(b.to_string()));
    let res = router
        .clone()
        .oneshot(req.body(body).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let body = res.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        headers,
        serde_json::from_slice(&body).unwrap_or(Value::Null),
    )
}

async fn get(router: &axum::Router, uri: &str, request_id: Option<&str>) -> Reply {
    match request_id {
        Some(id) => send(router, "GET", uri, None, &[("x-request-id", id)]).await,
        None => send(router, "GET", uri, None, &[]).await,
    }
}

async fn new_board(router: &axum::Router, title: &str) -> String {
    let (status, _, body) = send(
        router,
        "POST",
        "/api/boards",
        Some(json!({ "title": title })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    body["id"].as_str().unwrap().to_string()
}

/// Waits for an event the server logs after the request returns (a socket
/// closing on its own task).
async fn eventually(captured: &Captured, message: &str) -> Value {
    for _ in 0..100 {
        if let Some(line) = captured
            .lines()
            .into_iter()
            .find(|l| l["fields"]["message"] == message)
        {
            return line;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("no '{message}' in {}", captured.text());
}

#[tokio::test]
async fn every_response_has_a_request_id_and_one_access_line() {
    let (captured, _guard) = Captured::start();
    let router = instance().await;

    let (status, headers, _) = get(
        &router,
        "/api/boards/0190a0b0-0000-7000-8000-000000000000",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let id = headers["x-request-id"].to_str().unwrap().to_string();
    assert_eq!(id.len(), 36, "a fresh UUID: {id}");

    let access: Vec<Value> = captured
        .lines()
        .into_iter()
        .filter(|l| l["fields"]["message"] == "request" && l["span"]["request_id"] == id.as_str())
        .collect();
    assert_eq!(access.len(), 1, "{}", captured.text());
    assert_eq!(access[0]["level"], "DEBUG", "4xx is debug");
    assert_eq!(access[0]["fields"]["status"], 404);
    assert_eq!(access[0]["span"]["request_id"], id.as_str());
    assert_eq!(access[0]["span"]["route"], "/api/boards/{id}");
}

#[tokio::test]
async fn a_plain_incoming_id_is_kept_and_a_malformed_one_replaced() {
    let (_captured, _guard) = Captured::start();
    let router = instance().await;
    let (_, headers, body) = get(
        &router,
        "/api/boards/0190a0b0-0000-7000-8000-000000000000",
        Some("proxy-42_a"),
    )
    .await;
    assert_eq!(headers["x-request-id"], "proxy-42_a");
    assert_eq!(
        body["requestId"], "proxy-42_a",
        "the error body names it too"
    );

    for bad in ["has space", "semi;colon", &"x".repeat(65)] {
        let (_, headers, _) = get(&router, "/health", Some(bad)).await;
        let id = headers["x-request-id"].to_str().unwrap();
        assert_ne!(id, bad);
        assert_eq!(id.len(), 36);
    }
}

#[tokio::test]
async fn a_server_error_is_logged_once_with_its_cause() {
    let (captured, _guard) = Captured::start();
    let app = state().await;
    sqlx::query("DROP TABLE canvas")
        .execute(&app.db)
        .await
        .unwrap();
    let router = visarium::router(app);

    let (status, headers, body) = get(&router, "/api/boards", None).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    let errors: Vec<Value> = captured
        .lines()
        .into_iter()
        .filter(|l| {
            l["level"] == "ERROR"
                && l["span"]["request_id"] == headers["x-request-id"].to_str().unwrap()
        })
        .collect();
    assert_eq!(errors.len(), 1, "{}", captured.text());
    assert_eq!(errors[0]["fields"]["status"], 500);
    assert!(
        errors[0]["fields"]["error"]
            .as_str()
            .unwrap()
            .contains("canvas"),
        "{}",
        errors[0]
    );
    assert_eq!(
        errors[0]["span"]["request_id"],
        headers["x-request-id"].to_str().unwrap()
    );
}

#[tokio::test]
async fn a_socket_logs_its_opening_and_closing_with_one_connection_id() {
    let (captured, _guard) = Captured::start();
    let app = state().await;
    let router = visarium::router(app.clone());
    let board = new_board(&router, "Sockets").await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(visarium::serve(app, listener));

    let mut req = format!("ws://{addr}/ws/canvas/{board}")
        .into_client_request()
        .unwrap();
    req.headers_mut()
        .insert("origin", format!("http://{addr}").parse().unwrap());
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    ws.close(Some(tungstenite::protocol::CloseFrame {
        code: tungstenite::protocol::frame::coding::CloseCode::Normal,
        reason: "bye".into(),
    }))
    .await
    .unwrap();

    let closed = eventually(&captured, "socket closed").await;
    let opened = eventually(&captured, "socket opened").await;
    assert_eq!(opened["level"], "INFO");
    assert_eq!(opened["span"]["board"], board.as_str());
    assert!(opened["span"]["user"].is_string());
    assert_eq!(closed["span"]["conn"], opened["span"]["conn"]);
    assert_eq!(closed["fields"]["by"], "client");
    assert_eq!(closed["fields"]["code"], 1000);
    assert_eq!(closed["fields"]["reason"], "bye");
    assert!(closed["fields"]["duration_ms"].is_u64());
}

#[tokio::test]
async fn a_tool_call_is_one_line_without_its_arguments() {
    let (captured, _guard) = Captured::start();
    let router = instance().await;
    let board = new_board(&router, "Tool board").await;
    let call = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
        "name": "item_create",
        "arguments": { "board": "Tool board", "kind": "note", "source": "MARKER-NOTE-TEXT" }
    } });
    let (status, _, body) = send(&router, "POST", "/mcp", Some(call), &[]).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["result"]["isError"], false, "{body}");

    let calls: Vec<Value> = captured
        .lines()
        .into_iter()
        .filter(|l| l["fields"]["message"] == "tool call")
        .collect();
    assert_eq!(calls.len(), 1, "{}", captured.text());
    assert_eq!(calls[0]["level"], "INFO");
    assert_eq!(calls[0]["span"]["tool"], "item_create");
    assert_eq!(calls[0]["span"]["board"], board.as_str());
    assert_eq!(calls[0]["fields"]["ok"], true);
    assert!(calls[0]["fields"]["duration_ms"].is_u64());
    assert!(
        !captured.text().contains("MARKER-NOTE-TEXT"),
        "{}",
        captured.text()
    );
}

/// The `name=value` of every cookie a reply sets.
fn set_cookies(headers: &axum::http::HeaderMap) -> Vec<String> {
    headers
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|c| c.to_str().unwrap().split(';').next().unwrap().to_string())
        .filter(|c| !c.ends_with('='))
        .collect()
}

#[tokio::test]
async fn a_wrong_password_is_one_warning_without_the_username() {
    let (captured, _guard) = Captured::start();
    let router = visarium::router(state_with(false).await);
    let (status, _, body) = send(&router, "POST", "/api/setup",
        Some(json!({ "username": "zelda", "displayName": "Zelda", "password": "correct horse battery" })), &[]).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");

    let (status, headers, _) = send(
        &router,
        "POST",
        "/api/session",
        Some(json!({ "username": "zelda", "password": "WRONG-PASSWORD-x" })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let id = headers["x-request-id"].to_str().unwrap();
    let warnings: Vec<Value> = captured
        .lines()
        .into_iter()
        .filter(|l| l["level"] == "WARN" && l["span"]["request_id"] == id)
        .collect();
    assert_eq!(warnings.len(), 1, "{}", captured.text());
    assert_eq!(warnings[0]["fields"]["method"], "password");
    assert_eq!(warnings[0]["fields"]["reason"], "bad credentials");
    let text = captured.text();
    assert!(!text.contains("zelda"), "{text}");
    assert!(!text.contains("WRONG-PASSWORD-x"), "{text}");
}

/// The never-log list (server/logging), at `trace`, through the paths that
/// handle each kind of secret or content.
#[tokio::test]
async fn secrets_and_board_content_never_reach_the_log() {
    let (captured, _guard) = Captured::start();
    let router = visarium::router(state_with(false).await);
    let password = "PASSWORD-SECRET-horse battery";
    let (status, headers, body) = send(&router, "POST", "/api/setup",
        Some(json!({ "username": "quentin", "displayName": "DISPLAY-NAME-SECRET", "password": password })), &[]).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert!(!set_cookies(&headers).is_empty());
    let (status, headers, _) = send(
        &router,
        "POST",
        "/api/session",
        Some(json!({ "username": "quentin", "password": password })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let session = set_cookies(&headers)
        .into_iter()
        .find(|c| c.starts_with("VISARIUM_SESSION="))
        .unwrap();
    let auth = [("cookie", session.as_str())];

    let (status, _, board) = send(
        &router,
        "POST",
        "/api/boards",
        Some(json!({ "title": "BOARD-TITLE-SECRET" })),
        &auth,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{board}");
    let board = board["id"].as_str().unwrap().to_string();
    let note = json!({ "operations": [{ "body": { "type": "item.create", "itemId": uuid::Uuid::now_v7(), "z": 1.0,
        "transform": { "x": 0.0, "y": 0.0, "width": 200.0, "height": 100.0, "rotation": 0.0 },
        "content": { "kind": "note", "source": "NOTE-TEXT-SECRET" } } }] });
    let (status, _, body) = send(
        &router,
        "POST",
        &format!("/api/boards/{board}/operations"),
        Some(note),
        &auth,
    )
    .await;
    assert!(status.is_success(), "{body}");

    let (status, _, made) = send(
        &router,
        "POST",
        &format!("/api/boards/{board}/shares"),
        Some(json!({ "passphrase": "PASSPHRASE-SECRET" })),
        &auth,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{made}");
    let share_token = made["link"].as_str().unwrap()[3..].to_string();
    let (status, _, _) = send(
        &router,
        "POST",
        "/api/shared/session",
        Some(json!({ "token": share_token, "passphrase": "PASSPHRASE-SECRET" })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let text = captured.text();
    let session_value = session.split_once('=').unwrap().1;
    for secret in [
        password,
        session_value,
        share_token.as_str(),
        "PASSPHRASE-SECRET",
        "quentin",
        "DISPLAY-NAME-SECRET",
        "BOARD-TITLE-SECRET",
        "NOTE-TEXT-SECRET",
    ] {
        assert!(!text.contains(secret), "'{secret}' was logged:\n{text}");
    }
    // And the events that should be there are.
    for message in [
        "instance claimed",
        "signed in",
        "share link created",
        "share link opened",
    ] {
        assert!(text.contains(message), "no '{message}' in {text}");
    }
}
