import { useCallback, useEffect, useMemo, useState } from "react";
import { useApp } from "../lib/store";
import { invoke, isTauri } from "../lib/tauri";
import type { Order, ProviderInfo, Quote, XmrBalance, ZecAddress } from "../lib/types";
import { ago, errMsg, fmt, ts, usd } from "../lib/format";
import { exchangeWarnings } from "../lib/privacy";
import { Addr, Banner, Btn, Chip, Empty, ErrLine, Field, Input, Kv, Panel, Select, Td, Th, Warnings } from "../components/ui";

const ASSETS = ["XMR", "ZEC", "SOL", "USDC"] as const;
type Asset = (typeof ASSETS)[number];

const ACTIVE = new Set(["waiting_deposit", "confirming", "exchanging", "sending", "review", "refunding", "unknown"]);

export default function Exchange() {
  const { wallet, net, prices, treasury, handoff, setHandoff, toast } = useApp();
  const [from, setFrom] = useState<Asset>("SOL");
  const [to, setTo] = useState<Asset>("XMR");
  const [amount, setAmount] = useState("1");
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [sel, setSel] = useState<Quote | null>(null);
  const [settle, setSettle] = useState("");
  const [refund, setRefund] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [created, setCreated] = useState<Order | null>(null);
  const [xmrAddr, setXmrAddr] = useState<string | null>(null);
  const [zecAddrs, setZecAddrs] = useState<ZecAddress[]>([]);

  // Agent hand-off: prefill from an approved propose_move.
  useEffect(() => {
    const a = handoff?.proposal.action;
    if (a && a.kind === "propose_move") {
      if (ASSETS.includes(a.from as Asset)) setFrom(a.from as Asset);
      if (ASSETS.includes(a.to as Asset)) setTo(a.to as Asset);
      if (a.amount) setAmount(String(a.amount));
    }
  }, [handoff]);

  const loadOrders = useCallback(async () => {
    if (!isTauri) return;
    try {
      setOrders(await invoke<Order[]>("exchange_orders"));
    } catch (e) {
      setErr(errMsg(e));
    }
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    invoke<ProviderInfo[]>("exchange_providers").then(setProviders).catch(() => {});
    loadOrders();
    if (treasury.xmrOpen) invoke<XmrBalance>("xmr_balance").then((b) => setXmrAddr(b.subaddresses.find((s) => !s.used && s.index > 0)?.address ?? b.subaddresses[0]?.address ?? null)).catch(() => {});
    if (treasury.zecReachable) invoke<ZecAddress[]>("zec_addresses").then(setZecAddrs).catch(() => {});
  }, [loadOrders, treasury.xmrOpen, treasury.zecReachable]);

  // Poll active orders.
  useEffect(() => {
    const t = setInterval(async () => {
      const act = orders.filter((o) => ACTIVE.has(o.status));
      for (const o of act.slice(0, 5)) {
        try {
          await invoke("exchange_refresh", { orderId: o.id });
        } catch {
          /* provider hiccup; try next tick */
        }
      }
      if (act.length) loadOrders();
    }, 30_000);
    return () => clearInterval(t);
  }, [orders, loadOrders]);

  // Prefill settle / refund addresses from wallets we know.
  useEffect(() => {
    const pick = (a: Asset): string => {
      if ((a === "SOL" || a === "USDC") && wallet.pubkey) return wallet.pubkey;
      if (a === "XMR" && xmrAddr) return xmrAddr;
      if (a === "ZEC") return zecAddrs.find((z) => !z.shielded)?.address ?? "";
      return "";
    };
    setSettle(pick(to));
    setRefund(pick(from));
  }, [from, to, wallet.pubkey, xmrAddr, zecAddrs]);

  const getQuotes = async () => {
    setBusy("quote");
    setErr(null);
    setSel(null);
    setCreated(null);
    try {
      const q = await invoke<Quote[]>("exchange_quotes", { from, to, amount: Number(amount) });
      setQuotes(q);
      if (!q.some((x) => x.ok)) toast("no provider returned a usable quote", "warn");
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    if (!sel) return;
    setBusy("create");
    setErr(null);
    try {
      const o = await invoke<Order>("exchange_create", {
        provider: sel.provider,
        from,
        to,
        amount: Number(amount),
        settleAddress: settle.trim(),
        refundAddress: refund.trim() || null,
        quoteRef: sel.quote_ref,
      });
      setCreated(o);
      toast(`order created on ${o.provider}`, "ok");
      if (handoff) {
        await invoke("agent_result", { id: handoff.proposal.id, ok: true, result: `exchange order ${o.id} (${o.provider})` });
        setHandoff(null);
      }
      loadOrders();
    } catch (e) {
      setErr(errMsg(e));
      if (handoff) {
        await invoke("agent_result", { id: handoff.proposal.id, ok: false, result: errMsg(e) }).catch(() => {});
        setHandoff(null);
      }
    } finally {
      setBusy(null);
    }
  };

  const refresh = async (id: string) => {
    setBusy(id);
    try {
      await invoke("exchange_refresh", { orderId: id });
      await loadOrders();
    } catch (e) {
      toast(errMsg(e), "err");
    } finally {
      setBusy(null);
    }
  };

  const fromUsd = useMemo(() => Number(amount) * (prices[from] ?? (from === "USDC" ? 1 : 0)), [amount, from, prices]);
  const warnings = useMemo(
    () => exchangeWarnings({ provider: sel?.provider ?? "the provider", from, to, net: { proxyEnabled: net.proxyEnabled, torReachable: net.torReachable, tunnelUp: net.tunnelUp }, kyc: sel?.kyc ?? null }),
    [sel, from, to, net],
  );

  if (!isTauri) {
    return <div className="view"><Banner tone="warn">Cross-chain routing runs through the desktop backend so provider traffic can be proxied. Not available in browser mode.</Banner></div>;
  }

  return (
    <div className="view">
      <Banner tone="or">
        <b>DISCLOSURE</b> Swap providers are third parties. They see your IP (unless Tor/VPN), deposit tx, settle address, amounts and timing, and may demand KYC under risk rules. Monero hides the sender side; the Solana and transparent-ZEC sides are public. This screen compares them; it cannot make them private.
      </Banner>
      {handoff && handoff.proposal.action.kind === "propose_move" && (
        <Banner tone="warn">Executing approved agent proposal: <b>{handoff.proposal.title}</b>. Creating an order will mark it executed. <Btn size="xs" variant="ghost" onClick={() => setHandoff(null)}>detach</Btn></Banner>
      )}
      <div className="row">
        <Panel title="Route" style={{ width: 380 }}>
          <div className="row">
            <Field label="from" className="grow"><Select value={from} onChange={(e) => setFrom(e.target.value as Asset)}>{ASSETS.map((a) => <option key={a}>{a}</option>)}</Select></Field>
            <Btn size="sm" style={{ marginTop: 14 }} onClick={() => { setFrom(to); setTo(from); }}>⇄</Btn>
            <Field label="to" className="grow"><Select value={to} onChange={(e) => setTo(e.target.value as Asset)}>{ASSETS.map((a) => <option key={a}>{a}</option>)}</Select></Field>
          </div>
          <Field label={`amount (${from})`} hint={fromUsd ? `≈ ${usd(fromUsd)}` : undefined}><Input mono value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Btn variant="primary" block busy={busy === "quote"} disabled={from === to || !(Number(amount) > 0)} onClick={getQuotes}>get quotes</Btn>
          <div className="hr" />
          <div className="dim xs up">providers</div>
          {providers.map((p) => (
            <div key={p.name} className="row ac small">
              <span style={{ width: 90 }}>{p.name}</span>
              {p.requires_key ? (p.has_key ? <Chip tone="ok">key set</Chip> : <Chip tone="warn">needs key</Chip>) : <Chip>no key needed</Chip>}
              <span className="dim xs ellipsis">{p.notes[0]}</span>
            </div>
          ))}
        </Panel>

        <Panel title="Quotes" className="grow" tight right={quotes.length ? <span className="dim xs">{quotes.filter((q) => q.ok).length}/{quotes.length} usable · sorted by output</span> : null}>
          <table className="tbl">
            <thead><tr><Th>provider</Th><Th num>rate</Th><Th num>you receive</Th><Th num>min</Th><Th num>max</Th><Th num>eta</Th><Th>kyc</Th><Th>type</Th><Th num>ms</Th><Th>status</Th></tr></thead>
            <tbody>
              {quotes.map((q) => (
                <tr key={q.provider + (q.quote_ref ?? "")} className={`click ${sel === q ? "sel" : ""}`} onClick={() => q.ok && setSel(q)}>
                  <Td>{q.provider}</Td>
                  <Td num>{q.rate != null ? fmt(q.rate, 6) : "-"}</Td>
                  <Td num><b>{q.amount_to != null ? `${fmt(q.amount_to, 6)} ${to}` : "-"}</b></Td>
                  <Td num className="dim">{q.min != null ? fmt(q.min, 4) : "-"}</Td>
                  <Td num className="dim">{q.max != null ? fmt(q.max, 2) : "-"}</Td>
                  <Td num className="dim">{q.eta_minutes != null ? `~${q.eta_minutes}m` : "-"}</Td>
                  <Td className="dim">{q.kyc ?? "-"}</Td>
                  <Td className="dim">{q.fixed ? "fixed" : "float"}</Td>
                  <Td num className="dim">{q.latency_ms}</Td>
                  <Td>{q.ok ? <Chip tone="ok">ok</Chip> : <span className={q.requires_key ? "warn" : "err"} title={q.error ?? ""}>{q.error ?? "failed"}</span>}</Td>
                </tr>
              ))}
              {!quotes.length && <tr><Td colSpan={10}><Empty>no quotes yet</Empty></Td></tr>}
            </tbody>
          </table>
          {sel && (
            <div style={{ padding: 8 }} className="col">
              {sel.notes.length > 0 && <div className="dim small">{sel.notes.map((n, i) => <div key={i}>· {n}</div>)}</div>}
              <Warnings items={warnings} />
              <div className="row">
                <Field label={`settle address (${to})`} className="grow" hint={to === "ZEC" ? "must be a transparent t1 address; shield afterwards" : to === "XMR" ? "fresh subaddress from VAULT recommended" : undefined}><Input mono value={settle} onChange={(e) => setSettle(e.target.value)} /></Field>
                <Field label={`refund address (${from})`} className="grow" hint="where the provider returns funds if the swap fails"><Input mono value={refund} onChange={(e) => setRefund(e.target.value)} /></Field>
              </div>
              <div className="row ac">
                <Btn variant="primary" busy={busy === "create"} disabled={!settle.trim()} onClick={create}>create order on {sel.provider}</Btn>
                <span className="dim small">You will then send exactly {amount} {from} to the deposit address shown. Nothing is sent automatically.</span>
              </div>
              <ErrLine e={err} />
            </div>
          )}
          {!sel && err && <div style={{ padding: 8 }}><ErrLine e={err} /></div>}
        </Panel>
      </div>

      {created && (
        <Panel title={`Order ${created.id.slice(0, 8)} · ${created.provider}`} right={<Chip tone="or">{created.status}</Chip>}>
          <Kv wrap items={[
            ["send", <b>{created.amount_from} {created.from_asset}</b>],
            ["to deposit address", <Addr value={created.deposit_address} full />],
            ...(created.deposit_memo ? ([["memo / extra id", <Addr value={created.deposit_memo} full />]] as [React.ReactNode, React.ReactNode][]) : []),
            ["you receive", created.amount_to ? `~${fmt(created.amount_to, 6)} ${created.to_asset}` : `${created.to_asset} (rate set on deposit)`],
            ["settle to", <Addr value={created.settle_address} full />],
            ["refund to", created.refund_address ? <Addr value={created.refund_address} full /> : <span className="warn">none - failed swaps cannot be refunded automatically</span>],
            ["provider ref", created.provider_id],
          ]} />
          {created.from_asset === "XMR" && <Banner tone="info">Send from VAULT › XMR › send. Use priority normal; providers usually need 10 confirmations.</Banner>}
          {created.from_asset === "ZEC" && <Banner tone="warn">Send from a transparent address in VAULT › ZEC. Shielded → provider sends are rejected by most providers.</Banner>}
        </Panel>
      )}

      <Panel title="Orders" tight right={<Btn size="xs" onClick={loadOrders}>refresh</Btn>}>
        <table className="tbl dense">
          <thead><tr><Th>created</Th><Th>provider</Th><Th>route</Th><Th num>in</Th><Th num>out</Th><Th>deposit</Th><Th>status</Th><Th>updated</Th><Th></Th></tr></thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <Td className="dim">{ts(o.ts)}</Td>
                <Td>{o.provider}</Td>
                <Td>{o.from_asset}→{o.to_asset}</Td>
                <Td num>{o.amount_from}</Td>
                <Td num>{o.amount_to ? fmt(o.amount_to, 6) : "-"}</Td>
                <Td><Addr value={o.deposit_address} /></Td>
                <Td><span className={o.status === "complete" ? "ok" : ["failed", "expired", "refunded"].includes(o.status) ? "err" : o.status === "review" ? "warn" : "or"}>{o.status}</span>{o.status === "refunded" && o.refund_address ? <span className="dim"> → refund addr</span> : null}{o.status === "failed" && !o.refund_address ? <span className="err"> · no refund addr: contact provider with ref {o.provider_id}</span> : null}</Td>
                <Td className="dim">{ago(o.updated)}</Td>
                <Td><Btn size="xs" busy={busy === o.id} onClick={() => refresh(o.id)}>poll</Btn></Td>
              </tr>
            ))}
            {!orders.length && <tr><Td colSpan={9}><Empty>no orders</Empty></Td></tr>}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
