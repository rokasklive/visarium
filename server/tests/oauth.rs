//! OAuth for `/mcp` end to end (mcp-oauth): discovery, registration, client
//! metadata documents, consent, tokens, refresh rotation and revocation.

use std::path::PathBuf;
use std::sync::atomic::Ordering;

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use base64::Engine;
use http_body_util::BodyExt;
use reqwest::Url;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tower::ServiceExt;

const ISSUER: &str = "http://localhost:8080";
const VERIFIER: &str = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE: &str = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

struct Reply {
    status: StatusCode,
    headers: axum::http::HeaderMap,
    body: Vec<u8>,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
    fn location(&self) -> String {
        self.headers
            .get(header::LOCATION)
            .map(|l| l.to_str().unwrap().to_string())
            .unwrap_or_default()
    }
    fn header(&self, name: header::HeaderName) -> String {
        self.headers
            .get(name)
            .map(|v| v.to_str().unwrap().to_string())
            .unwrap_or_default()
    }
}

/// A browser (with cookies) or an app (without) talking to one router.
struct Client {
    router: axum::Router,
    cookies: Vec<(String, String)>,
}

impl Client {
    async fn send(
        &mut self,
        method: &str,
        uri: &str,
        ct: Option<&str>,
        body: String,
        extra: &[(&str, &str)],
    ) -> Reply {
        let mut req = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::HOST, "localhost:8080");
        if !self.cookies.is_empty() {
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
            req = req
                .header(header::COOKIE, jar.join("; "))
                .header("X-XSRF-TOKEN", csrf);
        }
        if let Some(ct) = ct {
            req = req.header(header::CONTENT_TYPE, ct);
        }
        for (k, v) in extra {
            req = req.header(*k, *v);
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
        self.send("GET", uri, None, String::new(), &[]).await
    }
    async fn json(&mut self, method: &str, uri: &str, body: Value) -> Reply {
        self.send(method, uri, Some("application/json"), body.to_string(), &[])
            .await
    }
    async fn form(&mut self, uri: &str, fields: &[(&str, &str)]) -> Reply {
        let body = Url::parse_with_params("http://x/", fields)
            .unwrap()
            .query()
            .unwrap_or_default()
            .to_string();
        self.send(
            "POST",
            uri,
            Some("application/x-www-form-urlencoded"),
            body,
            &[],
        )
        .await
    }
    async fn mcp(&mut self, token: &str) -> Reply {
        let auth = format!("Bearer {token}");
        self.send(
            "POST",
            "/mcp",
            Some("application/json"),
            json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }).to_string(),
            &[("authorization", &auth)],
        )
        .await
    }
}

async fn instance(public_url: Option<&str>) -> (visarium::AppState, PathBuf) {
    instance_with(public_url, false).await
}

async fn instance_with(
    public_url: Option<&str>,
    no_documents: bool,
) -> (visarium::AppState, PathBuf) {
    let dir = std::env::temp_dir().join(format!("visarium-oauth-{}", uuid::Uuid::new_v4()));
    let config = visarium::Config {
        database: dir.join("visarium.db"),
        assets: dir.join("assets"),
        derivatives: dir.join("derivatives"),
        version: "test".into(),
        public_url: public_url.map(String::from),
        client_documents_disabled: no_documents,
        ..Default::default()
    };
    (visarium::open(config).await.unwrap(), dir)
}

/// The instance, a browser signed in as its admin, and an app with no cookies.
async fn world() -> (visarium::AppState, Client, Client, PathBuf) {
    let (app, dir) = instance(Some(ISSUER)).await;
    let router = visarium::router(app.clone());
    let mut browser = Client {
        router: router.clone(),
        cookies: vec![],
    };
    browser.get("/api/session").await;
    let claimed = browser
        .json(
            "POST",
            "/api/setup",
            json!({ "username": "ada", "displayName": "Ada", "password": "correct horse battery" }),
        )
        .await;
    assert_eq!(claimed.status, StatusCode::CREATED);
    let app_client = Client {
        router,
        cookies: vec![],
    };
    (app, browser, app_client, dir)
}

