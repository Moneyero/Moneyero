import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { recordRequest } from "./observers";

/** True when running inside the Tauri webview (desktop). False in a plain browser (dev / Phantom mode). */
export const isTauri: boolean = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export class BackendUnavailable extends Error {
  constructor(cmd: string) {
    super(`${cmd}: backend unavailable (browser mode - run the desktop app for wallets, vault, VPN and agent)`);
  }
}

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) throw new BackendUnavailable(cmd);
  try {
    return await tauriInvoke<T>(cmd, args);
  } catch (e) {
    throw new Error(typeof e === "string" ? e : (e as Error)?.message ?? String(e));
  }
}

interface HttpResp {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function headersToRecord(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (h instanceof Headers) {
    h.forEach((v, k) => (out[k] = v));
  } else if (Array.isArray(h)) {
    for (const [k, v] of h) out[k] = v;
  } else {
    Object.assign(out, h);
  }
  return out;
}

/**
 * fetch() that is routed through the Rust HTTP client when running on desktop, so the
 * NETWORK proxy / Tor setting applies to market data, Solana RPC and swap providers alike.
 * Falls back to window.fetch in browser mode.
 */
export async function bridgedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  recordRequest(url);
  if (!isTauri) return fetch(input, init);
  const method = init?.method ?? (typeof input !== "string" && !(input instanceof URL) ? input.method : "GET");
  const headers = headersToRecord(init?.headers);
  let body: string | undefined;
  if (init?.body != null) {
    if (typeof init.body === "string") body = init.body;
    else if (init.body instanceof URLSearchParams) body = init.body.toString();
    else if (init.body instanceof ArrayBuffer || ArrayBuffer.isView(init.body)) body = new TextDecoder().decode(init.body as ArrayBuffer);
    else body = String(init.body);
  }
  const r = await tauriInvoke<HttpResp>("http_request", { req: { method, url, headers, body, timeout_secs: 45 } });
  return new Response(r.body, { status: r.status, headers: r.headers });
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await bridgedFetch(url, init);
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url.split("?")[0]}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`bad JSON from ${url.split("?")[0]}`);
  }
}
