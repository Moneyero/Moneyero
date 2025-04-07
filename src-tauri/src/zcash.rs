//! Native Zcash wallet via the zcashd / zallet JSON-RPC interface (Bitcoin-style RPC).
//!
//! Works against a local `zcashd` (deprecated upstream but still the reference full-node
//! wallet) or `zallet`, its successor, which keeps the same wallet RPC surface
//! (`z_getbalanceforaccount`, `z_sendmany`, `z_getaddressforaccount`, ...).
//! Keys live inside the node wallet on this machine. Moneyero never sees them.
//!
//! Shielded vs transparent is tracked explicitly: every address and every balance is
//! tagged with its pool, and sends default to `FullPrivacy`.

use serde::Serialize;
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::procs::{self, ProcStatus};
use crate::settings;
use crate::state::AppState;

pub const PROC: &str = "zcash-node";

fn is_loopback(url: &str) -> bool {
    url.contains("127.0.0.1") || url.contains("localhost") || url.contains("[::1]")
}

fn cookie_credentials(state: &AppState) -> Option<(String, String)> {
    let datadir = state.setting("zcash.datadir");
    if datadir.trim().is_empty() {
        return None;
    }
    let content = std::fs::read_to_string(std::path::Path::new(&datadir).join(".cookie")).ok()?;
    let (u, p) = content.trim().split_once(':')?;
    Some((u.to_string(), p.to_string()))
}

async fn credentials(state: &AppState) -> AppResult<(String, String)> {
    let user = state.setting("zcash.rpc_user");
    let stored = {
        let conn = state.db.lock();
        settings::secret_exists(&conn, "zcash.rpc_pass")?
    };
    if stored {
        let pass = settings::secret_get_string(state, "zcash.rpc_pass")?.unwrap_or_default();
        return Ok((user, pass));
    }
    if let Some(c) = cookie_credentials(state) {
        return Ok(c);
    }
    Ok((user, String::new()))
}

pub async fn rpc(state: &AppState, method: &str, params: Vec<Value>) -> AppResult<Value> {
    let url = state.setting("zcash.rpc_url");
    if url.trim().is_empty() {
        return Err(AppError::Msg("zcash.rpc_url not configured".into()));
    }
    let (user, pass) = credentials(state).await?;
    let client = if is_loopback(&url) { state.local_client()? } else { state.client_timeout(60)? };
    let body = json!({"jsonrpc": "1.0", "id": "moneyero", "method": method, "params": params});
    let resp = client
        .post(&url)
        .basic_auth(user, Some(pass))
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Msg(format!("zcash rpc unreachable at {url}: {e}")))?;
    let status = resp.status();
    let text = resp.text().await?;
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(AppError::Msg("zcash rpc: unauthorized (check rpcuser/rpcpassword or cookie)".into()));
    }
    let v: Value = serde_json::from_str(&text)
        .map_err(|_| AppError::Msg(format!("zcash rpc: non-JSON response (HTTP {}): {}", status.as_u16(), crate::http::truncate(&text, 200))))?;
    if let Some(e) = v.get("error").filter(|e| !e.is_null()) {
        return Err(AppError::Msg(format!(
            "zcash rpc {}: {}",
            e.get("code").and_then(|c| c.as_i64()).unwrap_or(0),
            e.get("message").and_then(|m| m.as_str()).unwrap_or("error")
        )));
    }
    Ok(v.get("result").cloned().unwrap_or(Value::Null))
}

// ------------------------------------------------------------------ status

#[derive(Debug, Serialize)]
pub struct ZecStatus {
    pub process: ProcStatus,
    pub reachable: bool,
    pub error: Option<String>,
    pub chain: Option<String>,
    pub blocks: Option<u64>,
    pub headers: Option<u64>,
    pub verification_progress: Option<f64>,
    pub version: Option<Value>,
    pub backend: String,
    pub rpc_url: String,
    pub wallet_version: Option<i64>,
}