async fn register(app: &mut Client, redirect: &str) -> String {
    let r = app
        .json(
            "POST",
            "/oauth/register",
            json!({ "client_name": "Claude Code", "redirect_uris": [redirect] }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.json());
    r.json()["client_id"].as_str().unwrap().to_string()
}

fn authorize_url(client_id: &str, redirect: &str, extra: &[(&str, &str)]) -> String {
    let mut params = vec![
        ("response_type", "code"),
        ("client_id", client_id),
        ("redirect_uri", redirect),
        ("state", "st4te"),
        ("code_challenge", CHALLENGE),
        ("code_challenge_method", "S256"),
        ("resource", "http://localhost:8080/mcp"),
    ];
    for (k, v) in extra {
        params.retain(|(p, _)| p != k);
        if !v.is_empty() {
            params.push((k, v));
        }
    }
    let url = Url::parse_with_params("http://localhost:8080/oauth/authorize", &params).unwrap();
    format!("/oauth/authorize?{}", url.query().unwrap())
}

fn param(url: &str, name: &str) -> Option<String> {
    Url::parse(url)
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.into_owned())
}

/// Authorize, then answer on the consent page. Returns where the browser goes.
async fn consent(browser: &mut Client, url: &str, approve: bool, manage: bool) -> String {
    let r = browser.get(url).await;
    assert_eq!(
        r.status,
        StatusCode::SEE_OTHER,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    let to = r.location();
    let request = to
        .strip_prefix("/oauth/consent?request=")
        .unwrap_or_else(|| panic!("went to {to}"));
    let shown = browser.get(&format!("/api/oauth/requests/{request}")).await;
    assert_eq!(shown.status, StatusCode::OK, "{}", shown.json());
    let answer = browser
        .json(
            "POST",
            "/api/oauth/consent",
            json!({ "request": request, "approve": approve, "manageBoards": manage }),
        )
        .await;
    assert_eq!(answer.status, StatusCode::OK, "{}", answer.json());
    answer.json()["redirect"].as_str().unwrap().to_string()
}

async fn redeem(app: &mut Client, client_id: &str, redirect: &str, code: &str) -> Reply {
    app.form(
        "/oauth/token",
        &[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("code_verifier", VERIFIER),
            ("client_id", client_id),
            ("redirect_uri", redirect),
            ("resource", "http://localhost:8080/mcp"),
        ],
    )
    .await
}

#[test]
fn the_test_challenge_is_the_verifiers() {
    let c = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(Sha256::digest(VERIFIER.as_bytes()));
    assert_eq!(c, CHALLENGE);
}

#[tokio::test]
async fn discovery_and_challenge_only_with_a_public_address() {
    let (_app, _browser, mut app, _dir) = world().await;
    let r = app.get("/.well-known/oauth-protected-resource/mcp").await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["resource"], "http://localhost:8080/mcp");
    assert_eq!(r.json()["authorization_servers"], json!([ISSUER]));
    assert_eq!(r.json()["bearer_methods_supported"], json!(["header"]));
    assert_eq!(r.header(header::ACCESS_CONTROL_ALLOW_ORIGIN), "*");
    assert_eq!(
        app.get("/.well-known/oauth-protected-resource")
            .await
            .status,
        StatusCode::OK
    );

    let m = app
        .get("/.well-known/oauth-authorization-server")
        .await
        .json();
    assert_eq!(m["issuer"], ISSUER);
    assert_eq!(m["code_challenge_methods_supported"], json!(["S256"]));
    assert_eq!(m["token_endpoint_auth_methods_supported"], json!(["none"]));
    assert_eq!(m["client_id_metadata_document_supported"], true);
    assert_eq!(m["authorization_response_iss_parameter_supported"], true);
    assert_eq!(m["token_endpoint"], "http://localhost:8080/oauth/token");

    let refused = app.mcp("").await;
    let r = app
        .send("POST", "/mcp", Some("application/json"), "{}".into(), &[])
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        r.header(header::WWW_AUTHENTICATE),
        "Bearer resource_metadata=\"http://localhost:8080/.well-known/oauth-protected-resource/mcp\", scope=\"mcp\""
    );
    assert!(r.json()["detail"].as_str().unwrap().contains("Agents"));
    assert_eq!(refused.status, StatusCode::UNAUTHORIZED);

    // Without a public address: bearer tokens only, no metadata, no challenge.
    let (bare, _dir) = instance(None).await;
    let mut c = Client {
        router: visarium::router(bare),
        cookies: vec![],
    };
    assert_eq!(
        c.get("/.well-known/oauth-authorization-server")
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        c.get("/.well-known/oauth-protected-resource/mcp")
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        c.form("/oauth/token", &[("grant_type", "refresh_token")])
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    let r = c
        .send("POST", "/mcp", Some("application/json"), "{}".into(), &[])
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    assert!(r.headers.get(header::WWW_AUTHENTICATE).is_none());
}

