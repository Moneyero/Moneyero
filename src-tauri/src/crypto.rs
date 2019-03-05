//! Local encryption primitives.
//!
//! Master key: Argon2id(password, random 16-byte salt) -> 32 bytes, kept only in memory
//! while the vault is unlocked and zeroized on lock.
//! Payloads: XChaCha20-Poly1305 with a random 24-byte nonce prepended to the ciphertext.

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use rand::RngCore;
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::error::{AppError, AppResult};

pub const VAULT_CHECK_PLAINTEXT: &[u8] = b"BLACKBOX-VAULT-OK-v1";

#[derive(Zeroize, ZeroizeOnDrop)]
pub struct VaultKey(pub [u8; 32]);

pub fn random_bytes(n: usize) -> Vec<u8> {
    let mut v = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut v);
    v
}

pub fn random_hex(n_bytes: usize) -> String {
    hex::encode(random_bytes(n_bytes))
}

pub fn derive_key(password: &str, salt: &[u8]) -> AppResult<VaultKey> {
    // 64 MiB, 3 passes, 1 lane. Deliberately slow for an interactive unlock.
    let params = Params::new(64 * 1024, 3, 1, Some(32)).map_err(|e| AppError::Msg(e.to_string()))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = [0u8; 32];
    argon
        .hash_password_into(password.as_bytes(), salt, &mut out)
        .map_err(|e| AppError::Msg(format!("argon2: {e}")))?;
    Ok(VaultKey(out))
}

pub fn encrypt(key: &VaultKey, plaintext: &[u8]) -> AppResult<Vec<u8>> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key.0));
    let nonce = random_bytes(24);
    let ct = cipher
        .encrypt(XNonce::from_slice(&nonce), plaintext)
        .map_err(|_| AppError::Msg("encryption failed".into()))?;
    let mut out = nonce;
    out.extend_from_slice(&ct);
    Ok(out)
}

pub fn decrypt(key: &VaultKey, blob: &[u8]) -> AppResult<Vec<u8>> {
    if blob.len() < 24 + 16 {
        return Err(AppError::Msg("ciphertext too short".into()));
    }
    let (nonce, ct) = blob.split_at(24);
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key.0));
    cipher
        .decrypt(XNonce::from_slice(nonce), ct)
        .map_err(|_| AppError::Msg("decryption failed (wrong password or corrupted data)".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let salt = random_bytes(16);
        let k = derive_key("correct horse", &salt).unwrap();
        let blob = encrypt(&k, b"hello").unwrap();
        assert_eq!(decrypt(&k, &blob).unwrap(), b"hello");
        let k2 = derive_key("wrong", &salt).unwrap();
        assert!(decrypt(&k2, &blob).is_err());
    }
}
