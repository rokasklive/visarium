//! The demo gateway end to end: sandboxes start, stay apart, keep to their
//! allowance, and end.

use std::path::{Path, PathBuf};
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use visarium::demo::{GatewayState, Settings};

/// One visitor: a browser's cookie jar, on the demo's public host.
struct Visitor {
    router: axum::Router,
    cookies: Vec<(String, String)>,
    ip: String,
}

struct Reply {
    status: StatusCode,
    headers: axum::http::HeaderMap,
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

impl Visitor {
    fn new(router: &axum::Router, ip: &str) -> Self {
        Self {
            router: router.clone(),
            cookies: vec![],
            ip: ip.into(),
        }
    }

    async fn send(&mut self, method: &str, uri: &str, ct: Option<&str>, body: Vec<u8>) -> Reply {
        let csrf = self
            .cookies
            .iter()
            .find(|(k, _)| k == "XSRF-TOKEN")
            .map(|(_, v)| v.clone())
            .unwrap_or_default();
        let mut req = Request::builder()
            .method(method)
            .uri(uri)
            // Not loopback: a sandbox answers on the demo's public name.
            .header(header::HOST, "demo.example")
            .header("x-test-ip", &self.ip)
            .header("X-XSRF-TOKEN", csrf)
            .header(
                header::COOKIE,
                self.cookies
                    .iter()
                    .map(|(k, v)| format!("{k}={v}"))
                    .collect::<Vec<_>>()
                    .join("; "),
            );
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
            self.cookies.push((k.into(), v.into()));
        }
        let status = res.status();
        let headers = res.headers().clone();
        let body = res.into_body().collect().await.unwrap().to_bytes().to_vec();
        Reply {
            status,
            headers,
            body,
        }
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
    /// Presses Start, and picks up the CSRF cookie the sandbox sets.
    async fn start(&mut self) -> Reply {
        let started = self.send("POST", "/demo/start", None, vec![]).await;
        if started.status == StatusCode::SEE_OTHER {
            self.get("/api/session").await;
        }
        started
    }
    async fn upload(&mut self, name: &str, bytes: &[u8]) -> Reply {
        let mut body = format!(
            "--B\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
        )
        .into_bytes();
        body.extend_from_slice(bytes);
        body.extend_from_slice(b"\r\n--B--\r\n");
        self.send(
            "POST",
            "/api/assets",
            Some("multipart/form-data; boundary=B"),
            body,
        )
        .await
    }
}

fn temp() -> PathBuf {
    std::env::temp_dir().join(format!("visarium-demo-test-{}", uuid::Uuid::new_v4()))
}

fn settings(root: &Path) -> Settings {
    let mut s = Settings {
        root: root.to_path_buf(),
        ip_header: Some("x-test-ip".parse().unwrap()),
        version: "test".into(),
        sweep_every: Duration::from_millis(100),
        ..Default::default()
    };
    s.policy.max_boards = 2;
    s.policy.storage_bytes = 200_000;
    s
}

async fn gateway(settings: Settings) -> (GatewayState, axum::Router) {
    let g = visarium::demo::open(settings).await.unwrap();
    let router = visarium::demo::router(g.clone());
    (g, router)
}

fn noise_png(width: u32, height: u32) -> Vec<u8> {
    let mut seed = 7u32;
    let img = image::RgbImage::from_fn(width, height, |_, _| {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let b = seed.to_le_bytes();
        image::Rgb([b[0], b[1], b[2]])
    });
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).unwrap();
    out.into_inner()
}

