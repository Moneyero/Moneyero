import { useCallback, useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { invoke, isTauri } from "../lib/tauri";
import type { DnsLeakResult, IpCheck, NetLogRow, NetStatus, VpnStatus } from "../lib/types";
import { ago, bytes, errMsg, ts } from "../lib/format";
import { networkWarnings } from "../lib/privacy";
import { dnsLeakBrowser, publicIp, webrtcLeak, type DnsLeakBrowser, type IpInfo, type WebRtcResult } from "../lib/leaks";
import { Banner, Btn, Chip, Dot, Empty, ErrLine, Field, Input, Kv, Panel, Select, TextArea, Td, Th, Warnings } from "../components/ui";

export default function Network() {
  const { settings, setSetting, setNet, toast } = useApp();
  const [st, setSt] = useState<NetStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [ip, setIp] = useState<IpCheck | null>(null);
  const [ipDirect, setIpDirect] = useState<IpCheck | null>(null);
  const [dns, setDns] = useState<DnsLeakResult | null>(null);
  const [log, setLog] = useState<NetLogRow[]>([]);
  const [imp, setImp] = useState({ name: "", content: "" });
  const [out, setOut] = useState<string>("");
  const [vpn, setVpn] = useState<VpnStatus | null>(null);
  const [vpnSel, setVpnSel] = useState("");
  const [vpnExit, setVpnExit] = useState<{ ip?: string; is_tor?: boolean; via?: string } | null>(null);

  const load = useCallback(async () => {
    if (!isTauri) return;
    try {
      const s = await invoke<NetStatus>("net_status");
      setSt(s);
      setErr(null);
      const t = s.tunnels.find((x) => x.handshake_fresh) ?? s.tunnels[0];
      const v = await invoke<VpnStatus>("vpn_status").catch(() => null);
      setVpn(v);
      setNet({ proxyEnabled: s.proxy_enabled, torReachable: s.tor_socks_reachable, tunnelUp: !!t, tunnelName: t?.interface ?? null, vpnUp: !!(v?.running && v.handshake_age_secs != null), vpnName: v?.name ?? null });
      setLog(await invoke<NetLogRow[]>("net_log_list", { limit: 80 }));
    } catch (e) {
      setErr(errMsg(e));
    }
  }, [setNet]);

  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      toast(errMsg(e), "err");
    } finally {
      setBusy(null);
      load();
    }
  };

  if (!isTauri) {
    return <BrowserExposure />;
  }

  const vpnUp = !!(vpn?.running && vpn.handshake_age_secs != null);
  const tunnelUp = (st?.tunnels.length ?? 0) > 0 || vpnUp;
  const warnings = networkWarnings({ proxyEnabled: !!st?.proxy_enabled, torReachable: !!st?.tor_socks_reachable, tunnelUp });
  const dnsCountries = new Set(dns?.dns_servers.map((d) => d.country));
  const ipCountry = dns?.your_ip[0]?.country;
  const dnsLeak = dns && dns.dns_servers.length > 0 && ipCountry && [...dnsCountries].some((c) => c && c !== ipCountry);

  return (
    <div className="view">
      <ErrLine e={err} />
      <Warnings items={warnings} />
      <Panel
        title="Built-in VPN · userspace WireGuard"
        right={vpnUp ? <Chip tone="ok">connected · {vpn?.name}</Chip> : vpn?.running ? <Chip tone="warn">handshaking…</Chip> : <Chip>off</Chip>}
      >
        <div className="row">
          <div className="col grow">
            <div className="small muted">
              WireGuard runs inside Moneyero: no driver, no Administrator, no WireGuard install. Every request the app makes (Solana RPC, Jupiter, GeckoTerminal, swap providers, Claude, the Monero daemon link) exits through this tunnel. If the tunnel drops, those requests fail instead of leaking. It does not cover other programs or browser extensions.
            </div>
            <div className="row ac wrap">
              <Field label="config (import below)" style={{ width: 240 }}>
                <Select value={vpnSel || vpn?.name || ""} onChange={(e) => setVpnSel(e.target.value)} disabled={vpnUp}>
                  <option value="">select…</option>
                  {st?.configs.map((c) => <option key={c.name} value={c.name}>{c.name} · {c.endpoint ?? "?"}</option>)}
                </Select>
              </Field>
              {!vpn?.running ? (
                <Btn variant="primary" style={{ marginTop: 14 }} busy={busy === "vpn-up"} disabled={!(vpnSel || st?.configs[0]?.name)} onClick={() => run("vpn-up", async () => { const s = await invoke<VpnStatus>("vpn_connect", { name: vpnSel || st!.configs[0].name }); setVpn(s); setVpnExit(null); toast(`VPN up: ${s.name} → ${s.resolved_endpoint}`, "ok"); })}>connect</Btn>
              ) : (
                <Btn variant="danger" style={{ marginTop: 14 }} busy={busy === "vpn-down"} onClick={() => run("vpn-down", async () => { setVpn(await invoke<VpnStatus>("vpn_disconnect")); setVpnExit(null); })}>disconnect</Btn>
              )}
              <Btn variant="ghost" style={{ marginTop: 14 }} disabled={!vpnUp} busy={busy === "vpn-exit"} onClick={() => run("vpn-exit", async () => setVpnExit(await invoke("vpn_exit_check")))}>prove exit IP via tunnel</Btn>
            </div>
            {vpnExit && <Banner tone="ok">Exit through tunnel: <b>{vpnExit.ip ?? "?"}</b>{vpnExit.is_tor ? " (Tor exit)" : ""} <span className="dim">· {vpnExit.via}</span></Banner>}
          </div>
          <div style={{ width: 420 }}>
            <Kv items={[
              ["state", vpnUp ? <span className="ok">connected</span> : vpn?.running ? <span className="warn">waiting for handshake</span> : <span className="muted">off</span>],
              ["endpoint", vpn?.endpoint ? <span>{vpn.endpoint} <span className="dim">→ {vpn.resolved_endpoint}</span></span> : "-"],
              ["tunnel ip", vpn?.tunnel_address ?? "-"],
              ["dns via tunnel", vpn?.dns.join(", ") || "-"],
              ["last handshake", vpn?.handshake_age_secs != null ? `${vpn.handshake_age_secs}s ago` : "never"],
              ["traffic", vpn ? `↑ ${bytes(vpn.tx_bytes)} ↓ ${bytes(vpn.rx_bytes)} · ${vpn.connections} conn` : "-"],
              ["local socks", vpn ? `127.0.0.1:${vpn.socks_port} (app only)` : "-"],
              ["kill switch", vpnUp ? <span className="ok">inherent: no tunnel, no requests</span> : <span className="dim">-</span>],
            ]} />
            {vpn?.last_error && <ErrLine e={vpn.last_error} />}
          </div>
        </div>
      </Panel>
      <div className="row">
        <Panel title="Status" className="grow">
          <Kv
            items={[
              ["platform", st?.platform ?? "-"],
              ["wireguard", <span><Dot state={st?.wireguard_found ? "ok" : "err"} /> {st?.wireguard_bin}</span>],
              ["wg", <span><Dot state={st?.wg_found ? "ok" : "err"} /> {st?.wg_bin} {st?.wg_error ? <span className="warn"> · {st.wg_error}</span> : null}</span>],
              ["tunnel", tunnelUp ? <span className="ok">{st!.tunnels.map((t) => t.interface).join(", ")} up</span> : <span className="warn">none</span>],
              ["kill switch", <span className={st?.kill_switch.state === "likely_on" ? "ok" : st?.kill_switch.state === "off" ? "warn" : "muted"}>{st?.kill_switch.state} <span className="dim">· {st?.kill_switch.reason}</span></span>],
              ["app proxy", st?.proxy_enabled ? <span className="ok">ON {st.proxy_url}</span> : <span className="muted">off</span>],
              ["tor socks", st?.tor_socks_reachable ? <span className="ok">reachable</span> : <span className="dim">not listening</span>],
            ]}
          />
        </Panel>
        <Panel title="Proxy / Tor" style={{ width: 420 }}>
          <div className="small muted">When ON, every outbound request from Moneyero (RPC, Jupiter, GeckoTerminal, swap providers, Claude API, monero-wallet-rpc daemon link) is sent through this SOCKS proxy. Loopback RPC is exempt. If the proxy is down, requests fail closed.</div>
          <Field label="proxy url"><Input mono value={settings["net.proxy_url"] ?? ""} onChange={(e) => setSetting("net.proxy_url", e.target.value)} /></Field>
          <div className="row ac">
            <Btn variant={st?.proxy_enabled ? "danger" : "primary"} onClick={() => run("proxy", async () => { await setSetting("net.proxy_enabled", st?.proxy_enabled ? "false" : "true"); })}>
              {st?.proxy_enabled ? "disable proxy" : "enable proxy"}
            </Btn>
            <span className="dim small">Tor daemon default 9050 · Tor Browser 9150</span>
          </div>
        </Panel>
      </div>

      <div className="row">
        <Panel title="WireGuard tunnels" className="grow" tight>
          <table className="tbl">
            <thead><tr><Th>iface</Th><Th>peer endpoint</Th><Th>allowed ips</Th><Th>handshake</Th><Th num>rx</Th><Th num>tx</Th><Th></Th></tr></thead>
            <tbody>
              {st?.tunnels.flatMap((t) =>
                (t.peers.length ? t.peers : [null]).map((p, i) => (
                  <tr key={`${t.interface}-${i}`}>
                    <Td><span className="ok">{t.interface}</span></Td>
                    <Td>{p?.endpoint ?? "-"}</Td>
                    <Td className="dim">{p?.allowed_ips.join(", ") ?? "-"}</Td>
                    <Td className={t.handshake_fresh ? "ok" : "warn"}>{p?.latest_handshake ? `${ago(p.latest_handshake)} ago` : "never"}</Td>
                    <Td num>{p ? bytes(p.rx_bytes) : "-"}</Td>
                    <Td num>{p ? bytes(p.tx_bytes) : "-"}</Td>
                    <Td><Btn size="xs" variant="danger" busy={busy === `down-${t.interface}`} onClick={() => run(`down-${t.interface}`, async () => { const r = await invoke<{ ok: boolean; output: string }>("net_down", { name: t.interface }); setOut(r.output); })}>down</Btn></Td>
                  </tr>
                )),
              )}
              {!st?.tunnels.length && <tr><Td colSpan={7}><Empty>no active tunnel{st?.wg_error ? " (or wg cannot read tunnel state - see status)" : ""}</Empty></Td></tr>}
            </tbody>
          </table>
          <div style={{ padding: 6 }} className="dim xs">Server selection = pick a config below. Windows: tunnel install needs Administrator; run Moneyero elevated or install the tunnel once via the WireGuard app, after which status is read here.</div>
        </Panel>
        <Panel title="Configs (servers)" style={{ width: 460 }} tight>
          <table className="tbl">
            <thead><tr><Th>name</Th><Th>endpoint</Th><Th>mode</Th><Th>dns</Th><Th></Th></tr></thead>
            <tbody>
              {st?.configs.map((c) => (
                <tr key={c.name}>
                  <Td>{c.name}</Td>
                  <Td className="dim">{c.endpoint ?? "-"}</Td>
                  <Td>{c.full_tunnel ? <Chip tone="ok">full</Chip> : <Chip tone="warn">split</Chip>}</Td>
                  <Td className="dim">{c.dns.join(",") || <span className="warn">none</span>}</Td>
                  <Td className="nowrap">
                    <Btn size="xs" variant="primary" busy={busy === `up-${c.name}`} onClick={() => run(`up-${c.name}`, async () => { const r = await invoke<{ ok: boolean; output: string }>("net_up", { name: c.name }); setOut(r.output); if (!r.ok) toast(r.output || "tunnel up failed", "err"); })}>up</Btn>{" "}
                    <Btn size="xs" variant="ghost" onClick={() => run(`del-${c.name}`, () => invoke("net_config_delete", { name: c.name }))}>del</Btn>
                  </Td>
                </tr>
              ))}
              {!st?.configs.length && <tr><Td colSpan={5}><Empty>no configs imported</Empty></Td></tr>}
            </tbody>
          </table>
          <div style={{ padding: 6 }} className="col">
            <div className="row">
              <Field label="name (≤15 chars)" style={{ width: 160 }}><Input mono value={imp.name} onChange={(e) => setImp({ ...imp, name: e.target.value })} placeholder="mullvad-se1" /></Field>
            </div>
            <Field label="wireguard .conf contents" hint="Stored in the app data dir, not in the vault; the private key must be readable by WireGuard itself."><TextArea rows={5} value={imp.content} onChange={(e) => setImp({ ...imp, content: e.target.value })} placeholder={"[Interface]\nPrivateKey = ...\nAddress = ...\nDNS = ...\n\n[Peer]\nPublicKey = ...\nAllowedIPs = 0.0.0.0/0, ::/0\nEndpoint = host:51820"} /></Field>
            <Btn size="sm" disabled={!imp.name || !imp.content} onClick={() => run("import", async () => { await invoke("net_config_import", { name: imp.name, content: imp.content }); setImp({ name: "", content: "" }); })}>import config</Btn>
          </div>
        </Panel>
      </div>

      <div className="row">
        <Panel title="Exit IP" className="grow">
          <div className="row">
            <Btn busy={busy === "ip"} onClick={() => run("ip", async () => setIp(await invoke<IpCheck>("net_ip_check", { direct: false })))}>check via app path</Btn>
            <Btn variant="ghost" busy={busy === "ipd"} title="Bypasses the proxy on purpose to show your underlying address. Reveals it to the check service." onClick={() => run("ipd", async () => setIpDirect(await invoke<IpCheck>("net_ip_check", { direct: true })))}>check direct (reveals real IP)</Btn>
          </div>
          {ip && <Kv items={[["app path", <span><b className={ip.is_tor ? "ok" : ""}>{ip.ip ?? "?"}</b> {ip.is_tor === true && <Chip tone="ok">tor exit</Chip>} {ip.is_tor === false && <Chip tone="warn">not tor</Chip>} {ip.via_proxy && <Chip>via proxy</Chip>} {ip.geo ? <span className="dim"> {ip.geo.country} · {ip.geo.org}</span> : null} {ip.error && <span className="err">{ip.error}</span>}</span>], ["source", <span className="dim">{ip.source}</span>]]} />}
          {ipDirect && <Kv items={[["direct", <span><b>{ipDirect.ip ?? "?"}</b> {ipDirect.is_tor === false && !tunnelUp && <Chip tone="err">real address</Chip>} {ipDirect.is_tor === false && tunnelUp && <Chip tone="ok">vpn exit</Chip>} {ipDirect.error && <span className="err">{ipDirect.error}</span>}</span>]]} />}
          {ip && ipDirect && ip.ip && ipDirect.ip && ip.ip === ipDirect.ip && !tunnelUp && <Banner tone="err">Proxy path and direct path show the same address: the proxy is not changing your exit.</Banner>}
        </Panel>
        <Panel title="DNS leak test" className="grow" right={<span className="dim xs">bash.ws</span>}>
          <div className="small muted">Resolves 10 unique hostnames through the OS resolver, then asks the authoritative server which resolvers it saw. If resolvers outside your VPN/Tor path show up, DNS is leaking.</div>
          <Btn busy={busy === "dns"} onClick={() => run("dns", async () => setDns(await invoke<DnsLeakResult>("net_dns_leak")))}>run test</Btn>
          {dns && (
            <>
              {dnsLeak ? <Banner tone="err">DNS LEAK: resolver country differs from exit IP country.</Banner> : dns.dns_servers.length ? <Banner tone="ok">{dns.dns_servers.length} resolver(s) seen, consistent with exit ({ipCountry}).</Banner> : <Banner tone="warn">No resolvers observed (DNS may be blocked or cached).</Banner>}
              <table className="tbl dense">
                <thead><tr><Th>type</Th><Th>ip</Th><Th>country</Th><Th>asn</Th></tr></thead>
                <tbody>
                  {dns.your_ip.map((r, i) => <tr key={`i${i}`}><Td>exit ip</Td><Td>{r.ip}</Td><Td>{r.country}</Td><Td className="dim">{r.asn}</Td></tr>)}
                  {dns.dns_servers.map((r, i) => <tr key={`d${i}`}><Td className="muted">dns</Td><Td>{r.ip}</Td><Td className={r.country !== ipCountry ? "err" : ""}>{r.country}</Td><Td className="dim">{r.asn}</Td></tr>)}
                </tbody>
              </table>
              {dns.conclusion && <div className="dim xs">service verdict: {dns.conclusion}</div>}
            </>
          )}
        </Panel>
      </div>

      {out && <Panel title="last command output"><pre className="logbox">{out}</pre></Panel>}

      <Panel title="Connection log" tight>
        <table className="tbl dense">
          <thead><tr><Th w={150}>time</Th><Th w={140}>event</Th><Th>detail</Th></tr></thead>
          <tbody>
            {log.map((r) => <tr key={r.id}><Td className="dim">{ts(r.ts)}</Td><Td className={r.event.includes("fail") ? "err" : ""}>{r.event}</Td><Td wrap className="muted">{r.detail}</Td></tr>)}
            {!log.length && <tr><Td colSpan={3}><Empty>empty</Empty></Td></tr>}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

/** Browser mode: no tunnel control possible from a web page, but the exposure checks are real. */
function BrowserExposure() {
  const [ip, setIp] = useState<IpInfo | null>(null);
  const [rtc, setRtc] = useState<WebRtcResult | null>(null);
  const [dns, setDns] = useState<DnsLeakBrowser | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const runIp = async () => {
    setBusy("ip");
    setIp(await publicIp());
    setBusy(null);
  };
  const runRtc = async () => {
    setBusy("rtc");
    setRtc(await webrtcLeak());
    setBusy(null);
  };
  const runDns = async () => {
    setBusy("dns");
    setDns(await dnsLeakBrowser());
    setBusy(null);
  };
  useEffect(() => {
    runIp();
    runRtc();
  }, []);

  const rtcLeak = ip?.ip && rtc?.publicIps.length ? rtc.publicIps.some((x) => x !== ip.ip) : false;
  const dnsCountries = new Set(dns?.servers.map((s) => s.country));
  const dnsLeak = dns?.ok && dns.yourIp[0] && [...dnsCountries].some((c) => c && c !== dns.yourIp[0].country);

  return (
    <div className="view">
      <Banner tone="or">
        <b>BROWSER MODE</b> A web page cannot start a VPN or change your network path. It can show you what every site you visit learns about this connection. The desktop build adds the Tor switch, WireGuard control, kill-switch state and the same tests through the app's own network path.
      </Banner>
      <div className="row">
        <Panel title="What this page can see" className="grow" right={<Btn size="xs" busy={busy === "ip"} onClick={runIp}>re-check</Btn>}>
          <Kv items={[
            ["your ip", ip ? (ip.ip ? <b>{ip.ip}</b> : <span className="err">{ip.error ?? "unknown"}</span>) : <span className="dim">checking…</span>],
            ["provider", ip?.org ?? "-"],
            ["location", ip ? [ip.city, ip.country].filter(Boolean).join(", ") || "-" : "-"],
            ["seen by", <span className="dim">{ip?.source ?? "-"} (third parties, named on purpose)</span>],
          ]} />
          {ip?.ip && <Banner tone="warn">Every RPC node, API and swap provider you use from this browser sees this address unless you run a VPN or Tor Browser.</Banner>}
        </Panel>
        <Panel title="WebRTC leak" className="grow" right={<Btn size="xs" busy={busy === "rtc"} onClick={runRtc}>re-check</Btn>}>
          {!rtc ? <Empty>gathering ICE candidates…</Empty> : !rtc.supported ? <Empty>WebRTC not available</Empty> : (
            <>
              <Kv items={[
                ["public via stun", rtc.publicIps.length ? rtc.publicIps.join(", ") : <span className="dim">none</span>],
                ["candidates", <span className="dim">{rtc.candidates.map((c) => `${c.ip} (${c.type})`).join(", ") || "none"}</span>],
              ]} />
              {rtcLeak ? <Banner tone="err">WebRTC exposes a different address than HTTP: your VPN or proxy is being bypassed.</Banner> : rtc.publicIps.length ? <Banner tone="ok">WebRTC address matches your HTTP address.</Banner> : <Banner tone="info">No server-reflexive candidate; WebRTC is blocked or STUN unreachable.</Banner>}
            </>
          )}
        </Panel>
      </div>
      <Panel title="DNS leak test · bash.ws" right={<Btn size="xs" busy={busy === "dns"} onClick={runDns}>run</Btn>}>
        <div className="small muted">Loads ten unique hostnames so your operating system resolves them, then asks bash.ws which resolvers hit its nameserver.</div>
        {dns && (dns.ok ? (
          <>
            {dnsLeak ? <Banner tone="err">DNS LEAK: a resolver outside your exit country answered.</Banner> : dns.servers.length ? <Banner tone="ok">{dns.servers.length} resolver(s), consistent with {dns.yourIp[0]?.country}.</Banner> : <Banner tone="warn">No resolvers observed.</Banner>}
            <table className="tbl dense">
              <thead><tr><Th>type</Th><Th>ip</Th><Th>country</Th><Th>asn</Th></tr></thead>
              <tbody>
                {dns.yourIp.map((r, i) => <tr key={`i${i}`}><Td>exit ip</Td><Td>{r.ip}</Td><Td>{r.country}</Td><Td></Td></tr>)}
                {dns.servers.map((r, i) => <tr key={`d${i}`}><Td className="muted">dns</Td><Td>{r.ip}</Td><Td>{r.country}</Td><Td className="dim">{r.asn}</Td></tr>)}
              </tbody>
            </table>
          </>
        ) : <Banner tone="warn">Test could not run from this browser ({dns.error}). The desktop build runs it from the Rust side.</Banner>)}
      </Panel>
      <Panel title="What the desktop build adds">
        <ul className="small muted" style={{ margin: 0, paddingLeft: 16 }}>
          <li><b>Tor switch</b>: one setting routes every request the app makes through a SOCKS5 proxy; fails closed if Tor is down.</li>
          <li><b>WireGuard</b>: import configs, bring tunnels up and down, live handshake and transfer stats, inferred kill-switch state.</li>
          <li><b>Exit-IP check through the app path</b>, Tor exit detection, and the DNS test run by the Rust process rather than the browser.</li>
          <li><b>Monero daemon over Tor</b>: monero-wallet-rpc is started with the proxy when the switch is on.</li>
        </ul>
      </Panel>
    </div>
  );
}
