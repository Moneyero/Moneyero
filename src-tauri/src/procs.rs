//! Managed child processes (monero-wallet-rpc, zcashd/zallet). Spawned with stdout/stderr
//! redirected to a log file under the app data dir, killed on app exit.

use serde::Serialize;
use std::path::PathBuf;
use std::process::Stdio;
use tokio::process::{Child, Command};

use crate::db;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub struct ManagedProc {
    pub child: Child,
    pub started: i64,
    pub cmdline: String,
    pub log_path: PathBuf,
}

#[derive(Debug, Serialize, Clone)]
pub struct ProcStatus {
    pub name: String,
    pub running: bool,
    pub pid: Option<u32>,
    pub started: Option<i64>,
    pub cmdline: Option<String>,
    pub exit_code: Option<i32>,
    pub log_tail: String,
}

pub fn log_dir(state: &AppState) -> PathBuf {
    state.data_dir.join("logs")
}

pub fn spawn(state: &AppState, name: &str, program: &str, args: &[String], redact: &[String]) -> AppResult<ProcStatus> {
    if program.trim().is_empty() {
        return Err(AppError::Msg(format!("{name}: binary path not configured (SETTINGS)")));
    }
    if !std::path::Path::new(program).exists() && which(program).is_none() {
        return Err(AppError::Msg(format!("{name}: binary not found at '{program}'")));
    }
    {
        let mut procs = state.procs.lock();
        if let Some(p) = procs.get_mut(name) {
            if p.child.try_wait()?.is_none() {
                return Err(AppError::Msg(format!("{name}: already running")));
            }
            procs.remove(name);
        }
    }
    let dir = log_dir(state);
    std::fs::create_dir_all(&dir)?;
    let log_path = dir.join(format!("{name}.log"));
    let out = std::fs::OpenOptions::new().create(true).append(true).open(&log_path)?;
    let err = out.try_clone()?;

    let mut cmd = Command::new(program);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::from(out)).stderr(Stdio::from(err)).kill_on_drop(true);
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let child = cmd.spawn().map_err(|e| AppError::Msg(format!("{name}: spawn failed: {e}")))?;
    let pid = child.id();
    let mut shown: Vec<String> = args.to_vec();
    for s in redact {
        for a in shown.iter_mut() {
            if !s.is_empty() && a.contains(s.as_str()) {
                *a = a.replace(s.as_str(), "***");
            }
        }
    }
    let cmdline = format!("{program} {}", shown.join(" "));
    let started = db::now();
    state.procs.lock().insert(
        name.to_string(),
        ManagedProc { child, started, cmdline: cmdline.clone(), log_path: log_path.clone() },
    );
    state.log("process", "spawn", "info", &format!("{name} started (pid {})", pid.unwrap_or(0)), Some(serde_json::json!({"cmdline": cmdline})));
    Ok(ProcStatus {
        name: name.into(),
        running: true,
        pid,
        started: Some(started),
        cmdline: Some(cmdline),
        exit_code: None,
        log_tail: String::new(),
    })
}

pub fn stop(state: &AppState, name: &str) -> AppResult<bool> {
    let mut procs = state.procs.lock();
    if let Some(mut p) = procs.remove(name) {
        let _ = p.child.start_kill();
        drop(procs);
        state.log("process", "stop", "info", &format!("{name} stopped"), None);
        return Ok(true);
    }
    Ok(false)
}

pub fn stop_all(state: &AppState) {
    let mut procs = state.procs.lock();
    for (_, mut p) in procs.drain() {
        let _ = p.child.start_kill();
    }
}

pub fn status(state: &AppState, name: &str) -> ProcStatus {
    let mut procs = state.procs.lock();
    let log_path = log_dir(state).join(format!("{name}.log"));
    match procs.get_mut(name) {
        None => ProcStatus {
            name: name.into(),
            running: false,
            pid: None,
            started: None,
            cmdline: None,
            exit_code: None,
            log_tail: tail(&log_path, 40),
        },
        Some(p) => {
            let exit = p.child.try_wait().ok().flatten();
            ProcStatus {
                name: name.into(),
                running: exit.is_none(),
                pid: p.child.id(),
                started: Some(p.started),
                cmdline: Some(p.cmdline.clone()),
                exit_code: exit.and_then(|s| s.code()),
                log_tail: tail(&p.log_path, 40),
            }
        }
    }
}

pub fn tail(path: &std::path::Path, lines: usize) -> String {
    match std::fs::read(path) {
        Ok(bytes) => {
            let s = String::from_utf8_lossy(&bytes);
            let v: Vec<&str> = s.lines().collect();
            let start = v.len().saturating_sub(lines);
            v[start..].join("\n")
        }
        Err(_) => String::new(),
    }
}

pub fn which(bin: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let cand = dir.join(bin);
        if cand.is_file() {
            return Some(cand);
        }
        #[cfg(target_os = "windows")]
        {
            let exe = dir.join(format!("{bin}.exe"));
            if exe.is_file() {
                return Some(exe);
            }
        }
    }
    None
}

#[tauri::command]
pub fn proc_status(state: tauri::State<'_, AppState>, name: String) -> ProcStatus {
    status(&state, &name)
}

#[tauri::command]
pub fn proc_stop(state: tauri::State<'_, AppState>, name: String) -> AppResult<bool> {
    stop(&state, &name)
}

#[tauri::command]
pub fn proc_log(state: tauri::State<'_, AppState>, name: String, lines: Option<usize>) -> String {
    tail(&log_dir(&state).join(format!("{name}.log")), lines.unwrap_or(200))
}
