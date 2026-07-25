import React, { useEffect, useState } from "react";
import { useApp, type View } from "../lib/store";
import { isTauri } from "../lib/tauri";
import { hms, short, usd } from "../lib/format";
import { Dot } from "./ui";

const NAV: { id: View; label: string; key: string }[] = [
  { id: "terminal", label: "Terminal", key: "1" },
  { id: "vault", label: "Vault", key: "2" },
  { id: "exchange", label: "Exchange", key: "3" },
  { id: "agent", label: "Agent", key: "4" },
  { id: "network", label: "Network", key: "5" },
  { id: "activity", label: "Activity", key: "6" },
  { id: "settings", label: "Settings", key: "7" },
];

export default function Shell(p: { children: React.ReactNode }) {
  const { view, setView, vault, wallet, net, treasury, prices, toasts, dismiss, realizedPnl } = useApp();
  const [clock, setClock] = useState(hms(Date.now()));

  useEffect(() => {
    const t = setInterval(() => setClock(hms(Date.now())), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      const n = NAV.find((x) => x.key === e.key);
      if (n) {
        e.preventDefault();
        setView(n.id);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [setView]);

  const vaultState = !isTauri ? "off" : !vault?.initialized ? "warn" : vault.unlocked ? "ok" : "err";
  const vaultText = !isTauri ? "n/a" : !vault?.initialized ? "no vault" : vault.unlocked ? "unlocked" : "locked";
  const netState = net.vpnUp ? "ok" : net.proxyEnabled ? (net.torReachable ? "ok" : "err") : net.tunnelUp ? "ok" : "warn";
  const netText = net.vpnUp ? `VPN ${net.vpnName ?? ""}` : net.proxyEnabled ? (net.torReachable ? "TOR" : "TOR DOWN") : net.tunnelUp ? `WG ${net.tunnelName ?? ""}` : "CLEARNET";
  const total = treasury.sol * (prices.SOL ?? 0) + treasury.usdc + treasury.solTokensUsd + treasury.xmr * (prices.XMR ?? 0) + treasury.zec * (prices.ZEC ?? 0);

  return (
    <div className="shell">
      <div className="topbar">
        <div className="brand" onClick={() => setView("terminal")} style={{ cursor: "pointer" }}>
          <img src="/logo.svg" alt="" width="18" height="18" style={{ borderRadius: "50%", display: "block" }} />
          Moneyero <span className="tag">v0.1 {isTauri ? "desktop" : "browser"}</span>
        </div>
        <nav className="nav">
          {NAV.map((n) => (
            <button key={n.id} className={view === n.id ? "active" : ""} onClick={() => setView(n.id)} title={`Alt+${n.key}`}>
              <span className="key">{n.key}</span>
              {n.label}
            </button>
          ))}
        </nav>
        <div className="statusstrip">
          <div className="cell" title="Vault (local encryption)">
            <Dot state={vaultState} /> VAULT <b>{vaultText}</b>
          </div>
          <div className="cell" title="Network path for all app traffic">
            <Dot state={netState} /> NET <b>{netText}</b>
          </div>
          <div className="cell" title="Solana signer">
            <Dot state={wallet.pubkey ? "ok" : "off"} /> SOL <b>{wallet.pubkey ? `${wallet.kind}:${short(wallet.pubkey, 4, 4)}` : "no wallet"}</b>
          </div>
          <div className="cell" title="Monero wallet">
            <Dot state={treasury.xmrOpen ? "or" : "off"} /> XMR <b>{treasury.xmrOpen ? treasury.xmr.toFixed(4) : "-"}</b>
          </div>
          <div className="cell" title="Zcash wallet">
            <Dot state={treasury.zecReachable ? "ok" : "off"} /> ZEC <b>{treasury.zecReachable ? treasury.zec.toFixed(4) : "-"}</b>
          </div>
          <div className="cell" title="Treasury value (priced assets only)">
            Σ <b>{total > 0 ? usd(total) : "-"}</b>
          </div>
        </div>
      </div>
      <div className="main">{p.children}</div>
      <div className="bottombar">
        <span>{clock}</span>
        <span>SOL {prices.SOL ? usd(prices.SOL) : "-"}</span>
        <span className="or">XMR {prices.XMR ? usd(prices.XMR) : "-"}</span>
        <span className="gold">ZEC {prices.ZEC ? usd(prices.ZEC) : "-"}</span>
        <span>rPNL {realizedPnl ? usd(realizedPnl) : "-"}</span>
        <span className="sp">alt+1..7 switch views</span>
        <span>no telemetry · self-custody · keys never leave this machine</span>
      </div>
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.level}`} onClick={() => dismiss(t.id)}>
            {t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}
