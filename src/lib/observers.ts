/**
 * Who has this session talked to, and what each party learns from it.
 * Counts outbound requests per host (through the app's single fetch path) so the UI can show
 * the observers as a live list rather than a static warning. Nothing here leaves the machine.
 */
import { useEffect, useState } from "react";

export interface Observer {
  host: string;
  count: number;
  lastAt: number;
  role: string;
  learns: string;
}

const KNOWN: { test: RegExp; role: string; learns: string }[] = [
  { test: /api\.(mainnet-beta|devnet|testnet)\.solana\.com/, role: "public Solana RPC", learns: "your IP, every address you query, every transaction you submit" },
  { test: /helius|triton|quiknode|quicknode|alchemy|ankr|rpcpool|syndica/, role: "private Solana RPC", learns: "your IP and queried addresses, under your own account" },
  { test: /jup\.ag/, role: "Jupiter", learns: "your IP, the tokens you search, each quote (pair and amount), and your wallet address when a swap is built" },
  { test: /geckoterminal\.com/, role: "GeckoTerminal", learns: "your IP and which pool you are charting" },
  { test: /coingecko\.com/, role: "CoinGecko", learns: "your IP and that you watch XMR, ZEC and SOL" },
  { test: /ipify\.org|ipapi\.co|torproject\.org|bash\.ws/, role: "leak check", learns: "your IP, by design: that is what the check measures" },
  { test: /anthropic\.com/, role: "Anthropic", learns: "the agent snapshot: prices, balances, P&L, rules and your message. No addresses or keys" },
  { test: /sideshift|trocador|changenow|exolix/, role: "swap provider", learns: "your IP, the pair, amounts, deposit transaction and settle address" },
];

const byHost = new Map<string, Observer>();
const listeners = new Set<() => void>();
let version = 0;

export function recordRequest(url: string): void {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return;
  }
  if (!host || /^(127\.|localhost|\[::1\])/.test(host)) return;
  const k = KNOWN.find((x) => x.test.test(host));
  const cur = byHost.get(host);
  if (cur) {
    cur.count++;
    cur.lastAt = Date.now();
  } else {
    byHost.set(host, { host, count: 1, lastAt: Date.now(), role: k?.role ?? (/rpc|node/.test(host) ? "RPC" : "third party"), learns: k?.learns ?? "your IP and whatever this request contains" });
  }
  version++;
  for (const l of listeners) l();
}

/** Non-HTTP observers the app knows about, e.g. a wallet extension. */
export function recordObserver(host: string, role: string, learns: string): void {
  if (byHost.has(host)) return;
  byHost.set(host, { host, count: 0, lastAt: Date.now(), role, learns });
  version++;
  for (const l of listeners) l();
}

export function listObservers(): Observer[] {
  return [...byHost.values()].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
}

export function useObservers(): Observer[] {
  const [, setV] = useState(version);
  useEffect(() => {
    const l = () => setV(version);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return listObservers();
}
