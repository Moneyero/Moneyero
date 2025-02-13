//! Native Monero wallet via a locally managed `monero-wallet-rpc` process.
//!
//! The official wallet binary holds the keys (encrypted on disk with the wallet password);
//! Moneyero spawns it bound to 127.0.0.1 with a random per-session RPC login and talks
//! JSON-RPC over HTTP digest auth. Nothing wallet-related ever leaves this machine except
//! the normal wallet<->daemon traffic, which can be routed through Tor (`--proxy`).

use md5::Md5;
use reqwest::header::{AUTHORIZATION, WWW_AUTHENTICATE};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;

use crate::crypto::random_hex;
use crate::error::{AppError, AppResult};
use crate::procs::{self, ProcStatus};
use crate::settings;
use crate::state::AppState;

pub const PROC: &str = "monero-wallet-rpc";
pub const ATOMIC: u64 = 1_000_000_000_000;

#[derive(Default)]
pub struct MoneroSession {
    pub port: u16,
    pub user: String,
    pub pass: String,
    pub wallet: Option<String>,
}

pub fn wallet_dir(state: &AppState) -> PathBuf {
    state.data_dir.join("monero").join("wallets")
}

// ------------------------------------------------------------------ amounts

pub fn xmr_to_atomic(s: &str) -> AppResult<u64> {
    let s = s.trim();
    if s.is_empty() {
        return Err(AppError::Msg("amount required".into()));
    }
    let (int_part, frac_part) = match s.split_once('.') {
        Some((a, b)) => (a, b),
        None => (s, ""),
    };
    if !int_part.chars().all(|c| c.is_ascii_digit()) || !frac_part.chars().all(|c| c.is_ascii_digit()) {
        return Err(AppError::Msg("invalid amount".into()));
    }
    if frac_part.len() > 12 {
        return Err(AppError::Msg("XMR has at most 12 decimal places".into()));
    }
    let int_v: u64 = if int_part.is_empty() { 0 } else { int_part.parse().map_err(|_| AppError::Msg("amount too large".into()))? };
    let mut frac = frac_part.to_string();
    while frac.len() < 12 {
        frac.push('0');
    }
    let frac_v: u64 = frac.parse().unwrap_or(0);
    int_v.checked_mul(ATOMIC).and_then(|v| v.checked_add(frac_v)).ok_or_else(|| AppError::Msg("amount too large".into()))
}

pub fn atomic_to_xmr(a: u64) -> String {
    format!("{}.{:012}", a / ATOMIC, a % ATOMIC)
}

pub fn atomic_to_f64(a: u64) -> f64 {
    a as f64 / ATOMIC as f64
}

// ------------------------------------------------------------------ digest auth

fn parse_challenge(h: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let body = h.trim().strip_prefix("Digest").unwrap_or(h).trim();
    let mut key = String::new();
    let mut val = String::new();
    let mut in_val = false;
    let mut quoted = false;
    let flush = |key: &mut String, val: &mut String, out: &mut HashMap<String, String>| {
        if !key.trim().is_empty() {
            out.insert(key.trim().to_ascii_lowercase(), val.trim().to_string());
        }
        key.clear();
        val.clear();
    };
    for c in body.chars() {
        if quoted {
            if c == '"' {
                quoted = false;
            } else {
                val.push(c);
            }
            continue;
        }
        match c {
            '"' if in_val => quoted = true,
            '=' if !in_val => in_val = true,
            ',' => {
                flush(&mut key, &mut val, &mut out);
                in_val = false;
            }
            _ => {
                if in_val {
                    val.push(c)
                } else {
                    key.push(c)
                }
            }
        }
    }
    flush(&mut key, &mut val, &mut out);
    out
}

fn hash_with(alg: &str, s: &str) -> String {
    if alg.to_ascii_uppercase().starts_with("SHA-256") {
        hex::encode(Sha256::digest(s.as_bytes()))
    } else {
        hex::encode(Md5::digest(s.as_bytes()))
    }
}

