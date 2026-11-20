//! The agent interface end to end (ADR-0031): the fixture board, diagram
//! structure against the shared fixtures, and `/mcp` over a real router.

use std::path::PathBuf;

use serde_json::{Value, json};
use visarium::agent::diagram::{self, Extracted};

const FIXTURES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../packages/canvas-core/fixtures/diagrams"
);

// --- diagram structure: the server half of the shared fixtures -----------------

#[test]
fn extraction_matches_every_shared_fixture() {
    let mut checked = 0;
    let mut wrong = vec![];
    for entry in std::fs::read_dir(FIXTURES).unwrap() {
        let path = entry.unwrap().path();
        let lang = match path.extension().and_then(|e| e.to_str()) {
            Some("mmd") => "mermaid",
            Some("puml") => "plantuml",
            _ => continue,
        };
        let source = std::fs::read_to_string(&path).unwrap();
        let want: Value = serde_json::from_str(
            &std::fs::read_to_string(path.with_extension("elements.json")).unwrap(),
        )
        .unwrap();
        let Extracted::Known(got) = diagram::extract(lang, &source) else {
            wrong.push(format!("{}: unsupported", path.display()));
            continue;
        };
        let mut got_elements = got.elements.clone();
        got_elements.sort();
        let mut want_elements: Vec<String> =
            serde_json::from_value(want["elements"].clone()).unwrap();
        want_elements.sort();
        if got_elements != want_elements {
            wrong.push(format!(
                "{}: elements {got_elements:?}, fixture {want_elements:?}",
                path.display()
            ));
        }
        if serde_json::to_value(&got.edges).unwrap() != want["edges"] {
            wrong.push(format!(
                "{}: edges {}, fixture {}",
                path.display(),
                json!(got.edges),
                want["edges"]
            ));
        }
        if let Some(w) = &got.warning {
            wrong.push(format!("{}: unexpected warning {w:?}", path.display()));
        }
        checked += 1;
    }
    assert!(checked >= 12, "fixtures found: {checked}");
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    assert!(
        matches!(diagram::extract("mermaid", "gantt\n  title Plan\n  section A\n  Task :a1, 2026-01-01, 3d"),
        Extracted::Unsupported(t) if t == "mermaid gantt")
    );
}

// --- harness ------------------------------------------------------------------

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use futures_util::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest};
use tower::ServiceExt;
use visarium::agent::board::{Anchored, Board, BoardData};
use visarium::auth::{self, Kind};
use visarium::boards::{self, Actor, Op};

const FIXTURE: &str = include_str!("fixtures/offline-sync.json");
const EVAL: &str = include_str!("agent_eval/tasks.json");

