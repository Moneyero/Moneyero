import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../lib/store";
import { invoke, isTauri } from "../lib/tauri";
import type { Action, AuditRow, ChatMessage, ChatReply, Proposal, Rule, Snapshot, Trigger } from "../lib/types";
import { ago, errMsg, ts, usd } from "../lib/format";
import { Banner, Btn, Chip, Empty, ErrLine, Field, Input, Kv, Panel, Prompt, Select, Td, Th } from "../components/ui";

const TRIGGERS: { kind: Trigger["kind"]; label: string; params: { key: string; label: string; type: "number" | "asset" | "symbol" }[] }[] = [
  { kind: "realized_pnl_above", label: "realised P&L above $", params: [{ key: "usd", label: "usd", type: "number" }] },
  { kind: "sol_balance_above", label: "SOL balance above", params: [{ key: "sol", label: "sol", type: "number" }] },
  { kind: "allocation_above", label: "allocation above %", params: [{ key: "asset", label: "asset", type: "asset" }, { key: "pct", label: "%", type: "number" }] },
  { kind: "allocation_below", label: "allocation below %", params: [{ key: "asset", label: "asset", type: "asset" }, { key: "pct", label: "%", type: "number" }] },
  { kind: "price_above", label: "price above $", params: [{ key: "symbol", label: "symbol", type: "symbol" }, { key: "usd", label: "usd", type: "number" }] },
  { kind: "price_below", label: "price below $", params: [{ key: "symbol", label: "symbol", type: "symbol" }, { key: "usd", label: "usd", type: "number" }] },
  { kind: "unshielded_zec_above", label: "transparent ZEC above", params: [{ key: "zec", label: "zec", type: "number" }] },
  { kind: "treasury_value_above", label: "treasury value above $", params: [{ key: "usd", label: "usd", type: "number" }] },
];
const ACTIONS: { kind: Action["kind"]; label: string }[] = [
  { kind: "propose_move", label: "propose cross-chain move (EXCHANGE)" },
  { kind: "propose_swap", label: "propose Solana swap (TERMINAL)" },
  { kind: "propose_shield", label: "propose shielding ZEC (VAULT)" },
  { kind: "notify", label: "notify only" },
];
const ASSETS = ["SOL", "USDC", "XMR", "ZEC", "TOKENS"];

export function describeTrigger(t: Trigger): string {
  switch (t.kind) {
    case "realized_pnl_above": return `realised P&L > ${usd(t.usd)}`;
    case "sol_balance_above": return `SOL balance > ${t.sol}`;
    case "allocation_above": return `${t.asset} allocation > ${t.pct}%`;
    case "allocation_below": return `${t.asset} allocation < ${t.pct}%`;
    case "price_above": return `${t.symbol} > ${usd(t.usd)}`;
    case "price_below": return `${t.symbol} < ${usd(t.usd)}`;
    case "unshielded_zec_above": return `transparent ZEC > ${t.zec}`;
    case "treasury_value_above": return `treasury > ${usd(t.usd)}`;
  }
}
export function describeAction(a: Action): string {
  switch (a.kind) {
    case "propose_move": return `move ${a.amount != null ? a.amount : a.pct != null ? `${a.pct}% of` : ""} ${a.from} → ${a.to}`;
    case "propose_swap": return `swap ${a.amount != null ? a.amount : a.pct != null ? `${a.pct}% of` : ""} ${a.from_symbol} → ${a.to_symbol}`;
    case "propose_shield": return "shield transparent ZEC";
    case "notify": return `notify: ${a.message}`;
  }
}