fn digest_header(user: &str, pass: &str, method: &str, uri: &str, ch: &HashMap<String, String>) -> AppResult<String> {
    let realm = ch.get("realm").cloned().unwrap_or_default();
    let nonce = ch.get("nonce").cloned().ok_or_else(|| AppError::Msg("digest challenge missing nonce".into()))?;
    let algorithm = ch.get("algorithm").cloned().unwrap_or_else(|| "MD5".into());
    let qop = ch.get("qop").map(|q| q.split(',').any(|x| x.trim() == "auth")).unwrap_or(false);
    let ha1 = hash_with(&algorithm, &format!("{user}:{realm}:{pass}"));
    let ha2 = hash_with(&algorithm, &format!("{method}:{uri}"));
    let cnonce = random_hex(8);
    let nc = "00000001";
    let response = if qop {
        hash_with(&algorithm, &format!("{ha1}:{nonce}:{nc}:{cnonce}:auth:{ha2}"))
    } else {
        hash_with(&algorithm, &format!("{ha1}:{nonce}:{ha2}"))
    };
    let mut h = format!(
        r#"Digest username="{user}", realm="{realm}", nonce="{nonce}", uri="{uri}", algorithm={algorithm}, response="{response}""#
    );
    if qop {
        h.push_str(&format!(r#", qop=auth, nc={nc}, cnonce="{cnonce}""#));
    }
    if let Some(op) = ch.get("opaque") {
        h.push_str(&format!(r#", opaque="{op}""#));
    }
    Ok(h)
}

// ------------------------------------------------------------------ rpc

pub async fn rpc(state: &AppState, method: &str, params: Value) -> AppResult<Value> {
    let (port, user, pass) = {
        let s = state.monero.lock();
        if s.port == 0 {
            return Err(AppError::Msg("monero-wallet-rpc is not running (VAULT > start)".into()));
        }
        (s.port, s.user.clone(), s.pass.clone())
    };
    let client = state.local_client()?;
    let url = format!("http://127.0.0.1:{port}/json_rpc");
    let body = json!({"jsonrpc": "2.0", "id": "0", "method": method, "params": params});
    let mut resp = client.post(&url).json(&body).send().await?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        let mut chosen: Option<HashMap<String, String>> = None;
        for h in resp.headers().get_all(WWW_AUTHENTICATE) {
            if let Ok(s) = h.to_str() {
                let ch = parse_challenge(s);
                let is_md5 = ch.get("algorithm").map(|a| a.eq_ignore_ascii_case("MD5")).unwrap_or(true);
                if chosen.is_none() || is_md5 {
                    chosen = Some(ch);
                }
            }
        }
        let ch = chosen.ok_or_else(|| AppError::Msg("wallet-rpc 401 without digest challenge".into()))?;
        let auth = digest_header(&user, &pass, "POST", "/json_rpc", &ch)?;
        resp = client.post(&url).header(AUTHORIZATION, auth).json(&body).send().await?;
        if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(AppError::Msg("wallet-rpc rejected RPC credentials".into()));
        }
    }
    let v: Value = resp.json().await?;
    if let Some(e) = v.get("error") {
        return Err(AppError::Msg(format!(
            "wallet-rpc {}: {}",
            e.get("code").and_then(|c| c.as_i64()).unwrap_or(0),
            e.get("message").and_then(|m| m.as_str()).unwrap_or("error")
        )));
    }
    Ok(v.get("result").cloned().unwrap_or(Value::Null))
}

fn daemon_url(state: &AppState) -> String {
    let addr = state.setting("monero.daemon_address");
    if addr.contains("://") {
        return addr.trim_end_matches('/').to_string();
    }
    let ssl = state.setting("monero.daemon_ssl");
    let scheme = if ssl == "enabled" || addr.ends_with(":443") { "https" } else { "http" };
    format!("{scheme}://{addr}")
}

fn proxy_hostport(state: &AppState) -> Option<String> {
    let p = state.proxy()?;
    let hp = p.split("://").last().unwrap_or(&p).trim_end_matches('/').to_string();
    Some(hp)
}

// ------------------------------------------------------------------ commands

#[derive(Debug, Serialize)]
pub struct XmrStatus {
    pub process: ProcStatus,
    pub rpc_ok: bool,
    pub rpc_version: Option<u64>,
    pub wallet: Option<String>,
    pub wallet_height: Option<u64>,
    pub daemon_url: String,
    pub daemon_height: Option<u64>,
    pub daemon_target: Option<u64>,
    pub daemon_synced: Option<bool>,
    pub daemon_nettype: Option<String>,
    pub daemon_error: Option<String>,
    pub proxy: Option<String>,
    pub wallet_dir: String,
    pub binary: String,
}

#[tauri::command]
pub async fn xmr_status(state: tauri::State<'_, AppState>) -> AppResult<XmrStatus> {
    let process = procs::status(&state, PROC);
    let wallet = state.monero.lock().wallet.clone();
    let mut rpc_ok = false;
    let mut rpc_version = None;
    let mut wallet_height = None;
    if process.running {
        if let Ok(v) = rpc(&state, "get_version", json!({})).await {
            rpc_ok = true;
            rpc_version = v.get("version").and_then(|x| x.as_u64());
        }
        if wallet.is_some() {
            if let Ok(v) = rpc(&state, "get_height", json!({})).await {
                wallet_height = v.get("height").and_then(|x| x.as_u64());
            }
        }
    }
    let durl = daemon_url(&state);
    let (mut dh, mut dt, mut ds, mut dn, mut de) = (None, None, None, None, None);
    match state.client_timeout(12) {
        Ok(client) => match crate::http::get_json(&client, &format!("{durl}/get_info"), &[]).await {
            Ok(info) => {
                dh = info.get("height").and_then(|x| x.as_u64());
                dt = info.get("target_height").and_then(|x| x.as_u64());
                ds = info.get("synchronized").and_then(|x| x.as_bool());
                dn = info.get("nettype").and_then(|x| x.as_str()).map(|s| s.to_string());
            }
            Err(e) => de = Some(e.to_string()),
        },
        Err(e) => de = Some(e.to_string()),
    }
    Ok(XmrStatus {
        process,
        rpc_ok,
        rpc_version,
        wallet,
        wallet_height,
        daemon_url: durl,
        daemon_height: dh,
        daemon_target: dt,
        daemon_synced: ds,
        daemon_nettype: dn,
        daemon_error: de,
        proxy: state.proxy(),
        wallet_dir: wallet_dir(&state).display().to_string(),
        binary: state.setting("monero.wallet_rpc_path"),
    })
}

#[tauri::command]
pub async fn xmr_start(state: tauri::State<'_, AppState>) -> AppResult<ProcStatus> {
    let bin = state.setting("monero.wallet_rpc_path");
    let daemon = state.setting("monero.daemon_address");
    let ssl = state.setting("monero.daemon_ssl");
    let trusted = state.setting_bool("monero.trusted_daemon");
    let port = state.setting_u64("monero.rpc_port", 18083) as u16;
    let user = "moneyero".to_string();
    let pass = random_hex(16);
    let wdir = wallet_dir(&state);
    std::fs::create_dir_all(&wdir)?;
    let log_file = procs::log_dir(&state).join("monero-wallet-rpc.internal.log");

    let mut args: Vec<String> = vec![
        "--rpc-bind-ip".into(), "127.0.0.1".into(),
        "--rpc-bind-port".into(), port.to_string(),
        "--rpc-login".into(), format!("{user}:{pass}"),
        "--wallet-dir".into(), wdir.display().to_string(),
        "--daemon-address".into(), daemon.clone(),
        "--daemon-ssl".into(), if ssl.is_empty() { "autodetect".into() } else { ssl },
        "--log-file".into(), log_file.display().to_string(),
        "--log-level".into(), "0".into(),
        "--max-log-files".into(), "2".into(),
    ];
    args.push(if trusted { "--trusted-daemon".into() } else { "--untrusted-daemon".into() });
    let mut redact = vec![pass.clone()];
    if let Ok(Some(login)) = settings::secret_get_string(&state, "monero.daemon_login") {
        args.push("--daemon-login".into());
        args.push(login.clone());
        redact.push(login);
    }
    if let Some(hp) = proxy_hostport(&state) {
        args.push("--proxy".into());
        args.push(hp);
    }
    {
        let mut s = state.monero.lock();
        *s = MoneroSession { port, user, pass, wallet: None };
    }
    let st = procs::spawn(&state, PROC, &bin, &args, &redact)?;
    // Wait for RPC to come up.
    for _ in 0..30 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if rpc(&state, "get_version", json!({})).await.is_ok() {
            state.log("monero", "rpc_up", "info", &format!("wallet-rpc listening on 127.0.0.1:{port}"), None);
            return Ok(procs::status(&state, PROC));
        }
        if !procs::status(&state, PROC).running {
            break;
        }
    }
    let status = procs::status(&state, PROC);
    if !status.running {
        return Err(AppError::Msg(format!("wallet-rpc exited early. log tail:\n{}", status.log_tail)));
    }
    Ok(st)
}

#[tauri::command]
pub async fn xmr_stop(state: tauri::State<'_, AppState>) -> AppResult<bool> {
    let _ = rpc(&state, "close_wallet", json!({"autosave_current": true})).await;
    let _ = rpc(&state, "stop_wallet", json!({})).await;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let stopped = procs::stop(&state, PROC)?;
    *state.monero.lock() = MoneroSession::default();
    Ok(stopped)
}

#[tauri::command]
pub fn xmr_wallet_list(state: tauri::State<'_, AppState>) -> AppResult<Vec<String>> {
    let dir = wallet_dir(&state);
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if let Some(stem) = name.strip_suffix(".keys") {
                out.push(stem.to_string());
            }
        }
    }
    out.sort();
    Ok(out)
}

