//! Images an agent brings in (agents/board-editing, design D7): from a URL
//! the server fetches, or from bytes in the call. Either way they are stored
//! exactly like an upload.
//!
//! A URL is fetched only from a public address. The server sits on a private
//! network, so a URL naming `10.0.0.5`, or a name that resolves there, or a
//! redirect that points there, is refused. The connection is pinned to the
//! address that was checked, so a name cannot resolve one way for the check
//! and another for the fetch.

use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::Ordering;
use std::time::Duration;

use base64::Engine;
use reqwest::Url;

use crate::AppState;
use crate::agent::board::Fail;
use crate::assets::{Asset, Spool};

/// Bytes passed in a call: comfortably inside one MCP message.
pub const MAX_DATA_BYTES: usize = 8 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(20);
const MAX_REDIRECTS: usize = 3;

/// Addresses a fetch must never reach: loopback, private, link-local,
/// unique-local, carrier-grade NAT, multicast, broadcast and unspecified,
/// whether written as IPv4 or as IPv4 inside IPv6.
pub fn refused(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            v.is_loopback()
                || v.is_private()
                || v.is_link_local()
                || v.is_unspecified()
                || v.is_multicast()
                || v.is_broadcast()
                || o[0] == 0
                || (o[0] == 100 && (o[1] & 0xc0) == 64)
        }
        IpAddr::V6(v) => {
            let s = v.segments();
            v.is_loopback()
                || v.is_unspecified()
                || v.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00
                || (s[0] & 0xffc0) == 0xfe80
                || v.to_ipv4_mapped().is_some_and(|m| refused(IpAddr::V4(m)))
                // NAT64 (64:ff9b::/96) carries an IPv4 in its last 32 bits,
                // 6to4 (2002::/16) in bits 16-47.
                || (s[..6] == [0x64, 0xff9b, 0, 0, 0, 0] && refused(embedded(s[6], s[7])))
                || (s[0] == 0x2002 && refused(embedded(s[1], s[2])))
                || (s[..6] == [0, 0, 0, 0, 0, 0] && refused(IpAddr::V4(v.to_ipv4().unwrap())))
        }
    }
}

fn embedded(hi: u16, lo: u16) -> IpAddr {
    IpAddr::V4(std::net::Ipv4Addr::from(
        (u32::from(hi) << 16) | u32::from(lo),
    ))
}

fn not_an_image(e: crate::error::ApiError) -> Fail {
    if e.status == axum::http::StatusCode::UNSUPPORTED_MEDIA_TYPE {
        format!(
            "That is not an image the board can show ({}). Nothing was created.",
            e.detail
        )
    } else {
        format!("{} Nothing was created.", e.detail)
    }
}

/// Bytes given in the call, as base64.
pub async fn from_data(
    app: &AppState,
    data: &str,
    filename: Option<String>,
    uploader: &str,
) -> Result<Asset, Fail> {
    let data = data.trim();
    let data = data.split_once(";base64,").map(|(_, d)| d).unwrap_or(data);
    if data.len() / 4 * 3 > MAX_DATA_BYTES + 3 {
        return Err(format!(
            "data may be at most {} MB. For a larger image, pass its url instead. Nothing was created.",
            MAX_DATA_BYTES / 1024 / 1024
        ));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("data is not base64 ({e}). Nothing was created."))?;
    let mut spool = Spool::new(app).await.map_err(|e| e.detail)?;
    spool.push(&bytes).await.map_err(|e| e.detail)?;
    spool
        .store(app, filename, uploader)
        .await
        .map_err(not_an_image)
}

/// The image at a public URL.
pub async fn from_url(app: &AppState, raw: &str, uploader: &str) -> Result<Asset, Fail> {
    let allow_private = app.allow_private_imports.load(Ordering::Relaxed);
    let mut url = Url::parse(raw.trim())
        .map_err(|e| format!("'{raw}' is not a URL ({e}). Nothing was created."))?;
    for _ in 0..=MAX_REDIRECTS {
        if !matches!(url.scheme(), "http" | "https") {
            return Err(format!(
                "Only http and https URLs can be imported, not {}. Nothing was created.",
                url.scheme()
            ));
        }
        let host = url
            .host_str()
            .ok_or("The URL has no host. Nothing was created.")?
            .to_string();
        let port = url.port_or_known_default().unwrap_or(80);
        let addrs: Vec<SocketAddr> = match host.trim_matches(['[', ']']).parse::<IpAddr>() {
            Ok(ip) => vec![SocketAddr::new(ip, port)],
            Err(_) => tokio::net::lookup_host((host.as_str(), port))
                .await
                .map_err(|e| format!("{host} could not be resolved ({e}). Nothing was created."))?
                .collect(),
        };
        let Some(first) = addrs.first().copied() else {
            return Err(format!("{host} has no address. Nothing was created."));
        };
        if !allow_private && addrs.iter().any(|a| refused(a.ip())) {
            return Err(format!(
                "{host} is a private address, and images are imported only from public ones. Nothing was fetched or created."
            ));
        }
        // No environment proxy: it would connect on our behalf, past the
        // address pinned below.
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(TIMEOUT)
            .resolve(&host, first)
            .build()
            .map_err(|e| e.to_string())?;
        let mut response = client
            .get(url.clone())
            .send()
            .await
            .map_err(|e| format!("Fetching {url} failed ({e}). Nothing was created."))?;
        if response.status().is_redirection() {
            let to = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|l| l.to_str().ok())
                .ok_or("A redirect without a Location. Nothing was created.")?;
            url = url.join(to).map_err(|e| {
                format!("A redirect to '{to}' is not a URL ({e}). Nothing was created.")
            })?;
            continue;
        }
        if !response.status().is_success() {
            return Err(format!(
                "{url} answered {}. Nothing was created.",
                response.status()
            ));
        }
        let filename = url
            .path_segments()
            .and_then(|mut s| s.next_back())
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let mut spool = Spool::new(app).await.map_err(|e| e.detail)?;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| format!("Reading {url} failed ({e}). Nothing was created."))?
        {
            spool
                .push(&chunk)
                .await
                .map_err(|e| format!("{} Nothing was created.", e.detail))?;
        }
        return spool
            .store(app, filename, uploader)
            .await
            .map_err(not_an_image);
    }
    Err(format!(
        "{raw} redirected more than {MAX_REDIRECTS} times. Nothing was created."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_and_special_addresses_are_refused() {
        for ip in [
            "127.0.0.1",
            "10.0.0.5",
            "172.16.4.1",
            "192.168.1.10",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "224.0.0.1",
            "255.255.255.255",
            "::1",
            "::",
            "fc00::1",
            "fd12::1",
            "fe80::1",
            "ff02::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.5",
            "::ffff:169.254.169.254",
            "64:ff9b::a00:5",
            "64:ff9b::7f00:1",
            "2002:a00:5::",
            "2002:7f00:1::",
        ] {
            assert!(refused(ip.parse().unwrap()), "{ip} must be refused");
        }
    }

    #[test]
    fn public_addresses_are_allowed() {
        for ip in [
            "93.184.216.34",
            "1.1.1.1",
            "100.128.0.1",
            "2606:4700::1111",
            "::ffff:93.184.216.34",
            "64:ff9b::5db8:d822",
            "2002:5db8:d822::",
        ] {
            assert!(!refused(ip.parse().unwrap()), "{ip} is public");
        }
    }
}