#[tokio::test]
async fn a_visitor_starts_a_sandbox_of_their_own() {
    let root = temp();
    let (g, router) = gateway(settings(&root)).await;
    let mut ada = Visitor::new(&router, "10.0.0.1");

    let first = ada.get("/").await;
    assert_eq!(first.status, StatusCode::OK);
    assert!(first.text().contains("Start the demo"));
    assert_eq!(first.headers["x-content-type-options"], "nosniff");
    assert_eq!(
        ada.get("/api/boards").await.status,
        StatusCode::UNAUTHORIZED,
        "no sandbox, no API"
    );

    let started = ada.start().await;
    assert_eq!(started.status, StatusCode::SEE_OTHER);
    assert_eq!(started.headers[header::LOCATION], "/");
    let cookie = started.headers[header::SET_COOKIE].to_str().unwrap();
    assert!(
        cookie.contains("HttpOnly") && cookie.contains("SameSite=Lax"),
        "{cookie}"
    );

    let session = ada.get("/api/session").await.json();
    assert_eq!(session["singleUser"], true);
    assert_eq!(session["sharingEnabled"], false);
    assert_eq!(session["demo"]["maxBoards"], 2);
    assert!(session["demo"]["endsAt"].as_str().unwrap().ends_with('Z'));

    // Isolation: what one visitor makes, another never sees.
    let made = ada
        .json("POST", "/api/boards", json!({ "title": "Ada's" }))
        .await;
    assert_eq!(made.status, StatusCode::CREATED, "{}", made.json());
    let mut bo = Visitor::new(&router, "10.0.0.2");
    assert_eq!(bo.start().await.status, StatusCode::SEE_OTHER);
    let theirs = bo.get("/api/boards").await.json();
    assert!(
        !theirs.to_string().contains("Ada's"),
        "another sandbox's board leaked: {theirs}"
    );
    assert_eq!(g.count(), 2);

    // Agents and sign-in are not part of the demo.
    for path in [
        "/mcp",
        "/oauth/register",
        "/.well-known/oauth-authorization-server",
    ] {
        assert_eq!(ada.get(path).await.status, StatusCode::NOT_FOUND, "{path}");
    }
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn a_sandbox_keeps_to_its_allowance() {
    let root = temp();
    let (_g, router) = gateway(settings(&root)).await;
    let mut ada = Visitor::new(&router, "10.0.0.1");
    ada.start().await;

    for n in 0..2 {
        let r = ada
            .json("POST", "/api/boards", json!({ "title": format!("b{n}") }))
            .await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.json());
    }
    let third = ada
        .json("POST", "/api/boards", json!({ "title": "b3" }))
        .await;
    assert_eq!(third.status, StatusCode::FORBIDDEN);
    assert!(
        third.json()["detail"]
            .as_str()
            .unwrap()
            .contains("up to 2 boards")
    );

    // 200 KB of images: a small one fits, a larger one says how much is left.
    let small = ada.upload("small.png", &noise_png(40, 40)).await;
    assert_eq!(small.status, StatusCode::CREATED, "{}", small.json());
    let big = ada.upload("big.png", &noise_png(300, 300)).await;
    assert_eq!(
        big.status,
        StatusCode::INSUFFICIENT_STORAGE,
        "{}",
        big.json()
    );
    assert!(
        big.json()["detail"]
            .as_str()
            .unwrap()
            .contains("This demo holds up to 200 KB"),
        "{}",
        big.json()
    );
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn starts_are_limited_per_address_and_by_room() {
    let root = temp();
    let mut s = settings(&root);
    s.starts_per_hour = 1;
    s.max_sandboxes = 2;
    let (_g, router) = gateway(s).await;

    let mut ada = Visitor::new(&router, "10.0.0.1");
    assert_eq!(ada.start().await.status, StatusCode::SEE_OTHER);
    let again = Visitor::new(&router, "10.0.0.1").start().await;
    assert_eq!(again.status, StatusCode::TOO_MANY_REQUESTS);
    assert!(again.text().contains("several demos"));

    assert_eq!(
        Visitor::new(&router, "10.0.0.2").start().await.status,
        StatusCode::SEE_OTHER
    );
    // Both sandboxes were just used, so neither is evicted for a third.
    let full = Visitor::new(&router, "10.0.0.3").start().await;
    assert_eq!(full.status, StatusCode::TOO_MANY_REQUESTS);
    assert!(full.text().contains("full right now"));
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn a_sandbox_ends_and_its_folder_goes_with_it() {
    let root = temp();
    let mut s = settings(&root);
    s.lifetime = Duration::from_millis(600);
    let (g, router) = gateway(s).await;
    let mut ada = Visitor::new(&router, "10.0.0.1");
    ada.start().await;
    assert_eq!(ada.get("/api/boards").await.status, StatusCode::OK);
    let sandboxes = || {
        std::fs::read_dir(&root)
            .unwrap()
            .filter(|e| e.as_ref().unwrap().file_type().unwrap().is_dir())
            .count()
    };
    assert_eq!(sandboxes(), 1);

    tokio::time::sleep(Duration::from_millis(700)).await;
    let page = ada.get("/").await;
    assert!(
        page.text().contains("Your demo has ended"),
        "{}",
        page.text()
    );
    assert_eq!(
        ada.get("/api/boards").await.status,
        StatusCode::UNAUTHORIZED
    );

    for _ in 0..50 {
        if sandboxes() == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(sandboxes(), 0, "the ended sandbox's folder is gone");
    assert_eq!(g.count(), 0);
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn every_sandbox_starts_from_the_seed() {
    // A seed is any instance's data directory: here, one board and one image.
    let seed = temp();
    let app = visarium::open(visarium::Config {
        database: seed.join("db").join("visarium.db"),
        assets: seed.join("assets"),
        derivatives: seed.join("derivatives"),
        version: "seed".into(),
        single_user: true,
        ..Default::default()
    })
    .await
    .unwrap();
    let local = app.local_user.clone().unwrap();
    visarium::boards::create_board(&app, &local, "Welcome", None)
        .await
        .unwrap();
    let mut spool = visarium::assets::Spool::new(&app).await.unwrap();
    spool.push(&noise_png(64, 64)).await.unwrap();
    let image = spool
        .store(&app, Some("seed.png".into()), &local)
        .await
        .unwrap();
    drop(app);

    let root = temp();
    let mut s = settings(&root);
    s.seed = Some(seed.clone());
    let (_g, router) = gateway(s).await;
    let mut ada = Visitor::new(&router, "10.0.0.1");
    ada.start().await;
    let boards = ada.get("/api/boards").await.json();
    assert!(boards.to_string().contains("Welcome"), "{boards}");
    let shown = ada.get(&format!("/api/assets/{}/content", image.id)).await;
    assert_eq!(shown.status, StatusCode::OK);

    // Seeded images do not count against the visitor's own allowance.
    let session = ada.get("/api/session").await.json();
    assert_eq!(session["demo"]["storageBytes"], 200_000);
    let small = ada.upload("mine.png", &noise_png(40, 40)).await;
    assert_eq!(small.status, StatusCode::CREATED, "{}", small.json());

    // Deleting the seed's image in a sandbox leaves the seed's file alone.
    let purge = ada
        .send(
            "DELETE",
            &format!("/api/assets/{}?withItems=true", image.id),
            None,
            vec![],
        )
        .await;
    assert!(purge.status.is_success(), "{}", purge.json());
    let file = ada
        .send(
            "DELETE",
            &format!("/api/assets/{}/file", image.id),
            None,
            vec![],
        )
        .await;
    assert!(file.status.is_success(), "{}", file.json());
    assert!(seed.join("assets").join(&image.storage_key).exists());

    let _ = std::fs::remove_dir_all(root);
    let _ = std::fs::remove_dir_all(seed);
}
