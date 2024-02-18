import { useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { invoke, isTauri } from "../lib/tauri";
import { errMsg } from "../lib/format";
import { Btn, Chip, ErrLine, Field, Input, Kv, Panel, Select } from "../components/ui";

interface Spec {
  key: string;
  label: string;
  hint?: string;
  type?: "text" | "bool" | "select" | "number";
  options?: string[];
  placeholder?: string;
}

const SECTIONS: { title: string; gold?: boolean; items: Spec[] }[] = [
  {
    title: "Solana / trading",
    items: [
      { key: "solana.rpc_url", label: "RPC URL", hint: "Public RPC logs your IP + queried addresses. A private RPC (Helius, Triton, your own) is strongly preferred." },
      { key: "solana.commitment", label: "commitment", type: "select", options: ["processed", "confirmed", "finalized"] },
      { key: "jupiter.base_url", label: "Jupiter base (keyless)", hint: "lite-api.jup.ag is rate limited; set an API key to use api.jup.ag." },
      { key: "jupiter.keyed_base_url", label: "Jupiter base (with key)" },
      { key: "gecko.base_url", label: "GeckoTerminal base", hint: "OHLCV candles (public, 30 req/min)." },
      { key: "trade.default_slippage_bps", label: "default slippage (bps)", type: "number" },
      { key: "trade.max_slippage_bps", label: "max slippage (bps)", type: "number" },
    ],
  },
  {
    title: "Monero",
    items: [
      { key: "monero.wallet_rpc_path", label: "monero-wallet-rpc binary", hint: "Full path to the official monero-wallet-rpc executable (from getmonero.org, verify signatures).", placeholder: "C:\\monero\\monero-wallet-rpc.exe" },
      { key: "monero.daemon_address", label: "daemon address", hint: "host:port of monerod. 127.0.0.1:18081 for a local node.", placeholder: "127.0.0.1:18081" },
      { key: "monero.daemon_ssl", label: "daemon SSL", type: "select", options: ["autodetect", "enabled", "disabled"] },
      { key: "monero.trusted_daemon", label: "trusted daemon", type: "bool", hint: "Only for a node you run." },
      { key: "monero.rpc_port", label: "wallet-rpc local port", type: "number" },
    ],
  },
  {
    title: "Zcash",
    gold: true,
    items: [
      { key: "zcash.rpc_url", label: "node RPC URL", hint: "zcashd / zallet JSON-RPC.", placeholder: "http://127.0.0.1:8232" },
      { key: "zcash.rpc_user", label: "rpcuser", hint: "Leave empty with datadir set to use cookie auth." },
      { key: "zcash.binary_path", label: "node binary (optional)", hint: "zcashd or zallet, to manage the process from VAULT." },
      { key: "zcash.datadir", label: "datadir (optional)" },
      { key: "zcash.conf_path", label: "conf path (optional)" },
      { key: "zcash.default_privacy_policy", label: "default privacy policy", type: "select", options: ["FullPrivacy", "AllowRevealedAmounts", "AllowRevealedRecipients", "AllowRevealedSenders", "AllowFullyTransparent", "NoPrivacy"] },
    ],
  },
  {
    title: "Network",
    items: [
      { key: "net.proxy_enabled", label: "route ALL app traffic via proxy", type: "bool", hint: "Applies to market data, RPC, swap providers, Claude API and monero-wallet-rpc." },
      { key: "net.proxy_url", label: "proxy URL", hint: "socks5h:// resolves DNS through the proxy. Tor Browser: 127.0.0.1:9150; tor daemon: 9050." },
      { key: "net.wireguard_path", label: "wireguard binary", hint: "wireguard.exe on Windows (/installtunnelservice), wg-quick elsewhere." },
      { key: "net.wg_path", label: "wg binary", hint: "Used for `wg show all dump`." },
      { key: "net.ip_check_url", label: "IP check URL", hint: "check.torproject.org also reports whether the exit is a Tor relay." },
      { key: "net.geo_lookup", label: "geo lookup of exit IP (3rd party)", type: "bool", hint: "Sends the exit IP to ipapi.co. Off by default." },
    ],
  },
  {
    title: "Agent",
    items: [
      { key: "agent.enabled", label: "rules engine enabled", type: "bool" },
      { key: "agent.tick_secs", label: "evaluation interval (s)", type: "number" },
      { key: "agent.max_proposal_usd", label: "flag proposals above (USD)", type: "number" },
      { key: "agent.model", label: "Claude model", type: "select", options: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] },
      { key: "agent.effort", label: "effort", type: "select", options: ["low", "medium", "high", "xhigh", "max"] },
    ],
  },
  {
    title: "Exchange",
    items: [
      { key: "exchange.providers", label: "enabled providers", hint: "comma separated: sideshift,trocador,changenow,exolix" },
      { key: "exchange.sideshift_affiliate", label: "SideShift affiliate id (optional)" },
    ],
  },
];

