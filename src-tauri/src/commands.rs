//! Misc commands: settings, secrets, activity/audit feeds, trade log, app info.

use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;

use crate::db;
use crate::error::{AppError, AppResult};
use crate::settings;
use crate::state::AppState;

#[derive(Debug, Serialize)]
pub struct AppInfo {
    pub version: String,
    pub data_dir: String,
    pub platform: String,
    pub arch: String,
}

#[tauri::command]
pub fn app_info(state: tauri::State<'_, AppState>) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        data_dir: state.data_dir.display().to_string(),
        platform: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
    }
}

#[tauri::command]
pub fn settings_all(state: tauri::State<'_, AppState>) -> AppResult<BTreeMap<String, String>> {
    let conn = state.db.lock();
    let mut all = settings::all(&conn)?;
    all.remove("vault.salt");
    all.remove("vault.check");
    Ok(all)
}

#[tauri::command]
pub fn settings_set(state: tauri::State<'_, AppState>, key: String, value: String) -> AppResult<()> {
    if key.starts_with("vault.") {
        return Err(AppError::Msg("vault settings are managed by the vault commands".into()));
    }
    if key.is_empty() || key.len() > 64 || value.len() > 4096 {
        return Err(AppError::Msg("bad key/value".into()));
    }
    let conn = state.db.lock();
    settings::set(&conn, &key, &value)?;
    db::audit(&conn, "user", "settings.set", Some(&json!({"key": key})))?;
    Ok(())
}

#[tauri::command]
pub fn secret_set(state: tauri::State<'_, AppState>, key: String, value: String) -> AppResult<()> {
    if key == "sol.keypair" {
        return Err(AppError::Msg("use the Solana signer commands".into()));
    }
    settings::secret_set(&state, &key, value.trim().as_bytes())?;
    state.audit("user", "secret.set", Some(json!({"key": key})));
    Ok(())
}

#[tauri::command]
pub fn secret_delete(state: tauri::State<'_, AppState>, key: String) -> AppResult<()> {
    if key == "sol.keypair" {
        return Err(AppError::Msg("use the Solana signer commands".into()));
    }
    let conn = state.db.lock();
    settings::secret_delete(&conn, &key)?;
    db::audit(&conn, "user", "secret.delete", Some(&json!({"key": key})))?;
    Ok(())
}

#[tauri::command]
pub fn activity_list(state: tauri::State<'_, AppState>, module: Option<String>, limit: Option<i64>) -> AppResult<Vec<db::ActivityRow>> {
    let conn = state.db.lock();
    db::list_activity(&conn, module.as_deref().filter(|m| !m.is_empty() && *m != "all"), limit.unwrap_or(200))
}

#[tauri::command]
pub fn activity_log(state: tauri::State<'_, AppState>, module: String, kind: String, level: String, message: String, data: Option<serde_json::Value>) -> AppResult<()> {
    let conn = state.db.lock();
    db::log_activity(&conn, &module, &kind, &level, &message, data.as_ref())
}

#[tauri::command]
pub fn audit_list(state: tauri::State<'_, AppState>, limit: Option<i64>) -> AppResult<Vec<db::AuditRow>> {
    let conn = state.db.lock();
    db::list_audit(&conn, limit.unwrap_or(200))
}

// ------------------------------------------------------------------ trades (P&L source of truth)

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Trade {
    pub id: String,
    pub ts: i64,
    pub wallet: String,
    pub in_mint: String,
    pub in_symbol: String,
    pub in_amount: f64,
    pub out_mint: String,
    pub out_symbol: String,
    pub out_amount: f64,
    pub in_usd: Option<f64>,
    pub out_usd: Option<f64>,
    pub signature: Option<String>,
    pub status: String,
    pub slippage_bps: Option<i64>,
    pub route: Option<String>,
}

#[tauri::command]
pub fn trades_add(state: tauri::State<'_, AppState>, trade: Trade) -> AppResult<Trade> {
    let mut t = trade;
    if t.id.is_empty() {
        t.id = uuid::Uuid::new_v4().to_string();
    }
    if t.ts == 0 {
        t.ts = db::now();
    }
    let conn = state.db.lock();
    conn.execute(
        "INSERT INTO trades(id, ts, wallet, in_mint, in_symbol, in_amount, out_mint, out_symbol, out_amount, in_usd, out_usd, signature, status, slippage_bps, route)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, signature=excluded.signature, out_amount=excluded.out_amount, out_usd=excluded.out_usd",
        params![t.id, t.ts, t.wallet, t.in_mint, t.in_symbol, t.in_amount, t.out_mint, t.out_symbol, t.out_amount, t.in_usd, t.out_usd, t.signature, t.status, t.slippage_bps, t.route],
    )?;
    db::log_activity(
        &conn,
        "terminal",
        "trade",
        if t.status == "failed" { "warn" } else { "info" },
        &format!("{} {} {} -> {} {} [{}]", t.status, t.in_amount, t.in_symbol, t.out_amount, t.out_symbol, t.signature.clone().unwrap_or_default()),
        Some(&json!({"id": t.id, "wallet": t.wallet, "signature": t.signature})),
    )?;
    Ok(t)
}

#[tauri::command]
pub fn trades_list(state: tauri::State<'_, AppState>, wallet: Option<String>, limit: Option<i64>) -> AppResult<Vec<Trade>> {
    let conn = state.db.lock();
    let mut stmt = conn.prepare(
        "SELECT id, ts, wallet, in_mint, in_symbol, in_amount, out_mint, out_symbol, out_amount, in_usd, out_usd, signature, status, slippage_bps, route
         FROM trades WHERE (?1 IS NULL OR wallet = ?1) ORDER BY ts DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![wallet, limit.unwrap_or(500)], |r| {
        Ok(Trade {
            id: r.get(0)?,
            ts: r.get(1)?,
            wallet: r.get(2)?,
            in_mint: r.get(3)?,
            in_symbol: r.get(4)?,
            in_amount: r.get(5)?,
            out_mint: r.get(6)?,
            out_symbol: r.get(7)?,
            out_amount: r.get(8)?,
            in_usd: r.get(9)?,
            out_usd: r.get(10)?,
            signature: r.get(11)?,
            status: r.get(12)?,
            slippage_bps: r.get(13)?,
            route: r.get(14)?,
        })
    })?;
    let mut out = vec![];
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

#[tauri::command]
pub fn trades_delete(state: tauri::State<'_, AppState>, id: String) -> AppResult<()> {
    let conn = state.db.lock();
    conn.execute("DELETE FROM trades WHERE id = ?1", params![id])?;
    Ok(())
}
