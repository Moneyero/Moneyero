import { create } from "zustand";
import { invoke, isTauri } from "./tauri";
import type { Proposal, VaultStatus } from "./types";
import { errMsg } from "./format";

export type View = "terminal" | "vault" | "exchange" | "agent" | "network" | "activity" | "settings";

export interface Toast {
  id: number;
  level: "info" | "ok" | "warn" | "err";
  msg: string;
}

export interface WalletState {
  kind: "phantom" | "local" | null;
  pubkey: string | null;
}

export interface NetSummary {
  proxyEnabled: boolean;
  torReachable: boolean;
  tunnelUp: boolean;
  tunnelName: string | null;
  /** Built-in userspace WireGuard tunnel (covers all app traffic). */
  vpnUp: boolean;
  vpnName: string | null;
}

export interface TreasuryBalances {
  sol: number;
  usdc: number;
  solTokensUsd: number;
  xmr: number;
  zec: number;
  zecTransparent: number;
  xmrOpen: boolean;
  zecReachable: boolean;
}

/** Cross-view hand-off: an approved agent proposal waiting to be executed through a manual flow. */
export interface Handoff {
  proposal: Proposal;
}

interface AppStore {
  view: View;
  setView: (v: View) => void;

  settings: Record<string, string>;
  loadSettings: () => Promise<void>;
  setSetting: (key: string, value: string) => Promise<void>;
  s: (key: string, fallback?: string) => string;
  sb: (key: string) => boolean;

  vault: VaultStatus | null;
  refreshVault: () => Promise<void>;

  wallet: WalletState;
  setWallet: (w: WalletState) => void;

  prices: Record<string, number>;
  setPrices: (p: Record<string, number>) => void;

  net: NetSummary;
  setNet: (n: Partial<NetSummary>) => void;

  treasury: TreasuryBalances;
  setTreasury: (t: Partial<TreasuryBalances>) => void;
  realizedPnl: number;
  unrealizedPnl: number;
  setPnl: (r: number, u: number) => void;

  handoff: Handoff | null;
  setHandoff: (h: Handoff | null) => void;

  toasts: Toast[];
  toast: (msg: string, level?: Toast["level"]) => void;
  dismiss: (id: number) => void;
}

let toastSeq = 1;
const BROWSER_SETTINGS_KEY = "bb.settings.browser";

const VIEWS: View[] = ["terminal", "vault", "exchange", "agent", "network", "activity", "settings"];
const qs = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
const initialView = (VIEWS.find((v) => v === qs.get("view")) ?? "terminal") as View;

export const useApp = create<AppStore>((set, get) => ({
  view: initialView,
  setView: (view) => set({ view }),

  settings: {},
  loadSettings: async () => {
    if (!isTauri) {
      // Browser mode: a handful of trading settings, kept in this browser only.
      try {
        set({ settings: JSON.parse(localStorage.getItem(BROWSER_SETTINGS_KEY) ?? "{}") });
      } catch {
        set({ settings: {} });
      }
      return;
    }
    try {
      const settings = await invoke<Record<string, string>>("settings_all");
      set({ settings });
    } catch (e) {
      get().toast(`settings: ${errMsg(e)}`, "err");
    }
  },
  setSetting: async (key, value) => {
    const settings = { ...get().settings, [key]: value };
    set({ settings });
    if (!isTauri) {
      try {
        localStorage.setItem(BROWSER_SETTINGS_KEY, JSON.stringify(settings));
      } catch {
        /* private window or storage blocked: the value still applies until reload */
      }
      return;
    }
    try {
      await invoke("settings_set", { key, value });
    } catch (e) {
      get().toast(`save ${key}: ${errMsg(e)}`, "err");
    }
  },
  s: (key, fallback = "") => get().settings[key] ?? fallback,
  sb: (key) => ["true", "1", "yes", "on"].includes((get().settings[key] ?? "").toLowerCase()),

  vault: null,
  refreshVault: async () => {
    if (!isTauri) return;
    try {
      set({ vault: await invoke<VaultStatus>("vault_status") });
    } catch (e) {
      get().toast(`vault: ${errMsg(e)}`, "err");
    }
  },

  wallet: { kind: null, pubkey: null },
  setWallet: (wallet) => set({ wallet }),

  prices: {},
  setPrices: (p) => set({ prices: { ...get().prices, ...p } }),

  net: { proxyEnabled: false, torReachable: false, tunnelUp: false, tunnelName: null, vpnUp: false, vpnName: null },
  setNet: (n) => set({ net: { ...get().net, ...n } }),

  treasury: { sol: 0, usdc: 0, solTokensUsd: 0, xmr: 0, zec: 0, zecTransparent: 0, xmrOpen: false, zecReachable: false },
  setTreasury: (t) => set({ treasury: { ...get().treasury, ...t } }),
  realizedPnl: 0,
  unrealizedPnl: 0,
  setPnl: (realizedPnl, unrealizedPnl) => set({ realizedPnl, unrealizedPnl }),

  handoff: null,
  setHandoff: (handoff) => set({ handoff }),

  toasts: [],
  toast: (msg, level = "info") => {
    const id = toastSeq++;
    set({ toasts: [...get().toasts, { id, level, msg }].slice(-6) });
    setTimeout(() => get().dismiss(id), level === "err" ? 9000 : 5000);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));
