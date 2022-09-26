//! Network privacy layer: WireGuard tunnel control, exit-IP / Tor detection, DNS leak test,
//! and the proxy (Tor SOCKS) switch that every outbound request in the app honours.
//!
//! Nothing here is simulated. If `wireguard.exe` / `wg-quick` is missing or needs elevation,
//! the raw error is surfaced.

use serde::Serialize;
use serde_json::json;
use std::path::PathBuf;
use std::time::Duration;

use crate::db;
use crate::error::{AppError, AppResult};
use crate::procs::which;
use crate::state::AppState;

fn wg_dir(state: &AppState) -> PathBuf {
    state.data_dir.join("wg")
}

fn safe_name(name: &str) -> AppResult<String> {
    let n = name.trim().trim_end_matches(".conf");
    if n.is_empty() || n.len() > 15 || !n.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(AppError::Msg("tunnel name: 1-15 chars, letters/digits/-/_ (WireGuard interface naming)".into()));
    }
    Ok(n.to_string())
}

#[derive(Debug, Serialize, Clone)]
pub struct ConfSummary {
    pub name: String,
    pub endpoint: Option<String>,
    pub allowed_ips: Vec<String>,
    pub dns: Vec<String>,
    pub full_tunnel: bool,
    pub address: Option<String>,
}

fn summarize_conf(name: &str, content: &str) -> ConfSummary {
    let mut s = ConfSummary { name: name.into(), endpoint: None, allowed_ips: vec![], dns: vec![], full_tunnel: false, address: None };
    for line in content.lines() {
        let line = line.trim();
        if let Some((k, v)) = line.split_once('=') {
            let k = k.trim().to_ascii_lowercase();
            let v = v.trim();
            match k.as_str() {
                "endpoint" => s.endpoint = Some(v.into()),
                "allowedips" => s.allowed_ips.extend(v.split(',').map(|x| x.trim().to_string())),
                "dns" => s.dns.extend(v.split(',').map(|x| x.trim().to_string())),
                "address" => s.address = Some(v.into()),
                _ => {}
            }
        }
    }
    s.full_tunnel = s.allowed_ips.iter().any(|a| a == "0.0.0.0/0") ;
    s
}

#[derive(Debug, Serialize, Clone)]
pub struct Peer {
    pub public_key: String,
    pub endpoint: Option<String>,
    pub allowed_ips: Vec<String>,
    pub latest_handshake: Option<i64>,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
}

#[derive(Debug, Serialize, Clone)]
pub struct Tunnel {
    pub interface: String,
    pub listen_port: Option<u16>,
    pub peers: Vec<Peer>,
    pub handshake_fresh: bool,
}

fn parse_wg_dump(out: &str) -> Vec<Tunnel> {
    let mut tunnels: Vec<Tunnel> = vec![];
    for line in out.lines() {
        let cols: Vec<&str> = line.split('\t').collect();
        if cols.len() == 5 {
            // interface line: name, private key (discarded), public key, listen port, fwmark
            tunnels.push(Tunnel { interface: cols[0].into(), listen_port: cols[3].parse().ok(), peers: vec![], handshake_fresh: false });
        } else if cols.len() >= 8 {
            let hs: i64 = cols[5].parse().unwrap_or(0);
            let peer = Peer {
                public_key: cols[1].into(),
                endpoint: if cols[3] == "(none)" { None } else { Some(cols[3].into()) },
                allowed_ips: cols[4].split(',').map(|s| s.trim().to_string()).collect(),
                latest_handshake: if hs > 0 { Some(hs) } else { None },
                rx_bytes: cols[6].parse().unwrap_or(0),
                tx_bytes: cols[7].parse().unwrap_or(0),
            };
            if let Some(t) = tunnels.iter_mut().find(|t| t.interface == cols[0]) {
                if hs > 0 && db::now() - hs < 180 {
                    t.handshake_fresh = true;
                }
                t.peers.push(peer);
            }
        }
    }
    tunnels
}

async fn run(bin: &str, args: &[&str]) -> AppResult<(bool, String)> {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(args);
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x0800_0000);
    }
    let out = tokio::time::timeout(Duration::from_secs(25), cmd.output())
        .await
        .map_err(|_| AppError::Msg(format!("{bin} timed out")))?
        .map_err(|e| AppError::Msg(format!("{bin}: {e}")))?;
    let mut text = String::from_utf8_lossy(&out.stdout).to_string();
    let err = String::from_utf8_lossy(&out.stderr);
    if !err.trim().is_empty() {
        text.push_str(&err);
    }
    Ok((out.status.success(), text.trim().to_string()))
}

