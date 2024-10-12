import { useCallback, useEffect, useMemo, useState } from "react";
import { useApp } from "../lib/store";
import { invoke, isTauri } from "../lib/tauri";
import type { ProcStatus, SolLocalStatus, XmrBalance, XmrOutput, XmrPreparedTx, XmrStatus, XmrTransfer, XmrWalletOpened, ZecAddress, ZecBalance, ZecStatus, ZecTx } from "../lib/types";
import { ago, errMsg, fmt, short, ts, usd } from "../lib/format";
import { xmrNodeWarnings, xmrOutputWarnings, zecSendWarnings } from "../lib/privacy";
import { Addr, Banner, Btn, Chip, Dot, Empty, ErrLine, Field, Input, Kv, Modal, Panel, Select, Tabs, Td, TextArea, Th, Warnings } from "../components/ui";

type Tab = "xmr" | "zec" | "sol";

export default function Vault() {
  const [tab, setTab] = useState<Tab>("xmr");
  const { handoff } = useApp();
  useEffect(() => {
    if (handoff?.proposal.action.kind === "propose_shield") setTab("zec");
  }, [handoff]);
  if (!isTauri) {
    return <div className="view"><Banner tone="warn">Wallets run in the desktop backend (monero-wallet-rpc / zcashd processes, vault-encrypted Solana key). Browser mode has no vault.</Banner></div>;
  }
  return (
    <div className="view" style={{ padding: 0 }}>
      <Tabs tabs={[{ id: "xmr", label: "XMR · Monero" }, { id: "zec", label: "ZEC · Zcash", gold: true }, { id: "sol", label: "SOL signer" }]} active={tab} onChange={setTab} />
      <div className="view" style={{ paddingTop: 0 }}>
        {tab === "xmr" && <XmrTab />}
        {tab === "zec" && <ZecTab />}
        {tab === "sol" && <SolTab />}
      </div>
    </div>
  );
}

/* ====================================================================== MONERO */