#[derive(Debug, Serialize)]
pub struct XmrWalletOpened {
    pub name: String,
    pub address: String,
    pub seed: Option<String>,
    pub restore_height: Option<u64>,
}

fn check_name(name: &str) -> AppResult<()> {
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(AppError::Msg("wallet name: letters, digits, - and _ only".into()));
    }
    Ok(())
}

#[tauri::command]
pub async fn xmr_create(state: tauri::State<'_, AppState>, name: String, password: String, language: Option<String>) -> AppResult<XmrWalletOpened> {
    check_name(&name)?;
    rpc(&state, "create_wallet", json!({"filename": name, "password": password, "language": language.unwrap_or_else(|| "English".into())})).await?;
    let addr = rpc(&state, "get_address", json!({"account_index": 0})).await?;
    let seed = rpc(&state, "query_key", json!({"key_type": "mnemonic"})).await?;
    let h = rpc(&state, "get_height", json!({})).await.ok();
    state.monero.lock().wallet = Some(name.clone());
    state.log("monero", "wallet_created", "info", &format!("wallet '{name}' created"), None);
    state.audit("user", "xmr.wallet_create", Some(json!({"name": name})));
    Ok(XmrWalletOpened {
        name,
        address: addr["address"].as_str().unwrap_or_default().to_string(),
        seed: seed["key"].as_str().map(|s| s.to_string()),
        restore_height: h.and_then(|v| v["height"].as_u64()),
    })
}

