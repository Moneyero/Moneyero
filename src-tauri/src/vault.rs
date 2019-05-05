//! The local vault: one master password protects every secret the app stores
//! (API keys, RPC credentials, the local Solana signing key).

use rusqlite::params;
use serde::Serialize;
use std::collections::BTreeMap;

use crate::crypto;
use crate::error::{AppError, AppResult};
use crate::settings;
use crate::state::AppState;

#[derive(Debug, Serialize)]
pub struct VaultStatus {
    pub initialized: bool,
    pub unlocked: bool,
    pub secret_slots: BTreeMap<String, bool>,
}

fn status_inner(state: &AppState) -> AppResult<VaultStatus> {
    let conn = state.db.lock();
    let initialized = settings::get(&conn, "vault.salt")?.is_some();
    let secret_slots = settings::secret_slots(&conn)?;
    drop(conn);
    Ok(VaultStatus { initialized, unlocked: state.vault_unlocked(), secret_slots })
}

#[tauri::command]
pub fn vault_status(state: tauri::State<'_, AppState>) -> AppResult<VaultStatus> {
    status_inner(&state)
}

async fn derive(password: String, salt: Vec<u8>) -> AppResult<crypto::VaultKey> {
    tokio::task::spawn_blocking(move || crypto::derive_key(&password, &salt))
        .await
        .map_err(|e| AppError::Msg(e.to_string()))?
}

#[tauri::command]
pub async fn vault_init(state: tauri::State<'_, AppState>, password: String) -> AppResult<VaultStatus> {
    if password.chars().count() < 8 {
        return Err(AppError::Msg("master password must be at least 8 characters".into()));
    }
    {
        let conn = state.db.lock();
        if settings::get(&conn, "vault.salt")?.is_some() {
            return Err(AppError::Msg("vault already initialised".into()));
        }
    }
    let salt = crypto::random_bytes(16);
    let key = derive(password, salt.clone()).await?;
    let check = crypto::encrypt(&key, crypto::VAULT_CHECK_PLAINTEXT)?;
    {
        let conn = state.db.lock();
        settings::set(&conn, "vault.salt", &hex::encode(&salt))?;
        settings::set(&conn, "vault.check", &hex::encode(&check))?;
    }
    *state.vault.lock() = Some(key);
    state.audit("user", "vault.init", None);
    state.log("vault", "init", "info", "vault initialised", None);
    status_inner(&state)
}

#[tauri::command]
pub async fn vault_unlock(state: tauri::State<'_, AppState>, password: String) -> AppResult<VaultStatus> {
    let (salt, check) = {
        let conn = state.db.lock();
        let salt = settings::get(&conn, "vault.salt")?.ok_or_else(|| AppError::Msg("vault not initialised".into()))?;
        let check = settings::get(&conn, "vault.check")?.ok_or_else(|| AppError::Msg("vault corrupted".into()))?;
        (hex::decode(salt).map_err(|e| AppError::Msg(e.to_string()))?, hex::decode(check).map_err(|e| AppError::Msg(e.to_string()))?)
    };
    let key = derive(password, salt).await?;
    match crypto::decrypt(&key, &check) {
        Ok(pt) if pt == crypto::VAULT_CHECK_PLAINTEXT => {
            *state.vault.lock() = Some(key);
            state.audit("user", "vault.unlock", None);
            status_inner(&state)
        }
        _ => {
            state.audit("user", "vault.unlock_failed", None);
            Err(AppError::Msg("wrong master password".into()))
        }
    }
}

#[tauri::command]
pub fn vault_lock(state: tauri::State<'_, AppState>) -> AppResult<VaultStatus> {
    *state.vault.lock() = None; // VaultKey zeroizes on drop
    state.audit("user", "vault.lock", None);
    status_inner(&state)
}

#[tauri::command]
pub async fn vault_change_password(
    state: tauri::State<'_, AppState>,
    old_password: String,
    new_password: String,
) -> AppResult<VaultStatus> {
    if new_password.chars().count() < 8 {
        return Err(AppError::Msg("new password must be at least 8 characters".into()));
    }
    let (salt, check) = {
        let conn = state.db.lock();
        let salt = settings::get(&conn, "vault.salt")?.ok_or_else(|| AppError::Msg("vault not initialised".into()))?;
        let check = settings::get(&conn, "vault.check")?.ok_or_else(|| AppError::Msg("vault corrupted".into()))?;
        (hex::decode(salt).map_err(|e| AppError::Msg(e.to_string()))?, hex::decode(check).map_err(|e| AppError::Msg(e.to_string()))?)
    };
    let old_key = derive(old_password, salt).await?;
    if crypto::decrypt(&old_key, &check).map(|pt| pt == crypto::VAULT_CHECK_PLAINTEXT).unwrap_or(false) == false {
        return Err(AppError::Msg("wrong current password".into()));
    }
    let new_salt = crypto::random_bytes(16);
    let new_key = derive(new_password, new_salt.clone()).await?;

    // Re-encrypt every secret under the new key, atomically.
    let conn = state.db.lock();
    let rows: Vec<(String, Vec<u8>)> = {
        let mut stmt = conn.prepare("SELECT key, blob FROM secrets")?;
        let it = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?)))?;
        let mut v = Vec::new();
        for r in it {
            v.push(r?);
        }
        v
    };
    conn.execute_batch("BEGIN")?;
    let mut ok = true;
    for (k, blob) in rows {
        match crypto::decrypt(&old_key, &blob).and_then(|pt| crypto::encrypt(&new_key, &pt)) {
            Ok(nb) => {
                conn.execute("UPDATE secrets SET blob = ?1 WHERE key = ?2", params![nb, k])?;
            }
            Err(_) => {
                ok = false;
                break;
            }
        }
    }
    if !ok {
        conn.execute_batch("ROLLBACK")?;
        return Err(AppError::Msg("re-encryption failed; password unchanged".into()));
    }
    let new_check = crypto::encrypt(&new_key, crypto::VAULT_CHECK_PLAINTEXT)?;
    settings::set(&conn, "vault.salt", &hex::encode(&new_salt))?;
    settings::set(&conn, "vault.check", &hex::encode(&new_check))?;
    conn.execute_batch("COMMIT")?;
    drop(conn);
    *state.vault.lock() = Some(new_key);
    state.audit("user", "vault.password_changed", None);
    status_inner(&state)
}
