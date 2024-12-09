//! Outbound HTTP. Every request the app makes - market data, swap providers, IP checks,
//! the Claude API, even the frontend's Solana RPC traffic - goes through this client so a
//! single setting (NETWORK > proxy / Tor) governs all of it.

use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub const USER_AGENT: &str = "Mozilla/5.0 (compatible; moneyero/0.1)";

pub fn build_client(proxy: Option<&str>, timeout_secs: u64) -> AppResult<reqwest::Client> {
    let mut b = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .connect_timeout(Duration::from_secs(15))
        .user_agent(USER_AGENT)
        .redirect(Policy::limited(3));
    if let Some(p) = proxy.filter(|p| !p.trim().is_empty()) {
        b = b.proxy(reqwest::Proxy::all(p)?);
    }
    Ok(b.build()?)
}

#[derive(Debug, Deserialize)]
pub struct HttpReq {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
    pub timeout_secs: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct HttpResp {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}

fn is_loopback_url(u: &reqwest::Url) -> bool {
    match u.host_str() {
        Some("127.0.0.1") | Some("localhost") | Some("[::1]") | Some("::1") => true,
        _ => false,
    }
}

/// Frontend fetch bridge. HTTPS anywhere; plain HTTP only to loopback (local nodes/RPC).
#[tauri::command]
pub async fn http_request(state: tauri::State<'_, AppState>, req: HttpReq) -> AppResult<HttpResp> {
    let url = reqwest::Url::parse(&req.url).map_err(|e| AppError::Msg(format!("bad url: {e}")))?;
    match url.scheme() {
        "https" => {}
        "http" if is_loopback_url(&url) => {}
        s => return Err(AppError::Msg(format!("scheme {s} not allowed for {}", url.host_str().unwrap_or("?")))),
    }
    // Loopback traffic must never be sent through the proxy.
    let proxy = if is_loopback_url(&url) { None } else { state.proxy() };
    let client = build_client(proxy.as_deref(), req.timeout_secs.unwrap_or(30))?;
    let method = reqwest::Method::from_bytes(req.method.to_uppercase().as_bytes())
        .map_err(|_| AppError::Msg("bad method".into()))?;
    let mut rb = client.request(method, url);
    for (k, v) in &req.headers {
        rb = rb.header(k, v);
    }
    if let Some(b) = req.body {
        rb = rb.body(b);
    }
    let resp = rb.send().await?;
    let status = resp.status().as_u16();
    let mut headers = HashMap::new();
    for (k, v) in resp.headers() {
        if let Ok(s) = v.to_str() {
            headers.insert(k.to_string(), s.to_string());
        }
    }
    let body = resp.text().await?;
    Ok(HttpResp { status, headers, body })
}

/// Convenience: GET JSON through the app client.
pub async fn get_json(client: &reqwest::Client, url: &str, headers: &[(&str, &str)]) -> AppResult<serde_json::Value> {
    let mut rb = client.get(url);
    for (k, v) in headers {
        rb = rb.header(*k, *v);
    }
    let resp = rb.send().await?;
    let status = resp.status();
    let text = resp.text().await?;
    if !status.is_success() {
        return Err(AppError::Msg(format!("HTTP {} from {}: {}", status.as_u16(), url, truncate(&text, 300))));
    }
    serde_json::from_str(&text).map_err(|e| AppError::Msg(format!("bad json from {url}: {e}")))
}

pub async fn post_json(
    client: &reqwest::Client,
    url: &str,
    headers: &[(&str, &str)],
    body: &serde_json::Value,
) -> AppResult<serde_json::Value> {
    let mut rb = client.post(url).json(body);
    for (k, v) in headers {
        rb = rb.header(*k, *v);
    }
    let resp = rb.send().await?;
    let status = resp.status();
    let text = resp.text().await?;
    if !status.is_success() {
        return Err(AppError::Msg(format!("HTTP {} from {}: {}", status.as_u16(), url, truncate(&text, 400))));
    }
    serde_json::from_str(&text).map_err(|e| AppError::Msg(format!("bad json from {url}: {e}")))
}

pub fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let t: String = s.chars().take(n).collect();
        format!("{t}...")
    }
}