#[tauri::command]
pub async fn zec_status(state: tauri::State<'_, AppState>) -> AppResult<ZecStatus> {
    let process = procs::status(&state, PROC);
    let rpc_url = state.setting("zcash.rpc_url");
    let mut st = ZecStatus {
        process,
        reachable: false,
        error: None,
        chain: None,
        blocks: None,
        headers: None,
        verification_progress: None,
        version: None,
        backend: "unknown".into(),
        rpc_url,
        wallet_version: None,
    };
    match rpc(&state, "getblockchaininfo", vec![]).await {
        Ok(v) => {
            st.reachable = true;
            st.chain = v["chain"].as_str().map(|s| s.to_string());
            st.blocks = v["blocks"].as_u64();
            st.headers = v["headers"].as_u64();
            st.verification_progress = v["verificationprogress"].as_f64();
        }
        Err(e) => {
            st.error = Some(e.to_string());
            return Ok(st);
        }
    }
    if let Ok(info) = rpc(&state, "getinfo", vec![]).await {
        st.version = info.get("version").cloned();
        st.backend = if info.get("build").and_then(|b| b.as_str()).map(|b| b.contains("zallet")).unwrap_or(false) {
            "zallet".into()
        } else {
            "zcashd".into()
        };
    }
    if let Ok(w) = rpc(&state, "getwalletinfo", vec![]).await {
        st.wallet_version = w["walletversion"].as_i64();
    }
    Ok(st)
}

// ------------------------------------------------------------------ balances

#[derive(Debug, Serialize)]
pub struct ZecPoolBalance {
    pub pool: String,
    pub zec: f64,
    pub shielded: bool,
}

#[derive(Debug, Serialize)]
pub struct ZecBalance {
    pub transparent: f64,
    pub shielded: f64,
    pub total: f64,
    pub pools: Vec<ZecPoolBalance>,
    pub min_conf: u32,
}

fn parse_zec(v: &Value) -> f64 {
    match v {
        Value::String(s) => s.parse().unwrap_or(0.0),
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        _ => 0.0,
    }
}

#[tauri::command]
pub async fn zec_balance(state: tauri::State<'_, AppState>) -> AppResult<ZecBalance> {
    let t = rpc(&state, "z_gettotalbalance", vec![json!(1)]).await?;
    let transparent = parse_zec(&t["transparent"]);
    let shielded = parse_zec(&t["private"]);
    let total = parse_zec(&t["total"]);
    let mut pools = vec![];
    // Per-pool breakdown is only available for unified accounts (zcashd >= 5.0 / zallet).
    if let Ok(accts) = rpc(&state, "z_listaccounts", vec![]).await {
        let mut sapling = 0.0;
        let mut orchard = 0.0;
        let mut t_acct = 0.0;
        if let Some(list) = accts.as_array() {
            for a in list {
                if let Some(acct) = a["account"].as_u64() {
                    if let Ok(b) = rpc(&state, "z_getbalanceforaccount", vec![json!(acct), json!(1)]).await {
                        sapling += b["pools"]["sapling"]["valueZat"].as_f64().unwrap_or(0.0) / 1e8;
                        orchard += b["pools"]["orchard"]["valueZat"].as_f64().unwrap_or(0.0) / 1e8;
                        t_acct += b["pools"]["transparent"]["valueZat"].as_f64().unwrap_or(0.0) / 1e8;
                    }
                }
            }
        }
        if sapling > 0.0 || orchard > 0.0 || t_acct > 0.0 {
            pools.push(ZecPoolBalance { pool: "orchard".into(), zec: orchard, shielded: true });
            pools.push(ZecPoolBalance { pool: "sapling".into(), zec: sapling, shielded: true });
            pools.push(ZecPoolBalance { pool: "transparent (accounts)".into(), zec: t_acct, shielded: false });
        }
    }
    Ok(ZecBalance { transparent, shielded, total, pools, min_conf: 1 })
}

// ------------------------------------------------------------------ addresses

#[derive(Debug, Serialize)]
pub struct ZecAddress {
    pub address: String,
    pub pool: String,
    pub shielded: bool,
    pub account: Option<u64>,
    pub receiver_types: Vec<String>,
    pub balance: f64,
}

