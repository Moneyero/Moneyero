//! Cross-chain swap routing (XMR / ZEC <-> SOL / USDC) through non-custodial swap services.
//!
//! All provider traffic goes through the app HTTP client (so Tor applies). Providers see:
//! your IP (unless proxied), the deposit transaction, the settle address, and the amounts.
//! The UI shows this disclosure on every quote. ZEC legs are transparent-pool on every
//! provider we know of; shield afterwards in VAULT.

use futures::future::join_all;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Instant;

use crate::db;
use crate::error::{AppError, AppResult};
use crate::http::{get_json, post_json};
use crate::settings;
use crate::state::AppState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Asset {
    Xmr,
    Zec,
    Sol,
    Usdc,
}

impl Asset {
    pub fn parse(s: &str) -> AppResult<Asset> {
        match s.trim().to_ascii_uppercase().as_str() {
            "XMR" => Ok(Asset::Xmr),
            "ZEC" => Ok(Asset::Zec),
            "SOL" => Ok(Asset::Sol),
            "USDC" => Ok(Asset::Usdc),
            o => Err(AppError::Msg(format!("unsupported asset {o}"))),
        }
    }
    pub fn ticker(&self) -> &'static str {
        match self {
            Asset::Xmr => "XMR",
            Asset::Zec => "ZEC",
            Asset::Sol => "SOL",
            Asset::Usdc => "USDC",
        }
    }
    fn sideshift(&self) -> (&'static str, &'static str) {
        match self {
            Asset::Xmr => ("xmr", "monero"),
            Asset::Zec => ("zec", "zcash"),
            Asset::Sol => ("sol", "solana"),
            Asset::Usdc => ("usdc", "solana"),
        }
    }
    fn changenow(&self) -> (&'static str, &'static str) {
        match self {
            Asset::Xmr => ("xmr", "xmr"),
            Asset::Zec => ("zec", "zec"),
            Asset::Sol => ("sol", "sol"),
            Asset::Usdc => ("usdc", "sol"),
        }
    }
    fn trocador(&self) -> (&'static str, &'static str) {
        match self {
            Asset::Xmr => ("xmr", "Mainnet"),
            Asset::Zec => ("zec", "Mainnet"),
            Asset::Sol => ("sol", "Mainnet"),
            Asset::Usdc => ("usdc", "SOL"),
        }
    }
    fn exolix(&self) -> (&'static str, &'static str) {
        match self {
            Asset::Xmr => ("XMR", "XMR"),
            Asset::Zec => ("ZEC", "ZEC"),
            Asset::Sol => ("SOL", "SOL"),
            Asset::Usdc => ("USDC", "SOL"),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Quote {
    pub provider: String,
    pub ok: bool,
    pub error: Option<String>,
    pub rate: Option<f64>,
    pub amount_from: f64,
    pub amount_to: Option<f64>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub eta_minutes: Option<f64>,
    pub kyc: Option<String>,
    pub fixed: bool,
    pub notes: Vec<String>,
    pub latency_ms: u128,
    pub requires_key: bool,
    pub quote_ref: Option<String>,
}

impl Quote {
    fn fail(provider: &str, amount_from: f64, err: String, requires_key: bool, t: Instant) -> Quote {
        Quote {
            provider: provider.into(),
            ok: false,
            error: Some(err),
            rate: None,
            amount_from,
            amount_to: None,
            min: None,
            max: None,
            eta_minutes: None,
            kyc: None,
            fixed: false,
            notes: vec![],
            latency_ms: t.elapsed().as_millis(),
            requires_key,
            quote_ref: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Order {
    pub id: String,
    pub ts: i64,
    pub provider: String,
    pub provider_id: String,
    pub from_asset: String,
    pub to_asset: String,
    pub amount_from: f64,
    pub amount_to: Option<f64>,
    pub deposit_address: Option<String>,
    pub deposit_memo: Option<String>,
    pub settle_address: String,
    pub refund_address: Option<String>,
    pub status: String,
    pub raw: Option<String>,
    pub updated: i64,
}

#[derive(Debug, Serialize)]
pub struct ProviderInfo {
    pub name: String,
    pub requires_key: bool,
    pub has_key: bool,
    pub notes: Vec<String>,
    pub url: String,
}

fn num(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn zec_note(from: Asset, to: Asset, notes: &mut Vec<String>) {
    if from == Asset::Zec {
        notes.push("ZEC deposit must come from a TRANSPARENT address (provider cannot receive shielded).".into());
    }
    if to == Asset::Zec {
        notes.push("ZEC is settled to a transparent address. Shield it in VAULT afterwards.".into());
    }
}

fn key(state: &AppState, slot: &str) -> Option<String> {
    settings::secret_get_string(state, slot).ok().flatten()
}

// ------------------------------------------------------------------ SideShift

async fn sideshift_quote(state: &AppState, from: Asset, to: Asset, amount: f64) -> Quote {
    let t = Instant::now();
    let (fc, fn_) = from.sideshift();
    let (tc, tn) = to.sideshift();
    let client = match state.client_timeout(20) {
        Ok(c) => c,
        Err(e) => return Quote::fail("sideshift", amount, e.to_string(), false, t),
    };
    let url = format!("https://sideshift.ai/api/v2/pair/{fc}-{fn_}/{tc}-{tn}?amount={amount}");
    match get_json(&client, &url, &[]).await {
        Ok(v) => {
            let rate = num(&v["rate"]);
            let min = num(&v["min"]);
            let max = num(&v["max"]);
            let mut notes = vec!["Variable rate; final amount set at deposit time.".into(), "Provider geo-blocks some jurisdictions.".into()];
            zec_note(from, to, &mut notes);
            let mut q = Quote {
                provider: "sideshift".into(),
                ok: rate.is_some(),
                error: None,
                rate,
                amount_from: amount,
                amount_to: rate.map(|r| r * amount),
                min,
                max,
                eta_minutes: Some(if from == Asset::Xmr { 20.0 } else { 10.0 }),
                kyc: Some("none (may request on review)".into()),
                fixed: false,
                notes,
                latency_ms: t.elapsed().as_millis(),
                requires_key: false,
                quote_ref: None,
            };
            if let (Some(mn), true) = (min, amount > 0.0) {
                if amount < mn {
                    q.ok = false;
                    q.error = Some(format!("below provider minimum {mn}"));
                }
            }
            if let Some(mx) = max {
                if amount > mx {
                    q.ok = false;
                    q.error = Some(format!("above provider maximum {mx}"));
                }
            }
            q
        }
        Err(e) => Quote::fail("sideshift", amount, e.to_string(), false, t),
    }
}

async fn sideshift_create(state: &AppState, from: Asset, to: Asset, settle: &str, refund: Option<&str>) -> AppResult<Value> {
    let (fc, fn_) = from.sideshift();
    let (tc, tn) = to.sideshift();
    let client = state.client_timeout(30)?;
    let mut body = json!({
        "settleAddress": settle, "depositCoin": fc, "settleCoin": tc,
        "depositNetwork": fn_, "settleNetwork": tn,
    });
    if let Some(r) = refund.filter(|r| !r.is_empty()) {
        body["refundAddress"] = json!(r);
    }
    let aff = state.setting("exchange.sideshift_affiliate");
    if !aff.is_empty() {
        body["affiliateId"] = json!(aff);
    }
    let secret = key(state, "sideshift.secret");
    let mut headers: Vec<(&str, &str)> = vec![];
    if let Some(s) = secret.as_deref() {
        headers.push(("x-sideshift-secret", s));
    }
    post_json(&client, "https://sideshift.ai/api/v2/shifts/variable", &headers, &body).await
}

async fn sideshift_status(state: &AppState, id: &str) -> AppResult<(String, Value)> {
    let client = state.client_timeout(20)?;
    let v = get_json(&client, &format!("https://sideshift.ai/api/v2/shifts/{id}"), &[]).await?;
    let s = v["status"].as_str().unwrap_or("unknown");
    let norm = match s {
        "waiting" => "waiting_deposit",
        "pending" | "processing" => "confirming",
        "review" => "review",
        "settling" => "sending",
        "settled" => "complete",
        "refund" | "refunding" => "refunding",
        "refunded" => "refunded",
        "expired" => "expired",
        _ => "unknown",
    };
    Ok((norm.into(), v))
}

// ------------------------------------------------------------------ ChangeNOW

async fn changenow_quote(state: &AppState, from: Asset, to: Asset, amount: f64) -> Quote {
    let t = Instant::now();
    let Some(k) = key(state, "changenow.api_key") else {
        return Quote::fail("changenow", amount, "API key not configured (SETTINGS > keys)".into(), true, t);
    };
    let (fc, fnet) = from.changenow();
    let (tc, tnet) = to.changenow();
    let client = match state.client_timeout(20) {
        Ok(c) => c,
        Err(e) => return Quote::fail("changenow", amount, e.to_string(), true, t),
    };
    let est = format!("https://api.changenow.io/v2/exchange/estimated-amount?fromCurrency={fc}&toCurrency={tc}&fromAmount={amount}&fromNetwork={fnet}&toNetwork={tnet}&flow=standard");
    let min_url = format!("https://api.changenow.io/v2/exchange/min-amount?fromCurrency={fc}&toCurrency={tc}&fromNetwork={fnet}&toNetwork={tnet}&flow=standard");
    let h = [("x-changenow-api-key", k.as_str())];
    let (e, m) = futures::join!(get_json(&client, &est, &h), get_json(&client, &min_url, &h));
    match e {
        Ok(v) => {
            let to_amt = num(&v["toAmount"]);
            let mut notes = vec!["Standard (floating) flow.".into(), "Provider may hold funds for KYC on risk flags.".into()];
            if let Some(w) = v["warningMessage"].as_str() {
                notes.push(w.into());
            }
            zec_note(from, to, &mut notes);
            Quote {
                provider: "changenow".into(),
                ok: to_amt.is_some(),
                error: None,
                rate: to_amt.map(|a| a / amount),
                amount_from: amount,
                amount_to: to_amt,
                min: m.ok().and_then(|mv| num(&mv["minAmount"])),
                max: None,
                eta_minutes: v["transactionSpeedForecast"].as_str().and_then(|s| s.split('-').last()).and_then(|s| s.trim().parse().ok()),
                kyc: Some("risk-based".into()),
                fixed: false,
                notes,
                latency_ms: t.elapsed().as_millis(),
                requires_key: true,
                quote_ref: None,
            }
        }
        Err(e) => Quote::fail("changenow", amount, e.to_string(), true, t),
    }
}

async fn changenow_create(state: &AppState, from: Asset, to: Asset, amount: f64, settle: &str, refund: Option<&str>) -> AppResult<Value> {
    let k = key(state, "changenow.api_key").ok_or_else(|| AppError::Msg("changenow API key missing".into()))?;
    let (fc, fnet) = from.changenow();
    let (tc, tnet) = to.changenow();
    let client = state.client_timeout(30)?;
    let body = json!({
        "fromCurrency": fc, "toCurrency": tc, "fromNetwork": fnet, "toNetwork": tnet,
        "fromAmount": amount, "address": settle, "refundAddress": refund.unwrap_or(""), "flow": "standard", "type": "direct"
    });
    post_json(&client, "https://api.changenow.io/v2/exchange", &[("x-changenow-api-key", k.as_str())], &body).await
}

async fn changenow_status(state: &AppState, id: &str) -> AppResult<(String, Value)> {
    let k = key(state, "changenow.api_key").ok_or_else(|| AppError::Msg("changenow API key missing".into()))?;
    let client = state.client_timeout(20)?;
    let v = get_json(&client, &format!("https://api.changenow.io/v2/exchange/by-id?id={id}"), &[("x-changenow-api-key", k.as_str())]).await?;
    let norm = match v["status"].as_str().unwrap_or("") {
        "new" | "waiting" => "waiting_deposit",
        "confirming" => "confirming",
        "exchanging" => "exchanging",
        "sending" => "sending",
        "finished" => "complete",
        "failed" => "failed",
        "refunded" => "refunded",
        "verifying" => "review",
        _ => "unknown",
    };
    Ok((norm.into(), v))
}

// ------------------------------------------------------------------ Trocador

async fn trocador_quotes(state: &AppState, from: Asset, to: Asset, amount: f64) -> Vec<Quote> {
    let t = Instant::now();
    let Some(k) = key(state, "trocador.api_key") else {
        return vec![Quote::fail("trocador", amount, "API key not configured (SETTINGS > keys)".into(), true, t)];
    };
    let (ft, fnet) = from.trocador();
    let (tt, tnet) = to.trocador();
    let client = match state.client_timeout(25) {
        Ok(c) => c,
        Err(e) => return vec![Quote::fail("trocador", amount, e.to_string(), true, t)],
    };
    let url = format!("https://trocador.app/api/new_rate?ticker_from={ft}&network_from={fnet}&ticker_to={tt}&network_to={tnet}&amount_from={amount}&payment=False&min_kycrating=C&markup=0&best_only=False");
    match get_json(&client, &url, &[("API-Key", k.as_str())]).await {
        Ok(v) => {
            let trade_id = v["trade_id"].as_str().unwrap_or_default().to_string();
            let mut out = vec![];
            if let Some(list) = v["quotes"]["quotes"].as_array() {
                for q in list {
                    let prov = q["provider"].as_str().unwrap_or("?");
                    let amt = num(&q["amount_to"]);
                    let mut notes = vec![format!("via Trocador aggregator; log policy: {}", q["log_policy"].as_str().unwrap_or("?"))];
                    if q["insurance"].as_f64().unwrap_or(0.0) > 0.0 {
                        notes.push(format!("insurance {}%", q["insurance"]));
                    }
                    zec_note(from, to, &mut notes);
                    out.push(Quote {
                        provider: format!("trocador:{prov}"),
                        ok: amt.is_some(),
                        error: None,
                        rate: amt.map(|a| a / amount),
                        amount_from: amount,
                        amount_to: amt,
                        min: None,
                        max: None,
                        eta_minutes: num(&q["eta"]),
                        kyc: q["kycrating"].as_str().map(|s| format!("rating {s}")),
                        fixed: q["fixed"].as_bool().unwrap_or(false),
                        notes,
                        latency_ms: t.elapsed().as_millis(),
                        requires_key: true,
                        quote_ref: Some(format!("{trade_id}|{prov}")),
                    });
                }
            }
            if out.is_empty() {
                out.push(Quote::fail("trocador", amount, "no routes returned".into(), true, t));
            }
            out
        }
        Err(e) => vec![Quote::fail("trocador", amount, e.to_string(), true, t)],
    }
}

async fn trocador_create(state: &AppState, from: Asset, to: Asset, amount: f64, settle: &str, refund: Option<&str>, quote_ref: &str) -> AppResult<Value> {
    let k = key(state, "trocador.api_key").ok_or_else(|| AppError::Msg("trocador API key missing".into()))?;
    let (trade_id, prov) = quote_ref.split_once('|').ok_or_else(|| AppError::Msg("trocador quote reference missing; re-quote".into()))?;
    let (ft, fnet) = from.trocador();
    let (tt, tnet) = to.trocador();
    let client = state.client_timeout(30)?;
    let url = format!(
        "https://trocador.app/api/new_trade?ticker_from={ft}&network_from={fnet}&ticker_to={tt}&network_to={tnet}&amount_from={amount}&address={settle}&refund={}&provider={prov}&fixed=False&payment=False&id={trade_id}",
        refund.unwrap_or("")
    );
    get_json(&client, &url, &[("API-Key", k.as_str())]).await
}

async fn trocador_status(state: &AppState, id: &str) -> AppResult<(String, Value)> {
    let k = key(state, "trocador.api_key").ok_or_else(|| AppError::Msg("trocador API key missing".into()))?;
    let client = state.client_timeout(20)?;
    let v = get_json(&client, &format!("https://trocador.app/api/trade?id={id}"), &[("API-Key", k.as_str())]).await?;
    let item = v.as_array().and_then(|a| a.first()).cloned().unwrap_or(v);
    let norm = match item["status"].as_str().unwrap_or("") {
        "new" | "waiting" => "waiting_deposit",
        "confirming" => "confirming",
        "sending" => "sending",
        "finished" => "complete",
        "failed" => "failed",
        "expired" => "expired",
        "halted" => "review",
        "refunded" => "refunded",
        _ => "unknown",
    };
    Ok((norm.into(), item))
}

// ------------------------------------------------------------------ Exolix

async fn exolix_quote(state: &AppState, from: Asset, to: Asset, amount: f64) -> Quote {
    let t = Instant::now();
    let (fc, fnet) = from.exolix();
    let (tc, tnet) = to.exolix();
    let client = match state.client_timeout(20) {
        Ok(c) => c,
        Err(e) => return Quote::fail("exolix", amount, e.to_string(), false, t),
    };
    let url = format!("https://exolix.com/api/v2/rate?coinFrom={fc}&networkFrom={fnet}&coinTo={tc}&networkTo={tnet}&amount={amount}&rateType=float");
    let k = key(state, "exolix.api_key");
    let mut h: Vec<(&str, &str)> = vec![];
    if let Some(kk) = k.as_deref() {
        h.push(("Authorization", kk));
    }
    match get_json(&client, &url, &h).await {
        Ok(v) => {
            let to_amt = num(&v["toAmount"]);
            let mut notes = vec!["Floating rate.".into()];
            if let Some(m) = v["message"].as_str() {
                if !m.is_empty() {
                    notes.push(m.into());
                }
            }
            zec_note(from, to, &mut notes);
            Quote {
                provider: "exolix".into(),
                ok: to_amt.is_some(),
                error: v["message"].as_str().filter(|_| to_amt.is_none()).map(|s| s.to_string()),
                rate: num(&v["rate"]).or(to_amt.map(|a| a / amount)),
                amount_from: amount,
                amount_to: to_amt,
                min: num(&v["minAmount"]),
                max: num(&v["maxAmount"]),
                eta_minutes: Some(15.0),
                kyc: Some("risk-based".into()),
                fixed: false,
                notes,
                latency_ms: t.elapsed().as_millis(),
                requires_key: false,
                quote_ref: None,
            }
        }
        Err(e) => Quote::fail("exolix", amount, e.to_string(), false, t),
    }
}

async fn exolix_create(state: &AppState, from: Asset, to: Asset, amount: f64, settle: &str, refund: Option<&str>) -> AppResult<Value> {
    let (fc, fnet) = from.exolix();
    let (tc, tnet) = to.exolix();
    let client = state.client_timeout(30)?;
    let body = json!({
        "coinFrom": fc, "networkFrom": fnet, "coinTo": tc, "networkTo": tnet,
        "amount": amount, "withdrawalAddress": settle, "refundAddress": refund.unwrap_or(""), "rateType": "float"
    });
    let k = key(state, "exolix.api_key");
    let mut h: Vec<(&str, &str)> = vec![];
    if let Some(kk) = k.as_deref() {
        h.push(("Authorization", kk));
    }
    post_json(&client, "https://exolix.com/api/v2/transactions", &h, &body).await
}

async fn exolix_status(state: &AppState, id: &str) -> AppResult<(String, Value)> {
    let client = state.client_timeout(20)?;
    let k = key(state, "exolix.api_key");
    let mut h: Vec<(&str, &str)> = vec![];
    if let Some(kk) = k.as_deref() {
        h.push(("Authorization", kk));
    }
    let v = get_json(&client, &format!("https://exolix.com/api/v2/transactions/{id}"), &h).await?;
    let norm = match v["status"].as_str().unwrap_or("") {
        "wait" => "waiting_deposit",
        "confirmation" | "confirmed" => "confirming",
        "exchanging" => "exchanging",
        "sending" => "sending",
        "success" => "complete",
        "overdue" => "expired",
        "refunded" => "refunded",
        _ => "unknown",
    };
    Ok((norm.into(), v))
}

// ------------------------------------------------------------------ commands

#[tauri::command]
pub fn exchange_providers(state: tauri::State<'_, AppState>) -> AppResult<Vec<ProviderInfo>> {
    let conn = state.db.lock();
    let has = |k: &str| settings::secret_exists(&conn, k).unwrap_or(false);
    Ok(vec![
        ProviderInfo { name: "sideshift".into(), requires_key: false, has_key: has("sideshift.secret"), url: "https://sideshift.ai".into(), notes: vec!["Quotes without an account. Orders optionally tagged with your account secret.".into(), "Geo-blocks US and sanctioned regions.".into()] },
        ProviderInfo { name: "trocador".into(), requires_key: true, has_key: has("trocador.api_key"), url: "https://trocador.app".into(), notes: vec!["Aggregator of 20+ exchanges with KYC ratings and log policies.".into(), "Tor onion endpoint available if you set net proxy.".into()] },
        ProviderInfo { name: "changenow".into(), requires_key: true, has_key: has("changenow.api_key"), url: "https://changenow.io".into(), notes: vec!["Partner API key required for quotes.".into()] },
        ProviderInfo { name: "exolix".into(), requires_key: false, has_key: has("exolix.api_key"), url: "https://exolix.com".into(), notes: vec!["Public rate endpoint; key improves limits.".into()] },
    ])
}

#[tauri::command]
pub async fn exchange_quotes(state: tauri::State<'_, AppState>, from: String, to: String, amount: f64) -> AppResult<Vec<Quote>> {
    let from = Asset::parse(&from)?;
    let to = Asset::parse(&to)?;
    if from == to {
        return Err(AppError::Msg("from and to must differ".into()));
    }
    if !(amount > 0.0) {
        return Err(AppError::Msg("amount must be > 0".into()));
    }
    let enabled = state.setting("exchange.providers");
    let on = |n: &str| enabled.split(',').any(|p| p.trim() == n);
    let st: &AppState = &state;
    let mut futs: Vec<std::pin::Pin<Box<dyn futures::Future<Output = Vec<Quote>> + Send>>> = vec![];
    if on("sideshift") {
        futs.push(Box::pin(async move { vec![sideshift_quote(st, from, to, amount).await] }));
    }
    if on("changenow") {
        futs.push(Box::pin(async move { vec![changenow_quote(st, from, to, amount).await] }));
    }
    if on("trocador") {
        futs.push(Box::pin(async move { trocador_quotes(st, from, to, amount).await }));
    }
    if on("exolix") {
        futs.push(Box::pin(async move { vec![exolix_quote(st, from, to, amount).await] }));
    }
    let mut quotes: Vec<Quote> = join_all(futs).await.into_iter().flatten().collect();
    quotes.sort_by(|a, b| {
        b.ok.cmp(&a.ok).then(b.amount_to.unwrap_or(0.0).partial_cmp(&a.amount_to.unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal))
    });
    state.log("exchange", "quote", "info", &format!("quoted {amount} {} -> {}", from.ticker(), to.ticker()), Some(json!({"providers": quotes.len(), "proxy": state.proxy().is_some()})));
    Ok(quotes)
}

fn row_to_order(r: &rusqlite::Row<'_>) -> rusqlite::Result<Order> {
    Ok(Order {
        id: r.get(0)?,
        ts: r.get(1)?,
        provider: r.get(2)?,
        provider_id: r.get(3)?,
        from_asset: r.get(4)?,
        to_asset: r.get(5)?,
        amount_from: r.get(6)?,
        amount_to: r.get(7)?,
        deposit_address: r.get(8)?,
        deposit_memo: r.get(9)?,
        settle_address: r.get(10)?,
        refund_address: r.get(11)?,
        status: r.get(12)?,
        raw: r.get(13)?,
        updated: r.get(14)?,
    })
}

const ORDER_COLS: &str = "id, ts, provider, provider_id, from_asset, to_asset, amount_from, amount_to, deposit_address, deposit_memo, settle_address, refund_address, status, raw, updated";

#[tauri::command]
pub async fn exchange_create(
    state: tauri::State<'_, AppState>,
    provider: String,
    from: String,
    to: String,
    amount: f64,
    settle_address: String,
    refund_address: Option<String>,
    quote_ref: Option<String>,
) -> AppResult<Order> {
    let fa = Asset::parse(&from)?;
    let ta = Asset::parse(&to)?;
    let settle = settle_address.trim().to_string();
    if settle.is_empty() {
        return Err(AppError::Msg("settle address required".into()));
    }
    let refund = refund_address.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty());
    let base = provider.split(':').next().unwrap_or("").to_string();
    let (provider_id, dep_addr, dep_memo, amount_to, raw) = match base.as_str() {
        "sideshift" => {
            let v = sideshift_create(&state, fa, ta, &settle, refund).await?;
            (
                v["id"].as_str().unwrap_or_default().to_string(),
                v["depositAddress"].as_str().map(|s| s.to_string()),
                v["depositMemo"].as_str().map(|s| s.to_string()),
                None,
                v,
            )
        }
        "changenow" => {
            let v = changenow_create(&state, fa, ta, amount, &settle, refund).await?;
            (
                v["id"].as_str().unwrap_or_default().to_string(),
                v["payinAddress"].as_str().map(|s| s.to_string()),
                v["payinExtraId"].as_str().map(|s| s.to_string()),
                num(&v["toAmount"]),
                v,
            )
        }
        "trocador" => {
            let v = trocador_create(&state, fa, ta, amount, &settle, refund, quote_ref.as_deref().unwrap_or("")).await?;
            (
                v["trade_id"].as_str().unwrap_or_default().to_string(),
                v["address_provider"].as_str().map(|s| s.to_string()),
                v["address_provider_memo"].as_str().map(|s| s.to_string()),
                num(&v["amount_to"]),
                v,
            )
        }
        "exolix" => {
            let v = exolix_create(&state, fa, ta, amount, &settle, refund).await?;
            (
                v["id"].as_str().unwrap_or_default().to_string(),
                v["depositAddress"].as_str().map(|s| s.to_string()),
                v["depositExtraId"].as_str().map(|s| s.to_string()),
                num(&v["amountTo"]),
                v,
            )
        }
        _ => return Err(AppError::Msg(format!("unknown provider {provider}"))),
    };
    if provider_id.is_empty() || dep_addr.is_none() {
        return Err(AppError::Msg(format!("provider returned no deposit address: {}", crate::http::truncate(&raw.to_string(), 300))));
    }
    let order = Order {
        id: uuid::Uuid::new_v4().to_string(),
        ts: db::now(),
        provider: provider.clone(),
        provider_id,
        from_asset: fa.ticker().into(),
        to_asset: ta.ticker().into(),
        amount_from: amount,
        amount_to,
        deposit_address: dep_addr,
        deposit_memo: dep_memo,
        settle_address: settle,
        refund_address: refund.map(|s| s.to_string()),
        status: "waiting_deposit".into(),
        raw: Some(raw.to_string()),
        updated: db::now(),
    };
    {
        let conn = state.db.lock();
        conn.execute(
            &format!("INSERT INTO swap_orders({ORDER_COLS}) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)"),
            params![
                order.id, order.ts, order.provider, order.provider_id, order.from_asset, order.to_asset, order.amount_from,
                order.amount_to, order.deposit_address, order.deposit_memo, order.settle_address, order.refund_address,
                order.status, order.raw, order.updated
            ],
        )?;
    }
    state.log("exchange", "order_created", "info", &format!("{} order {} {} -> {}", provider, amount, fa.ticker(), ta.ticker()), Some(json!({"order_id": order.id, "provider_id": order.provider_id})));
    state.audit("user", "exchange.order_create", Some(json!({"order_id": order.id, "provider": provider})));
    Ok(order)
}

#[tauri::command]
pub async fn exchange_refresh(state: tauri::State<'_, AppState>, order_id: String) -> AppResult<Order> {
    let mut order: Order = {
        let conn = state.db.lock();
        conn.query_row(&format!("SELECT {ORDER_COLS} FROM swap_orders WHERE id = ?1"), params![order_id], row_to_order)?
    };
    let base = order.provider.split(':').next().unwrap_or("").to_string();
    let (status, raw) = match base.as_str() {
        "sideshift" => sideshift_status(&state, &order.provider_id).await?,
        "changenow" => changenow_status(&state, &order.provider_id).await?,
        "trocador" => trocador_status(&state, &order.provider_id).await?,
        "exolix" => exolix_status(&state, &order.provider_id).await?,
        _ => return Err(AppError::Msg("unknown provider".into())),
    };
    let settle_amt = num(&raw["settleAmount"]).or(num(&raw["amountTo"])).or(num(&raw["amount_to"])).or(num(&raw["amountReceive"]));
    if settle_amt.is_some() {
        order.amount_to = settle_amt;
    }
    let changed = order.status != status;
    order.status = status.clone();
    order.raw = Some(raw.to_string());
    order.updated = db::now();
    {
        let conn = state.db.lock();
        conn.execute(
            "UPDATE swap_orders SET status = ?1, raw = ?2, updated = ?3, amount_to = ?4 WHERE id = ?5",
            params![order.status, order.raw, order.updated, order.amount_to, order.id],
        )?;
    }
    if changed {
        let level = match status.as_str() {
            "failed" | "expired" | "refunded" | "refunding" | "review" => "warn",
            _ => "info",
        };
        state.log("exchange", "order_status", level, &format!("{} order now {}", order.provider, status), Some(json!({"order_id": order.id})));
    }
    Ok(order)
}

#[tauri::command]
pub fn exchange_orders(state: tauri::State<'_, AppState>) -> AppResult<Vec<Order>> {
    let conn = state.db.lock();
    let mut stmt = conn.prepare(&format!("SELECT {ORDER_COLS} FROM swap_orders ORDER BY ts DESC LIMIT 200"))?;
    let rows = stmt.query_map([], row_to_order)?;
    let mut out = vec![];
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}
