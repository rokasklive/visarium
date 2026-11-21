//! The self-hosted server. Configured entirely from the environment:
//!
//!   VISARIUM_PORT              8080
//!   VISARIUM_BIND              0.0.0.0
//!   VISARIUM_DATABASE          data/visarium.db      canonical — back it up
//!   VISARIUM_ASSETS_PATH       data/assets           canonical — back it up
//!   VISARIUM_DERIVATIVES_PATH  data/derivatives      a cache
//!   VISARIUM_SINGLE_USER       false                 no accounts; loopback only
//!   VISARIUM_PUBLIC_URL        (none)                https://visarium.example.net;
//!                                                    required with any OIDC provider
//!   VISARIUM_AUTH_PASSWORD     off                   on: username and password sign-in too
//!   VISARIUM_SHARING           on                    off: no read-only share links
//!   VISARIUM_OAUTH_CLIENT_DOCUMENTS on               off: MCP apps register instead of
//!                                                    being fetched (no outbound internet)
//!   VISARIUM_OIDC_{ID}_*       (none)                a sign-in provider; see below
//!   VISARIUM_VISION_BASE_URL   (none)                with _MODEL (and _API_KEY, _PROMPT):
//!                                                    the vision model that describes images
//!   VISARIUM_LOG_LEVEL         info                  error, warn, info, debug, trace
//!   VISARIUM_LOG_FORMAT        text                  json: one JSON object per line
//!
//! A provider is `VISARIUM_OIDC_{ID}_CLIENT_ID`, `_CLIENT_SECRET`, `_ISSUER`
//! and optionally `_NAME`. `GOOGLE` needs no issuer or name. Register
//! `{VISARIUM_PUBLIC_URL}/auth/oidc/{id}/callback` as its redirect URI.

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;

fn env(name: &str, default: &str) -> String {
    std::env::var(name)
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| default.into())
}

#[tokio::main]
async fn main() -> visarium::anyhow_lite::Result<()> {
    let level = env("VISARIUM_LOG_LEVEL", "info");
    visarium::telemetry::init(visarium::telemetry::Options {
        level: &level,
        format: visarium::telemetry::Format::parse(&env("VISARIUM_LOG_FORMAT", "text")),
        file_dir: None,
    })?;

    let bind: IpAddr = env("VISARIUM_BIND", "0.0.0.0").parse()?;
    let port: u16 = env("VISARIUM_PORT", "8080").parse()?;
    let flag = |name: &str, default: &str| {
        matches!(
            env(name, default).to_ascii_lowercase().as_str(),
            "true" | "1" | "yes" | "on"
        )
    };
    let single_user = flag("VISARIUM_SINGLE_USER", "false");
    if single_user && !bind.is_loopback() {
        // Single-user mode has no sign-in at all; on a reachable address that
        // is an open library.
        return Err(
            format!("VISARIUM_SINGLE_USER needs a loopback VISARIUM_BIND, not {bind}").into(),
        );
    }

    let config = visarium::Config {
        database: PathBuf::from(env("VISARIUM_DATABASE", "data/visarium.db")),
        assets: PathBuf::from(env("VISARIUM_ASSETS_PATH", "data/assets")),
        derivatives: PathBuf::from(env("VISARIUM_DERIVATIVES_PATH", "data/derivatives")),
        version: env("VISARIUM_VERSION", env!("CARGO_PKG_VERSION")),
        single_user,
        // Off unless asked for: an OpenID Connect provider is the way in we
        // recommend, and a password form on a public server is one more
        // thing to guess at.
        password_disabled: !flag("VISARIUM_AUTH_PASSWORD", "off"),
        sharing_disabled: !flag("VISARIUM_SHARING", "on"),
        client_documents_disabled: !flag("VISARIUM_OAUTH_CLIENT_DOCUMENTS", "on"),
        vision: visarium::vision::from_env(std::env::vars()),
        public_url: std::env::var("VISARIUM_PUBLIC_URL")
            .ok()
            .map(|u| u.trim().trim_end_matches('/').to_string())
            .filter(|u| !u.is_empty()),
        providers: visarium::oidc::providers_from_env(std::env::vars())?,
    };
    // A refusal to start is written for the person reading the container log,
    // so it goes out as plain lines, not as a debug-quoted string.
    let state = match visarium::open(config).await {
        Ok(state) => state,
        Err(e) => {
            tracing::error!(error = %e, "the server did not start");
            eprintln!("\n{e}\n");
            std::process::exit(1);
        }
    };
    let listener = tokio::net::TcpListener::bind(SocketAddr::new(bind, port)).await?;
    tracing::info!(address = %listener.local_addr()?, "listening");

    axum::serve(listener, visarium::router(state))
        .with_graceful_shutdown(async {
            let ctrl_c = tokio::signal::ctrl_c();
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).unwrap();
            tokio::select! { _ = ctrl_c => {}, _ = term.recv() => {} }
        })
        .await?;
    tracing::info!("shut down");
    Ok(())
}
