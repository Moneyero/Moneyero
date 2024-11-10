//! Treasury agent: deterministic rules engine + Claude for natural-language control.
//!
//! Guarantees:
//! * Rules and the model only create PROPOSALS. A proposal does nothing until a human
//!   approves it in the UI, and the approved action is then executed through the exact same
//!   flows a manual action would use (Jupiter swap, exchange order, VAULT send).
//! * The agent has no handle on any signing key.
//! * Every evaluation, proposal, decision and model call is written to the audit table.

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;

use crate::db;
use crate::error::{AppError, AppResult};
use crate::llm;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Trigger {
    RealizedPnlAbove { usd: f64 },
    SolBalanceAbove { sol: f64 },
    AllocationAbove { asset: String, pct: f64 },
    AllocationBelow { asset: String, pct: f64 },
    PriceAbove { symbol: String, usd: f64 },
    PriceBelow { symbol: String, usd: f64 },
    UnshieldedZecAbove { zec: f64 },
    TreasuryValueAbove { usd: f64 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Action {
    /// Cross-chain move via EXCHANGE (e.g. SOL -> XMR). pct is % of the `from` holding.
    ProposeMove { from: String, to: String, pct: Option<f64>, amount: Option<f64>, note: Option<String> },
    /// On-chain Solana swap via Jupiter (e.g. token -> USDC).
    ProposeSwap { from_symbol: String, to_symbol: String, amount: Option<f64>, pct: Option<f64>, note: Option<String> },
    /// Shield transparent ZEC into the Orchard/Sapling pool.
    ProposeShield { note: Option<String> },
    Notify { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rule {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub trigger: Trigger,
    pub action: Action,
    pub cooldown_secs: i64,
    pub last_fired: Option<i64>,
    pub created: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Balances {
    #[serde(default)]
    pub sol: f64,
    #[serde(default)]
    pub usdc: f64,
    #[serde(default)]
    pub xmr: f64,
    #[serde(default)]
    pub zec: f64,
    #[serde(default)]
    pub zec_transparent: f64,
    #[serde(default)]
    pub sol_tokens_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Snapshot {
    #[serde(default)]
    pub prices: HashMap<String, f64>,
    #[serde(default)]
    pub balances: Balances,
    #[serde(default)]
    pub realized_pnl_usd: f64,
    #[serde(default)]
    pub unrealized_pnl_usd: f64,
    pub wallet: Option<String>,
    #[serde(default)]
    pub sources: Vec<String>,
}

impl Snapshot {
    fn price(&self, sym: &str) -> f64 {
        let s = sym.to_ascii_uppercase();
        if s == "USDC" || s == "USD" {
            return 1.0;
        }
        *self.prices.get(&s).unwrap_or(&0.0)
    }
    fn value_of(&self, asset: &str) -> f64 {
        match asset.to_ascii_uppercase().as_str() {
            "SOL" => self.balances.sol * self.price("SOL"),
            "USDC" => self.balances.usdc,
            "XMR" => self.balances.xmr * self.price("XMR"),
            "ZEC" => self.balances.zec * self.price("ZEC"),
            "TOKENS" => self.balances.sol_tokens_usd,
            _ => 0.0,
        }
    }
    fn total(&self) -> f64 {
        self.value_of("SOL") + self.value_of("USDC") + self.value_of("XMR") + self.value_of("ZEC") + self.value_of("TOKENS")
    }
    fn alloc_pct(&self, asset: &str) -> f64 {
        let t = self.total();
        if t <= 0.0 {
            0.0
        } else {
            self.value_of(asset) / t * 100.0
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Proposal {
    pub id: String,
    pub ts: i64,
    pub rule_id: Option<String>,
    pub source: String,
    pub title: String,
    pub rationale: String,
    pub action: Action,
    pub status: String,
    pub decided_ts: Option<i64>,
    pub result: Option<String>,
}

// ------------------------------------------------------------------ rules CRUD

fn row_to_rule(r: &rusqlite::Row<'_>) -> rusqlite::Result<Rule> {
    let trigger: String = r.get(3)?;
    let action: String = r.get(4)?;
    Ok(Rule {
        id: r.get(0)?,
        name: r.get(1)?,
        enabled: r.get::<_, i64>(2)? != 0,
        trigger: serde_json::from_str(&trigger).unwrap_or(Trigger::TreasuryValueAbove { usd: f64::MAX }),
        action: serde_json::from_str(&action).unwrap_or(Action::Notify { message: "invalid action".into() }),
        cooldown_secs: r.get(5)?,
        last_fired: r.get(6)?,
        created: r.get(7)?,
    })
}

fn load_rules(state: &AppState) -> AppResult<Vec<Rule>> {
    let conn = state.db.lock();
    let mut stmt = conn.prepare("SELECT id, name, enabled, trigger, action, cooldown_secs, last_fired, created FROM rules ORDER BY created")?;
    let rows = stmt.query_map([], row_to_rule)?;
    let mut out = vec![];
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

#[tauri::command]
pub fn agent_rules(state: tauri::State<'_, AppState>) -> AppResult<Vec<Rule>> {
    load_rules(&state)
}

#[tauri::command]
pub fn agent_rule_upsert(state: tauri::State<'_, AppState>, rule: Rule) -> AppResult<Rule> {
    let mut rule = rule;
    if rule.id.is_empty() {
        rule.id = uuid::Uuid::new_v4().to_string();
        rule.created = db::now();
    }
    if rule.name.trim().is_empty() {
        return Err(AppError::Msg("rule name required".into()));
    }
    if rule.cooldown_secs < 60 {
        rule.cooldown_secs = 60;
    }
    let conn = state.db.lock();
    conn.execute(
        "INSERT INTO rules(id, name, enabled, trigger, action, cooldown_secs, last_fired, created) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, enabled=excluded.enabled, trigger=excluded.trigger, action=excluded.action, cooldown_secs=excluded.cooldown_secs",
        params![
            rule.id,
            rule.name,
            rule.enabled as i64,
            serde_json::to_string(&rule.trigger)?,
            serde_json::to_string(&rule.action)?,
            rule.cooldown_secs,
            rule.last_fired,
            rule.created
        ],
    )?;
    db::audit(&conn, "user", "rule.upsert", Some(&json!({"id": rule.id, "name": rule.name, "enabled": rule.enabled})))?;
    Ok(rule)
}

#[tauri::command]
pub fn agent_rule_delete(state: tauri::State<'_, AppState>, id: String) -> AppResult<()> {
    let conn = state.db.lock();
    conn.execute("DELETE FROM rules WHERE id = ?1", params![id])?;
    db::audit(&conn, "user", "rule.delete", Some(&json!({"id": id})))?;
    Ok(())
}

// ------------------------------------------------------------------ evaluation

fn describe_action(a: &Action, snap: &Snapshot) -> (String, Option<Action>) {
    match a {
        Action::ProposeMove { from, to, pct, amount, note } => {
            let from_u = from.to_ascii_uppercase();
            let holding = match from_u.as_str() {
                "SOL" => snap.balances.sol,
                "USDC" => snap.balances.usdc,
                "XMR" => snap.balances.xmr,
                "ZEC" => snap.balances.zec,
                _ => 0.0,
            };
            let amt = amount.or(pct.map(|p| holding * p / 100.0)).unwrap_or(0.0);
            let usd = amt * snap.price(&from_u);
            let title = format!("Move {:.4} {} (~${:.0}) into {}", amt, from_u, usd, to.to_ascii_uppercase());
            let concrete = Action::ProposeMove { from: from_u, to: to.to_ascii_uppercase(), pct: *pct, amount: Some(amt), note: note.clone() };
            (title, Some(concrete))
        }
        Action::ProposeSwap { from_symbol, to_symbol, amount, pct, note } => {
            let title = match (amount, pct) {
                (Some(a), _) => format!("Swap {a} {from_symbol} -> {to_symbol} on Solana"),
                (None, Some(p)) => format!("Swap {p}% of {from_symbol} -> {to_symbol} on Solana"),
                _ => format!("Swap {from_symbol} -> {to_symbol} on Solana"),
            };
            (title, Some(Action::ProposeSwap { from_symbol: from_symbol.clone(), to_symbol: to_symbol.clone(), amount: *amount, pct: *pct, note: note.clone() }))
        }
        Action::ProposeShield { note } => (format!("Shield {:.4} transparent ZEC", snap.balances.zec_transparent), Some(Action::ProposeShield { note: note.clone() })),
        Action::Notify { message } => (message.clone(), None),
    }
}

fn check_trigger(t: &Trigger, s: &Snapshot) -> Option<String> {
    match t {
        Trigger::RealizedPnlAbove { usd } => (s.realized_pnl_usd > *usd).then(|| format!("realised P&L ${:.2} > ${:.2}", s.realized_pnl_usd, usd)),
        Trigger::SolBalanceAbove { sol } => (s.balances.sol > *sol).then(|| format!("SOL balance {:.4} > {:.4}", s.balances.sol, sol)),
        Trigger::AllocationAbove { asset, pct } => {
            let a = s.alloc_pct(asset);
            (a > *pct).then(|| format!("{} allocation {:.1}% > {:.1}%", asset.to_ascii_uppercase(), a, pct))
        }
        Trigger::AllocationBelow { asset, pct } => {
            let a = s.alloc_pct(asset);
            (s.total() > 0.0 && a < *pct).then(|| format!("{} allocation {:.1}% < {:.1}%", asset.to_ascii_uppercase(), a, pct))
        }
        Trigger::PriceAbove { symbol, usd } => {
            let p = s.price(symbol);
            (p > 0.0 && p > *usd).then(|| format!("{} ${:.4} > ${:.4}", symbol.to_ascii_uppercase(), p, usd))
        }
        Trigger::PriceBelow { symbol, usd } => {
            let p = s.price(symbol);
            (p > 0.0 && p < *usd).then(|| format!("{} ${:.4} < ${:.4}", symbol.to_ascii_uppercase(), p, usd))
        }
        Trigger::UnshieldedZecAbove { zec } => (s.balances.zec_transparent > *zec).then(|| format!("transparent ZEC {:.4} > {:.4}", s.balances.zec_transparent, zec)),
        Trigger::TreasuryValueAbove { usd } => (s.total() > *usd).then(|| format!("treasury ${:.0} > ${:.0}", s.total(), usd)),
    }
}

fn insert_proposal(conn: &rusqlite::Connection, p: &Proposal) -> AppResult<()> {
    conn.execute(
        "INSERT INTO proposals(id, ts, rule_id, source, title, rationale, action, status, decided_ts, result) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![p.id, p.ts, p.rule_id, p.source, p.title, p.rationale, serde_json::to_string(&p.action)?, p.status, p.decided_ts, p.result],
    )?;
    db::audit(conn, &p.source, "proposal.created", Some(&json!({"id": p.id, "title": p.title, "rule_id": p.rule_id})))?;
    Ok(())
}

/// Evaluate all enabled rules against a fresh snapshot. Returns newly created proposals.
#[tauri::command]
pub fn agent_tick(state: tauri::State<'_, AppState>, snapshot: Snapshot) -> AppResult<Vec<Proposal>> {
    if !state.setting_bool("agent.enabled") {
        return Ok(vec![]);
    }
    let rules = load_rules(&state)?;
    let now = db::now();
    let max_usd = state.setting("agent.max_proposal_usd").parse::<f64>().unwrap_or(5000.0);
    let mut created = vec![];
    let conn = state.db.lock();
    for r in rules.into_iter().filter(|r| r.enabled) {
        if let Some(lf) = r.last_fired {
            if now - lf < r.cooldown_secs {
                continue;
            }
        }
        let Some(why) = check_trigger(&r.trigger, &snapshot) else { continue };
        // Skip if an identical rule already has a pending proposal.
        let pending: Option<String> = conn
            .query_row("SELECT id FROM proposals WHERE rule_id = ?1 AND status = 'pending'", params![r.id], |x| x.get(0))
            .optional()?;
        if pending.is_some() {
            continue;
        }
        let (title, concrete) = describe_action(&r.action, &snapshot);
        let mut rationale = format!("Rule '{}' fired: {}.", r.name, why);
        if let Some(Action::ProposeMove { amount: Some(a), from, .. }) = &concrete {
            let usd = a * snapshot.price(from);
            if usd > max_usd {
                rationale.push_str(&format!(" NOTE: ${usd:.0} exceeds agent.max_proposal_usd (${max_usd:.0}); proposal flagged."));
            }
        }
        let p = Proposal {
            id: uuid::Uuid::new_v4().to_string(),
            ts: now,
            rule_id: Some(r.id.clone()),
            source: "rules".into(),
            title,
            rationale,
            action: concrete.unwrap_or(r.action.clone()),
            status: "pending".into(),
            decided_ts: None,
            result: None,
        };
        insert_proposal(&conn, &p)?;
        conn.execute("UPDATE rules SET last_fired = ?1 WHERE id = ?2", params![now, r.id])?;
        created.push(p);
    }
    db::audit(&conn, "rules", "tick", Some(&json!({"treasury_usd": snapshot.total(), "new_proposals": created.len(), "sources": snapshot.sources})))?;
    Ok(created)
}

fn row_to_proposal(r: &rusqlite::Row<'_>) -> rusqlite::Result<Proposal> {
    let action: String = r.get(6)?;
    Ok(Proposal {
        id: r.get(0)?,
        ts: r.get(1)?,
        rule_id: r.get(2)?,
        source: r.get(3)?,
        title: r.get(4)?,
        rationale: r.get(5)?,
        action: serde_json::from_str(&action).unwrap_or(Action::Notify { message: action }),
        status: r.get(7)?,
        decided_ts: r.get(8)?,
        result: r.get(9)?,
    })
}

#[tauri::command]
pub fn agent_proposals(state: tauri::State<'_, AppState>, status: Option<String>) -> AppResult<Vec<Proposal>> {
    let conn = state.db.lock();
    let sql = "SELECT id, ts, rule_id, source, title, rationale, action, status, decided_ts, result FROM proposals WHERE (?1 IS NULL OR status = ?1) ORDER BY ts DESC LIMIT 200";
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params![status], row_to_proposal)?;
    let mut out = vec![];
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

#[tauri::command]
pub fn agent_decide(state: tauri::State<'_, AppState>, id: String, approve: bool, note: Option<String>) -> AppResult<Proposal> {
    let conn = state.db.lock();
    let status = if approve { "approved" } else { "rejected" };
    let n = conn.execute(
        "UPDATE proposals SET status = ?1, decided_ts = ?2, result = ?3 WHERE id = ?4 AND status = 'pending'",
        params![status, db::now(), note, id],
    )?;
    if n == 0 {
        return Err(AppError::Msg("proposal not pending".into()));
    }
    db::audit(&conn, "user", if approve { "proposal.approved" } else { "proposal.rejected" }, Some(&json!({"id": id, "note": note})))?;
    conn.query_row(
        "SELECT id, ts, rule_id, source, title, rationale, action, status, decided_ts, result FROM proposals WHERE id = ?1",
        params![id],
        row_to_proposal,
    )
    .map_err(Into::into)
}

#[tauri::command]
pub fn agent_result(state: tauri::State<'_, AppState>, id: String, ok: bool, result: String) -> AppResult<()> {
    let conn = state.db.lock();
    conn.execute(
        "UPDATE proposals SET status = ?1, result = ?2 WHERE id = ?3 AND status = 'approved'",
        params![if ok { "executed" } else { "failed" }, result, id],
    )?;
    db::audit(&conn, "user", if ok { "proposal.executed" } else { "proposal.failed" }, Some(&json!({"id": id, "result": result})))?;
    Ok(())
}

#[tauri::command]
pub fn agent_create_proposal(state: tauri::State<'_, AppState>, title: String, rationale: String, action: Action) -> AppResult<Proposal> {
    let p = Proposal {
        id: uuid::Uuid::new_v4().to_string(),
        ts: db::now(),
        rule_id: None,
        source: "llm".into(),
        title,
        rationale,
        action,
        status: "pending".into(),
        decided_ts: None,
        result: None,
    };
    let conn = state.db.lock();
    insert_proposal(&conn, &p)?;
    Ok(p)
}

// ------------------------------------------------------------------ natural language

const SYSTEM_PROMPT: &str = r#"You are the treasury assistant inside Moneyero, a desktop privacy terminal. The operator holds Monero (XMR, main privacy treasury), Zcash (ZEC, shielded where possible), and Solana (SOL + SPL tokens, trading venue). You help them write automation rules and reason about treasury allocation.

Hard constraints you must respect and must tell the user about when relevant:
- You cannot execute anything. You can only propose rules and actions. Every proposal requires explicit human approval in the UI, and the approval triggers the normal manual flow.
- Never ask for seed phrases, private keys, or passwords. Never suggest pasting them anywhere.
- Solana is a transparent ledger: swaps link the wallet address to activity permanently. Cross-chain swap providers see IP (unless Tor), amounts, deposit tx and settle address. ZEC is only private when shielded (zs/u1 addresses, FullPrivacy policy). Say so when proposing moves that touch these.
- Do not promise anonymity. Be precise and terse. Monospace-terminal tone, no marketing.

Rule format. A rule is {name, trigger, action, cooldown_secs}. Encode trigger and action as JSON strings using exactly these shapes:
Triggers:
  {"kind":"realized_pnl_above","usd":500}
  {"kind":"sol_balance_above","sol":10}
  {"kind":"allocation_above","asset":"SOL","pct":60}      (asset: SOL|USDC|XMR|ZEC|TOKENS; pct of total treasury value)
  {"kind":"allocation_below","asset":"XMR","pct":30}
  {"kind":"price_above","symbol":"SOL","usd":250}
  {"kind":"price_below","symbol":"XMR","usd":120}
  {"kind":"unshielded_zec_above","zec":0.5}
  {"kind":"treasury_value_above","usd":10000}
Actions:
  {"kind":"propose_move","from":"SOL","to":"XMR","pct":30,"note":"..."}           (cross-chain via EXCHANGE; pct of the from-holding, or "amount")
  {"kind":"propose_swap","from_symbol":"WIF","to_symbol":"USDC","pct":100,"note":"..."}  (Jupiter swap on Solana)
  {"kind":"propose_shield","note":"..."}
  {"kind":"notify","message":"..."}

Reply with JSON matching the provided schema. Put conversational text in "reply". Only include rules/actions you are confident match the operator's intent; otherwise ask a clarifying question in "reply" and leave the arrays empty."#;

fn reply_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["reply", "rules", "actions"],
        "properties": {
            "reply": {"type": "string", "description": "Terse answer for the operator."},
            "rules": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["name", "trigger_json", "action_json", "cooldown_secs"],
                    "properties": {
                        "name": {"type": "string"},
                        "trigger_json": {"type": "string", "description": "JSON-encoded trigger object"},
                        "action_json": {"type": "string", "description": "JSON-encoded action object"},
                        "cooldown_secs": {"type": "integer"}
                    }
                }
            },
            "actions": {
                "type": "array",
                "description": "Immediate one-off proposals (still require approval).",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["title", "rationale", "action_json"],
                    "properties": {
                        "title": {"type": "string"},
                        "rationale": {"type": "string"},
                        "action_json": {"type": "string"}
                    }
                }
            }
        }
    })
}

#[derive(Debug, Serialize)]
pub struct SuggestedRule {
    pub name: String,
    pub trigger: Trigger,
    pub action: Action,
    pub cooldown_secs: i64,
}

#[derive(Debug, Serialize)]
pub struct ChatReply {
    pub reply: String,
    pub rules: Vec<SuggestedRule>,
    pub proposals: Vec<Proposal>,
    pub invalid: Vec<String>,
    pub model: String,
    pub tokens: (u64, u64),
}

#[derive(Debug, Serialize)]
pub struct ChatMessage {
    pub id: i64,
    pub ts: i64,
    pub role: String,
    pub content: String,
}

#[tauri::command]
pub fn agent_messages(state: tauri::State<'_, AppState>) -> AppResult<Vec<ChatMessage>> {
    let conn = state.db.lock();
    let mut stmt = conn.prepare("SELECT id, ts, role, content FROM agent_messages ORDER BY id DESC LIMIT 60")?;
    let rows = stmt.query_map([], |r| Ok(ChatMessage { id: r.get(0)?, ts: r.get(1)?, role: r.get(2)?, content: r.get(3)? }))?;
    let mut out = vec![];
    for r in rows {
        out.push(r?);
    }
    out.reverse();
    Ok(out)
}

#[tauri::command]
pub fn agent_clear_chat(state: tauri::State<'_, AppState>) -> AppResult<()> {
    let conn = state.db.lock();
    conn.execute("DELETE FROM agent_messages", [])?;
    Ok(())
}

#[tauri::command]
pub async fn agent_chat(state: tauri::State<'_, AppState>, message: String, snapshot: Snapshot) -> AppResult<ChatReply> {
    let message = message.trim().to_string();
    if message.is_empty() {
        return Err(AppError::Msg("empty message".into()));
    }
    // History (stable prefix) + current snapshot + new message (volatile suffix).
    let history: Vec<(String, String)> = {
        let conn = state.db.lock();
        let mut stmt = conn.prepare("SELECT role, content FROM agent_messages ORDER BY id DESC LIMIT 20")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut v = vec![];
        for r in rows {
            v.push(r?);
        }
        v.reverse();
        v
    };
    let rules = load_rules(&state)?;
    let mut messages: Vec<Value> = vec![];
    for (role, content) in history {
        let role = if role == "assistant" { "assistant" } else { "user" };
        // Ensure alternation: merge consecutive same-role messages.
        if let Some(last) = messages.last_mut() {
            if last["role"] == role {
                let prev = last["content"].as_str().unwrap_or("").to_string();
                last["content"] = json!(format!("{prev}\n\n{content}"));
                continue;
            }
        }
        messages.push(json!({"role": role, "content": content}));
    }
    let ctx = json!({
        "treasury_usd": snapshot.total(),
        "allocation_pct": {"SOL": snapshot.alloc_pct("SOL"), "USDC": snapshot.alloc_pct("USDC"), "XMR": snapshot.alloc_pct("XMR"), "ZEC": snapshot.alloc_pct("ZEC"), "TOKENS": snapshot.alloc_pct("TOKENS")},
        "balances": snapshot.balances,
        "prices_usd": snapshot.prices,
        "realized_pnl_usd": snapshot.realized_pnl_usd,
        "unrealized_pnl_usd": snapshot.unrealized_pnl_usd,
        "data_sources": snapshot.sources,
        "existing_rules": rules.iter().map(|r| json!({"name": r.name, "enabled": r.enabled, "trigger": r.trigger, "action": r.action})).collect::<Vec<_>>(),
    });
    let user_turn = format!("<snapshot>\n{}\n</snapshot>\n\n{}", serde_json::to_string_pretty(&ctx)?, message);
    if let Some(last) = messages.last_mut() {
        if last["role"] == "user" {
            let prev = last["content"].as_str().unwrap_or("").to_string();
            last["content"] = json!(format!("{prev}\n\n{user_turn}"));
        } else {
            messages.push(json!({"role": "user", "content": user_turn}));
        }
    } else {
        messages.push(json!({"role": "user", "content": user_turn}));
    }

    let reply = llm::structured(&state, SYSTEM_PROMPT, messages, reply_schema()).await?;
    let text = reply.json["reply"].as_str().unwrap_or("").to_string();

    let mut out_rules = vec![];
    let mut proposals = vec![];
    let mut invalid = vec![];
    if let Some(list) = reply.json["rules"].as_array() {
        for r in list {
            let t: Result<Trigger, _> = serde_json::from_str(r["trigger_json"].as_str().unwrap_or(""));
            let a: Result<Action, _> = serde_json::from_str(r["action_json"].as_str().unwrap_or(""));
            match (t, a) {
                (Ok(trigger), Ok(action)) => out_rules.push(SuggestedRule {
                    name: r["name"].as_str().unwrap_or("rule").into(),
                    trigger,
                    action,
                    cooldown_secs: r["cooldown_secs"].as_i64().unwrap_or(3600).max(60),
                }),
                (t, a) => invalid.push(format!("rule '{}': {}", r["name"].as_str().unwrap_or("?"), t.err().map(|e| e.to_string()).or(a.err().map(|e| e.to_string())).unwrap_or_default())),
            }
        }
    }
    {
        let conn = state.db.lock();
        if let Some(list) = reply.json["actions"].as_array() {
            for a in list {
                match serde_json::from_str::<Action>(a["action_json"].as_str().unwrap_or("")) {
                    Ok(action) => {
                        let p = Proposal {
                            id: uuid::Uuid::new_v4().to_string(),
                            ts: db::now(),
                            rule_id: None,
                            source: "llm".into(),
                            title: a["title"].as_str().unwrap_or("proposal").into(),
                            rationale: a["rationale"].as_str().unwrap_or("").into(),
                            action,
                            status: "pending".into(),
                            decided_ts: None,
                            result: None,
                        };
                        insert_proposal(&conn, &p)?;
                        proposals.push(p);
                    }
                    Err(e) => invalid.push(format!("action '{}': {e}", a["title"].as_str().unwrap_or("?"))),
                }
            }
        }
        conn.execute("INSERT INTO agent_messages(ts, role, content) VALUES(?1, 'user', ?2)", params![db::now(), message])?;
        conn.execute("INSERT INTO agent_messages(ts, role, content) VALUES(?1, 'assistant', ?2)", params![db::now(), text])?;
        db::audit(
            &conn,
            "llm",
            "chat",
            Some(&json!({"model": reply.model, "in": reply.input_tokens, "out": reply.output_tokens, "rules_suggested": out_rules.len(), "proposals": proposals.len(), "invalid": invalid.len()})),
        )?;
    }
    Ok(ChatReply { reply: text, rules: out_rules, proposals, invalid, model: reply.model, tokens: (reply.input_tokens, reply.output_tokens) })
}