function XmrTab() {
  const { settings, setSetting, prices, setTreasury, toast, vault } = useApp();
  const [st, setSt] = useState<XmrStatus | null>(null);
  const [wallets, setWallets] = useState<string[]>([]);
  const [bal, setBal] = useState<XmrBalance | null>(null);
  const [txs, setTxs] = useState<XmrTransfer[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [mode, setMode] = useState<"open" | "create" | "restore">("open");
  const [f, setF] = useState({ name: "", password: "", seed: "", height: "", offset: "" });
  const [opened, setOpened] = useState<XmrWalletOpened | null>(null);
  const [send, setSend] = useState({ address: "", amount: "", priority: "0" });
  const [prepared, setPrepared] = useState<XmrPreparedTx | null>(null);
  const [prepKind, setPrepKind] = useState<"send" | "churn">("send");
  const [outputs, setOutputs] = useState<XmrOutput[]>([]);
  const [sel, setSel] = useState<string[]>([]);
  const [showSpent, setShowSpent] = useState(false);
  const [seed, setSeed] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [daemon, setDaemon] = useState({ address: settings["monero.daemon_address"] ?? "", ssl: settings["monero.daemon_ssl"] ?? "autodetect", trusted: settings["monero.trusted_daemon"] === "true" });

  const load = useCallback(async () => {
    try {
      const s = await invoke<XmrStatus>("xmr_status");
      setSt(s);
      setWallets(await invoke<string[]>("xmr_wallet_list"));
      if (s.wallet && s.rpc_ok) {
        const b = await invoke<XmrBalance>("xmr_balance");
        setBal(b);
        setTreasury({ xmr: b.balance, xmrOpen: true });
        setTxs(await invoke<XmrTransfer[]>("xmr_transfers"));
        const outs = await invoke<XmrOutput[]>("xmr_outputs", { includeSpent: showSpent });
        setOutputs(outs);
        setSel((cur) => cur.filter((k) => outs.some((o) => o.key_image === k && !o.spent)));
      } else {
        setBal(null);
        setOutputs([]);
        setTreasury({ xmrOpen: false });
      }
      setErr(null);
    } catch (e) {
      setErr(errMsg(e));
    }
  }, [setTreasury, showSpent]);

  useEffect(() => {
    load();
    const t = setInterval(load, 12_000);
    return () => clearInterval(t);
  }, [load]);

  const run = async (k: string, fn: () => Promise<void>) => {
    setBusy(k);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(null);
      load();
    }
  };

  const openWallet = () =>
    run("open", async () => {
      let r: XmrWalletOpened;
      if (mode === "open") r = await invoke<XmrWalletOpened>("xmr_open", { name: f.name, password: f.password });
      else if (mode === "create") r = await invoke<XmrWalletOpened>("xmr_create", { name: f.name, password: f.password, language: "English" });
      else r = await invoke<XmrWalletOpened>("xmr_restore", { name: f.name, password: f.password, seed: f.seed, restoreHeight: f.height ? Number(f.height) : null, seedOffset: f.offset || null });
      setOpened(r);
      setF({ name: "", password: "", seed: "", height: "", offset: "" });
      toast(`wallet ${r.name} ${mode === "open" ? "opened" : mode === "create" ? "created" : "restored"}`, "ok");
    });

  const warnings = useMemo(() => (st ? xmrNodeWarnings({ daemonUrl: st.daemon_url, proxy: st.proxy, trusted: settings["monero.trusted_daemon"] === "true" }) : []), [st, settings]);
  const syncPct = st?.wallet_height && st.daemon_height ? Math.min(100, (st.wallet_height / st.daemon_height) * 100) : null;
  const price = prices.XMR ?? 0;
  const selected = useMemo(() => outputs.filter((o) => sel.includes(o.key_image)), [outputs, sel]);
  const selTotal = selected.reduce((s, o) => s + o.amount, 0);
  const selSpendable = selected.filter((o) => o.unlocked && !o.frozen).reduce((s, o) => s + o.amount, 0);
  const ccWarnings = useMemo(() => xmrOutputWarnings(selected, outputs), [selected, outputs]);
  const toggle = (k: string) => setSel((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));
  const fmtX = (n: number) => n.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");

  const prepareSend = () =>
    run("prep", async () => {
      const args = { address: send.address.trim(), amount: send.amount.trim(), priority: Number(send.priority) };
      const tx = sel.length
        ? await invoke<XmrPreparedTx>("xmr_prepare_transfer_from", { ...args, keyImages: sel })
        : await invoke<XmrPreparedTx>("xmr_prepare_transfer", args);
      setPrepKind("send");
      setPrepared(tx);
    });

  const prepareChurn = (ki: string) =>
    run("churn", async () => {
      const tx = await invoke<XmrPreparedTx>("xmr_prepare_churn", { keyImage: ki, priority: Number(send.priority) });
      setPrepKind("churn");
      setPrepared(tx);
    });

  const setFrozen = (kis: string[], frozen: boolean) =>
    run(frozen ? "freeze" : "thaw", async () => {
      for (const ki of kis) await invoke("xmr_freeze", { keyImage: ki, frozen });
      toast(`${kis.length} output(s) ${frozen ? "frozen" : "thawed"}`, "ok");
    });

  return (
    <>
      <ErrLine e={err} />
      <div className="row">
        <Panel title="monero-wallet-rpc" style={{ width: 430 }} right={<Chip tone={st?.rpc_ok ? "ok" : st?.process.running ? "warn" : "err"}>{st?.rpc_ok ? "rpc up" : st?.process.running ? "starting" : "stopped"}</Chip>}>
          <Kv wrap items={[
            ["binary", st?.binary || <span className="warn">not set → SETTINGS › Monero</span>],
            ["pid", st?.process.pid ?? "-"],
            ["version", st?.rpc_version ? `0x${st.rpc_version.toString(16)}` : "-"],
            ["wallet dir", st?.wallet_dir ?? "-"],
            ["proxy", st?.proxy ? <span className="ok">{st.proxy}</span> : <span className="muted">none</span>],
          ]} />
          <div className="row">
            {!st?.process.running ? <Btn variant="primary" busy={busy === "start"} disabled={!st?.binary} onClick={() => run("start", () => invoke<ProcStatus>("xmr_start").then(() => {}))}>start wallet-rpc</Btn> : <Btn variant="danger" busy={busy === "stop"} onClick={() => run("stop", () => invoke("xmr_stop").then(() => {}))}>stop</Btn>}
            <Btn size="sm" variant="ghost" onClick={() => invoke<string>("proc_log", { name: "monero-wallet-rpc", lines: 60 }).then((l) => setErr(l || "(empty log)"))}>log</Btn>
          </div>
          <div className="dim xs">Spawned on 127.0.0.1 with a random per-session digest login. Wallet files are encrypted by monero-wallet-rpc with the wallet password you choose.</div>
        </Panel>
        <Panel title="Daemon (node)" className="grow" right={<span className="dim xs">{st?.daemon_nettype ?? ""}</span>}>
          <Kv items={[
            ["url", st?.daemon_url ?? "-"],
            ["height", st?.daemon_height ? <span>{st.daemon_height.toLocaleString()} {st.daemon_synced ? <Chip tone="ok">synced</Chip> : <Chip tone="warn">syncing → {st.daemon_target?.toLocaleString()}</Chip>}</span> : <span className="err">{st?.daemon_error ?? "unreachable"}</span>],
            ["wallet height", st?.wallet_height ? <span>{st.wallet_height.toLocaleString()} {syncPct != null && <span className={syncPct > 99.9 ? "ok" : "warn"}>({syncPct.toFixed(2)}%)</span>}</span> : "-"],
          ]} />
          <div className="row ac">
            <Field label="daemon host:port" className="grow"><Input mono value={daemon.address} onChange={(e) => setDaemon({ ...daemon, address: e.target.value })} /></Field>
            <Field label="ssl" style={{ width: 110 }}><Select value={daemon.ssl} onChange={(e) => setDaemon({ ...daemon, ssl: e.target.value })}><option>autodetect</option><option>enabled</option><option>disabled</option></Select></Field>
            <label className="chk" style={{ marginTop: 14 }}><input type="checkbox" checked={daemon.trusted} onChange={(e) => setDaemon({ ...daemon, trusted: e.target.checked })} />trusted</label>
            <Btn size="sm" style={{ marginTop: 14 }} busy={busy === "daemon"} onClick={() => run("daemon", async () => { await invoke("xmr_set_daemon", daemon); await setSetting("monero.daemon_address", daemon.address); await setSetting("monero.daemon_ssl", daemon.ssl); await setSetting("monero.trusted_daemon", String(daemon.trusted)); })}>apply</Btn>
          </div>
          <Warnings items={warnings} compact />
        </Panel>
      </div>

      {st?.rpc_ok && !st.wallet && (
        <Panel title="Wallet">
          <Tabs tabs={[{ id: "open", label: "open" }, { id: "create", label: "create" }, { id: "restore", label: "restore from seed" }]} active={mode} onChange={setMode} />
          <div className="row ac wrap">
            {mode === "open" ? (
              <Field label="wallet" style={{ width: 220 }}>
                <Select value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })}><option value="">select…</option>{wallets.map((w) => <option key={w}>{w}</option>)}</Select>
              </Field>
            ) : (
              <Field label="wallet name" style={{ width: 220 }}><Input mono value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="treasury" /></Field>
            )}
            <Field label="wallet password" style={{ width: 220 }}><Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} onKeyDown={(e) => e.key === "Enter" && mode !== "restore" && openWallet()} /></Field>
            {mode === "restore" && (
              <>
                <Field label="restore height (block or 0)" style={{ width: 160 }}><Input mono value={f.height} onChange={(e) => setF({ ...f, height: e.target.value })} placeholder="0" /></Field>
                <Field label="seed offset (optional)" style={{ width: 160 }}><Input type="password" value={f.offset} onChange={(e) => setF({ ...f, offset: e.target.value })} /></Field>
              </>
            )}
            <Btn variant="primary" style={{ marginTop: 14 }} busy={busy === "open"} disabled={!f.name || !f.password || (mode === "restore" && !f.seed)} onClick={openWallet}>{mode}</Btn>
          </div>
          {mode === "restore" && <Field label="25-word mnemonic seed" hint="Typed here, sent only to the local monero-wallet-rpc process over loopback. Never stored by Moneyero."><TextArea rows={3} value={f.seed} onChange={(e) => setF({ ...f, seed: e.target.value })} /></Field>}
          {!wallets.length && mode === "open" && <Empty>no wallets in {st.wallet_dir}</Empty>}
        </Panel>
      )}

      {st?.wallet && bal && (
        <>
          <div className="row">
            <Panel title={`Balance · ${st.wallet}`} style={{ width: 430 }} right={<Btn size="xs" busy={busy === "refresh"} onClick={() => run("refresh", () => invoke("xmr_refresh").then(() => {}))}>refresh</Btn>}>
              <div className="big or">{bal.balance.toFixed(12).replace(/0+$/, "").replace(/\.$/, "")} <span className="med muted">XMR</span></div>
              <Kv items={[
                ["unlocked", <span>{bal.unlocked.toFixed(12).replace(/0+$/, "").replace(/\.$/, "")} XMR{bal.blocks_to_unlock > 0 && <span className="warn"> · {bal.blocks_to_unlock} blocks to unlock</span>}</span>],
                ["value", price ? usd(bal.balance * price) : "-"],
                ["atomic", bal.balance_atomic],
              ]} />
              <div className="row">
                <Btn size="sm" variant="ghost" onClick={() => run("close", () => invoke("xmr_close").then(() => { setOpened(null); setSeed(null); }))}>close wallet</Btn>
                <Btn size="sm" variant="ghost" busy={busy === "rescan"} onClick={() => run("rescan", () => invoke("xmr_rescan", { hard: false }).then(() => {}))}>rescan</Btn>
                <Btn size="sm" variant="ghost" disabled={!vault?.unlocked} title={vault?.unlocked ? "" : "unlock vault first"} onClick={() => run("seed", async () => setSeed(await invoke<string>("xmr_seed")))}>show seed</Btn>
              </div>
            </Panel>
            <Panel title="Send" className="grow">
              <div className="row">
                <Field label="destination address" className="grow"><Input mono value={send.address} onChange={(e) => setSend({ ...send, address: e.target.value })} placeholder="4… / 8…" /></Field>
                <Field label="amount XMR" style={{ width: 160 }}><Input mono value={send.amount} onChange={(e) => setSend({ ...send, amount: e.target.value })} /></Field>
                <Field label="priority" style={{ width: 120 }}><Select value={send.priority} onChange={(e) => setSend({ ...send, priority: e.target.value })}><option value="0">default</option><option value="1">unimportant</option><option value="2">normal</option><option value="3">elevated</option><option value="4">priority</option></Select></Field>
                <Btn variant="primary" style={{ marginTop: 14 }} busy={busy === "prep"} disabled={!send.address || !send.amount} onClick={prepareSend}>prepare</Btn>
              </div>
              <div className="dim xs">Two-step: the wallet constructs the ring-signature transaction locally and shows the exact fee. Nothing is broadcast until you confirm.</div>
              {sel.length > 0 && (
                <Banner tone="or">
                  <b>COIN CONTROL</b> this send may only spend the {sel.length} selected output{sel.length > 1 ? "s" : ""} ({fmtX(selSpendable)} XMR spendable). Every other output is frozen while the transaction is built, then thawed.{" "}
                  <span className="addr" onClick={() => setSel([])}>clear selection</span>
                </Banner>
              )}
              {(sel.length ? selSpendable : bal.unlocked) < Number(send.amount || 0) && Number(send.amount) > 0 && <Banner tone="warn">amount exceeds {sel.length ? "the selected spendable outputs" : "unlocked balance"} (fee comes on top)</Banner>}
            </Panel>
          </div>

          <div className="row">
            <Panel title="Receive · subaddresses" className="grow" tight right={<span className="row ac"><Input placeholder="label" value={label} onChange={(e) => setLabel(e.target.value)} style={{ width: 140 }} /><Btn size="xs" variant="primary" busy={busy === "sub"} onClick={() => run("sub", () => invoke("xmr_new_subaddress", { label }).then(() => setLabel("")))}>new subaddress</Btn></span>}>
              <table className="tbl dense">
                <thead><tr><Th num>#</Th><Th>address</Th><Th>label</Th><Th num>balance</Th><Th num>unlocked</Th><Th>used</Th></tr></thead>
                <tbody>
                  {bal.subaddresses.map((s) => (
                    <tr key={s.index}>
                      <Td num className="dim">{s.index}</Td>
                      <Td><Addr value={s.address} head={12} tail={12} /></Td>
                      <Td className="muted">{s.label || (s.index === 0 ? "primary" : "")}</Td>
                      <Td num>{s.balance ? s.balance.toFixed(6) : ""}</Td>
                      <Td num>{s.unlocked ? s.unlocked.toFixed(6) : ""}</Td>
                      <Td>{s.used ? <Chip tone="warn">used</Chip> : <Chip tone="ok">fresh</Chip>}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ padding: 6 }} className="dim xs">Give every counterparty a fresh subaddress. Reuse links payments together for whoever sees both.</div>
            </Panel>
          </div>

          <Panel
            title={<span>Coin control · outputs <span className="dim">· {outputs.filter((o) => !o.spent).length} unspent</span></span>}
            tight
            right={
              <span className="row ac">
                <label className="chk xs"><input type="checkbox" checked={showSpent} onChange={(e) => setShowSpent(e.target.checked)} />show spent</label>
                <Btn size="xs" disabled={!sel.length} busy={busy === "freeze"} onClick={() => setFrozen(sel.filter((k) => outputs.find((o) => o.key_image === k && !o.frozen)), true)}>freeze selected</Btn>
                <Btn size="xs" disabled={!sel.length} busy={busy === "thaw"} onClick={() => setFrozen(sel.filter((k) => outputs.find((o) => o.key_image === k && o.frozen)), false)}>thaw selected</Btn>
                <Btn size="xs" variant="ghost" disabled={!sel.length} onClick={() => setSel([])}>clear</Btn>
              </span>
            }
          >
            <table className="tbl dense">
              <thead><tr><Th w={24}></Th><Th num>amount</Th><Th>sub</Th><Th num>height</Th><Th num>conf</Th><Th>state</Th><Th>received in</Th><Th>key image</Th><Th></Th></tr></thead>
              <tbody>
                {outputs.map((o) => {
                  const on = sel.includes(o.key_image);
                  return (
                    <tr key={o.key_image} className={`click ${on ? "sel" : ""}`} onClick={() => !o.spent && toggle(o.key_image)}>
                      <Td><input type="checkbox" checked={on} disabled={o.spent} onChange={() => toggle(o.key_image)} onClick={(e) => e.stopPropagation()} /></Td>
                      <Td num className={o.spent ? "dim" : o.amount < 0.0005 ? "warn" : ""}>{fmtX(o.amount)}</Td>
                      <Td className="muted">{o.subaddr_index}</Td>
                      <Td num className="dim">{o.height || "pool"}</Td>
                      <Td num className="dim">{o.confirmations}</Td>
                      <Td>
                        {o.spent ? <Chip>spent</Chip> : o.frozen ? <Chip tone="or">frozen</Chip> : o.unlocked ? <Chip tone="ok">spendable</Chip> : <Chip tone="warn">locked</Chip>}
                      </Td>
                      <Td><Addr value={o.tx_hash} /></Td>
                      <Td><Addr value={o.key_image} /></Td>
                      <Td>
                        {!o.spent && (
                          <span className="row" onClick={(e) => e.stopPropagation()}>
                            <Btn size="xs" variant="ghost" busy={busy === "freeze" || busy === "thaw"} onClick={() => setFrozen([o.key_image], !o.frozen)}>{o.frozen ? "thaw" : "freeze"}</Btn>
                            <Btn size="xs" variant="ghost" disabled={!o.unlocked || o.frozen} title="sweep this output alone to a fresh subaddress of this wallet" busy={busy === "churn"} onClick={() => prepareChurn(o.key_image)}>churn</Btn>
                          </span>
                        )}
                      </Td>
                    </tr>
                  );
                })}
                {!outputs.length && <tr><Td colSpan={9}><Empty>no outputs yet</Empty></Td></tr>}
              </tbody>
            </table>
            <div style={{ padding: 6 }}>
              {sel.length > 0 && <div className="small" style={{ marginBottom: 6 }}>selected <span className="or">{sel.length}</span> · {fmtX(selTotal)} XMR{selSpendable !== selTotal && <span className="dim"> ({fmtX(selSpendable)} spendable now)</span>} · the Send panel will spend only these</div>}
              <Warnings items={ccWarnings} compact />
              <div className="dim xs" style={{ marginTop: 6 }}>
                Each row is one output the wallet owns. <b>Freeze</b> keeps an output out of every future transaction until you thaw it: use it for unsolicited dust or anything you do not want mixed with the rest. <b>Churn</b> sends one output to yourself, so the coin's next spend no longer shares an input with how it arrived. Selecting rows limits the next send to exactly those outputs.
              </div>
            </div>
          </Panel>

          <Panel title="Transfers" tight>
            <table className="tbl dense">
              <thead><tr><Th>time</Th><Th>type</Th><Th num>amount</Th><Th num>fee</Th><Th num>conf</Th><Th>txid</Th><Th>sub</Th><Th>note</Th></tr></thead>
              <tbody>
                {txs.map((t) => (
                  <tr key={t.txid + t.kind}>
                    <Td className="dim">{ts(t.timestamp)}</Td>
                    <Td className={t.kind === "in" ? "ok" : t.kind === "out" ? "or" : t.kind === "failed" ? "err" : "warn"}>{t.kind}{t.locked ? " (locked)" : ""}</Td>
                    <Td num>{t.kind === "out" ? "-" : "+"}{t.amount.toFixed(6)}</Td>
                    <Td num className="dim">{t.fee ? t.fee.toFixed(6) : ""}</Td>
                    <Td num className="dim">{t.confirmations}</Td>
                    <Td><Addr value={t.txid} /></Td>
                    <Td className="dim">{t.subaddr_index}</Td>
                    <Td className="dim">{t.note}</Td>
                  </tr>
                ))}
                {!txs.length && <tr><Td colSpan={8}><Empty>no transfers (wallet may still be scanning)</Empty></Td></tr>}
              </tbody>
            </table>
          </Panel>
        </>
      )}

      {prepared && (
        <Modal title={prepKind === "churn" ? "Confirm churn (send to yourself)" : "Confirm Monero transfer"} onClose={() => setPrepared(null)}>
          {prepKind === "churn" && <Banner tone="or">The whole output goes to a fresh subaddress of this wallet. Nothing leaves your control; you pay the network fee only.</Banner>}
          {prepKind === "send" && sel.length > 0 && <Banner tone="or">Built from the {sel.length} selected output{sel.length > 1 ? "s" : ""} only.</Banner>}
          <Kv wrap items={[["to", <Addr value={prepared.destination} full />], ["amount", `${prepared.amount.toFixed(12)} XMR`], ["fee", <span className="or">{prepared.fee.toFixed(12)} XMR</span>], ["total", `${(prepared.amount + prepared.fee).toFixed(12)} XMR`], ["tx hash", prepared.tx_hash]]} />
          <div className="row mt8">
            <Btn variant="primary" busy={busy === "relay"} onClick={() => run("relay", async () => { const h = await invoke<string>("xmr_relay", { txMetadata: prepared.tx_metadata, note: prepKind === "churn" ? "churn" : null }); toast(`relayed ${short(h)}`, "ok"); setPrepared(null); setSel([]); if (prepKind === "send") setSend({ address: "", amount: "", priority: "0" }); })}>broadcast</Btn>
            <Btn variant="ghost" onClick={() => setPrepared(null)}>cancel</Btn>
          </div>
        </Modal>
      )}
      {(opened?.seed || seed) && (
        <Modal title="Mnemonic seed — write it down, then close" onClose={() => { setOpened(null); setSeed(null); }}>
          <Banner tone="err">Anyone with these 25 words controls the funds. Never type them into a website, a chat, or this agent. Moneyero does not store them.</Banner>
          <div className="seed">{(opened?.seed ?? seed ?? "").split(/\s+/).map((w, i) => <span key={i}><i>{i + 1}</i>{w}</span>)}</div>
          {opened?.restore_height != null && <div className="dim small mt4">restore height: {opened.restore_height} (note it; speeds up future restores)</div>}
        </Modal>
      )}
    </>
  );
}