async fn tcp_open(addr: &str) -> bool {
    tokio::time::timeout(Duration::from_millis(1200), tokio::net::TcpStream::connect(addr)).await.map(|r| r.is_ok()).unwrap_or(false)
}

#[derive(Debug, Serialize)]
pub struct KillSwitch {
    pub state: String,
    pub reason: String,
}

#[derive(Debug, Serialize)]
pub struct NetStatus {
    pub platform: String,
    pub wireguard_bin: String,
    pub wireguard_found: bool,
    pub wg_bin: String,
    pub wg_found: bool,
    pub wg_error: Option<String>,
    pub tunnels: Vec<Tunnel>,
    pub configs: Vec<ConfSummary>,
    pub proxy_enabled: bool,
    pub proxy_url: String,
    pub tor_socks_reachable: bool,
    pub kill_switch: KillSwitch,
}

fn resolve_bin(path: &str) -> (bool, String) {
    if std::path::Path::new(path).is_file() {
        return (true, path.to_string());
    }
    match which(path) {
        Some(p) => (true, p.display().to_string()),
        None => (false, path.to_string()),
    }
}

#[tauri::command]
pub async fn net_status(state: tauri::State<'_, AppState>) -> AppResult<NetStatus> {
    let wireguard = state.setting("net.wireguard_path");
    let wg = state.setting("net.wg_path");
    let (wireguard_found, wireguard_bin) = resolve_bin(&wireguard);
    let (wg_found, wg_bin) = resolve_bin(&wg);
    let mut tunnels = vec![];
    let mut wg_error = None;
    if wg_found {
        match run(&wg_bin, &["show", "all", "dump"]).await {
            Ok((true, out)) => tunnels = parse_wg_dump(&out),
            Ok((false, out)) => wg_error = Some(if out.is_empty() { "wg show failed (needs elevation on Windows?)".into() } else { out }),
            Err(e) => wg_error = Some(e.to_string()),
        }
    }
    let configs = list_configs(&state)?;
    let proxy_url = state.setting("net.proxy_url");
    let proxy_enabled = state.setting_bool("net.proxy_enabled");
    let socks_hostport = proxy_url.split("://").last().unwrap_or("127.0.0.1:9050").trim_end_matches('/').to_string();
    let tor_socks_reachable = tcp_open(&socks_hostport).await;

    let kill_switch = if let Some(t) = tunnels.first() {
        let conf = configs.iter().find(|c| c.name == t.interface);
        match conf {
            Some(c) if c.full_tunnel => KillSwitch {
                state: "likely_on".into(),
                reason: if cfg!(target_os = "windows") {
                    "full-tunnel AllowedIPs; WireGuard for Windows blocks untunneled traffic by default for 0.0.0.0/0 configs (verify the toggle in the WireGuard UI)".into()
                } else {
                    "full-tunnel AllowedIPs; wg-quick installs a default-route + fwmark rule set that drops untunneled traffic (verify with your firewall)".into()
                },
            },
            Some(_) => KillSwitch { state: "off".into(), reason: "split-tunnel AllowedIPs - traffic outside the listed ranges bypasses the VPN".into() },
            None => KillSwitch { state: "unknown".into(), reason: "active tunnel was not imported here; cannot read its AllowedIPs".into() },
        }
    } else {
        KillSwitch { state: "off".into(), reason: "no active WireGuard tunnel".into() }
    };

    Ok(NetStatus {
        platform: std::env::consts::OS.into(),
        wireguard_bin,
        wireguard_found,
        wg_bin,
        wg_found,
        wg_error,
        tunnels,
        configs,
        proxy_enabled,
        proxy_url,
        tor_socks_reachable,
        kill_switch,
    })
}