const DESKTOP_WHY: Record<string, string> = {
  Monero: "Runs monero-wallet-rpc as a local process and talks to it over loopback.",
  Zcash: "Talks to zcashd or zallet on your machine.",
  Network: "Built-in WireGuard, Tor switch and leak tests need raw sockets.",
  Agent: "Rules engine and Claude calls run in Rust with vault-held keys.",
  Exchange: "Swap-provider traffic goes through the tunnelled Rust client.",
};

const SECRETS: { key: string; label: string; hint: string }[] = [
  { key: "anthropic.api_key", label: "Anthropic API key", hint: "AGENT natural-language control. Requests go through the proxy if enabled." },
  { key: "jupiter.api_key", label: "Jupiter API key", hint: "Higher rate limits on api.jup.ag." },
  { key: "trocador.api_key", label: "Trocador API key", hint: "Required for Trocador quotes." },
  { key: "changenow.api_key", label: "ChangeNOW API key", hint: "Required for ChangeNOW quotes." },
  { key: "exolix.api_key", label: "Exolix API key", hint: "Optional." },
  { key: "sideshift.secret", label: "SideShift account secret", hint: "Optional; ties orders to your SideShift account." },
  { key: "zcash.rpc_pass", label: "Zcash rpcpassword", hint: "From zcash.conf." },
  { key: "monero.daemon_login", label: "Monero daemon login", hint: "user:pass if your node requires it." },
];

