import { fetchJson } from "./tauri";

/** USD prices for the treasury assets. CoinGecko public endpoint (no key), via the app client. */
export async function majorPrices(): Promise<Record<string, number>> {
  const r = await fetchJson<Record<string, { usd?: number }>>(
    "https://api.coingecko.com/api/v3/simple/price?ids=monero,zcash,solana,usd-coin&vs_currencies=usd",
  );
  const out: Record<string, number> = {};
  if (r.monero?.usd) out.XMR = r.monero.usd;
  if (r.zcash?.usd) out.ZEC = r.zcash.usd;
  if (r.solana?.usd) out.SOL = r.solana.usd;
  out.USDC = r["usd-coin"]?.usd ?? 1;
  return out;
}
