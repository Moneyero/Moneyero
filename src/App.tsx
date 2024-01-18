import { useEffect } from "react";
import { useApp } from "./lib/store";
import { invoke, isTauri } from "./lib/tauri";
import { majorPrices } from "./lib/prices";
import type { NetStatus, Proposal, VpnStatus, XmrBalance, XmrStatus, ZecBalance } from "./lib/types";
import Shell from "./components/Shell";
import Terminal from "./views/Terminal";
import Vault from "./views/Vault";
import Exchange from "./views/Exchange";
import Agent from "./views/Agent";
import Network from "./views/Network";
import Activity from "./views/Activity";
import Settings from "./views/Settings";

export default function App() {
  const { view, loadSettings, refreshVault, setPrices, setNet, setTreasury, settings, prices, treasury, realizedPnl, unrealizedPnl, wallet, toast } = useApp();

  // Boot.
  useEffect(() => {
    loadSettings();
    refreshVault();
  }, [loadSettings, refreshVault]);

  // Major prices (XMR/ZEC/SOL) every 60s.
  useEffect(() => {
    let alive = true;
    const tick = () => majorPrices().then((p) => alive && setPrices(p)).catch(() => {});
    tick();
    const t = setInterval(tick, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [setPrices]);

  // Network + wallet summaries for the status strip and the agent snapshot.
  useEffect(() => {
    if (!isTauri) return;
    let alive = true;
    const tick = async () => {
      try {
        const n = await invoke<NetStatus>("net_status");
        if (!alive) return;
        const t = n.tunnels.find((x) => x.handshake_fresh) ?? n.tunnels[0];
        setNet({ proxyEnabled: n.proxy_enabled, torReachable: n.tor_socks_reachable, tunnelUp: !!t, tunnelName: t?.interface ?? null });
      } catch {
        /* ignore */
      }
      try {
        const v = await invoke<VpnStatus>("vpn_status");
        if (alive) setNet({ vpnUp: v.running && v.handshake_age_secs != null, vpnName: v.name });
      } catch {
        /* ignore */
      }
      try {
        const x = await invoke<XmrStatus>("xmr_status");
        if (x.wallet && x.rpc_ok) {
          const b = await invoke<XmrBalance>("xmr_balance");
          if (alive) setTreasury({ xmr: b.balance, xmrOpen: true });
        } else if (alive) setTreasury({ xmrOpen: false });
      } catch {
        /* ignore */
      }
      try {
        const z = await invoke<ZecBalance>("zec_balance");
        if (alive) setTreasury({ zec: z.total, zecTransparent: z.transparent, zecReachable: true });
      } catch {
        if (alive) setTreasury({ zecReachable: false });
      }
    };
    tick();
    const t = setInterval(tick, 45_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [setNet, setTreasury]);

  // Background rules-engine tick (independent of which view is open).
  useEffect(() => {
    if (!isTauri || settings["agent.enabled"] !== "true") return;
    const secs = Math.max(15, Number(settings["agent.tick_secs"] ?? 60));
    const t = setInterval(async () => {
      try {
        const created = await invoke<Proposal[]>("agent_tick", {
          snapshot: {
            prices: { SOL: prices.SOL ?? 0, XMR: prices.XMR ?? 0, ZEC: prices.ZEC ?? 0, USDC: 1 },
            balances: { sol: treasury.sol, usdc: treasury.usdc, xmr: treasury.xmr, zec: treasury.zec, zec_transparent: treasury.zecTransparent, sol_tokens_usd: treasury.solTokensUsd },
            realized_pnl_usd: realizedPnl,
            unrealized_pnl_usd: unrealizedPnl,
            wallet: wallet.pubkey,
            sources: ["background"],
          },
        });
        if (created.length) toast(`AGENT: ${created.length} new proposal(s) awaiting approval`, "warn");
      } catch {
        /* next tick */
      }
    }, secs * 1000);
    return () => clearInterval(t);
  }, [settings, prices, treasury, realizedPnl, unrealizedPnl, wallet.pubkey, toast]);

  return (
    <Shell>
      {view === "terminal" && <Terminal />}
      {view === "vault" && <Vault />}
      {view === "exchange" && <Exchange />}
      {view === "agent" && <Agent />}
      {view === "network" && <Network />}
      {view === "activity" && <Activity />}
      {view === "settings" && <Settings />}
    </Shell>
  );
}
