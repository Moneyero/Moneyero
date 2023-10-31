/**
 * Browser-side exposure checks. These run in any browser, including browser mode, and show
 * what a web page can learn about a visitor's connection. They are real requests to real
 * third-party services, named in the UI.
 */

export interface IpInfo {
  ip: string | null;
  org: string | null;
  country: string | null;
  city: string | null;
  source: string;
  error?: string;
}

export async function publicIp(): Promise<IpInfo> {
  try {
    const r = await fetch("https://api.ipify.org?format=json", { cache: "no-store" });
    const { ip } = (await r.json()) as { ip: string };
    let org: string | null = null, country: string | null = null, city: string | null = null;
    try {
      const g = await fetch(`https://ipapi.co/${ip}/json/`, { cache: "no-store" });
      const j = (await g.json()) as { org?: string; country_name?: string; city?: string };
      org = j.org ?? null;
      country = j.country_name ?? null;
      city = j.city ?? null;
    } catch {
      /* geo optional */
    }
    return { ip, org, country, city, source: "api.ipify.org + ipapi.co" };
  } catch (e) {
    return { ip: null, org: null, country: null, city: null, source: "api.ipify.org", error: String(e) };
  }
}

export interface WebRtcResult {
  candidates: { ip: string; type: string }[];
  publicIps: string[];
  supported: boolean;
}

/** Gathers ICE candidates. A server-reflexive (srflx) address that differs from the HTTP IP means WebRTC bypasses your proxy/VPN. */
export function webrtcLeak(timeoutMs = 4000): Promise<WebRtcResult> {
  return new Promise((resolve) => {
    if (typeof RTCPeerConnection === "undefined") return resolve({ candidates: [], publicIps: [], supported: false });
    const seen = new Map<string, string>();
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    const finish = () => {
      try {
        pc.close();
      } catch {
        /* closed */
      }
      const candidates = [...seen.entries()].map(([ip, type]) => ({ ip, type }));
      resolve({ candidates, publicIps: candidates.filter((c) => c.type === "srflx").map((c) => c.ip), supported: true });
    };
    pc.createDataChannel("x");
    pc.onicecandidate = (e) => {
      if (!e.candidate) return finish();
      const m = /candidate:\S+ \d+ \S+ \d+ (\S+) \d+ typ (\w+)/.exec(e.candidate.candidate);
      if (m && !m[1].endsWith(".local")) seen.set(m[1], m[2]);
    };
    pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(finish);
    setTimeout(finish, timeoutMs);
  });
}

export interface DnsLeakBrowser {
  ok: boolean;
  servers: { ip: string; country: string; asn: string }[];
  yourIp: { ip: string; country: string }[];
  error?: string;
}

/** bash.ws DNS leak test from the browser: trigger lookups by loading images, then read the report. */
export async function dnsLeakBrowser(): Promise<DnsLeakBrowser> {
  try {
    const id = (await (await fetch("https://bash.ws/id", { cache: "no-store" })).text()).trim();
    if (!/^\d+$/.test(id)) throw new Error("no test id");
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        new Promise<void>((res) => {
          const img = new Image();
          img.onload = img.onerror = () => res();
          img.src = `https://${id}.${i + 1}.bash.ws/`;
          setTimeout(res, 3500);
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 800));
    const rows = (await (await fetch(`https://bash.ws/dnsleak/test/${id}?json`, { cache: "no-store" })).json()) as { ip: string; country: string; country_name: string; asn: string; type: string }[];
    return {
      ok: true,
      servers: rows.filter((r) => r.type === "dns").map((r) => ({ ip: r.ip, country: r.country_name, asn: r.asn })),
      yourIp: rows.filter((r) => r.type === "ip").map((r) => ({ ip: r.ip, country: r.country_name })),
    };
  } catch (e) {
    return { ok: false, servers: [], yourIp: [], error: String(e) };
  }
}