#[tokio::test]
async fn registration_is_for_public_clients_with_safe_redirects() {
    let (app_state, _browser, mut app, _dir) = world().await;
    let r = app
        .json(
            "POST",
            "/oauth/register",
            json!({ "client_name": "Claude Code", "redirect_uris": ["http://localhost:51234/callback"] }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.json());
    assert_eq!(r.json()["token_endpoint_auth_method"], "none");
    assert!(r.json()["client_id"].as_str().is_some());

    let bad = app
        .json(
            "POST",
            "/oauth/register",
            json!({ "redirect_uris": ["http://evil.example.com/cb"] }),
        )
        .await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST);
    assert_eq!(bad.json()["error"], "invalid_redirect_uri");
    let secret = app
        .json(
            "POST",
            "/oauth/register",
            json!({ "redirect_uris": ["https://a.example/cb"], "token_endpoint_auth_method": "client_secret_basic" }),
        )
        .await;
    assert_eq!(secret.json()["error"], "invalid_client_metadata");

    // Ten an hour per address.
    let mut last = StatusCode::OK;
    for _ in 0..11 {
        last = app
            .send(
                "POST",
                "/oauth/register",
                Some("application/json"),
                json!({ "redirect_uris": ["https://a.example/cb"] }).to_string(),
                &[("x-forwarded-for", "203.0.113.9")],
            )
            .await
            .status;
    }
    assert_eq!(last, StatusCode::TOO_MANY_REQUESTS);

    // A client never used is pruned after a day.
    sqlx::query("UPDATE oauth_client SET created_at = '2000-01-01T00:00:00.000Z'")
        .execute(&app_state.db)
        .await
        .unwrap();
    visarium::oauth::sweep(&app_state.db).await.unwrap();
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM oauth_client")
        .fetch_one(&app_state.db)
        .await
        .unwrap();
    assert_eq!(left, 0);
}

#[tokio::test]
async fn authorize_refuses_on_a_page_until_the_redirect_is_known() {
    let (_state, mut browser, mut app, _dir) = world().await;
    let cb = "http://127.0.0.1/callback";
    let id = register(&mut app, cb).await;

    let unknown = browser.get(&authorize_url("no-such-client", cb, &[])).await;
    assert_eq!(unknown.status, StatusCode::BAD_REQUEST);
    assert!(unknown.location().is_empty(), "never redirected");
    let elsewhere = browser
        .get(&authorize_url(&id, "http://127.0.0.1:9/other", &[]))
        .await;
    assert_eq!(elsewhere.status, StatusCode::BAD_REQUEST);
    assert!(elsewhere.location().is_empty());

    // Known redirect, bad request: back to the client, with state and iss.
    let cb_port = "http://127.0.0.1:8787/callback";
    for (extra, error) in [
        (vec![("code_challenge_method", "plain")], "invalid_request"),
        (vec![("code_challenge", "")], "invalid_request"),
        (vec![("state", "")], "invalid_request"),
        (
            vec![("response_type", "token")],
            "unsupported_response_type",
        ),
        (
            vec![("resource", "https://other.example.com/mcp")],
            "invalid_target",
        ),
    ] {
        let r = browser.get(&authorize_url(&id, cb_port, &extra)).await;
        assert_eq!(r.status, StatusCode::SEE_OTHER, "{extra:?}");
        let to = r.location();
        assert!(to.starts_with(cb_port), "{to}");
        assert_eq!(param(&to, "error").as_deref(), Some(error), "{extra:?}");
        assert_eq!(param(&to, "iss").as_deref(), Some(ISSUER));
    }

    // Declining goes back with access_denied.
    let to = consent(
        &mut browser,
        &authorize_url(&id, cb_port, &[]),
        false,
        false,
    )
    .await;
    assert_eq!(param(&to, "error").as_deref(), Some("access_denied"));
    assert_eq!(param(&to, "state").as_deref(), Some("st4te"));
}

