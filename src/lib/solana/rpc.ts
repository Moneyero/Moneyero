import { Connection, PublicKey, type Commitment } from "@solana/web3.js";
import { bridgedFetch } from "../tauri";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
export const STABLES = new Set([USDC_MINT, USDT_MINT]);
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

const cache = new Map<string, Connection>();

export function getConnection(rpcUrl: string, commitment: Commitment = "confirmed"): Connection {
  const key = `${rpcUrl}|${commitment}`;
  let c = cache.get(key);
  if (!c) {
    c = new Connection(rpcUrl, {
      commitment,
      fetch: bridgedFetch as unknown as typeof fetch,
      disableRetryOnRateLimit: true,
    });
    cache.set(key, c);
  }
  return c;
}

export interface TokenHolding {
  mint: string;
  amount: number;
  decimals: number;
  program: "token" | "token2022";
}

export async function getSolBalance(conn: Connection, owner: PublicKey): Promise<number> {
  const lamports = await conn.getBalance(owner);
  return lamports / 1e9;
}

export async function getTokenHoldings(conn: Connection, owner: PublicKey): Promise<TokenHolding[]> {
  const out: TokenHolding[] = [];
  for (const [program, tag] of [
    [TOKEN_PROGRAM, "token"],
    [TOKEN_2022, "token2022"],
  ] as const) {
    try {
      const res = await conn.getParsedTokenAccountsByOwner(owner, { programId: program });
      for (const acc of res.value) {
        const info = (acc.account.data as { parsed?: { info?: { mint: string; tokenAmount: { uiAmount: number | null; decimals: number } } } }).parsed?.info;
        if (!info) continue;
        const amt = info.tokenAmount.uiAmount ?? 0;
        if (amt > 0) out.push({ mint: info.mint, amount: amt, decimals: info.tokenAmount.decimals, program: tag });
      }
    } catch {
      // token-2022 lookups can fail on some RPCs; ignore that program then.
    }
  }
  return out;
}

export async function rpcHealth(conn: Connection): Promise<{ slot: number; ms: number }> {
  const t = performance.now();
  const slot = await conn.getSlot();
  return { slot, ms: Math.round(performance.now() - t) };
}

export function isPublicRpc(url: string): boolean {
  return /api\.(mainnet-beta|devnet|testnet)\.solana\.com/.test(url);
}
