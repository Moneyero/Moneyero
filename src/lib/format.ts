export function fmt(n: number | null | undefined, dp = 4): string {
  if (n == null || !isFinite(n)) return "-";
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (Math.abs(n) >= 1e4) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return n.toLocaleString("en-US", { maximumFractionDigits: dp, minimumFractionDigits: 0 });
}

export function fmtPrice(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "-";
  if (n === 0) return "0";
  if (n < 0.0001) return n.toExponential(2);
  if (n < 1) return n.toFixed(6);
  if (n < 100) return n.toFixed(4);
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function usd(n: number | null | undefined, dp = 2): string {
  if (n == null || !isFinite(n)) return "-";
  const sign = n < 0 ? "-" : "";
  const a = Math.abs(n);
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${a.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  return `${sign}$${a.toFixed(dp)}`;
}

export function pct(n: number | null | undefined, dp = 2): string {
  if (n == null || !isFinite(n)) return "-";
  return `${n > 0 ? "+" : ""}${n.toFixed(dp)}%`;
}

export function short(s: string | null | undefined, head = 6, tail = 6): string {
  if (!s) return "-";
  if (s.length <= head + tail + 3) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

export function ts(t: number | null | undefined): string {
  if (!t) return "-";
  const d = new Date(t > 1e12 ? t : t * 1000);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function hms(t: number | null | undefined): string {
  if (!t) return "-";
  const d = new Date(t > 1e12 ? t : t * 1000);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function ago(t: number | null | undefined): string {
  if (!t) return "-";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - (t > 1e12 ? t / 1000 : t)));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)}K`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)}M`;
  return `${(n / 1024 ** 3).toFixed(2)}G`;
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function toBaseUnits(amount: string, decimals: number): bigint {
  const s = amount.trim();
  if (!/^\d*(\.\d*)?$/.test(s) || s === "" || s === ".") throw new Error("invalid amount");
  const [i, f = ""] = s.split(".");
  if (f.length > decimals) throw new Error(`max ${decimals} decimals`);
  return BigInt(i || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export function fromBaseUnits(v: string | number | bigint, decimals: number): number {
  return Number(v) / 10 ** decimals;
}
