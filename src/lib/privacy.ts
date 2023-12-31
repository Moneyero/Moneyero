/**
 * Privacy engine: deterministic warnings about what each action reveals, and to whom.
 * It never claims anonymity. It names the observer.
 */

export interface Warning {
  level: "info" | "warn" | "crit";
  code: string;
  text: string;
}

export interface NetCtx {
  proxyEnabled: boolean;
  torReachable: boolean;
  tunnelUp: boolean;
}

export function networkWarnings(n: NetCtx): Warning[] {
  const w: Warning[] = [];
  if (!n.tunnelUp && !n.proxyEnabled) {
    w.push({ level: "warn", code: "net.clear", text: "No VPN tunnel and no Tor proxy: every RPC node, API and swap provider sees your real IP." });
  }
  if (n.proxyEnabled && !n.torReachable) {
    w.push({ level: "crit", code: "net.proxy_down", text: "Proxy is enabled but the SOCKS port is unreachable. Requests will fail rather than leak, but nothing works until Tor is running." });
  }
  if (n.tunnelUp && !n.proxyEnabled) {
    w.push({ level: "info", code: "net.vpn_only", text: "VPN hides your IP from endpoints, but the VPN operator sees all destinations. Tor adds a second hop for API traffic." });
  }
  return w;
}

export function solanaSwapWarnings(p: { signerKind: "phantom" | "local" | null; net: NetCtx; rpcIsPublic: boolean; tokenRisk: number; sameWalletAsExchangeSettle: boolean }): Warning[] {
  const w: Warning[] = [];
  w.push({ level: "info", code: "sol.public", text: "Solana is a transparent ledger. This swap permanently links your wallet address to this token and amount." });
  if (p.signerKind === "phantom") {
    w.push({ level: "warn", code: "sol.phantom_rpc", text: "Phantom simulates and may submit through its own RPC: Phantom's infrastructure sees your address and this transaction regardless of the proxy setting here." });
  }
  if (p.rpcIsPublic) {
    w.push({ level: "info", code: "sol.public_rpc", text: "Public Solana RPC: the operator logs the IP that queries this address. Use a private RPC or route through Tor." });
  }
  if (!p.net.proxyEnabled && !p.net.tunnelUp) {
    w.push({ level: "warn", code: "sol.ip", text: "Your real IP is attached to RPC queries and Jupiter API calls for this wallet." });
  }
  if (p.sameWalletAsExchangeSettle) {
    w.push({ level: "warn", code: "sol.link", text: "This wallet also received funds from a swap provider. Trading here links that provider deposit to your trading activity." });
  }
  if (p.tokenRisk > 0) {
    w.push({ level: p.tokenRisk > 1 ? "crit" : "warn", code: "sol.token_risk", text: `${p.tokenRisk} red flag${p.tokenRisk > 1 ? "s" : ""} on this token (see risk row). Not a privacy issue; a loss-of-funds issue.` });
  }
  return w;
}

export function exchangeWarnings(p: { provider: string; from: string; to: string; net: NetCtx; kyc: string | null }): Warning[] {
  const w: Warning[] = [];
  w.push({ level: "warn", code: "ex.metadata", text: `${p.provider} sees: your IP${p.net.proxyEnabled ? " (Tor exit)" : p.net.tunnelUp ? " (VPN exit)" : " (REAL)"}, the ${p.from} deposit transaction, the ${p.to} settle address, amounts and timing. It can correlate them indefinitely.` });
  if (p.from === "XMR") {
    w.push({ level: "info", code: "ex.xmr_out", text: "Sending XMR to a provider reveals that *some* Monero reached them, not your wallet history. The receiving chain side is fully public." });
  }
  if (p.to === "XMR") {
    w.push({ level: "info", code: "ex.xmr_in", text: "The provider knows the XMR address it paid. Use a fresh subaddress; do not reuse it." });
  }
  if (p.from === "ZEC" || p.to === "ZEC") {
    w.push({ level: "warn", code: "ex.zec_t", text: "Providers only handle TRANSPARENT ZEC. The t-address leg is as public as Bitcoin. Shield immediately after settlement." });
  }
  if (p.from === "SOL" || p.from === "USDC" || p.to === "SOL" || p.to === "USDC") {
    w.push({ level: "info", code: "ex.sol_link", text: "The Solana leg ties your wallet address to this provider on-chain." });
  }
  if (p.kyc && /[CD]/.test(p.kyc)) {
    w.push({ level: "warn", code: "ex.kyc", text: `KYC rating ${p.kyc}: provider may freeze funds and demand identity documents.` });
  }
  return w;
}

