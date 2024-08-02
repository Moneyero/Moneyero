import type { Trade } from "../types";
import { STABLES } from "./rpc";

export interface PositionPnl {
  mint: string;
  symbol: string;
  bought: number;
  sold: number;
  position: number; // tracked position from trade log
  avgCost: number; // USD per unit for the tracked position
  costBasisUsd: number;
  realizedUsd: number;
  markUsd: number | null;
  unrealizedUsd: number | null;
  untrackedSold: number; // units sold without a recorded cost basis
}

export interface PnlSummary {
  realizedUsd: number;
  unrealizedUsd: number;
  positions: PositionPnl[];
  tradeCount: number;
}

/**
 * Average-cost P&L from the local trade log. Only trades recorded by Moneyero count; tokens
 * acquired elsewhere show up as `untrackedSold` instead of being guessed at.
 */
export function computePnl(trades: Trade[], prices: Record<string, number>): PnlSummary {
  const pos = new Map<string, PositionPnl>();
  const get = (mint: string, symbol: string) => {
    let p = pos.get(mint);
    if (!p) {
      p = { mint, symbol, bought: 0, sold: 0, position: 0, avgCost: 0, costBasisUsd: 0, realizedUsd: 0, markUsd: null, unrealizedUsd: null, untrackedSold: 0 };
      pos.set(mint, p);
    }
    return p;
  };
  const sorted = [...trades].filter((t) => t.status === "confirmed").sort((a, b) => a.ts - b.ts);
  for (const t of sorted) {
    const inUsd = t.in_usd ?? (STABLES.has(t.in_mint) ? t.in_amount : null);
    const outUsd = t.out_usd ?? (STABLES.has(t.out_mint) ? t.out_amount : null);
    const value = inUsd ?? outUsd ?? 0;
    // Sell side (what we gave)
    if (!STABLES.has(t.in_mint)) {
      const p = get(t.in_mint, t.in_symbol);
      p.sold += t.in_amount;
      const tracked = Math.min(t.in_amount, p.position);
      const untracked = t.in_amount - tracked;
      if (tracked > 0) {
        const cost = p.avgCost * tracked;
        const proceeds = value * (tracked / t.in_amount);
        p.realizedUsd += proceeds - cost;
        p.position -= tracked;
        p.costBasisUsd -= cost;
      }
      p.untrackedSold += untracked;
      if (p.position <= 1e-12) {
        p.position = 0;
        p.costBasisUsd = 0;
        p.avgCost = 0;
      }
    }
    // Buy side (what we received)
    if (!STABLES.has(t.out_mint)) {
      const p = get(t.out_mint, t.out_symbol);
      p.bought += t.out_amount;
      p.costBasisUsd += value;
      p.position += t.out_amount;
      p.avgCost = p.position > 0 ? p.costBasisUsd / p.position : 0;
    }
  }
  let realized = 0;
  let unrealized = 0;
  const positions: PositionPnl[] = [];
  for (const p of pos.values()) {
    const mark = prices[p.mint];
    p.markUsd = mark ?? null;
    p.unrealizedUsd = mark != null && p.position > 0 ? p.position * mark - p.costBasisUsd : null;
    realized += p.realizedUsd;
    unrealized += p.unrealizedUsd ?? 0;
    positions.push(p);
  }
  positions.sort((a, b) => Math.abs(b.realizedUsd + (b.unrealizedUsd ?? 0)) - Math.abs(a.realizedUsd + (a.unrealizedUsd ?? 0)));
  return { realizedUsd: realized, unrealizedUsd: unrealized, positions, tradeCount: sorted.length };
}
