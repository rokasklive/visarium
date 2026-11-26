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
//!   VISARIUM_APPS_PORT         (none)                development and tests only: serve
//!                                                    canvas apps' views from 127.0.0.1 on
//!                                                    this port (0: any free one)
//!
//! Demo mode serves a public sandbox per visitor instead (src/demo.rs); the
//! settings above about accounts, providers and data paths do not apply:
//!
//!   VISARIUM_DEMO              off                   on: be a demo gateway
//!   VISARIUM_DEMO_ROOT         data/demo             sandboxes; emptied at start
//!   VISARIUM_DEMO_SEED         (none)                a data dir to copy into each
//!                                                    sandbox (db/, assets/, derivatives/)
//!   VISARIUM_DEMO_HOURS        2                     how long a sandbox lives
//!   VISARIUM_DEMO_MAX          100                   sandboxes at once
//!   VISARIUM_DEMO_STORAGE_MB   50                    images a visitor may add
//!   VISARIUM_DEMO_IP_HEADER    (none)                e.g. Cf-Connecting-IP behind a proxy
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

/// Ctrl-C everywhere, plus SIGTERM where the platform has one.
async fn shutdown_signal() {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut term =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).unwrap();
        tokio::select! { _ = ctrl_c => {}, _ = term.recv() => {} }
    }
    #[cfg(not(unix))]
    {
        let _ = ctrl_c.await;
    }
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
    if flag("VISARIUM_DEMO", "off") {
        return demo(bind, port, &env).await;
    }
    let single_user = flag("VISARIUM_SINGLE_USER", "false");
    if single_user && !bind.is_loopback() {
        // Single-user mode has no sign-in at all; on a reachable address that
        // is an open library.
        return Err(
            format!("VISARIUM_SINGLE_USER needs a loopback VISARIUM_BIND, not {bind}").into(),
        );
    }

    let mut config = visarium::Config {
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
        demo: None,
        decode_permits: None,
        // A self-hosted sandbox hostname comes with canvas-apps Phase 2.
        apps_origin: None,
    };
    // ponytail: a loopback origin, as the desktop has, so development and the
    // e2e scenario can run apps; reachable only from this machine.
    let sandbox = match std::env::var("VISARIUM_APPS_PORT")
        .ok()
        .filter(|p| !p.is_empty())
    {
        Some(p) => Some(tokio::net::TcpListener::bind(("127.0.0.1", p.parse::<u16>()?)).await?),
        None => None,
    };
    if let Some(l) = &sandbox {
        config.apps_origin = Some(format!("http://127.0.0.1:{}", l.local_addr()?.port()));
    }
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
    if let Some(l) = sandbox {
        tracing::info!(address = %l.local_addr()?, "serving app views");
        tokio::spawn(visarium::serve_sandbox(state.clone(), l));
    }

    axum::serve(listener, visarium::router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    tracing::info!("shut down");
    Ok(())
}

/// The demo gateway in place of an instance (VISARIUM_DEMO=on).
async fn demo(
    bind: IpAddr,
    port: u16,
    env: &dyn Fn(&str, &str) -> String,
) -> visarium::anyhow_lite::Result<()> {
    let number = |name: &str, default: &str| -> visarium::anyhow_lite::Result<u64> {
        env(name, default)
            .parse()
            .map_err(|_| format!("{name} must be a whole number").into())
    };
    let mut settings = visarium::demo::Settings {
        root: PathBuf::from(env("VISARIUM_DEMO_ROOT", "data/demo")),
        seed: std::env::var("VISARIUM_DEMO_SEED")
            .ok()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from),
        lifetime: std::time::Duration::from_secs(number("VISARIUM_DEMO_HOURS", "2")? * 3600),
        max_sandboxes: number("VISARIUM_DEMO_MAX", "100")? as usize,
        version: env("VISARIUM_VERSION", env!("CARGO_PKG_VERSION")),
        ip_header: std::env::var("VISARIUM_DEMO_IP_HEADER")
            .ok()
            .filter(|s| !s.is_empty())
            .map(|h| h.parse())
            .transpose()
            .map_err(|_| "VISARIUM_DEMO_IP_HEADER is not a header name")?,
        ..Default::default()
    };
    settings.policy.storage_bytes = number("VISARIUM_DEMO_STORAGE_MB", "50")? * 1_000_000;
    let gateway = visarium::demo::open(settings).await?;
    let listener = tokio::net::TcpListener::bind(SocketAddr::new(bind, port)).await?;
    tracing::info!(address = %listener.local_addr()?, "listening as a demo");
    axum::serve(
        listener,
        visarium::demo::router(gateway).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    Ok(())
}