export function zecSendWarnings(p: { fromShielded: boolean; toShielded: boolean; policy: string }): Warning[] {
  const w: Warning[] = [];
  if (!p.fromShielded) w.push({ level: "warn", code: "zec.t_from", text: "Spending from a transparent address: sender, amount and change are public." });
  if (!p.toShielded) w.push({ level: "warn", code: "zec.t_to", text: "Destination is transparent: the recipient's balance and your payment are public forever." });
  if (p.policy !== "FullPrivacy") w.push({ level: "crit", code: "zec.policy", text: `Privacy policy ${p.policy} permits revealing ${p.policy.replace("Allow", "").replace(/([A-Z])/g, " $1").toLowerCase()} on-chain.` });
  if (p.fromShielded && p.toShielded && p.policy === "FullPrivacy") w.push({ level: "info", code: "zec.ok", text: "Fully shielded transfer: amounts, sender and receiver encrypted on-chain. Your node operator and network path still see timing." });
  return w;
}

/** Coin control: what spending a particular set of outputs together reveals. Facts, not a score. */
export function xmrOutputWarnings(sel: { amount: number; subaddr_index: number; confirmations: number }[], all: { subaddr_index: number; spent: boolean }[]): Warning[] {
  const w: Warning[] = [];
  if (!sel.length) return w;
  const subs = new Set(sel.map((o) => o.subaddr_index));
  if (subs.size > 1) {
    w.push({ level: "warn", code: "xmr.cc.merge", text: `Spending outputs from ${subs.size} different subaddresses in one transaction proves to anyone who knows those addresses that they belong to the same wallet.` });
  }
  const dust = sel.filter((o) => o.amount > 0 && o.amount < 0.0005);
  if (dust.length) {
    w.push({ level: "warn", code: "xmr.cc.dust", text: `${dust.length} selected output(s) are tiny. Unsolicited dust can be a tracing probe; spending it alongside real funds links them to whoever sent it. Consider churning it alone or leaving it frozen.` });
  }
  const young = sel.filter((o) => o.confirmations < 10);
  if (young.length) w.push({ level: "info", code: "xmr.cc.locked", text: `${young.length} selected output(s) are still locked (under 10 confirmations) and cannot be spent yet.` });
  const crowded = sel.filter((o) => all.filter((a) => !a.spent && a.subaddr_index === o.subaddr_index).length > 1);
  if (crowded.length && subs.size === 1) {
    w.push({ level: "info", code: "xmr.cc.reuse", text: "This subaddress received more than once. The senders can already link those payments to one recipient; spending them together adds nothing new on-chain." });
  }
  w.push({ level: "info", code: "xmr.cc.ring", text: "Each spent output still hides inside a ring of 16 decoys. Coin control changes what your own counterparties can infer, not what the chain shows." });
  return w;
}

export function xmrNodeWarnings(p: { daemonUrl: string; proxy: string | null; trusted: boolean }): Warning[] {
  const w: Warning[] = [];
  const local = /127\.0\.0\.1|localhost/.test(p.daemonUrl);
  if (!local) {
    w.push({ level: "warn", code: "xmr.remote", text: `Remote node ${p.daemonUrl} sees your IP${p.proxy ? " (Tor exit)" : ""}, your wallet's restore height, and which transactions it fetches. It cannot see balances or keys, but it can fingerprint wallet activity.` });
    if (!p.proxy) w.push({ level: "warn", code: "xmr.remote_clear", text: "Enable the Tor proxy (NETWORK) to hide your IP from the remote node." });
    if (p.trusted) w.push({ level: "crit", code: "xmr.trusted_remote", text: "A remote node is marked TRUSTED: it may learn more about your wallet. Only trust a node you run." });
  } else {
    w.push({ level: "info", code: "xmr.local", text: "Local node: strongest setting. Outbound P2P traffic still reveals that this IP runs Monero unless the node itself uses Tor/I2P." });
  }
  return w;
}