export default function Settings() {
  const { settings, setSetting, loadSettings, vault, refreshVault, toast } = useApp();
  const [local, setLocal] = useState<Record<string, string>>({});
  const [pw, setPw] = useState({ a: "", b: "", old: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [secretVal, setSecretVal] = useState<Record<string, string>>({});
  const [info, setInfo] = useState<{ version: string; data_dir: string; platform: string; arch: string } | null>(null);

  useEffect(() => {
    setLocal(settings);
  }, [settings]);
  useEffect(() => {
    if (isTauri) invoke<typeof info>("app_info").then(setInfo).catch(() => {});
  }, []);

  const commit = async (key: string) => {
    if (local[key] !== settings[key]) await setSetting(key, local[key] ?? "");
  };

  const vaultAction = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await refreshVault();
      setPw({ a: "", b: "", old: "" });
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const saveSecret = async (key: string) => {
    const v = secretVal[key] ?? "";
    if (!v.trim()) return;
    try {
      await invoke("secret_set", { key, value: v });
      setSecretVal({ ...secretVal, [key]: "" });
      await refreshVault();
      toast(`${key} stored (encrypted)`, "ok");
    } catch (e) {
      toast(errMsg(e), "err");
    }
  };
  const delSecret = async (key: string) => {
    try {
      await invoke("secret_delete", { key });
      await refreshVault();
    } catch (e) {
      toast(errMsg(e), "err");
    }
  };

  const renderSection = (sec: (typeof SECTIONS)[number]) => (
    <Panel key={sec.title} title={sec.title} gold={sec.gold}>
      {sec.items.map((it) => (
        <Field key={it.key} label={it.label} hint={it.hint}>
          {it.type === "bool" ? (
            <Select value={(local[it.key] ?? "false") === "true" ? "true" : "false"} onChange={(e) => { setLocal({ ...local, [it.key]: e.target.value }); setSetting(it.key, e.target.value); }}>
              <option value="false">off</option>
              <option value="true">on</option>
            </Select>
          ) : it.type === "select" ? (
            <Select value={local[it.key] ?? ""} onChange={(e) => { setLocal({ ...local, [it.key]: e.target.value }); setSetting(it.key, e.target.value); }}>
              {it.options!.map((o) => <option key={o} value={o}>{o}</option>)}
            </Select>
          ) : (
            <Input mono value={local[it.key] ?? ""} placeholder={it.placeholder} onChange={(e) => setLocal({ ...local, [it.key]: e.target.value })} onBlur={() => commit(it.key)} onKeyDown={(e) => e.key === "Enter" && commit(it.key)} />
          )}
        </Field>
      ))}
    </Panel>
  );

  if (!isTauri) {
    const trading = SECTIONS.find((s) => s.title === "Solana / trading")!;
    const desktopOnly = SECTIONS.filter((s) => s !== trading);
    const clearAll = async () => {
      for (const it of trading.items) await setSetting(it.key, "");
      toast("browser settings reset to defaults", "ok");
    };
    return (
      <div className="view">
        <div className="row">
          <div className="col grow">
            {renderSection({ ...trading, title: "Solana / trading (browser mode)" })}
          </div>
          <div className="col" style={{ width: 400 }}>
            <Panel title="This browser">
              <Kv wrap items={[
                ["mode", "browser · Phantom signing"],
                ["stored in", "this browser's localStorage, nothing else"],
                ["vault", "none (needs desktop)"],
                ["telemetry", "none"],
              ]} />
              <div className="dim xs">Leave a field empty to use the default. The RPC URL is the one that matters: the public Solana RPC logs the IP that queries your address.</div>
              <Btn size="sm" variant="ghost" onClick={clearAll}>reset to defaults</Btn>
            </Panel>
            <Panel title="Desktop only">
              <table className="tbl dense">
                <tbody>
                  {desktopOnly.map((s) => (
                    <tr key={s.title}><td style={{ width: 90 }}>{s.title}</td><td className="dim xs">{DESKTOP_WHY[s.title] ?? ""}</td></tr>
                  ))}
                  <tr><td>Keys</td><td className="dim xs">API keys and RPC credentials sit in the vault, encrypted with Argon2id and XChaCha20. A web page must never hold them.</td></tr>
                </tbody>
              </table>
              <div className="dim xs" style={{ marginTop: 6 }}><a href="/download.html">Build the desktop app →</a></div>
            </Panel>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="view">
      <div className="row">
        <Panel title="Vault" className="grow" right={<Chip tone={vault?.unlocked ? "ok" : vault?.initialized ? "err" : "warn"}>{vault?.unlocked ? "unlocked" : vault?.initialized ? "locked" : "not initialised"}</Chip>}>
          <div className="small muted">
            One master password. Argon2id → XChaCha20-Poly1305. Protects API keys, RPC credentials and the local Solana signing key. Monero and Zcash keys are protected separately by their own wallet software; the vault never holds them.
          </div>
          <ErrLine e={err} />
          {!vault?.initialized && (
            <div className="row ac">
              <Field label="new master password" className="grow"><Input type="password" value={pw.a} onChange={(e) => setPw({ ...pw, a: e.target.value })} /></Field>
              <Field label="repeat" className="grow"><Input type="password" value={pw.b} onChange={(e) => setPw({ ...pw, b: e.target.value })} /></Field>
              <Btn variant="primary" busy={busy} disabled={pw.a.length < 8 || pw.a !== pw.b} onClick={() => vaultAction(() => invoke("vault_init", { password: pw.a }))} style={{ marginTop: 14 }}>init vault</Btn>
            </div>
          )}
          {vault?.initialized && !vault.unlocked && (
            <div className="row ac">
              <Field label="master password" className="grow"><Input type="password" autoFocus value={pw.a} onChange={(e) => setPw({ ...pw, a: e.target.value })} onKeyDown={(e) => e.key === "Enter" && vaultAction(() => invoke("vault_unlock", { password: pw.a }))} /></Field>
              <Btn variant="primary" busy={busy} disabled={!pw.a} onClick={() => vaultAction(() => invoke("vault_unlock", { password: pw.a }))} style={{ marginTop: 14 }}>unlock</Btn>
            </div>
          )}
          {vault?.unlocked && (
            <div className="row ac wrap">
              <Btn onClick={() => vaultAction(() => invoke("vault_lock"))}>lock now</Btn>
              <Field label="current"><Input type="password" value={pw.old} onChange={(e) => setPw({ ...pw, old: e.target.value })} /></Field>
              <Field label="new"><Input type="password" value={pw.a} onChange={(e) => setPw({ ...pw, a: e.target.value })} /></Field>
              <Field label="repeat"><Input type="password" value={pw.b} onChange={(e) => setPw({ ...pw, b: e.target.value })} /></Field>
              <Btn busy={busy} disabled={!pw.old || pw.a.length < 8 || pw.a !== pw.b} onClick={() => vaultAction(() => invoke("vault_change_password", { oldPassword: pw.old, newPassword: pw.a }))} style={{ marginTop: 14 }}>change password</Btn>
            </div>
          )}
        </Panel>
        <Panel title="App" style={{ width: 360 }}>
          <Kv wrap items={[["version", info?.version ?? "-"], ["platform", `${info?.platform ?? "-"} ${info?.arch ?? ""}`], ["data dir", info?.data_dir ?? "-"], ["telemetry", "none"], ["update check", "none (manual)"]]} />
          <Btn size="sm" onClick={loadSettings}>reload settings</Btn>
        </Panel>
      </div>

      <Panel title="Keys & credentials (vault-encrypted)" right={!vault?.unlocked && <Chip tone="warn">unlock vault to edit</Chip>}>
        <table className="tbl">
          <thead><tr><th>slot</th><th>status</th><th>value</th><th></th></tr></thead>
          <tbody>
            {SECRETS.map((s) => {
              const has = vault?.secret_slots?.[s.key];
              return (
                <tr key={s.key}>
                  <td><div>{s.label}</div><div className="dim xs">{s.hint}</div></td>
                  <td>{has ? <Chip tone="ok">set</Chip> : <Chip>empty</Chip>}</td>
                  <td style={{ width: 360 }}>
                    <Input type="password" placeholder={has ? "•••••••• (replace)" : "paste value"} disabled={!vault?.unlocked} value={secretVal[s.key] ?? ""} onChange={(e) => setSecretVal({ ...secretVal, [s.key]: e.target.value })} onKeyDown={(e) => e.key === "Enter" && saveSecret(s.key)} />
                  </td>
                  <td className="nowrap">
                    <Btn size="xs" variant="primary" disabled={!vault?.unlocked || !(secretVal[s.key] ?? "").trim()} onClick={() => saveSecret(s.key)}>save</Btn>{" "}
                    <Btn size="xs" variant="danger" disabled={!has} onClick={() => delSecret(s.key)}>clear</Btn>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>

      <div className="grid2">{SECTIONS.map(renderSection)}</div>
    </div>
  );
}
