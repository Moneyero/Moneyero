//! Key/value settings (plain) and secrets (vault-encrypted).

use rusqlite::{params, Connection, OptionalExtension};
use std::collections::BTreeMap;

use crate::crypto;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[cfg(target_os = "windows")]
const DEFAULT_WIREGUARD: &str = "C:\\Program Files\\WireGuard\\wireguard.exe";
#[cfg(target_os = "windows")]
const DEFAULT_WG: &str = "C:\\Program Files\\WireGuard\\wg.exe";
#[cfg(not(target_os = "windows"))]
const DEFAULT_WIREGUARD: &str = "wg-quick";
#[cfg(not(target_os = "windows"))]
const DEFAULT_WG: &str = "wg";

/// Defaults for every known setting key. Anything not listed here is still stored, but has no default.
pub fn defaults() -> Vec<(&'static str, String)> {
    vec![
        // Solana / trading
        ("solana.rpc_url", "https://api.mainnet-beta.solana.com".into()),
        ("solana.commitment", "confirmed".into()),
        ("solana.priority_fee", "auto".into()),
        ("jupiter.base_url", "https://lite-api.jup.ag".into()),
        ("jupiter.keyed_base_url", "https://api.jup.ag".into()),
        ("gecko.base_url", "https://api.geckoterminal.com/api/v2".into()),
        ("trade.default_slippage_bps", "50".into()),
        ("trade.max_slippage_bps", "300".into()),
        // Monero
        ("monero.wallet_rpc_path", String::new()),
        ("monero.daemon_address", "127.0.0.1:18081".into()),
        ("monero.daemon_ssl", "autodetect".into()),
        ("monero.trusted_daemon", "false".into()),
        ("monero.rpc_port", "18083".into()),
        ("monero.autostart", "false".into()),
        // Zcash
        ("zcash.rpc_url", "http://127.0.0.1:8232".into()),
        ("zcash.rpc_user", String::new()),
        ("zcash.binary_path", String::new()),
        ("zcash.datadir", String::new()),
        ("zcash.conf_path", String::new()),
        ("zcash.default_privacy_policy", "FullPrivacy".into()),
        // Network
        ("net.proxy_enabled", "false".into()),
        ("net.proxy_url", "socks5h://127.0.0.1:9050".into()),
        ("net.wireguard_path", DEFAULT_WIREGUARD.into()),
        ("net.wg_path", DEFAULT_WG.into()),
        ("net.geo_lookup", "false".into()),
        ("net.ip_check_url", "https://check.torproject.org/api/ip".into()),
        ("net.ip_fallback_url", "https://icanhazip.com".into()),
        ("net.vpn_socks_port", "19050".into()),
        ("net.vpn_autoconnect", String::new()),
        // Agent
        ("agent.model", "claude-opus-5-5".into()),
        ("agent.effort", "medium".into()),
        ("agent.enabled", "false".into()),
        ("agent.tick_secs", "60".into()),
        ("agent.max_proposal_usd", "5000".into()),
        // Exchange
        ("exchange.sideshift_affiliate", String::new()),
        ("exchange.providers", "sideshift,trocador,changenow,exolix".into()),
        // UI
        ("ui.entry_seen", "false".into()),
    ]
}

pub fn get(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| r.get::<_, String>(0))
        .optional()?)
}

pub fn get_or_default(conn: &Connection, key: &str) -> AppResult<String> {
    if let Some(v) = get(conn, key)? {
        return Ok(v);
    }
    Ok(defaults().into_iter().find(|(k, _)| *k == key).map(|(_, v)| v).unwrap_or_default())
}

pub fn set(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO settings(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn all(conn: &Connection) -> AppResult<BTreeMap<String, String>> {
    let mut map: BTreeMap<String, String> = defaults().into_iter().map(|(k, v)| (k.to_string(), v)).collect();
    let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for r in rows {
        let (k, v) = r?;
        map.insert(k, v);
    }
    Ok(map)
}

// ---------------------------------------------------------------- secrets

/// Known secret slots. Anything else is rejected so the UI cannot be tricked into storing arbitrary keys.
pub const SECRET_KEYS: &[&str] = &[
    "anthropic.api_key",
    "jupiter.api_key",
    "trocador.api_key",
    "changenow.api_key",
    "exolix.api_key",
    "sideshift.secret",
    "zcash.rpc_pass",
    "monero.daemon_login",
    "sol.keypair",
];

pub fn secret_exists(conn: &Connection, key: &str) -> AppResult<bool> {
    Ok(conn
        .query_row("SELECT 1 FROM secrets WHERE key = ?1", params![key], |_| Ok(()))
        .optional()?
        .is_some())
}

pub fn secret_set(state: &AppState, key: &str, value: &[u8]) -> AppResult<()> {
    if !SECRET_KEYS.contains(&key) {
        return Err(AppError::Msg(format!("unknown secret slot: {key}")));
    }
    let blob = state.require_vault(|k| crypto::encrypt(k, value))?;
    let conn = state.db.lock();
    conn.execute(
        "INSERT INTO secrets(key, blob) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET blob = excluded.blob",
        params![key, blob],
    )?;
    Ok(())
}

pub fn secret_get(state: &AppState, key: &str) -> AppResult<Option<Vec<u8>>> {
    let blob: Option<Vec<u8>> = {
        let conn = state.db.lock();
        conn.query_row("SELECT blob FROM secrets WHERE key = ?1", params![key], |r| r.get(0))
            .optional()?
    };
    match blob {
        None => Ok(None),
        Some(b) => state.require_vault(|k| crypto::decrypt(k, &b)).map(Some),
    }
}

pub fn secret_get_string(state: &AppState, key: &str) -> AppResult<Option<String>> {
    Ok(secret_get(state, key)?.and_then(|b| String::from_utf8(b).ok()).filter(|s| !s.is_empty()))
}

pub fn secret_delete(conn: &Connection, key: &str) -> AppResult<()> {
    conn.execute("DELETE FROM secrets WHERE key = ?1", params![key])?;
    Ok(())
}

pub fn secret_slots(conn: &Connection) -> AppResult<BTreeMap<String, bool>> {
    let mut out = BTreeMap::new();
    for k in SECRET_KEYS {
        out.insert(k.to_string(), secret_exists(conn, k)?);
    }
    Ok(out)
}
