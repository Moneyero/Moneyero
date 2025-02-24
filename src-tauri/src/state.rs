use parking_lot::Mutex;
use rusqlite::Connection;
use std::collections::HashMap;
use std::path::PathBuf;

use crate::crypto::VaultKey;
use crate::error::{AppError, AppResult};
use crate::monero::MoneroSession;
use crate::procs::ManagedProc;
use crate::{db, http, settings};

pub struct AppState {
    pub data_dir: PathBuf,
    pub db: Mutex<Connection>,
    pub vault: Mutex<Option<VaultKey>>,
    pub procs: Mutex<HashMap<String, ManagedProc>>,
    pub monero: Mutex<MoneroSession>,
    /// Built-in userspace WireGuard tunnel, when connected.
    pub vpn: Mutex<Option<crate::vpn::VpnHandle>>,
}

impl AppState {
    pub fn new(data_dir: PathBuf) -> AppResult<Self> {
        std::fs::create_dir_all(&data_dir)?;
        let conn = db::open(&data_dir.join("moneyero.db"))?;
        Ok(Self {
            data_dir,
            db: Mutex::new(conn),
            vault: Mutex::new(None),
            procs: Mutex::new(HashMap::new()),
            monero: Mutex::new(MoneroSession::default()),
            vpn: Mutex::new(None),
        })
    }

    pub fn setting(&self, key: &str) -> String {
        let conn = self.db.lock();
        settings::get_or_default(&conn, key).unwrap_or_default()
    }

    pub fn setting_bool(&self, key: &str) -> bool {
        matches!(self.setting(key).trim().to_ascii_lowercase().as_str(), "true" | "1" | "yes" | "on")
    }

    pub fn setting_u64(&self, key: &str, fallback: u64) -> u64 {
        self.setting(key).trim().parse().unwrap_or(fallback)
    }

    /// Active outbound proxy URL. The built-in VPN tunnel takes precedence when it is up;
    /// otherwise the user-configured proxy (Tor) if enabled.
    pub fn proxy(&self) -> Option<String> {
        {
            let g = self.vpn.lock();
            if let Some(h) = g.as_ref() {
                let st = h.status();
                if st.running {
                    return Some(format!("socks5h://127.0.0.1:{}", st.socks_port));
                }
            }
        }
        if self.setting_bool("net.proxy_enabled") {
            let p = self.setting("net.proxy_url");
            if !p.trim().is_empty() {
                return Some(p);
            }
        }
        None
    }

    pub fn client_timeout(&self, secs: u64) -> AppResult<reqwest::Client> {
        http::build_client(self.proxy().as_deref(), secs)
    }

    /// Client that never uses the proxy (loopback RPC only).
    pub fn local_client(&self) -> AppResult<reqwest::Client> {
        http::build_client(None, 120)
    }

    pub fn vault_unlocked(&self) -> bool {
        self.vault.lock().is_some()
    }

    pub fn require_vault<T>(&self, f: impl FnOnce(&VaultKey) -> AppResult<T>) -> AppResult<T> {
        let guard = self.vault.lock();
        match guard.as_ref() {
            Some(k) => f(k),
            None => Err(AppError::VaultLocked),
        }
    }

    pub fn log(&self, module: &str, kind: &str, level: &str, message: &str, data: Option<serde_json::Value>) {
        let conn = self.db.lock();
        let _ = db::log_activity(&conn, module, kind, level, message, data.as_ref());
    }

    pub fn audit(&self, actor: &str, event: &str, detail: Option<serde_json::Value>) {
        let conn = self.db.lock();
        let _ = db::audit(&conn, actor, event, detail.as_ref());
    }

    pub fn net_log(&self, event: &str, detail: Option<&str>) {
        let conn = self.db.lock();
        let _ = db::net_log(&conn, event, detail);
    }
}