/* ====================================================================== ZCASH */

const POLICIES = ["FullPrivacy", "AllowRevealedAmounts", "AllowRevealedRecipients", "AllowRevealedSenders", "AllowFullyTransparent", "NoPrivacy"];

function ZecTab() {
  const { settings, prices, setTreasury, toast, vault, handoff, setHandoff } = useApp();
  const [st, setSt] = useState<ZecStatus | null>(null);
  const [bal, setBal] = useState<ZecBalance | null>(null);
  const [addrs, setAddrs] = useState<ZecAddress[]>([]);
  const [txs, setTxs] = useState<ZecTx[]>([]);
  const [ops, setOps] = useState<{ id: string; status: string; method?: string; result?: { txid?: string }; error?: { message?: string }; creation_time?: number }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [send, setSend] = useState({ from: "", to: "", amount: "", memo: "", policy: settings["zcash.default_privacy_policy"] ?? "FullPrivacy" });
  const [newKind, setNewKind] = useState("unified");
  const [impKey, setImpKey] = useState("");
  const [vk, setVk] = useState<string | null>(null);
  const [shieldTo, setShieldTo] = useState("");

  const load = useCallback(async () => {
    try {
      const s = await invoke<ZecStatus>("zec_status");
      setSt(s);
      if (s.reachable) {
        const [b, a, t, o] = await Promise.all([
          invoke<ZecBalance>("zec_balance"),
          invoke<ZecAddress[]>("zec_addresses"),
          invoke<ZecTx[]>("zec_transactions").catch(() => [] as ZecTx[]),
          invoke<typeof ops>("zec_operations").catch(() => []),
        ]);
        setBal(b);
        setAddrs(a);
        setTxs(t);
        setOps(Array.isArray(o) ? o : []);
        setTreasury({ zec: b.total, zecTransparent: b.transparent, zecReachable: true });
      } else {
        setTreasury({ zecReachable: false });
      }
      setErr(null);
    } catch (e) {
      setErr(errMsg(e));
    }
  }, [setTreasury]);

  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!send.from && addrs.length) setSend((s) => ({ ...s, from: addrs.find((a) => a.shielded)?.address ?? addrs[0].address }));
    if (!shieldTo && addrs.length) setShieldTo(addrs.find((a) => a.pool === "unified")?.address ?? addrs.find((a) => a.shielded)?.address ?? "");
  }, [addrs, send.from, shieldTo]);

  const run = async (k: string, fn: () => Promise<void>) => {
    setBusy(k);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(null);
      load();
    }
  };

  const fromAddr = addrs.find((a) => a.address === send.from);
  const toShielded = /^(zs|u1|ztestsapling|utest)/.test(send.to.trim());
  const sendWarnings = useMemo(() => (send.to ? zecSendWarnings({ fromShielded: !!fromAddr?.shielded, toShielded, policy: send.policy }) : []), [send.to, send.policy, fromAddr, toShielded]);
  const price = prices.ZEC ?? 0;
  const progress = st?.verification_progress != null ? st.verification_progress * 100 : null;

  return (
    <>
      <ErrLine e={err} />
      {handoff?.proposal.action.kind === "propose_shield" && <Banner tone="warn">Executing approved agent proposal: <b>{handoff.proposal.title}</b>. <Btn size="xs" variant="ghost" onClick={() => setHandoff(null)}>detach</Btn></Banner>}
      <div className="row">
        <Panel title="Zcash node" gold style={{ width: 430 }} right={<Chip tone={st?.reachable ? "ok" : "err"}>{st?.reachable ? `${st.backend} rpc up` : "unreachable"}</Chip>}>
          <Kv wrap items={[
            ["rpc", st?.rpc_url ?? "-"],
            ["chain", st?.chain ?? "-"],
            ["blocks", st?.blocks != null ? <span>{st.blocks.toLocaleString()} / {st.headers?.toLocaleString()} {progress != null && <span className={progress > 99.99 ? "ok" : "warn"}>({progress.toFixed(2)}%)</span>}</span> : "-"],
            ["process", st?.process.running ? <span className="ok">managed pid {st.process.pid}</span> : <span className="muted">external / not running</span>],
            ["error", st?.error ? <span className="err">{st.error}</span> : "-"],
          ]} />
          <div className="row">
            {!st?.process.running ? <Btn size="sm" busy={busy === "nstart"} disabled={!settings["zcash.binary_path"]} title={settings["zcash.binary_path"] ? "" : "set zcash.binary_path in SETTINGS"} onClick={() => run("nstart", () => invoke("zec_node_start").then(() => {}))}>start node</Btn> : <Btn size="sm" variant="danger" busy={busy === "nstop"} onClick={() => run("nstop", () => invoke("zec_node_stop").then(() => {}))}>stop node</Btn>}
            <Btn size="sm" variant="ghost" onClick={() => invoke<string>("proc_log", { name: "zcash-node", lines: 60 }).then((l) => setErr(l || "(empty log)"))}>log</Btn>
          </div>
          <div className="dim xs">Full-node wallet (zcashd or its successor zallet) holds the keys. Moneyero speaks JSON-RPC to it over loopback. Initial sync of a full node takes days; see docs/BLOCKERS.md for the light-client status.</div>
        </Panel>
        <Panel title="Balance" gold className="grow" right={bal && bal.transparent > 0 ? <Chip tone="warn">{bal.transparent.toFixed(4)} ZEC exposed</Chip> : null}>
          {bal ? (
            <div className="row gap12">
              <div>
                <div className="dim xs up">shielded</div>
                <div className="big gold">{bal.shielded.toFixed(8)}</div>
                <div className="dim small">{bal.pools.filter((p) => p.shielded).map((p) => `${p.pool} ${p.zec.toFixed(6)}`).join(" · ") || "sapling + orchard"}</div>
              </div>
              <div>
                <div className="dim xs up">transparent</div>
                <div className={`big ${bal.transparent > 0 ? "warn" : "muted"}`}>{bal.transparent.toFixed(8)}</div>
                <div className="dim small">public, like Bitcoin</div>
              </div>
              <div>
                <div className="dim xs up">total</div>
                <div className="big">{bal.total.toFixed(8)}</div>
                <div className="dim small">{price ? usd(bal.total * price) : "-"}</div>
              </div>
            </div>
          ) : <Empty>node offline</Empty>}
          {bal && bal.transparent > 0 && (
            <div className="row ac">
              <Field label="shield everything transparent into" className="grow"><Select value={shieldTo} onChange={(e) => setShieldTo(e.target.value)}>{addrs.filter((a) => a.shielded).map((a) => <option key={a.address} value={a.address}>{a.pool} {short(a.address, 10, 8)}</option>)}</Select></Field>
              <Btn variant="gold" style={{ marginTop: 14 }} busy={busy === "shield"} disabled={!shieldTo} onClick={() => run("shield", async () => { const r = await invoke<{ opid?: string }>("zec_shield_transparent", { to: shieldTo }); toast(`shielding queued ${r.opid ?? ""}`, "ok"); if (handoff?.proposal.action.kind === "propose_shield") { await invoke("agent_result", { id: handoff.proposal.id, ok: true, result: `z_mergetoaddress ${r.opid ?? ""}` }); setHandoff(null); } })}>shield all</Btn>
            </div>
          )}
        </Panel>
      </div>

      {st?.reachable && (
        <>
          <div className="row">
            <Panel title="Addresses" gold className="grow" tight right={<span className="row ac"><Select value={newKind} onChange={(e) => setNewKind(e.target.value)} style={{ width: 130 }}><option value="unified">unified (u1)</option><option value="sapling">sapling (zs)</option><option value="transparent">transparent (t1)</option></Select><Btn size="xs" variant="gold" busy={busy === "newaddr"} onClick={() => run("newaddr", () => invoke("zec_new_address", { kind: newKind }).then(() => {}))}>new</Btn></span>}>
              <table className="tbl dense">
                <thead><tr><Th>pool</Th><Th>address</Th><Th>receivers</Th><Th num>balance</Th><Th></Th></tr></thead>
                <tbody>
                  {addrs.map((a) => (
                    <tr key={a.address}>
                      <Td>{a.shielded ? <Chip tone="gold">{a.pool}</Chip> : <Chip tone="warn">transparent</Chip>}</Td>
                      <Td><Addr value={a.address} head={14} tail={10} /></Td>
                      <Td className="dim">{a.receiver_types.join(",")}</Td>
                      <Td num>{a.balance ? a.balance.toFixed(8) : ""}</Td>
                      <Td>{a.shielded && <Btn size="xs" variant="ghost" disabled={!vault?.unlocked} onClick={() => run("vk", async () => setVk(await invoke<string>("zec_export_viewing_key", { address: a.address })))}>view key</Btn>}</Td>
                    </tr>
                  ))}
                  {!addrs.length && <tr><Td colSpan={5}><Empty>no addresses - create a unified address</Empty></Td></tr>}
                </tbody>
              </table>
            </Panel>
            <Panel title="Send" gold style={{ width: 560 }}>
              <Field label="from"><Select value={send.from} onChange={(e) => setSend({ ...send, from: e.target.value })}>{addrs.map((a) => <option key={a.address} value={a.address}>{a.shielded ? "[shielded]" : "[TRANSPARENT]"} {short(a.address, 12, 8)} {a.balance ? `· ${a.balance.toFixed(4)}` : ""}</option>)}<option value="ANY_TADDR">ANY_TADDR (all transparent)</option></Select></Field>
              <Field label="to"><Input mono value={send.to} onChange={(e) => setSend({ ...send, to: e.target.value })} placeholder="u1… / zs… / t1…" /></Field>
              <div className="row">
                <Field label="amount ZEC" className="grow"><Input mono value={send.amount} onChange={(e) => setSend({ ...send, amount: e.target.value })} /></Field>
                <Field label="privacy policy" className="grow"><Select value={send.policy} onChange={(e) => setSend({ ...send, policy: e.target.value })}>{POLICIES.map((p) => <option key={p}>{p}</option>)}</Select></Field>
              </div>
              <Field label="memo (shielded only, 512 bytes)"><Input value={send.memo} onChange={(e) => setSend({ ...send, memo: e.target.value })} disabled={!toShielded} /></Field>
              <Warnings items={sendWarnings} compact />
              <Btn variant="gold" busy={busy === "send"} disabled={!send.to || !send.amount} onClick={() => run("send", async () => { const op = await invoke<string>("zec_send", { from: send.from, to: send.to.trim(), amount: send.amount, memo: send.memo || null, privacyPolicy: send.policy }); toast(`queued ${op}`, "ok"); setSend({ ...send, to: "", amount: "", memo: "" }); })}>send (z_sendmany)</Btn>
            </Panel>
          </div>

          {ops.length > 0 && (
            <Panel title="Async operations" gold tight>
              <table className="tbl dense">
                <thead><tr><Th>opid</Th><Th>method</Th><Th>status</Th><Th>txid / error</Th><Th>created</Th></tr></thead>
                <tbody>
                  {ops.slice().reverse().slice(0, 15).map((o) => (
                    <tr key={o.id}>
                      <Td className="dim">{short(o.id, 10, 6)}</Td>
                      <Td>{o.method}</Td>
                      <Td className={o.status === "success" ? "ok" : o.status === "failed" ? "err" : "warn"}>{o.status}</Td>
                      <Td>{o.result?.txid ? <Addr value={o.result.txid} /> : <span className="err">{o.error?.message}</span>}</Td>
                      <Td className="dim">{o.creation_time ? ago(o.creation_time) + " ago" : ""}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          )}

          <div className="row">
            <Panel title="Transactions" gold className="grow" tight>
              <table className="tbl dense">
                <thead><tr><Th>time</Th><Th>pool</Th><Th>kind</Th><Th num>amount</Th><Th>address</Th><Th>memo</Th><Th num>conf</Th><Th>txid</Th></tr></thead>
                <tbody>
                  {txs.map((t, i) => (
                    <tr key={t.txid + i}>
                      <Td className="dim">{ts(t.time)}</Td>
                      <Td>{t.pool === "transparent" ? <span className="warn">t</span> : <span className="gold">{t.pool}</span>}</Td>
                      <Td className="muted">{t.kind}</Td>
                      <Td num>{t.amount}</Td>
                      <Td><Addr value={t.address} /></Td>
                      <Td className="dim" title={t.memo ?? ""}>{t.memo ? (t.memo.length > 40 ? `${t.memo.slice(0, 40)}…` : t.memo) : ""}</Td>
                      <Td num className="dim">{t.confirmations}</Td>
                      <Td><Addr value={t.txid} /></Td>
                    </tr>
                  ))}
                  {!txs.length && <tr><Td colSpan={8}><Empty>none</Empty></Td></tr>}
                </tbody>
              </table>
            </Panel>
            <Panel title="Restore / import" gold style={{ width: 460 }}>
              <div className="dim small">Full wallet restore from a mnemonic happens in the node itself (zcashd: wallet.dat; zallet: <code>zallet import-mnemonic</code>). Individual keys can be imported here; they go straight to the node over loopback.</div>
              <Field label="spending key (secret-extended-key-main…), viewing key, or WIF t-key"><Input type="password" value={impKey} onChange={(e) => setImpKey(e.target.value)} /></Field>
              <div className="row">
                <Btn size="sm" variant="gold" busy={busy === "imp"} disabled={!impKey} onClick={() => run("imp", async () => { await invoke("zec_import_key", { key: impKey, rescan: true }); setImpKey(""); toast("key imported; node rescanning", "ok"); })}>import + rescan</Btn>
                <Btn size="sm" variant="ghost" busy={busy === "imp2"} disabled={!impKey} onClick={() => run("imp2", async () => { await invoke("zec_import_key", { key: impKey, rescan: false }); setImpKey(""); })}>import (no rescan)</Btn>
              </div>
            </Panel>
          </div>
        </>
      )}
      {vk && (
        <Modal title="Viewing key (read-only access to this address)" onClose={() => setVk(null)}>
          <Banner tone="warn">A viewing key reveals all incoming transactions and memos of the address to whoever holds it. It cannot spend.</Banner>
          <pre className="seed">{vk}</pre>
        </Modal>
      )}
    </>
  );
}

/* ====================================================================== SOL SIGNER */

function SolTab() {
  const { vault, setWallet, toast } = useApp();
  const [st, setSt] = useState<SolLocalStatus | null>(null);
  const [imp, setImp] = useState("");
  const [exported, setExported] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);

  const load = useCallback(() => invoke<SolLocalStatus>("sol_local_status").then(setSt).catch((e) => setErr(errMsg(e))), []);
  useEffect(() => {
    load();
  }, [load]);

  const act = async (fn: () => Promise<void>) => {
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      load();
    }
  };

  return (
    <div className="row">
      <Panel title="Local Solana signer" style={{ width: 560 }} right={<Chip tone={st?.exists ? "ok" : "warn"}>{st?.exists ? "present" : "none"}</Chip>}>
        <div className="small muted">Desktop webviews cannot load the Phantom extension, so the desktop build signs with a key held in the vault (Argon2id + XChaCha20-Poly1305). Signing happens in Rust; the key never enters the UI. Phantom remains available when the UI runs in a browser.</div>
        <ErrLine e={err} />
        <Kv wrap items={[["pubkey", st?.pubkey ? <Addr value={st.pubkey} full /> : "-"], ["vault", vault?.unlocked ? <span className="ok">unlocked</span> : <span className="warn">locked (unlock in SETTINGS to create/sign)</span>]]} />
        {!st?.exists ? (
          <>
            <div className="row">
              <Btn variant="primary" disabled={!vault?.unlocked} onClick={() => act(async () => { const pk = await invoke<string>("sol_local_create"); toast(`signer created ${short(pk)}`, "ok"); })}>generate new keypair</Btn>
            </div>
            <Field label="or import secret key (base58 or solana-keygen JSON array)"><Input type="password" value={imp} onChange={(e) => setImp(e.target.value)} /></Field>
            <Btn size="sm" disabled={!vault?.unlocked || !imp} onClick={() => act(async () => { await invoke("sol_local_import", { secret: imp }); setImp(""); toast("signer imported", "ok"); })}>import</Btn>
          </>
        ) : (
          <div className="row wrap">
            <Btn variant="primary" disabled={!vault?.unlocked} onClick={() => act(async () => { setWallet({ kind: "local", pubkey: st.pubkey }); toast("local signer selected for TERMINAL", "ok"); })}>use in terminal</Btn>
            <Btn variant="ghost" disabled={!vault?.unlocked} onClick={() => act(async () => setExported(await invoke<string>("sol_local_export")))}>export (backup)</Btn>
            {!confirmDel ? <Btn variant="danger" disabled={!vault?.unlocked} onClick={() => setConfirmDel(true)}>delete</Btn> : <Btn variant="danger" onClick={() => act(async () => { await invoke("sol_local_delete"); setConfirmDel(false); setWallet({ kind: null, pubkey: null }); })}>confirm delete (irreversible)</Btn>}
          </div>
        )}
      </Panel>
      {exported && (
        <Modal title="Secret key (base58, 64 bytes)" onClose={() => setExported(null)}>
          <Banner tone="err">Full control of the wallet. Store offline. Importable into Phantom / solana-keygen.</Banner>
          <pre className="seed">{exported}</pre>
        </Modal>
      )}
      <Panel title="Notes" className="grow">
        <ul className="small muted" style={{ margin: 0, paddingLeft: 16 }}>
          <li>Fund this address only with what you intend to trade. Treasury belongs in XMR / shielded ZEC.</li>
          <li>Every swap signed here is public on Solana forever and tied to this address.</li>
          <li>Hardware wallets: not supported in this build (no Ledger transport in the webview). Documented in docs/BLOCKERS.md.</li>
          <li>Each signature is recorded in the audit trail with a hash of the message.</li>
        </ul>
        <div className="dim xs mt4">{fmt(0, 0) && ""}</div>
      </Panel>
      {!st && <Dot state="off" />}
    </div>
  );
}
