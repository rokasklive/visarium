//! Image descriptions end to end (image-descriptions): the admin's setting,
//! the describer against a stub OpenAI-compatible endpoint, retries, and the
//! setup test. What agents read is in tests/agent.rs.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

struct Reply {
    status: StatusCode,
    body: Vec<u8>,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

struct Client {
    router: axum::Router,
    cookies: Vec<(String, String)>,
}

impl Client {
    async fn send(&mut self, method: &str, uri: &str, ct: Option<&str>, body: Vec<u8>) -> Reply {
        let jar: Vec<String> = self
            .cookies
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect();
        let csrf = self
            .cookies
            .iter()
            .find(|(k, _)| k == "XSRF-TOKEN")
            .map(|(_, v)| v.clone())
            .unwrap_or_default();
        let mut req = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::HOST, "localhost:8080")
            .header(header::COOKIE, jar.join("; "))
            .header("X-XSRF-TOKEN", csrf);
        if let Some(ct) = ct {
            req = req.header(header::CONTENT_TYPE, ct);
        }
        let res = self
            .router
            .clone()
            .oneshot(req.body(Body::from(body)).unwrap())
            .await
            .unwrap();
        for set in res.headers().get_all(header::SET_COOKIE) {
            let pair = set.to_str().unwrap().split(';').next().unwrap();
            let (k, v) = pair.split_once('=').unwrap();
            self.cookies.retain(|(name, _)| name != k);
            if !v.is_empty() {
                self.cookies.push((k.into(), v.into()));
            }
        }
        let status = res.status();
        let body = res.into_body().collect().await.unwrap().to_bytes().to_vec();
        Reply { status, body }
    }
    async fn get(&mut self, uri: &str) -> Reply {
        self.send("GET", uri, None, vec![]).await
    }
    async fn json(&mut self, method: &str, uri: &str, body: Value) -> Reply {
        self.send(
            method,
            uri,
            Some("application/json"),
            body.to_string().into_bytes(),
        )
        .await
    }
    async fn upload(&mut self, bytes: &[u8]) -> Reply {
        let b = "XBOUNDARYX";
        let mut body = format!(
            "--{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"shot.png\"\r\nContent-Type: image/png\r\n\r\n"
        )
        .into_bytes();
        body.extend_from_slice(bytes);
        body.extend_from_slice(format!("\r\n--{b}--\r\n").as_bytes());
        self.send(
            "POST",
            "/api/assets",
            Some(&format!("multipart/form-data; boundary={b}")),
            body,
        )
        .await
    }
}

fn png(seed: u8) -> Vec<u8> {
    let img = image::RgbImage::from_fn(200, 120, |x, y| {
        image::Rgb([seed, (x % 256) as u8, (y % 256) as u8])
    });
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).unwrap();
    out.into_inner()
}

/// A stand-in for an OpenAI-compatible endpoint. Model `missing` is a 404,
/// and `failing` turns every answer into a 500.
#[derive(Clone, Default)]
struct Stub {
    calls: Arc<AtomicUsize>,
    failing: Arc<AtomicBool>,
    last: Arc<std::sync::Mutex<Value>>,
    last_auth: Arc<std::sync::Mutex<String>>,
}

async fn stub() -> (String, Stub) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let state = Stub::default();
    let s = state.clone();
    let router = axum::Router::new().route(
        "/v1/chat/completions",
        axum::routing::post(move |headers: axum::http::HeaderMap, body: String| {
            let s = s.clone();
            async move {
                s.calls.fetch_add(1, Ordering::SeqCst);
                let body: Value = serde_json::from_str(&body).unwrap();
                *s.last_auth.lock().unwrap() = headers
                    .get(header::AUTHORIZATION)
                    .map(|v| v.to_str().unwrap().to_string())
                    .unwrap_or_default();
                *s.last.lock().unwrap() = body.clone();
                let model = body["model"].as_str().unwrap_or("").to_string();
                if model == "missing" {
                    return (StatusCode::NOT_FOUND, axum::Json(json!({ "error": { "message": "model 'missing' not found" } })));
                }
                if s.failing.load(Ordering::SeqCst) {
                    return (StatusCode::INTERNAL_SERVER_ERROR, axum::Json(json!({ "error": { "message": "overloaded" } })));
                }
                let reply = format!(
                    "CAPTION: Screenshot seen by {model}\nDESCRIPTION: A coloured gradient.\nTEXT:\nconnection refused"
                );
                (StatusCode::OK, axum::Json(json!({ "choices": [{ "message": { "role": "assistant", "content": reply } }] })))
            }
        }),
    );
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (base, state)
}

