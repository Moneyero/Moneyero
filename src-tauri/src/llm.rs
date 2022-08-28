//! Claude API client (raw HTTP through the app's proxied client). The key lives in the vault.
//! The model only ever *proposes*; nothing here can sign, send, or place an order.

use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::settings;
use crate::state::AppState;

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2026-10-21";

pub struct LlmReply {
    pub json: Value,
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

fn supports_fallbacks(model: &str) -> bool {
    model.starts_with("claude-opus-5") || model.starts_with("claude-fable-5") || model == "claude-sonnet-5-5"
}

/// One structured-output round trip. `system` is cached as a stable prefix; the volatile
/// snapshot must be placed by the caller inside the last user message.
pub async fn structured(state: &AppState, system: &str, messages: Vec<Value>, schema: Value) -> AppResult<LlmReply> {
    let api_key = settings::secret_get_string(state, "anthropic.api_key")?
        .ok_or_else(|| AppError::Msg("Anthropic API key not set (SETTINGS > keys)".into()))?;
    let model = state.setting("agent.model");
    let effort = state.setting("agent.effort");
    let effort = if ["low", "medium", "high", "xhigh", "max"].contains(&effort.as_str()) { effort } else { "medium".into() };

    let mut body = json!({
        "model": model,
        "max_tokens": 8000,
        "system": [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
        "messages": messages,
        "output_config": {
            "effort": effort,
            "format": {"type": "json_schema", "schema": schema}
        }
    });
    let mut betas: Vec<&str> = vec![];
    if supports_fallbacks(&model) {
        body["fallbacks"] = json!("default");
        betas.push("server-side-fallback-2026-07-01");
    }

    let client = state.client_timeout(180)?;
    let mut req = client
        .post(API_URL)
        .header("content-type", "application/json")
        .header("x-api-key", api_key)
        .header("anthropic-version", API_VERSION);
    if !betas.is_empty() {
        req = req.header("anthropic-beta", betas.join(","));
    }
    let resp = req.json(&body).send().await?;
    let status = resp.status();
    let text = resp.text().await?;
    if !status.is_success() {
        let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        let m = v["error"]["message"].as_str().unwrap_or(&text);
        return Err(AppError::Msg(format!("Claude API {}: {}", status.as_u16(), crate::http::truncate(m, 400))));
    }
    let v: Value = serde_json::from_str(&text)?;
    let stop = v["stop_reason"].as_str().unwrap_or("");
    if stop == "refusal" {
        let cat = v["stop_details"]["category"].as_str().unwrap_or("unspecified");
        return Err(AppError::Msg(format!("model declined the request (category: {cat})")));
    }
    if stop == "max_tokens" {
        return Err(AppError::Msg("model output truncated (max_tokens); try a shorter request".into()));
    }
    let mut out = String::new();
    if let Some(blocks) = v["content"].as_array() {
        for b in blocks {
            if b["type"] == "text" {
                out.push_str(b["text"].as_str().unwrap_or(""));
            }
        }
    }
    let parsed: Value = serde_json::from_str(out.trim())
        .map_err(|e| AppError::Msg(format!("model returned non-JSON output: {e}: {}", crate::http::truncate(&out, 200))))?;
    Ok(LlmReply {
        json: parsed,
        model: v["model"].as_str().unwrap_or(&model).to_string(),
        input_tokens: v["usage"]["input_tokens"].as_u64().unwrap_or(0),
        output_tokens: v["usage"]["output_tokens"].as_u64().unwrap_or(0),
    })
}