#[tauri::command]
pub async fn zec_addresses(state: tauri::State<'_, AppState>) -> AppResult<Vec<ZecAddress>> {
    let la = rpc(&state, "listaddresses", vec![]).await?;
    let mut out: Vec<ZecAddress> = Vec::new();
    if let Some(sources) = la.as_array() {
        for src in sources {
            if let Some(t) = src["transparent"]["addresses"].as_array() {
                for a in t {
                    if let Some(s) = a.as_str() {
                        out.push(ZecAddress { address: s.into(), pool: "transparent".into(), shielded: false, account: None, receiver_types: vec![], balance: 0.0 });
                    }
                }
            }
            if let Some(groups) = src["sapling"].as_array() {
                for g in groups {
                    if let Some(list) = g["addresses"].as_array() {
                        for a in list {
                            if let Some(s) = a.as_str() {
                                out.push(ZecAddress { address: s.into(), pool: "sapling".into(), shielded: true, account: None, receiver_types: vec![], balance: 0.0 });
                            }
                        }
                    }
                }
            }
            if let Some(groups) = src["unified"].as_array() {
                for g in groups {
                    let account = g["account"].as_u64();
                    if let Some(list) = g["addresses"].as_array() {
                        for a in list {
                            let rts: Vec<String> = a["receiver_types"]
                                .as_array()
                                .map(|v| v.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
                                .unwrap_or_default();
                            out.push(ZecAddress {
                                address: a["address"].as_str().unwrap_or_default().into(),
                                pool: "unified".into(),
                                shielded: rts.iter().any(|r| r == "sapling" || r == "orchard"),
                                account,
                                receiver_types: rts,
                                balance: 0.0,
                            });
                        }
                    }
                }
            }
        }
    }
    // Per-address balances from unspent sets.
    if let Ok(tu) = rpc(&state, "listunspent", vec![json!(1)]).await {
        if let Some(list) = tu.as_array() {
            for u in list {
                let addr = u["address"].as_str().unwrap_or_default();
                if let Some(e) = out.iter_mut().find(|e| e.address == addr) {
                    e.balance += parse_zec(&u["amount"]);
                }
            }
        }
    }
    if let Ok(zu) = rpc(&state, "z_listunspent", vec![json!(1), json!(9_999_999), json!(false)]).await {
        if let Some(list) = zu.as_array() {
            for u in list {
                let addr = u["address"].as_str().unwrap_or_default();
                if let Some(e) = out.iter_mut().find(|e| e.address == addr) {
                    e.balance += parse_zec(&u["amount"]);
                }
            }
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn zec_new_address(state: tauri::State<'_, AppState>, kind: String) -> AppResult<Value> {
    let r = match kind.as_str() {
        "unified" => {
            let accts = rpc(&state, "z_listaccounts", vec![]).await.unwrap_or(json!([]));
            let acct = match accts.as_array().and_then(|a| a.first()).and_then(|a| a["account"].as_u64()) {
                Some(a) => a,
                None => rpc(&state, "z_getnewaccount", vec![]).await?["account"].as_u64().unwrap_or(0),
            };
            rpc(&state, "z_getaddressforaccount", vec![json!(acct)]).await?
        }
        "sapling" => json!({"address": rpc(&state, "z_getnewaddress", vec![json!("sapling")]).await?}),
        "transparent" => json!({"address": rpc(&state, "getnewaddress", vec![]).await?}),
        _ => return Err(AppError::Msg("kind must be unified | sapling | transparent".into())),
    };
    state.log("zcash", "new_address", "info", &format!("new {kind} address"), None);
    Ok(r)
}

// ------------------------------------------------------------------ sending

pub fn is_shielded_addr(a: &str) -> bool {
    a.starts_with("zs") || a.starts_with("u1") || a.starts_with("ztestsapling") || a.starts_with("utest")
}
pub fn is_transparent_addr(a: &str) -> bool {
    a.starts_with("t1") || a.starts_with("t3") || a.starts_with("tm")
}

#[tauri::command]
pub async fn zec_send(
    state: tauri::State<'_, AppState>,
    from: String,
    to: String,
    amount: String,
    memo: Option<String>,
    privacy_policy: Option<String>,
) -> AppResult<String> {
    let amt: f64 = amount.trim().parse().map_err(|_| AppError::Msg("invalid amount".into()))?;
    if amt <= 0.0 {
        return Err(AppError::Msg("amount must be > 0".into()));
    }
    if !is_shielded_addr(&to) && !is_transparent_addr(&to) {
        return Err(AppError::Msg("unrecognised Zcash address".into()));
    }
    let policy = privacy_policy.unwrap_or_else(|| state.setting("zcash.default_privacy_policy"));
    let mut dest = json!({"address": to, "amount": (amt * 1e8).round() / 1e8});
    if let Some(m) = memo.filter(|m| !m.is_empty()) {
        if !is_shielded_addr(&to) {
            return Err(AppError::Msg("memos can only be sent to shielded addresses".into()));
        }
        dest["memo"] = Value::String(hex::encode(m.as_bytes()));
    }
    let opid = rpc(&state, "z_sendmany", vec![json!(from), json!([dest]), json!(1), Value::Null, json!(policy)]).await?;
    let opid = opid.as_str().unwrap_or_default().to_string();
    let revealed = !is_shielded_addr(&to) || !is_shielded_addr(&from);
    state.log(
        "zcash",
        "send",
        if revealed { "warn" } else { "info" },
        &format!("ZEC send queued ({policy}) -> {}", if is_shielded_addr(&to) { "shielded" } else { "TRANSPARENT" }),
        Some(json!({"opid": opid, "amount": amt, "policy": policy, "transparent_leg": revealed})),
    );
    state.audit("user", "zec.send", Some(json!({"opid": opid, "policy": policy})));
    Ok(opid)
}

#[tauri::command]
pub async fn zec_shield_transparent(state: tauri::State<'_, AppState>, to: String) -> AppResult<Value> {
    if !is_shielded_addr(&to) {
        return Err(AppError::Msg("destination must be a shielded (zs/u1) address".into()));
    }
    // z_mergetoaddress sweeps all transparent UTXOs into the shielded pool, fee auto (ZIP-317).
    let r = rpc(&state, "z_mergetoaddress", vec![json!(["ANY_TADDR"]), json!(to)]).await?;
    state.log("zcash", "shield", "info", "shielding all transparent funds", Some(r.clone()));
    state.audit("user", "zec.shield", None);
    Ok(r)
}

#[tauri::command]
pub async fn zec_operations(state: tauri::State<'_, AppState>) -> AppResult<Value> {
    rpc(&state, "z_getoperationstatus", vec![]).await
}

#[derive(Debug, Serialize)]
pub struct ZecTx {
    pub txid: String,
    pub kind: String,
    pub pool: String,
    pub address: String,
    pub amount: f64,
    pub memo: Option<String>,
    pub confirmations: i64,
    pub time: i64,
}

fn decode_memo(hexmemo: &str) -> Option<String> {
    let bytes = hex::decode(hexmemo).ok()?;
    if bytes.first() == Some(&0xf6) {
        return None;
    }
    let trimmed: Vec<u8> = bytes.into_iter().take_while(|b| *b != 0).collect();
    let s = String::from_utf8(trimmed).ok()?;
    if s.trim().is_empty() {
        None
    } else {
        Some(s)
    }
}

#[tauri::command]
pub async fn zec_transactions(state: tauri::State<'_, AppState>) -> AppResult<Vec<ZecTx>> {
    let mut out = Vec::new();
    if let Ok(lt) = rpc(&state, "listtransactions", vec![json!("*"), json!(60)]).await {
        if let Some(list) = lt.as_array() {
            for t in list {
                out.push(ZecTx {
                    txid: t["txid"].as_str().unwrap_or_default().into(),
                    kind: t["category"].as_str().unwrap_or("transparent").into(),
                    pool: "transparent".into(),
                    address: t["address"].as_str().unwrap_or_default().into(),
                    amount: parse_zec(&t["amount"]),
                    memo: None,
                    confirmations: t["confirmations"].as_i64().unwrap_or(0),
                    time: t["time"].as_i64().unwrap_or(0),
                });
            }
        }
    }
    let addrs = zec_addresses(state.clone()).await.unwrap_or_default();
    for a in addrs.into_iter().filter(|a| a.shielded) {
        if let Ok(r) = rpc(&state, "z_listreceivedbyaddress", vec![json!(a.address), json!(0)]).await {
            if let Some(list) = r.as_array() {
                for t in list {
                    if t["change"].as_bool().unwrap_or(false) {
                        continue;
                    }
                    out.push(ZecTx {
                        txid: t["txid"].as_str().unwrap_or_default().into(),
                        kind: "receive".into(),
                        pool: t["pool"].as_str().unwrap_or(&a.pool).into(),
                        address: a.address.clone(),
                        amount: parse_zec(&t["amount"]),
                        memo: t["memo"].as_str().and_then(decode_memo),
                        confirmations: t["confirmations"].as_i64().unwrap_or(0),
                        time: t["blocktime"].as_i64().unwrap_or(0),
                    });
                }
            }
        }
    }
    out.sort_by(|a, b| b.time.cmp(&a.time));
    Ok(out)
}

#[tauri::command]
pub async fn zec_import_key(state: tauri::State<'_, AppState>, key: String, rescan: bool) -> AppResult<Value> {
    let key = key.trim().to_string();
    let r = if key.starts_with("secret-extended-key-") {
        rpc(&state, "z_importkey", vec![json!(key), json!(if rescan { "yes" } else { "no" })]).await?
    } else if key.starts_with("zxview") || key.starts_with("uview") {
        rpc(&state, "z_importviewingkey", vec![json!(key), json!(if rescan { "yes" } else { "no" })]).await?
    } else {
        rpc(&state, "importprivkey", vec![json!(key), json!(""), json!(rescan)]).await?
    };
    state.log("zcash", "import_key", "info", "key imported into node wallet", None);
    state.audit("user", "zec.import_key", Some(json!({"rescan": rescan})));
    Ok(r)
}

#[tauri::command]
pub async fn zec_export_viewing_key(state: tauri::State<'_, AppState>, address: String) -> AppResult<String> {
    if !state.vault_unlocked() {
        return Err(AppError::VaultLocked);
    }
    let r = rpc(&state, "z_exportviewingkey", vec![json!(address)]).await?;
    state.audit("user", "zec.export_viewing_key", None);
    Ok(r.as_str().unwrap_or_default().to_string())
}

#[tauri::command]
pub async fn zec_validate(state: tauri::State<'_, AppState>, address: String) -> AppResult<Value> {
    if is_transparent_addr(&address) {
        rpc(&state, "validateaddress", vec![json!(address)]).await
    } else {
        rpc(&state, "z_validateaddress", vec![json!(address)]).await
    }
}

// ------------------------------------------------------------------ node process

#[tauri::command]
pub fn zec_node_start(state: tauri::State<'_, AppState>) -> AppResult<ProcStatus> {
    let bin = state.setting("zcash.binary_path");
    let conf = state.setting("zcash.conf_path");
    let datadir = state.setting("zcash.datadir");
    let lower = bin.to_ascii_lowercase();
    let mut args: Vec<String> = Vec::new();
    if lower.contains("zallet") {
        if !conf.is_empty() {
            args.push("-c".into());
            args.push(conf);
        }
        if !datadir.is_empty() {
            args.push("--datadir".into());
            args.push(datadir);
        }
        args.push("start".into());
    } else {
        if !conf.is_empty() {
            args.push(format!("-conf={conf}"));
        }
        if !datadir.is_empty() {
            args.push(format!("-datadir={datadir}"));
        }
        args.push("-printtoconsole".into());
    }
    procs::spawn(&state, PROC, &bin, &args, &[])
}

#[tauri::command]
pub async fn zec_node_stop(state: tauri::State<'_, AppState>) -> AppResult<bool> {
    let _ = rpc(&state, "stop", vec![]).await;
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    procs::stop(&state, PROC)
}