fn list_configs(state: &AppState) -> AppResult<Vec<ConfSummary>> {
    let dir = wg_dir(state);
    let mut out = vec![];
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if let Some(stem) = name.strip_suffix(".conf") {
                if let Ok(content) = std::fs::read_to_string(e.path()) {
                    out.push(summarize_conf(stem, &content));
                }
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[tauri::command]
pub fn net_config_import(state: tauri::State<'_, AppState>, name: String, content: String) -> AppResult<ConfSummary> {
    let name = safe_name(&name)?;
    if !content.contains("[Interface]") || !content.contains("[Peer]") || !content.to_ascii_lowercase().contains("privatekey") {
        return Err(AppError::Msg("not a WireGuard config ([Interface] with PrivateKey and [Peer] required)".into()));
    }
    let dir = wg_dir(&state);
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{name}.conf"));
    std::fs::write(&path, content.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    state.net_log("config_import", Some(&name));
    Ok(summarize_conf(&name, &content))
}

#[tauri::command]
pub fn net_config_delete(state: tauri::State<'_, AppState>, name: String) -> AppResult<()> {
    let name = safe_name(&name)?;
    let path = wg_dir(&state).join(format!("{name}.conf"));
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    state.net_log("config_delete", Some(&name));
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct CmdResult {
    pub ok: bool,
    pub output: String,
}

#[tauri::command]
pub async fn net_up(state: tauri::State<'_, AppState>, name: String) -> AppResult<CmdResult> {
    let name = safe_name(&name)?;
    let path = wg_dir(&state).join(format!("{name}.conf"));
    if !path.exists() {
        return Err(AppError::Msg("config not found".into()));
    }
    let bin = state.setting("net.wireguard_path");
    let (found, bin) = resolve_bin(&bin);
    if !found {
        return Err(AppError::Msg(format!("WireGuard binary not found at '{bin}' (SETTINGS > network)")));
    }
    let p = path.display().to_string();
    let (ok, output) = if cfg!(target_os = "windows") {
        run(&bin, &["/installtunnelservice", &p]).await?
    } else {
        run(&bin, &["up", &p]).await?
    };
    let output = if output.is_empty() && !ok {
        "command failed silently - on Windows this usually means the app needs to run elevated (Administrator) to install the tunnel service".into()
    } else {
        output
    };
    state.net_log(if ok { "tunnel_up" } else { "tunnel_up_failed" }, Some(&format!("{name}: {output}")));
    state.log("network", "tunnel", if ok { "info" } else { "warn" }, &format!("tunnel {name} up: {}", if ok { "ok" } else { "failed" }), Some(json!({"output": output})));
    Ok(CmdResult { ok, output })
}

#[tauri::command]
pub async fn net_down(state: tauri::State<'_, AppState>, name: String) -> AppResult<CmdResult> {
    let name = safe_name(&name)?;
    let bin = state.setting("net.wireguard_path");
    let (found, bin) = resolve_bin(&bin);
    if !found {
        return Err(AppError::Msg(format!("WireGuard binary not found at '{bin}'")));
    }
    let (ok, output) = if cfg!(target_os = "windows") {
        run(&bin, &["/uninstalltunnelservice", &name]).await?
    } else {
        let path = wg_dir(&state).join(format!("{name}.conf")).display().to_string();
        run(&bin, &["down", &path]).await?
    };
    state.net_log(if ok { "tunnel_down" } else { "tunnel_down_failed" }, Some(&format!("{name}: {output}")));
    Ok(CmdResult { ok, output })
}

#[derive(Debug, Serialize)]
pub struct IpCheck {
    pub ip: Option<String>,
    pub is_tor: Option<bool>,
    pub via_proxy: bool,
    pub source: String,
    pub geo: Option<serde_json::Value>,
    pub error: Option<String>,
}

/// Exit-IP check through the app's normal path (proxy if enabled). `direct=true` bypasses the
/// proxy on purpose so you can compare - this reveals your real IP to the check service.
#[tauri::command]
pub async fn net_ip_check(state: tauri::State<'_, AppState>, direct: Option<bool>) -> AppResult<IpCheck> {
    let direct = direct.unwrap_or(false);
    let proxy = if direct { None } else { state.proxy() };
    let client = crate::http::build_client(proxy.as_deref(), 20)?;
    let url = state.setting("net.ip_check_url");
    let mut res = IpCheck { ip: None, is_tor: None, via_proxy: proxy.is_some(), source: url.clone(), geo: None, error: None };
    match crate::http::get_json(&client, &url, &[]).await {
        Ok(v) => {
            res.ip = v["IP"].as_str().or(v["ip"].as_str()).map(|s| s.to_string());
            res.is_tor = v["IsTor"].as_bool();
        }
        Err(e1) => {
            let fb = state.setting("net.ip_fallback_url");
            match client.get(&fb).send().await {
                Ok(r) => {
                    res.source = fb;
                    res.ip = r.text().await.ok().map(|t| t.trim().to_string());
                }
                Err(e2) => res.error = Some(format!("{e1}; fallback: {e2}")),
            }
        }
    }
    if state.setting_bool("net.geo_lookup") {
        if let Some(ip) = &res.ip {
            if let Ok(g) = crate::http::get_json(&client, &format!("https://ipapi.co/{ip}/json/"), &[]).await {
                res.geo = Some(json!({"country": g["country_name"], "org": g["org"], "asn": g["asn"], "city": g["city"]}));
            }
        }
    }
    state.net_log("ip_check", Some(&format!("{} tor={:?} proxy={}", res.ip.clone().unwrap_or_default(), res.is_tor, res.via_proxy)));
    Ok(res)
}

#[derive(Debug, Serialize)]
pub struct DnsLeakResult {
    pub test_id: String,
    pub your_ip: Vec<serde_json::Value>,
    pub dns_servers: Vec<serde_json::Value>,
    pub conclusion: Option<String>,
    pub resolver_queries_sent: usize,
}

/// Real DNS leak test (bash.ws): resolve N unique subdomains through the OS resolver, then ask
/// the service which resolvers hit its authoritative nameserver.
#[tauri::command]
pub async fn net_dns_leak(state: tauri::State<'_, AppState>) -> AppResult<DnsLeakResult> {
    let client = state.client_timeout(25)?;
    let id = client.get("https://bash.ws/id").send().await?.text().await?.trim().to_string();
    if id.is_empty() || id.len() > 32 {
        return Err(AppError::Msg("bash.ws returned no test id".into()));
    }
    let mut lookups = vec![];
    for i in 1..=10 {
        let host = format!("{id}.{i}.bash.ws:80");
        lookups.push(async move { let _ = tokio::time::timeout(Duration::from_secs(6), tokio::net::lookup_host(host)).await; });
    }
    futures::future::join_all(lookups).await;
    tokio::time::sleep(Duration::from_millis(800)).await;
    let v = crate::http::get_json(&client, &format!("https://bash.ws/dnsleak/test/{id}?json"), &[]).await?;
    let mut your_ip = vec![];
    let mut dns = vec![];
    let mut conclusion = None;
    if let Some(list) = v.as_array() {
        for e in list {
            match e["type"].as_str() {
                Some("ip") => your_ip.push(json!({"ip": e["ip"], "country": e["country_name"], "asn": e["asn"]})),
                Some("dns") => dns.push(json!({"ip": e["ip"], "country": e["country_name"], "asn": e["asn"]})),
                Some("conclusion") => conclusion = e["ip"].as_str().map(|s| s.to_string()),
                _ => {}
            }
        }
    }
    state.net_log("dns_leak_test", Some(&format!("{} resolvers seen; {}", dns.len(), conclusion.clone().unwrap_or_default())));
    Ok(DnsLeakResult { test_id: id, your_ip, dns_servers: dns, conclusion, resolver_queries_sent: 10 })
}

#[tauri::command]
pub fn net_log_list(state: tauri::State<'_, AppState>, limit: Option<i64>) -> AppResult<Vec<db::NetLogRow>> {
    let conn = state.db.lock();
    db::list_net_log(&conn, limit.unwrap_or(100))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dump_parse() {
        let out = "wg0\tPRIV\tPUB\t51820\toff\nwg0\tPEERPUB\t(none)\t1.2.3.4:51820\t0.0.0.0/0, ::/0\t0\t100\t200\toff\n";
        let t = parse_wg_dump(out);
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].peers.len(), 1);
        assert_eq!(t[0].peers[0].endpoint.as_deref(), Some("1.2.3.4:51820"));
        assert_eq!(t[0].peers[0].allowed_ips.len(), 2);
    }

    #[test]
    fn conf_summary() {
        let c = summarize_conf("x", "[Interface]\nPrivateKey = a\nAddress = 10.0.0.2/32\nDNS = 1.1.1.1\n[Peer]\nEndpoint = h:1\nAllowedIPs = 0.0.0.0/0, ::/0\n");
        assert!(c.full_tunnel);
        assert_eq!(c.dns, vec!["1.1.1.1"]);
    }
}