#[tokio::test]
async fn a_signed_in_client_is_an_agent_until_revoked() {
    let (state, mut browser, mut app, _dir) = world().await;
    let cb = "cursor://anysphere.cursor-mcp/oauth/callback";
    let id = register(&mut app, cb).await;

    let shown = {
        let r = browser.get(&authorize_url(&id, cb, &[])).await;
        let request = r.location().split("request=").nth(1).unwrap().to_string();
        browser
            .get(&format!("/api/oauth/requests/{request}"))
            .await
            .json()
    };
    assert_eq!(shown["clientName"], "Claude Code");
    assert_eq!(shown["redirectHost"], "cursor://anysphere.cursor-mcp");

    let to = consent(&mut browser, &authorize_url(&id, cb, &[]), true, true).await;
    assert!(to.starts_with(cb), "{to}");
    assert_eq!(param(&to, "state").as_deref(), Some("st4te"));
    assert_eq!(param(&to, "iss").as_deref(), Some(ISSUER));
    let code = param(&to, "code").unwrap();

    // The wrong verifier burns the code.
    let wrong = app
        .form(
            "/oauth/token",
            &[
                ("grant_type", "authorization_code"),
                ("code", &code),
                ("code_verifier", "not-it"),
                ("client_id", &id),
                ("redirect_uri", cb),
            ],
        )
        .await;
    assert_eq!(wrong.status, StatusCode::BAD_REQUEST);
    assert_eq!(wrong.json()["error"], "invalid_grant");
    assert_eq!(
        redeem(&mut app, &id, cb, &code).await.json()["error"],
        "invalid_grant"
    );

    // Another resource is refused.
    let code = param(
        &consent(&mut browser, &authorize_url(&id, cb, &[]), true, true).await,
        "code",
    )
    .unwrap();
    let other = app
        .form(
            "/oauth/token",
            &[
                ("grant_type", "authorization_code"),
                ("code", &code),
                ("code_verifier", VERIFIER),
                ("client_id", &id),
                ("redirect_uri", cb),
                ("resource", "https://other.example.com/mcp"),
            ],
        )
        .await;
    assert_eq!(other.json()["error"], "invalid_target");

    let code = param(
        &consent(&mut browser, &authorize_url(&id, cb, &[]), true, true).await,
        "code",
    )
    .unwrap();
    let t = redeem(&mut app, &id, cb, &code).await;
    assert_eq!(t.status, StatusCode::OK, "{}", t.json());
    assert_eq!(t.header(header::CACHE_CONTROL), "no-store");
    let t = t.json();
    assert_eq!(t["token_type"], "Bearer");
    assert_eq!(t["expires_in"], 3600);
    let access = t["access_token"].as_str().unwrap().to_string();
    let refresh = t["refresh_token"].as_str().unwrap().to_string();

    // It works on /mcp, with the grant chosen at consent, and nowhere else.
    // A first use in the very millisecond the connection was made reads as
    // never used ("last used" is last_seen_at != created_at), so wait one.
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    let listed = app.mcp(&access).await;
    assert_eq!(listed.status, StatusCode::OK);
    assert!(
        listed.json().to_string().contains("board_create"),
        "manage boards granted"
    );
    let api = app
        .send(
            "GET",
            "/api/agent-tokens",
            None,
            String::new(),
            &[("authorization", &format!("Bearer {access}"))],
        )
        .await;
    assert_eq!(api.status, StatusCode::UNAUTHORIZED);
    let query = app
        .send(
            "POST",
            &format!("/mcp?access_token={access}"),
            Some("application/json"),
            "{}".into(),
            &[],
        )
        .await;
    assert_eq!(query.status, StatusCode::UNAUTHORIZED);

    // Listed as one agent, connected by sign-in.
    let agents = browser.get("/api/agent-tokens").await.json();
    let agents = agents.as_array().unwrap();
    assert_eq!(agents.len(), 1, "{agents:?}");
    assert_eq!(agents[0]["label"], "Claude Code");
    assert_eq!(agents[0]["connectedBySignIn"], true);
    assert!(agents[0]["lastUsedAt"].is_string());

    // Refresh rotates; the old refresh token then ends the connection.
    let r = app
        .form(
            "/oauth/token",
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", &refresh),
                ("client_id", &id),
            ],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json());
    let access2 = r.json()["access_token"].as_str().unwrap().to_string();
    assert_ne!(r.json()["refresh_token"].as_str().unwrap(), refresh);
    assert_eq!(app.mcp(&access2).await.status, StatusCode::OK);
    let replay = app
        .form(
            "/oauth/token",
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", &refresh),
                ("client_id", &id),
            ],
        )
        .await;
    assert_eq!(replay.json()["error"], "invalid_grant");
    assert_eq!(
        app.mcp(&access2).await.status,
        StatusCode::UNAUTHORIZED,
        "connection ended"
    );
    assert!(
        browser
            .get("/api/agent-tokens")
            .await
            .json()
            .as_array()
            .unwrap()
            .is_empty()
    );

    // Revoking from the Agents list ends access and refresh at once.
    let code = param(
        &consent(&mut browser, &authorize_url(&id, cb, &[]), true, false).await,
        "code",
    )
    .unwrap();
    let t = redeem(&mut app, &id, cb, &code).await.json();
    let (access, refresh) = (
        t["access_token"].as_str().unwrap().to_string(),
        t["refresh_token"].as_str().unwrap().to_string(),
    );
    assert!(
        !app.mcp(&access)
            .await
            .json()
            .to_string()
            .contains("board_create"),
        "no grant"
    );
    let agent = browser.get("/api/agent-tokens").await.json()[0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        browser
            .send(
                "DELETE",
                &format!("/api/agent-tokens/{agent}"),
                None,
                String::new(),
                &[]
            )
            .await
            .status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(app.mcp(&access).await.status, StatusCode::UNAUTHORIZED);
    let r = app
        .form(
            "/oauth/token",
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", &refresh),
                ("client_id", &id),
            ],
        )
        .await;
    assert_eq!(r.json()["error"], "invalid_grant");

    // An expired access token is refused with the challenge, so the client refreshes.
    let code = param(
        &consent(&mut browser, &authorize_url(&id, cb, &[]), true, false).await,
        "code",
    )
    .unwrap();
    let access = redeem(&mut app, &id, cb, &code).await.json()["access_token"]
        .as_str()
        .unwrap()
        .to_string();
    sqlx::query(
        "UPDATE oauth_token SET expires_at = '2000-01-01T00:00:00.000Z' WHERE kind = 'access'",
    )
    .execute(&state.db)
    .await
    .unwrap();
    let r = app.mcp(&access).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    assert!(
        r.header(header::WWW_AUTHENTICATE)
            .contains("error=\"invalid_token\"")
    );
}