export default function Agent() {
  const { settings, setSetting, prices, treasury, realizedPnl, unrealizedPnl, wallet, vault, setHandoff, setView, toast } = useApp();
  const [rules, setRules] = useState<Rule[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [msgs, setMsgs] = useState<ChatMessage[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lastReply, setLastReply] = useState<ChatReply | null>(null);
  const [form, setForm] = useState<{ name: string; tkind: Trigger["kind"]; tp: Record<string, string>; akind: Action["kind"]; ap: Record<string, string>; cooldown: string }>({
    name: "",
    tkind: "realized_pnl_above",
    tp: { usd: "500" },
    akind: "propose_move",
    ap: { from: "SOL", to: "XMR", pct: "30" },
    cooldown: "3600",
  });
  const chatEnd = useRef<HTMLDivElement>(null);
  const enabled = (settings["agent.enabled"] ?? "false") === "true";

  const snapshot = useMemo<Snapshot>(
    () => ({
      prices: { SOL: prices.SOL ?? 0, XMR: prices.XMR ?? 0, ZEC: prices.ZEC ?? 0, USDC: 1, ...Object.fromEntries(Object.entries(prices).filter(([k]) => k.length <= 10)) },
      balances: { sol: treasury.sol, usdc: treasury.usdc, xmr: treasury.xmr, zec: treasury.zec, zec_transparent: treasury.zecTransparent, sol_tokens_usd: treasury.solTokensUsd },
      realized_pnl_usd: realizedPnl,
      unrealized_pnl_usd: unrealizedPnl,
      wallet: wallet.pubkey,
      sources: [wallet.pubkey ? `solana:${wallet.kind}` : "solana:none", treasury.xmrOpen ? "monero:wallet-rpc" : "monero:closed", treasury.zecReachable ? "zcash:rpc" : "zcash:offline", "prices:coingecko+jupiter"],
    }),
    [prices, treasury, realizedPnl, unrealizedPnl, wallet],
  );

  const load = useCallback(async () => {
    if (!isTauri) return;
    try {
      const [r, p, m, a] = await Promise.all([
        invoke<Rule[]>("agent_rules"),
        invoke<Proposal[]>("agent_proposals", { status: null }),
        invoke<ChatMessage[]>("agent_messages"),
        invoke<AuditRow[]>("audit_list", { limit: 40 }),
      ]);
      setRules(r);
      setProposals(p);
      setMsgs(m);
      setAudit(a.filter((x) => x.actor === "rules" || x.actor === "llm" || x.event.startsWith("proposal") || x.event.startsWith("rule")));
      setErr(null);
    } catch (e) {
      setErr(errMsg(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: "end" });
  }, [msgs, lastReply]);

  // Rules engine tick (also runs while this view is open; App runs a background tick too).
  useEffect(() => {
    if (!isTauri || !enabled) return;
    const secs = Math.max(15, Number(settings["agent.tick_secs"] ?? 60));
    const t = setInterval(async () => {
      try {
        const created = await invoke<Proposal[]>("agent_tick", { snapshot });
        if (created.length) {
          toast(`${created.length} new agent proposal(s)`, "warn");
          load();
        }
      } catch {
        /* evaluated again next tick */
      }
    }, secs * 1000);
    return () => clearInterval(t);
  }, [enabled, settings, snapshot, load, toast]);

  const send = async () => {
    const m = input.trim();
    if (!m) return;
    setBusy("chat");
    setErr(null);
    try {
      const r = await invoke<ChatReply>("agent_chat", { message: m, snapshot });
      setLastReply(r);
      setInput("");
      await load();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const addRule = async (r: { name: string; trigger: Trigger; action: Action; cooldown_secs: number }) => {
    try {
      await invoke("agent_rule_upsert", { rule: { id: "", name: r.name, enabled: true, trigger: r.trigger, action: r.action, cooldown_secs: r.cooldown_secs, last_fired: null, created: 0 } });
      toast(`rule '${r.name}' added`, "ok");
      load();
    } catch (e) {
      toast(errMsg(e), "err");
    }
  };

  const toggleRule = async (r: Rule) => {
    await invoke("agent_rule_upsert", { rule: { ...r, enabled: !r.enabled } }).catch((e) => toast(errMsg(e), "err"));
    load();
  };

  const decide = async (p: Proposal, approve: boolean) => {
    setBusy(p.id);
    try {
      const upd = await invoke<Proposal>("agent_decide", { id: p.id, approve, note: null });
      if (approve) {
        switch (upd.action.kind) {
          case "propose_move":
            setHandoff({ proposal: upd });
            setView("exchange");
            break;
          case "propose_swap":
            setHandoff({ proposal: upd });
            setView("terminal");
            break;
          case "propose_shield":
            setHandoff({ proposal: upd });
            setView("vault");
            break;
          case "notify":
            await invoke("agent_result", { id: upd.id, ok: true, result: "acknowledged" });
        }
      }
      load();
    } catch (e) {
      toast(errMsg(e), "err");
    } finally {
      setBusy(null);
    }
  };

  const buildFromForm = (): { trigger: Trigger; action: Action } | string => {
    const n = (k: string) => Number(form.tp[k]);
    let trigger: Trigger;
    switch (form.tkind) {
      case "realized_pnl_above": trigger = { kind: form.tkind, usd: n("usd") }; break;
      case "sol_balance_above": trigger = { kind: form.tkind, sol: n("sol") }; break;
      case "allocation_above":
      case "allocation_below": trigger = { kind: form.tkind, asset: form.tp.asset ?? "SOL", pct: n("pct") }; break;
      case "price_above":
      case "price_below": trigger = { kind: form.tkind, symbol: (form.tp.symbol ?? "SOL").toUpperCase(), usd: n("usd") }; break;
      case "unshielded_zec_above": trigger = { kind: form.tkind, zec: n("zec") }; break;
      case "treasury_value_above": trigger = { kind: form.tkind, usd: n("usd") }; break;
    }
    const a = form.ap;
    let action: Action;
    switch (form.akind) {
      case "propose_move": action = { kind: "propose_move", from: a.from ?? "SOL", to: a.to ?? "XMR", pct: a.pct ? Number(a.pct) : null, amount: a.amount ? Number(a.amount) : null, note: a.note || null }; break;
      case "propose_swap": action = { kind: "propose_swap", from_symbol: (a.from_symbol ?? "").toUpperCase(), to_symbol: (a.to_symbol ?? "USDC").toUpperCase(), pct: a.pct ? Number(a.pct) : null, amount: a.amount ? Number(a.amount) : null, note: a.note || null }; break;
      case "propose_shield": action = { kind: "propose_shield", note: a.note || null }; break;
      case "notify": action = { kind: "notify", message: a.message ?? "" }; break;
    }
    if (!form.name.trim()) return "name required";
    return { trigger, action };
  };

  if (!isTauri) {
    return <div className="view"><Banner tone="warn">The agent (rules engine, proposals, Claude integration) runs in the desktop backend with vault-held credentials. Not available in browser mode.</Banner></div>;
  }

  const pending = proposals.filter((p) => p.status === "pending");
  const tdef = TRIGGERS.find((t) => t.kind === form.tkind)!;
  const total = snapshot.balances.sol * snapshot.prices.SOL + snapshot.balances.usdc + snapshot.balances.sol_tokens_usd + snapshot.balances.xmr * snapshot.prices.XMR + snapshot.balances.zec * snapshot.prices.ZEC;

  return (
    <div className="view">
      <Banner tone="or"><b>APPROVAL-FIRST</b> Rules and the model create proposals only. Nothing is signed, sent or ordered until you approve a proposal here, and approval routes you into the normal manual flow. The agent has no key access. Every step is in the audit trail.</Banner>
      <ErrLine e={err} />
      <div className="row ac wrap">
        <Panel title="Engine" style={{ width: 300 }}>
          <div className="row ac sb">
            <span>rules engine</span>
            <Btn size="sm" variant={enabled ? "danger" : "primary"} onClick={() => setSetting("agent.enabled", enabled ? "false" : "true")}>{enabled ? "disable" : "enable"}</Btn>
          </div>
          <Kv items={[["tick", `${settings["agent.tick_secs"] ?? 60}s`], ["model", settings["agent.model"] ?? "-"], ["effort", settings["agent.effort"] ?? "-"], ["api key", vault?.secret_slots?.["anthropic.api_key"] ? <span className="ok">set</span> : <span className="warn">missing (SETTINGS)</span>], ["vault", vault?.unlocked ? <span className="ok">unlocked</span> : <span className="warn">locked - model calls need the key</span>]]} />
        </Panel>
        <Panel title="Snapshot fed to rules / model" className="grow">
          <div className="row gap12 wrap">
            <Kv items={[["treasury", usd(total)], ["SOL", `${treasury.sol.toFixed(4)} (${usd(treasury.sol * snapshot.prices.SOL)})`], ["USDC", usd(treasury.usdc)], ["tokens", usd(treasury.solTokensUsd)]]} />
            <Kv items={[["XMR", treasury.xmrOpen ? `${treasury.xmr.toFixed(6)} (${usd(treasury.xmr * snapshot.prices.XMR)})` : "wallet closed"], ["ZEC", treasury.zecReachable ? `${treasury.zec.toFixed(6)} (${usd(treasury.zec * snapshot.prices.ZEC)})` : "offline"], ["ZEC transparent", treasury.zecReachable ? treasury.zecTransparent.toFixed(6) : "-"], ["rPNL / uPNL", `${usd(realizedPnl)} / ${usd(unrealizedPnl)}`]]} />
            <Kv items={[["sources", snapshot.sources.join(" · ")]]} wrap />
          </div>
        </Panel>
      </div>

      <div className="row" style={{ minHeight: 360 }}>
        <Panel title="Natural-language control" className="grow" tight right={<Btn size="xs" variant="ghost" onClick={() => invoke("agent_clear_chat").then(load)}>clear</Btn>}>
          <div className="scroll" style={{ height: 300, padding: 8 }}>
            {!msgs.length && <Empty>Examples: "When realised profit exceeds $500, propose moving 30% into XMR." · "Alert me if transparent ZEC is above 0.5." · "What is my current allocation and what would you change?"</Empty>}
            {msgs.map((m) => (
              <div key={m.id} className="small" style={{ marginBottom: 6 }}>
                <span className={m.role === "user" ? "or" : "gold"}>{m.role === "user" ? "you" : "agent"}</span> <span className="dim xs">{ago(m.ts)}</span>
                <pre style={{ color: "var(--fg)", marginTop: 2 }}>{m.content}</pre>
              </div>
            ))}
            {lastReply && (lastReply.rules.length > 0 || lastReply.invalid.length > 0 || lastReply.proposals.length > 0) && (
              <div className="banner" style={{ marginTop: 6 }}>
                {lastReply.rules.map((r, i) => (
                  <div key={i} className="row ac sb small">
                    <span><b>{r.name}</b>: when {describeTrigger(r.trigger)} → {describeAction(r.action)} <span className="dim">(cooldown {r.cooldown_secs}s)</span></span>
                    <Btn size="xs" variant="primary" onClick={() => addRule(r)}>add rule</Btn>
                  </div>
                ))}
                {lastReply.proposals.length > 0 && <div className="small">{lastReply.proposals.length} proposal(s) queued for approval below.</div>}
                {lastReply.invalid.map((x, i) => <div key={i} className="err small">rejected: {x}</div>)}
                <div className="dim xs">{lastReply.model} · {lastReply.tokens[0]}/{lastReply.tokens[1]} tok</div>
              </div>
            )}
            <div ref={chatEnd} />
          </div>
          <div style={{ padding: 8, borderTop: "1px solid var(--line)" }} className="row ac">
            <div className="grow"><Prompt value={input} onChange={setInput} onEnter={send} placeholder="instruction or question…" /></div>
            <Btn variant="primary" busy={busy === "chat"} onClick={send}>send</Btn>
          </div>
        </Panel>

        <Panel title={`Proposals (${pending.length} pending)`} style={{ width: 520 }} tight>
          <div className="scroll" style={{ maxHeight: 360 }}>
            {!proposals.length && <Empty>none</Empty>}
            {proposals.slice(0, 30).map((p) => (
              <div key={p.id} style={{ padding: "6px 8px", borderBottom: "1px solid var(--line)" }}>
                <div className="row ac sb">
                  <span><Chip tone={p.source === "llm" ? "gold" : "or"}>{p.source}</Chip> <b>{p.title}</b></span>
                  <span className={p.status === "pending" ? "warn" : p.status === "executed" ? "ok" : p.status === "failed" || p.status === "rejected" ? "err" : "muted"}>{p.status}</span>
                </div>
                <div className="dim small">{p.rationale}</div>
                <div className="small muted">→ {describeAction(p.action)} · {ts(p.ts)}{p.result ? ` · ${p.result}` : ""}</div>
                {p.status === "pending" && (
                  <div className="row mt4">
                    <Btn size="xs" variant="primary" busy={busy === p.id} onClick={() => decide(p, true)}>approve → execute manually</Btn>
                    <Btn size="xs" variant="danger" onClick={() => decide(p, false)}>reject</Btn>
                  </div>
                )}
                {p.status === "approved" && (
                  <div className="row mt4">
                    <Btn size="xs" onClick={() => { setHandoff({ proposal: p }); setView(p.action.kind === "propose_move" ? "exchange" : p.action.kind === "propose_swap" ? "terminal" : "vault"); }}>resume</Btn>
                    <Btn size="xs" variant="ghost" onClick={() => invoke("agent_result", { id: p.id, ok: true, result: "marked done by operator" }).then(load)}>mark done</Btn>
                    <Btn size="xs" variant="ghost" onClick={() => invoke("agent_result", { id: p.id, ok: false, result: "abandoned by operator" }).then(load)}>abandon</Btn>
                  </div>
                )}
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div className="row">
        <Panel title={`Rules (${rules.length})`} className="grow" tight>
          <table className="tbl">
            <thead><tr><Th>on</Th><Th>name</Th><Th>when</Th><Th>then</Th><Th>cooldown</Th><Th>last fired</Th><Th></Th></tr></thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id}>
                  <Td><Btn size="xs" variant={r.enabled ? "primary" : "ghost"} onClick={() => toggleRule(r)}>{r.enabled ? "on" : "off"}</Btn></Td>
                  <Td>{r.name}</Td>
                  <Td>{describeTrigger(r.trigger)}</Td>
                  <Td className="muted">{describeAction(r.action)}</Td>
                  <Td className="dim">{r.cooldown_secs}s</Td>
                  <Td className="dim">{r.last_fired ? `${ago(r.last_fired)} ago` : "never"}</Td>
                  <Td><Btn size="xs" variant="danger" onClick={() => invoke("agent_rule_delete", { id: r.id }).then(load)}>del</Btn></Td>
                </tr>
              ))}
              {!rules.length && <tr><Td colSpan={7}><Empty>no rules. Build one below or ask the agent.</Empty></Td></tr>}
            </tbody>
          </table>
        </Panel>
        <Panel title="Rule builder" style={{ width: 480 }}>
          <Field label="name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="take profit into xmr" /></Field>
          <Field label="when"><Select value={form.tkind} onChange={(e) => setForm({ ...form, tkind: e.target.value as Trigger["kind"], tp: {} })}>{TRIGGERS.map((t) => <option key={t.kind} value={t.kind}>{t.label}</option>)}</Select></Field>
          <div className="row">
            {tdef.params.map((p) => (
              <Field key={p.key} label={p.label} className="grow">
                {p.type === "asset" ? (
                  <Select value={form.tp[p.key] ?? "SOL"} onChange={(e) => setForm({ ...form, tp: { ...form.tp, [p.key]: e.target.value } })}>{ASSETS.map((a) => <option key={a}>{a}</option>)}</Select>
                ) : (
                  <Input mono value={form.tp[p.key] ?? ""} onChange={(e) => setForm({ ...form, tp: { ...form.tp, [p.key]: e.target.value } })} />
                )}
              </Field>
            ))}
          </div>
          <Field label="then"><Select value={form.akind} onChange={(e) => setForm({ ...form, akind: e.target.value as Action["kind"], ap: {} })}>{ACTIONS.map((a) => <option key={a.kind} value={a.kind}>{a.label}</option>)}</Select></Field>
          {form.akind === "propose_move" && (
            <div className="row">
              <Field label="from" className="grow"><Select value={form.ap.from ?? "SOL"} onChange={(e) => setForm({ ...form, ap: { ...form.ap, from: e.target.value } })}>{["SOL", "USDC", "XMR", "ZEC"].map((a) => <option key={a}>{a}</option>)}</Select></Field>
              <Field label="to" className="grow"><Select value={form.ap.to ?? "XMR"} onChange={(e) => setForm({ ...form, ap: { ...form.ap, to: e.target.value } })}>{["XMR", "ZEC", "SOL", "USDC"].map((a) => <option key={a}>{a}</option>)}</Select></Field>
              <Field label="% of from" className="grow"><Input mono value={form.ap.pct ?? ""} onChange={(e) => setForm({ ...form, ap: { ...form.ap, pct: e.target.value } })} /></Field>
              <Field label="or amount" className="grow"><Input mono value={form.ap.amount ?? ""} onChange={(e) => setForm({ ...form, ap: { ...form.ap, amount: e.target.value } })} /></Field>
            </div>
          )}
          {form.akind === "propose_swap" && (
            <div className="row">
              <Field label="from symbol" className="grow"><Input value={form.ap.from_symbol ?? ""} onChange={(e) => setForm({ ...form, ap: { ...form.ap, from_symbol: e.target.value } })} /></Field>
              <Field label="to symbol" className="grow"><Input value={form.ap.to_symbol ?? "USDC"} onChange={(e) => setForm({ ...form, ap: { ...form.ap, to_symbol: e.target.value } })} /></Field>
              <Field label="%" className="grow"><Input mono value={form.ap.pct ?? ""} onChange={(e) => setForm({ ...form, ap: { ...form.ap, pct: e.target.value } })} /></Field>
            </div>
          )}
          {form.akind === "notify" && <Field label="message"><Input value={form.ap.message ?? ""} onChange={(e) => setForm({ ...form, ap: { ...form.ap, message: e.target.value } })} /></Field>}
          <div className="row ac">
            <Field label="cooldown (s)" style={{ width: 120 }}><Input mono value={form.cooldown} onChange={(e) => setForm({ ...form, cooldown: e.target.value })} /></Field>
            <Btn variant="primary" style={{ marginTop: 14 }} onClick={() => { const b = buildFromForm(); if (typeof b === "string") return toast(b, "err"); addRule({ name: form.name.trim(), trigger: b.trigger, action: b.action, cooldown_secs: Number(form.cooldown) || 3600 }); }}>add rule</Btn>
          </div>
        </Panel>
      </div>

      <Panel title="Agent audit (latest)" tight>
        <table className="tbl dense">
          <thead><tr><Th w={150}>time</Th><Th w={60}>actor</Th><Th w={170}>event</Th><Th>detail</Th></tr></thead>
          <tbody>
            {audit.map((a) => <tr key={a.id}><Td className="dim">{ts(a.ts)}</Td><Td className={a.actor === "llm" ? "gold" : a.actor === "rules" ? "or" : "muted"}>{a.actor}</Td><Td>{a.event}</Td><Td wrap className="dim">{a.detail}</Td></tr>)}
            {!audit.length && <tr><Td colSpan={4}><Empty>nothing yet</Empty></Td></tr>}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
