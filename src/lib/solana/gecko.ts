import { fetchJson } from "../tauri";

export interface PoolInfo {
  address: string;
  name: string;
  dex: string;
  reserveUsd: number;
  volume24h: number;
  priceUsd: number;
  priceChange24h: number;
  tokenIsBase: boolean;
}

export interface Candle {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
export const TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

function tfParams(tf: Timeframe): { unit: "minute" | "hour" | "day"; agg: number } {
  switch (tf) {
    case "1m": return { unit: "minute", agg: 1 };
    case "5m": return { unit: "minute", agg: 5 };
    case "15m": return { unit: "minute", agg: 15 };
    case "1h": return { unit: "hour", agg: 1 };
    case "4h": return { unit: "hour", agg: 4 };
    case "1d": return { unit: "day", agg: 1 };
  }
}

interface GeckoPool {
  id: string;
  attributes: {
    address: string;
    name: string;
    reserve_in_usd: string;
    base_token_price_usd: string;
    quote_token_price_usd: string;
    volume_usd: { h24: string };
    price_change_percentage: { h24: string };
  };
  relationships: { dex: { data: { id: string } }; base_token: { data: { id: string } } };
}

export async function topPool(base: string, mint: string): Promise<PoolInfo | null> {
  const res = await fetchJson<{ data: GeckoPool[] }>(`${base.replace(/\/$/, "")}/networks/solana/tokens/${mint}/pools?page=1`, {
    headers: { accept: "application/json;version=20230302" },
  });
  const p = res.data?.[0];
  if (!p) return null;
  const tokenIsBase = p.relationships.base_token.data.id === `solana_${mint}`;
  return {
    address: p.attributes.address,
    name: p.attributes.name,
    dex: p.relationships.dex.data.id,
    reserveUsd: Number(p.attributes.reserve_in_usd),
    volume24h: Number(p.attributes.volume_usd?.h24 ?? 0),
    priceUsd: Number(tokenIsBase ? p.attributes.base_token_price_usd : p.attributes.quote_token_price_usd),
    priceChange24h: Number(p.attributes.price_change_percentage?.h24 ?? 0),
    tokenIsBase,
  };
}

export async function ohlcv(base: string, pool: string, tf: Timeframe, tokenIsBase: boolean, limit = 300): Promise<Candle[]> {
  const { unit, agg } = tfParams(tf);
  const url = `${base.replace(/\/$/, "")}/networks/solana/pools/${pool}/ohlcv/${unit}?aggregate=${agg}&limit=${limit}&currency=usd&token=${tokenIsBase ? "base" : "quote"}`;
  const res = await fetchJson<{ data: { attributes: { ohlcv_list: number[][] } } }>(url, { headers: { accept: "application/json;version=20230302" } });
  const list = res.data?.attributes?.ohlcv_list ?? [];
  const seen = new Set<number>();
  const out: Candle[] = [];
  for (const row of list) {
    const [t, o, h, l, c, v] = row;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push({ time: t, open: o, high: h, low: l, close: c, volume: v });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}
