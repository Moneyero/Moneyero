//! Local Solana signer. Browser-extension wallets (Phantom) cannot inject into a Tauri
//! webview, so the desktop build keeps an ed25519 keypair encrypted in the vault and signs
//! transaction messages in Rust. The frontend only ever sees the public key and signatures.
//! Phantom is still supported when the UI runs in a regular browser (`npm run dev`).

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::{Signer, SigningKey};
use rand::rngs::OsRng;
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};
use crate::settings;
use crate::state::AppState;

const SLOT: &str = "sol.keypair";
const PUB_SETTING: &str = "sol.local_pubkey";

#[derive(Debug, Serialize)]
pub struct SolLocalStatus {
    pub exists: bool,
    pub pubkey: Option<String>,
    pub vault_unlocked: bool,
}

fn load(state: &AppState) -> AppResult<SigningKey> {
    let bytes = settings::secret_get(state, SLOT)?.ok_or_else(|| AppError::Msg("no local Solana signer (VAULT > create or import)".into()))?;
    let seed: [u8; 32] = bytes.get(..32).and_then(|s| s.try_into().ok()).ok_or_else(|| AppError::Msg("corrupted signer blob".into()))?;
    Ok(SigningKey::from_bytes(&seed))
}

fn pubkey_b58(sk: &SigningKey) -> String {
    bs58::encode(sk.verifying_key().to_bytes()).into_string()
}

fn store(state: &AppState, sk: &SigningKey) -> AppResult<String> {
    settings::secret_set(state, SLOT, &sk.to_bytes())?;
    let pk = pubkey_b58(sk);
    let conn = state.db.lock();
    settings::set(&conn, PUB_SETTING, &pk)?;
    Ok(pk)
}

#[tauri::command]
pub fn sol_local_status(state: tauri::State<'_, AppState>) -> AppResult<SolLocalStatus> {
    let conn = state.db.lock();
    let exists = settings::secret_exists(&conn, SLOT)?;
    let pubkey = if exists { settings::get(&conn, PUB_SETTING)? } else { None };
    drop(conn);
    Ok(SolLocalStatus { exists, pubkey, vault_unlocked: state.vault_unlocked() })
}

#[tauri::command]
pub fn sol_local_create(state: tauri::State<'_, AppState>) -> AppResult<String> {
    {
        let conn = state.db.lock();
        if settings::secret_exists(&conn, SLOT)? {
            return Err(AppError::Msg("a local signer already exists; export + delete it first".into()));
        }
    }
    let sk = SigningKey::generate(&mut OsRng);
    let pk = store(&state, &sk)?;
    state.audit("user", "sol.signer_created", Some(json!({"pubkey": pk})));
    state.log("solana", "signer_created", "info", &format!("local signer {pk}"), None);
    Ok(pk)
}

#[tauri::command]
pub fn sol_local_import(state: tauri::State<'_, AppState>, secret: String) -> AppResult<String> {
    {
        let conn = state.db.lock();
        if settings::secret_exists(&conn, SLOT)? {
            return Err(AppError::Msg("a local signer already exists; delete it first".into()));
        }
    }
    let s = secret.trim();
    let bytes: Vec<u8> = if s.starts_with('[') {
        serde_json::from_str::<Vec<u8>>(s).map_err(|_| AppError::Msg("expected a JSON byte array (solana-keygen format)".into()))?
    } else {
        bs58::decode(s).into_vec().map_err(|_| AppError::Msg("expected base58 secret key or JSON byte array".into()))?
    };
    let seed: [u8; 32] = match bytes.len() {
        32 | 64 => bytes[..32].try_into().unwrap(),
        n => return Err(AppError::Msg(format!("secret key must be 32 or 64 bytes, got {n}"))),
    };
    let sk = SigningKey::from_bytes(&seed);
    if bytes.len() == 64 && sk.verifying_key().to_bytes() != bytes[32..] {
        return Err(AppError::Msg("keypair mismatch: public half does not match secret half".into()));
    }
    let pk = store(&state, &sk)?;
    state.audit("user", "sol.signer_imported", Some(json!({"pubkey": pk})));
    Ok(pk)
}

/// Signs raw transaction message bytes (base64). The frontend attaches the signature.
#[tauri::command]
pub fn sol_local_sign(state: tauri::State<'_, AppState>, message: String, purpose: Option<String>) -> AppResult<String> {
    let msg = B64.decode(message.trim()).map_err(|_| AppError::Msg("message must be base64".into()))?;
    if msg.is_empty() || msg.len() > 1232 * 4 {
        return Err(AppError::Msg("message size out of range".into()));
    }
    let sk = load(&state)?;
    let sig = sk.sign(&msg);
    let digest = hex::encode(Sha256::digest(&msg));
    state.audit("user", "sol.sign", Some(json!({"msg_sha256": &digest[..16], "purpose": purpose})));
    Ok(B64.encode(sig.to_bytes()))
}

#[tauri::command]
pub fn sol_local_export(state: tauri::State<'_, AppState>) -> AppResult<String> {
    let sk = load(&state)?;
    state.audit("user", "sol.signer_exported", None);
    Ok(bs58::encode(sk.to_keypair_bytes()).into_string())
}

#[tauri::command]
pub fn sol_local_delete(state: tauri::State<'_, AppState>) -> AppResult<()> {
    if !state.vault_unlocked() {
        return Err(AppError::VaultLocked);
    }
    let conn = state.db.lock();
    settings::secret_delete(&conn, SLOT)?;
    conn.execute("DELETE FROM settings WHERE key = ?1", rusqlite::params![PUB_SETTING])?;
    drop(conn);
    state.audit("user", "sol.signer_deleted", None);
    Ok(())
}
