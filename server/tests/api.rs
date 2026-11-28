//! The API end to end, over a real router and a throwaway SQLite file: the
//! contract the SPA depends on, checked from the outside.

use std::path::PathBuf;

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use futures_util::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest};
use tower::ServiceExt;

mod fake_mcp;
mod issuer;
use issuer::{Issuer, Person};

struct Client {
    router: axum::Router,
    cookies: Vec<(String, String)>,
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
}

impl Client {
    fn new(router: axum::Router) -> Self {
        Self {
            router,
            cookies: vec![],
        }
    }
    fn cookie(&self, name: &str) -> Option<String> {
        self.cookies
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.clone())
    }
    fn cookie_header(&self) -> String {
        self.cookies
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("; ")
    }
    fn csrf(&self) -> String {
        self.cookies
            .iter()
            .find(|(k, _)| k == "XSRF-TOKEN")
            .map(|(_, v)| v.clone())
            .unwrap_or_default()
    }

    async fn send(
        &mut self,
        method: &str,
        uri: &str,
        content_type: Option<&str>,
        body: Vec<u8>,
        extra: &[(&str, &str)],
    ) -> Reply {
        let mut req = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::HOST, "localhost:8080");
        req = req
            .header(header::COOKIE, self.cookie_header())
            .header("X-XSRF-TOKEN", self.csrf());
        if let Some(ct) = content_type {
            req = req.header(header::CONTENT_TYPE, ct);
        }
        let headers = req.headers_mut().unwrap();
        for (k, v) in extra {
            headers.insert(
                axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                v.parse().unwrap(),
            );
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
        let headers = res.headers().clone();
        let body = res.into_body().collect().await.unwrap().to_bytes().to_vec();
        Reply {
            status,
            headers,
            body,
        }
    }

    async fn get(&mut self, uri: &str) -> Reply {
        self.send("GET", uri, None, vec![], &[]).await
    }
    async fn json(&mut self, method: &str, uri: &str, body: Value) -> Reply {
        self.send(
            method,
            uri,
            Some("application/json"),
            body.to_string().into_bytes(),
            &[],
        )
        .await
    }
    async fn upload(&mut self, filename: &str, bytes: &[u8]) -> Reply {
        let boundary = "XBOUNDARYX";
        let mut body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
        )
        .into_bytes();
        body.extend_from_slice(bytes);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        self.send(
            "POST",
            "/api/assets",
            Some(&format!("multipart/form-data; boundary={boundary}")),
            body,
            &[],
        )
        .await
    }
}

fn png(width: u32, height: u32, seed: u8) -> Vec<u8> {
    let img = image::RgbImage::from_fn(width, height, |x, y| {
        image::Rgb([seed, (x % 256) as u8, (y % 256) as u8])
    });
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).unwrap();
    out.into_inner()
}

fn config(single_user: bool) -> (visarium::Config, PathBuf) {
    let dir = std::env::temp_dir().join(format!("visarium-test-{}", uuid::Uuid::new_v4()));
    let config = visarium::Config {
        database: dir.join("visarium.db"),
        assets: dir.join("assets"),
        derivatives: dir.join("derivatives"),
        version: "test".into(),
        single_user,
        public_url: Some("http://localhost:8080".into()),
        ..Default::default()
    };
    (config, dir)
}

async fn instance(single_user: bool) -> (visarium::AppState, PathBuf) {
    let (config, dir) = config(single_user);
    (visarium::open(config).await.unwrap(), dir)
}

/// An instance with the in-process OpenID provider configured as `test`.
async fn with_provider(
    issuer: &Issuer,
    tweak: impl FnOnce(&mut visarium::Config),
) -> (visarium::AppState, PathBuf) {
    let (mut config, dir) = config(false);
    config.providers = vec![issuer.provider("test")];
    tweak(&mut config);
    (visarium::open(config).await.unwrap(), dir)
}

fn location(r: &Reply) -> String {
    r.headers
        .get(header::LOCATION)
        .map(|l| l.to_str().unwrap().to_string())
        .unwrap_or_default()
}

/// Leaves for the provider, lets it sign `person` in, and stops short of
/// coming back: returns the callback path the browser would load next.
async fn to_callback(c: &mut Client, issuer: &Issuer, start: &str, person: Person) -> String {
    issuer.next(person);
    let left = c.get(start).await;
    assert_eq!(
        left.status,
        StatusCode::FOUND,
        "{start}: {}",
        String::from_utf8_lossy(&left.body)
    );
    provider_round_trip(&location(&left)).await
}

async fn provider_round_trip(url: &str) -> String {
    assert!(url.starts_with("http://127.0.0.1:"), "left for {url}");
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let back = http.get(url).send().await.unwrap();
    let back = back.headers()[header::LOCATION]
        .to_str()
        .unwrap()
        .to_string();
    back.strip_prefix("http://localhost:8080")
        .unwrap_or_else(|| panic!("came back to {back}"))
        .to_string()
}

/// The whole round trip: start, provider, callback. Returns the callback reply.
async fn sso(c: &mut Client, issuer: &Issuer, start: &str, person: Person) -> Reply {
    let callback = to_callback(c, issuer, start, person).await;
    c.get(&callback).await
}

async fn invite(admin: &mut Client, body: Value) -> String {
    let made = admin.json("POST", "/api/invitations", body).await;
    assert_eq!(made.status, StatusCode::CREATED, "{}", made.json());
    let link = made.json()["link"].as_str().unwrap().to_string();
    assert!(
        link.starts_with("/invite#"),
        "the token rides in the fragment"
    );
    link["/invite#".len()..].to_string()
}

async fn count(app: &visarium::AppState, sql: &'static str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(&app.db).await.unwrap()
}

async fn signed_in() -> (Client, visarium::AppState, PathBuf) {
    let (app, dir) = instance(false).await;
    let mut c = Client::new(visarium::router(app.clone()));
    let boot = c.get("/api/session").await;
    assert_eq!(
        boot.json(),
        json!({ "setupRequired": true, "user": null, "singleUser": false, "passwordEnabled": true, "providers": [], "sharingEnabled": true })
    );
    let claimed = c
        .json(
            "POST",
            "/api/setup",
            json!({ "username": "ada", "displayName": "Ada", "password": "correct horse battery" }),
        )
        .await;
    assert_eq!(claimed.status, StatusCode::CREATED, "{}", claimed.json());
    (c, app, dir)
}

