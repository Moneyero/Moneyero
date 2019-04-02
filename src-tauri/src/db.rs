//! SQLite persistence. Everything the app remembers lives here, in the OS app-data dir.
//! Secrets are stored only as vault-encrypted blobs (see `settings::secret_set`).

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::error::AppResult;

pub fn open(path: &Path) -> AppResult<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS secrets (
            key  TEXT PRIMARY KEY,
            blob BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS activity (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            ts      INTEGER NOT NULL,
            module  TEXT NOT NULL,
            kind    TEXT NOT NULL,
            level   TEXT NOT NULL,
            message TEXT NOT NULL,
            data    TEXT
        );
        CREATE INDEX IF NOT EXISTS activity_ts ON activity(ts DESC);

        CREATE TABLE IF NOT EXISTS trades (
            id           TEXT PRIMARY KEY,
            ts           INTEGER NOT NULL,
            wallet       TEXT NOT NULL,
            in_mint      TEXT NOT NULL,
            in_symbol    TEXT NOT NULL,
            in_amount    REAL NOT NULL,
            out_mint     TEXT NOT NULL,
            out_symbol   TEXT NOT NULL,
            out_amount   REAL NOT NULL,
            in_usd       REAL,
            out_usd      REAL,
            signature    TEXT,
            status       TEXT NOT NULL,
            slippage_bps INTEGER,
            route        TEXT
        );
        CREATE INDEX IF NOT EXISTS trades_ts ON trades(ts DESC);

        CREATE TABLE IF NOT EXISTS swap_orders (
            id             TEXT PRIMARY KEY,
            ts             INTEGER NOT NULL,
            provider       TEXT NOT NULL,
            provider_id    TEXT NOT NULL,
            from_asset     TEXT NOT NULL,
            to_asset       TEXT NOT NULL,
            amount_from    REAL NOT NULL,
            amount_to      REAL,
            deposit_address TEXT,
            deposit_memo   TEXT,
            settle_address TEXT NOT NULL,
            refund_address TEXT,
            status         TEXT NOT NULL,
            raw            TEXT,
            updated        INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS rules (
            id            TEXT PRIMARY KEY,
            name          TEXT NOT NULL,
            enabled       INTEGER NOT NULL DEFAULT 1,
            trigger       TEXT NOT NULL,
            action        TEXT NOT NULL,
            cooldown_secs INTEGER NOT NULL DEFAULT 3600,
            last_fired    INTEGER,
            created       INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS proposals (
            id         TEXT PRIMARY KEY,
            ts         INTEGER NOT NULL,
            rule_id    TEXT,
            source     TEXT NOT NULL,
            title      TEXT NOT NULL,
            rationale  TEXT NOT NULL,
            action     TEXT NOT NULL,
            status     TEXT NOT NULL,
            decided_ts INTEGER,
            result     TEXT
        );

        CREATE TABLE IF NOT EXISTS audit (
            id     INTEGER PRIMARY KEY AUTOINCREMENT,
            ts     INTEGER NOT NULL,
            actor  TEXT NOT NULL,
            event  TEXT NOT NULL,
            detail TEXT
        );
        CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts DESC);

        CREATE TABLE IF NOT EXISTS agent_messages (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            ts      INTEGER NOT NULL,
            role    TEXT NOT NULL,
            content TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS net_log (
            id     INTEGER PRIMARY KEY AUTOINCREMENT,
            ts     INTEGER NOT NULL,
            event  TEXT NOT NULL,
            detail TEXT
        );
        "#,
    )?;
    Ok(conn)
}

pub fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ActivityRow {
    pub id: i64,
    pub ts: i64,
    pub module: String,
    pub kind: String,
    pub level: String,
    pub message: String,
    pub data: Option<String>,
}

pub fn log_activity(
    conn: &Connection,
    module: &str,
    kind: &str,
    level: &str,
    message: &str,
    data: Option<&serde_json::Value>,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO activity(ts, module, kind, level, message, data) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
        params![now(), module, kind, level, message, data.map(|d| d.to_string())],
    )?;
    Ok(())
}

pub fn list_activity(conn: &Connection, module: Option<&str>, limit: i64) -> AppResult<Vec<ActivityRow>> {
    let mut out = Vec::new();
    let sql = match module {
        Some(_) => "SELECT id, ts, module, kind, level, message, data FROM activity WHERE module = ?1 ORDER BY ts DESC, id DESC LIMIT ?2",
        None => "SELECT id, ts, module, kind, level, message, data FROM activity WHERE ?1 = ?1 ORDER BY ts DESC, id DESC LIMIT ?2",
    };
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params![module.unwrap_or("*"), limit], |r| {
        Ok(ActivityRow {
            id: r.get(0)?,
            ts: r.get(1)?,
            module: r.get(2)?,
            kind: r.get(3)?,
            level: r.get(4)?,
            message: r.get(5)?,
            data: r.get(6)?,
        })
    })?;
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn audit(conn: &Connection, actor: &str, event: &str, detail: Option<&serde_json::Value>) -> AppResult<()> {
    conn.execute(
        "INSERT INTO audit(ts, actor, event, detail) VALUES(?1, ?2, ?3, ?4)",
        params![now(), actor, event, detail.map(|d| d.to_string())],
    )?;
    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AuditRow {
    pub id: i64,
    pub ts: i64,
    pub actor: String,
    pub event: String,
    pub detail: Option<String>,
}

pub fn list_audit(conn: &Connection, limit: i64) -> AppResult<Vec<AuditRow>> {
    let mut stmt = conn.prepare("SELECT id, ts, actor, event, detail FROM audit ORDER BY ts DESC, id DESC LIMIT ?1")?;
    let rows = stmt.query_map(params![limit], |r| {
        Ok(AuditRow { id: r.get(0)?, ts: r.get(1)?, actor: r.get(2)?, event: r.get(3)?, detail: r.get(4)? })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn net_log(conn: &Connection, event: &str, detail: Option<&str>) -> AppResult<()> {
    conn.execute("INSERT INTO net_log(ts, event, detail) VALUES(?1, ?2, ?3)", params![now(), event, detail])?;
    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NetLogRow {
    pub id: i64,
    pub ts: i64,
    pub event: String,
    pub detail: Option<String>,
}

pub fn list_net_log(conn: &Connection, limit: i64) -> AppResult<Vec<NetLogRow>> {
    let mut stmt = conn.prepare("SELECT id, ts, event, detail FROM net_log ORDER BY ts DESC, id DESC LIMIT ?1")?;
    let rows = stmt.query_map(params![limit], |r| Ok(NetLogRow { id: r.get(0)?, ts: r.get(1)?, event: r.get(2)?, detail: r.get(3)? }))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}