async fn instance(
    vision_env: Option<visarium::vision::Setting>,
) -> (visarium::AppState, Client, PathBuf) {
    let dir = std::env::temp_dir().join(format!("visarium-vision-{}", uuid::Uuid::new_v4()));
    let config = visarium::Config {
        database: dir.join("visarium.db"),
        assets: dir.join("assets"),
        derivatives: dir.join("derivatives"),
        version: "test".into(),
        public_url: Some("http://localhost:8080".into()),
        vision: vision_env,
        ..Default::default()
    };
    let app = visarium::open(config).await.unwrap();
    let mut admin = Client {
        router: visarium::router(app.clone()),
        cookies: vec![],
    };
    admin.get("/api/session").await;
    let claimed = admin
        .json(
            "POST",
            "/api/setup",
            json!({ "username": "ada", "displayName": "Ada", "password": "correct horse battery" }),
        )
        .await;
    assert_eq!(claimed.status, StatusCode::CREATED);
    (app, admin, dir)
}

/// Waits until `sql` returns a row, or fails after five seconds.
async fn eventually(app: &visarium::AppState, sql: &str, bind: &str) -> Value {
    for _ in 0..100 {
        let row: Option<Row> = sqlx::query_as(sqlx::AssertSqlSafe(sql.to_string()))
            .bind(bind)
            .fetch_optional(&app.db)
            .await
            .unwrap();
        if let Some((status, caption, model, attempts, error)) = row {
            return json!({ "status": status, "caption": caption, "model": model, "attempts": attempts, "error": error });
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("never: {sql} with {bind}");
}

type Row = (String, Option<String>, Option<String>, i64, Option<String>);

const ROW: &str =
    "SELECT status, caption, model, attempts, error FROM image_description WHERE asset_id = ?";

#[tokio::test]
async fn only_admins_set_it_and_the_key_never_comes_back() {
    let (app, mut admin, _dir) = instance(None).await;
    let shown = admin.get("/api/instance/vision").await;
    assert_eq!(shown.status, StatusCode::OK);
    assert_eq!(shown.json()["configured"], false);
    assert!(
        shown.json()["defaultPrompt"]
            .as_str()
            .unwrap()
            .contains("CAPTION")
    );

    let saved = admin
        .json(
            "PUT",
            "/api/instance/vision",
            json!({ "baseUrl": "http://127.0.0.1:9/v1/", "apiKey": "sk-very-secret", "model": "gpt-5-mini" }),
        )
        .await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.text());
    assert!(!saved.text().contains("sk-very-secret"));
    assert_eq!(saved.json()["hasKey"], true);
    assert_eq!(saved.json()["baseUrl"], "http://127.0.0.1:9/v1");
    // Saving without a key keeps the stored one.
    let again = admin
        .json(
            "PUT",
            "/api/instance/vision",
            json!({ "baseUrl": "http://127.0.0.1:9/v1", "model": "other", "enabled": false }),
        )
        .await;
    assert_eq!(again.json()["hasKey"], true);
    assert_eq!(again.json()["enabled"], false);
    assert!(
        !admin
            .get("/api/instance/vision")
            .await
            .text()
            .contains("sk-very-secret")
    );
    assert_eq!(
        admin
            .json(
                "PUT",
                "/api/instance/vision",
                json!({ "baseUrl": "ftp://x", "model": "m" })
            )
            .await
            .status,
        StatusCode::BAD_REQUEST
    );

    // A moderator sees none of it.
    let id = uuid::Uuid::now_v7().to_string();
    sqlx::query("INSERT INTO app_user (id, username, display_name, role) VALUES (?, 'mo', 'Mo', 'moderator')")
        .bind(&id)
        .execute(&app.db)
        .await
        .unwrap();
    let token = visarium::auth::create_session(
        &app.db,
        visarium::auth::Kind::Browser,
        Some(&id),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    let mut mo = Client {
        router: visarium::router(app.clone()),
        cookies: vec![
            ("VISARIUM_SESSION".into(), token),
            ("XSRF-TOKEN".into(), "t".into()),
        ],
    };
    assert_eq!(
        mo.get("/api/instance/vision").await.status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        mo.json(
            "PUT",
            "/api/instance/vision",
            json!({ "baseUrl": "http://x/v1", "model": "m" })
        )
        .await
        .status,
        StatusCode::FORBIDDEN
    );

    // Set by the environment: read-only here.
    let (_app, mut admin, _dir) = instance(Some(visarium::vision::Setting {
        base_url: "http://127.0.0.1:9/v1".into(),
        model: "env-model".into(),
        api_key: "sk-env".into(),
        enabled: true,
        from_env: true,
        ..Default::default()
    }))
    .await;
    let shown = admin.get("/api/instance/vision").await;
    assert_eq!(shown.json()["fromEnv"], true);
    assert_eq!(shown.json()["model"], "env-model");
    assert!(!shown.text().contains("sk-env"));
    assert_eq!(
        admin
            .json(
                "PUT",
                "/api/instance/vision",
                json!({ "baseUrl": "http://x/v1", "model": "m" })
            )
            .await
            .status,
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn uploads_are_described_once_and_redone_for_a_new_model() {
    let (base, stub) = stub().await;
    let (app, mut admin, _dir) = instance(None).await;
    let saved = admin
        .json(
            "PUT",
            "/api/instance/vision",
            json!({ "baseUrl": base, "apiKey": "sk-1", "model": "vis-1" }),
        )
        .await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.text());

    let up = admin.upload(&png(1)).await;
    assert_eq!(up.status, StatusCode::CREATED, "{}", up.text());
    let asset = up.json()["id"].as_str().unwrap().to_string();
    let row = eventually(&app, &format!("{ROW} AND status = 'done'"), &asset).await;
    assert_eq!(row["caption"], "Screenshot seen by vis-1");
    assert_eq!(row["model"], "vis-1");
    let sent = stub.last.lock().unwrap().clone();
    assert!(
        sent["messages"][0]["content"][1]["image_url"]["url"]
            .as_str()
            .unwrap()
            .starts_with("data:image/jpeg;base64,")
    );
    assert_eq!(*stub.last_auth.lock().unwrap(), "Bearer sk-1");

    // The same bytes again are the same asset: no second call.
    let calls = stub.calls.load(Ordering::SeqCst);
    let again = admin.upload(&png(1)).await;
    assert_eq!(again.json()["id"], asset);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(stub.calls.load(Ordering::SeqCst), calls);

    // A new model redoes it, keeping the old text until then.
    admin
        .json(
            "PUT",
            "/api/instance/vision",
            json!({ "baseUrl": base, "model": "vis-2" }),
        )
        .await;
    let row = eventually(&app, &format!("{ROW} AND model = 'vis-2'"), &asset).await;
    assert_eq!(row["caption"], "Screenshot seen by vis-2");
    assert_eq!(
        *stub.last_auth.lock().unwrap(),
        "Bearer sk-1",
        "the stored key is kept"
    );

    let shown = admin.get("/api/instance/vision").await.json();
    assert_eq!(shown["described"], 1);
    assert_eq!(shown["waiting"], 0);
}

#[tokio::test]
async fn failures_never_block_and_are_retried_after_a_change() {
    let (base, stub) = stub().await;
    stub.failing.store(true, Ordering::SeqCst);
    let (app, mut admin, _dir) = instance(None).await;
    admin
        .json(
            "PUT",
            "/api/instance/vision",
            json!({ "baseUrl": base, "model": "vis-1" }),
        )
        .await;
    let up = admin.upload(&png(2)).await;
    assert_eq!(up.status, StatusCode::CREATED, "the upload is unaffected");
    let asset = up.json()["id"].as_str().unwrap().to_string();
    let row = eventually(&app, &format!("{ROW} AND status = 'failed'"), &asset).await;
    assert_eq!(row["attempts"], 1);
    assert!(row["error"].as_str().unwrap().contains("500"), "{row}");
    let shown = admin.get("/api/instance/vision").await.json();
    assert_eq!(shown["waiting"], 1);
    assert!(
        shown["lastError"]["message"]
            .as_str()
            .unwrap()
            .contains("overloaded")
    );

    // Not retried before its time.
    let calls = stub.calls.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(stub.calls.load(Ordering::SeqCst), calls);

    // Saving the setting again tries what failed at once.
    stub.failing.store(false, Ordering::SeqCst);
    admin
        .json(
            "PUT",
            "/api/instance/vision",
            json!({ "baseUrl": base, "model": "vis-1" }),
        )
        .await;
    let row = eventually(&app, &format!("{ROW} AND status = 'done'"), &asset).await;
    assert_eq!(row["attempts"], 0);

    // Turned off, nothing new is described.
    admin
        .json(
            "PUT",
            "/api/instance/vision",
            json!({ "baseUrl": base, "model": "vis-1", "enabled": false }),
        )
        .await;
    let calls = stub.calls.load(Ordering::SeqCst);
    admin.upload(&png(3)).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(stub.calls.load(Ordering::SeqCst), calls);
}

#[tokio::test]
async fn the_test_button_shows_the_description_or_the_endpoints_error() {
    let (base, _stub) = stub().await;
    let (_app, mut admin, _dir) = instance(None).await;
    let ok = admin
        .json(
            "POST",
            "/api/instance/vision/test",
            json!({ "baseUrl": base, "model": "vis-1" }),
        )
        .await;
    assert_eq!(ok.status, StatusCode::OK);
    assert_eq!(ok.json()["ok"], true);
    assert_eq!(ok.json()["caption"], "Screenshot seen by vis-1");
    assert_eq!(ok.json()["visibleText"], "connection refused");
    let bad = admin
        .json(
            "POST",
            "/api/instance/vision/test",
            json!({ "baseUrl": base, "model": "missing" }),
        )
        .await
        .json();
    assert_eq!(bad["ok"], false);
    let error = bad["error"].as_str().unwrap();
    assert!(
        error.contains("404") && error.contains("model 'missing' not found"),
        "{error}"
    );
    // Nothing was saved by testing.
    assert_eq!(
        admin.get("/api/instance/vision").await.json()["configured"],
        false
    );
}