/// Serves `doc` at `/client.json` on loopback, and returns that URL.
async fn serve_document(doc: impl Fn(&str) -> Value + Send + Sync + 'static) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/client.json", listener.local_addr().unwrap());
    let body = doc(&url);
    let router = axum::Router::new().route(
        "/client.json",
        axum::routing::get(move || async move { axum::Json(body) }),
    );
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    url
}

#[tokio::test]
async fn clients_can_identify_by_a_metadata_document() {
    let (state, mut browser, mut app, _dir) = world().await;
    let cb = "https://chat.example.com/connector/oauth/callback";
    let good = serve_document(move |url| {
        json!({ "client_id": url, "client_name": "Example Chat", "redirect_uris": [cb] })
    })
    .await;
    let liar = serve_document(move |_| {
        json!({ "client_id": "https://someone-else.example/client.json", "redirect_uris": [cb] })
    })
    .await;

    // A private address is refused unless explicitly allowed (tests only).
    let r = browser.get(&authorize_url(&good, cb, &[])).await;
    assert_eq!(
        r.status,
        StatusCode::BAD_REQUEST,
        "an http, loopback document is not a client"
    );
    state.allow_private_imports.store(true, Ordering::Relaxed);

    let r = browser.get(&authorize_url(&good, cb, &[])).await;
    assert_eq!(
        r.status,
        StatusCode::SEE_OTHER,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    let request = r.location().split("request=").nth(1).unwrap().to_string();
    let shown = browser
        .get(&format!("/api/oauth/requests/{request}"))
        .await
        .json();
    assert_eq!(shown["clientName"], "Example Chat");
    assert_eq!(shown["clientHost"], "127.0.0.1");
    assert_eq!(shown["redirectHost"], "chat.example.com");

    let to = consent(&mut browser, &authorize_url(&good, cb, &[]), true, false).await;
    let code = param(&to, "code").unwrap();
    let t = redeem(&mut app, &good, cb, &code).await;
    assert_eq!(t.status, StatusCode::OK, "{}", t.json());

    let r = browser.get(&authorize_url(&liar, cb, &[])).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(r.location().is_empty());
}

#[tokio::test]
async fn without_documents_apps_are_told_to_register() {
    let (app, dir) = instance_with(Some(ISSUER), true).await;
    let _ = dir;
    let mut c = Client {
        router: visarium::router(app),
        cookies: vec![],
    };
    let m = c
        .get("/.well-known/oauth-authorization-server")
        .await
        .json();
    assert_eq!(m["client_id_metadata_document_supported"], false);
    assert!(m["registration_endpoint"].is_string());
    let r = c
        .get(&authorize_url(
            "https://claude.example/oauth/client.json",
            "https://claude.example/cb",
            &[],
        ))
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(r.location().is_empty());
    assert!(String::from_utf8_lossy(&r.body).contains("registered clients only"));
    // Registering still works.
    let id = register(&mut c, "https://claude.example/cb").await;
    assert!(!id.starts_with("https://"));
}
