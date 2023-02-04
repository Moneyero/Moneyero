import { fetchJson } from "../tauri";

export interface JupToken {
  id: string;
  name: string;
  symbol: string;
  icon?: string;
  decimals: number;
  usdPrice?: number;
  liquidity?: number;
  mcap?: number;
  fdv?: number;
  holderCount?: number;
  isVerified?: boolean;
  organicScore?: number;
  organicScoreLabel?: string;
  tags?: string[];
  audit?: {
    mintAuthorityDisabled?: boolean;
    freezeAuthorityDisabled?: boolean;
    topHoldersPercentage?: number;
    devBalancePercentage?: number;
  };
  stats24h?: {
    priceChange?: number;
    buyVolume?: number;
    sellVolume?: number;
    numBuys?: number;
    numSells?: number;
    numTraders?: number;
  };
  stats1h?: { priceChange?: number };
}

export interface JupQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: { swapInfo: { label?: string; ammKey: string; inputMint: string; outputMint: string; inAmount: string; outAmount: string; feeAmount: string; feeMint: string }; percent: number }[];
  contextSlot?: number;
  timeTaken?: number;
}

export interface JupSwapResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports?: number;
  computeUnitLimit?: number;
  simulationError?: { error: string; errorCode?: string } | null;
}

export interface JupCfg {
  base: string;
  keyedBase: string;
  apiKey: string | null;
}

function base(c: JupCfg): string {
  return (c.apiKey ? c.keyedBase : c.base).replace(/\/$/, "");
}
function headers(c: JupCfg): Record<string, string> {
  return c.apiKey ? { "x-api-key": c.apiKey } : {};
}

export async function searchTokens(c: JupCfg, query: string): Promise<JupToken[]> {
  const q = query.trim();
  if (!q) return [];
  const res = await fetchJson<JupToken[] | { tokens?: JupToken[] }>(`${base(c)}/tokens/v2/search?query=${encodeURIComponent(q)}`, { headers: headers(c) });
  return Array.isArray(res) ? res : (res.tokens ?? []);
}

export async function tokensByMints(c: JupCfg, mints: string[]): Promise<JupToken[]> {
  if (!mints.length) return [];
  const res = await fetchJson<JupToken[]>(`${base(c)}/tokens/v2/search?query=${encodeURIComponent(mints.slice(0, 50).join(","))}`, { headers: headers(c) });
  return Array.isArray(res) ? res : [];
}

export async function getPrices(c: JupCfg, mints: string[]): Promise<Record<string, number>> {
  const ids = [...new Set(mints)].filter(Boolean).slice(0, 50);
  if (!ids.length) return {};
  const res = await fetchJson<Record<string, { usdPrice?: number; price?: string | number } | null>>(`${base(c)}/price/v3?ids=${ids.join(",")}`, { headers: headers(c) });
  const out: Record<string, number> = {};
  const data = (res as { data?: typeof res }).data ?? res;
  for (const [k, v] of Object.entries(data)) {
    if (!v) continue;
    const p = v.usdPrice ?? (v.price != null ? Number(v.price) : undefined);
    if (p != null && isFinite(p)) out[k] = p;
  }
  return out;
}

export async function getQuote(
  c: JupCfg,
  p: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number },
): Promise<JupQuote> {
  const qs = new URLSearchParams({
    inputMint: p.inputMint,
    outputMint: p.outputMint,
    amount: p.amount.toString(),
    slippageBps: String(p.slippageBps),
    restrictIntermediateTokens: "true",
    swapMode: "ExactIn",
  });
  return fetchJson<JupQuote>(`${base(c)}/swap/v1/quote?${qs}`, { headers: headers(c) });
}

export async function buildSwap(
  c: JupCfg,
  p: { quoteResponse: JupQuote; userPublicKey: string; priorityFee: "auto" | number },
): Promise<JupSwapResponse> {
  const body: Record<string, unknown> = {
    quoteResponse: p.quoteResponse,
    userPublicKey: p.userPublicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    dynamicSlippage: false,
  };
  if (p.priorityFee === "auto") {
    body.prioritizationFeeLamports = { priorityLevelWithMaxLamports: { maxLamports: 5_000_000, priorityLevel: "high" } };
  } else {
    body.prioritizationFeeLamports = p.priorityFee;
  }
  return fetchJson<JupSwapResponse>(`${base(c)}/swap/v1/swap`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers(c) },
    body: JSON.stringify(body),
  });
}

export interface RiskFlag {
  level: "ok" | "warn" | "err";
  label: string;
  detail: string;
}

/** Deterministic risk indicators derived from Jupiter token metadata. No scoring theatre. */
export function riskFlags(t: JupToken | null): RiskFlag[] {
  if (!t) return [];
  const f: RiskFlag[] = [];
  if (t.isVerified) f.push({ level: "ok", label: "verified", detail: "On Jupiter verified list" });
  else f.push({ level: "warn", label: "unverified", detail: "Not on Jupiter verified list" });
  if (t.audit) {
    if (t.audit.mintAuthorityDisabled === false) f.push({ level: "err", label: "mint auth", detail: "Mint authority still enabled - supply can be inflated" });
    if (t.audit.freezeAuthorityDisabled === false) f.push({ level: "err", label: "freeze auth", detail: "Freeze authority enabled - your tokens can be frozen" });
    if (t.audit.topHoldersPercentage != null && t.audit.topHoldersPercentage > 50) f.push({ level: "warn", label: `top10 ${t.audit.topHoldersPercentage.toFixed(0)}%`, detail: "Top 10 holders control more than half of supply" });
    if (t.audit.devBalancePercentage != null && t.audit.devBalancePercentage > 10) f.push({ level: "warn", label: `dev ${t.audit.devBalancePercentage.toFixed(0)}%`, detail: "Deployer holds a large share" });
  }
  if (t.liquidity != null) {
    if (t.liquidity < 20_000) f.push({ level: "err", label: "thin liq", detail: `Liquidity ${Math.round(t.liquidity).toLocaleString()} USD - expect heavy price impact` });
    else if (t.liquidity < 100_000) f.push({ level: "warn", label: "low liq", detail: `Liquidity ${Math.round(t.liquidity).toLocaleString()} USD` });
  }
  if (t.organicScoreLabel === "low") f.push({ level: "warn", label: "organic:low", detail: "Jupiter organic score low (wash/bot volume likely)" });
  if (t.tags?.includes("pump")) f.push({ level: "warn", label: "pump.fun", detail: "Launched via pump.fun bonding curve" });
  return f;
}