#[tauri::command]
pub async fn xmr_open(state: tauri::State<'_, AppState>, name: String, password: String) -> AppResult<XmrWalletOpened> {
    check_name(&name)?;
    rpc(&state, "open_wallet", json!({"filename": name, "password": password})).await?;
    let addr = rpc(&state, "get_address", json!({"account_index": 0})).await?;
    state.monero.lock().wallet = Some(name.clone());
    state.log("monero", "wallet_opened", "info", &format!("wallet '{name}' opened"), None);
    Ok(XmrWalletOpened { name, address: addr["address"].as_str().unwrap_or_default().to_string(), seed: None, restore_height: None })
}

#[tauri::command]
pub async fn xmr_restore(
    state: tauri::State<'_, AppState>,
    name: String,
    password: String,
    seed: String,
    restore_height: Option<u64>,
    seed_offset: Option<String>,
) -> AppResult<XmrWalletOpened> {
    check_name(&name)?;
    let words: Vec<&str> = seed.split_whitespace().collect();
    if words.len() != 25 && words.len() != 24 && words.len() != 13 {
        return Err(AppError::Msg(format!("expected a 25-word (or legacy 24/13-word) seed, got {} words", words.len())));
    }
    let mut params = json!({
        "filename": name, "password": password, "seed": words.join(" "),
        "restore_height": restore_height.unwrap_or(0), "language": "English", "autosave_current": true
    });
    if let Some(off) = seed_offset.filter(|s| !s.is_empty()) {
        params["seed_offset"] = Value::String(off);
    }
    let r = rpc(&state, "restore_deterministic_wallet", params).await?;
    state.monero.lock().wallet = Some(name.clone());
    state.log("monero", "wallet_restored", "info", &format!("wallet '{name}' restored from seed"), None);
    state.audit("user", "xmr.wallet_restore", Some(json!({"name": name, "restore_height": restore_height})));
    Ok(XmrWalletOpened {
        name,
        address: r["address"].as_str().unwrap_or_default().to_string(),
        seed: None,
        restore_height,
    })
}

