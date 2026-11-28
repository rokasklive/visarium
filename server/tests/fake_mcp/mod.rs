//! A Streamable HTTP MCP server on loopback for the canvas-apps tests
//! (canvas/app-sources), answering in plain JSON.
#![allow(dead_code)]

use axum::http::StatusCode;
use serde_json::{Value, json};

/// A Streamable HTTP MCP server on loopback, answering in plain JSON: a
/// `price` tool with a view, a `secret` tool apps may not call, a `fail`
/// tool, and the view's HTML, which a test may change. Counts tool calls.
pub struct FakeMcp {
    pub url: String,
    pub html: std::sync::Arc<std::sync::Mutex<String>>,
    pub calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    pub stop: tokio::task::JoinHandle<()>,
}

pub async fn fake_mcp() -> FakeMcp {
    use std::sync::atomic::Ordering;
    let html = std::sync::Arc::new(std::sync::Mutex::new(
        "<!doctype html><title>Price</title><p>v1</p>".to_string(),
    ));
    let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (h, n) = (html.clone(), calls.clone());
    let handler = move |axum::Json(m): axum::Json<Value>| {
        let (h, n) = (h.clone(), n.clone());
        async move {
            use axum::response::IntoResponse;
            let Some(id) = m.get("id").cloned() else {
                return StatusCode::ACCEPTED.into_response();
            };
            let p = &m["params"];
            let result = match m["method"].as_str().unwrap_or_default() {
                "initialize" => json!({
                    "protocolVersion": "2025-06-18",
                    "capabilities": { "tools": {}, "resources": {} },
                    "serverInfo": { "name": "fake", "version": "1" },
                }),
                "tools/list" => json!({ "tools": [
                    { "name": "price", "inputSchema": { "type": "object" },
                      "_meta": { "ui": { "resourceUri": "ui://price/view" } } },
                    { "name": "secret", "inputSchema": { "type": "object" },
                      "_meta": { "ui": { "visibility": ["model"] } } },
                    { "name": "fail", "inputSchema": { "type": "object" } },
                ]}),
                "tools/call" => {
                    n.fetch_add(1, Ordering::SeqCst);
                    match p["name"].as_str() {
                        Some("fail") => {
                            json!({ "isError": true, "content": [{ "type": "text", "text": "rates are down" }] })
                        }
                        _ => {
                            let age = p["arguments"]["age"].as_i64().unwrap_or(0);
                            json!({ "content": [{ "type": "text", "text": format!("Premium {}", age * 30) }],
                                    "structuredContent": { "premium": age * 30 } })
                        }
                    }
                }
                "resources/read" => json!({ "contents": [{
                    "uri": p["uri"], "mimeType": "text/html;profile=mcp-app",
                    "text": h.lock().unwrap().clone(),
                    "_meta": { "ui": { "csp": { "connectDomains": ["https://api.example.com"] } } },
                }]}),
                _ => json!({}),
            };
            axum::Json(json!({ "jsonrpc": "2.0", "id": id, "result": result })).into_response()
        }
    };
    let router = axum::Router::new().route("/mcp", axum::routing::post(handler));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let stop = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    FakeMcp {
        url: format!("http://localhost:{port}/mcp"),
        html,
        calls,
        stop,
    }
}
