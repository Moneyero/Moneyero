import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { invoke, isTauri } from "../tauri";
import type { SolLocalStatus } from "../types";

export interface Signer {
  kind: "phantom" | "local";
  publicKey: PublicKey;
  signTransaction(tx: VersionedTransaction): Promise<VersionedTransaction>;
  disconnect(): Promise<void>;
}

interface PhantomProvider {
  isPhantom?: boolean;
  publicKey?: { toString(): string } | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } }>;
  disconnect(): Promise<void>;
  signTransaction<T extends VersionedTransaction>(tx: T): Promise<T>;
  on?(event: string, cb: (...a: unknown[]) => void): void;
}

declare global {
  interface Window {
    phantom?: { solana?: PhantomProvider };
    solana?: PhantomProvider;
  }
}

export function phantomProvider(): PhantomProvider | null {
  if (typeof window === "undefined") return null;
  const p = window.phantom?.solana ?? window.solana;
  return p && p.isPhantom ? p : null;
}

export function phantomAvailable(): boolean {
  return phantomProvider() != null;
}

/** Why Phantom is / isn't usable right now, for the UI. */
export function phantomNote(): string {
  if (isTauri) return "Browser-extension wallets cannot inject into a desktop webview. Use the LOCAL SIGNER (vault-encrypted key) here, or open the UI in a browser (npm run dev) to trade with Phantom.";
  if (!phantomAvailable()) return "Phantom extension not detected in this browser.";
  return "Phantom detected.";
}

export async function connectPhantom(): Promise<Signer> {
  const p = phantomProvider();
  if (!p) throw new Error(phantomNote());
  const res = await p.connect();
  const publicKey = new PublicKey(res.publicKey.toString());
  return {
    kind: "phantom",
    publicKey,
    signTransaction: (tx) => p.signTransaction(tx),
    disconnect: () => p.disconnect(),
  };
}

export async function localSignerStatus(): Promise<SolLocalStatus> {
  return invoke<SolLocalStatus>("sol_local_status");
}

export async function connectLocal(): Promise<Signer> {
  const st = await localSignerStatus();
  if (!st.exists || !st.pubkey) throw new Error("no local signer yet - create or import one in VAULT > SOL SIGNER");
  if (!st.vault_unlocked) throw new Error("vault is locked - unlock it in SETTINGS to sign");
  const publicKey = new PublicKey(st.pubkey);
  return {
    kind: "local",
    publicKey,
    signTransaction: async (tx) => {
      const msg = Buffer.from(tx.message.serialize()).toString("base64");
      const sigB64 = await invoke<string>("sol_local_sign", { message: msg, purpose: "jupiter_swap" });
      tx.addSignature(publicKey, new Uint8Array(Buffer.from(sigB64, "base64")));
      return tx;
    },
    disconnect: async () => {},
  };
}