#[tauri::command]
pub async fn xmr_close(state: tauri::State<'_, AppState>) -> AppResult<()> {
    rpc(&state, "close_wallet", json!({"autosave_current": true})).await?;
    state.monero.lock().wallet = None;
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct XmrSubaddress {
    pub index: u64,
    pub address: String,
    pub label: String,
    pub balance: f64,
    pub unlocked: f64,
    pub used: bool,
}

#[derive(Debug, Serialize)]
pub struct XmrBalance {
    pub balance: f64,
    pub unlocked: f64,
    pub balance_atomic: String,
    pub unlocked_atomic: String,
    pub blocks_to_unlock: u64,
    pub subaddresses: Vec<XmrSubaddress>,
}

#[tauri::command]
pub async fn xmr_balance(state: tauri::State<'_, AppState>) -> AppResult<XmrBalance> {
    let b = rpc(&state, "get_balance", json!({"account_index": 0, "all_accounts": false, "strict": false})).await?;
    let bal = b["balance"].as_u64().unwrap_or(0);
    let unl = b["unlocked_balance"].as_u64().unwrap_or(0);
    let mut subs = Vec::new();
    // get_balance only lists subaddresses with funds; merge with get_address for the full set.
    let addrs = rpc(&state, "get_address", json!({"account_index": 0})).await?;
    let mut by_index: HashMap<u64, XmrSubaddress> = HashMap::new();
    if let Some(list) = addrs["addresses"].as_array() {
        for a in list {
            let idx = a["address_index"].as_u64().unwrap_or(0);
            by_index.insert(
                idx,
                XmrSubaddress {
                    index: idx,
                    address: a["address"].as_str().unwrap_or_default().into(),
                    label: a["label"].as_str().unwrap_or_default().into(),
                    balance: 0.0,
                    unlocked: 0.0,
                    used: a["used"].as_bool().unwrap_or(false),
                },
            );
        }
    }
    if let Some(list) = b["per_subaddress"].as_array() {
        for s in list {
            let idx = s["address_index"].as_u64().unwrap_or(0);
            let e = by_index.entry(idx).or_insert_with(|| XmrSubaddress {
                index: idx,
                address: s["address"].as_str().unwrap_or_default().into(),
                label: s["label"].as_str().unwrap_or_default().into(),
                balance: 0.0,
                unlocked: 0.0,
                used: true,
            });
            e.balance = atomic_to_f64(s["balance"].as_u64().unwrap_or(0));
            e.unlocked = atomic_to_f64(s["unlocked_balance"].as_u64().unwrap_or(0));
        }
    }
    let mut keys: Vec<u64> = by_index.keys().copied().collect();
    keys.sort();
    for k in keys {
        if let Some(v) = by_index.remove(&k) {
            subs.push(v);
        }
    }
    Ok(XmrBalance {
        balance: atomic_to_f64(bal),
        unlocked: atomic_to_f64(unl),
        balance_atomic: atomic_to_xmr(bal),
        unlocked_atomic: atomic_to_xmr(unl),
        blocks_to_unlock: b["blocks_to_unlock"].as_u64().unwrap_or(0),
        subaddresses: subs,
    })
}

#[tauri::command]
pub async fn xmr_new_subaddress(state: tauri::State<'_, AppState>, label: Option<String>) -> AppResult<Value> {
    let r = rpc(&state, "create_address", json!({"account_index": 0, "label": label.unwrap_or_default()})).await?;
    state.log("monero", "subaddress", "info", "new subaddress created", None);
    Ok(r)
}

#[derive(Debug, Serialize)]
pub struct XmrPreparedTx {
    pub tx_hash: String,
    pub amount: f64,
    pub fee: f64,
    pub tx_metadata: String,
    pub destination: String,
}

#[tauri::command]
pub async fn xmr_prepare_transfer(
    state: tauri::State<'_, AppState>,
    address: String,
    amount: String,
    priority: Option<u32>,
) -> AppResult<XmrPreparedTx> {
    let atomic = xmr_to_atomic(&amount)?;
    if atomic == 0 {
        return Err(AppError::Msg("amount must be > 0".into()));
    }
    let v = rpc(&state, "validate_address", json!({"address": address, "any_net_type": false, "allow_openalias": false})).await?;
    if !v["valid"].as_bool().unwrap_or(false) {
        return Err(AppError::Msg("invalid Monero address".into()));
    }
    let r = rpc(
        &state,
        "transfer",
        json!({
            "destinations": [{"amount": atomic, "address": address}],
            "account_index": 0,
            "priority": priority.unwrap_or(0),
            "do_not_relay": true,
            "get_tx_metadata": true,
            "get_tx_hex": false
        }),
    )
    .await?;
    Ok(XmrPreparedTx {
        tx_hash: r["tx_hash"].as_str().unwrap_or_default().into(),
        amount: atomic_to_f64(r["amount"].as_u64().unwrap_or(atomic)),
        fee: atomic_to_f64(r["fee"].as_u64().unwrap_or(0)),
        tx_metadata: r["tx_metadata"].as_str().unwrap_or_default().into(),
        destination: address,
    })
}

#[tauri::command]
pub async fn xmr_relay(state: tauri::State<'_, AppState>, tx_metadata: String, note: Option<String>) -> AppResult<String> {
    let r = rpc(&state, "relay_tx", json!({"hex": tx_metadata})).await?;
    let hash = r["tx_hash"].as_str().unwrap_or_default().to_string();
    state.log("monero", "send", "info", &format!("XMR tx relayed {hash}"), Some(json!({"tx_hash": hash, "note": note})));
    state.audit("user", "xmr.send", Some(json!({"tx_hash": hash})));
    Ok(hash)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct XmrTransfer {
    pub kind: String,
    pub txid: String,
    pub amount: f64,
    pub fee: f64,
    pub height: u64,
    pub timestamp: u64,
    pub confirmations: u64,
    pub address: String,
    pub subaddr_index: u64,
    pub note: String,
    pub locked: bool,
}

#[tauri::command]
pub async fn xmr_transfers(state: tauri::State<'_, AppState>) -> AppResult<Vec<XmrTransfer>> {
    let r = rpc(
        &state,
        "get_transfers",
        json!({"in": true, "out": true, "pending": true, "failed": true, "pool": true, "account_index": 0}),
    )
    .await?;
    let mut out = Vec::new();
    for kind in ["in", "out", "pending", "failed", "pool"] {
        if let Some(list) = r[kind].as_array() {
            for t in list {
                out.push(XmrTransfer {
                    kind: kind.into(),
                    txid: t["txid"].as_str().unwrap_or_default().into(),
                    amount: atomic_to_f64(t["amount"].as_u64().unwrap_or(0)),
                    fee: atomic_to_f64(t["fee"].as_u64().unwrap_or(0)),
                    height: t["height"].as_u64().unwrap_or(0),
                    timestamp: t["timestamp"].as_u64().unwrap_or(0),
                    confirmations: t["confirmations"].as_u64().unwrap_or(0),
                    address: t["address"].as_str().unwrap_or_default().into(),
                    subaddr_index: t["subaddr_index"]["minor"].as_u64().unwrap_or(0),
                    note: t["note"].as_str().unwrap_or_default().into(),
                    locked: t["locked"].as_bool().unwrap_or(false),
                });
            }
        }
    }
    out.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(out)
}

#[tauri::command]
pub async fn xmr_seed(state: tauri::State<'_, AppState>) -> AppResult<String> {
    if !state.vault_unlocked() {
        return Err(AppError::VaultLocked);
    }
    let r = rpc(&state, "query_key", json!({"key_type": "mnemonic"})).await?;
    state.audit("user", "xmr.seed_viewed", None);
    Ok(r["key"].as_str().unwrap_or_default().to_string())
}

#[tauri::command]
pub async fn xmr_refresh(state: tauri::State<'_, AppState>) -> AppResult<Value> {
    let r = rpc(&state, "refresh", json!({})).await?;
    let _ = rpc(&state, "store", json!({})).await;
    Ok(r)
}

#[tauri::command]
pub async fn xmr_rescan(state: tauri::State<'_, AppState>, hard: Option<bool>) -> AppResult<()> {
    rpc(&state, "rescan_blockchain", json!({"hard": hard.unwrap_or(false)})).await?;
    state.log("monero", "rescan", "info", "blockchain rescan started", None);
    Ok(())
}

#[tauri::command]
pub async fn xmr_validate(state: tauri::State<'_, AppState>, address: String) -> AppResult<Value> {
    rpc(&state, "validate_address", json!({"address": address, "any_net_type": false, "allow_openalias": false})).await
}

#[tauri::command]
pub async fn xmr_set_daemon(state: tauri::State<'_, AppState>, address: String, ssl: String, trusted: bool) -> AppResult<()> {
    {
        let conn = state.db.lock();
        settings::set(&conn, "monero.daemon_address", &address)?;
        settings::set(&conn, "monero.daemon_ssl", &ssl)?;
        settings::set(&conn, "monero.trusted_daemon", if trusted { "true" } else { "false" })?;
    }
    if state.monero.lock().port != 0 {
        let _ = rpc(&state, "set_daemon", json!({"address": address, "trusted": trusted, "ssl_support": ssl})).await?;
    }
    state.log("monero", "daemon_changed", "info", &format!("daemon set to {address}"), None);
    Ok(())
}

// ---------------------------------------------------------------- coin control
//
// Monero's `transfer` RPC picks inputs itself. The wallet-side way to control which outputs a
// transaction may spend is to freeze every other output first (what Feather does). The commands
// below expose the wallet's own output list and freeze/thaw, and `xmr_prepare_transfer_from`
// does the freeze → construct → thaw dance inside one call so no output is left frozen by accident.

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct XmrOutput {
    pub key_image: String,
    pub amount: f64,
    pub spent: bool,
    pub frozen: bool,
    pub unlocked: bool,
    pub global_index: u64,
    pub tx_hash: String,
    pub subaddr_index: u64,
    pub height: u64,
    pub confirmations: u64,
}

fn parse_outputs(r: &Value, wallet_height: u64) -> Vec<XmrOutput> {
    let mut out = Vec::new();
    if let Some(list) = r["transfers"].as_array() {
        for t in list {
            let height = t["block_height"].as_u64().unwrap_or(0);
            let conf = if height > 0 && wallet_height >= height { wallet_height - height + 1 } else { 0 };
            out.push(XmrOutput {
                key_image: t["key_image"].as_str().unwrap_or_default().into(),
                amount: atomic_to_f64(t["amount"].as_u64().unwrap_or(0)),
                spent: t["spent"].as_bool().unwrap_or(false),
                frozen: t["frozen"].as_bool().unwrap_or(false),
                // Older wallet-rpc versions omit `unlocked`; fall back to the 10-block rule.
                unlocked: t["unlocked"].as_bool().unwrap_or(conf >= 10),
                global_index: t["global_index"].as_u64().unwrap_or(0),
                tx_hash: t["tx_hash"].as_str().unwrap_or_default().into(),
                subaddr_index: t["subaddr_index"]["minor"].as_u64().unwrap_or(0),
                height,
                confirmations: conf,
            });
        }
    }
    out.sort_by(|a, b| b.height.cmp(&a.height).then(b.global_index.cmp(&a.global_index)));
    out
}

#[tauri::command]
pub async fn xmr_outputs(state: tauri::State<'_, AppState>, include_spent: Option<bool>) -> AppResult<Vec<XmrOutput>> {
    let h = rpc(&state, "get_height", json!({})).await?;
    let wallet_height = h["height"].as_u64().unwrap_or(0);
    let r = rpc(
        &state,
        "incoming_transfers",
        json!({"transfer_type": if include_spent.unwrap_or(false) { "all" } else { "available" }, "account_index": 0}),
    )
    .await?;
    Ok(parse_outputs(&r, wallet_height))
}

fn check_key_image(ki: &str) -> AppResult<()> {
    if ki.len() != 64 || !ki.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(AppError::Msg("invalid key image".into()));
    }
    Ok(())
}

#[tauri::command]
pub async fn xmr_freeze(state: tauri::State<'_, AppState>, key_image: String, frozen: bool) -> AppResult<()> {
    check_key_image(&key_image)?;
    rpc(&state, if frozen { "freeze" } else { "thaw" }, json!({"key_image": key_image})).await?;
    let _ = rpc(&state, "store", json!({})).await;
    state.log("monero", if frozen { "freeze" } else { "thaw" }, "info", &format!("output {} {}", &key_image[..12], if frozen { "frozen" } else { "thawed" }), None);
    Ok(())
}

/// Freeze every spendable output that is not in `keep`, run `f`, then thaw exactly what we froze.
async fn with_only<F, Fut, T>(state: &AppState, keep: &[String], f: F) -> AppResult<T>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = AppResult<T>>,
{
    let r = rpc(state, "incoming_transfers", json!({"transfer_type": "available", "account_index": 0})).await?;
    let all = parse_outputs(&r, u64::MAX);
    let mut froze = Vec::new();
    for o in all.iter().filter(|o| !o.frozen && !o.spent && !keep.contains(&o.key_image)) {
        rpc(state, "freeze", json!({"key_image": o.key_image})).await?;
        froze.push(o.key_image.clone());
    }
    let res = f().await;
    let mut thaw_err = None;
    for ki in &froze {
        if let Err(e) = rpc(state, "thaw", json!({"key_image": ki})).await {
            thaw_err = Some(e);
        }
    }
    if let Some(e) = thaw_err {
        state.log("monero", "coin_control", "error", "failed to thaw an output after constructing a transaction; check the outputs panel", None);
        return Err(e);
    }
    res
}

#[tauri::command]
pub async fn xmr_prepare_transfer_from(
    state: tauri::State<'_, AppState>,
    address: String,
    amount: String,
    priority: Option<u32>,
    key_images: Vec<String>,
) -> AppResult<XmrPreparedTx> {
    if key_images.is_empty() {
        return Err(AppError::Msg("select at least one output".into()));
    }
    for ki in &key_images {
        check_key_image(ki)?;
    }
    let atomic = xmr_to_atomic(&amount)?;
    if atomic == 0 {
        return Err(AppError::Msg("amount must be > 0".into()));
    }
    let v = rpc(&state, "validate_address", json!({"address": address, "any_net_type": false, "allow_openalias": false})).await?;
    if !v["valid"].as_bool().unwrap_or(false) {
        return Err(AppError::Msg("invalid Monero address".into()));
    }
    let st = &*state;
    let addr = address.clone();
    let r = with_only(st, &key_images, || async move {
        rpc(
            st,
            "transfer",
            json!({
                "destinations": [{"amount": atomic, "address": addr}],
                "account_index": 0,
                "priority": priority.unwrap_or(0),
                "do_not_relay": true,
                "get_tx_metadata": true,
                "get_tx_hex": false
            }),
        )
        .await
    })
    .await?;
    state.log("monero", "coin_control", "info", &format!("transaction built from {} selected output(s)", key_images.len()), None);
    Ok(XmrPreparedTx {
        tx_hash: r["tx_hash"].as_str().unwrap_or_default().into(),
        amount: atomic_to_f64(r["amount"].as_u64().unwrap_or(atomic)),
        fee: atomic_to_f64(r["fee"].as_u64().unwrap_or(0)),
        tx_metadata: r["tx_metadata"].as_str().unwrap_or_default().into(),
        destination: address,
    })
}

/// Churn: sweep one output, whole, to a fresh subaddress of this wallet. Breaks the link
/// between how the coin arrived and how it will later leave. Costs a fee, nothing else moves.
#[tauri::command]
pub async fn xmr_prepare_churn(state: tauri::State<'_, AppState>, key_image: String, priority: Option<u32>) -> AppResult<XmrPreparedTx> {
    check_key_image(&key_image)?;
    let sub = rpc(&state, "create_address", json!({"account_index": 0, "label": "churn"})).await?;
    let dest = sub["address"].as_str().unwrap_or_default().to_string();
    if dest.is_empty() {
        return Err(AppError::Msg("could not create a churn subaddress".into()));
    }
    let r = rpc(
        &state,
        "sweep_single",
        json!({
            "address": dest,
            "key_image": key_image,
            "priority": priority.unwrap_or(0),
            "do_not_relay": true,
            "get_tx_metadata": true,
            "get_tx_hex": false
        }),
    )
    .await?;
    state.log("monero", "churn", "info", &format!("churn prepared for output {}", &key_image[..12]), None);
    Ok(XmrPreparedTx {
        tx_hash: r["tx_hash"].as_str().unwrap_or_default().into(),
        amount: atomic_to_f64(r["amount"].as_u64().unwrap_or(0)),
        fee: atomic_to_f64(r["fee"].as_u64().unwrap_or(0)),
        tx_metadata: r["tx_metadata"].as_str().unwrap_or_default().into(),
        destination: dest,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outputs_parse_and_sort() {
        let v = json!({"transfers": [
            {"amount": 1_000_000_000_000u64, "spent": false, "global_index": 5, "tx_hash": "a", "key_image": "k1", "block_height": 100, "subaddr_index": {"major": 0, "minor": 2}},
            {"amount": 500_000_000_000u64, "spent": false, "frozen": true, "unlocked": true, "global_index": 9, "tx_hash": "b", "key_image": "k2", "block_height": 120, "subaddr_index": {"major": 0, "minor": 0}}
        ]});
        let o = parse_outputs(&v, 125);
        assert_eq!(o.len(), 2);
        assert_eq!(o[0].key_image, "k2");
        assert!(o[0].frozen && o[0].unlocked);
        assert_eq!(o[0].confirmations, 6);
        assert_eq!(o[1].subaddr_index, 2);
        assert!(o[1].unlocked, "26 confirmations passes the 10-block fallback");
        assert!((o[1].amount - 1.0).abs() < 1e-12);
    }

    #[test]
    fn key_image_shape() {
        assert!(check_key_image(&"ab".repeat(32)).is_ok());
        assert!(check_key_image("zz").is_err());
    }

    #[test]
    fn amounts() {
        assert_eq!(xmr_to_atomic("1").unwrap(), ATOMIC);
        assert_eq!(xmr_to_atomic("0.5").unwrap(), ATOMIC / 2);
        assert_eq!(xmr_to_atomic("0.000000000001").unwrap(), 1);
        assert!(xmr_to_atomic("0.0000000000001").is_err());
        assert_eq!(atomic_to_xmr(1_500_000_000_000), "1.500000000000");
    }

    #[test]
    fn challenge() {
        let ch = parse_challenge(r#"Digest qop="auth",algorithm=MD5,realm="monero-rpc",nonce="abc==",stale=false"#);
        assert_eq!(ch["realm"], "monero-rpc");
        assert_eq!(ch["nonce"], "abc==");
        assert_eq!(ch["algorithm"], "MD5");
    }
}