#[tokio::test]
async fn auth_csrf_and_accounts() {
    let (app, dir) = instance(false).await;
    let mut c = Client {
        router: visarium::router(app),
        cookies: vec![],
    };

    let r = c.get("/api/boards").await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    assert_eq!(r.headers[header::CONTENT_TYPE], "application/problem+json");
    assert_eq!(c.get("/health").await.json(), json!({ "status": "UP" }));

    let token = c.csrf();
    assert!(
        !token.is_empty(),
        "the first response issues the CSRF cookie"
    );
    c.cookies.retain(|(k, _)| k != "XSRF-TOKEN");
    c.cookies.push(("XSRF-TOKEN".into(), token.clone()));
    let forged = c
        .send(
            "POST",
            "/api/setup",
            Some("application/json"),
            b"{}".to_vec(),
            &[("X-XSRF-TOKEN", "wrong")],
        )
        .await;
    assert_eq!(forged.status, StatusCode::FORBIDDEN);

    let short = c
        .json(
            "POST",
            "/api/setup",
            json!({ "username": "ada", "displayName": "Ada", "password": "short" }),
        )
        .await;
    assert_eq!(short.status, StatusCode::BAD_REQUEST);
    assert!(
        short.json()["detail"]
            .as_str()
            .unwrap()
            .contains("12 characters")
    );

    let ok = c
        .json(
            "POST",
            "/api/setup",
            json!({ "username": "ada", "displayName": "Ada", "password": "correct horse battery" }),
        )
        .await;
    assert_eq!(ok.status, StatusCode::CREATED);
    assert_eq!(ok.json()["admin"], true);
    let again = c
        .json(
            "POST",
            "/api/setup",
            json!({ "username": "bob", "displayName": "Bob", "password": "correct horse battery" }),
        )
        .await;
    assert_eq!(again.status, StatusCode::CONFLICT);

    // Accounts come from invitations; an admin no longer types anyone's password.
    let typed = c
        .json(
            "POST",
            "/api/accounts",
            json!({ "username": "bob", "displayName": "Bob", "password": "another long password" }),
        )
        .await;
    assert_eq!(typed.status, StatusCode::METHOD_NOT_ALLOWED);
    let token = invite(&mut c, json!({ "note": "for Bob" })).await;
    let mut b = Client::new(c.router.clone());
    b.get("/api/session").await;
    let bob = b.json("POST", "/api/invitations/redeem", json!({ "token": token, "username": "bob", "displayName": "Bob", "password": "another long password" })).await;
    assert_eq!(bob.status, StatusCode::CREATED, "{}", bob.json());
    assert_eq!(bob.json()["admin"], false);
    let token = invite(&mut c, json!({})).await;
    let dup = b.json("POST", "/api/invitations/redeem", json!({ "token": token, "username": "bob", "displayName": "B", "password": "another long password" })).await;
    assert_eq!(dup.status, StatusCode::CONFLICT);
    let me = c.json("GET", "/api/session", json!(null)).await.json()["user"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let demote = c
        .json(
            "PUT",
            &format!("/api/accounts/{me}/role"),
            json!({ "role": "moderator" }),
        )
        .await;
    assert_eq!(
        demote.status,
        StatusCode::CONFLICT,
        "the last admin cannot be demoted"
    );

    assert_eq!(
        c.send("DELETE", "/api/session", None, vec![], &[])
            .await
            .status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(c.get("/api/boards").await.status, StatusCode::UNAUTHORIZED);
    let wrong = c
        .json(
            "POST",
            "/api/session",
            json!({ "username": "bob", "password": "not the password" }),
        )
        .await;
    assert_eq!(wrong.status, StatusCode::UNAUTHORIZED);
    let right = c
        .json(
            "POST",
            "/api/session",
            json!({ "username": "bob", "password": "another long password" }),
        )
        .await;
    assert_eq!(right.status, StatusCode::OK);
    assert_eq!(right.json()["username"], "bob");
    assert_eq!(
        c.get("/api/accounts").await.status,
        StatusCode::FORBIDDEN,
        "bob is not an admin"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn single_user_needs_no_sign_in_and_only_answers_loopback() {
    let (app, dir) = instance(true).await;
    let mut c = Client {
        router: visarium::router(app),
        cookies: vec![],
    };
    let session = c.get("/api/session").await.json();
    assert_eq!(session["setupRequired"], false);
    assert_eq!(session["user"]["admin"], true);
    assert_eq!(
        session["singleUser"], true,
        "the SPA hides Sign out on this"
    );
    assert_eq!(c.get("/api/boards").await.status, StatusCode::OK);
    let rebound = c
        .send(
            "GET",
            "/api/boards",
            None,
            vec![],
            &[("host", "evil.example:8080")],
        )
        .await;
    assert_eq!(rebound.status, StatusCode::FORBIDDEN);

    // The next launch finds this account by the name `local`.
    let renamed = c
        .json("PATCH", "/api/accounts/me", json!({ "username": "rokas" }))
        .await;
    assert_eq!(renamed.status, StatusCode::BAD_REQUEST);
    let named = c
        .json(
            "PATCH",
            "/api/accounts/me",
            json!({ "displayName": "Rokas", "username": "local" }),
        )
        .await;
    assert_eq!(named.status, StatusCode::OK, "display name still changes");
    assert_eq!(named.json()["username"], "local");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn assets_boards_library_and_lifecycle() {
    let (mut c, _app, dir) = signed_in().await;

    let big = c.upload("Sunset.png", &png(3000, 2000, 1)).await;
    assert_eq!(big.status, StatusCode::CREATED, "{}", big.json());
    let asset = big.json();
    assert_eq!(
        (asset["width"].as_i64(), asset["height"].as_i64()),
        (Some(3000), Some(2000))
    );
    let id = asset["id"].as_str().unwrap().to_string();
    assert_eq!(
        c.upload("again.png", &png(3000, 2000, 1)).await.json()["id"],
        asset["id"],
        "same bytes, same asset"
    );
    assert_eq!(
        c.upload("junk.png", b"definitely not an image")
            .await
            .status,
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );

    let d = c.get(&format!("/api/assets/{id}/derivatives/512")).await;
    assert_eq!(d.status, StatusCode::OK);
    assert_eq!(d.headers[header::CONTENT_TYPE], "image/webp");
    let decoded = image::load_from_memory(&d.body).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (512, 341));
    let etag = d.headers[header::ETAG].to_str().unwrap().to_string();
    let cached = c
        .send(
            "GET",
            &format!("/api/assets/{id}/derivatives/512"),
            None,
            vec![],
            &[("if-none-match", &etag)],
        )
        .await;
    assert_eq!(cached.status, StatusCode::NOT_MODIFIED);
    assert_eq!(
        c.get(&format!("/api/assets/{id}/derivatives/300"))
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
    let original = c.get(&format!("/api/assets/{id}/content")).await;
    assert_eq!(original.headers[header::CONTENT_TYPE], "image/png");
    assert!(
        original.headers[header::CONTENT_DISPOSITION]
            .to_str()
            .unwrap()
            .contains("Sunset.png")
    );

    // A board, three operations, and the snapshot that results.
    let board = c
        .json("POST", "/api/boards", json!({ "title": "Refs" }))
        .await
        .json();
    let b = board["id"].as_str().unwrap().to_string();
    let item = uuid::Uuid::now_v7().to_string();
    let group = uuid::Uuid::now_v7().to_string();
    let t = json!({ "x": 1.0, "y": 2.0, "width": 300.0, "height": 200.0, "rotation": 0.0 });
    let ops = json!({ "operations": [
        { "operationId": uuid::Uuid::now_v7(), "baseRevision": 0, "body": { "type": "item.create", "itemId": item, "transform": t, "z": 1.0,
            "content": { "kind": "image", "asset": { "assetId": id, "intrinsicWidth": 3000, "intrinsicHeight": 2000 } }, "groupId": null, "appearance": null } },
        { "operationId": uuid::Uuid::now_v7(), "baseRevision": 0, "body": { "type": "group.create", "groupId": group, "memberIds": [item], "label": "Sky", "frame": true } },
        { "operationId": uuid::Uuid::now_v7(), "baseRevision": 0, "body": { "type": "item.appearance", "itemId": item, "appearance": { "opacity": 0.5, "flipX": true, "flipY": false } } },
    ]});
    let applied = c
        .json("POST", &format!("/api/boards/{b}/operations"), ops)
        .await;
    assert_eq!(applied.json()["revision"], 3);
    assert_eq!(
        applied.json()["operations"].as_array().unwrap().len(),
        3,
        "the applied bodies come back"
    );
    let snap = c.get(&format!("/api/boards/{b}/snapshot")).await.json();
    assert_eq!(snap["revision"], 3);
    assert_eq!(snap["items"][0]["groupId"], group.as_str());
    assert_eq!(
        snap["items"][0]["appearance"],
        json!({ "opacity": 0.5, "flipX": true, "flipY": false })
    );
    assert_eq!(snap["items"][0]["content"]["asset"]["intrinsicWidth"], 3000);
    assert_eq!(
        snap["groups"][0],
        json!({ "id": group, "ref": "g1", "label": "Sky", "frame": true, "collides": false, "memberIds": [item] })
    );
    assert_eq!(
        snap["items"][0]["ref"], "i1",
        "an item carries its short ref (ADR-0031)"
    );

    let broken = json!({ "operations": [{ "body": { "type": "item.create", "itemId": uuid::Uuid::now_v7(), "transform": t,
        "content": { "kind": "image", "asset": { "assetId": uuid::Uuid::now_v7() } } } }] });
    assert_eq!(
        c.json("POST", &format!("/api/boards/{b}/operations"), broken)
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        c.get(&format!("/api/boards/{b}")).await.json()["revision"],
        3,
        "a refused batch commits nothing"
    );

    let copy = c
        .json("POST", &format!("/api/boards/{b}/duplicate"), json!(null))
        .await;
    assert_eq!(copy.status, StatusCode::CREATED);
    let copy_snap = c
        .get(&format!(
            "/api/boards/{}/snapshot",
            copy.json()["id"].as_str().unwrap()
        ))
        .await
        .json();
    assert_eq!(copy_snap["items"].as_array().unwrap().len(), 1);
    assert_ne!(copy_snap["groups"][0]["id"], group.as_str());
    assert_eq!(
        copy_snap["groups"][0]["memberIds"][0],
        copy_snap["items"][0]["id"]
    );

    // Crop (ADR-0029): round-trips, survives a plain move, is copied by board
    // duplication, goes back to absent when full, and is refused outside 0..1.
    let ops_url = format!("/api/boards/{b}/operations");
    let crop = json!({ "x": 0.25, "y": 0.0, "width": 0.5, "height": 1.0 });
    let half = json!({ "x": 1.0, "y": 2.0, "width": 150.0, "height": 200.0, "rotation": 0.0 });
    let cropped = json!({ "operations": [{ "body": { "type": "item.transform", "itemId": item, "transform": half, "crop": crop } }] });
    assert_eq!(
        c.json("POST", &ops_url, cropped).await.status,
        StatusCode::OK
    );
    let moved = json!({ "operations": [{ "body": { "type": "item.transform", "itemId": item, "transform": t } }] });
    assert_eq!(c.json("POST", &ops_url, moved).await.status, StatusCode::OK);
    let snap = c.get(&format!("/api/boards/{b}/snapshot")).await.json();
    assert_eq!(
        snap["items"][0]["crop"], crop,
        "a transform without a crop leaves it alone"
    );
    let copy = c
        .json("POST", &format!("/api/boards/{b}/duplicate"), json!(null))
        .await
        .json();
    let copy_snap = c
        .get(&format!(
            "/api/boards/{}/snapshot",
            copy["id"].as_str().unwrap()
        ))
        .await
        .json();
    assert_eq!(
        copy_snap["items"][0]["crop"], crop,
        "board duplication names the crop columns"
    );
    let gone = c
        .send(
            "DELETE",
            &format!("/api/boards/{}", copy["id"].as_str().unwrap()),
            None,
            vec![],
            &[],
        )
        .await;
    assert!(
        gone.status.is_success(),
        "the extra copy goes, so later board counts stay as they were"
    );
    let revision = c.get(&format!("/api/boards/{b}")).await.json()["revision"].clone();
    for bad in [
        json!({ "x": 0.6, "y": 0.0, "width": 0.5, "height": 1.0 }),
        json!({ "x": -0.1, "y": 0.0, "width": 0.5, "height": 1.0 }),
        json!({ "x": 0.0, "y": 0.0, "width": 0.0, "height": 1.0 }),
    ] {
        let body = json!({ "operations": [{ "body": { "type": "item.transform", "itemId": item, "transform": t, "crop": bad } }] });
        assert_eq!(
            c.json("POST", &ops_url, body).await.status,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        c.get(&format!("/api/boards/{b}")).await.json()["revision"],
        revision,
        "a refused crop stores nothing"
    );
    let drift = json!({ "x": 1e-12, "y": 0.0, "width": 1.0000000001, "height": 1.0 });
    let full = json!({ "operations": [{ "body": { "type": "item.transform", "itemId": item, "transform": t, "crop": drift } }] });
    assert_eq!(c.json("POST", &ops_url, full).await.status, StatusCode::OK);
    let snap = c.get(&format!("/api/boards/{b}/snapshot")).await.json();
    assert!(
        snap["items"][0].get("crop").is_none(),
        "a full crop is stored as absent"
    );

    // Library: name order, paged two at a time, nameless last.
    for (i, name) in ["b.png", "A.png", "c.png"].iter().enumerate() {
        assert_eq!(
            c.upload(name, &png(40, 30, 10 + i as u8)).await.status,
            StatusCode::CREATED
        );
    }
    let mut names = vec![];
    let mut cursor = String::new();
    loop {
        let page = c
            .get(&format!("/api/assets?sort=name&limit=2&cursor={cursor}"))
            .await
            .json();
        names.extend(
            page["assets"]
                .as_array()
                .unwrap()
                .iter()
                .map(|a| a["originalFilename"].as_str().unwrap().to_string()),
        );
        match page["nextCursor"].as_str() {
            Some(next) => cursor = next.into(),
            None => break,
        }
    }
    assert_eq!(names, ["A.png", "b.png", "c.png", "Sunset.png"]);
    let recent = c.get("/api/assets?limit=10").await.json();
    assert_eq!(recent["assets"][0]["originalFilename"], "c.png");
    assert_eq!(recent["assets"][3]["boards"], 2);
    assert_eq!(
        c.get("/api/assets?q=sun").await.json()["assets"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let mismatched = c
        .get(&format!("/api/assets?sort=recent&cursor={cursor}"))
        .await;
    assert_eq!(mismatched.status, StatusCode::BAD_REQUEST);

    // Collections.
    let coll = c
        .json("POST", "/api/collections", json!({ "name": "Skies" }))
        .await
        .json();
    let cid = coll["id"].as_str().unwrap();
    let ghost = uuid::Uuid::now_v7().to_string();
    let added = c
        .json(
            "PUT",
            &format!("/api/collections/{cid}/assets"),
            json!({ "assetIds": [id, ghost] }),
        )
        .await
        .json();
    assert_eq!(added, json!({ "skipped": [ghost] }));
    assert_eq!(
        c.get(&format!("/api/collections/{cid}")).await.json()["assetCount"],
        1
    );
    assert_eq!(
        c.get(&format!("/api/assets?collection={cid}")).await.json()["assets"][0]["id"],
        id.as_str()
    );
    assert_eq!(
        c.json("POST", "/api/collections", json!({ "name": "Skies" }))
            .await
            .status,
        StatusCode::CONFLICT
    );

    // Delete: refused while on a board, then cascaded, restored, purged.
    let refused = c
        .send("DELETE", &format!("/api/assets/{id}"), None, vec![], &[])
        .await;
    assert_eq!(refused.status, StatusCode::CONFLICT);
    assert_eq!(refused.json()["boardCount"], 2);
    assert_eq!(refused.json()["boards"][0]["items"], 1);
    let cascaded = c
        .send(
            "DELETE",
            &format!("/api/assets/{id}?withItems=true"),
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(cascaded.status, StatusCode::NO_CONTENT);
    assert_eq!(
        c.get(&format!("/api/boards/{b}/snapshot")).await.json()["items"],
        json!([])
    );
    assert_eq!(
        c.get("/api/assets?deleted=true").await.json()["assets"][0]["id"],
        id.as_str()
    );
    assert_eq!(
        c.send(
            "POST",
            &format!("/api/assets/{id}/restore"),
            None,
            vec![],
            &[]
        )
        .await
        .status,
        StatusCode::OK
    );
    assert_eq!(
        c.send(
            "DELETE",
            &format!("/api/assets/{id}/file"),
            None,
            vec![],
            &[]
        )
        .await
        .status,
        StatusCode::CONFLICT
    );
    c.send("DELETE", &format!("/api/assets/{id}"), None, vec![], &[])
        .await;
    assert_eq!(
        c.send(
            "DELETE",
            &format!("/api/assets/{id}/file"),
            None,
            vec![],
            &[]
        )
        .await
        .status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        c.get(&format!("/api/assets/{id}")).await.status,
        StatusCode::NOT_FOUND
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn realtime_presence_previews_and_announced_ops() {
    let (mut c, app, dir) = signed_in().await;
    let board = c
        .json("POST", "/api/boards", json!({ "title": "Live" }))
        .await
        .json();
    let b = board["id"].as_str().unwrap().to_string();

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(visarium::serve(app, listener));

    let connect = |origin: &'static str| {
        let mut req = format!("ws://{addr}/ws/canvas/{b}")
            .into_client_request()
            .unwrap();
        req.headers_mut()
            .insert("cookie", c.cookie_header().parse().unwrap());
        req.headers_mut().insert(
            "origin",
            origin.replace("ADDR", &addr.to_string()).parse().unwrap(),
        );
        tokio_tungstenite::connect_async(req)
    };
    assert!(
        connect("http://evil.example").await.is_err(),
        "cross-origin sockets are refused"
    );

    let (mut a, _) = connect("http://ADDR").await.unwrap();
    let (mut z, _) = connect("http://ADDR").await.unwrap();
    async fn next(
        ws: &mut (impl StreamExt<Item = Result<tungstenite::Message, tungstenite::Error>> + Unpin),
    ) -> Value {
        loop {
            match ws.next().await.unwrap().unwrap() {
                tungstenite::Message::Text(t) => return serde_json::from_str(&t).unwrap(),
                tungstenite::Message::Close(f) => {
                    return json!({ "closed": f.map(|f| u16::from(f.code)) });
                }
                _ => continue,
            }
        }
    }
    let hello =
        json!({ "t": "hello", "protocolVersion": visarium::PROTOCOL_VERSION, "sinceRevision": 0 })
            .to_string();
    a.send(hello.clone().into()).await.unwrap();
    let welcome_a = next(&mut a).await;
    assert_eq!(welcome_a["t"], "welcome");
    let actor_a = welcome_a["actorId"].as_str().unwrap().to_string();
    z.send(hello.into()).await.unwrap();
    let welcome_z = next(&mut z).await;
    assert_eq!(welcome_z["actors"].as_array().unwrap().len(), 2);
    let joined = next(&mut a).await;
    assert_eq!(joined["joined"][0]["displayName"], "Ada");
    assert_ne!(
        joined["joined"][0]["colourIndex"],
        welcome_a["actors"][0]["colourIndex"]
    );

    a.send(
        json!({ "t": "cursor", "x": 4.5, "y": -1 })
            .to_string()
            .into(),
    )
    .await
    .unwrap();
    assert_eq!(
        next(&mut z).await,
        json!({ "t": "cursor", "actorId": actor_a, "x": 4.5, "y": -1.0 })
    );

    let item = uuid::Uuid::now_v7().to_string();
    a.send(
        json!({ "t": "lock.acquire", "itemIds": [item] })
            .to_string()
            .into(),
    )
    .await
    .unwrap();
    assert_eq!(next(&mut a).await["heldBy"], actor_a.as_str());
    assert_eq!(next(&mut z).await["heldBy"], actor_a.as_str());
    z.send(
        json!({ "t": "lock.acquire", "itemIds": [item] })
            .to_string()
            .into(),
    )
    .await
    .unwrap();
    assert_eq!(
        next(&mut z).await["heldBy"],
        actor_a.as_str(),
        "refused: still a's"
    );

    // An op committed over REST by `a` reaches `z`, and not `a`.
    let group = uuid::Uuid::now_v7();
    let posted = c
        .send(
            "POST",
            &format!("/api/boards/{b}/operations"),
            Some("application/json"),
            json!({ "operations": [{ "body": { "type": "group.create", "groupId": group, "label": "x" } }] }).to_string().into_bytes(),
            &[("x-visarium-actor", &actor_a)],
        )
        .await;
    assert_eq!(posted.status, StatusCode::OK);
    let op = next(&mut z).await;
    assert_eq!(
        (
            op["t"].as_str(),
            op["fromRevision"].as_i64(),
            op["toRevision"].as_i64()
        ),
        (Some("op"), Some(0), Some(1))
    );
    assert_eq!(
        op["operations"][0],
        json!({ "type": "group.create", "groupId": group, "label": "x" })
    );

    // Attribution is the server's: a peer hears the stamped body, whatever the author claimed.
    let me = c.get("/api/session").await.json()["user"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let list = json!({ "type": "item.create", "itemId": uuid::Uuid::now_v7(), "transform": { "x": 0.0, "y": 0.0, "width": 300.0, "height": 100.0 },
        "content": { "kind": "checklist", "title": "T", "tasks": [{ "id": "t1", "text": "One", "by": "mallory", "at": "1999" }] } });
    let posted = c
        .send(
            "POST",
            &format!("/api/boards/{b}/operations"),
            Some("application/json"),
            json!({ "operations": [{ "body": list }] })
                .to_string()
                .into_bytes(),
            &[("x-visarium-actor", &actor_a)],
        )
        .await;
    assert_eq!(
        posted.json()["operations"][0]["content"]["tasks"][0]["by"],
        me.as_str(),
        "the author gets the stamp back"
    );
    let heard = next(&mut z).await;
    assert_eq!(
        heard["operations"][0]["content"]["tasks"][0]["by"],
        me.as_str()
    );
    // The web client drops a frame with `"groupId": null`, so absent stays absent.
    let created = heard["operations"][0].as_object().unwrap();
    assert!(!created.contains_key("groupId") && !created.contains_key("appearance"));
    assert_ne!(heard["operations"][0]["content"]["tasks"][0]["at"], "1999");

    drop(a);
    let released = next(&mut z).await;
    assert_eq!(
        released,
        json!({ "t": "lock", "itemIds": [item], "heldBy": null, "expiresAt": 0 })
    );
    assert_eq!(
        next(&mut z).await,
        json!({ "t": "presence", "left": [actor_a] })
    );

    z.send(
        json!({ "t": "cursor", "x": "nope", "y": 0 })
            .to_string()
            .into(),
    )
    .await
    .unwrap();
    assert_eq!(next(&mut z).await, json!({ "closed": 1007 }));
    let _ = std::fs::remove_dir_all(dir);
}

// --- board objects and links (canvas/notes, diagrams, checklists, links) -----

async fn post_ops(c: &mut Client, board: &str, bodies: Vec<Value>) -> Reply {
    let ops: Vec<Value> = bodies.into_iter().map(|b| json!({ "body": b })).collect();
    c.json(
        "POST",
        &format!("/api/boards/{board}/operations"),
        json!({ "operations": ops }),
    )
    .await
}

fn create(item: &str, content: Value) -> Value {
    json!({ "type": "item.create", "itemId": item, "transform": { "x": 0.0, "y": 0.0, "width": 320.0, "height": 120.0 }, "content": content })
}

#[tokio::test]
async fn notes_diagrams_checklists_and_links() {
    let (mut c, _app, dir) = signed_in().await;
    let me = c.get("/api/session").await.json()["user"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let (b, image, _, _) = board_with_one_image(&mut c).await;
    let id = || uuid::Uuid::now_v7().to_string();
    let (note, flow, list) = (id(), id(), id());
    let made = post_ops(&mut c, &b, vec![
        create(&note, json!({ "kind": "note", "source": "### Overview\n\n- [ ] one" })),
        create(&flow, json!({ "kind": "diagram", "lang": "mermaid", "source": "flowchart LR\n  API --> Pay" })),
        create(&list, json!({ "kind": "checklist", "title": "Build", "tasks": [
            { "id": "t1", "text": "Interface", "state": "done" }, { "id": "t2", "text": "Keys" }] })),
    ]).await;
    assert_eq!(made.status, StatusCode::OK, "{}", made.json());
    let snap = c.get(&format!("/api/boards/{b}/snapshot")).await.json();
    let by_id = |snap: &Value, i: &str| {
        snap["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|x| x["id"] == i)
            .cloned()
            .unwrap()
    };
    assert_eq!(
        by_id(&snap, &note)["content"],
        json!({ "kind": "note", "source": "### Overview\n\n- [ ] one" })
    );
    assert_eq!(by_id(&snap, &flow)["content"]["lang"], "mermaid");
    assert_eq!(
        by_id(&snap, &list)["content"]["tasks"][1]["state"],
        "todo",
        "state defaults to todo"
    );
    assert_eq!(
        by_id(&snap, &list)["content"]["tasks"][0]["by"],
        me.as_str()
    );
    assert_eq!(snap["people"][&me], "Ada");
    assert_eq!(
        by_id(&snap, &image)["content"]["kind"],
        "image",
        "images are untouched"
    );

    // Every refusal names the problem and commits nothing.
    let revision = |snap: &Value| snap["revision"].as_i64().unwrap();
    let before = revision(&c.get(&format!("/api/boards/{b}/snapshot")).await.json());
    let too_many: Vec<Value> = (0..201)
        .map(|n| json!({ "id": format!("t{n}"), "text": "x" }))
        .collect();
    let refused = [
        (
            create(&id(), json!({ "kind": "sticker", "source": "x" })),
            "unknown item kind",
        ),
        (
            create(
                &id(),
                json!({ "kind": "diagram", "lang": "graphviz", "source": "x" }),
            ),
            "lang must be one of",
        ),
        (create(&id(), json!({ "kind": "note" })), "needs its source"),
        (
            create(
                &id(),
                json!({ "kind": "note", "source": "x".repeat(65 * 1024) }),
            ),
            "limited to 65536 bytes",
        ),
        (
            create(
                &id(),
                json!({ "kind": "checklist", "title": "T", "tasks": too_many }),
            ),
            "at most 200 tasks",
        ),
        (
            create(
                &id(),
                json!({ "kind": "checklist", "title": "T", "tasks": [{ "id": "a", "text": "x".repeat(501) }] }),
            ),
            "1-500 characters",
        ),
        (
            create(
                &id(),
                json!({ "kind": "checklist", "title": "T", "tasks": [{ "id": "a", "text": "x" }, { "id": "a", "text": "y" }] }),
            ),
            "used twice",
        ),
        (
            create(
                &id(),
                json!({ "kind": "checklist", "title": "T", "tasks": [{ "id": "a", "text": "x", "state": "maybe" }] }),
            ),
            "state must be one of",
        ),
        (
            json!({ "type": "item.source", "itemId": list, "source": "x" }),
            "only notes and diagrams have source",
        ),
        (
            json!({ "type": "task.add", "itemId": note, "task": { "id": "t9", "text": "x" } }),
            "not a checklist",
        ),
        (
            json!({ "type": "task.add", "itemId": list, "task": { "id": "t1", "text": "x" } }),
            "already in this checklist",
        ),
        (
            json!({ "type": "link.add", "linkId": id(), "from": { "itemId": note }, "to": { "itemId": note }, "linkType": "describes" }),
            "two different ends",
        ),
        (
            json!({ "type": "link.add", "linkId": id(), "from": { "itemId": image, "element": "Pay" }, "to": { "itemId": flow }, "linkType": "describes" }),
            "only a diagram, a note or a checklist has named parts",
        ),
        (
            json!({ "type": "link.add", "linkId": id(), "from": { "itemId": note }, "to": { "itemId": flow, "element": "x".repeat(201) }, "linkType": "describes" }),
            "element name is 1-200",
        ),
        (
            json!({ "type": "link.add", "linkId": id(), "from": { "itemId": note }, "to": { "itemId": flow }, "linkType": "likes" }),
            "link type must be one of",
        ),
        (
            json!({ "type": "link.add", "linkId": id(), "from": { "itemId": note }, "to": { "itemId": id() }, "linkType": "describes" }),
            "no item",
        ),
    ];
    for (body, why) in refused {
        let r = post_ops(&mut c, &b, vec![body.clone()]).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{body}");
        assert!(
            r.json()["detail"]
                .as_str()
                .unwrap_or_default()
                .contains(why),
            "{why}: {}",
            r.json()
        );
    }
    assert_eq!(
        revision(&c.get(&format!("/api/boards/{b}/snapshot")).await.json()),
        before,
        "refused batches commit nothing"
    );

    // A link on another board's item is not this board's to make.
    let other = c
        .json("POST", "/api/boards", json!({ "title": "Other" }))
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let elsewhere = id();
    assert_eq!(
        post_ops(
            &mut c,
            &other,
            vec![create(&elsewhere, json!({ "kind": "note", "source": "x" }))]
        )
        .await
        .status,
        StatusCode::OK
    );
    let cross = json!({ "type": "link.add", "linkId": id(), "from": { "itemId": note }, "to": { "itemId": elsewhere }, "linkType": "describes" });
    assert_eq!(
        post_ops(&mut c, &b, vec![cross]).await.status,
        StatusCode::BAD_REQUEST
    );

    // Tasks change one at a time; the stamp is the server's, not the client's.
    let changed = post_ops(&mut c, &b, vec![
        json!({ "type": "task.set", "itemId": list, "taskId": "t2", "state": "doing", "by": "mallory", "at": "1999" }),
        json!({ "type": "task.add", "itemId": list, "task": { "id": "t3", "text": "Between" }, "index": 1 }),
        json!({ "type": "task.remove", "itemId": list, "taskId": "t1" }),
        json!({ "type": "checklist.title", "itemId": list, "title": "Build the adapter" }),
    ]).await;
    assert_eq!(changed.status, StatusCode::OK, "{}", changed.json());
    assert_eq!(changed.json()["operations"][0]["by"], me.as_str());
    let tasks = by_id(
        &c.get(&format!("/api/boards/{b}/snapshot")).await.json(),
        &list,
    )["content"]
        .clone();
    assert_eq!(tasks["title"], "Build the adapter");
    let summary: Vec<(String, String)> = tasks["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| {
            (
                t["id"].as_str().unwrap().into(),
                t["state"].as_str().unwrap().into(),
            )
        })
        .collect();
    assert_eq!(
        summary,
        [
            ("t3".to_string(), "todo".to_string()),
            ("t2".into(), "doing".into())
        ]
    );
    assert_eq!(tasks["tasks"][1]["by"], me.as_str());
    assert_ne!(tasks["tasks"][1]["at"], "1999");

    // A stale source edit is refused with both revisions named; a current one lands.
    let rev = by_id(
        &c.get(&format!("/api/boards/{b}/snapshot")).await.json(),
        &note,
    )["revision"]
        .as_i64()
        .unwrap();
    let stale = post_ops(&mut c, &b, vec![json!({ "type": "item.source", "itemId": note, "source": "late", "baseRevision": rev - 1 })]).await;
    assert_eq!(stale.status, StatusCode::CONFLICT);
    let detail = stale.json()["detail"].as_str().unwrap().to_string();
    assert!(
        detail.contains(&format!("revision {}", rev - 1))
            && detail.contains(&format!("revision {rev}")),
        "{detail}"
    );
    let fresh = post_ops(&mut c, &b, vec![json!({ "type": "item.source", "itemId": note, "source": "### Overview v2", "baseRevision": rev })]).await;
    assert_eq!(fresh.status, StatusCode::OK);
    assert_eq!(
        by_id(
            &c.get(&format!("/api/boards/{b}/snapshot")).await.json(),
            &note
        )["revision"],
        rev + 1
    );

    // Links: add, retype, survive duplication remapped, and cascade with their items.
    let (l1, l2) = (id(), id());
    let linked = post_ops(&mut c, &b, vec![
        json!({ "type": "link.add", "linkId": l1, "from": { "itemId": note }, "to": { "itemId": flow, "element": "Pay" }, "linkType": "describes" }),
        json!({ "type": "link.add", "linkId": l2, "from": { "itemId": list }, "to": { "itemId": flow, "element": "Pay" }, "linkType": "implements" }),
        json!({ "type": "link.set", "linkId": l1, "linkType": "comments" }),
    ]).await;
    assert_eq!(linked.status, StatusCode::OK, "{}", linked.json());
    let snap = c.get(&format!("/api/boards/{b}/snapshot")).await.json();
    let l = snap["links"]
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["id"] == l1.as_str())
        .unwrap()
        .clone();
    assert_eq!(
        (
            l["linkType"].as_str(),
            l["to"]["element"].as_str(),
            l["by"].as_str()
        ),
        (Some("comments"), Some("Pay"), Some(me.as_str()))
    );
    assert_eq!(l["from"], json!({ "itemId": note, "element": null }));

    let copy = c
        .json("POST", &format!("/api/boards/{b}/duplicate"), json!(null))
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let copied = c.get(&format!("/api/boards/{copy}/snapshot")).await.json();
    assert_eq!(copied["links"].as_array().unwrap().len(), 2);
    let ids: Vec<&str> = copied["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["id"].as_str().unwrap())
        .collect();
    for l in copied["links"].as_array().unwrap() {
        assert!(
            ids.contains(&l["from"]["itemId"].as_str().unwrap())
                && ids.contains(&l["to"]["itemId"].as_str().unwrap()),
            "remapped: {l}"
        );
    }
    let copied_list = copied["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["content"]["kind"] == "checklist")
        .unwrap();
    assert_eq!(copied_list["content"]["tasks"].as_array().unwrap().len(), 2);

    assert_eq!(
        post_ops(
            &mut c,
            &b,
            vec![json!({ "type": "item.delete", "itemId": flow })]
        )
        .await
        .status,
        StatusCode::OK
    );
    assert_eq!(
        c.get(&format!("/api/boards/{b}/snapshot")).await.json()["links"],
        json!([]),
        "deleting an end deletes its links"
    );
    // Updates whose target is gone apply to nothing, as every other operation does.
    for gone in [
        json!({ "type": "link.delete", "linkId": id() }),
        json!({ "type": "task.set", "itemId": list, "taskId": "nope", "state": "done" }),
        json!({ "type": "task.remove", "itemId": list, "taskId": "nope" }),
        json!({ "type": "item.source", "itemId": id(), "source": "x", "baseRevision": 3 }),
        json!({ "type": "task.add", "itemId": id(), "task": { "id": "t1", "text": "x" } }),
    ] {
        assert_eq!(
            post_ops(&mut c, &b, vec![gone.clone()]).await.status,
            StatusCode::OK,
            "{gone}"
        );
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn migration_0004_keeps_every_existing_image() {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePool};
    let (config, dir) = config(true);
    std::fs::create_dir_all(&dir).unwrap();
    // A database exactly as 0003 left it, with an image item that is grouped and cropped.
    let pool = SqlitePool::connect_with(
        SqliteConnectOptions::new()
            .filename(&config.database)
            .create_if_missing(true)
            .foreign_keys(true),
    )
    .await
    .unwrap();
    let mut before = sqlx::migrate!("./migrations");
    before.migrations = before
        .migrations
        .iter()
        .filter(|m| m.version < 4)
        .cloned()
        .collect::<Vec<_>>()
        .into();
    before.run(&pool).await.unwrap();
    for sql in [
        "INSERT INTO canvas (id, title) VALUES ('b1', 'Refs')",
        "INSERT INTO asset (id, content_hash, storage_key, mime_type, byte_size, width, height) VALUES ('a1', 'h', 'k', 'image/png', 10, 600, 400)",
        "INSERT INTO canvas_group (id, canvas_id, label) VALUES ('g1', 'b1', 'Sky')",
        "INSERT INTO canvas_item (id, canvas_id, asset_id, group_id, x, y, width, height, z, opacity, revision, crop_x, crop_y, crop_w, crop_h)
         VALUES ('i1', 'b1', 'a1', 'g1', 1, 2, 300, 200, 4, 0.5, 7, 0.25, 0, 0.5, 1)",
    ] {
        sqlx::query(sql).execute(&pool).await.unwrap();
    }
    pool.close().await;

    let app = visarium::open(config).await.unwrap();
    let row: (String, String, Option<String>, Option<String>, String, f64, i64, f64) =
        sqlx::query_as("SELECT kind, asset_id, body, lang, group_id, opacity, revision, crop_x FROM canvas_item WHERE id = 'i1'")
            .fetch_one(&app.db)
            .await
            .unwrap();
    assert_eq!(
        row,
        (
            "image".into(),
            "a1".into(),
            None,
            None,
            "g1".into(),
            0.5,
            7,
            0.25
        )
    );
    let snap = visarium::boards::snapshot_of(&app.db, "b1").await.unwrap();
    assert_eq!(snap["items"][0]["content"]["asset"]["assetId"], "a1");
    assert_eq!(snap["items"][0]["crop"]["x"], 0.25);
    assert_eq!(snap["links"], json!([]));
    let _ = std::fs::remove_dir_all(dir);
}

// --- sessions (auth/sessions) ------------------------------------------------

#[tokio::test]
async fn sessions_are_durable_hashed_listed_and_revocable() {
    let (config, dir) = config(false);
    let app = visarium::open(config.clone()).await.unwrap();
    let mut c = Client::new(visarium::router(app.clone()));
    c.get("/api/session").await;
    c.json(
        "POST",
        "/api/setup",
        json!({ "username": "ada", "displayName": "Ada", "password": "correct horse battery" }),
    )
    .await;
    let cookie = c.cookie("VISARIUM_SESSION").unwrap();

    // Only the hash is stored.
    let hashes: Vec<String> = sqlx::query_scalar("SELECT token_hash FROM session")
        .fetch_all(&app.db)
        .await
        .unwrap();
    assert!(
        !hashes.contains(&cookie),
        "the cookie value is not in the table"
    );
    assert!(hashes.contains(&visarium::auth::hash_token(&cookie)));

    // A restart signs nobody out: a second App over the same file.
    let reopened = visarium::open(config).await.unwrap();
    c.router = visarium::router(reopened);
    assert_eq!(c.get("/api/boards").await.status, StatusCode::OK);

    // A second browser; the list shows both, one marked current.
    let mut d = Client::new(c.router.clone());
    d.get("/api/session").await;
    let ua = [(
        "user-agent",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15",
    )];
    let signed = d
        .send(
            "POST",
            "/api/session",
            Some("application/json"),
            json!({ "username": "ada", "password": "correct horse battery" })
                .to_string()
                .into_bytes(),
            &ua,
        )
        .await;
    assert_eq!(signed.status, StatusCode::OK);
    let list = c.get("/api/sessions").await.json();
    assert_eq!(list.as_array().unwrap().len(), 2);
    assert_eq!(
        list.as_array()
            .unwrap()
            .iter()
            .filter(|s| s["current"] == true)
            .count(),
        1
    );
    let other = list
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["current"] == false)
        .unwrap()
        .clone();
    assert_eq!(other["label"], "Safari on macOS");

    // Session fixation: signing in again ends the session it arrived with.
    let before = d.cookie("VISARIUM_SESSION").unwrap();
    d.json(
        "POST",
        "/api/session",
        json!({ "username": "ada", "password": "correct horse battery" }),
    )
    .await;
    assert_ne!(d.cookie("VISARIUM_SESSION").unwrap(), before);
    let mut stale = Client::new(c.router.clone());
    stale.cookies.push(("VISARIUM_SESSION".into(), before));
    assert_eq!(
        stale.get("/api/boards").await.status,
        StatusCode::UNAUTHORIZED
    );

    // Sign out one session from another.
    let other = c
        .get("/api/sessions")
        .await
        .json()
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["current"] == false)
        .unwrap()["id"]
        .clone();
    assert_eq!(
        c.send(
            "DELETE",
            &format!("/api/sessions/{}", other.as_str().unwrap()),
            None,
            vec![],
            &[]
        )
        .await
        .status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(d.get("/api/boards").await.status, StatusCode::UNAUTHORIZED);

    // "Sign out other sessions".
    d.json(
        "POST",
        "/api/session",
        json!({ "username": "ada", "password": "correct horse battery" }),
    )
    .await;
    assert_eq!(
        c.send("DELETE", "/api/sessions", None, vec![], &[])
            .await
            .status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(d.get("/api/boards").await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(c.get("/api/boards").await.status, StatusCode::OK);

    // A password change ends the others and keeps the caller's.
    d.json(
        "POST",
        "/api/session",
        json!({ "username": "ada", "password": "correct horse battery" }),
    )
    .await;
    let changed = c.json("PUT", "/api/accounts/me/password", json!({ "currentPassword": "correct horse battery", "newPassword": "a different long one" })).await;
    assert_eq!(changed.status, StatusCode::NO_CONTENT);
    assert_eq!(d.get("/api/boards").await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(c.get("/api/boards").await.status, StatusCode::OK);

    // Expired is the same as absent: 401 problem+json. The sweep clears it.
    sqlx::query("UPDATE session SET expires_at = '2000-01-01T00:00:00.000Z'")
        .execute(&app.db)
        .await
        .unwrap();
    let expired = c.get("/api/boards").await;
    assert_eq!(expired.status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        expired.headers[header::CONTENT_TYPE],
        "application/problem+json"
    );
    visarium::auth::sweep(&app.db).await.unwrap();
    assert_eq!(count(&app, "SELECT count(*) FROM session").await, 0);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn cookies_are_host_bound_over_https() {
    let (mut c, _app, dir) = signed_in().await;
    let r = c
        .send(
            "POST",
            "/api/session",
            Some("application/json"),
            json!({ "username": "ada", "password": "correct horse battery" })
                .to_string()
                .into_bytes(),
            &[("x-forwarded-proto", "https")],
        )
        .await;
    let set: Vec<&str> = r
        .headers
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|v| v.to_str().unwrap())
        .collect();
    let session = set
        .iter()
        .find(|c| c.starts_with("__Host-visarium_session="))
        .expect("a __Host- session cookie");
    for attr in ["Path=/", "HttpOnly", "SameSite=Lax", "Secure"] {
        assert!(session.contains(attr), "{session} lacks {attr}");
    }
    assert!(
        !session.contains("Domain"),
        "a __Host- cookie names no domain"
    );
    // And it is honoured.
    let token = session
        .split(';')
        .next()
        .unwrap()
        .split_once('=')
        .unwrap()
        .1
        .to_string();
    let mut s = Client::new(c.router.clone());
    s.cookies.push(("__Host-visarium_session".into(), token));
    assert_eq!(s.get("/api/boards").await.status, StatusCode::OK);
    let _ = std::fs::remove_dir_all(dir);
}

// --- passwords (auth/sign-in) ------------------------------------------------

#[tokio::test]
async fn passwords_upgrade_from_bcrypt_and_take_long_passphrases() {
    let (mut c, app, dir) = signed_in().await;
    let old = visarium::auth::bcrypt_hash_for_tests("correct horse battery");
    sqlx::query("UPDATE app_user SET password_hash = ?")
        .bind(old)
        .execute(&app.db)
        .await
        .unwrap();
    let r = c
        .json(
            "POST",
            "/api/session",
            json!({ "username": "ada", "password": "correct horse battery" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let stored: String = sqlx::query_scalar("SELECT password_hash FROM app_user")
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert!(
        stored.starts_with("{argon2id}$argon2id$"),
        "upgraded: {stored}"
    );
    assert_eq!(
        c.json(
            "POST",
            "/api/session",
            json!({ "username": "ada", "password": "correct horse battery" })
        )
        .await
        .status,
        StatusCode::OK
    );

    let long = "x".repeat(99) + "y";
    let changed = c
        .json(
            "PUT",
            "/api/accounts/me/password",
            json!({ "currentPassword": "correct horse battery", "newPassword": long }),
        )
        .await;
    assert_eq!(changed.status, StatusCode::NO_CONTENT);
    assert_eq!(
        c.json(
            "POST",
            "/api/session",
            json!({ "username": "ada", "password": long })
        )
        .await
        .status,
        StatusCode::OK
    );
    let last_differs = "x".repeat(99) + "z";
    assert_eq!(
        c.json(
            "POST",
            "/api/session",
            json!({ "username": "ada", "password": last_differs })
        )
        .await
        .status,
        StatusCode::UNAUTHORIZED
    );
    let too_long = c
        .json(
            "PUT",
            "/api/accounts/me/password",
            json!({ "currentPassword": long, "newPassword": "x".repeat(1025) }),
        )
        .await;
    assert_eq!(too_long.status, StatusCode::BAD_REQUEST);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_configuration_nobody_could_sign_in_with_is_refused() {
    let (mut cfg, dir) = config(false);
    cfg.password_disabled = true;
    let err = visarium::open(cfg.clone())
        .await
        .err()
        .expect("refused")
        .to_string();
    assert!(
        err.contains("VISARIUM_AUTH_PASSWORD") && err.contains("VISARIUM_OIDC_"),
        "{err}"
    );
    cfg.password_disabled = false;
    cfg.public_url = None;
    cfg.providers = vec![visarium::oidc::ProviderConfig {
        id: "google".into(),
        name: "Google".into(),
        issuer: "https://accounts.google.com".into(),
        client_id: "x".into(),
        client_secret: "y".into(),
    }];
    let err = visarium::open(cfg)
        .await
        .err()
        .expect("refused")
        .to_string();
    assert!(err.contains("VISARIUM_PUBLIC_URL"), "{err}");
    let _ = std::fs::remove_dir_all(dir);
}

// --- OpenID Connect (auth/sign-in) -------------------------------------------

/// A linked identity is bound to the issuer that vouched for it: the same
/// subject from another issuer under the same provider id reaches nobody.
#[tokio::test]
async fn an_identity_is_bound_to_its_issuer() {
    let first = Issuer::start().await;
    let second = Issuer::start().await;
    let (mut cfg, dir) = config(false);
    cfg.providers = vec![first.provider("test")];
    let app = visarium::open(cfg.clone()).await.unwrap();
    let mut c = Client::new(visarium::router(app.clone()));
    c.get("/api/session").await;
    let ana = Person::new("ana-sub", "ana@example.com");
    let claimed = sso(
        &mut c,
        &first,
        "/auth/oidc/test/start?intent=claim",
        ana.clone(),
    )
    .await;
    assert_eq!(claimed.status, StatusCode::FOUND);
    assert_eq!(
        count(
            &app,
            "SELECT count(*) FROM user_identity WHERE issuer IS NOT NULL"
        )
        .await,
        1,
        "a new link records its issuer"
    );

    // Linked before issuers were recorded: the next sign-in adopts one.
    sqlx::query("UPDATE user_identity SET issuer = NULL")
        .execute(&app.db)
        .await
        .unwrap();
    let mut again = Client::new(visarium::router(app.clone()));
    again.get("/api/session").await;
    let back = sso(&mut again, &first, "/auth/oidc/test/start", ana.clone()).await;
    assert_eq!(location(&back), "/");
    assert_eq!(
        count(
            &app,
            "SELECT count(*) FROM user_identity WHERE issuer IS NOT NULL"
        )
        .await,
        1
    );

    // The same provider id, re-pointed at another issuer: same `sub`, no account.
    cfg.providers = vec![second.provider("test")];
    let moved = visarium::open(cfg).await.unwrap();
    let mut stranger = Client::new(visarium::router(moved));
    stranger.get("/api/session").await;
    let refused = sso(&mut stranger, &second, "/auth/oidc/test/start", ana).await;
    assert_eq!(location(&refused), "/sign-in?error=no-account");
    assert_eq!(
        stranger.get("/api/session").await.json()["user"],
        Value::Null
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn sign_in_with_a_provider() {
    let issuer = Issuer::start().await;
    let (app, dir) = with_provider(&issuer, |_| {}).await;
    let mut c = Client::new(visarium::router(app.clone()));
    let session = c.get("/api/session").await.json();
    assert_eq!(
        session["providers"],
        json!([{ "id": "test", "name": "Test SSO" }])
    );
    assert_eq!(session["passwordEnabled"], true);

    // First run, claimed through the provider.
    let ana = Person::new("ana-sub", "ana@example.com");
    let claimed = sso(
        &mut c,
        &issuer,
        "/auth/oidc/test/start?intent=claim&return=/boards",
        ana.clone(),
    )
    .await;
    assert_eq!(
        (claimed.status, location(&claimed)),
        (StatusCode::FOUND, "/boards".to_string())
    );
    assert!(
        c.cookie("VISARIUM_FLOW").is_none(),
        "the flow cookie is cleared"
    );
    let me = c.get("/api/session").await.json()["user"].clone();
    assert_eq!(
        (
            me["username"].as_str(),
            me["admin"].as_bool(),
            me["displayName"].as_str()
        ),
        (Some("ana"), Some(true), Some("ANA-SUB"))
    );

    // Out, and back in with the provider.
    c.send("DELETE", "/api/session", None, vec![], &[]).await;
    let back = sso(&mut c, &issuer, "/auth/oidc/test/start", ana.clone()).await;
    assert_eq!(location(&back), "/");
    assert_eq!(
        c.get("/api/session").await.json()["user"]["username"],
        "ana"
    );

    // An open redirect is refused: back to "/".
    let evil = sso(
        &mut c,
        &issuer,
        "/auth/oidc/test/start?return=https://evil.example/",
        ana.clone(),
    )
    .await;
    assert_eq!(location(&evil), "/");

    // A callback opened in a browser that did not start it signs nobody in.
    let mut c2 = Client::new(c.router.clone());
    let callback = to_callback(&mut c2, &issuer, "/auth/oidc/test/start", ana.clone()).await;
    let mut stranger = Client::new(c.router.clone());
    let refused = stranger.get(&callback).await;
    assert_eq!(location(&refused), "/sign-in?error=expired");
    assert!(stranger.cookie("VISARIUM_SESSION").is_none());
    // ...and once used, it is used up, even in the browser that started it.
    let mut c3 = Client::new(c.router.clone());
    let callback = to_callback(&mut c3, &issuer, "/auth/oidc/test/start", ana.clone()).await;
    let flow = c3.cookie("VISARIUM_FLOW").unwrap();
    assert_eq!(location(&c3.get(&callback).await), "/");
    c3.cookies.push(("VISARIUM_FLOW".into(), flow));
    assert_eq!(location(&c3.get(&callback).await), "/sign-in?error=expired");

    // A stranger with no invitation is turned away and nothing is created —
    // even with the same email as an existing account.
    let accounts = count(&app, "SELECT count(*) FROM app_user").await;
    let mut s = Client::new(c.router.clone());
    let intruder = sso(
        &mut s,
        &issuer,
        "/auth/oidc/test/start",
        Person::new("intruder", "ana@example.com"),
    )
    .await;
    assert_eq!(location(&intruder), "/sign-in?error=no-account");
    assert_eq!(count(&app, "SELECT count(*) FROM app_user").await, accounts);
    assert_eq!(count(&app, "SELECT count(*) FROM user_identity").await, 1);

    // A provider that declines is "cancelled", not an error page.
    let mut d = Client::new(c.router.clone());
    let left = d.get("/auth/oidc/test/start").await;
    let declined = d.get(&provider_round_trip(&location(&left)).await).await;
    assert_eq!(location(&declined), "/sign-in?error=cancelled");

    // An SSO-only account cannot drop its last way in; with a password, it can.
    let unlink = c
        .send(
            "DELETE",
            "/api/accounts/me/identities/test",
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(unlink.status, StatusCode::CONFLICT);
    let set = c
        .json(
            "PUT",
            "/api/accounts/me/password",
            json!({ "newPassword": "now with a password" }),
        )
        .await;
    assert_eq!(
        set.status,
        StatusCode::NO_CONTENT,
        "an SSO-only account sets its first password without a current one"
    );
    let ids = c.get("/api/accounts/me/identities").await.json();
    assert_eq!(
        (
            ids["hasPassword"].as_bool(),
            ids["identities"][0]["provider"].as_str()
        ),
        (Some(true), Some("test"))
    );
    assert_eq!(ids["identities"][0]["email"], "ana@example.com");
    assert_eq!(
        c.send(
            "DELETE",
            "/api/accounts/me/identities/test",
            None,
            vec![],
            &[]
        )
        .await
        .status,
        StatusCode::NO_CONTENT
    );

    // Link it again, from the signed-in account.
    let linked = sso(
        &mut c,
        &issuer,
        "/auth/oidc/test/start?intent=link&return=/account",
        ana.clone(),
    )
    .await;
    assert_eq!(location(&linked), "/account");
    // The same identity cannot be linked to a second account.
    let token = invite(&mut c, json!({})).await;
    let mut bob = Client::new(c.router.clone());
    bob.get("/api/session").await;
    bob.json("POST", "/api/invitations/redeem", json!({ "token": token, "username": "bob", "displayName": "Bob", "password": "bobs long password" })).await;
    let stolen = sso(
        &mut bob,
        &issuer,
        "/auth/oidc/test/start?intent=link",
        ana.clone(),
    )
    .await;
    assert_eq!(location(&stolen), "/sign-in?error=linked-elsewhere");
    // Linking needs someone signed in.
    assert_eq!(
        location(&stranger.get("/auth/oidc/test/start?intent=link").await),
        "/sign-in?error=signed-out"
    );

    // A deactivated account cannot come back through the provider.
    let bob_id = bob.get("/api/session").await.json()["user"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let bob_sso = Person::new("bob-sub", "bob@example.com");
    assert_eq!(
        location(
            &sso(
                &mut bob,
                &issuer,
                "/auth/oidc/test/start?intent=link",
                bob_sso.clone()
            )
            .await
        ),
        "/"
    );
    c.send(
        "POST",
        &format!("/api/accounts/{bob_id}/deactivation"),
        None,
        vec![],
        &[],
    )
    .await;
    let mut gone = Client::new(c.router.clone());
    assert_eq!(
        location(&sso(&mut gone, &issuer, "/auth/oidc/test/start", bob_sso).await),
        "/sign-in?error=deactivated"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn an_sso_only_instance_has_no_password_sign_in() {
    let issuer = Issuer::start().await;
    let (app, dir) = with_provider(&issuer, |c| c.password_disabled = true).await;
    let mut c = Client::new(visarium::router(app));
    assert_eq!(c.get("/api/session").await.json()["passwordEnabled"], false);
    let r = c
        .json(
            "POST",
            "/api/session",
            json!({ "username": "ada", "password": "correct horse battery" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let r = c
        .json(
            "POST",
            "/api/setup",
            json!({ "username": "ada", "displayName": "Ada", "password": "correct horse battery" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn exactly_one_first_run_claim_wins_whatever_the_method() {
    let issuer = Issuer::start().await;
    let (app, dir) = with_provider(&issuer, |_| {}).await;
    let router = visarium::router(app.clone());
    // Four browsers part-way through an SSO claim, four about to post a password.
    let mut sso_claims = vec![];
    for n in 0..4 {
        let mut c = Client::new(router.clone());
        let callback = to_callback(
            &mut c,
            &issuer,
            "/auth/oidc/test/start?intent=claim",
            Person::new(&format!("p{n}"), &format!("p{n}@example.com")),
        )
        .await;
        sso_claims.push((c, callback));
    }
    let mut password_claims = vec![];
    for n in 0..4 {
        let mut c = Client::new(router.clone());
        c.get("/api/session").await;
        password_claims.push((c, n));
    }
    let mut runs: Vec<std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send>>> = vec![];
    for (mut c, callback) in sso_claims {
        runs.push(Box::pin(
            async move { location(&c.get(&callback).await) == "/" },
        ));
    }
    for (mut c, n) in password_claims {
        runs.push(Box::pin(async move {
            let body = json!({ "username": format!("pw{n}"), "displayName": "P", "password": "correct horse battery" });
            c.json("POST", "/api/setup", body).await.status == StatusCode::CREATED
        }));
    }
    let won = futures_util::future::join_all(runs)
        .await
        .into_iter()
        .filter(|w| *w)
        .count();
    assert_eq!(won, 1);
    assert_eq!(count(&app, "SELECT count(*) FROM app_user").await, 1);
    let _ = std::fs::remove_dir_all(dir);
}

// --- invitations (auth/invitations) -----------------------------------------

#[tokio::test]
async fn invitations_join_reset_and_die() {
    let issuer = Issuer::start().await;
    let (app, dir) = with_provider(&issuer, |_| {}).await;
    let mut admin = Client::new(visarium::router(app.clone()));
    admin.get("/api/session").await;
    admin
        .json(
            "POST",
            "/api/setup",
            json!({ "username": "ada", "displayName": "Ada", "password": "correct horse battery" }),
        )
        .await;

    // Make, list.
    let token = invite(&mut admin, json!({ "note": "for Ana" })).await;
    let list = admin.get("/api/invitations").await.json();
    assert_eq!(
        (
            list[0]["note"].as_str(),
            list[0]["admin"].as_bool(),
            list[0]["purpose"].as_str()
        ),
        (Some("for Ana"), Some(false), Some("join"))
    );
    assert!(list[0]["expiresAt"].is_string());

    // Join through the provider: the token goes in a POST body, never a URL.
    let mut ana = Client::new(admin.router.clone());
    ana.get("/api/session").await;
    assert_eq!(
        ana.json(
            "POST",
            "/api/invitations/inspect",
            json!({ "token": token })
        )
        .await
        .json()["purpose"],
        "join"
    );
    issuer.next(Person::new("ana-sub", "ana@example.com"));
    let started = ana
        .json(
            "POST",
            "/api/invitations/redeem/test",
            json!({ "token": token }),
        )
        .await;
    assert_eq!(started.status, StatusCode::OK, "{}", started.json());
    let callback = provider_round_trip(started.json()["redirect"].as_str().unwrap()).await;
    assert_eq!(location(&ana.get(&callback).await), "/");
    let me = ana.get("/api/session").await.json()["user"].clone();
    assert_eq!(
        (me["username"].as_str(), me["admin"].as_bool()),
        (Some("ana"), Some(false))
    );
    let used = ana
        .json(
            "POST",
            "/api/invitations/inspect",
            json!({ "token": token }),
        )
        .await;
    assert_eq!(
        (used.status, used.json()["code"].as_str()),
        (StatusCode::GONE, Some("invite-used"))
    );
    let again = ana
        .json(
            "POST",
            "/api/invitations/redeem/test",
            json!({ "token": token }),
        )
        .await;
    assert_eq!(again.status, StatusCode::GONE);
    assert!(
        admin
            .get("/api/invitations")
            .await
            .json()
            .as_array()
            .unwrap()
            .is_empty(),
        "used ones leave the list"
    );

    // An admin invitation makes an admin.
    let token = invite(&mut admin, json!({ "admin": true })).await;
    let mut ben = Client::new(admin.router.clone());
    ben.get("/api/session").await;
    let joined = ben.json("POST", "/api/invitations/redeem", json!({ "token": token, "username": "ben", "displayName": "Ben", "password": "bens long password" })).await;
    assert_eq!(
        (joined.status, joined.json()["admin"].as_bool()),
        (StatusCode::CREATED, Some(true))
    );

    // Revoked and expired links say so.
    let token = invite(&mut admin, json!({})).await;
    let id = admin.get("/api/invitations").await.json()[0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        admin
            .send(
                "DELETE",
                &format!("/api/invitations/{id}"),
                None,
                vec![],
                &[]
            )
            .await
            .status,
        StatusCode::NO_CONTENT
    );
    let revoked = ana
        .json(
            "POST",
            "/api/invitations/inspect",
            json!({ "token": token }),
        )
        .await;
    assert_eq!(
        (revoked.status, revoked.json()["code"].as_str()),
        (StatusCode::GONE, Some("invite-invalid"))
    );
    let token = invite(&mut admin, json!({})).await;
    sqlx::query(
        "UPDATE invitation SET expires_at = '2000-01-01T00:00:00.000Z' WHERE used_at IS NULL",
    )
    .execute(&app.db)
    .await
    .unwrap();
    let expired = ana.json("POST", "/api/invitations/redeem", json!({ "token": token, "username": "late", "displayName": "Late", "password": "a long enough one" })).await;
    assert_eq!(
        (expired.status, expired.json()["code"].as_str()),
        (StatusCode::GONE, Some("invite-expired"))
    );

    // Members cannot invite.
    assert_eq!(
        ana.json("POST", "/api/invitations", json!({})).await.status,
        StatusCode::FORBIDDEN
    );

    // Reset: a one-time link that sets a new password and ends every session.
    let ben_id = ben.get("/api/session").await.json()["user"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let token = invite(&mut admin, json!({ "purpose": "reset", "userId": ben_id })).await;
    let mut anyone = Client::new(admin.router.clone());
    anyone.get("/api/session").await;
    assert_eq!(
        anyone
            .json(
                "POST",
                "/api/invitations/inspect",
                json!({ "token": token })
            )
            .await
            .json()["username"],
        "ben"
    );
    let reset = anyone
        .json(
            "POST",
            "/api/invitations/redeem",
            json!({ "token": token, "password": "bens brand new one" }),
        )
        .await;
    assert_eq!(reset.status, StatusCode::NO_CONTENT);
    assert_eq!(
        ben.get("/api/boards").await.status,
        StatusCode::UNAUTHORIZED,
        "his other session ended"
    );
    assert_eq!(
        anyone
            .json(
                "POST",
                "/api/session",
                json!({ "username": "ben", "password": "bens long password" })
            )
            .await
            .status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        anyone
            .json(
                "POST",
                "/api/session",
                json!({ "username": "ben", "password": "bens brand new one" })
            )
            .await
            .status,
        StatusCode::OK
    );
    let reused = anyone
        .json(
            "POST",
            "/api/invitations/redeem",
            json!({ "token": token, "password": "yet another password" }),
        )
        .await;
    assert_eq!(
        (reused.status, reused.json()["code"].as_str()),
        (StatusCode::GONE, Some("invite-used"))
    );
    let _ = std::fs::remove_dir_all(dir);
}

// --- share links (sharing/read-only-links) -----------------------------------

async fn board_with_one_image(c: &mut Client) -> (String, String, String, String) {
    let on_board = c.upload("on.png", &png(600, 400, 3)).await.json()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let elsewhere = c.upload("off.png", &png(600, 400, 4)).await.json()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let b = c
        .json("POST", "/api/boards", json!({ "title": "Refs" }))
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let item = uuid::Uuid::now_v7().to_string();
    let t = json!({ "x": 0.0, "y": 0.0, "width": 600.0, "height": 400.0, "rotation": 0.0 });
    let ops = json!({ "operations": [{ "body": { "type": "item.create", "itemId": item, "transform": t, "z": 1.0,
        "content": { "kind": "image", "asset": { "assetId": on_board, "intrinsicWidth": 600, "intrinsicHeight": 400 } } } }] });
    assert_eq!(
        c.json("POST", &format!("/api/boards/{b}/operations"), ops)
            .await
            .status,
        StatusCode::OK
    );
    (b, item, on_board, elsewhere)
}

async fn share(c: &mut Client, board: &str, body: Value) -> (String, String) {
    let made = c
        .json("POST", &format!("/api/boards/{board}/shares"), body)
        .await;
    assert_eq!(made.status, StatusCode::CREATED, "{}", made.json());
    let link = made.json()["link"].as_str().unwrap().to_string();
    assert!(link.starts_with("/s#"), "the token rides in the fragment");
    (
        made.json()["id"].as_str().unwrap().to_string(),
        link[3..].to_string(),
    )
}

async fn viewer(router: &axum::Router, token: &str) -> (Client, Reply) {
    let mut v = Client::new(router.clone());
    v.get("/api/session").await;
    let r = v
        .json("POST", "/api/shared/session", json!({ "token": token }))
        .await;
    (v, r)
}

#[tokio::test]
async fn share_links_show_one_board_and_nothing_else() {
    let (mut c, app, dir) = signed_in().await;
    let (b, item, on_board, elsewhere) = board_with_one_image(&mut c).await;
    let (link_id, token) = share(
        &mut c,
        &b,
        json!({ "label": "client review", "expiresInDays": 7 }),
    )
    .await;
    assert_eq!(
        c.json(
            "POST",
            &format!("/api/boards/{b}/shares"),
            json!({ "expiresInDays": 3 })
        )
        .await
        .status,
        StatusCode::BAD_REQUEST
    );
    let listed = c.get(&format!("/api/boards/{b}/shares")).await.json();
    assert_eq!(
        (
            listed[0]["label"].as_str(),
            listed[0]["createdByName"].as_str()
        ),
        (Some("client review"), Some("Ada"))
    );
    assert!(
        listed[0]["expiresAt"].is_string() && listed[0].get("link").is_none(),
        "the token is shown once, at creation"
    );
    assert_eq!(
        c.get("/api/shares").await.json().as_array().unwrap().len(),
        1,
        "admins see every link"
    );

    // Someone outside opens it.
    let (mut v, opened) = viewer(&c.router, &token).await;
    assert_eq!(opened.status, StatusCode::OK, "{}", opened.json());
    assert_eq!(
        opened.json(),
        json!({ "member": false, "boardId": b, "title": "Refs", "sharedBy": "Ada" })
    );
    assert!(v.cookie("VISARIUM_SHARE").is_some());
    let board = v.get("/api/shared/board").await;
    assert_eq!(board.status, StatusCode::OK);
    assert_eq!(
        (
            board.json()["title"].as_str(),
            board.json()["items"].as_array().unwrap().len()
        ),
        (Some("Refs"), 1)
    );
    assert_eq!(
        board.json()["links"],
        json!([]),
        "a viewer sees the board's links"
    );
    assert!(
        board.json().get("people").is_none(),
        "but not collaborators' names"
    );
    assert_eq!(board.headers["referrer-policy"], "no-referrer");
    assert_eq!(board.headers["x-robots-tag"], "noindex");
    assert_eq!(board.headers[header::CACHE_CONTROL], "private, no-store");
    assert_eq!(
        v.get(&format!("/api/shared/assets/{on_board}/derivatives/512"))
            .await
            .status,
        StatusCode::OK
    );

    // ...and nothing else.
    assert_eq!(
        v.get(&format!("/api/shared/assets/{elsewhere}/derivatives/512"))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        v.get(&format!("/api/assets/{on_board}/content"))
            .await
            .status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        v.get(&format!("/api/assets/{on_board}/derivatives/512"))
            .await
            .status,
        StatusCode::UNAUTHORIZED
    );
    for path in [
        "/api/boards",
        "/api/assets",
        "/api/collections",
        "/api/accounts",
        "/api/sessions",
    ] {
        assert_eq!(v.get(path).await.status, StatusCode::UNAUTHORIZED, "{path}");
    }
    let write = json!({ "operations": [{ "body": { "type": "item.delete", "itemId": item } }] });
    assert_eq!(
        v.json("POST", &format!("/api/boards/{b}/operations"), write)
            .await
            .status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        c.get(&format!("/api/boards/{b}")).await.json()["revision"],
        1,
        "the board is unchanged"
    );
    assert_eq!(v.get("/api/session").await.json()["user"], Value::Null);

    // A member who opens a link is sent to the board itself.
    let member = c
        .json("POST", "/api/shared/session", json!({ "token": token }))
        .await
        .json();
    assert_eq!(member, json!({ "member": true, "boardId": b }));

    // An image taken off the board stops being served.
    c.json(
        "POST",
        &format!("/api/boards/{b}/operations"),
        json!({ "operations": [{ "body": { "type": "item.delete", "itemId": item } }] }),
    )
    .await;
    assert_eq!(
        v.get(&format!("/api/shared/assets/{on_board}/derivatives/512"))
            .await
            .status,
        StatusCode::NOT_FOUND
    );

    // Revoked: the viewer's next request, and the link itself, are refused.
    assert_eq!(
        c.send(
            "DELETE",
            &format!("/api/shares/{link_id}"),
            None,
            vec![],
            &[]
        )
        .await
        .status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        v.get("/api/shared/board").await.status,
        StatusCode::UNAUTHORIZED
    );
    let (_, again) = viewer(&c.router, &token).await;
    assert_eq!(
        (again.status, again.json()["code"].as_str()),
        (StatusCode::GONE, Some("revoked"))
    );

    // Expired: refused, and no board data.
    let (_, day) = share(&mut c, &b, json!({ "expiresInDays": 1 })).await;
    sqlx::query(
        "UPDATE share_link SET expires_at = '2000-01-01T00:00:00.000Z' WHERE revoked_at IS NULL",
    )
    .execute(&app.db)
    .await
    .unwrap();
    let (_, late) = viewer(&c.router, &day).await;
    assert_eq!(
        (late.status, late.json()["code"].as_str()),
        (StatusCode::GONE, Some("expired"))
    );
    assert!(
        !String::from_utf8_lossy(&late.body).contains("Refs"),
        "no board data"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_passphrase_link_reveals_nothing_until_unlocked() {
    let (mut c, app, dir) = signed_in().await;
    let (b, ..) = board_with_one_image(&mut c).await;
    let (link_id, token) = share(&mut c, &b, json!({ "passphrase": "open sesame" })).await;
    let (other_id, _) = share(&mut c, &b, json!({})).await;

    let (mut v, locked) = viewer(&c.router, &token).await;
    assert_eq!(locked.status, StatusCode::UNAUTHORIZED);
    assert_eq!(locked.json()["passphraseRequired"], true);
    let said = String::from_utf8_lossy(&locked.body);
    assert!(
        !said.contains("Refs") && !said.contains("Ada") && locked.json().get("boardId").is_none(),
        "nothing about the board: {said}"
    );
    for _ in 0..6 {
        let wrong = v
            .json(
                "POST",
                "/api/shared/session",
                json!({ "token": token, "passphrase": "guess" }),
            )
            .await;
        assert_eq!(wrong.status, StatusCode::UNAUTHORIZED);
    }
    assert!(
        app.throttle.delay(&format!("share:{link_id}")) > std::time::Duration::ZERO,
        "guesses slow this link down"
    );
    assert_eq!(
        app.throttle.delay(&format!("share:{other_id}")),
        std::time::Duration::ZERO,
        "and no other"
    );
    let opened = v
        .json(
            "POST",
            "/api/shared/session",
            json!({ "token": token, "passphrase": "open sesame" }),
        )
        .await;
    assert_eq!(opened.status, StatusCode::OK);
    assert_eq!(v.get("/api/shared/board").await.status, StatusCode::OK);

    // A new passphrase ends whoever came in by the old one.
    let changed = c
        .json(
            "PATCH",
            &format!("/api/shares/{link_id}"),
            json!({ "passphrase": "new words" }),
        )
        .await;
    assert_eq!(
        (changed.status, changed.json()["hasPassphrase"].as_bool()),
        (StatusCode::OK, Some(true))
    );
    assert_eq!(
        v.get("/api/shared/board").await.status,
        StatusCode::UNAUTHORIZED
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn sharing_is_absent_in_single_user_mode() {
    let (app, dir) = instance(true).await;
    let mut c = Client::new(visarium::router(app));
    assert_eq!(c.get("/api/session").await.json()["sharingEnabled"], false);
    let b = c
        .json("POST", "/api/boards", json!({ "title": "Mine" }))
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        c.json("POST", &format!("/api/boards/{b}/shares"), json!({}))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn viewers_watch_live_and_are_cut_off_on_revoke() {
    let (mut c, app, dir) = signed_in().await;
    let (b, ..) = board_with_one_image(&mut c).await;
    let (link_id, token) = share(&mut c, &b, json!({})).await;
    let (v, _) = viewer(&c.router, &token).await;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(visarium::serve(app, listener));
    let socket = |path: String, cookies: String| {
        let mut req = format!("ws://{addr}{path}").into_client_request().unwrap();
        req.headers_mut().insert("cookie", cookies.parse().unwrap());
        req.headers_mut()
            .insert("origin", format!("http://{addr}").parse().unwrap());
        tokio_tungstenite::connect_async(req)
    };
    async fn next(
        ws: &mut (impl StreamExt<Item = Result<tungstenite::Message, tungstenite::Error>> + Unpin),
    ) -> Value {
        loop {
            match tokio::time::timeout(std::time::Duration::from_secs(5), ws.next())
                .await
                .expect("a frame in time")
                .unwrap()
                .unwrap()
            {
                tungstenite::Message::Text(t) => return serde_json::from_str(&t).unwrap(),
                tungstenite::Message::Close(f) => {
                    return json!({ "closed": f.map(|f| u16::from(f.code)) });
                }
                _ => continue,
            }
        }
    }
    let hello =
        json!({ "t": "hello", "protocolVersion": visarium::PROTOCOL_VERSION, "sinceRevision": 0 })
            .to_string();

    // The member's own socket refuses the viewer's cookie, and vice versa.
    assert!(
        socket(format!("/ws/canvas/{b}"), v.cookie_header())
            .await
            .is_err()
    );
    assert!(
        socket("/ws/shared".into(), c.cookie_header())
            .await
            .is_err()
    );

    let (mut vs, _) = socket("/ws/shared".into(), v.cookie_header())
        .await
        .unwrap();
    vs.send(hello.clone().into()).await.unwrap();
    let welcome = next(&mut vs).await;
    assert_eq!(
        (welcome["t"].as_str(), welcome["actors"].clone()),
        (Some("welcome"), json!([])),
        "no names for viewers"
    );

    let (mut ms, _) = socket(format!("/ws/canvas/{b}"), c.cookie_header())
        .await
        .unwrap();
    ms.send(hello.into()).await.unwrap();
    assert_eq!(next(&mut ms).await["t"], "welcome");
    assert_eq!(next(&mut ms).await, json!({ "t": "viewers", "count": 1 }));

    // A viewer's frames change nothing and reach nobody.
    vs.send(json!({ "t": "cursor", "x": 1, "y": 2 }).to_string().into())
        .await
        .unwrap();
    vs.send(
        json!({ "t": "lock.acquire", "itemIds": [uuid::Uuid::now_v7()] })
            .to_string()
            .into(),
    )
    .await
    .unwrap();

    // A member's committed edit reaches the viewer; the member's next frame is
    // that op, not anything the viewer sent.
    let group = uuid::Uuid::now_v7();
    let posted = c
        .json("POST", &format!("/api/boards/{b}/operations"), json!({ "operations": [{ "body": { "type": "group.create", "groupId": group, "label": "x" } }] }))
        .await;
    assert_eq!(posted.status, StatusCode::OK, "{}", posted.json());
    let op = next(&mut vs).await;
    assert_eq!(
        (op["t"].as_str(), op["toRevision"].as_i64()),
        (Some("op"), Some(2))
    );
    assert_eq!(
        next(&mut ms).await["t"],
        "op",
        "the member heard the op, not the viewer's cursor or lock"
    );

    // Revoking closes the viewer's socket.
    let revoked = c
        .send(
            "DELETE",
            &format!("/api/shares/{link_id}"),
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(revoked.status, StatusCode::NO_CONTENT);
    assert_eq!(next(&mut vs).await, json!({ "closed": 1008 }));
    assert_eq!(next(&mut ms).await, json!({ "t": "viewers", "count": 0 }));
    let _ = std::fs::remove_dir_all(dir);
}

// --- the desktop handoff (desktop/server-connections) ------------------------

fn pkce() -> (String, String) {
    use base64::Engine;
    use sha2::Digest;
    let verifier =
        uuid::Uuid::new_v4().simple().to_string() + &uuid::Uuid::new_v4().simple().to_string();
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(sha2::Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

#[tokio::test]
async fn the_desktop_gets_a_device_token_through_the_browser() {
    let (mut c, _app, dir) = signed_in().await;
    let (verifier, challenge) = pkce();
    let authorize = |port: u16, challenge: &str| json!({ "port": port, "challenge": challenge, "state": "s1", "label": "Visarium Desktop on studio-mac" });

    // Signed out, nothing is issued; a low port is refused.
    let mut desktop = Client::new(c.router.clone());
    desktop.get("/api/session").await;
    assert_eq!(
        desktop
            .json(
                "POST",
                "/api/device/authorize",
                authorize(49152, &challenge)
            )
            .await
            .status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        c.json("POST", "/api/device/authorize", authorize(80, &challenge))
            .await
            .status,
        StatusCode::BAD_REQUEST
    );

    // The browser, signed in, allows the device; the redirect is loopback only.
    let ok = c
        .json(
            "POST",
            "/api/device/authorize",
            authorize(49152, &challenge),
        )
        .await
        .json();
    let redirect = ok["redirect"].as_str().unwrap();
    assert!(
        redirect.starts_with("http://127.0.0.1:49152/callback?code="),
        "{redirect}"
    );
    assert!(redirect.ends_with("&state=s1"));
    let code = redirect
        .split("code=")
        .nth(1)
        .unwrap()
        .split('&')
        .next()
        .unwrap()
        .to_string();

    // A wrong verifier is refused, and burns the code.
    let wrong = desktop
        .json(
            "POST",
            "/api/device-tokens",
            json!({ "code": code, "verifier": "not-the-verifier" }),
        )
        .await;
    assert_eq!(wrong.status, StatusCode::UNAUTHORIZED);
    let late = desktop
        .json(
            "POST",
            "/api/device-tokens",
            json!({ "code": code, "verifier": verifier }),
        )
        .await;
    assert_eq!(late.status, StatusCode::UNAUTHORIZED, "single use");

    // The right one gets a device token: a session that works and is listed.
    let ok = c
        .json(
            "POST",
            "/api/device/authorize",
            authorize(49152, &challenge),
        )
        .await
        .json();
    let code = ok["redirect"]
        .as_str()
        .unwrap()
        .split("code=")
        .nth(1)
        .unwrap()
        .split('&')
        .next()
        .unwrap()
        .to_string();
    let token = desktop
        .json(
            "POST",
            "/api/device-tokens",
            json!({ "code": code, "verifier": verifier }),
        )
        .await;
    assert_eq!(token.status, StatusCode::CREATED);
    assert_eq!(token.json()["user"]["username"], "ada");
    desktop.cookies.push((
        "VISARIUM_SESSION".into(),
        token.json()["token"].as_str().unwrap().into(),
    ));
    assert_eq!(desktop.get("/api/boards").await.status, StatusCode::OK);
    let sessions = c.get("/api/sessions").await.json();
    let device = sessions
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["kind"] == "device")
        .unwrap();
    assert_eq!(device["label"], "Visarium Desktop on studio-mac");

    // The password form's fast path asks for a device session too.
    let mut fast = Client::new(c.router.clone());
    fast.get("/api/session").await;
    fast.json("POST", "/api/session", json!({ "username": "ada", "password": "correct horse battery", "device": { "label": "Visarium Desktop on old-laptop" } })).await;
    let sessions = c.get("/api/sessions").await.json();
    assert!(
        sessions
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["kind"] == "device" && s["label"] == "Visarium Desktop on old-laptop")
    );
    let _ = std::fs::remove_dir_all(dir);
}

// --- agent access: the data model (ADR-0031) ---------------------------------

fn create_note(id: &str, source: &str) -> Value {
    json!({ "body": { "type": "item.create", "itemId": id, "z": 1.0,
        "transform": { "x": 0.0, "y": 0.0, "width": 200.0, "height": 100.0, "rotation": 0.0 },
        "content": { "kind": "note", "source": source } } })
}

#[tokio::test]
async fn migration_0005_keeps_sessions_and_numbers_items_per_kind() {
    let (config, dir) = config(false);
    std::fs::create_dir_all(&dir).unwrap();
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&config.database)
        .create_if_missing(true)
        .foreign_keys(true);
    let db = sqlx::SqlitePool::connect_with(options).await.unwrap();
    let mut before = sqlx::migrate!("./migrations");
    before.migrations = std::borrow::Cow::Owned(
        before
            .migrations
            .iter()
            .filter(|m| m.version < 5)
            .cloned()
            .collect(),
    );
    before.run(&db).await.unwrap();
    for sql in [
        "INSERT INTO app_user (id, username, display_name, is_admin) VALUES ('u1', 'ada', 'Ada', 1)",
        "INSERT INTO session (token_hash, id, kind, user_id, label, expires_at) VALUES ('h1', 's1', 'browser', 'u1', 'Safari', '2999-01-01T00:00:00.000Z')",
        "INSERT INTO session (token_hash, id, kind, user_id, label, expires_at) VALUES ('h2', 's2', 'device', 'u1', 'Mac', '2999-01-01T00:00:00.000Z')",
        "INSERT INTO canvas (id, title) VALUES ('b1', 'One')",
        "INSERT INTO canvas (id, title) VALUES ('b2', 'Two')",
        "INSERT INTO canvas_group (id, canvas_id, label) VALUES ('g-a', 'b1', 'A')",
        "INSERT INTO canvas_item (id, canvas_id, kind, body, x, y, width, height, created_at) VALUES ('n-a', 'b1', 'note', 'first', 0, 0, 1, 1, '2026-01-01')",
        "INSERT INTO canvas_item (id, canvas_id, kind, body, x, y, width, height, created_at) VALUES ('n-b', 'b1', 'note', 'second', 0, 0, 1, 1, '2026-01-02')",
        "INSERT INTO canvas_item (id, canvas_id, kind, lang, body, x, y, width, height, created_at) VALUES ('d-a', 'b1', 'diagram', 'mermaid', 'flowchart LR; A-->B', 0, 0, 1, 1, '2026-01-03')",
        "INSERT INTO canvas_item (id, canvas_id, kind, body, x, y, width, height, created_at) VALUES ('n-c', 'b2', 'note', 'other board', 0, 0, 1, 1, '2026-01-01')",
    ] {
        sqlx::query(sql).execute(&db).await.unwrap();
    }
    db.close().await;

    let app = visarium::open(config).await.unwrap();
    let role: String = sqlx::query_scalar("SELECT role FROM app_user WHERE id = 'u1'")
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert_eq!(role, "admin", "0009 keeps an admin an admin");
    let sessions: Vec<(String, String)> =
        sqlx::query_as("SELECT id, kind FROM session ORDER BY id")
            .fetch_all(&app.db)
            .await
            .unwrap();
    assert_eq!(
        sessions,
        vec![
            ("s1".into(), "browser".into()),
            ("s2".into(), "device".into())
        ]
    );
    let refs: Vec<(String, i64)> = sqlx::query_as("SELECT id, ref_no FROM canvas_item ORDER BY id")
        .fetch_all(&app.db)
        .await
        .unwrap();
    assert_eq!(
        refs,
        vec![
            ("d-a".into(), 1),
            ("n-a".into(), 1),
            ("n-b".into(), 2),
            ("n-c".into(), 1)
        ]
    );
    let next: String = sqlx::query_scalar("SELECT next_refs FROM canvas WHERE id = 'b1'")
        .fetch_one(&app.db)
        .await
        .unwrap();
    let next: Value = serde_json::from_str(&next).unwrap();
    assert_eq!(
        (next["n"].as_i64(), next["d"].as_i64(), next["g"].as_i64()),
        (Some(2), Some(1), Some(1))
    );
    let found: Vec<String> =
        sqlx::query_scalar("SELECT item_id FROM item_text WHERE item_text MATCH 'second'")
            .fetch_all(&app.db)
            .await
            .unwrap();
    assert_eq!(
        found,
        vec!["n-b".to_string()],
        "existing text is searchable after the migration"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn collision_is_stored_toggled_snapshotted_and_duplicated() {
    let (mut c, _app, dir) = signed_in().await;
    let b = c
        .json("POST", "/api/boards", json!({ "title": "Collide" }))
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let (n1, n2, g) = (
        uuid::Uuid::now_v7().to_string(),
        uuid::Uuid::now_v7().to_string(),
        uuid::Uuid::now_v7().to_string(),
    );
    let mut on = create_note(&n1, "agent's");
    on["body"]["collides"] = json!(true);
    let ops = json!({ "operations": [on, create_note(&n2, "person's"),
        { "body": { "type": "group.create", "groupId": g, "memberIds": [n2], "collides": true } }] });
    assert_eq!(
        c.json("POST", &format!("/api/boards/{b}/operations"), ops)
            .await
            .status,
        StatusCode::OK
    );
    let snap = c.get(&format!("/api/boards/{b}/snapshot")).await.json();
    let collides = |snap: &Value, id: &str| {
        snap["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["id"] == id)
            .unwrap()["collides"]
            .clone()
    };
    assert_eq!(
        (collides(&snap, &n1), collides(&snap, &n2)),
        (json!(true), json!(false)),
        "absent is off"
    );
    assert_eq!(snap["groups"][0]["collides"], true);

    let toggle = json!({ "operations": [
        { "body": { "type": "item.collides", "itemId": n1, "collides": false } },
        { "body": { "type": "group.collides", "groupId": g, "collides": false } },
        { "body": { "type": "item.collides", "itemId": n2, "collides": true } }] });
    assert_eq!(
        c.json("POST", &format!("/api/boards/{b}/operations"), toggle)
            .await
            .status,
        StatusCode::OK
    );
    let snap = c.get(&format!("/api/boards/{b}/snapshot")).await.json();
    assert_eq!(
        (collides(&snap, &n1), collides(&snap, &n2)),
        (json!(false), json!(true))
    );
    assert_eq!(snap["groups"][0]["collides"], false);

    let copy = c
        .json("POST", &format!("/api/boards/{b}/duplicate"), json!(null))
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let snap = c.get(&format!("/api/boards/{copy}/snapshot")).await.json();
    let mut kept: Vec<_> = snap["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| {
            (
                i["ref"].as_str().unwrap().to_string(),
                i["collides"].as_bool().unwrap(),
            )
        })
        .collect();
    kept.sort();
    assert_eq!(
        kept,
        vec![("n1".into(), false), ("n2".into(), true)],
        "duplicate keeps the setting"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_resize_pushes_collision_on_items_aside_in_the_same_batch() {
    let (mut c, _app, dir) = signed_in().await;
    let b = c
        .json("POST", "/api/boards", json!({ "title": "Push" }))
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let ops_url = format!("/api/boards/{b}/operations");
    let (big, agent_note, person_note) = (
        uuid::Uuid::now_v7().to_string(),
        uuid::Uuid::now_v7().to_string(),
        uuid::Uuid::now_v7().to_string(),
    );
    let at = |id: &str, x: f64, y: f64, collides: bool| {
        json!({ "body": { "type": "item.create", "itemId": id, "z": 1.0, "collides": collides,
            "transform": { "x": x, "y": y, "width": 200.0, "height": 100.0, "rotation": 0.0 },
            "content": { "kind": "note", "source": "x" } } })
    };
    let made = json!({ "operations": [at(&big, 0.0, 0.0, false), at(&agent_note, 0.0, 200.0, true), at(&person_note, 400.0, 200.0, false)] });
    assert_eq!(
        c.json("POST", &ops_url, made).await.json()["revision"],
        3,
        "nothing overlaps yet, nothing pushed"
    );

    // The person grows their note to 600 wide and 320 tall: over both notes below.
    let grow = json!({ "operations": [{ "body": { "type": "item.transform", "itemId": big,
        "transform": { "x": 100.0, "y": 0.0, "width": 600.0, "height": 320.0, "rotation": 0.0 } } }] });
    let reply = c.json("POST", &ops_url, grow).await.json();
    let ops = reply["operations"].as_array().unwrap();
    assert_eq!(ops.len(), 2, "the resize and one push come back: {ops:?}");
    assert_eq!(ops[1]["type"], "item.transform");
    assert_eq!(ops[1]["itemId"], agent_note.as_str());
    assert_eq!(reply["revision"], 5);

    let snap = c.get(&format!("/api/boards/{b}/snapshot")).await.json();
    let y = |id: &str| {
        snap["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["id"] == id)
            .unwrap()["transform"]["y"]
            .as_f64()
            .unwrap()
    };
    assert!(
        y(&agent_note) - 50.0 >= 160.0 + 24.0,
        "the agent's note clears the grown note with the gap"
    );
    assert_eq!(
        y(&person_note),
        200.0,
        "a collision-off note is never moved"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn element_boxes_are_kept_for_the_current_revision_only() {
    let (mut c, app, dir) = signed_in().await;
    let b = c
        .json("POST", "/api/boards", json!({ "title": "Elements" }))
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let d = uuid::Uuid::now_v7().to_string();
    let made = json!({ "operations": [{ "body": { "type": "item.create", "itemId": d, "z": 1.0,
        "transform": { "x": 0.0, "y": 0.0, "width": 480.0, "height": 360.0, "rotation": 0.0 },
        "content": { "kind": "diagram", "lang": "mermaid", "source": "flowchart LR\n  A --> B" } } }] });
    c.json("POST", &format!("/api/boards/{b}/operations"), made)
        .await;
    let url = format!("/api/boards/{b}/items/{d}/elements");
    let report = |rev: i64, x: f64| json!({ "revision": rev, "width": 240.0, "elements": { "A": [x, 10.0, 40.0, 20.0], "B": [180.0, 10.0, 40.0, 20.0] } });
    let board_rev = c.get(&format!("/api/boards/{b}")).await.json()["revision"].clone();

    assert_eq!(
        c.json("PUT", &url, report(0, 10.0)).await.status,
        StatusCode::NO_CONTENT
    );
    let stored = || async {
        sqlx::query_as::<_, (Option<String>, Option<i64>)>(
            "SELECT element_boxes, element_rev FROM canvas_item WHERE id = ?",
        )
        .bind(&d)
        .fetch_one(&app.db)
        .await
        .unwrap()
    };
    let (boxes, rev) = stored().await;
    assert_eq!(rev, Some(0));
    assert_eq!(
        serde_json::from_str::<Value>(&boxes.unwrap()).unwrap()["elements"]["A"],
        json!([10.0, 10.0, 40.0, 20.0])
    );
    assert_eq!(
        c.get(&format!("/api/boards/{b}")).await.json()["revision"],
        board_rev,
        "a report changes no revision"
    );

    // A second browser reports the same revision: the first report stands.
    assert_eq!(
        c.json("PUT", &url, report(0, 99.0)).await.status,
        StatusCode::NO_CONTENT
    );
    assert!(stored().await.0.unwrap().contains("[10.0,10.0,40.0,20.0]"));

    // The diagram is edited; a late report for the old revision is refused.
    let edit = json!({ "operations": [{ "body": { "type": "item.source", "itemId": d, "source": "flowchart LR\n  A --> C" } }] });
    c.json("POST", &format!("/api/boards/{b}/operations"), edit)
        .await;
    assert_eq!(
        c.json("PUT", &url, report(0, 10.0)).await.status,
        StatusCode::CONFLICT
    );
    assert_eq!(
        c.json("PUT", &url, report(1, 30.0)).await.status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(stored().await.1, Some(1));
    assert_eq!(
        c.json(
            "PUT",
            &url,
            json!({ "revision": 1, "width": -1.0, "elements": {} })
        )
        .await
        .status,
        StatusCode::BAD_REQUEST
    );

    // A share-link viewer cannot report.
    let (_, token) = share(&mut c, &b, json!({ "label": "look", "expiresInDays": 7 })).await;
    let (mut v, _) = viewer(&c.router, &token).await;
    assert!(
        v.json("PUT", &url, report(1, 10.0))
            .await
            .status
            .is_client_error()
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn the_server_speaks_the_clients_protocol_version() {
    // A mismatch refuses every socket: the board shows "reconnecting" forever.
    let client = include_str!("../../packages/canvas-core/src/protocol.ts");
    let expected = format!(
        "export const PROTOCOL_VERSION = {};",
        visarium::PROTOCOL_VERSION
    );
    assert!(
        client.contains(&expected),
        "protocol.ts and lib.rs disagree on PROTOCOL_VERSION"
    );
}

#[tokio::test]
async fn migration_0007_leaves_every_existing_item_and_group_fixed() {
    let (config, dir) = config(false);
    std::fs::create_dir_all(&dir).unwrap();
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&config.database)
        .create_if_missing(true)
        .foreign_keys(true);
    let db = sqlx::SqlitePool::connect_with(options).await.unwrap();
    let mut before = sqlx::migrate!("./migrations");
    before.migrations = std::borrow::Cow::Owned(
        before
            .migrations
            .iter()
            .filter(|m| m.version < 7)
            .cloned()
            .collect(),
    );
    before.run(&db).await.unwrap();
    for sql in [
        "INSERT INTO canvas (id, title) VALUES ('b1', 'One')",
        "INSERT INTO canvas_group (id, canvas_id, label, ref_no) VALUES ('g-a', 'b1', 'A', 1)",
        "INSERT INTO canvas_item (id, canvas_id, kind, body, group_id, x, y, width, height, ref_no) VALUES ('n-a', 'b1', 'note', 'x', 'g-a', 0, 0, 1, 1, 1)",
    ] {
        sqlx::query(sql).execute(&db).await.unwrap();
    }
    db.close().await;

    let app = visarium::open(config).await.unwrap();
    let item: (bool, Option<String>) =
        sqlx::query_as("SELECT collides, element_boxes FROM canvas_item")
            .fetch_one(&app.db)
            .await
            .unwrap();
    assert_eq!(item, (false, None));
    let group: bool = sqlx::query_scalar("SELECT collides FROM canvas_group")
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert!(!group);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn refs_are_stable_never_reused_and_copied() {
    let (mut c, app, dir) = signed_in().await;
    let b = c
        .json("POST", "/api/boards", json!({ "title": "Refs" }))
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let ids: Vec<String> = (0..3).map(|_| uuid::Uuid::now_v7().to_string()).collect();
    let ops = json!({ "operations": [
        create_note(&ids[0], "one"),
        create_note(&ids[1], "two"),
        { "body": { "type": "item.create", "itemId": ids[2], "z": 1.0,
            "transform": { "x": 0.0, "y": 0.0, "width": 200.0, "height": 100.0, "rotation": 0.0 },
            "content": { "kind": "diagram", "lang": "mermaid", "source": "flowchart LR; A-->B" } } },
        create_note(&ids[0], "replayed create takes no number"),
    ]});
    assert_eq!(
        c.json("POST", &format!("/api/boards/{b}/operations"), ops)
            .await
            .status,
        StatusCode::OK
    );
    let refs = |snap: &Value| -> Vec<String> {
        let mut r: Vec<String> = snap["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["ref"].as_str().unwrap().to_string())
            .collect();
        r.sort();
        r
    };
    let snap = c.get(&format!("/api/boards/{b}/snapshot")).await.json();
    assert_eq!(refs(&snap), vec!["d1", "n1", "n2"]);

    let edit = json!({ "operations": [
        { "body": { "type": "item.source", "itemId": ids[1], "source": "edited" } },
        { "body": { "type": "item.transform", "itemId": ids[1], "transform": { "x": 50.0, "y": 50.0, "width": 10.0, "height": 10.0, "rotation": 0.0 } } },
    ]});
    c.json("POST", &format!("/api/boards/{b}/operations"), edit)
        .await;
    let snap = c.get(&format!("/api/boards/{b}/snapshot")).await.json();
    assert_eq!(
        refs(&snap),
        vec!["d1", "n1", "n2"],
        "edits and moves keep refs"
    );

    let fresh = uuid::Uuid::now_v7().to_string();
    let ops = json!({ "operations": [{ "body": { "type": "item.delete", "itemId": ids[1] } }, create_note(&fresh, "after delete")] });
    c.json("POST", &format!("/api/boards/{b}/operations"), ops)
        .await;
    let snap = c.get(&format!("/api/boards/{b}/snapshot")).await.json();
    assert_eq!(
        refs(&snap),
        vec!["d1", "n1", "n3"],
        "n2 is gone and is never handed out again"
    );

    let copy = c
        .json("POST", &format!("/api/boards/{b}/duplicate"), json!(null))
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let copied = c.get(&format!("/api/boards/{copy}/snapshot")).await.json();
    assert_eq!(
        refs(&copied),
        vec!["d1", "n1", "n3"],
        "a copy keeps every ref"
    );
    let another = uuid::Uuid::now_v7().to_string();
    c.json(
        "POST",
        &format!("/api/boards/{copy}/operations"),
        json!({ "operations": [create_note(&another, "x")] }),
    )
    .await;
    let copied = c.get(&format!("/api/boards/{copy}/snapshot")).await.json();
    assert!(
        refs(&copied).contains(&"n4".to_string()),
        "a copy's counters continue where the original's were"
    );
    drop(app);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn every_operation_is_logged_and_the_log_is_trimmed() {
    let (mut c, app, dir) = signed_in().await;
    let b = c
        .json("POST", "/api/boards", json!({ "title": "Log" }))
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let n = uuid::Uuid::now_v7().to_string();
    let ops = json!({ "operations": [
        create_note(&n, "hello"),
        { "body": { "type": "item.source", "itemId": n, "source": "hello again" } },
        { "body": { "type": "item.z", "itemId": n, "z": 5.0 } },
    ]});
    c.json("POST", &format!("/api/boards/{b}/operations"), ops)
        .await;
    let rows: Vec<(i64, String, Option<String>)> =
        sqlx::query_as("SELECT revision, json_extract(body, '$.type'), actor_agent FROM canvas_operation WHERE canvas_id = ? ORDER BY revision")
            .bind(&b)
            .fetch_all(&app.db)
            .await
            .unwrap();
    assert_eq!(
        rows,
        vec![
            (1, "item.create".into(), None),
            (2, "item.source".into(), None),
            (3, "item.z".into(), None)
        ],
        "one row per operation, at its own revision"
    );
    let actor: String =
        sqlx::query_scalar("SELECT actor_id FROM canvas_operation WHERE canvas_id = ? LIMIT 1")
            .bind(&b)
            .fetch_one(&app.db)
            .await
            .unwrap();
    let me: String = sqlx::query_scalar("SELECT id FROM app_user WHERE username = 'ada'")
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert_eq!(actor, me);

    let keep = visarium::boards::OPERATION_LOG_KEEP;
    let many: Vec<Value> = (0..keep + 10)
        .map(|i| json!({ "body": { "type": "item.z", "itemId": n, "z": i as f64 } }))
        .collect();
    c.json(
        "POST",
        &format!("/api/boards/{b}/operations"),
        json!({ "operations": many }),
    )
    .await;
    let kept: i64 = sqlx::query_scalar("SELECT count(*) FROM canvas_operation WHERE canvas_id = ?")
        .bind(&b)
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert_eq!(kept, keep);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn item_text_follows_edits_and_deletes() {
    let (mut c, app, dir) = signed_in().await;
    let b = c
        .json("POST", "/api/boards", json!({ "title": "Search" }))
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let n = uuid::Uuid::now_v7().to_string();
    let list = uuid::Uuid::now_v7().to_string();
    let ops = json!({ "operations": [
        create_note(&n, "the quick brown fox"),
        { "body": { "type": "item.create", "itemId": list, "z": 1.0,
            "transform": { "x": 0.0, "y": 0.0, "width": 200.0, "height": 100.0, "rotation": 0.0 },
            "content": { "kind": "checklist", "title": "Plan", "tasks": [{ "id": "t1", "text": "wire the retry_policy", "state": "todo" }] } } },
    ]});
    c.json("POST", &format!("/api/boards/{b}/operations"), ops)
        .await;
    let find = |q: &'static str| {
        let db = app.db.clone();
        async move {
            sqlx::query_scalar::<_, String>("SELECT item_id FROM item_text WHERE item_text MATCH ?")
                .bind(q)
                .fetch_all(&db)
                .await
                .unwrap()
        }
    };
    assert_eq!(find("brown").await, vec![n.clone()]);
    assert_eq!(
        find("retry_policy").await,
        vec![list.clone()],
        "underscores stay inside a word"
    );
    c.json("POST", &format!("/api/boards/{b}/operations"), json!({ "operations": [
        { "body": { "type": "item.source", "itemId": n, "source": "a lazy dog" } },
        { "body": { "type": "task.add", "itemId": list, "task": { "id": "t2", "text": "ship backoff", "state": "todo" } } },
    ]})).await;
    assert!(
        find("brown").await.is_empty(),
        "removed words are no longer found"
    );
    assert_eq!(find("lazy").await, vec![n.clone()]);
    assert_eq!(find("backoff").await, vec![list.clone()]);
    c.json(
        "POST",
        &format!("/api/boards/{b}/operations"),
        json!({ "operations": [{ "body": { "type": "item.delete", "itemId": n } }] }),
    )
    .await;
    assert!(find("lazy").await.is_empty(), "a deleted item is not found");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn agent_tokens_are_minted_shown_once_listed_and_revoked() {
    let (mut c, app, dir) = signed_in().await;
    let made = c
        .json(
            "POST",
            "/api/agent-tokens",
            json!({ "label": "Claude Code on laptop" }),
        )
        .await;
    assert_eq!(made.status, StatusCode::CREATED, "{}", made.json());
    let token = made.json()["token"].as_str().unwrap().to_string();
    let id = made.json()["id"].as_str().unwrap().to_string();
    assert_eq!(token.len(), 64);
    assert_eq!(
        c.json("POST", "/api/agent-tokens", json!({ "label": " " }))
            .await
            .status,
        StatusCode::BAD_REQUEST
    );

    let listed = c.get("/api/agent-tokens").await.json();
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["label"], "Claude Code on laptop");
    assert_eq!(listed[0]["lastUsedAt"], Value::Null, "never used yet");
    assert!(
        listed[0].get("token").is_none() && !listed.to_string().contains(&token),
        "the secret is never shown again"
    );
    let sessions = c.get("/api/sessions").await.json();
    assert!(
        sessions
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["kind"] != "agent"),
        "agent tokens are not browser sessions"
    );

    // Using it records a last use.
    let router = visarium::router(app.clone());
    let use_it = Request::builder()
        .method("POST")
        .uri("/mcp")
        .header(header::HOST, "localhost:8080")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::from(
            json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }).to_string(),
        ))
        .unwrap();
    assert_eq!(
        router.clone().oneshot(use_it).await.unwrap().status(),
        StatusCode::OK
    );
    assert!(c.get("/api/agent-tokens").await.json()[0]["lastUsedAt"].is_string());

    // "Sign out other sessions" leaves agent tokens alone; revoking ends one.
    assert_eq!(
        c.send("DELETE", "/api/sessions", None, vec![], &[])
            .await
            .status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        c.get("/api/agent-tokens")
            .await
            .json()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        c.send(
            "DELETE",
            &format!("/api/agent-tokens/{id}"),
            None,
            vec![],
            &[]
        )
        .await
        .status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(c.get("/api/agent-tokens").await.json(), json!([]));
    assert_eq!(
        c.send(
            "DELETE",
            &format!("/api/agent-tokens/{id}"),
            None,
            vec![],
            &[]
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn the_manage_boards_grant_starts_off_and_persists() {
    let (mut c, _app, dir) = signed_in().await;
    let made = c
        .json("POST", "/api/agent-tokens", json!({ "label": "Claude" }))
        .await
        .json();
    let id = made["id"].as_str().unwrap().to_string();
    assert_eq!(
        c.get("/api/agent-tokens").await.json()[0]["manageBoards"],
        false,
        "off for a new token"
    );
    let on = c
        .json(
            "PATCH",
            &format!("/api/agent-tokens/{id}"),
            json!({ "manageBoards": true }),
        )
        .await;
    assert_eq!(on.status, StatusCode::NO_CONTENT);
    assert_eq!(
        c.get("/api/agent-tokens").await.json()[0]["manageBoards"],
        true,
        "the toggle persists"
    );
    let nobody = c
        .json(
            "PATCH",
            &format!("/api/agent-tokens/{}", uuid::Uuid::now_v7()),
            json!({ "manageBoards": true }),
        )
        .await;
    assert_eq!(nobody.status, StatusCode::NOT_FOUND);

    assert_eq!(
        c.get("/api/agent-settings").await.json(),
        json!({ "localAgentsManageBoards": false })
    );
    let set = c
        .json(
            "PATCH",
            "/api/agent-settings",
            json!({ "localAgentsManageBoards": true }),
        )
        .await;
    assert_eq!(set.json(), json!({ "localAgentsManageBoards": true }));
    assert_eq!(
        c.get("/api/agent-settings").await.json()["localAgentsManageBoards"],
        true
    );
    let _ = std::fs::remove_dir_all(dir);
}

/// Every response refuses sniffing and foreign framing; anything behind a
/// session stays out of shared caches, 304s included.
#[tokio::test]
async fn responses_carry_security_and_cache_headers() {
    let (mut c, _app, dir) = signed_in().await;
    for uri in ["/api/session", "/health", "/boards/abc"] {
        let r = c.get(uri).await;
        assert_eq!(r.headers["x-content-type-options"], "nosniff", "{uri}");
        assert_eq!(
            r.headers["content-security-policy"], "frame-ancestors 'self'",
            "{uri}"
        );
    }
    assert_eq!(
        c.get("/api/session").await.headers["cache-control"],
        "private, no-cache"
    );

    let id = c.upload("a.png", &png(300, 200, 7)).await.json()["id"]
        .as_str()
        .unwrap()
        .to_string();
    for uri in [
        format!("/api/assets/{id}/content"),
        format!("/api/assets/{id}/derivatives/64"),
    ] {
        let first = c.get(&uri).await;
        assert_eq!(first.status, StatusCode::OK, "{uri}");
        let cache = first.headers["cache-control"].to_str().unwrap().to_string();
        assert!(cache.starts_with("private"), "{uri}: {cache}");
        let etag = first.headers["etag"].to_str().unwrap().to_string();
        let again = c
            .send("GET", &uri, None, vec![], &[("if-none-match", &etag)])
            .await;
        assert_eq!(again.status, StatusCode::NOT_MODIFIED, "{uri}");
        assert!(
            again.headers["cache-control"]
                .to_str()
                .unwrap()
                .starts_with("private"),
            "{uri} 304"
        );
    }
    let _ = std::fs::remove_dir_all(dir);
}

/// An agent token is a bearer credential for `/mcp` only. Replayed as the
/// session cookie, or as a bearer anywhere else, it signs nobody in.
#[tokio::test]
async fn an_agent_token_is_never_a_session() {
    let (mut c, app, dir) = signed_in().await;
    let made = c
        .json("POST", "/api/agent-tokens", json!({ "label": "limited" }))
        .await
        .json();
    let (id, token) = (
        made["id"].as_str().unwrap().to_string(),
        made["token"].as_str().unwrap().to_string(),
    );

    let mut agent = Client::new(visarium::router(app.clone()));
    agent.cookies = vec![
        ("VISARIUM_SESSION".into(), token.clone()),
        ("XSRF-TOKEN".into(), "t".into()),
    ];
    assert_eq!(
        agent.get("/api/accounts").await.status,
        StatusCode::UNAUTHORIZED
    );
    let raise = agent
        .json(
            "PATCH",
            &format!("/api/agent-tokens/{id}"),
            json!({ "manageBoards": true }),
        )
        .await;
    assert_eq!(raise.status, StatusCode::UNAUTHORIZED);
    let mint = agent
        .json("POST", "/api/agent-tokens", json!({ "label": "more" }))
        .await;
    assert_eq!(mint.status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        c.get("/api/agent-tokens").await.json(),
        json!([{ "id": id, "label": "limited", "createdAt": made["createdAt"], "lastUsedAt": null, "manageBoards": false, "connectedBySignIn": false }]),
        "the grant stays off and no token was minted"
    );

    let mut bearer = Client::new(visarium::router(app.clone()));
    let auth = format!("Bearer {token}");
    let boards = bearer
        .send(
            "GET",
            "/api/boards",
            None,
            vec![],
            &[("authorization", &auth)],
        )
        .await;
    assert_eq!(boards.status, StatusCode::UNAUTHORIZED);

    // A device session still signs in by cookie, as the desktop relies on.
    let device = c
        .json(
            "POST",
            "/api/session",
            json!({ "username": "ada", "password": "correct horse battery", "device": { "label": "Mac" } }),
        )
        .await;
    assert_eq!(device.status, StatusCode::OK);
    assert_eq!(c.get("/api/accounts").await.status, StatusCode::OK);
    let _ = std::fs::remove_dir_all(dir);
}

// --- canvas-polish: centerpiece, text scale, homes ---------------------------

#[tokio::test]
async fn centerpiece_is_set_snapshotted_validated_and_cleared_by_deletion() {
    let (mut c, _app, dir) = signed_in().await;
    let b = c
        .json("POST", "/api/boards", json!({ "title": "Centre" }))
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let (n, g) = (
        uuid::Uuid::now_v7().to_string(),
        uuid::Uuid::now_v7().to_string(),
    );
    let set = |t: Value| json!({ "type": "board.centerpiece", "target": t });
    assert_eq!(
        post_ops(
            &mut c,
            &b,
            vec![
                create(&n, json!({ "kind": "note", "source": "x" })),
                json!({ "type": "group.create", "groupId": g, "memberIds": [n] }),
                set(json!(format!("group:{g}")))
            ]
        )
        .await
        .status,
        StatusCode::OK
    );
    let snap = c.get(&format!("/api/boards/{b}/snapshot")).await.json();
    assert_eq!(snap["centerpiece"], json!(format!("group:{g}")));
    assert_eq!(
        post_ops(&mut c, &b, vec![set(json!("item:nope"))])
            .await
            .status,
        StatusCode::BAD_REQUEST,
        "must be on the board"
    );
    assert_eq!(
        post_ops(&mut c, &b, vec![set(json!("n1"))]).await.status,
        StatusCode::BAD_REQUEST,
        "must say item: or group:"
    );
    assert_eq!(
        post_ops(&mut c, &b, vec![set(json!(format!("item:{n}")))])
            .await
            .status,
        StatusCode::OK
    );
    assert_eq!(
        post_ops(
            &mut c,
            &b,
            vec![json!({ "type": "item.delete", "itemId": n })]
        )
        .await
        .status,
        StatusCode::OK
    );
    let snap = c.get(&format!("/api/boards/{b}/snapshot")).await.json();
    assert_eq!(
        snap["centerpiece"],
        Value::Null,
        "a deleted centerpiece leaves none"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn text_scale_rides_on_create_and_transform_and_is_bounded() {
    let (mut c, _app, dir) = signed_in().await;
    let b = c
        .json("POST", "/api/boards", json!({ "title": "Scale" }))
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let n = uuid::Uuid::now_v7().to_string();
    let mut make = create(&n, json!({ "kind": "note", "source": "x" }));
    make["textScale"] = json!(2.0);
    assert_eq!(
        post_ops(&mut c, &b, vec![make]).await.status,
        StatusCode::OK
    );
    let scale = |snap: &Value| snap["items"][0]["textScale"].clone();
    assert_eq!(
        scale(&c.get(&format!("/api/boards/{b}/snapshot")).await.json()),
        json!(2.0)
    );
    let tf = |s: Value| json!({ "type": "item.transform", "itemId": n, "transform": { "x": 0.0, "y": 0.0, "width": 640.0, "height": 240.0, "rotation": 0.0 }, "textScale": s });
    assert_eq!(
        post_ops(&mut c, &b, vec![tf(json!(9.0))]).await.status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        post_ops(&mut c, &b, vec![tf(json!(1.0))]).await.status,
        StatusCode::OK
    );
    assert_eq!(
        scale(&c.get(&format!("/api/boards/{b}/snapshot")).await.json()),
        Value::Null,
        "1 is the default, stored as none"
    );
    let copy = c
        .json("POST", &format!("/api/boards/{b}/duplicate"), json!(null))
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        c.get(&format!("/api/boards/{copy}/snapshot")).await.status,
        StatusCode::OK
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_pushed_item_keeps_its_home_and_returns_when_the_pusher_shrinks() {
    let (mut c, app, dir) = signed_in().await;
    let b = c
        .json("POST", "/api/boards", json!({ "title": "Home" }))
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let (big, note) = (
        uuid::Uuid::now_v7().to_string(),
        uuid::Uuid::now_v7().to_string(),
    );
    let at = |id: &str, y: f64, h: f64| {
        json!({ "type": "item.create", "itemId": id, "z": 1.0, "collides": true,
        "transform": { "x": 0.0, "y": y, "width": 200.0, "height": h, "rotation": 0.0 }, "content": { "kind": "note", "source": "x" } })
    };
    let size = |h: f64| {
        json!({ "type": "item.transform", "itemId": big,
        "transform": { "x": 0.0, "y": h / 2.0, "width": 200.0, "height": h, "rotation": 0.0 } })
    };
    assert_eq!(
        post_ops(
            &mut c,
            &b,
            vec![at(&big, 50.0, 100.0), at(&note, 200.0, 100.0)]
        )
        .await
        .status,
        StatusCode::OK
    );
    let pos = |app: &visarium::AppState, id: String| {
        let db = app.db.clone();
        async move {
            sqlx::query_as::<_, (f64, f64, Option<f64>, Option<f64>)>(
                "SELECT x, y, home_x, home_y FROM canvas_item WHERE id = ?",
            )
            .bind(id)
            .fetch_one(&db)
            .await
            .unwrap()
        }
    };
    // The pusher grows to its drawn height: the note is pushed, its home kept.
    assert_eq!(
        post_ops(&mut c, &b, vec![size(400.0)]).await.status,
        StatusCode::OK
    );
    let (x, y, hx, hy) = pos(&app, note.clone()).await;
    assert!(
        (x, y) != (0.0, 200.0) && (hx, hy) == (Some(0.0), Some(200.0)),
        "pushed to {x},{y}, home {hx:?},{hy:?}"
    );
    // It shrinks again: the note comes home, and is at home.
    assert_eq!(
        post_ops(&mut c, &b, vec![size(100.0)]).await.status,
        StatusCode::OK
    );
    assert_eq!(pos(&app, note.clone()).await, (0.0, 200.0, None, None));
    // Pushed again, then dragged on purpose: the drag is its new home.
    assert_eq!(
        post_ops(&mut c, &b, vec![size(400.0)]).await.status,
        StatusCode::OK
    );
    let drag = json!({ "type": "item.transform", "itemId": note, "transform": { "x": 600.0, "y": 0.0, "width": 200.0, "height": 100.0, "rotation": 0.0 } });
    assert_eq!(
        post_ops(&mut c, &b, vec![drag]).await.status,
        StatusCode::OK
    );
    assert_eq!(pos(&app, note.clone()).await, (600.0, 0.0, None, None));
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn an_agent_built_column_comes_back_together_after_heights_are_corrected() {
    // The opengrok board: an agent stacks items at estimated sizes, a browser
    // corrects the first diagram's height (taller), then a later edit shrinks it.
    let (mut c, app, dir) = signed_in().await;
    let b = c
        .json("POST", "/api/boards", json!({ "title": "Replay" }))
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let ids: Vec<String> = (0..4).map(|_| uuid::Uuid::now_v7().to_string()).collect();
    let create = |id: &str, y: f64| {
        json!({ "type": "item.create", "itemId": id, "z": 1.0, "collides": true,
        "transform": { "x": 0.0, "y": y, "width": 480.0, "height": 360.0, "rotation": 0.0 },
        "content": { "kind": "diagram", "lang": "mermaid", "source": "flowchart LR\n A-->B" } })
    };
    let ops: Vec<Value> = ids
        .iter()
        .enumerate()
        .map(|(n, id)| create(id, n as f64 * 408.0))
        .collect();
    assert_eq!(post_ops(&mut c, &b, ops).await.status, StatusCode::OK);
    let at = |h: f64| {
        json!({ "type": "item.transform", "itemId": ids[0],
        "transform": { "x": 0.0, "y": h / 2.0 - 180.0, "width": 480.0, "height": h, "rotation": 0.0 } })
    };
    assert_eq!(
        post_ops(&mut c, &b, vec![at(1400.0)]).await.status,
        StatusCode::OK
    );
    let rows = |app: &visarium::AppState| {
        let db = app.db.clone();
        async move {
            sqlx::query_as::<_, (String, f64, f64)>("SELECT id, x, y FROM canvas_item")
                .fetch_all(&db)
                .await
                .unwrap()
        }
    };
    let pushed = rows(&app).await;
    assert!(
        pushed
            .iter()
            .any(|(id, x, y)| *id != ids[0] && (*x, *y) != (0.0, 0.0)),
        "the column was pushed: {pushed:?}"
    );
    assert_eq!(
        post_ops(&mut c, &b, vec![at(360.0)]).await.status,
        StatusCode::OK
    );
    for (id, x, y) in rows(&app).await {
        let n = ids.iter().position(|i| *i == id).unwrap() as f64;
        assert!(
            (x).abs() <= 24.0 && (y - n * 408.0).abs() <= 24.0,
            "{id} at ({x}, {y}), home (0, {})",
            n * 408.0
        );
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_note_reports_its_passages_and_links_to_them() {
    let (mut c, app, dir) = signed_in().await;
    let b = c
        .json("POST", "/api/boards", json!({ "title": "Passages" }))
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let (n, d, list) = (
        uuid::Uuid::now_v7().to_string(),
        uuid::Uuid::now_v7().to_string(),
        uuid::Uuid::now_v7().to_string(),
    );
    assert_eq!(
        post_ops(&mut c, &b, vec![
            create(&n, json!({ "kind": "note", "source": "# Title\n\nFirst. ^a\n\nSecond. ^b" })),
            create(&d, json!({ "kind": "diagram", "lang": "mermaid", "source": "flowchart LR\n  A --> B" })),
            create(&list, json!({ "kind": "checklist", "title": "T", "tasks": [] })),
        ]).await.status,
        StatusCode::OK
    );
    let report = json!({ "revision": 0, "width": 320.0, "elements": { "^a": [0.0, 40.0, 320.0, 20.0], "^b": [0.0, 70.0, 320.0, 20.0] } });
    assert_eq!(
        c.json(
            "PUT",
            &format!("/api/boards/{b}/items/{n}/elements"),
            report.clone()
        )
        .await
        .status,
        StatusCode::NO_CONTENT
    );
    let rev: Option<i64> = sqlx::query_scalar("SELECT element_rev FROM canvas_item WHERE id = ?")
        .bind(&n)
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert_eq!(
        rev,
        Some(0),
        "a note's passages are stored like a diagram's elements"
    );
    assert_eq!(
        c.json(
            "PUT",
            &format!("/api/boards/{b}/items/{list}/elements"),
            report
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
    let link = |el: &str| json!({ "type": "link.add", "linkId": uuid::Uuid::now_v7(), "from": { "itemId": n, "element": el }, "to": { "itemId": d, "element": "A" }, "linkType": "describes" });
    assert_eq!(
        post_ops(&mut c, &b, vec![link("^a"), link("^b")])
            .await
            .status,
        StatusCode::OK
    );
    let snap = c.get(&format!("/api/boards/{b}/snapshot")).await.json();
    let mut froms: Vec<String> = snap["links"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["from"]["element"].as_str().unwrap().to_string())
        .collect();
    froms.sort();
    assert_eq!(froms, vec!["^a", "^b"]);
    let _ = std::fs::remove_dir_all(dir);
}

// --- roles and Instance Settings (instance-administration) ------------------

/// Joins through a fresh invitation from `staff`, signed in on a new client.
async fn join(staff: &mut Client, body: Value, username: &str) -> (Client, String) {
    let token = invite(staff, body).await;
    let mut c = Client::new(staff.router.clone());
    c.get("/api/session").await;
    let joined = c
        .json(
            "POST",
            "/api/invitations/redeem",
            json!({ "token": token, "username": username, "displayName": username, "password": "a long enough password" }),
        )
        .await;
    assert_eq!(joined.status, StatusCode::CREATED, "{}", joined.json());
    let id = joined.json()["id"].as_str().unwrap().to_string();
    (c, id)
}

/// A member socket rechecks its session: a revoked session or a deactivated
/// account closes it within the recheck interval.
#[tokio::test]
async fn member_sockets_end_with_their_session() {
    visarium::realtime::MEMBER_RECHECK_SECS.store(1, std::sync::atomic::Ordering::Relaxed);
    let (mut admin, app, dir) = signed_in().await;
    let b = admin
        .json("POST", "/api/boards", json!({ "title": "Live" }))
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let (member, member_id) = join(&mut admin, json!({}), "bo").await;
    let mut second = Client::new(admin.router.clone());
    second.get("/api/session").await;
    let signed = second
        .json(
            "POST",
            "/api/session",
            json!({ "username": "ada", "password": "correct horse battery" }),
        )
        .await;
    assert_eq!(signed.status, StatusCode::OK);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(visarium::serve(app, listener));
    let socket = |cookies: String| {
        let mut req = format!("ws://{addr}/ws/canvas/{b}")
            .into_client_request()
            .unwrap();
        req.headers_mut().insert("cookie", cookies.parse().unwrap());
        req.headers_mut()
            .insert("origin", format!("http://{addr}").parse().unwrap());
        tokio_tungstenite::connect_async(req)
    };
    async fn closed(
        ws: &mut (impl StreamExt<Item = Result<tungstenite::Message, tungstenite::Error>> + Unpin),
    ) -> Option<u16> {
        loop {
            match tokio::time::timeout(std::time::Duration::from_secs(5), ws.next())
                .await
                .expect("closed in time")
            {
                Some(Ok(tungstenite::Message::Close(f))) => return f.map(|f| u16::from(f.code)),
                Some(Ok(_)) => continue,
                _ => return None,
            }
        }
    }
    let hello =
        json!({ "t": "hello", "protocolVersion": visarium::PROTOCOL_VERSION, "sinceRevision": 0 })
            .to_string();

    // Revoked from another browser.
    let (mut ws, _) = socket(second.cookie_header()).await.unwrap();
    ws.send(hello.clone().into()).await.unwrap();
    let sessions = admin.get("/api/sessions").await.json();
    let other = sessions
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["current"] == false)
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let revoked = admin
        .send(
            "DELETE",
            &format!("/api/sessions/{other}"),
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(revoked.status, StatusCode::NO_CONTENT);
    assert_eq!(closed(&mut ws).await, Some(1008));

    // Deactivated by an admin.
    let (mut ws, _) = socket(member.cookie_header()).await.unwrap();
    ws.send(hello.into()).await.unwrap();
    let off = admin
        .send(
            "POST",
            &format!("/api/accounts/{member_id}/deactivation"),
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(off.status, StatusCode::OK);
    assert_eq!(closed(&mut ws).await, Some(1008));
    let _ = std::fs::remove_dir_all(dir);
}

/// Links carry the authority their issuer has when they are redeemed, and a
/// request that cannot succeed is refused before any password is hashed.
#[tokio::test]
async fn links_recheck_their_issuers_authority_when_redeemed() {
    let (mut admin, app, dir) = signed_in().await;
    let (mut mo, mo_id) = join(&mut admin, json!({ "role": "moderator" }), "mo").await;
    let (_bob, bob_id) = join(&mut mo, json!({}), "bob").await;
    let mut anon = Client::new(admin.router.clone());
    anon.get("/api/session").await;
    let redeem_reset =
        |token: String| json!({ "token": token, "password": "a brand new password" });

    // Refused before hashing: a claimed instance, an unknown token.
    let again = anon
        .json(
            "POST",
            "/api/setup",
            json!({ "username": "eve", "displayName": "Eve", "password": "correct horse battery" }),
        )
        .await;
    assert_eq!(again.status, StatusCode::CONFLICT);
    let unknown = anon
        .json(
            "POST",
            "/api/invitations/redeem",
            json!({ "token": "nope", "username": "cy", "displayName": "Cy", "password": "a long enough password" }),
        )
        .await;
    assert_eq!(unknown.status, StatusCode::GONE);

    // An ordinary reset works once, and only once.
    let reset = |id: &str| json!({ "purpose": "reset", "userId": id });
    let token = invite(&mut mo, reset(&bob_id)).await;
    let used = anon
        .json(
            "POST",
            "/api/invitations/redeem",
            redeem_reset(token.clone()),
        )
        .await;
    assert_eq!(used.status, StatusCode::NO_CONTENT, "{}", used.json());
    let twice = anon
        .json("POST", "/api/invitations/redeem", redeem_reset(token))
        .await;
    assert_eq!(twice.status, StatusCode::GONE);

    // Target promoted after the moderator made the link: refused. The admin's
    // role change also removed it from the list.
    let token = invite(&mut mo, reset(&bob_id)).await;
    let promoted = admin
        .json(
            "PUT",
            &format!("/api/accounts/{bob_id}/role"),
            json!({ "role": "admin" }),
        )
        .await;
    assert_eq!(promoted.status, StatusCode::OK);
    let refused = anon
        .json("POST", "/api/invitations/redeem", redeem_reset(token))
        .await;
    assert_eq!(refused.status, StatusCode::GONE);
    assert_eq!(
        count(
            &app,
            "SELECT count(*) FROM invitation WHERE purpose = 'reset' AND used_at IS NULL"
        )
        .await,
        0
    );
    let verified = anon
        .json(
            "POST",
            "/api/session",
            json!({ "username": "bob", "password": "a brand new password" }),
        )
        .await;
    assert_eq!(
        verified.status,
        StatusCode::OK,
        "the earlier reset's password still stands"
    );

    // The promotion only voided the link; with the target back to member it
    // still does not come back.
    admin
        .json(
            "PUT",
            &format!("/api/accounts/{bob_id}/role"),
            json!({ "role": "member" }),
        )
        .await;

    // A join link from an issuer since deactivated: refused.
    let token = invite(&mut mo, json!({})).await;
    let off = admin
        .send(
            "POST",
            &format!("/api/accounts/{mo_id}/deactivation"),
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(off.status, StatusCode::OK);
    let join_body = |token: String| json!({ "token": token, "username": "cy", "displayName": "Cy", "password": "a long enough password" });
    let refused = anon
        .json("POST", "/api/invitations/redeem", join_body(token))
        .await;
    assert_eq!(refused.status, StatusCode::GONE);

    // A join link for an admin, from an admin since demoted: refused.
    let (mut second_admin, second_id) = join(&mut admin, json!({ "role": "admin" }), "al").await;
    let token = invite(&mut second_admin, json!({ "role": "admin" })).await;
    let demoted = admin
        .json(
            "PUT",
            &format!("/api/accounts/{second_id}/role"),
            json!({ "role": "member" }),
        )
        .await;
    assert_eq!(demoted.status, StatusCode::OK);
    let refused = anon
        .json("POST", "/api/invitations/redeem", join_body(token))
        .await;
    assert_eq!(refused.status, StatusCode::GONE);

    // An ordinary join still works.
    let token = invite(&mut admin, json!({})).await;
    let ok = anon
        .json("POST", "/api/invitations/redeem", join_body(token))
        .await;
    assert_eq!(ok.status, StatusCode::CREATED, "{}", ok.json());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn moderators_run_members_but_not_staff_or_setup() {
    let (mut admin, _app, dir) = signed_in().await;
    let ada = admin.get("/api/session").await.json()["user"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let (mut mo, mo_id) = join(&mut admin, json!({ "role": "moderator" }), "mo").await;
    let me = mo.get("/api/session").await.json()["user"].clone();
    assert_eq!(
        (me["role"].as_str(), me["admin"].as_bool()),
        (Some("moderator"), Some(false))
    );
    let (mut bob, bob_id) = join(&mut mo, json!({}), "bob").await;
    assert_eq!(
        bob.get("/api/session").await.json()["user"]["role"],
        "member"
    );

    // Moderators invite members only.
    let up = mo
        .json("POST", "/api/invitations", json!({ "role": "moderator" }))
        .await;
    assert_eq!(up.status, StatusCode::FORBIDDEN);
    assert_eq!(mo.get("/api/accounts").await.status, StatusCode::OK);
    assert_eq!(bob.get("/api/accounts").await.status, StatusCode::FORBIDDEN);

    // Resets and deactivation: members yes, staff no.
    let reset = |id: &str| json!({ "purpose": "reset", "userId": id });
    assert_eq!(
        mo.json("POST", "/api/invitations", reset(&bob_id))
            .await
            .status,
        StatusCode::CREATED
    );
    assert_eq!(
        mo.json("POST", "/api/invitations", reset(&ada))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    let off = mo
        .json(
            "POST",
            &format!("/api/accounts/{bob_id}/deactivation"),
            json!(null),
        )
        .await;
    assert_eq!(off.status, StatusCode::OK, "{}", off.json());
    assert_eq!(
        bob.get("/api/boards").await.status,
        StatusCode::UNAUTHORIZED,
        "sessions ended"
    );
    let back = mo
        .json(
            "DELETE",
            &format!("/api/accounts/{bob_id}/deactivation"),
            json!(null),
        )
        .await;
    assert_eq!(
        (back.status, back.json()["deactivatedAt"].is_null()),
        (StatusCode::OK, true)
    );
    assert_eq!(
        mo.json(
            "POST",
            &format!("/api/accounts/{ada}/deactivation"),
            json!(null)
        )
        .await
        .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        mo.json(
            "POST",
            &format!("/api/accounts/{mo_id}/deactivation"),
            json!(null)
        )
        .await
        .status,
        StatusCode::FORBIDDEN,
        "moderators do not act on moderators, themselves included"
    );

    // Content: any board, every share link.
    let board = admin
        .json("POST", "/api/boards", json!({ "title": "Ada's" }))
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(mo.get("/api/shares").await.status, StatusCode::OK);
    assert_eq!(
        mo.send("DELETE", &format!("/api/boards/{board}"), None, vec![], &[])
            .await
            .status,
        StatusCode::NO_CONTENT
    );

    // Setup is admin-only: roles and providers.
    let promote = |role: &str| json!({ "role": role });
    assert_eq!(
        mo.json(
            "PUT",
            &format!("/api/accounts/{bob_id}/role"),
            promote("moderator")
        )
        .await
        .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        mo.get("/api/instance/providers").await.status,
        StatusCode::FORBIDDEN
    );
    let made = admin
        .json(
            "PUT",
            &format!("/api/accounts/{bob_id}/role"),
            promote("moderator"),
        )
        .await;
    assert_eq!(made.json()["role"], "moderator");
    assert_eq!(
        mo.json(
            "POST",
            &format!("/api/accounts/{bob_id}/deactivation"),
            json!(null)
        )
        .await
        .status,
        StatusCode::FORBIDDEN,
        "bob is a moderator now"
    );
    let last = admin
        .json(
            "PUT",
            &format!("/api/accounts/{ada}/role"),
            promote("moderator"),
        )
        .await;
    assert_eq!(
        last.status,
        StatusCode::CONFLICT,
        "the last admin stays an admin"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn providers_are_set_up_in_the_app() {
    let issuer = Issuer::start().await;
    let (app, dir) = with_provider(&issuer, |_| {}).await;
    let mut admin = Client::new(visarium::router(app.clone()));
    admin.get("/api/session").await;
    admin
        .json(
            "POST",
            "/api/setup",
            json!({ "username": "ada", "displayName": "Ada", "password": "correct horse battery" }),
        )
        .await;

    // The environment's provider is listed, read-only.
    let list = admin.get("/api/instance/providers").await.json();
    assert_eq!(
        (
            list["providers"][0]["id"].as_str(),
            list["providers"][0]["fromEnv"].as_bool()
        ),
        (Some("test"), Some(true))
    );
    let env = admin
        .json(
            "PUT",
            "/api/instance/providers/test",
            json!({ "clientId": "x", "clientSecret": "y" }),
        )
        .await;
    assert_eq!(env.status, StatusCode::CONFLICT);

    // A bad issuer is refused before anything is saved.
    let bad = admin
        .json(
            "PUT",
            "/api/instance/providers/second",
            json!({ "issuer": "http://127.0.0.1:1", "clientId": "x", "clientSecret": "y" }),
        )
        .await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST, "{}", bad.json());

    // Added, offered at once, secret never returned.
    let body = json!({ "name": "Second", "issuer": issuer.url, "clientId": issuer::CLIENT_ID, "clientSecret": issuer::CLIENT_SECRET });
    let saved = admin
        .json("PUT", "/api/instance/providers/second", body)
        .await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.json());
    assert_eq!(
        saved.json()["redirectUri"],
        "http://localhost:8080/auth/oidc/second/callback"
    );
    let session = admin.get("/api/session").await.json();
    assert_eq!(
        session["providers"][1],
        json!({ "id": "second", "name": "Second" })
    );
    let listed = admin.get("/api/instance/providers").await;
    assert!(!String::from_utf8_lossy(&listed.body).contains(issuer::CLIENT_SECRET));
    assert_eq!(listed.json()["providers"][1]["hasSecret"], true);

    // Renamed without a secret: it still signs in, and links Ada.
    let renamed = admin
        .json(
            "PUT",
            "/api/instance/providers/second",
            json!({ "name": "Second SSO" }),
        )
        .await;
    assert_eq!(renamed.status, StatusCode::OK, "{}", renamed.json());
    let linked = sso(
        &mut admin,
        &issuer,
        "/auth/oidc/second/start?intent=link&return=/settings",
        Person::new("ada-second", "ada@example.com"),
    )
    .await;
    assert_eq!(location(&linked), "/settings");

    // Removal asks first, with counts; Ada keeps her password, so none stranded.
    let ask = admin
        .send(
            "DELETE",
            "/api/instance/providers/second",
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(
        (
            ask.status,
            ask.json()["linkedAccounts"].as_i64(),
            ask.json()["strandedAccounts"].as_i64()
        ),
        (StatusCode::CONFLICT, Some(1), Some(0))
    );

    // A sign-in that left before the provider went fails on its way back.
    let mut other = Client::new(visarium::router(app.clone()));
    other.get("/api/session").await;
    let callback = to_callback(
        &mut other,
        &issuer,
        "/auth/oidc/second/start?intent=sign-in&return=/",
        Person::new("ada-second", "ada@example.com"),
    )
    .await;
    let gone = admin
        .send(
            "DELETE",
            "/api/instance/providers/second?confirm=true",
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(gone.status, StatusCode::NO_CONTENT);
    assert_eq!(
        location(&other.get(&callback).await),
        "/sign-in?error=provider-gone"
    );
    assert_eq!(
        admin.get("/api/session").await.json()["providers"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let _ = std::fs::remove_dir_all(dir);
}

/// Password sign-in is opt-in on the server: with no provider either, the
/// binary refuses to start and says what to set and why.
#[test]
fn the_server_will_not_start_with_no_way_to_sign_in() {
    let dir = std::env::temp_dir().join(format!("visarium-noway-{}", uuid::Uuid::new_v4()));
    let run = |extra: &[(&str, &str)]| {
        let mut cmd = std::process::Command::new(env!("CARGO_BIN_EXE_visarium"));
        cmd.env_clear()
            .env("VISARIUM_DATABASE", dir.join("visarium.db"))
            .env("VISARIUM_ASSETS_PATH", dir.join("assets"))
            .env("VISARIUM_DERIVATIVES_PATH", dir.join("derivatives"))
            .env("VISARIUM_BIND", "127.0.0.1")
            .env("VISARIUM_PORT", "0")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        for (k, v) in extra {
            cmd.env(k, v);
        }
        cmd.spawn().unwrap()
    };

    let refused = run(&[]).wait_with_output().unwrap();
    assert_eq!(refused.status.code(), Some(1));
    let said = String::from_utf8_lossy(&refused.stderr);
    assert!(
        said.contains("Visarium did not start: nobody could sign in."),
        "{said}"
    );
    assert!(
        said.contains("VISARIUM_AUTH_PASSWORD=on") && said.contains("Instance Settings > Sign-in")
    );
    assert!(
        !said.contains("\\n"),
        "plain lines, not a quoted string: {said}"
    );

    // Asking for password sign-in, it starts.
    let mut started = run(&[("VISARIUM_AUTH_PASSWORD", "on")]);
    std::thread::sleep(std::time::Duration::from_secs(2));
    assert!(started.try_wait().unwrap().is_none(), "still running");
    started.kill().unwrap();
    let _ = started.wait();
    let _ = std::fs::remove_dir_all(&dir);
}

/// A provider alone is a way in: password sign-in off, still starts.
#[tokio::test]
async fn a_provider_alone_is_a_way_in() {
    let issuer = Issuer::start().await;
    let (app, dir) = with_provider(&issuer, |c| c.password_disabled = true).await;
    let mut c = Client::new(visarium::router(app));
    let session = c.get("/api/session").await.json();
    assert_eq!(session["passwordEnabled"], false);
    assert_eq!(session["providers"][0]["id"], "test");
    let _ = std::fs::remove_dir_all(dir);
}

/// Files under `assets/` that are stored originals (not spool temps).
fn stored_originals(dir: &std::path::Path) -> usize {
    fn walk(p: &std::path::Path, n: &mut usize) {
        for e in std::fs::read_dir(p).into_iter().flatten().flatten() {
            let path = e.path();
            if path.is_dir() {
                walk(&path, n);
            } else if !path.file_name().unwrap().to_string_lossy().starts_with('.') {
                *n += 1;
            }
        }
    }
    let mut n = 0;
    walk(&dir.join("assets"), &mut n);
    n
}

/// A BMP header claiming `width`×`height` and carrying no pixels: what a
/// decompression bomb looks like to anything that trusts the header.
fn bmp_header(width: i32, height: i32) -> Vec<u8> {
    let mut b = Vec::new();
    b.extend_from_slice(b"BM");
    b.extend_from_slice(&54u32.to_le_bytes()); // file size, as claimed
    b.extend_from_slice(&0u32.to_le_bytes());
    b.extend_from_slice(&54u32.to_le_bytes()); // pixels start here
    b.extend_from_slice(&40u32.to_le_bytes()); // BITMAPINFOHEADER
    b.extend_from_slice(&width.to_le_bytes());
    b.extend_from_slice(&height.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&24u16.to_le_bytes());
    b.extend_from_slice(&[0; 24]);
    b
}

#[tokio::test]
async fn an_image_too_large_to_decode_is_refused_before_it_is_stored() {
    let (mut c, app, dir) = signed_in().await;
    // 400 megapixels in 54 bytes.
    let r = c.upload("bomb.bmp", &bmp_header(20_000, 20_000)).await;
    assert_eq!(r.status, StatusCode::PAYLOAD_TOO_LARGE, "{}", r.json());
    let detail = r.json()["detail"].as_str().unwrap().to_string();
    assert!(
        detail.contains("20,000 × 20,000 (400 megapixels)") && detail.contains("200 megapixels"),
        "{detail}"
    );
    assert_eq!(count(&app, "SELECT count(*) FROM asset").await, 0);
    assert_eq!(stored_originals(&dir), 0);
}

#[tokio::test]
async fn an_image_that_cannot_be_drawn_is_refused_not_kept() {
    let (mut c, app, dir) = signed_in().await;
    // A real header, then the pixels stop half-way.
    let whole = png(600, 600, 7);
    let r = c.upload("cut.png", &whole[..whole.len() / 2]).await;
    assert_eq!(r.status, StatusCode::UNSUPPORTED_MEDIA_TYPE, "{}", r.json());
    assert!(
        r.json()["detail"]
            .as_str()
            .unwrap()
            .contains("could not be drawn")
    );
    assert_eq!(count(&app, "SELECT count(*) FROM asset").await, 0);
    assert_eq!(stored_originals(&dir), 0);
}

#[tokio::test]
async fn a_full_page_screenshot_gets_tiers_webp_can_encode() {
    let (mut c, _app, _dir) = signed_in().await;
    // At 512 wide this would be 17,067 tall, past WebP's 16,383.
    let tall = image::GrayImage::from_fn(600, 20_000, |_, y| image::Luma([(y % 251) as u8]));
    let mut bytes = std::io::Cursor::new(Vec::new());
    tall.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
    let r = c.upload("page.png", bytes.get_ref()).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.json());
    let id = r.json()["id"].as_str().unwrap().to_string();
    for width in [512, 256, 64] {
        let tier = c
            .get(&format!("/api/assets/{id}/derivatives/{width}"))
            .await;
        assert_eq!(tier.status, StatusCode::OK, "{width}: {}", tier.json());
        let img = image::load_from_memory(&tier.body).unwrap();
        assert!(
            img.height() <= 16_383 && img.width() <= width,
            "{width}: {}x{}",
            img.width(),
            img.height()
        );
    }
}

#[tokio::test]
async fn the_storage_limit_is_shown_set_and_enforced() {
    let (mut c, app, _dir) = signed_in().await;
    let shown = c.get("/api/instance/storage").await;
    assert_eq!(shown.status, StatusCode::OK, "{}", shown.json());
    assert_eq!(shown.json()["usedBytes"], 0);
    assert_eq!(shown.json()["limitBytes"], Value::Null);
    #[cfg(unix)]
    assert!(shown.json()["diskFreeBytes"].as_u64().unwrap() > 0);

    let tiny = c
        .json(
            "PUT",
            "/api/instance/storage",
            json!({ "limitBytes": 5_000_000 }),
        )
        .await;
    assert_eq!(tiny.status, StatusCode::BAD_REQUEST);
    let set = c
        .json(
            "PUT",
            "/api/instance/storage",
            json!({ "limitBytes": 100_000_000 }),
        )
        .await;
    assert_eq!(set.status, StatusCode::OK, "{}", set.json());
    assert_eq!(set.json()["limitBytes"], 100_000_000);

    // Pretend the library already holds 150 MB, 50 MB of it in the trash.
    for (n, deleted) in [(1, false), (2, true)] {
        sqlx::query(
            "INSERT INTO asset (id, content_hash, storage_key, mime_type, byte_size, width, height, deleted_at)
             VALUES (?, ?, 'aa/bb/x.png', 'image/png', ?, 10, 10, CASE WHEN ? THEN '2026-01-01T00:00:00.000Z' END)",
        )
        .bind(uuid::Uuid::now_v7().to_string())
        .bind(format!("{n:064}"))
        .bind(if deleted { 50_000_000i64 } else { 100_000_000 })
        .bind(deleted)
        .execute(&app.db)
        .await
        .unwrap();
    }
    let refused = c.upload("one.png", &png(20, 20, 1)).await;
    assert_eq!(refused.status, StatusCode::INSUFFICIENT_STORAGE);
    let detail = refused.json()["detail"].as_str().unwrap().to_string();
    assert!(
        detail.contains("150 MB of 100 MB used, 50 MB of it in the trash"),
        "{detail}"
    );
    let shown = c.get("/api/instance/storage").await.json();
    assert_eq!(
        (shown["usedBytes"].as_u64(), shown["trashBytes"].as_u64()),
        (Some(150_000_000), Some(50_000_000))
    );

    let lifted = c
        .json(
            "PUT",
            "/api/instance/storage",
            json!({ "limitBytes": null }),
        )
        .await;
    assert_eq!(lifted.status, StatusCode::OK);
    assert_eq!(
        c.upload("one.png", &png(20, 20, 1)).await.status,
        StatusCode::CREATED
    );
}

/// agents/board-editing: people's edits are never guarded. A person changes an
/// accepted decision through the ordinary operation, with no confirmation.
#[tokio::test]
async fn a_person_changes_an_accepted_decision_without_being_asked() {
    let (mut c, _app, dir) = signed_in().await;
    let b = c
        .json("POST", "/api/boards", json!({ "title": "Decisions" }))
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let note = uuid::Uuid::now_v7().to_string();
    let made = post_ops(
        &mut c,
        &b,
        vec![create(
            &note,
            json!({ "kind": "note", "source": "# ADR-2\n\n**Status: Accepted** (2026-10-14)" }),
        )],
    )
    .await;
    assert_eq!(made.status, StatusCode::OK);
    let edit = post_ops(&mut c, &b, vec![json!({ "type": "item.source", "itemId": note, "source": "# ADR-2\n\n**Status: Superseded** (2026-10-14)" })]).await;
    assert_eq!(edit.status, StatusCode::OK, "{}", edit.json());
    let deleted = post_ops(
        &mut c,
        &b,
        vec![json!({ "type": "item.delete", "itemId": note })],
    )
    .await;
    assert_eq!(deleted.status, StatusCode::OK, "{}", deleted.json());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn items_offer_read_only_views() {
    let (mut c, _app, _dir) = signed_in().await;
    let b = c
        .json("POST", "/api/boards", json!({ "title": "Views" }))
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let (n, d, k) = (
        uuid::Uuid::now_v7().to_string(),
        uuid::Uuid::now_v7().to_string(),
        uuid::Uuid::now_v7().to_string(),
    );
    let note = "---\nage: 34\ncarValue: 18000\n---\n# Policy\n\n| Case | Premium |\n|---|---|\n| young | 1240 |\n| old | 980 |\n";
    let made = post_ops(
        &mut c,
        &b,
        vec![
            create(&n, json!({ "kind": "note", "source": note })),
            create(&d, json!({ "kind": "diagram", "lang": "mermaid", "source": "flowchart LR\n  A --> B" })),
            create(&k, json!({ "kind": "checklist", "title": "Regression", "tasks": [
                { "id": "t1", "text": "Young driver", "state": "done" },
                { "id": "t2", "text": "Old driver" } ] })),
        ],
    )
    .await;
    assert_eq!(made.status, StatusCode::OK, "{}", made.json());
    let url = |item: &str, view: &str| format!("/api/boards/{b}/items/{item}/views/{view}");

    let fm = c.get(&url(&n, "frontmatter")).await;
    assert_eq!(fm.status, StatusCode::OK, "{}", fm.json());
    assert_eq!(fm.json()["value"], json!({ "age": 34, "carValue": 18000 }));
    assert_eq!(fm.json()["ref"], "n1");
    let rev = fm.json()["revision"].clone();
    assert!(rev.as_i64().is_some());

    let tables = c.get(&url(&n, "tables")).await.json();
    assert_eq!(
        tables["value"][0]["rows"][1],
        json!({ "Case": "old", "Premium": "980" })
    );
    // Same revision, same view; reading changes nothing.
    let board_rev = c.get(&format!("/api/boards/{b}")).await.json()["revision"].clone();
    assert_eq!(c.get(&url(&n, "tables")).await.json(), tables);
    assert_eq!(
        c.get(&format!("/api/boards/{b}")).await.json()["revision"],
        board_rev
    );

    let graph = c.get(&url(&d, "graph")).await.json();
    assert_eq!(graph["value"]["elements"], json!(["A", "B"]));
    assert_eq!(graph["value"]["edges"][0]["from"], "A");
    assert_eq!(graph["value"]["edges"][0]["to"], "B");

    let tasks = c.get(&url(&k, "tasks")).await.json();
    assert_eq!(tasks["value"]["tasks"][0]["state"], "done");
    assert_eq!(tasks["value"]["tasks"][1]["state"], "todo");

    let wrong = c.get(&url(&n, "graph")).await;
    assert_eq!(wrong.status, StatusCode::BAD_REQUEST);
    let detail = wrong.json().to_string();
    assert!(
        detail.contains("text, markdown, frontmatter, tables"),
        "{detail}"
    );

    let missing = c.get(&url(&uuid::Uuid::now_v7().to_string(), "text")).await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);
    let no_board = c
        .get(&format!(
            "/api/boards/{}/items/{n}/views/text",
            uuid::Uuid::now_v7()
        ))
        .await;
    assert_eq!(no_board.status, StatusCode::NOT_FOUND);

    let mut stranger = Client::new(c.router.clone());
    assert_eq!(
        stranger.get(&url(&n, "text")).await.status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn migration_0014_keeps_every_item_and_link() {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePool};
    let (config, dir) = config(true);
    std::fs::create_dir_all(&dir).unwrap();
    // A database exactly as 0013 left it: every kind, a group, and links that
    // a careless rebuild of canvas_item would cascade away.
    let pool = SqlitePool::connect_with(
        SqliteConnectOptions::new()
            .filename(&config.database)
            .create_if_missing(true)
            .foreign_keys(true),
    )
    .await
    .unwrap();
    let mut before = sqlx::migrate!("./migrations");
    before.migrations = before
        .migrations
        .iter()
        .filter(|m| m.version < 14)
        .cloned()
        .collect::<Vec<_>>()
        .into();
    before.run(&pool).await.unwrap();
    for sql in [
        "INSERT INTO canvas (id, title) VALUES ('b1', 'Kinds')",
        "INSERT INTO asset (id, content_hash, storage_key, mime_type, byte_size, width, height) VALUES ('a1', 'h', 'k', 'image/png', 10, 600, 400)",
        "INSERT INTO canvas_group (id, canvas_id, label, ref_no) VALUES ('g1', 'b1', 'Sky', 1)",
        "INSERT INTO canvas_item (id, canvas_id, kind, asset_id, group_id, x, y, width, height, revision, ref_no, crop_x, crop_y, crop_w, crop_h)
         VALUES ('i1', 'b1', 'image', 'a1', 'g1', 1, 2, 300, 200, 7, 1, 0.25, 0, 0.5, 1)",
        "INSERT INTO canvas_item (id, canvas_id, kind, body, x, y, width, height, revision, ref_no, collides, text_scale, home_x, home_y)
         VALUES ('n1', 'b1', 'note', '# Policy', 0, 0, 200, 100, 3, 1, 1, 1.5, 4, 5)",
        "INSERT INTO canvas_item (id, canvas_id, kind, lang, body, x, y, width, height, ref_no, element_boxes, element_rev)
         VALUES ('d1', 'b1', 'diagram', 'mermaid', 'flowchart LR\n A --> B', 0, 0, 200, 100, 1, '{}', 2)",
        "INSERT INTO canvas_item (id, canvas_id, kind, body, x, y, width, height, ref_no)
         VALUES ('c1', 'b1', 'checklist', '{\"title\":\"T\",\"tasks\":[]}', 0, 0, 200, 100, 1)",
        "INSERT INTO canvas_link (id, canvas_id, from_item, to_item, to_element, link_type, created_by_agent)
         VALUES ('l1', 'b1', 'n1', 'd1', 'A', 'describes', 'Claude')",
        "INSERT INTO canvas_link (id, canvas_id, from_item, to_item, link_type) VALUES ('l2', 'b1', 'c1', 'd1', 'implements')",
    ] {
        sqlx::query(sql).execute(&pool).await.unwrap();
    }
    pool.close().await;

    let app = visarium::open(config).await.unwrap();
    type ItemCols = (String, String, i64, i64, Option<f64>, Option<f64>, i64);
    let items: Vec<ItemCols> = sqlx::query_as(
        "SELECT id, kind, revision, ref_no, text_scale, crop_x, content_rev FROM canvas_item ORDER BY id",
    )
    .fetch_all(&app.db)
    .await
    .unwrap();
    assert_eq!(
        items,
        vec![
            ("c1".into(), "checklist".into(), 0, 1, None, None, 0),
            ("d1".into(), "diagram".into(), 0, 1, None, None, 0),
            ("i1".into(), "image".into(), 7, 1, None, Some(0.25), 0),
            ("n1".into(), "note".into(), 3, 1, Some(1.5), None, 0),
        ]
    );
    let (collides, home_x, boxes, group): (bool, Option<f64>, Option<String>, Option<String>) =
        sqlx::query_as(
            "SELECT n.collides, n.home_x, d.element_boxes, i.group_id FROM canvas_item n, canvas_item d, canvas_item i
              WHERE n.id = 'n1' AND d.id = 'd1' AND i.id = 'i1'",
        )
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert_eq!(
        (collides, home_x, boxes.as_deref(), group.as_deref()),
        (true, Some(4.0), Some("{}"), Some("g1"))
    );
    type LinkCols = (
        String,
        String,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
    );
    let links: Vec<LinkCols> = sqlx::query_as(
        "SELECT id, from_item, to_element, link_type, created_by_agent, view FROM canvas_link ORDER BY id",
    )
    .fetch_all(&app.db)
    .await
    .unwrap();
    assert_eq!(
        links,
        vec![
            (
                "l1".into(),
                "n1".into(),
                Some("A".into()),
                "describes".into(),
                Some("Claude".into()),
                None
            ),
            (
                "l2".into(),
                "c1".into(),
                None,
                "implements".into(),
                None,
                None
            ),
        ]
    );
    // Deleting an item still cascades to its links: the new table kept the key.
    sqlx::query("DELETE FROM canvas_item WHERE id = 'c1'")
        .execute(&app.db)
        .await
        .unwrap();
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM canvas_link")
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert_eq!(left, 1);
    let fk: Vec<(String,)> = sqlx::query_as("SELECT \"table\" FROM pragma_foreign_key_check")
        .fetch_all(&app.db)
        .await
        .unwrap();
    assert!(fk.is_empty(), "{fk:?}");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn migration_0015_keeps_every_link_and_output() {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePool};
    let (config, dir) = config(true);
    std::fs::create_dir_all(&dir).unwrap();
    // A library as 0014 left it: an app fed by a note, with an output.
    let pool = SqlitePool::connect_with(
        SqliteConnectOptions::new()
            .filename(&config.database)
            .create_if_missing(true)
            .foreign_keys(true),
    )
    .await
    .unwrap();
    let mut before = sqlx::migrate!("./migrations");
    before.migrations = before
        .migrations
        .iter()
        .filter(|m| m.version < 15)
        .cloned()
        .collect::<Vec<_>>()
        .into();
    before.run(&pool).await.unwrap();
    for sql in [
        "INSERT INTO canvas (id, title) VALUES ('b1', 'Apps')",
        "INSERT INTO canvas_item (id, canvas_id, kind, body, x, y, width, height, ref_no, content_rev)
         VALUES ('n1', 'b1', 'note', '---\nage: 40\n---', 0, 0, 200, 100, 1, 3)",
        "INSERT INTO canvas_item (id, canvas_id, kind, body, x, y, width, height, ref_no)
         VALUES ('a1', 'b1', 'app', '{\"title\":\"Calc\",\"html\":\"<html></html>\"}', 0, 0, 200, 100, 1)",
        "INSERT INTO canvas_item (id, canvas_id, kind, body, x, y, width, height, ref_no)
         VALUES ('c1', 'b1', 'checklist', '{\"title\":\"T\",\"tasks\":[]}', 0, 0, 200, 100, 1)",
        "INSERT INTO canvas_link (id, canvas_id, from_item, to_item, link_type, view) VALUES ('l1', 'b1', 'n1', 'a1', 'feeds', 'frontmatter')",
        "INSERT INTO canvas_link (id, canvas_id, from_item, to_item, link_type) VALUES ('l2', 'b1', 'a1', 'c1', 'updates')",
        "INSERT INTO app_output (item_id, version, outputs, input_revs, status, run_at)
         VALUES ('a1', 1, '{\"premium\":1200}', '{\"n1\":3}', 'ok', '2026-11-26T10:00:00Z')",
    ] {
        sqlx::query(sql).execute(&pool).await.unwrap();
    }
    pool.close().await;

    let app = visarium::open(config).await.unwrap();
    type LinkCols = (
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let links: Vec<LinkCols> =
        sqlx::query_as("SELECT id, link_type, view, name, path FROM canvas_link ORDER BY id")
            .fetch_all(&app.db)
            .await
            .unwrap();
    assert_eq!(
        links,
        vec![
            (
                "l1".into(),
                "feeds".into(),
                Some("frontmatter".into()),
                None,
                None
            ),
            ("l2".into(), "updates".into(), None, None, None),
        ]
    );
    type OutCols = (i64, String, String, Option<String>, Option<String>);
    let out: OutCols = sqlx::query_as(
        "SELECT version, outputs, input_revs, card, cause FROM app_output WHERE item_id = 'a1'",
    )
    .fetch_one(&app.db)
    .await
    .unwrap();
    assert_eq!(
        out,
        (
            1,
            "{\"premium\":1200}".into(),
            "{\"n1\":3}".into(),
            None,
            None
        )
    );
    // Only a feeds link may carry a name or a path.
    for sql in [
        "UPDATE canvas_link SET name = 'x' WHERE id = 'l2'",
        "UPDATE canvas_link SET path = 'x' WHERE id = 'l2'",
        "UPDATE app_output SET cause = '[1]' WHERE item_id = 'a1'",
    ] {
        assert!(sqlx::query(sql).execute(&app.db).await.is_err(), "{sql}");
    }
    sqlx::query("UPDATE canvas_link SET name = 'age', path = 'age' WHERE id = 'l1'")
        .execute(&app.db)
        .await
        .unwrap();
    let _ = std::fs::remove_dir_all(dir);
}

fn link(id: &str, from: &str, to: &str, ty: &str, view: Option<&str>) -> Value {
    let mut l = json!({ "type": "link.add", "linkId": id, "from": { "itemId": from }, "to": { "itemId": to }, "linkType": ty });
    if let Some(v) = view {
        l["view"] = json!(v);
    }
    l
}

fn output(app: &str, outputs: Value, status: &str) -> Value {
    json!({ "type": "app.output", "itemId": app, "outputs": outputs, "status": status })
}

/// Posts `bodies` from a client socket that has `item` open and holds its run,
/// the only place an app's output commits from (canvas/apps).
async fn run_and_post(
    c: &mut Client,
    app: &visarium::AppState,
    b: &str,
    item: &str,
    bodies: Vec<Value>,
) -> Reply {
    let (board, id) = (
        uuid::Uuid::parse_str(b).unwrap(),
        uuid::Uuid::parse_str(item).unwrap(),
    );
    // A real socket: a run belongs to a connected client of the poster's own.
    let (_ws, socket) = live_socket(c, app, b).await;
    app.rooms.mount(&board, id, socket, true);
    let (revs, _) = visarium::apps::run_state(&app.db, &board, &id)
        .await
        .unwrap()
        .unwrap();
    // A fresh run each time: whatever an earlier, refused commit left is over.
    app.rooms.end_run(&board, id);
    app.rooms.request_run(&board, id, Some(socket), revs);
    post_ops_from(c, b, Some(socket), bodies).await
}

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// A board socket of `c`'s account, welcomed, and its actor id. The room knows
/// it only while the returned stream is held.
async fn live_socket(c: &Client, app: &visarium::AppState, b: &str) -> (Socket, uuid::Uuid) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(visarium::serve(app.clone(), listener));
    let mut req = format!("ws://{addr}/ws/canvas/{b}")
        .into_client_request()
        .unwrap();
    req.headers_mut()
        .insert("cookie", c.cookie_header().parse().unwrap());
    req.headers_mut()
        .insert("origin", format!("http://{addr}").parse().unwrap());
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    let hello =
        json!({ "t": "hello", "protocolVersion": visarium::PROTOCOL_VERSION, "sinceRevision": 0 });
    ws.send(hello.to_string().into()).await.unwrap();
    loop {
        if let tungstenite::Message::Text(t) = ws.next().await.unwrap().unwrap() {
            let f: Value = serde_json::from_str(&t).unwrap();
            if f["t"] == "welcome" {
                let id = uuid::Uuid::parse_str(f["actorId"].as_str().unwrap()).unwrap();
                return (ws, id);
            }
        }
    }
}

async fn post_ops_from(
    c: &mut Client,
    board: &str,
    socket: Option<uuid::Uuid>,
    bodies: Vec<Value>,
) -> Reply {
    let ops: Vec<Value> = bodies.into_iter().map(|b| json!({ "body": b })).collect();
    let actor = socket.map(|s| s.to_string()).unwrap_or_default();
    let headers: Vec<(&str, &str)> = if socket.is_some() {
        vec![("x-visarium-actor", actor.as_str())]
    } else {
        vec![]
    };
    c.send(
        "POST",
        &format!("/api/boards/{board}/operations"),
        Some("application/json"),
        json!({ "operations": ops }).to_string().into_bytes(),
        &headers,
    )
    .await
}

/// A board with a note n1 feeding app a1, a1 feeding app a2, and a2 allowed
/// to update checklist c1.
async fn app_board(c: &mut Client) -> (String, [String; 4]) {
    let b = c
        .json("POST", "/api/boards", json!({ "title": "Apps" }))
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let ids: [String; 4] = std::array::from_fn(|_| uuid::Uuid::now_v7().to_string());
    let [n, a1, a2, k] = ids.clone();
    let html = "<!doctype html><html><body>calc</body></html>";
    let r = post_ops(
        c,
        &b,
        vec![
            create(&n, json!({ "kind": "note", "source": "---\nage: 34\n---\n# Policy" })),
            create(&a1, json!({ "kind": "app", "title": "Premium", "html": html })),
            create(&a2, json!({ "kind": "app", "title": "Compare", "html": html })),
            create(&k, json!({ "kind": "checklist", "title": "Regression", "tasks": [{ "id": "t1", "text": "Young driver" }] })),
            link(&uuid::Uuid::now_v7().to_string(), &n, &a1, "feeds", Some("frontmatter")),
            link(&uuid::Uuid::now_v7().to_string(), &a1, &a2, "feeds", Some("outputs")),
            link(&uuid::Uuid::now_v7().to_string(), &a2, &k, "updates", None),
        ],
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json());
    (b, ids)
}

async fn snap(c: &mut Client, b: &str) -> Value {
    c.get(&format!("/api/boards/{b}/snapshot")).await.json()
}

fn item<'a>(s: &'a Value, id: &str) -> &'a Value {
    s["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["id"] == id)
        .unwrap()
}

#[tokio::test]
async fn data_links_grant_access_only_between_the_right_ends() {
    let (mut c, _app, _dir) = signed_in().await;
    let (b, [n, a1, a2, k]) = app_board(&mut c).await;
    let s = snap(&mut c, &b).await;
    assert_eq!(item(&s, &a1)["ref"], "a1");
    assert_eq!(item(&s, &a2)["ref"], "a2");
    assert_eq!(item(&s, &a1)["content"]["title"], "Premium");
    let feeds: Vec<&Value> = s["links"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|l| l["linkType"] == "feeds")
        .collect();
    assert_eq!(feeds[0]["view"], "frontmatter");

    let refused = |r: Reply, needle: &str| {
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.json());
        let d = r.json().to_string();
        assert!(d.contains(needle), "{needle} not in {d}");
    };
    let id = || uuid::Uuid::now_v7().to_string();
    // Wrong ends.
    refused(
        post_ops(&mut c, &b, vec![link(&id(), &n, &k, "feeds", Some("text"))]).await,
        "ends at an app",
    );
    refused(
        post_ops(&mut c, &b, vec![link(&id(), &n, &k, "updates", None)]).await,
        "from an app to a checklist",
    );
    refused(
        post_ops(&mut c, &b, vec![link(&id(), &n, &a1, "feeds", None)]).await,
        "needs the view",
    );
    refused(
        post_ops(
            &mut c,
            &b,
            vec![link(&id(), &n, &a1, "feeds", Some("graph"))],
        )
        .await,
        "Its views: text, markdown, frontmatter, tables.",
    );
    refused(
        post_ops(
            &mut c,
            &b,
            vec![link(&id(), &n, &k, "describes", Some("text"))],
        )
        .await,
        "only a feeds link carries a view",
    );
    // A cycle, named.
    refused(
        post_ops(
            &mut c,
            &b,
            vec![link(&id(), &a2, &a1, "feeds", Some("outputs"))],
        )
        .await,
        "a1 → a2 → a1",
    );
    // An app may not update what feeds it.
    refused(
        post_ops(
            &mut c,
            &b,
            vec![link(&id(), &k, &a2, "feeds", Some("tasks"))],
        )
        .await,
        "cannot also feed it",
    );
    // Semantic and data types never swap; a feeds view may change.
    let feed_id = feeds[0]["id"].as_str().unwrap().to_string();
    refused(
        post_ops(
            &mut c,
            &b,
            vec![json!({ "type": "link.set", "linkId": feed_id, "linkType": "describes" })],
        )
        .await,
        "cannot become a describes link",
    );
    let ok = post_ops(
        &mut c,
        &b,
        vec![
            json!({ "type": "link.set", "linkId": feed_id, "linkType": "feeds", "view": "tables" }),
        ],
    )
    .await;
    assert_eq!(ok.status, StatusCode::OK, "{}", ok.json());
    let s = snap(&mut c, &b).await;
    assert!(
        s["links"]
            .as_array()
            .unwrap()
            .iter()
            .any(|l| l["id"] == feed_id.as_str() && l["view"] == "tables")
    );
    // Semantic links still work between anything, apps included.
    let ok = post_ops(&mut c, &b, vec![link(&id(), &n, &a1, "describes", None)]).await;
    assert_eq!(ok.status, StatusCode::OK, "{}", ok.json());
}

#[tokio::test]
async fn outputs_are_versioned_and_staleness_is_derived() {
    let (mut c, app, _dir) = signed_in().await;
    let (b, [n, a1, a2, _k]) = app_board(&mut c).await;
    let s = snap(&mut c, &b).await;
    assert_eq!(item(&s, &a1)["appState"]["state"], "never run");
    assert_eq!(item(&s, &a1)["output"], Value::Null);

    let r = run_and_post(
        &mut c,
        &app,
        &b,
        &a1,
        vec![output(&a1, json!({ "premium": 1240 }), "ok")],
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json());
    // The applied op carries what was stored, for the author and every peer.
    let record = &r.json()["operations"][0]["record"];
    assert_eq!(record["version"], 1, "{}", r.json());
    assert!(record["contentRev"].as_i64().unwrap() > 0, "{record}");
    run_and_post(
        &mut c,
        &app,
        &b,
        &a2,
        vec![output(&a2, json!({ "verdict": "match" }), "ok")],
    )
    .await;
    let s = snap(&mut c, &b).await;
    let o = &item(&s, &a1)["output"];
    assert_eq!(
        (o["version"].clone(), o["outputs"]["premium"].clone()),
        (json!(1), json!(1240))
    );
    assert!(o["by"].is_string() && o["at"].is_string(), "{o}");
    assert_eq!(item(&s, &a1)["appState"]["state"], "fresh");
    assert_eq!(item(&s, &a2)["appState"]["state"], "fresh");
    let note_rev = item(&s, &n)["contentRev"].as_i64().unwrap();
    assert_eq!(o["inputRevs"][&n], json!(note_rev));

    // Moving the note changes nothing an app reads.
    let mv = json!({ "type": "item.transform", "itemId": n, "transform": { "x": 500.0, "y": 0.0, "width": 320.0, "height": 120.0, "rotation": 0.0 } });
    post_ops(&mut c, &b, vec![mv]).await;
    assert_eq!(
        item(&snap(&mut c, &b).await, &a1)["appState"]["state"],
        "fresh"
    );

    // Editing it makes a1 stale, naming the move, and a2 upstream stale.
    post_ops(
        &mut c,
        &b,
        vec![
            json!({ "type": "item.source", "itemId": n, "source": "---\nage: 19\n---\n# Policy" }),
        ],
    )
    .await;
    let s = snap(&mut c, &b).await;
    let st = &item(&s, &a1)["appState"];
    assert_eq!(st["state"], "stale", "{st}");
    assert_eq!(
        st["moved"][0],
        json!({ "itemId": n, "was": note_rev, "now": note_rev + 1 })
    );
    assert_eq!(
        item(&s, &a2)["appState"],
        json!({ "state": "upstream stale", "from": [a1] })
    );
    assert_eq!(
        item(&s, &a1)["output"]["outputs"]["premium"],
        1240,
        "outputs unchanged by the edit"
    );

    // A failed run keeps the last values beside its error.
    run_and_post(&mut c, &app, &b, &a1, vec![json!({ "type": "app.output", "itemId": a1, "outputs": {}, "status": "error", "error": "age out of range" })]).await;
    let s = snap(&mut c, &b).await;
    assert_eq!(
        item(&s, &a1)["appState"],
        json!({ "state": "error", "error": "age out of range" })
    );
    assert_eq!(item(&s, &a1)["output"]["outputs"]["premium"], 1240);
    assert_eq!(item(&s, &a2)["appState"]["state"], "upstream error");

    // Undo is a new version with the old values.
    post_ops(
        &mut c,
        &b,
        vec![json!({ "type": "app.output.revert", "itemId": a1, "toVersion": 1 })],
    )
    .await;
    let o = item(&snap(&mut c, &b).await, &a1)["output"].clone();
    assert_eq!(
        (o["version"].clone(), o["status"].clone()),
        (json!(3), json!("ok"))
    );

    // Outputs belong to apps' runs, and stay small.
    let r = post_ops(&mut c, &b, vec![output(&n, json!({ "x": 1 }), "ok")]).await;
    assert_eq!(r.status, StatusCode::CONFLICT, "no run, no output");
    let big = "x".repeat(17 * 1024);
    let r = run_and_post(
        &mut c,
        &app,
        &b,
        &a1,
        vec![output(&a1, json!({ "x": big }), "ok")],
    )
    .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    let r = run_and_post(&mut c, &app, &b, &a1, vec![output(&a1, json!({}), "maybe")]).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn an_apps_source_literals_and_link_setup_make_it_stale() {
    let (mut c, app, _dir) = signed_in().await;
    let (b, [_n, a1, _a2, k]) = app_board(&mut c).await;
    let refused = |r: Reply, needle: &str| {
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.json());
        let d = r.json().to_string();
        assert!(d.contains(needle), "{needle} not in {d}");
    };
    let r = run_and_post(
        &mut c,
        &app,
        &b,
        &a1,
        vec![output(&a1, json!({ "premium": 1200 }), "ok")],
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json());
    let s = snap(&mut c, &b).await;
    assert_eq!(item(&s, &a1)["appState"]["state"], "fresh");
    let stamps = &item(&s, &a1)["output"]["inputRevs"];
    assert_eq!(
        (stamps["#source"].clone(), stamps["#setup"].clone()),
        (json!(0), json!(0))
    );
    let moved = |s: &Value| -> Vec<String> {
        item(s, &a1)["appState"]["moved"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["itemId"].as_str().unwrap().to_string())
            .collect()
    };
    let set = |fields: Value| {
        let mut op = json!({ "type": "app.set", "itemId": a1 });
        op.as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        op
    };

    // Not a document: refused, nothing changed.
    refused(
        post_ops(&mut c, &b, vec![set(json!({ "html": "<p>no</p>" }))]).await,
        "whole HTML document",
    );
    // A quick edit to the source makes it stale; its outputs and what it feeds do not move.
    let rev = item(&snap(&mut c, &b).await, &a1)["contentRev"].clone();
    let r = post_ops(
        &mut c,
        &b,
        vec![set(
            json!({ "html": "<!doctype html><html><body>v2</body></html>" }),
        )],
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json());
    let s = snap(&mut c, &b).await;
    assert_eq!(item(&s, &a1)["content"]["sourceRev"], 1);
    assert_eq!(item(&s, &a1)["contentRev"], rev);
    assert_eq!(moved(&s), vec!["#source"]);

    // Literals: named like inputs, unique among them, at most 4 KiB each.
    refused(
        post_ops(
            &mut c,
            &b,
            vec![set(json!({ "literals": { "n1.frontmatter": 1 } }))],
        )
        .await,
        "already has an input named 'n1.frontmatter'",
    );
    refused(
        post_ops(&mut c, &b, vec![set(json!({ "literals": { "a b": 1 } }))]).await,
        "an input name is",
    );
    refused(
        post_ops(
            &mut c,
            &b,
            vec![set(json!({ "literals": { "big": "x".repeat(5000) } }))],
        )
        .await,
        "at most 4096 bytes",
    );
    refused(
        post_ops(&mut c, &b, vec![set(json!({ "run": "sometimes" }))]).await,
        "auto or manual",
    );
    let r = post_ops(
        &mut c,
        &b,
        vec![set(
            json!({ "literals": { "rate": 0.05 }, "run": "manual" }),
        )],
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json());
    let s = snap(&mut c, &b).await;
    assert_eq!(
        item(&s, &a1)["content"]["literals"],
        json!({ "rate": 0.05 })
    );
    assert_eq!(item(&s, &a1)["content"]["run"], "manual");
    assert_eq!(moved(&s), vec!["#source", "#setup"]);

    // Running again makes it fresh, stamped with both counters.
    let r = run_and_post(
        &mut c,
        &app,
        &b,
        &a1,
        vec![output(&a1, json!({ "premium": 1200 }), "ok")],
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json());
    let s = snap(&mut c, &b).await;
    assert_eq!(item(&s, &a1)["appState"]["state"], "fresh");

    // A feeds link narrowed to one field, under a name: stale, and labelled.
    let feed = s["links"]
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["linkType"] == "feeds" && l["to"]["itemId"] == a1)
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let link_set = |fields: Value| {
        let mut op = json!({ "type": "link.set", "linkId": feed, "linkType": "feeds" });
        op.as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        op
    };
    refused(
        post_ops(&mut c, &b, vec![link_set(json!({ "path": "a..b" }))]).await,
        "a field path is",
    );
    refused(
        post_ops(&mut c, &b, vec![link_set(json!({ "name": "rate" }))]).await,
        "already has an input named 'rate'",
    );
    let r = post_ops(
        &mut c,
        &b,
        vec![link_set(json!({ "path": "age", "name": "age" }))],
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json());
    let s = snap(&mut c, &b).await;
    let l = s["links"]
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["id"] == feed)
        .unwrap();
    assert_eq!(
        (l["path"].clone(), l["name"].clone()),
        (json!("age"), json!("age"))
    );
    assert_eq!(moved(&s), vec!["#setup"]);
    // Undo clears both: the whole view again, under its default name.
    let r = post_ops(
        &mut c,
        &b,
        vec![link_set(json!({ "path": "", "name": "" }))],
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json());
    let s = snap(&mut c, &b).await;
    let l = s["links"]
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["id"] == feed)
        .unwrap();
    assert_eq!(
        (l["path"].clone(), l["name"].clone()),
        (json!(null), json!(null))
    );
    // Only a feeds link carries a field or a name.
    refused(
        post_ops(
            &mut c,
            &b,
            vec![{
                let mut l = link(
                    &uuid::Uuid::now_v7().to_string(),
                    &a1,
                    &k,
                    "describes",
                    None,
                );
                l["name"] = json!("x");
                l
            }],
        )
        .await,
        "only a feeds link carries a field or an input name",
    );

    // A card attaches to the latest version only, and is capped.
    let version = item(&s, &a1)["output"]["version"].as_i64().unwrap();
    let card = |v: i64, html: &str| json!({ "type": "app.card", "itemId": a1, "version": v, "html": html });
    let r = post_ops(
        &mut c,
        &b,
        vec![card(version - 1, "<p>old</p>"), card(version, "<p>pic</p>")],
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json());
    assert_eq!(
        item(&snap(&mut c, &b).await, &a1)["output"]["card"],
        "<p>pic</p>"
    );
    refused(
        post_ops(&mut c, &b, vec![card(version, &"x".repeat(70_000))]).await,
        "at most 65536 bytes",
    );
}

#[tokio::test]
async fn an_app_reads_its_inputs_by_name_field_and_literal() {
    let (mut c, _app, _dir) = signed_in().await;
    let (b, [n, a1, a2, _k]) = app_board(&mut c).await;
    let url = |item: &str| format!("/api/boards/{b}/items/{item}/inputs");
    // By default an input is named after its source and view, and is the whole view.
    let r = c.get(&url(&a1)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json());
    let i = r.json();
    assert_eq!(i["values"], json!({ "n1.frontmatter": { "age": 34 } }));
    assert_eq!(i["inputs"][0]["ref"], "n1");
    assert_eq!(i["stamps"]["#source"], 0);
    assert!(i["stamps"][&n].is_number());

    // Narrowed to one field, named; a literal beside it; inputs declared in the source.
    let feed = snap(&mut c, &b).await["links"]
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["linkType"] == "feeds" && l["to"]["itemId"] == a1)
        .unwrap()["id"]
        .clone();
    let html = r#"<!doctype html><html><head>
<script type="application/json" id="visarium-inputs">[{ "name": "age", "description": "Insured's age" }, { "name": "sum" }]</script>
</head><body>calc</body></html>"#;
    let r = post_ops(
        &mut c,
        &b,
        vec![
            json!({ "type": "link.set", "linkId": feed, "linkType": "feeds", "path": "age", "name": "age" }),
            json!({ "type": "app.set", "itemId": a1, "html": html, "literals": { "rate": 0.05 } }),
        ],
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json());
    let i = c.get(&url(&a1)).await.json();
    assert_eq!(i["values"], json!({ "age": 34, "rate": 0.05 }));
    assert_eq!(
        i["inputs"],
        json!([
            { "name": "age", "origin": "link", "linkId": feed, "itemId": n, "ref": "n1", "view": "frontmatter",
              "path": "age", "revision": i["inputs"][0]["revision"], "value": 34, "fields": ["age"] },
            { "name": "rate", "origin": "literal", "value": 0.05 },
        ])
    );
    assert_eq!(
        i["declared"],
        json!([
            { "name": "age", "description": "Insured's age", "connected": true },
            { "name": "sum", "connected": false },
        ])
    );
    assert_eq!(
        (
            i["stamps"]["#source"].clone(),
            i["stamps"]["#setup"].clone()
        ),
        (json!(1), json!(2))
    );
    // Where its outputs go, and who ran it last (nobody yet).
    assert_eq!(i["feeds"], json!([{ "itemId": a2, "ref": "a2" }]));
    assert_eq!(
        (i["ranBy"].clone(), i["ranAt"].clone()),
        (json!(null), json!(null))
    );
    assert_eq!(c.get(&url(&a2)).await.json()["updates"][0]["ref"], "c1");

    // A field the view does not have: null, and said so.
    post_ops(
        &mut c,
        &b,
        vec![json!({ "type": "link.set", "linkId": feed, "linkType": "feeds", "path": "premium" })],
    )
    .await;
    let i = c.get(&url(&a1)).await.json();
    assert_eq!(
        (
            i["values"]["age"].clone(),
            i["inputs"][0]["missing"].clone()
        ),
        (json!(null), json!(true))
    );

    // An app's outputs feed the next by the same rule.
    assert_eq!(
        c.get(&url(&a2)).await.json()["values"],
        json!({ "a1.outputs": {} })
    );
    // Only apps have inputs; unknown items and boards are not found; strangers are not let in.
    assert_eq!(c.get(&url(&n)).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        c.get(&url(&uuid::Uuid::now_v7().to_string())).await.status,
        StatusCode::NOT_FOUND
    );
    let mut stranger = Client::new(c.router.clone());
    assert_eq!(
        stranger.get(&url(&a1)).await.status,
        StatusCode::UNAUTHORIZED
    );
}

/// The next app this socket is granted a run of, within `ms`.
async fn next_lease(ws: &mut Socket, ms: u64) -> Option<String> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(ms);
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        let Ok(Some(Ok(tungstenite::Message::Text(t)))) =
            tokio::time::timeout(left, ws.next()).await
        else {
            return None;
        };
        let f: Value = serde_json::from_str(&t).unwrap();
        if f["t"] == "run.lease" {
            return f["itemId"].as_str().map(str::to_string);
        }
    }
}

async fn cause_of(app: &visarium::AppState, item: &str) -> Value {
    let c: Option<String> = sqlx::query_scalar(
        "SELECT cause FROM app_output WHERE item_id = ? ORDER BY version DESC LIMIT 1",
    )
    .bind(item)
    .fetch_one(&app.db)
    .await
    .unwrap();
    c.map_or(Value::Null, |c| serde_json::from_str(&c).unwrap())
}

#[tokio::test]
async fn automatic_apps_run_after_an_edit_settles_in_order_and_within_limits() {
    let (mut c, app, _dir) = signed_in().await;
    let (b, [n, a1, a2, _k]) = app_board(&mut c).await;
    let board = uuid::Uuid::parse_str(&b).unwrap();
    let me: String = sqlx::query_scalar("SELECT id FROM app_user LIMIT 1")
        .fetch_one(&app.db)
        .await
        .unwrap();
    let out = |id: &str, v: i64| output(id, json!({ "v": v }), "ok");

    // Nobody watching: an edit leaves a1 behind, and nothing runs.
    post_ops(
        &mut c,
        &b,
        vec![json!({ "type": "item.source", "itemId": n, "source": "---\nage: 35\n---" })],
    )
    .await;
    // A client that can run apps joins: what is behind runs, a1 before a2.
    let (mut ws, socket) = live_socket(&c, &app, &b).await;
    assert!(app.rooms.set_ready(&board, socket, true));
    let mut leased = vec![];
    while let Some(id) = next_lease(&mut ws, 3000).await {
        leased.push(id.clone());
        let r = post_ops_from(&mut c, &b, Some(socket), vec![out(&id, 1)]).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.json());
        if leased.len() == 2 {
            break;
        }
    }
    assert_eq!(
        leased.first().map(String::as_str),
        Some(a1.as_str()),
        "{leased:?}"
    );
    assert!(leased.contains(&a2), "{leased:?}");
    let first = cause_of(&app, &a1).await;
    assert_eq!(
        (first["auto"].clone(), first["by"].clone()),
        (json!(true), json!(me))
    );
    // Edit, then fresh: a1 runs on its own, credited to the edit, then a2 on a1's outputs.
    while next_lease(&mut ws, 1500).await.is_some() {}
    post_ops(
        &mut c,
        &b,
        vec![json!({ "type": "item.source", "itemId": n, "source": "---\nage: 45\n---" })],
    )
    .await;
    assert_eq!(
        next_lease(&mut ws, 3000).await.as_deref(),
        Some(a1.as_str())
    );
    let r = post_ops_from(&mut c, &b, Some(socket), vec![out(&a1, 2)]).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json());
    assert_eq!(
        cause_of(&app, &a1).await,
        json!({ "auto": true, "by": me, "item": n })
    );
    // Credited as automatic, after the edit that caused it.
    let ran_by = c
        .get(&format!("/api/boards/{b}/items/{a1}/inputs"))
        .await
        .json()["ranBy"]
        .clone();
    assert!(
        ran_by
            .as_str()
            .is_some_and(|r| r.starts_with("a1, after ") && r.ends_with("'s edit to n1")),
        "{ran_by}"
    );
    assert_eq!(
        next_lease(&mut ws, 3000).await.as_deref(),
        Some(a2.as_str())
    );
    let r = post_ops_from(&mut c, &b, Some(socket), vec![out(&a2, 2)]).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json());
    assert_eq!(cause_of(&app, &a2).await["item"], json!(a1));
    let s = snap(&mut c, &b).await;
    assert_eq!(item(&s, &a1)["appState"]["state"], "fresh");
    assert_eq!(item(&s, &a2)["appState"]["state"], "fresh");

    // An error stops the chain: a2 does not run on a failed a1.
    post_ops(
        &mut c,
        &b,
        vec![json!({ "type": "item.source", "itemId": n, "source": "---\nage: 50\n---" })],
    )
    .await;
    assert_eq!(
        next_lease(&mut ws, 3000).await.as_deref(),
        Some(a1.as_str())
    );
    let r = post_ops_from(
        &mut c,
        &b,
        Some(socket),
        vec![output(&a1, json!({}), "error")],
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json());
    assert_eq!(next_lease(&mut ws, 2000).await, None);
    assert_eq!(
        item(&snap(&mut c, &b).await, &a2)["appState"]["state"],
        "upstream error"
    );

    // Manual stays stale.
    post_ops(
        &mut c,
        &b,
        vec![json!({ "type": "app.set", "itemId": a1, "run": "manual" })],
    )
    .await;
    post_ops(
        &mut c,
        &b,
        vec![json!({ "type": "item.source", "itemId": n, "source": "---\nage: 55\n---" })],
    )
    .await;
    assert_eq!(next_lease(&mut ws, 2000).await, None);
    assert_eq!(
        item(&snap(&mut c, &b).await, &a1)["appState"]["state"],
        "stale"
    );

    // A chain stops at its depth: a run 16 deep leaves what it feeds stale, saying why.
    post_ops(
        &mut c,
        &b,
        vec![json!({ "type": "app.set", "itemId": a1, "run": "auto" })],
    )
    .await;
    while next_lease(&mut ws, 1500).await.is_some() {}
    app.rooms
        .end_run(&board, uuid::Uuid::parse_str(&a1).unwrap());
    let (revs, _) =
        visarium::apps::run_state(&app.db, &board, &uuid::Uuid::parse_str(&a1).unwrap())
            .await
            .unwrap()
            .unwrap();
    app.rooms.request_auto(
        &board,
        uuid::Uuid::parse_str(&a1).unwrap(),
        (me.clone(), None),
        json!({ "auto": true, "by": me }),
        visarium::apps::AUTO_DEPTH,
        revs,
    );
    assert_eq!(
        next_lease(&mut ws, 1000).await.as_deref(),
        Some(a1.as_str())
    );
    let r = post_ops_from(&mut c, &b, Some(socket), vec![out(&a1, 99)]).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json());
    assert_eq!(next_lease(&mut ws, 2000).await, None);
    let held = app
        .rooms
        .held(&board, uuid::Uuid::parse_str(&a2).unwrap())
        .unwrap_or_default();
    assert!(held.contains("chain of 16"), "{held}");
    let said = c
        .get(&format!("/api/boards/{b}/items/{a2}/inputs"))
        .await
        .json()["held"]
        .clone();
    assert!(
        said.as_str().is_some_and(|s| s.contains("chain of 16")),
        "{said}"
    );
}

#[tokio::test]
async fn a_duplicated_board_keeps_its_apps_outputs_and_data_links() {
    let (mut c, app, _dir) = signed_in().await;
    let (b, [n, a1, _a2, _k]) = app_board(&mut c).await;
    // Name and narrow the note's link, and give a1 a literal, before it runs.
    let feed = snap(&mut c, &b).await["links"]
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["linkType"] == "feeds" && l["to"]["itemId"] == a1)
        .unwrap()["id"]
        .clone();
    post_ops(
        &mut c,
        &b,
        vec![
            json!({ "type": "link.set", "linkId": feed, "linkType": "feeds", "path": "age", "name": "age" }),
            json!({ "type": "app.set", "itemId": a1, "literals": { "rate": 0.05 } }),
        ],
    )
    .await;
    run_and_post(
        &mut c,
        &app,
        &b,
        &a1,
        vec![output(&a1, json!({ "premium": 1240 }), "ok")],
    )
    .await;
    post_ops(
        &mut c,
        &b,
        vec![json!({ "type": "item.source", "itemId": n, "source": "changed" })],
    )
    .await;
    let copy = c
        .json("POST", &format!("/api/boards/{b}/duplicate"), json!(null))
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let s = snap(&mut c, &copy).await;
    let app = s["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["ref"] == "a1")
        .unwrap();
    assert_eq!(app["output"]["outputs"]["premium"], 1240);
    assert_eq!(
        app["appState"]["state"], "stale",
        "as stale as the original"
    );
    let note = s["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["ref"] == "n1")
        .unwrap();
    assert_eq!(
        app["appState"]["moved"],
        json!([{ "itemId": note["id"], "was": 0, "now": 1 }]),
        "inputs renamed to the copies; its own source and setup kept and matching"
    );
    assert_eq!(app["content"]["literals"], json!({ "rate": 0.05 }));
    let fed = s["links"]
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["linkType"] == "feeds" && l["to"]["itemId"] == app["id"])
        .unwrap();
    assert_eq!(
        (fed["path"].clone(), fed["name"].clone()),
        (json!("age"), json!("age"))
    );
    let kinds: Vec<(&str, Option<&str>)> = s["links"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| (l["linkType"].as_str().unwrap(), l["view"].as_str()))
        .collect();
    assert!(
        kinds.contains(&("feeds", Some("frontmatter"))) && kinds.contains(&("updates", None)),
        "{kinds:?}"
    );
}

#[tokio::test]
async fn a_self_hosted_sandbox_hostname_is_framed_only_from_its_board() {
    // On the board's own origin, app views could reach its pages: refused.
    let (mut same, dir) = config(false);
    same.public_url = Some("https://board.example.net".into());
    same.apps_origin = Some("https://BOARD.example.net/".into());
    let refused = visarium::open(same).await.err().unwrap().to_string();
    assert!(refused.contains("must differ"), "{refused}");
    let _ = std::fs::remove_dir_all(dir);

    let (mut config, dir) = config(true);
    config.public_url = Some("https://board.example.net".into());
    config.apps_origin = Some("https://apps.example.net".into());
    let app = visarium::open(config).await.unwrap();
    let mut c = Client::new(visarium::router(app.clone()));
    assert_eq!(
        c.get("/api/meta").await.json()["appsOrigin"],
        "https://apps.example.net"
    );
    let (b, [_n, a1, _a2, _k]) = app_board(&mut c).await;
    let m = c
        .json(
            "POST",
            &format!("/api/boards/{b}/items/{a1}/mount"),
            json!(null),
        )
        .await
        .json();
    let path = m["url"]
        .as_str()
        .unwrap()
        .strip_prefix("https://apps.example.net")
        .unwrap()
        .to_string();
    let res = visarium::apps::sandbox_router(app.clone())
        .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let csp = res.headers()["content-security-policy"]
        .to_str()
        .unwrap()
        .to_string();
    assert!(
        csp.ends_with(
            "frame-ancestors http://127.0.0.1:* http://localhost:* https://board.example.net"
        ),
        "{csp}"
    );
    assert!(res.headers().get("set-cookie").is_none());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn app_views_load_only_from_the_sandbox_origin_with_a_mount_token() {
    // Without a sandbox origin, apps say where they run.
    let (mut plain, _app, _dir) = signed_in().await;
    assert_eq!(
        plain.get("/api/meta").await.json()["appsOrigin"],
        Value::Null
    );
    let (b, [_n, a1, _a2, _k]) = app_board(&mut plain).await;
    let refused = plain
        .json(
            "POST",
            &format!("/api/boards/{b}/items/{a1}/mount"),
            json!(null),
        )
        .await;
    assert_eq!(refused.status, StatusCode::NOT_FOUND);
    assert!(
        refused.json().to_string().contains("need a sandbox origin"),
        "{}",
        refused.json()
    );

    // The desktop's shape: one account, and a sandbox origin of its own.
    let (mut config, dir) = config(true);
    config.apps_origin = Some("http://127.0.0.1:47999".into());
    let app = visarium::open(config).await.unwrap();
    let mut c = Client::new(visarium::router(app.clone()));
    assert_eq!(
        c.get("/api/meta").await.json()["appsOrigin"],
        "http://127.0.0.1:47999"
    );
    let (b, [n, a1, _a2, _k]) = app_board(&mut c).await;
    let not_app = c
        .json(
            "POST",
            &format!("/api/boards/{b}/items/{n}/mount"),
            json!(null),
        )
        .await;
    assert_eq!(not_app.status, StatusCode::NOT_FOUND);
    let mounted = c
        .json(
            "POST",
            &format!("/api/boards/{b}/items/{a1}/mount"),
            json!({ "theme": "light", "tokens": { "ink": "oklch(0.24 0.008 265)", "surface": "x</style><script>" } }),
        )
        .await;
    assert_eq!(mounted.status, StatusCode::OK, "{}", mounted.json());
    let m = mounted.json();
    assert_eq!(m["origin"], "http://127.0.0.1:47999");
    let url = m["url"].as_str().unwrap();
    let path = url
        .strip_prefix("http://127.0.0.1:47999")
        .unwrap()
        .to_string();
    assert!(path.starts_with("/app/") && path.len() > 60, "{path}");

    let sandbox = visarium::apps::sandbox_router(app.clone());
    let fetch = |path: String| {
        let sandbox = sandbox.clone();
        async move {
            let res = sandbox
                .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            let status = res.status();
            let headers = res.headers().clone();
            let body = res.into_body().collect().await.unwrap().to_bytes();
            (status, headers, String::from_utf8_lossy(&body).to_string())
        }
    };
    let (status, headers, body) = fetch(path.clone()).await;
    assert_eq!(status, StatusCode::OK);
    // The app, dressed in the kit themed as the person has the board; a token
    // that is not a colour is left out.
    assert_eq!(
        body,
        "<!doctype html><html><meta name=\"color-scheme\" content=\"light\"><style data-visarium-kit>:root{--vk-ink:oklch(0.24 0.008 265);}</style><link rel=\"stylesheet\" href=\"/kit.css\"><script src=\"/kit.js\"></script><body>calc</body></html>"
    );
    // The kit's script, which sends the board snapshots for the card.
    let (js_status, js_headers, js) = fetch("/kit.js".into()).await;
    assert_eq!(js_status, StatusCode::OK);
    assert_eq!(
        js_headers[header::CONTENT_TYPE],
        "text/javascript; charset=utf-8"
    );
    assert!(js.contains("visarium/card"), "{js}");
    // The style sheet is on the board's own origin too, for drawing cards, signed in or not.
    let mut stranger = Client::new(c.router.clone());
    let board_kit = stranger.get("/api/apps/kit.css").await;
    assert_eq!(board_kit.status, StatusCode::OK);
    let (kit_status, kit_headers, kit) = fetch("/kit.css".into()).await;
    assert_eq!(kit_status, StatusCode::OK);
    assert_eq!(kit_headers[header::CONTENT_TYPE], "text/css; charset=utf-8");
    assert!(
        kit.contains("var(--vk-ink)") && !kit.contains("oklch("),
        "the kit chooses no colour"
    );
    let csp = headers[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
    for part in [
        "default-src 'none'",
        "connect-src 'none'",
        "frame-src 'none'",
        "object-src 'none'",
        "form-action 'none'",
        "frame-ancestors http://127.0.0.1:*",
    ] {
        assert!(csp.contains(part), "{part} missing from {csp}");
    }
    assert_eq!(headers[header::CONTENT_TYPE], "text/html; charset=utf-8");
    assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    assert!(
        headers.get(header::SET_COOKIE).is_none(),
        "the sandbox sets no cookie"
    );
    // The same token reloads the view; any other path or token is nothing.
    assert_eq!(fetch(path).await.0, StatusCode::OK);
    assert_eq!(
        fetch(format!("/app/{}", "0".repeat(64))).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(fetch("/api/boards".into()).await.0, StatusCode::NOT_FOUND);
    assert_eq!(fetch("/".into()).await.0, StatusCode::NOT_FOUND);
    // A deleted app's view is gone even with a live token.
    post_ops(
        &mut c,
        &b,
        vec![json!({ "type": "item.delete", "itemId": a1 })],
    )
    .await;
    let again = m["url"]
        .as_str()
        .unwrap()
        .strip_prefix("http://127.0.0.1:47999")
        .unwrap()
        .to_string();
    assert_eq!(fetch(again).await.0, StatusCode::NOT_FOUND);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn an_app_commits_only_from_the_client_running_it() {
    let (mut c, app, _dir) = signed_in().await;
    let (b, [n, a1, a2, k]) = app_board(&mut c).await;
    let (board, id1) = (
        uuid::Uuid::parse_str(&b).unwrap(),
        uuid::Uuid::parse_str(&a1).unwrap(),
    );
    let refused = |r: &Reply, status: StatusCode, needle: &str| {
        assert_eq!(r.status, status, "{}", r.json());
        assert!(
            r.json().to_string().contains(needle),
            "{needle} in {}",
            r.json()
        );
    };

    // No run, or someone else's: refused, nothing stored.
    let r = post_ops_from(&mut c, &b, None, vec![output(&a1, json!({ "p": 1 }), "ok")]).await;
    refused(&r, StatusCode::CONFLICT, "no_lease");
    // Ada is a connected client; "Bo" is only an id in a header, as anyone on
    // the board could copy one: neither holds a run that is not theirs.
    let (_ada_ws, ada) = live_socket(&c, &app, &b).await;
    let bo = uuid::Uuid::new_v4();
    app.rooms.mount(&board, id1, ada, true);
    app.rooms.mount(&board, id1, bo, true);
    let (revs, fresh) = visarium::apps::run_state(&app.db, &board, &id1)
        .await
        .unwrap()
        .unwrap();
    assert!(!fresh, "never ran");
    app.rooms.request_run(&board, id1, Some(ada), revs);
    let r = post_ops_from(
        &mut c,
        &b,
        Some(bo),
        vec![output(&a1, json!({ "p": 1 }), "ok")],
    )
    .await;
    refused(&r, StatusCode::CONFLICT, "no_lease");

    // The note changes mid-run: the run's result is for inputs that are gone.
    post_ops(
        &mut c,
        &b,
        vec![json!({ "type": "item.source", "itemId": n, "source": "changed" })],
    )
    .await;
    let r = post_ops_from(
        &mut c,
        &b,
        Some(ada),
        vec![output(&a1, json!({ "p": 1 }), "ok")],
    )
    .await;
    refused(&r, StatusCode::CONFLICT, "superseded");
    assert!(
        app.rooms.held_run(&board, id1, ada).is_none(),
        "the superseded run is over"
    );

    // A run for the inputs as they are commits, and ends.
    let (revs, _) = visarium::apps::run_state(&app.db, &board, &id1)
        .await
        .unwrap()
        .unwrap();
    app.rooms.request_run(&board, id1, Some(ada), revs);
    let r = post_ops_from(
        &mut c,
        &b,
        Some(ada),
        vec![output(&a1, json!({ "p": 1 }), "ok")],
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json());
    assert!(app.rooms.held_run(&board, id1, ada).is_none());
    // Now it is fresh: running it again would change nothing.
    assert!(
        visarium::apps::run_state(&app.db, &board, &id1)
            .await
            .unwrap()
            .unwrap()
            .1
    );
    let _ = (a2, k);
}

#[tokio::test]
async fn a_run_ticks_tasks_only_on_the_checklists_its_app_updates() {
    let (mut c, app, _dir) = signed_in().await;
    let (b, [n, a1, a2, k]) = app_board(&mut c).await;
    let tick = |by: &str| json!({ "type": "task.set", "itemId": k, "taskId": "t1", "state": "done", "byApp": by });

    // a2 updates k: during its run it may tick k's task, credited to it.
    let r = run_and_post(&mut c, &app, &b, &a2, vec![tick(&a2)]).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json());
    let s = snap(&mut c, &b).await;
    let task = &item(&s, &k)["content"]["tasks"][0];
    assert_eq!(
        (task["state"].clone(), task["byApp"].clone()),
        (json!("done"), json!(a2))
    );
    assert!(task["by"].is_string(), "and the person whose run it was");

    // a1 has no updates link to k: refused even during its own run.
    let r = run_and_post(&mut c, &app, &b, &a1, vec![tick(&a1)]).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.json());
    // Claiming an app without its run: refused.
    let r = post_ops(&mut c, &b, vec![tick(&a2)]).await;
    assert_eq!(r.status, StatusCode::CONFLICT, "{}", r.json());
    // A run's allowance is bounded.
    let many: Vec<Value> = (0..21).map(|_| tick(&a2)).collect();
    let r = run_and_post(&mut c, &app, &b, &a2, many).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.json());
    // A person's own later change clears the app's credit.
    post_ops(
        &mut c,
        &b,
        vec![json!({ "type": "task.set", "itemId": k, "taskId": "t1", "state": "todo" })],
    )
    .await;
    let s = snap(&mut c, &b).await;
    assert_eq!(item(&s, &k)["content"]["tasks"][0].get("byApp"), None);
    let _ = n;
}

// --- MCP servers as a source (canvas/app-sources) ------------------------------

use fake_mcp::{FakeMcp, fake_mcp};

/// Signed in on an instance whose operator allows these MCP hosts.
async fn signed_in_allowing(allow: &[&str]) -> (Client, visarium::AppState) {
    let (mut config, _dir) = config(false);
    config.mcp_allow = allow.iter().map(|h| h.to_string()).collect();
    config.apps_origin = Some("http://127.0.0.1:18081".into());
    let app = visarium::open(config).await.unwrap();
    let mut c = Client::new(visarium::router(app.clone()));
    c.get("/api/session").await;
    let claimed = c
        .json(
            "POST",
            "/api/setup",
            json!({ "username": "ada", "displayName": "Ada", "password": "correct horse battery" }),
        )
        .await;
    assert_eq!(claimed.status, StatusCode::CREATED);
    (c, app)
}

#[tokio::test]
async fn mcp_connections_reach_only_allowed_hosts_and_keep_their_tokens() {
    let server = fake_mcp().await;
    // Host not allowed: refused, naming the allowlist, and nothing is contacted.
    let (mut c, _app) = signed_in_allowing(&["mcp.example.com"]).await;
    let (b, _) = app_board(&mut c).await;
    let r = c
        .json(
            "POST",
            &format!("/api/boards/{b}/mcp"),
            json!({ "url": server.url }),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.json());
    assert!(
        r.json()["detail"]
            .as_str()
            .unwrap()
            .contains("VISARIUM_MCP_ALLOW: mcp.example.com")
    );
    // A local command is the desktop's alone.
    let r = c
        .json(
            "POST",
            &format!("/api/boards/{b}/mcp"),
            json!({ "command": "node server.js" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);

    // Private address: an allowed name resolving to loopback is refused...
    let (mut c, _app) = signed_in_allowing(&["localhost"]).await;
    let (b, _) = app_board(&mut c).await;
    let r = c
        .json(
            "POST",
            &format!("/api/boards/{b}/mcp"),
            json!({ "url": server.url }),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.json());
    assert!(
        r.json()["detail"]
            .as_str()
            .unwrap()
            .contains("private address"),
        "{}",
        r.json()
    );

    // ...unless the operator lists that address too.
    let (mut c, app) = signed_in_allowing(&["localhost", "127.0.0.1", "::1"]).await;
    let (b, _) = app_board(&mut c).await;
    let r = c
        .json(
            "POST",
            &format!("/api/boards/{b}/mcp"),
            json!({ "url": server.url, "token": "Bearer s3cret-token" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json());
    let tools = r.json()["tools"].clone();
    assert_eq!(tools[0]["resourceUri"], "ui://price/view");
    // The token never comes back.
    let listed = c.get(&format!("/api/boards/{b}/mcp")).await;
    assert_eq!(listed.json()["connections"][0]["hasToken"], true);
    assert!(!String::from_utf8_lossy(&listed.body).contains("s3cret"));
    let snap = c.get(&format!("/api/boards/{b}/snapshot")).await;
    assert!(!String::from_utf8_lossy(&snap.body).contains("s3cret"));
    assert_eq!(count(&app, "SELECT count(*) FROM mcp_connection").await, 1);
    server.stop.abort();
}

/// A board with an MCP connection to `server`, and app `a` made from its
/// `price` tool and view, fed n's frontmatter age: what the add menu does.
async fn mcp_app(c: &mut Client, server: &FakeMcp, tool: &str) -> (String, String, String, String) {
    let (b, ids) = app_board(c).await;
    let conn = c
        .json(
            "POST",
            &format!("/api/boards/{b}/mcp"),
            json!({ "url": server.url }),
        )
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let sha = c
        .json(
            "POST",
            &format!("/api/boards/{b}/mcp/{conn}/resource"),
            json!({ "uri": "ui://price/view" }),
        )
        .await
        .json()["sha256"]
        .as_str()
        .unwrap()
        .to_string();
    let a = uuid::Uuid::now_v7().to_string();
    let r = post_ops(
        c,
        &b,
        vec![
            create(&a, json!({ "kind": "app", "title": "Price", "run": "manual",
                "mcp": { "connection": conn, "resourceUri": "ui://price/view", "tool": tool, "sha256": sha } })),
            json!({ "type": "link.add", "linkId": uuid::Uuid::now_v7(), "from": { "itemId": ids[0] },
                    "to": { "itemId": a }, "linkType": "feeds", "view": "frontmatter", "path": "age", "name": "age" }),
        ],
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json());
    (b, a, conn, sha)
}

#[tokio::test]
async fn an_mcp_apps_view_is_pinned_and_calls_only_tools_visible_to_apps() {
    let server = fake_mcp().await;
    let (mut c, app) = signed_in_allowing(&["localhost", "127.0.0.1", "::1"]).await;
    let (b, a, _conn, sha) = mcp_app(&mut c, &server, "price").await;

    // Its view is the pinned HTML, under a policy widened only by what it declares.
    let mount = c
        .json(
            "POST",
            &format!("/api/boards/{b}/items/{a}/mount"),
            json!(null),
        )
        .await;
    assert_eq!(mount.status, StatusCode::OK, "{}", mount.json());
    let pinned = visarium::mcp::view_of(
        &app.db,
        &visarium::apps::McpSource {
            connection: String::new(),
            resource_uri: String::new(),
            tool: None,
            sha256: sha.clone(),
        },
    )
    .await
    .unwrap();
    assert!(pinned.0.contains("<p>v1</p>"));
    let csp = visarium::mcp::view_csp(None, &pinned.1);
    assert!(csp.contains("connect-src https://api.example.com"), "{csp}");

    // Resource changed upstream: a3 keeps v1 and offers the update.
    *server.html.lock().unwrap() = "<!doctype html><title>Price</title><p>v2</p>".into();
    c.json(
        "POST",
        &format!("/api/boards/{b}/items/{a}/mount"),
        json!(null),
    )
    .await;
    let mut update = Value::Null;
    for _ in 0..100 {
        update = c
            .get(&format!("/api/boards/{b}/items/{a}/inputs"))
            .await
            .json()["mcp"]["updateAvailable"]
            .clone();
        if update.is_string() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let new = update.as_str().expect("an update is offered").to_string();
    let snap = c.get(&format!("/api/boards/{b}/snapshot")).await.json();
    let item = snap["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["id"] == a)
        .unwrap()
        .clone();
    assert_eq!(item["content"]["mcp"]["sha256"], sha, "still pinned");
    // A person applies it.
    let r = post_ops(
        &mut c,
        &b,
        vec![json!({ "type": "app.set", "itemId": a, "mcpSha256": new })],
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json());
    let inputs = c
        .get(&format!("/api/boards/{b}/items/{a}/inputs"))
        .await
        .json();
    assert_eq!(inputs["mcp"]["sha256"], new);
    assert_eq!(inputs["mcp"]["updateAvailable"], Value::Null);
    assert!(!inputs.to_string().contains("token"));

    // Tool not visible to apps: refused, and the server is not called.
    let before = server.calls.load(std::sync::atomic::Ordering::SeqCst);
    let r = c
        .json(
            "POST",
            &format!("/api/boards/{b}/items/{a}/mcp"),
            json!({ "method": "tools/call", "params": { "name": "secret", "arguments": {} } }),
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.json());
    assert_eq!(
        server.calls.load(std::sync::atomic::Ordering::SeqCst),
        before
    );
    let r = c
        .json("POST", &format!("/api/boards/{b}/items/{a}/mcp"),
            json!({ "method": "tools/call", "params": { "name": "price", "arguments": { "age": 40 } } }))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json());
    assert_eq!(r.json()["structuredContent"]["premium"], 1200);
    server.stop.abort();
}

async fn until_output(
    app: &visarium::AppState,
    item: &str,
    version: i64,
) -> (String, String, Option<String>) {
    for _ in 0..200 {
        let row: Option<(String, String, Option<String>)> = sqlx::query_as(
            "SELECT status, outputs, error FROM app_output WHERE item_id = ? AND version = ?",
        )
        .bind(item)
        .bind(version)
        .fetch_optional(&app.db)
        .await
        .unwrap();
        if let Some(r) = row {
            return r;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("no output v{version} for {item}");
}

#[tokio::test]
async fn a_tool_backed_app_runs_on_the_server_with_nobody_around() {
    let server = fake_mcp().await;
    let (mut c, app) = signed_in_allowing(&["localhost", "127.0.0.1", "::1"]).await;
    let (b, a, _conn, _) = mcp_app(&mut c, &server, "price").await;
    let board = uuid::Uuid::parse_str(&b).unwrap();
    let id = uuid::Uuid::parse_str(&a).unwrap();
    // Nobody has the board open, and nobody can run an inline app...
    assert!(!app.rooms.can_run(&board, id));
    // ...but a tool-backed one runs on the server: inputs in, structured content out.
    let (stamps, _) = visarium::apps::run_state(&app.db, &board, &id)
        .await
        .unwrap()
        .unwrap();
    let user: String = sqlx::query_scalar("SELECT id FROM app_user LIMIT 1")
        .fetch_one(&app.db)
        .await
        .unwrap();
    let g = visarium::mcp::grant(
        &app,
        &board,
        id,
        (user.clone(), Some("Claude".into())),
        None,
        stamps,
    )
    .await;
    assert!(
        matches!(g, Some(visarium::realtime::RunGrant::Leased(h)) if h == visarium::realtime::SERVER)
    );
    let (status, outputs, _) = until_output(&app, &a, 1).await;
    assert_eq!(status, "ok");
    assert_eq!(
        serde_json::from_str::<Value>(&outputs).unwrap(),
        json!({ "premium": 1020 })
    );

    // Tool error: an error version, and the ok outputs before it stay readable.
    sqlx::query("UPDATE canvas_item SET body = json_set(body, '$.mcp.tool', 'fail') WHERE id = ?")
        .bind(&a)
        .execute(&app.db)
        .await
        .unwrap();
    let edit = post_ops(
        &mut c,
        &b,
        vec![json!({ "type": "app.set", "itemId": a, "literals": { "x": 1 } })],
    )
    .await;
    assert_eq!(edit.status, StatusCode::OK, "{}", edit.json());
    let (stamps, _) = visarium::apps::run_state(&app.db, &board, &id)
        .await
        .unwrap()
        .unwrap();
    visarium::mcp::grant(&app, &board, id, (user.clone(), None), None, stamps).await;
    let (status, _, error) = until_output(&app, &a, 2).await;
    assert_eq!(
        (status.as_str(), error.as_deref()),
        ("error", Some("rates are down"))
    );
    let (_, outputs, _) = until_output(&app, &a, 1).await;
    assert!(outputs.contains("1020"));

    // Server gone: the run ends unavailable.
    server.stop.abort();
    let _ = server.stop.await;
    let edit = post_ops(
        &mut c,
        &b,
        vec![json!({ "type": "app.set", "itemId": a, "literals": { "x": 2 } })],
    )
    .await;
    assert_eq!(edit.status, StatusCode::OK);
    let (stamps, _) = visarium::apps::run_state(&app.db, &board, &id)
        .await
        .unwrap()
        .unwrap();
    visarium::mcp::grant(&app, &board, id, (user, None), None, stamps).await;
    let (status, _, error) = until_output(&app, &a, 3).await;
    assert_eq!(status, "error");
    assert!(error.unwrap().starts_with("unavailable"));
}

#[tokio::test]
async fn the_desktop_runs_a_local_mcp_server_the_person_names() {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../web/e2e/fixtures/mcp/server.mjs")
        .canonicalize()
        .unwrap();
    let (mut config, _dir) = config(true);
    config.mcp_local = true;
    let app = visarium::open(config).await.unwrap();
    let mut c = Client::new(visarium::router(app.clone()));
    c.get("/api/session").await;
    let (b, _) = app_board(&mut c).await;
    let r = c
        .json(
            "POST",
            &format!("/api/boards/{b}/mcp"),
            json!({ "command": format!("node {} --stdio", script.display()) }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json());
    assert_eq!(r.json()["tools"][0]["name"], "quote");
    assert_eq!(
        c.get(&format!("/api/boards/{b}/mcp")).await.json()["local"],
        true
    );
}