struct World {
    app: visarium::AppState,
    router: axum::Router,
    dir: PathBuf,
    user: String,
    token: String,
    board: String,
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn config(single_user: bool) -> (visarium::Config, PathBuf) {
    let dir = std::env::temp_dir().join(format!("visarium-agent-{}", uuid::Uuid::new_v4()));
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

async fn person(app: &visarium::AppState, username: &str, name: &str) -> String {
    let id = uuid::Uuid::now_v7().to_string();
    sqlx::query("INSERT INTO app_user (id, username, display_name, is_admin) VALUES (?, ?, ?, 0)")
        .bind(&id)
        .bind(username)
        .bind(name)
        .execute(&app.db)
        .await
        .unwrap();
    id
}

async fn agent_token(app: &visarium::AppState, user: &str, label: &str) -> String {
    auth::create_session(&app.db, Kind::Agent, Some(user), None, None, Some(label))
        .await
        .unwrap()
}

/// The fixture board, built from its operations as Ada; its image is a real
/// stored PNG, so item_view has pixels to return.
async fn fixture_board(app: &visarium::AppState, user: &str, dir: &std::path::Path) -> String {
    let board = uuid::Uuid::now_v7();
    let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
    sqlx::query("INSERT INTO canvas (id, title, owner_id) VALUES (?, ?, ?)")
        .bind(board.to_string())
        .bind(fixture["title"].as_str().unwrap())
        .bind(user)
        .execute(&app.db)
        .await
        .unwrap();
    let img = image::RgbImage::from_fn(320, 240, |x, y| {
        image::Rgb([200, (x % 256) as u8, (y % 256) as u8])
    });
    let mut png = std::io::Cursor::new(Vec::new());
    img.write_to(&mut png, image::ImageFormat::Png).unwrap();
    let png = png.into_inner();
    std::fs::create_dir_all(dir.join("assets/fx")).unwrap();
    std::fs::write(dir.join("assets/fx/photo.png"), &png).unwrap();
    let asset = uuid::Uuid::now_v7().to_string();
    sqlx::query(
        "INSERT INTO asset (id, content_hash, storage_key, original_filename, mime_type, byte_size, width, height, uploaded_by)
         VALUES (?, ?, 'fx/photo.png', 'whiteboard-photo.png', 'image/png', ?, 320, 240, ?)",
    )
    .bind(&asset)
    .bind(format!("fx-{asset}"))
    .bind(png.len() as i64)
    .bind(user)
    .execute(&app.db)
    .await
    .unwrap();
    // Fresh ids per board, so one database can hold the fixture twice.
    let mut text = fixture["operations"]
        .to_string()
        .replace("{{ASSET}}", &asset);
    while let Some(at) = text.find("00000000-0000-4000-8000-") {
        let fixed = text[at..at + 36].to_string();
        text = text.replace(&fixed, &uuid::Uuid::now_v7().to_string());
    }
    let ops: Vec<Op> = serde_json::from_str(&text).unwrap();
    apply_as(app, &board.to_string(), user, ops).await;
    board.to_string()
}

async fn apply_as(app: &visarium::AppState, board: &str, user: &str, mut ops: Vec<Op>) {
    let actor = Actor {
        user_id: user.into(),
        agent: None,
    };
    for op in &mut ops {
        op.stamp(&actor, "2026-11-19T10:00:00.000Z");
    }
    boards::apply(app, &uuid::Uuid::parse_str(board).unwrap(), &mut ops, &actor)
        .await
        .unwrap();
}

async fn world() -> World {
    let (config, dir) = config(false);
    let app = visarium::open(config).await.unwrap();
    let user = person(&app, "ada", "Ada").await;
    let token = agent_token(&app, &user, "Claude Code on laptop").await;
    let board = fixture_board(&app, &user, &dir).await;
    let router = visarium::router(app.clone());
    World {
        app,
        router,
        dir,
        user,
        token,
        board,
    }
}

async fn post(router: &axum::Router, headers: &[(&str, &str)], body: Value) -> (StatusCode, Value) {
    let mut req = Request::builder()
        .method("POST")
        .uri("/mcp")
        .header(header::HOST, "localhost:8080")
        .header(header::CONTENT_TYPE, "application/json");
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let res = router
        .clone()
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

impl World {
    async fn rpc(&self, method: &str, params: Value) -> Value {
        let auth = format!("Bearer {}", self.token);
        let (status, body) = post(
            &self.router,
            &[("authorization", &auth)],
            json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["result"].clone()
    }
    /// A tool's text, asserting it succeeded.
    async fn ok(&self, tool: &str, args: Value) -> String {
        let r = self
            .rpc("tools/call", json!({ "name": tool, "arguments": args }))
            .await;
        assert_eq!(
            r["isError"], false,
            "{tool} failed: {}",
            r["content"][0]["text"]
        );
        r["content"][0]["text"].as_str().unwrap().to_string()
    }
    /// A tool's error text, asserting it failed.
    async fn fails(&self, tool: &str, args: Value) -> String {
        let r = self
            .rpc("tools/call", json!({ "name": tool, "arguments": args }))
            .await;
        assert_eq!(
            r["isError"], true,
            "{tool} should have failed: {}",
            r["content"][0]["text"]
        );
        r["content"][0]["text"].as_str().unwrap().to_string()
    }
    async fn data(&self) -> BoardData {
        BoardData::load(
            &self.app.db,
            &Board {
                id: uuid::Uuid::parse_str(&self.board).unwrap(),
                title: "Offline sync".into(),
            },
        )
        .await
        .unwrap()
    }
    async fn revision(&self) -> i64 {
        sqlx::query_scalar("SELECT revision FROM canvas WHERE id = ?")
            .bind(&self.board)
            .fetch_one(&self.app.db)
            .await
            .unwrap()
    }
}

// --- the fixture and the eval set ------------------------------------------------

#[tokio::test]
async fn the_fixture_board_loads_whole() {
    let w = world().await;
    let b = w.data().await;
    assert_eq!(b.items.len(), 10);
    assert_eq!(b.links.len(), 6);
    assert_eq!(b.groups.len(), 2);
    let refs: Vec<String> = b.items.iter().map(|i| i.short_ref()).collect();
    for r in ["d1", "d2", "d3", "n1", "n5", "c1", "i1"] {
        assert!(refs.contains(&r.to_string()), "{r} in {refs:?}");
    }
}

#[test]
fn the_eval_set_is_well_formed() {
    let eval: Value = serde_json::from_str(EVAL).unwrap();
    let tasks = eval["tasks"].as_array().unwrap();
    assert!((6..=10).contains(&tasks.len()));
    for t in tasks {
        assert!(t["id"].as_str().is_some_and(|s| !s.is_empty()), "{t}");
        assert!(t["prompt"].as_str().is_some_and(|s| s.len() > 20), "{t}");
        assert!(t["check"]["kind"].as_str().is_some(), "{t}");
    }
}

#[tokio::test]
async fn broken_links_are_known_and_unsupported_types_are_unknown() {
    let w = world().await;
    let b = w.data().await;
    let broken = b.broken_links();
    assert_eq!(broken.len(), 1);
    assert_eq!(
        b.anchor_text(&broken[0].to_item, broken[0].to_element.as_deref()),
        "d3#Backoff"
    );
    // A link into a gantt chart's "element" is unknown, never broken.
    let gantt = uuid::Uuid::now_v7();
    let n1 = b.resolve_item("n1").unwrap().id.clone();
    let ops: Vec<Op> = serde_json::from_value(json!([
        { "type": "item.create", "itemId": gantt, "z": 20.0, "transform": { "x": 0.0, "y": 2000.0, "width": 400.0, "height": 200.0 },
          "content": { "kind": "diagram", "lang": "mermaid", "source": "gantt\n  title Plan\n  section A\n  Spike :a1, 2026-11-20, 3d" } },
        { "type": "link.add", "linkId": uuid::Uuid::now_v7(), "from": { "itemId": n1 }, "to": { "itemId": gantt, "element": "a1" }, "linkType": "describes" },
    ]))
    .unwrap();
    apply_as(&w.app, &w.board, &w.user, ops).await;
    let b = w.data().await;
    assert_eq!(
        b.broken_links().len(),
        1,
        "the gantt link is not counted broken"
    );
    assert_eq!(
        b.anchored(&gantt.to_string(), Some("a1")),
        Anchored::Unknown
    );
}

// --- access ---------------------------------------------------------------------

#[tokio::test]
async fn mcp_admits_only_a_live_agent_token() {
    let w = world().await;
    let call = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" });
    let (status, body) = post(&w.router, &[], call.clone()).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(
        body["detail"].as_str().unwrap().contains("Agents"),
        "points at where tokens are made: {body}"
    );

    // A signed-in browser's cookie is not read on /mcp at all.
    let browser = auth::create_session(
        &w.app.db,
        Kind::Browser,
        Some(&w.user),
        None,
        None,
        Some("Safari"),
    )
    .await
    .unwrap();
    let cookie = format!("VISARIUM_SESSION={browser}");
    assert_eq!(
        post(&w.router, &[("cookie", &cookie)], call.clone())
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    // Nor is a browser session's token accepted as a bearer.
    assert_eq!(
        post(
            &w.router,
            &[("authorization", &format!("Bearer {browser}"))],
            call.clone()
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );

    let auth = format!("Bearer {}", w.token);
    assert_eq!(
        post(&w.router, &[("authorization", &auth)], call.clone())
            .await
            .0,
        StatusCode::OK
    );
    sqlx::query("DELETE FROM session WHERE kind = 'agent'")
        .execute(&w.app.db)
        .await
        .unwrap();
    let (status, body) = post(&w.router, &[("authorization", &auth)], call.clone()).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(
        body["detail"].as_str().unwrap().contains("revoked"),
        "{body}"
    );

    // Deactivation ends every token of the account.
    let token = agent_token(&w.app, &w.user, "second").await;
    visarium::auth::end_sessions_of(&w.app.db, &w.user, None)
        .await
        .unwrap();
    assert_eq!(
        post(
            &w.router,
            &[("authorization", &format!("Bearer {token}"))],
            call
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn single_user_mode_needs_no_token_on_loopback_only() {
    let (config, dir) = config(true);
    let app = visarium::open(config).await.unwrap();
    let router = visarium::router(app);
    let call = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "desk", "arguments": {} } });
    let (status, body) = post(&router, &[], call.clone()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["result"]["isError"], false);
    let mut req = Request::builder()
        .method("POST")
        .uri("/mcp")
        .header(header::HOST, "evil.example")
        .header(header::CONTENT_TYPE, "application/json");
    req = req.header("x-test", "1");
    let res = router
        .clone()
        .oneshot(req.body(Body::from(call.to_string())).unwrap())
        .await
        .unwrap();
    assert_eq!(
        res.status(),
        StatusCode::FORBIDDEN,
        "DNS rebinding is refused"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn the_protocol_is_stateless_json_rpc() {
    let w = world().await;
    let auth = format!("Bearer {}", w.token);
    // No initialize first: any call stands alone.
    let text = w.ok("board_read", json!({ "board": "Offline sync" })).await;
    assert!(text.starts_with("# Offline sync"), "{text}");

    let tools = w.rpc("tools/list", json!({})).await;
    assert_eq!(tools["tools"].as_array().unwrap().len(), 15);
    assert!(tools["ttlMs"].as_u64().unwrap() > 0);
    for t in tools["tools"].as_array().unwrap() {
        assert!(
            t["description"].as_str().unwrap().len() > 40,
            "{} is described",
            t["name"]
        );
        assert_eq!(t["inputSchema"]["type"], "object");
    }
    let deletes = tools["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "item_delete")
        .unwrap();
    assert_eq!(deletes["annotations"]["destructiveHint"], true);

    // Older clients still say initialize, and get the old handshake.
    let init = w.rpc("initialize", json!({ "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "t", "version": "1" } })).await;
    assert_eq!(init["protocolVersion"], "2025-06-18");
    assert_eq!(init["serverInfo"]["name"], "visarium");

    // A 2026-07-28 client discovers: a DiscoverResult with every required
    // field, or it falls back to initialize and can no longer ask its person
    // anything mid-call (design.md, the fresh-session run).
    let found = w.rpc("server/discover", json!({})).await;
    assert_eq!(found["resultType"], "complete");
    assert_eq!(found["supportedVersions"], json!([visarium::agent::PROTOCOL]));
    assert!(found["capabilities"]["tools"].is_object());
    assert!(found["ttlMs"].is_u64());
    assert_eq!(found["cacheScope"], "public");
    assert_eq!(found["_meta"]["io.modelcontextprotocol/serverInfo"]["name"], "visarium");
    assert!(found.get("protocolVersion").is_none() && found.get("serverInfo").is_none());
    // Every result says it is complete; lists say how they may be cached.
    let listed = w.rpc("tools/list", json!({})).await;
    assert_eq!(listed["resultType"], "complete");
    assert_eq!(listed["cacheScope"], "private", "the list depends on the caller's grant");
    assert_eq!(w.rpc("ping", json!({})).await["resultType"], "complete");

    let (status, _) = post(
        &w.router,
        &[("authorization", &auth)],
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::ACCEPTED,
        "a notification gets no answer"
    );
    let (status, _) = post(
        &w.router,
        &[("authorization", &auth), ("mcp-method", "tools/call")],
        json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "Mcp-Method must match the body"
    );
    let (status, _) = post(
        &w.router,
        &[("authorization", &auth), ("origin", "https://evil.example")],
        json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/list" }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (_, body) = post(
        &w.router,
        &[("authorization", &auth)],
        json!({ "jsonrpc": "2.0", "id": 4, "method": "nope" }),
    )
    .await;
    assert_eq!(body["error"]["code"], -32601);
    let unknown = w.fails("frobnicate", json!({})).await;
    assert!(
        unknown.contains("board_read"),
        "an unknown tool names the real ones"
    );
}

#[tokio::test]
async fn the_agent_is_told_how_to_work() {
    let w = world().await;
    let init = w.rpc("server/discover", json!({})).await;
    let instructions = init["instructions"].as_str().unwrap();
    assert!(instructions.contains("A link from A to B of type `describes` means A describes B"));
    assert!(instructions.contains("d2#Server"));
    assert!(instructions.contains("whole interface") && instructions.contains("which capability is missing"));
    let listed = w.rpc("resources/list", json!({})).await;
    assert_eq!(listed["resources"][0]["uri"], "visarium://guide");
    let guide = w
        .rpc("resources/read", json!({ "uri": "visarium://guide" }))
        .await;
    let guide = guide["contents"][0]["text"].as_str().unwrap();
    assert!(guide.contains("## When a tool is missing") && guide.contains("For example:"));
    assert!(guide.contains("\"centerpiece\": \"g1\""), "the guide shows setting a centerpiece");
    // Every tool, the granted ones included, has an example call.
    w.grant(true).await;
    for t in w.rpc("tools/list", json!({})).await["tools"]
        .as_array()
        .unwrap()
    {
        let name = t["name"].as_str().unwrap();
        assert!(
            guide.contains(&format!("- {name} {{")),
            "the guide has an example call for {name}"
        );
    }
}

#[tokio::test]
async fn agent_changes_are_credited_to_the_agent_and_its_person() {
    let w = world().await;
    w.ok("tasks", json!({ "board": "Offline sync", "ref": "c1", "set": [{ "task": "t6", "state": "done" }], "by": "someone-else" })).await;
    let b = w.data().await;
    let list = b.checklist(b.resolve_item("c1").unwrap()).unwrap();
    let t6 = list.tasks.iter().find(|t| t.id == "t6").unwrap();
    assert_eq!(
        (t6.by.as_deref(), t6.by_agent.as_deref()),
        (Some(w.user.as_str()), Some("Claude Code on laptop"))
    );
    let (actor, agent): (String, String) = sqlx::query_as("SELECT actor_id, actor_agent FROM canvas_operation WHERE canvas_id = ? ORDER BY revision DESC LIMIT 1")
        .bind(&w.board)
        .fetch_one(&w.app.db)
        .await
        .unwrap();
    assert_eq!(
        (actor, agent),
        (w.user.clone(), "Claude Code on laptop".to_string())
    );
    let read = w
        .ok("item_read", json!({ "board": "Offline sync", "ref": "c1" }))
        .await;
    assert!(
        read.contains("c1/t6 [done] Show an offline indicator — Claude Code on laptop for Ada"),
        "{read}"
    );
}

#[tokio::test]
#[ignore = "prints what an agent sees, for reading by eye"]
async fn show_reads() {
    let w = world().await;
    for (tool, args) in [
        ("desk", json!({})),
        ("board_read", json!({ "board": "Offline sync" })),
        ("item_read", json!({ "board": "Offline sync", "ref": "d2" })),
        ("item_read", json!({ "board": "Offline sync", "ref": "c1" })),
        (
            "trace",
            json!({ "board": "Offline sync", "ref": "d1#OpQueue" }),
        ),
        ("trace", json!({ "board": "Offline sync", "ref": "c1" })),
        ("search", json!({ "query": "IndexedDB" })),
        (
            "changes",
            json!({ "board": "Offline sync", "since_rev": 14 }),
        ),
    ] {
        println!("===== {tool} {args}\n{}\n", w.ok(tool, args.clone()).await);
    }
}

// --- reading ----------------------------------------------------------------------

fn note_op(id: uuid::Uuid, x: f64, y: f64, source: &str, group: Option<uuid::Uuid>) -> Value {
    json!({ "type": "item.create", "itemId": id, "z": 1.0, "groupId": group,
        "transform": { "x": x, "y": y, "width": 300.0, "height": 120.0 }, "content": { "kind": "note", "source": source } })
}

#[tokio::test]
async fn refs_resolve_and_say_what_exists_when_they_do_not() {
    let w = world().await;
    let err = w
        .fails("item_read", json!({ "board": "Offline sync", "ref": "d9" }))
        .await;
    assert!(err.contains("d1, d2, d3"), "{err}");
    let err = w
        .fails("item_read", json!({ "board": "Offline sync", "ref": "zz" }))
        .await;
    assert!(err.contains("kind letter"), "{err}");
    let by_id = w.data().await.resolve_item("d2").unwrap().id.clone();
    assert!(
        w.ok("item_read", json!({ "board": w.board, "ref": by_id }))
            .await
            .starts_with("## d2")
    );
    // Two boards of one name: the error lists both, with ids.
    let other = fixture_board(&w.app, &w.user, &w.dir).await;
    let err = w
        .fails("board_read", json!({ "board": "offline SYNC" }))
        .await;
    assert!(err.contains(&w.board) && err.contains(&other), "{err}");
    let err = w.fails("board_read", json!({ "board": "Nope" })).await;
    assert!(
        err.contains("\"Offline sync\""),
        "an unknown board lists real ones: {err}"
    );
}

#[tokio::test]
async fn the_desk_lists_boards_newest_first() {
    let w = world().await;
    let empty = uuid::Uuid::now_v7().to_string();
    sqlx::query("INSERT INTO canvas (id, title, updated_at) VALUES (?, 'Scratch', '2020-01-01T00:00:00.000Z')").bind(&empty).execute(&w.app.db).await.unwrap();
    let desk = w.ok("desk", json!({})).await;
    let first = desk.find("\"Offline sync\"").unwrap();
    assert!(
        first < desk.find("\"Scratch\"").unwrap(),
        "most recently changed first:\n{desk}"
    );
    assert!(
        desk.contains("3 diagrams, 5 notes, 1 checklist, 1 image"),
        "{desk}"
    );
    assert!(desk.contains("5 open tasks, 1 blocked"), "{desk}");
}

#[tokio::test]
async fn the_overview_is_a_table_of_contents() {
    let w = world().await;
    let o = w.ok("board_read", json!({ "board": "Offline sync" })).await;
    for want in [
        "# Offline sync · rev 18 · 10 items · 6 links · 1 broken",
        "## Frame \"Current architecture\" (g1)",
        "## Frame \"Proposed flow\" (g2)",
        "## Loose",
        "d1  plantuml class \"Domain model\" · 7 elements: BoardSync, CanvasDocument, OpQueue, Snapshot, +3",
        "← n1 describes d1#OpQueue",
        "c1  checklist \"Offline sync plan\" · 3/8 done · 1 blocked (t4 \"Decide the IndexedDB schema\")",
        "- n4 describes d3#Backoff: d3 no longer declares Backoff",
    ] {
        assert!(o.contains(want), "missing {want:?} in\n{o}");
    }
    assert!(
        !o.contains("@startuml") && !o.contains("flowchart TD"),
        "no source in the overview"
    );
    assert!(o.len() < visarium::agent::read::OVERVIEW_BUDGET_CHARS);
}

#[tokio::test]
async fn a_large_board_stays_in_budget_and_says_how_to_read_the_rest() {
    let w = world().await;
    let mut ops = vec![];
    for g in 0..4 {
        let group = uuid::Uuid::now_v7();
        ops.push(json!({ "type": "group.create", "groupId": group, "memberIds": [], "label": format!("Area {g}"), "frame": true }));
        for n in 0..50 {
            ops.push(note_op(
                uuid::Uuid::now_v7(),
                5000.0 + g as f64 * 400.0,
                n as f64 * 150.0,
                &format!("# Note {g}.{n}\nfiller words here"),
                Some(group),
            ));
        }
    }
    apply_as(
        &w.app,
        &w.board,
        &w.user,
        serde_json::from_value(Value::Array(ops)).unwrap(),
    )
    .await;
    let o = w.ok("board_read", json!({ "board": "Offline sync" })).await;
    assert!(
        o.len() <= visarium::agent::read::OVERVIEW_BUDGET_CHARS + 600,
        "{} chars",
        o.len()
    );
    assert!(
        o.contains("board_read(board: \"Offline sync\", focus: \"g"),
        "{o}"
    );
    let focused = w
        .ok(
            "board_read",
            json!({ "board": "Offline sync", "focus": "g6" }),
        )
        .await;
    assert_eq!(
        focused.matches("\nn").count(),
        50,
        "a focused read lists the whole frame:\n{focused}"
    );
}

#[tokio::test]
async fn an_item_reads_in_full_and_long_sources_in_windows() {
    let w = world().await;
    let d2 = w
        .ok("item_read", json!({ "board": "Offline sync", "ref": "d2" }))
        .await;
    assert!(d2.contains("Elements (3): Client, Server, Store"), "{d2}");
    assert!(
        d2.contains("- Client → Server: hello(sinceRevision)"),
        "{d2}"
    );
    assert!(d2.contains("- Server: ← n3 describes"), "{d2}");
    assert!(d2.contains("item_edit with base_rev 0"), "{d2}");
    let c1 = w
        .ok("item_read", json!({ "board": "Offline sync", "ref": "c1" }))
        .await;
    assert!(
        c1.contains("- c1/t4 [blocked] Decide the IndexedDB schema — Ada"),
        "{c1}"
    );

    let long: String = (1..=340).map(|n| format!("line {n}\n")).collect();
    apply_as(
        &w.app,
        &w.board,
        &w.user,
        serde_json::from_value(json!([note_op(
            uuid::Uuid::now_v7(),
            0.0,
            5000.0,
            &long,
            None
        )]))
        .unwrap(),
    )
    .await;
    let first = w
        .ok("item_read", json!({ "board": "Offline sync", "ref": "n6" }))
        .await;
    assert!(
        first.contains("lines 1–100 of 340")
            && first.contains(" 100  line 100")
            && !first.contains("line 101"),
        "{first}"
    );
    assert!(
        first.contains("item_read(ref: \"n6\", offset: 100)"),
        "{first}"
    );
    let second = w
        .ok(
            "item_read",
            json!({ "board": "Offline sync", "ref": "n6", "offset": 100 }),
        )
        .await;
    assert!(
        second.contains("lines 101–200 of 340") && second.contains(" 101  line 101"),
        "{second}"
    );
}

#[tokio::test]
async fn trace_gathers_an_element_and_marks_name_matches() {
    let w = world().await;
    // OpQueue named in a task too, to be found as a match, not a link.
    let c1 = w.data().await.resolve_item("c1").unwrap().id.clone();
    apply_as(&w.app, &w.board, &w.user, serde_json::from_value(json!([
        { "type": "task.add", "itemId": c1, "task": { "id": "t9", "text": "Persist OpQueue across reloads", "state": "todo" } },
    ])).unwrap()).await;
    let t = w
        .ok(
            "trace",
            json!({ "board": "Offline sync", "ref": "d1#OpQueue" }),
        )
        .await;
    assert!(
        t.contains("- BoardSync → OpQueue: drains")
            && t.contains("- OpQueue → CanvasDocument: applies"),
        "{t}"
    );
    assert!(
        t.contains("- n1 describes it — note \"Why OpQueue is per tab\""),
        "{t}"
    );
    assert!(
        t.contains("Name matches elsewhere (the same name, not a link):")
            && t.contains("c1/t9 [todo] \"Persist OpQueue across reloads\" mentions OpQueue"),
        "{t}"
    );
    assert!(
        !t.contains("n1 note \"Why OpQueue is per tab\" mentions"),
        "a linked note is not repeated as a match:\n{t}"
    );
    let item = w
        .ok("trace", json!({ "board": "Offline sync", "ref": "c1" }))
        .await;
    assert!(
        item.contains("- → implements d2 — plantuml sequence \"Reconnect\""),
        "{item}"
    );
}

#[tokio::test]
async fn search_finds_text_across_boards_within_a_cap() {
    let w = world().await;
    let s = w.ok("search", json!({ "query": "RetryLoop" })).await;
    assert!(
        s.contains("d3 (mermaid diagram)"),
        "an element name is found in its diagram's source: {s}"
    );
    let s = w.ok("search", json!({ "query": "airplane" })).await;
    assert!(s.contains("c1 (checklist)"), "task text is found: {s}");
    // Another person's board is still the person's: every member reaches every board.
    let notes: Vec<Value> = (0..25)
        .map(|n| {
            note_op(
                uuid::Uuid::now_v7(),
                0.0,
                6000.0 + n as f64 * 200.0,
                &format!("widget {n}"),
                None,
            )
        })
        .collect();
    apply_as(
        &w.app,
        &w.board,
        &w.user,
        serde_json::from_value(Value::Array(notes)).unwrap(),
    )
    .await;
    let s = w.ok("search", json!({ "query": "widget" })).await;
    assert!(
        s.starts_with("25 matches") && s.contains("5 more not shown"),
        "{s}"
    );
    let none = w
        .ok("search", json!({ "query": "nothing-like-this" }))
        .await;
    assert!(none.starts_with("Nothing matches"), "{none}");
}

#[tokio::test]
async fn changes_read_as_sentences() {
    let w = world().await;
    let since = w.revision().await;
    let ana = person(&w.app, "ana", "Ana").await;
    let b = w.data().await;
    let (c1, d2) = (
        b.resolve_item("c1").unwrap().id.clone(),
        b.resolve_item("d2").unwrap().id.clone(),
    );
    apply_as(
        &w.app,
        &w.board,
        &ana,
        serde_json::from_value(json!([
            { "type": "task.set", "itemId": c1, "taskId": "t5", "state": "doing" },
        ]))
        .unwrap(),
    )
    .await;
    apply_as(
        &w.app,
        &w.board,
        &w.user,
        serde_json::from_value(json!([
            { "type": "item.source", "itemId": d2, "source": "@startuml\nA -> B\n@enduml" },
        ]))
        .unwrap(),
    )
    .await;
    let c = w
        .ok(
            "changes",
            json!({ "board": "Offline sync", "since_rev": since }),
        )
        .await;
    assert!(c.contains("Ana set c1/t5 to doing"), "{c}");
    assert!(c.contains("Ada edited the source of d2"), "{c}");
    let none = w
        .ok(
            "changes",
            json!({ "board": "Offline sync", "since_rev": since + 2 }),
        )
        .await;
    assert!(none.starts_with("Nothing has changed"), "{none}");
}

#[tokio::test]
async fn changes_narrate_collision_and_the_pushes_it_causes() {
    let w = world().await;
    let since = w.revision().await;
    let b = w.data().await;
    let (n1, d1) = (b.resolve_item("n1").unwrap(), b.resolve_item("d1").unwrap());
    let (n1_id, d1_id, x, y) = (n1.id.clone(), d1.id.clone(), n1.x, n1.y);
    let mut on = vec![json!({ "type": "item.collides", "itemId": n1_id, "collides": true })];
    // n1 sits in a frame; a group's setting wins for its members.
    if let Some(g) = &n1.group_id {
        on.push(json!({ "type": "group.collides", "groupId": g, "collides": true }));
    }
    apply_as(&w.app, &w.board, &w.user, serde_json::from_value(json!(on)).unwrap()).await;
    // d1 is dropped right on top of n1.
    apply_as(&w.app, &w.board, &w.user, serde_json::from_value(json!([{ "type": "item.transform", "itemId": d1_id,
        "transform": { "x": x, "y": y, "width": 480.0, "height": 360.0, "rotation": 0.0 } }])).unwrap()).await;
    let c = w.ok("changes", json!({ "board": "Offline sync", "since_rev": since })).await;
    assert!(c.contains("turned collision on for n1"), "{c}");
    assert!(c.contains("moved or resized d1") && c.contains("n1"), "{c}");
    let after = w.data().await;
    let n1 = after.resolve_item("n1").unwrap();
    assert!((n1.x, n1.y) != (x, y), "n1 was pushed aside");
}

#[tokio::test]
async fn images_are_viewed_and_everything_else_is_read() {
    let w = world().await;
    let r = w.rpc("tools/call", json!({ "name": "item_view", "arguments": { "board": "Offline sync", "ref": "i1", "width": 256 } })).await;
    assert_eq!(r["isError"], false, "{r}");
    assert_eq!(r["content"][1]["type"], "image");
    assert!(r["content"][1]["data"].as_str().unwrap().len() > 100);
    let err = w
        .fails("item_view", json!({ "board": "Offline sync", "ref": "d2" }))
        .await;
    assert!(err.contains("item_read"), "{err}");
}

#[tokio::test]
async fn reading_changes_nothing() {
    let w = world().await;
    let before = w.revision().await;
    let logged: i64 = sqlx::query_scalar("SELECT count(*) FROM canvas_operation")
        .fetch_one(&w.app.db)
        .await
        .unwrap();
    for (tool, args) in [
        ("desk", json!({})),
        ("board_read", json!({ "board": "Offline sync" })),
        ("item_read", json!({ "board": "Offline sync", "ref": "d1" })),
        (
            "trace",
            json!({ "board": "Offline sync", "ref": "d1#OpQueue" }),
        ),
        ("search", json!({ "query": "queue" })),
        (
            "changes",
            json!({ "board": "Offline sync", "since_rev": 0 }),
        ),
        ("item_view", json!({ "board": "Offline sync", "ref": "i1" })),
    ] {
        w.ok(tool, args).await;
    }
    assert_eq!(w.revision().await, before);
    let after: i64 = sqlx::query_scalar("SELECT count(*) FROM canvas_operation")
        .fetch_one(&w.app.db)
        .await
        .unwrap();
    assert_eq!(after, logged);
}

// --- writing ------------------------------------------------------------------------

#[tokio::test]
async fn a_note_is_created_beside_its_subject_and_linked_in_one_call() {
    let w = world().await;
    let text = w
        .ok("item_create", json!({ "board": "Offline sync", "kind": "note", "source": "OpQueue drains on reconnect.", "near": "d1",
            "link": { "type": "describes", "to": "d1#OpQueue" } }))
        .await;
    assert!(text.starts_with("Created n6 (note) ") && text.contains(" d1 · link to d1#OpQueue "), "{text}");
    assert!(text.contains("crosses nothing"), "{text}");
    assert!(text.contains("Linked n6 describes d1#OpQueue."), "{text}");
    let b = w.data().await;
    let n6 = b.resolve_item("n6").unwrap();
    let r = visarium::agent::place::Rect::of(n6);
    for other in b.items.iter().filter(|i| i.id != n6.id) {
        let o = visarium::agent::place::Rect::of(other);
        let apart = r.x + r.w / 2.0 <= o.x - o.w / 2.0
            || o.x + o.w / 2.0 <= r.x - r.w / 2.0
            || r.y + r.h / 2.0 <= o.y - o.h / 2.0
            || o.y + o.h / 2.0 <= r.y - r.h / 2.0;
        assert!(apart, "n6 overlaps {}", other.short_ref());
    }
    assert!(
        b.links
            .iter()
            .any(|l| l.from_item == n6.id && l.to_element.as_deref() == Some("OpQueue"))
    );

    let before = w.revision().await;
    let err = w
        .fails("item_create", json!({ "board": "Offline sync", "kind": "note", "source": "x", "link": { "type": "describes", "to": "d1#OpQeue" } }))
        .await;
    assert!(
        err.contains("declares no element 'OpQeue'") && err.contains("OpQueue"),
        "{err}"
    );
    assert_eq!(
        w.revision().await,
        before,
        "nothing is created when the link is refused"
    );
}

#[tokio::test]
async fn a_link_can_end_at_one_checklist_task() {
    let w = world().await;
    let text = w
        .ok("link", json!({ "board": "Offline sync", "from": "c1/t4", "to": "d1#OpQueue", "type": "implements" }))
        .await;
    assert!(text.contains("c1/t4 implements d1#OpQueue"), "{text}");
    let b = w.data().await;
    assert!(b.links.iter().any(|l| l.from_element.as_deref() == Some("t4")));
    let err = w
        .fails("link", json!({ "board": "Offline sync", "from": "c1#t99", "to": "d1", "type": "implements" }))
        .await;
    assert!(err.contains("has no task 't99'") && err.contains("t4"), "{err}");
}

fn person_note(id: &str, x: f64, y: f64, w: f64, h: f64) -> Value {
    json!({ "type": "item.create", "itemId": id, "z": 1.0,
        "transform": { "x": x, "y": y, "width": w, "height": h, "rotation": 0.0 },
        "content": { "kind": "note", "source": "wall" } })
}

#[tokio::test]
async fn a_note_linked_to_an_element_is_placed_beside_where_it_is_drawn() {
    let w = world().await;
    let b = w.data().await;
    let d1 = b.resolve_item("d1").unwrap();
    // A browser drew BoardSync at d1's bottom left (layout 480 wide, as drawn).
    sqlx::query("UPDATE canvas_item SET element_boxes = ?, element_rev = revision WHERE id = ?")
        .bind(r#"{"width": 480, "elements": {"BoardSync": [0, 300, 80, 40]}}"#)
        .bind(&d1.id)
        .execute(&w.app.db)
        .await
        .unwrap();
    let text = w
        .ok("item_create", json!({ "board": "Offline sync", "kind": "note", "source": "Drains on reconnect.", "near": "d1",
            "link": { "type": "describes", "to": "d1#BoardSync" } }))
        .await;
    assert!(text.contains("link to d1#BoardSync") && text.contains("crosses nothing"), "{text}");
    let n = w.data().await.resolve_item("n6").unwrap().x;
    assert!(n < 0.0, "on BoardSync's side of d1, not the right: x = {n}\n{text}");
}

#[tokio::test]
async fn a_note_near_a_frame_is_outside_its_outline() {
    let w = world().await;
    w.ok("item_create", json!({ "board": "Offline sync", "kind": "note", "source": "About the flow.", "near": "g2" })).await;
    let b = w.data().await;
    let g2 = b.resolve_group("g2").unwrap().id.clone();
    let members: Vec<_> = b.items.iter().filter(|i| i.group_id.as_deref() == Some(g2.as_str())).map(visarium::agent::place::Rect::of).collect();
    let outline = visarium::agent::place::Rect::around(&members).unwrap();
    let pad = visarium::collision::GROUP_PAD;
    let n = visarium::agent::place::Rect::of(b.resolve_item("n6").unwrap());
    let outside = n.right() <= outline.left() - pad || n.left() >= outline.right() + pad
        || n.bottom() <= outline.top() - pad || n.top() >= outline.bottom() + pad;
    assert!(outside, "{n:?} is inside g2's outline {outline:?}");
}

#[tokio::test]
async fn an_unavoidable_crossing_is_reported() {
    let w = world().await;
    // A note walled in on all four sides, far from everything else.
    let ids: Vec<String> = (0..5).map(|_| uuid::Uuid::now_v7().to_string()).collect();
    let ops = json!([
        person_note(&ids[0], 10000.0, 0.0, 200.0, 100.0),
        person_note(&ids[1], 10000.0, -174.0, 1000.0, 200.0),
        person_note(&ids[2], 10000.0, 174.0, 1000.0, 200.0),
        person_note(&ids[3], 9776.0, 0.0, 200.0, 548.0),
        person_note(&ids[4], 10224.0, 0.0, 200.0, 548.0),
    ]);
    apply_as(&w.app, &w.board, &w.user, serde_json::from_value(ops).unwrap()).await;
    let text = w
        .ok("item_create", json!({ "board": "Offline sync", "kind": "note", "source": "Walled.", "near": "n6",
            "link": { "type": "comments", "to": "n6" } }))
        .await;
    assert!(text.contains("link to n6") && text.contains("crosses n"), "{text}");
    assert!(text.contains("no nearby spot was free of crossings"), "{text}");
}

#[tokio::test]
async fn an_agents_items_collide_until_fixed_in_place() {
    let w = world().await;
    w.ok("item_create", json!({ "board": "Offline sync", "kind": "note", "source": "Mine.", "near": "c1" })).await;
    let b = w.data().await;
    let n6 = b.resolve_item("n6").unwrap();
    assert!(n6.collides, "an agent's note has collision on");
    let (x, y) = (n6.x, n6.y);
    let text = w.ok("arrange", json!({ "board": "Offline sync", "refs": ["n6"], "collides": false })).await;
    assert!(text.contains("collision off"), "{text}");
    let after = w.data().await;
    let n6 = after.resolve_item("n6").unwrap();
    assert!(!n6.collides && (n6.x, n6.y) == (x, y), "fixed, and not moved");
}

#[tokio::test]
async fn six_notes_are_laid_out_as_a_grid_of_three() {
    let w = world().await;
    for i in 0..6 {
        w.ok("item_create", json!({ "board": "Offline sync", "kind": "note", "source": format!("Card {i}"), "near": "c1" })).await;
    }
    let refs: Vec<String> = (6..12).map(|n| format!("n{n}")).collect();
    let text = w.ok("arrange", json!({ "board": "Offline sync", "refs": refs, "layout": "grid", "columns": 3, "below": "c1" })).await;
    assert!(text.contains("laid out in a grid of 3 columns below c1"), "{text}");
    let b = w.data().await;
    let rects: Vec<_> = refs.iter().map(|r| visarium::agent::place::Rect::of(b.resolve_item(r).unwrap())).collect();
    let tops: std::collections::BTreeSet<i64> = rects.iter().map(|r| r.top().round() as i64).collect();
    assert_eq!(tops.len(), 2, "two rows, top-aligned: {rects:?}");
    let mut row: Vec<_> = rects.iter().filter(|r| r.top().round() as i64 == *tops.first().unwrap()).collect();
    row.sort_by(|a, b| a.x.total_cmp(&b.x));
    assert_eq!(row.len(), 3);
    assert_eq!((row[1].left() - row[0].right()).round(), (row[2].left() - row[1].right()).round(), "an even gap");
    let c1 = visarium::agent::place::Rect::of(b.resolve_item("c1").unwrap());
    assert!(rects.iter().all(|r| r.top() >= c1.bottom()), "below c1");
}

#[tokio::test]
async fn group_create_frames_packs_and_pushes_aside() {
    let w = world().await;
    w.ok("item_create", json!({ "board": "Offline sync", "kind": "note", "source": "Under the list.", "below": "c1" })).await;
    // A column of c1 then i1 grows down over the agent's note below c1.
    let text = w
        .ok("group_create", json!({ "board": "Offline sync", "refs": ["c1", "i1"], "title": "Moodboard", "layout": "column" }))
        .await;
    assert!(text.starts_with("Grouped c1, i1 as g3 \"Moodboard\" (framed), laid out in a column"), "{text}");
    assert!(text.contains("Moved aside: n6"), "{text}");
    let b = w.data().await;
    let g3 = b.resolve_group("g3").unwrap();
    assert!(g3.frame && g3.collides && g3.label.as_deref() == Some("Moodboard"));
    let members: Vec<_> = b.items.iter().filter(|i| i.group_id.as_deref() == Some(g3.id.as_str())).collect();
    assert_eq!(members.len(), 2);
    let n6 = visarium::agent::place::Rect::of(b.resolve_item("n6").unwrap());
    for m in &members {
        assert!(!n6.overlaps(&visarium::agent::place::Rect::of(m), 0.0), "n6 still overlaps {}", m.short_ref());
    }

    // Taken from another group, and kept off what never moves.
    let text = w.ok("group_create", json!({ "board": "Offline sync", "refs": ["n1"], "title": "Solo" })).await;
    assert!(text.contains("n1 left g1"), "{text}");
    let b = w.data().await;
    let n1 = visarium::agent::place::Rect::of(b.resolve_item("n1").unwrap());
    for fixed in b.items.iter().filter(|i| !i.collides && i.short_ref() != "n1") {
        assert!(!n1.overlaps(&visarium::agent::place::Rect::of(fixed), 0.0), "n1 lands on {}", fixed.short_ref());
    }
}

#[tokio::test]
async fn placement_into_a_frame_and_below_a_diagram() {
    let w = world().await;
    let text = w
        .ok(
            "item_create",
            json!({ "board": "Offline sync", "kind": "note", "source": "framed", "in": "g2" }),
        )
        .await;
    assert!(text.contains("in g2"), "{text}");
    let b = w.data().await;
    let g2 = b.resolve_group("g2").unwrap().id.clone();
    assert_eq!(
        b.resolve_item("n6").unwrap().group_id.as_deref(),
        Some(g2.as_str()),
        "it is a member of g2"
    );
    w.ok("item_create", json!({ "board": "Offline sync", "kind": "checklist", "title": "Plan", "tasks": ["a", "b"], "below": "d2",
        "link": { "type": "implements", "to": "d2" } })).await;
    let b = w.data().await;
    let (c2, d2) = (b.resolve_item("c2").unwrap(), b.resolve_item("d2").unwrap());
    assert!(c2.y - c2.height / 2.0 >= d2.y + d2.height / 2.0, "below d2");
    let list = b.checklist(c2).unwrap();
    assert_eq!(
        list.tasks.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
        ["t1", "t2"]
    );
}

#[tokio::test]
async fn source_edits_are_exact_guarded_and_report_their_effect() {
    let w = world().await;
    let text = w.ok("item_edit", json!({ "board": "Offline sync", "ref": "d3", "base_rev": 0, "old": "RetryLoop[", "new": "RetryPolicy[" })).await;
    // Only the declaration changed: the edge still names RetryLoop, which now
    // has no shape but is still a node. Rename every use for a real rename.
    assert!(
        text.contains("Edited d3") && text.contains("Elements: +RetryPolicy"),
        "{text}"
    );
    let text = w.ok("item_edit", json!({ "board": "Offline sync", "ref": "d3", "base_rev": 1,
        "source": "flowchart TD\n  Start[Edit arrives] --> Check{Base revision current?}\n  Check -->|yes| Apply[Apply and commit]\n  Check -->|no| RetryPolicy[Re-read and retry]\n  RetryPolicy --> Check\n  Apply --> Done[Broadcast to peers]" })).await;
    assert!(text.contains("Elements: −RetryLoop"), "{text}");
    assert!(
        text.contains("Link n5 describes d3#RetryLoop is now broken"),
        "{text}"
    );

    let err = w.fails("item_edit", json!({ "board": "Offline sync", "ref": "d3", "base_rev": 2, "old": "Check", "new": "Verify" })).await;
    assert!(
        err.contains("occurs 4 times") && err.contains("lines 2, 3, 4, 5"),
        "{err}"
    );

    // Someone else edits first; the agent's stale edit is refused with who and what.
    let ana = person(&w.app, "ana", "Ana").await;
    let d3 = w.data().await.resolve_item("d3").unwrap().id.clone();
    apply_as(
        &w.app,
        &w.board,
        &ana,
        serde_json::from_value(
            json!([{ "type": "item.source", "itemId": d3, "source": "flowchart TD\n  A --> B" }]),
        )
        .unwrap(),
    )
    .await;
    let err = w.fails("item_edit", json!({ "board": "Offline sync", "ref": "d3", "base_rev": 2, "source": "flowchart TD\n  X --> Y" })).await;
    assert!(
        err.contains("d3 changed since rev 2")
            && err.contains("it is at rev 3")
            && err.contains("by Ana: edited the source of d3"),
        "{err}"
    );

    let text = w.ok("item_edit", json!({ "board": "Offline sync", "ref": "d3", "base_rev": 3, "source": "flowchart TD\n  A --> B\n  B --> C[unclosed\n" })).await;
    assert!(
        text.contains("line 3 does not parse"),
        "a broken diagram is saved, with a warning: {text}"
    );
    let b = w.data().await;
    assert!(
        b.resolve_item("d3")
            .unwrap()
            .body
            .as_deref()
            .unwrap()
            .contains("unclosed")
    );
}

#[tokio::test]
async fn checklist_batches_touch_only_their_tasks() {
    let w = world().await;
    let ana = person(&w.app, "ana", "Ana").await;
    let c1 = w.data().await.resolve_item("c1").unwrap().id.clone();
    // Ana changes t8 while the agent's batch is on its way.
    apply_as(
        &w.app,
        &w.board,
        &ana,
        serde_json::from_value(
            json!([{ "type": "task.set", "itemId": c1, "taskId": "t8", "state": "doing" }]),
        )
        .unwrap(),
    )
    .await;
    let text = w
        .ok("tasks", json!({ "board": "Offline sync", "ref": "c1",
            "set": [{ "task": "c1/t5", "state": "done" }, { "task": "t6", "state": "done" }, { "task": "t7", "state": "done" }],
            "add": [{ "text": "Write the runbook", "after": "t7" }], "remove": ["t1"] }))
        .await;
    assert!(
        text.contains("added c1/t9 \"Write the runbook\"") && text.contains("removed c1/t1"),
        "{text}"
    );
    let b = w.data().await;
    let list = b.checklist(b.resolve_item("c1").unwrap()).unwrap();
    let state = |id: &str| {
        list.tasks
            .iter()
            .find(|t| t.id == id)
            .map(|t| t.state.clone())
    };
    assert_eq!(
        (state("t5"), state("t6"), state("t7")),
        (
            Some("done".into()),
            Some("done".into()),
            Some("done".into())
        )
    );
    assert_eq!(state("t8"), Some("doing".into()), "Ana's change stands");
    assert_eq!(state("t1"), None);
    let after_t7 = list.tasks.iter().position(|t| t.id == "t7").unwrap();
    assert_eq!(list.tasks[after_t7 + 1].id, "t9");

    let before = w.revision().await;
    let err = w.fails("tasks", json!({ "board": "Offline sync", "ref": "c1", "set": [{ "task": "t2", "state": "done" }, { "task": "t99", "state": "done" }] })).await;
    assert!(err.contains("no task t99"), "{err}");
    assert_eq!(
        w.revision().await,
        before,
        "a batch applies whole or not at all"
    );
}

#[tokio::test]
async fn links_are_made_retyped_repaired_and_removed() {
    let w = world().await;
    let text = w.ok("link", json!({ "board": "Offline sync", "from": "n2", "to": "d1#BoardSync", "type": "describes" })).await;
    assert!(
        text.contains("from comments to describes"),
        "an existing pair is retyped: {text}"
    );
    assert_eq!(w.data().await.links.len(), 6);
    w.ok(
        "unlink",
        json!({ "board": "Offline sync", "from": "n4", "to": "d3#Backoff" }),
    )
    .await;
    let text = w.ok("link", json!({ "board": "Offline sync", "from": "n4", "to": "d3#RetryLoop", "type": "describes" })).await;
    assert!(text.contains("Linked n4 describes d3#RetryLoop"), "{text}");
    assert!(w.data().await.broken_links().is_empty());
    let err = w
        .fails(
            "unlink",
            json!({ "board": "Offline sync", "from": "n1", "to": "c1" }),
        )
        .await;
    assert!(
        err.contains("n1 describes d1#OpQueue"),
        "the error lists n1's real links: {err}"
    );
}

#[tokio::test]
async fn arranging_and_deleting() {
    let w = world().await;
    w.ok(
        "arrange",
        json!({ "board": "Offline sync", "refs": ["n4", "n5"], "out_of_group": true }),
    )
    .await;
    let b = w.data().await;
    assert!(
        b.resolve_item("n4").unwrap().group_id.is_none()
            && b.resolve_item("n5").unwrap().group_id.is_none()
    );
    w.ok(
        "arrange",
        json!({ "board": "Offline sync", "refs": ["n4", "n5"], "in": "g1" }),
    )
    .await;
    let b = w.data().await;
    let g1 = b.resolve_group("g1").unwrap().id.clone();
    assert!(
        ["n4", "n5"]
            .iter()
            .all(|r| b.resolve_item(r).unwrap().group_id.as_deref() == Some(g1.as_str()))
    );

    let text = w
        .ok(
            "item_delete",
            json!({ "board": "Offline sync", "ref": "n5" }),
        )
        .await;
    assert!(
        text.contains("Deleted n5") && text.contains("n5 describes d3#RetryLoop"),
        "{text}"
    );
    assert!(
        text.contains("The retry loop re-reads"),
        "the content comes back, to recreate it: {text}"
    );
    let b = w.data().await;
    assert!(b.resolve_item("n5").is_err() && b.links.len() == 5);
}

#[tokio::test]
async fn a_retried_write_applies_once() {
    let w = world().await;
    let args =
        json!({ "board": "Offline sync", "kind": "note", "source": "once", "request_id": "r-1" });
    let first = w.ok("item_create", args.clone()).await;
    let second = w.ok("item_create", args).await;
    assert!(
        second.contains("Already done") && second.contains("Created n6"),
        "{second}"
    );
    assert!(first.contains("Created n6"));
    let notes = w
        .data()
        .await
        .items
        .iter()
        .filter(|i| i.kind == "note")
        .count();
    assert_eq!(notes, 6, "one note, not two");
}

#[tokio::test]
async fn a_runaway_agent_is_slowed() {
    let w = world().await;
    let limit = visarium::agent::AGENT_WRITES_PER_MINUTE;
    let mut refused = None;
    for n in 0..=limit {
        let r = w.rpc("tools/call", json!({ "name": "link", "arguments": { "board": "Offline sync", "from": "n1", "to": "d1#OpQueue", "type": "describes" } })).await;
        if r["isError"] == true {
            refused = Some((n, r["content"][0]["text"].as_str().unwrap().to_string()));
            break;
        }
    }
    let (n, text) = refused.expect("the limit applies");
    assert_eq!(n, limit);
    assert!(text.contains("Wait") && text.contains("seconds"), "{text}");
}

// --- presence ------------------------------------------------------------------------

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn next(ws: &mut Socket) -> Value {
    let wait = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            match ws.next().await.unwrap().unwrap() {
                tungstenite::Message::Text(t) => return serde_json::from_str::<Value>(&t).unwrap(),
                _ => continue,
            }
        }
    });
    wait.await.expect("a frame within 5 s")
}

/// The next frame that is not about how many viewers there are.
async fn next_frame(ws: &mut Socket) -> Value {
    loop {
        let f = next(ws).await;
        if f["t"] != "viewers" {
            return f;
        }
    }
}

#[tokio::test]
async fn people_see_an_agent_arrive_look_and_leave_and_viewers_see_none_of_it() {
    let w = world().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(visarium::serve(w.app.clone(), listener));

    // A member, by browser session cookie.
    let browser = auth::create_session(&w.app.db, Kind::Browser, Some(&w.user), None, None, None)
        .await
        .unwrap();
    let mut req = format!("ws://{addr}/ws/canvas/{}", w.board)
        .into_client_request()
        .unwrap();
    req.headers_mut().insert(
        "cookie",
        format!("VISARIUM_SESSION={browser}").parse().unwrap(),
    );
    let (mut member, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    member
        .send(
            json!({ "t": "hello", "protocolVersion": visarium::PROTOCOL_VERSION, "sinceRevision": 0 })
                .to_string()
                .into(),
        )
        .await
        .unwrap();
    assert_eq!(next(&mut member).await["t"], "welcome");

    // A share-link viewer of the same board.
    let share = uuid::Uuid::now_v7().to_string();
    sqlx::query("INSERT INTO share_link (id, canvas_id, token_hash) VALUES (?, ?, 'unused')")
        .bind(&share)
        .bind(&w.board)
        .execute(&w.app.db)
        .await
        .unwrap();
    let viewer_token = auth::create_session(&w.app.db, Kind::Share, None, Some(&share), None, None)
        .await
        .unwrap();
    let mut req = format!("ws://{addr}/ws/shared")
        .into_client_request()
        .unwrap();
    req.headers_mut().insert(
        "cookie",
        format!("VISARIUM_SHARE={viewer_token}").parse().unwrap(),
    );
    let (mut viewer, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    viewer
        .send(
            json!({ "t": "hello", "protocolVersion": visarium::PROTOCOL_VERSION, "sinceRevision": 0 })
                .to_string()
                .into(),
        )
        .await
        .unwrap();
    assert_eq!(next(&mut viewer).await["t"], "welcome");

    w.ok("board_read", json!({ "board": "Offline sync" })).await;
    let joined = next_frame(&mut member).await;
    assert_eq!(joined["t"], "presence");
    assert_eq!(joined["joined"][0]["kind"], "agent");
    assert_eq!(joined["joined"][0]["displayName"], "Claude Code on laptop");
    assert_eq!(joined["joined"][0]["person"], "Ada");
    let agent_id = joined["joined"][0]["actorId"].as_str().unwrap().to_string();

    w.ok("item_read", json!({ "board": "Offline sync", "ref": "d2" }))
        .await;
    let focus = next_frame(&mut member).await;
    let d2 = w.data().await.resolve_item("d2").unwrap().id.clone();
    assert_eq!(
        focus,
        json!({ "t": "focus", "actorId": agent_id, "itemId": d2, "verb": "reading" })
    );
    assert!(
        !focus.to_string().contains("@startuml"),
        "a focus frame carries no source"
    );

    // An edit: the member hears the operation and the focus; the viewer hears
    // the operation and nothing about the agent.
    w.ok(
        "tasks",
        json!({ "board": "Offline sync", "ref": "c1", "set": [{ "task": "t6", "state": "done" }] }),
    )
    .await;
    let op = next_frame(&mut member).await;
    assert_eq!(op["t"], "op");
    assert_eq!(op["operations"][0]["byAgent"], "Claude Code on laptop");
    assert_eq!(next_frame(&mut member).await["verb"], "editing");
    let seen = next_frame(&mut viewer).await;
    assert_eq!(
        seen["t"], "op",
        "the viewer's first frame after welcome is the change itself: {seen}"
    );

    // Quiet for longer than AGENT_QUIET_SECS: the agent leaves.
    let later = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + (visarium::realtime::AGENT_QUIET_SECS + 1) * 1000;
    w.app.rooms.sweep_agents_at(later);
    assert_eq!(
        next_frame(&mut member).await,
        json!({ "t": "presence", "left": [agent_id] })
    );

    // The viewer heard nothing more; a ping round trip proves the queue is empty.
    viewer
        .send(tungstenite::Message::Ping(vec![1].into()))
        .await
        .unwrap();
    let quiet = tokio::time::timeout(std::time::Duration::from_millis(300), async {
        loop {
            match viewer.next().await {
                Some(Ok(tungstenite::Message::Text(t))) => return Some(t.to_string()),
                Some(Ok(_)) => continue,
                _ => return None,
            }
        }
    })
    .await;
    assert!(
        !matches!(quiet, Ok(Some(_))),
        "the viewer received {quiet:?}"
    );
}

#[tokio::test]
async fn a_rename_says_exactly_how_to_move_its_links() {
    let w = world().await;
    let b = w.data().await;
    let d3 = b.resolve_item("d3").unwrap();
    let source = d3.body.clone().unwrap().replace("RetryLoop", "RetryPolicy");
    let text = w
        .ok(
            "item_edit",
            json!({ "board": "Offline sync", "ref": "d3", "base_rev": 0, "source": source }),
        )
        .await;
    assert!(
        text.contains("Elements: −RetryLoop, +RetryPolicy"),
        "{text}"
    );
    assert!(
        text.contains("unlink(from: \"n5\", to: \"d3#RetryLoop\"), then link(from: \"n5\", to: \"d3#RetryPolicy\", type: \"describes\")"),
        "{text}"
    );
}

#[tokio::test]
async fn a_local_agent_is_named_by_its_client() {
    let (config, dir) = config(true);
    let app = visarium::open(config).await.unwrap();
    let router = visarium::router(app.clone());
    let board = uuid::Uuid::now_v7().to_string();
    sqlx::query("INSERT INTO canvas (id, title) VALUES (?, 'Mine')")
        .bind(&board)
        .execute(&app.db)
        .await
        .unwrap();
    let create = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": { "name": "item_create", "arguments": { "board": "Mine", "kind": "checklist", "title": "x", "tasks": ["a"] } } });
    post(
        &router,
        &[("user-agent", "claude-code/2.1.181 (cli)")],
        create,
    )
    .await;
    let agent: String =
        sqlx::query_scalar("SELECT actor_agent FROM canvas_operation WHERE canvas_id = ?")
            .bind(&board)
            .fetch_one(&app.db)
            .await
            .unwrap();
    assert_eq!(agent, "Claude Code");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_task_ref_reads_its_checklist() {
    let w = world().await;
    let t = w
        .ok("trace", json!({ "board": "Offline sync", "ref": "c1/t5" }))
        .await;
    assert!(t.starts_with("## c1"), "{t}");
    let r = w
        .ok(
            "item_read",
            json!({ "board": "Offline sync", "ref": "c1/t5" }),
        )
        .await;
    assert!(
        r.contains("c1/t5 [todo] Resolve conflicts on replay"),
        "{r}"
    );
}

// --- board management (agents/board-management) --------------------------------

impl World {
    async fn grant(&self, on: bool) {
        sqlx::query("UPDATE session SET manage_boards = ? WHERE token_hash = ?")
            .bind(on)
            .bind(auth::hash_token(&self.token))
            .execute(&self.app.db)
            .await
            .unwrap();
    }
    async fn titles(&self) -> Vec<String> {
        sqlx::query_scalar("SELECT title FROM canvas ORDER BY created_at")
            .fetch_all(&self.app.db)
            .await
            .unwrap()
    }
}

const ELICIT: &str = "io.modelcontextprotocol/clientCapabilities";

#[tokio::test]
async fn board_tools_need_the_grant_and_say_where_to_turn_it_on() {
    let w = world().await;
    let names = |r: Value| -> Vec<String> {
        r["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect()
    };
    let off = names(w.rpc("tools/list", json!({})).await);
    assert!(!off.iter().any(|n| n.starts_with("board_") && n != "board_read"), "{off:?}");
    let refused = w.fails("board_create", json!({ "title": "Demo" })).await;
    assert!(refused.contains("Manage boards") && refused.contains("Settings → Agents"), "{refused}");
    assert_eq!(w.titles().await, ["Offline sync"], "the refusal changed nothing");

    // The grant applies from the next call, with no new token.
    w.grant(true).await;
    let on = names(w.rpc("tools/list", json!({})).await);
    for t in ["board_create", "board_rename", "board_duplicate", "board_delete"] {
        assert!(on.contains(&t.to_string()), "{t} in {on:?}");
    }
    let delete = w.rpc("tools/list", json!({})).await["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "board_delete")
        .cloned()
        .unwrap();
    assert_eq!(delete["annotations"]["destructiveHint"], true);
}

#[tokio::test]
async fn an_agent_creates_renames_and_duplicates_boards() {
    let w = world().await;
    w.grant(true).await;
    let made = w.ok("board_create", json!({ "title": "Demo" })).await;
    assert!(made.contains("Created board \"Demo\"") && !made.contains("Another board"), "{made}");
    let (owner, agent): (String, Option<String>) =
        sqlx::query_as("SELECT owner_id, created_by_agent FROM canvas WHERE title = 'Demo'")
            .fetch_one(&w.app.db)
            .await
            .unwrap();
    assert_eq!(owner, w.user, "owned by the agent's person");
    assert_eq!(agent.as_deref(), Some("Claude Code on laptop"));
    assert!(w.ok("desk", json!({})).await.contains("made by Claude Code on laptop for Ada"));

    // A shared title is made, and the agent is told to use the id.
    let again = w.ok("board_create", json!({ "title": "demo" })).await;
    assert!(again.contains("Another board is also called") && again.contains("by its id"), "{again}");

    let renamed = w.ok("board_rename", json!({ "board": "Offline sync", "title": "Sync, offline" })).await;
    assert!(renamed.contains("\"Offline sync\" to \"Sync, offline\""), "{renamed}");

    let copied = w.ok("board_duplicate", json!({ "board": w.board })).await;
    assert!(copied.contains("\"Sync, offline copy\""), "{copied}");
    let copy: String = sqlx::query_scalar("SELECT id FROM canvas WHERE title = 'Sync, offline copy'")
        .fetch_one(&w.app.db)
        .await
        .unwrap();
    let overview = w.ok("board_read", json!({ "board": copy })).await;
    assert!(overview.contains("d2"), "refs are kept: {overview}");
}

#[tokio::test]
async fn a_retried_board_create_makes_one_board() {
    let w = world().await;
    w.grant(true).await;
    let first = w.ok("board_create", json!({ "title": "Once", "request_id": "r-1" })).await;
    let second = w.ok("board_create", json!({ "title": "Once", "request_id": "r-1" })).await;
    assert!(second.contains("Already done") && second.contains(first.split("(id ").nth(1).unwrap().split(')').next().unwrap()));
    assert_eq!(w.titles().await.iter().filter(|t| *t == "Once").count(), 1);
}

#[tokio::test]
async fn deleting_a_board_asks_the_person_and_needs_a_yes() {
    let w = world().await;
    w.grant(true).await;
    let call = |extra: Value| {
        let mut params = json!({ "name": "board_delete", "arguments": { "board": "Offline sync" } });
        params.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        params
    };

    // A client that cannot ask: refused, nothing deleted.
    let r = w.rpc("tools/call", call(json!({}))).await;
    assert_eq!(r["isError"], true);
    assert!(r["content"][0]["text"].as_str().unwrap().contains("in the Visarium app"), "{r}");
    let url_only = json!({ "_meta": { ELICIT: { "elicitation": { "url": {} } } } });
    assert_eq!(w.rpc("tools/call", call(url_only)).await["isError"], true, "url mode cannot confirm");

    // A client that can: it is asked, and nothing is deleted yet.
    let meta = json!({ ELICIT: { "elicitation": {} } });
    let ask = w.rpc("tools/call", call(json!({ "_meta": meta }))).await;
    assert_eq!(ask["resultType"], "input_required", "{ask}");
    let req = &ask["inputRequests"]["confirm_delete"];
    assert_eq!(req["method"], "elicitation/create");
    assert_eq!(req["params"]["mode"], "form");
    let message = req["params"]["message"].as_str().unwrap();
    assert!(message.contains("Offline sync") && message.contains("cannot be undone") && message.contains("diagram"), "{message}");
    assert_eq!(req["params"]["requestedSchema"]["properties"]["confirm"]["type"], "boolean");
    assert!(ask["content"][0]["text"].as_str().unwrap().contains("Nothing is deleted"), "a fallback for clients that ignore resultType");
    assert_eq!(w.titles().await, ["Offline sync"]);

    // Declined, cancelled, or accepted without the box ticked: kept.
    for answer in [
        json!({ "action": "decline" }),
        json!({ "action": "cancel" }),
        json!({ "action": "accept", "content": { "confirm": false } }),
    ] {
        let r = w.rpc("tools/call", call(json!({ "_meta": meta, "inputResponses": { "confirm_delete": answer } }))).await;
        assert_eq!(r["isError"], false, "{r}");
        assert!(r["content"][0]["text"].as_str().unwrap().contains("Nothing was deleted"), "{r}");
        assert_eq!(w.titles().await, ["Offline sync"]);
    }

    // A yes deletes it.
    let yes = json!({ "_meta": meta, "inputResponses": { "confirm_delete": { "action": "accept", "content": { "confirm": true } } } });
    let done = w.rpc("tools/call", call(yes)).await;
    assert_eq!(done["isError"], false, "{done}");
    assert!(done["content"][0]["text"].as_str().unwrap().contains("Deleted the board \"Offline sync\""), "{done}");
    assert!(w.titles().await.is_empty());
}

#[tokio::test]
async fn only_an_owner_or_admins_agent_deletes_a_board() {
    let w = world().await;
    w.grant(true).await;
    let other = person(&w.app, "bo", "Bo").await;
    sqlx::query("UPDATE canvas SET owner_id = ? WHERE id = ?")
        .bind(&other)
        .bind(&w.board)
        .execute(&w.app.db)
        .await
        .unwrap();
    let r = w
        .rpc("tools/call", json!({ "name": "board_delete", "arguments": { "board": w.board },
             "_meta": { ELICIT: { "elicitation": {} } } }))
        .await;
    assert_eq!(r["isError"], true, "refused before asking anyone: {r}");
    assert!(r["content"][0]["text"].as_str().unwrap().contains("owner or an admin"), "{r}");
    assert_eq!(w.titles().await, ["Offline sync"]);
}

#[tokio::test]
async fn people_on_a_board_see_it_renamed_and_deleted_and_by_whom() {
    let w = world().await;
    w.grant(true).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(visarium::serve(w.app.clone(), listener));
    let browser = auth::create_session(&w.app.db, Kind::Browser, Some(&w.user), None, None, None)
        .await
        .unwrap();
    let mut req = format!("ws://{addr}/ws/canvas/{}", w.board).into_client_request().unwrap();
    req.headers_mut()
        .insert("cookie", format!("VISARIUM_SESSION={browser}").parse().unwrap());
    let (mut member, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    member
        .send(json!({ "t": "hello", "protocolVersion": visarium::PROTOCOL_VERSION, "sinceRevision": 0 }).to_string().into())
        .await
        .unwrap();
    assert_eq!(next(&mut member).await["t"], "welcome");

    w.ok("board_rename", json!({ "board": w.board, "title": "Feature tour" })).await;
    assert_eq!(
        next_frame(&mut member).await,
        json!({ "t": "board", "title": "Feature tour", "by": "Claude Code on laptop for Ada" })
    );

    let yes = json!({ "name": "board_delete", "arguments": { "board": w.board },
        "_meta": { ELICIT: { "elicitation": {} } },
        "inputResponses": { "confirm_delete": { "action": "accept", "content": { "confirm": true } } } });
    assert_eq!(w.rpc("tools/call", yes).await["isError"], false);
    assert_eq!(
        next_frame(&mut member).await,
        json!({ "t": "board-deleted", "by": "Claude Code on laptop for Ada" })
    );
}

// --- images ---------------------------------------------------------------------------

fn png(w: u32, h: u32, shade: u8) -> Vec<u8> {
    let mut out = std::io::Cursor::new(vec![]);
    image::RgbImage::from_pixel(w, h, image::Rgb([shade, 40, 90]))
        .write_to(&mut out, image::ImageFormat::Png)
        .unwrap();
    out.into_inner()
}

fn animated_gif() -> Vec<u8> {
    let mut out = vec![];
    {
        let mut encoder = image::codecs::gif::GifEncoder::new(&mut out);
        let frames = [0u8, 200].map(|shade| {
            image::Frame::new(image::RgbaImage::from_pixel(64, 32, image::Rgba([shade, 0, 0, 255])))
        });
        encoder.encode_frames(frames).unwrap();
    }
    out
}

fn b64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// A tiny HTTP server on loopback: /x.png, /page (HTML), /redir (to /x.png).
async fn image_server() -> u16 {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let picture = png(300, 150, 7);
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else { return };
            let picture = picture.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 2048];
                let n = socket.read(&mut buf).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]);
                let path = request.split_whitespace().nth(1).unwrap_or("/");
                let (head, body): (String, Vec<u8>) = match path {
                    "/x.png" => (format!("HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\n", picture.len()), picture),
                    "/redir" => ("HTTP/1.1 302 Found\r\nLocation: /x.png\r\nContent-Length: 0\r\n".into(), vec![]),
                    _ => ("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 13\r\n".into(), b"<html></html>".to_vec()),
                };
                let _ = socket.write_all(format!("{head}Connection: close\r\n\r\n").as_bytes()).await;
                let _ = socket.write_all(&body).await;
            });
        }
    });
    port
}

async fn assets(w: &World) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM asset").fetch_one(&w.app.db).await.unwrap()
}

#[tokio::test]
async fn an_image_from_data_is_stored_like_an_upload_and_placed() {
    let w = world().await;
    let before = assets(&w).await;
    let picture = png(200, 100, 1);
    let text = w
        .ok("item_create", json!({ "board": "Offline sync", "kind": "image", "data": b64(&picture), "filename": "swatch.png", "near": "n1" }))
        .await;
    assert!(text.starts_with("Created i2 (image)"), "{text}");
    let b = w.data().await;
    let i2 = b.resolve_item("i2").unwrap();
    assert_eq!((i2.width, i2.height), (200.0, 100.0), "shown at its own size");
    assert!(i2.collides);
    assert_eq!(assets(&w).await, before + 1);
    // The same bytes again: a second item, still one file.
    w.ok("item_create", json!({ "board": "Offline sync", "kind": "image", "data": b64(&picture), "near": "i2" })).await;
    assert_eq!(assets(&w).await, before + 1, "same bytes, same asset");
    assert!(w.data().await.resolve_item("i3").is_ok());
}

#[tokio::test]
async fn an_animated_gif_stays_a_gif() {
    let w = world().await;
    w.ok("item_create", json!({ "board": "Offline sync", "kind": "image", "data": b64(&animated_gif()), "near": "n1" })).await;
    let b = w.data().await;
    assert_eq!(b.resolve_item("i2").unwrap().mime_type.as_deref(), Some("image/gif"));
}

#[tokio::test]
async fn too_much_data_points_to_a_url() {
    let w = world().await;
    // Over the 8 MB image limit, inside what one call may carry.
    let big = "A".repeat(12 * 1024 * 1024);
    let err = w.fails("item_create", json!({ "board": "Offline sync", "kind": "image", "data": big })).await;
    assert!(err.contains("at most 8 MB") && err.contains("url"), "{err}");
    let err = w.fails("item_create", json!({ "board": "Offline sync", "kind": "image", "data": b64(b"not a picture") })).await;
    assert!(err.contains("not an image"), "{err}");
    // A 6 MB image passes as data.
    let mut big_png = png(1200, 1200, 3);
    big_png.resize(6 * 1024 * 1024, 0);
    let text = w.ok("item_create", json!({ "board": "Offline sync", "kind": "image", "data": b64(&big_png) })).await;
    assert!(text.starts_with("Created i2 (image)"), "{text}");
}

#[tokio::test]
async fn an_image_from_a_url_follows_redirects_and_refuses_what_is_not_an_image() {
    let w = world().await;
    let port = image_server().await;
    w.app.allow_private_imports.store(true, std::sync::atomic::Ordering::Relaxed);
    let text = w
        .ok("item_create", json!({ "board": "Offline sync", "kind": "image", "url": format!("http://127.0.0.1:{port}/redir"), "near": "n2",
            "link": { "type": "comments", "to": "n2" } }))
        .await;
    assert!(text.contains("Created i2 (image)") && text.contains("Linked i2 comments n2"), "{text}");
    let b = w.data().await;
    assert_eq!(b.resolve_item("i2").unwrap().width, 300.0);
    let err = w
        .fails("item_create", json!({ "board": "Offline sync", "kind": "image", "url": format!("http://127.0.0.1:{port}/page") }))
        .await;
    assert!(err.contains("not an image"), "{err}");
}

#[tokio::test]
async fn a_url_on_a_private_address_is_never_fetched() {
    let w = world().await;
    let port = image_server().await;
    let before = w.revision().await;
    for url in [
        format!("http://127.0.0.1:{port}/x.png"),
        format!("http://localhost:{port}/x.png"),
        "http://192.168.1.10/image.png".to_string(),
        "http://[::ffff:10.0.0.5]/image.png".to_string(),
    ] {
        let err = w.fails("item_create", json!({ "board": "Offline sync", "kind": "image", "url": url })).await;
        assert!(err.contains("private address"), "{url}: {err}");
    }
    let err = w.fails("item_create", json!({ "board": "Offline sync", "kind": "image", "url": "ftp://example.com/x.png" })).await;
    assert!(err.contains("Only http and https"), "{err}");
    assert_eq!(w.revision().await, before, "nothing was created");
}

// --- layout in the overview --------------------------------------------------------------

#[tokio::test]
async fn the_overview_names_layout_problems_but_not_a_persons_own_overlaps() {
    let w = world().await;
    let read = || w.ok("board_read", json!({ "board": "Offline sync" }));
    assert!(read().await.contains("Layout: no overlaps or crossings"), "the fixture is tidy");

    // A person stacks two of their own notes on purpose: not a problem.
    let b = w.data().await;
    let n1 = b.resolve_item("n1").unwrap().id.clone();
    apply_as(&w.app, &w.board, &w.user, serde_json::from_value(json!([{ "type": "item.transform", "itemId": n1,
        "transform": { "x": 0.0, "y": 0.0, "width": 280.0, "height": 200.0, "rotation": 0.0 } }])).unwrap()).await;
    assert!(read().await.contains("Layout: no overlaps or crossings"));

    // The agent's linked note is dragged onto d1 by a person.
    w.ok("item_create", json!({ "board": "Offline sync", "kind": "note", "source": "Mine.", "near": "c1",
        "link": { "type": "comments", "to": "c1" } })).await;
    let n6 = w.data().await.resolve_item("n6").unwrap().id.clone();
    apply_as(&w.app, &w.board, &w.user, serde_json::from_value(json!([{ "type": "item.transform", "itemId": n6,
        "transform": { "x": -100.0, "y": 100.0, "width": 200.0, "height": 100.0, "rotation": 0.0 } }])).unwrap()).await;
    let text = read().await;
    assert!(text.contains("## Layout"), "{text}");
    assert!(text.contains("d1 overlaps n6") || text.contains("n6 overlaps d1"), "{text}");
    assert!(text.contains("n6 → c1 crosses"), "{text}");
    assert!(!text.contains("n1 overlaps d1") && !text.contains("d1 overlaps n1"), "{text}");
}

// --- canvas-polish ------------------------------------------------------------------

#[tokio::test]
async fn a_scaled_note_reads_with_its_text_scale() {
    let w = world().await;
    let id = uuid::Uuid::now_v7();
    let mut op = note_op(id, 0.0, 9000.0, "Big words", None);
    op["textScale"] = json!(2.5);
    apply_as(&w.app, &w.board, &w.user, serde_json::from_value(json!([op])).unwrap()).await;
    let read = w.ok("item_read", json!({ "board": "Offline sync", "ref": "n6" })).await;
    assert!(read.contains("Text shown at 2.5× its normal size."), "{read}");
    let plain = w.ok("item_read", json!({ "board": "Offline sync", "ref": "n1" })).await;
    assert!(!plain.contains("Text shown at"), "{plain}");
}

#[tokio::test]
async fn an_agent_sets_and_clears_the_centerpiece_and_reads_it_back() {
    let w = world().await;
    let set = w.ok("arrange", json!({ "board": "Offline sync", "centerpiece": "d2" })).await;
    assert!(set.contains("d2 is now the centerpiece"), "{set}");
    let o = w.ok("board_read", json!({ "board": "Offline sync" })).await;
    assert!(o.contains("Centerpiece: d2"), "{o}");
    let snap: Option<String> = sqlx::query_scalar("SELECT centerpiece FROM canvas WHERE id = ?")
        .bind(&w.board)
        .fetch_one(&w.app.db)
        .await
        .unwrap();
    assert!(snap.is_some_and(|c| c.starts_with("item:")));
    let cleared = w.ok("arrange", json!({ "board": "Offline sync", "centerpiece": "" })).await;
    assert!(cleared.contains("no centerpiece"), "{cleared}");
    let o = w.ok("board_read", json!({ "board": "Offline sync" })).await;
    assert!(!o.contains("Centerpiece:"), "{o}");
    let bad = w.fails("arrange", json!({ "board": "Offline sync", "centerpiece": "g99" })).await;
    assert!(bad.contains("does not exist"), "{bad}");
}

#[tokio::test]
async fn an_agent_links_a_passage_of_a_note_and_is_told_which_exist() {
    let w = world().await;
    let id = uuid::Uuid::now_v7();
    let op = note_op(id, 0.0, 9000.0, "# Evidence\n\nHow a request becomes evidence. ^evidence\n\n## Fallbacks\n\nPlain.", None);
    apply_as(&w.app, &w.board, &w.user, serde_json::from_value(json!([op])).unwrap()).await;
    let read = w.ok("item_read", json!({ "board": "Offline sync", "ref": "n6" })).await;
    assert!(read.contains("Passages (2): ^evidence, fallbacks"), "{read}");
    let linked = w
        .ok("link", json!({ "board": "Offline sync", "from": "n6#^evidence", "to": "d2#Server", "type": "describes" }))
        .await;
    assert!(linked.contains("n6#^evidence"), "{linked}");
    let o = w.ok("board_read", json!({ "board": "Offline sync" })).await;
    assert!(o.contains("7 links · 1 broken"), "the new passage link is whole, not broken: {o}");
    let refused = w
        .fails("link", json!({ "board": "Offline sync", "from": "n6#^nope", "to": "d2", "type": "describes" }))
        .await;
    assert!(refused.contains("Its passages: ^evidence, fallbacks"), "{refused}");
    let unlinked = w.ok("unlink", json!({ "board": "Offline sync", "from": "n6#^evidence", "to": "d2#Server" })).await;
    assert!(!unlinked.is_empty());
}
