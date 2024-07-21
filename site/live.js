// Live parts of the front page: the price chart and the exposure readout.
// All numbers come from CoinGecko at page load. Nothing is hard-coded, nothing is animated.
import { createChart, ColorType, CrosshairMode, LineStyle } from "lightweight-charts";
import { COINS, gecko } from "/site/site.js";
import { publicIp, webrtcLeak } from "/src/lib/leaks.ts";

const host = document.getElementById("herochart");
let chart, series, current = "XMR";
const cache = {};

async function load(sym) {
  if (cache[sym]) return cache[sym];
  const j = await gecko(`coins/${COINS[sym].id}/market_chart?vs_currency=usd&days=90&interval=daily`, 300_000);
  const out = [];
  const seen = new Set();
  for (const [t, p] of j.prices) {
    const day = Math.floor(t / 86400000) * 86400;
    if (seen.has(day)) continue;
    seen.add(day);
    out.push({ time: day, value: p });
  }
  cache[sym] = out;
  return out;
}

function build() {
  chart = createChart(host, {
    layout: { background: { type: ColorType.Solid, color: "#ffffff" }, textColor: "#5a554c", fontFamily: "Verdana, Arial, sans-serif", fontSize: 10, attributionLogo: false },
    grid: { vertLines: { color: "#eeebe4" }, horzLines: { color: "#eeebe4" } },
    rightPriceScale: { borderColor: "#d6d0c4", scaleMargins: { top: 0.12, bottom: 0.1 } },
    timeScale: { borderColor: "#d6d0c4", fixLeftEdge: true, fixRightEdge: true },
    crosshair: { mode: CrosshairMode.Magnet, vertLine: { color: "#999", labelBackgroundColor: "#555", style: LineStyle.Solid }, horzLine: { color: "#999", labelBackgroundColor: "#555", style: LineStyle.Solid } },
    handleScroll: false,
    handleScale: false,
  });
  const ro = new ResizeObserver(() => chart.applyOptions({ width: host.clientWidth, height: host.clientHeight }));
  ro.observe(host);
}

const num = (v) => v.toLocaleString("en-US", { maximumFractionDigits: v < 10 ? 3 : 2, minimumFractionDigits: 2 });
const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };

async function show(sym) {
  current = sym;
  for (const b of document.querySelectorAll("[data-coin]")) b.classList.toggle("on", b.dataset.coin === sym);
  const color = COINS[sym].color;
  set("chart-meta", `${sym}/USD · daily close · 90 days · coingecko`);
  const pts = await load(sym).catch(() => null);
  if (!pts || !pts.length) { set("chart-meta", `${sym}/USD · chart offline (rate limited, try again in a minute)`); return; }
  if (series) chart.removeSeries(series);
  const last = pts[pts.length - 1].value;
  series = chart.addAreaSeries({
    lineColor: color, lineWidth: 2, topColor: color + "33", bottomColor: color + "00",
    lastValueVisible: true, crosshairMarkerRadius: 3,
    priceLineVisible: true, priceLineColor: color, priceLineStyle: LineStyle.Dotted, priceLineWidth: 1,
    priceFormat: { type: "price", precision: last < 10 ? 3 : 2, minMove: last < 10 ? 0.001 : 0.01 },
  });
  series.setData(pts);
  chart.timeScale().fitContent();
  const first = pts[0].value;
  const lo = Math.min(...pts.map((p) => p.value)), hi = Math.max(...pts.map((p) => p.value));
  const ch = ((last - first) / first) * 100;
  set("f-last", `<b>$${num(last)}</b>`);
  set("f-chg", `<b class="${ch >= 0 ? "up" : "dn"}">${ch >= 0 ? "+" : ""}${ch.toFixed(1)}%</b>`);
  set("f-range", `<b>$${num(lo)} – $${num(hi)}</b>`);
}

if (host) {
  build();
  show("XMR");
  for (const b of document.querySelectorAll("[data-coin]")) b.addEventListener("click", () => b.dataset.coin !== current && show(b.dataset.coin));
}

// ---------------------------------------------------------------- exposure: what this page can see about the visitor
async function exposure() {
  const box = document.getElementById("expose");
  if (!box) return;
  const put = (k, v) => { const el = box.querySelector(`[data-x="${k}"]`); if (el) el.innerHTML = v; };
  const [ip, rtc] = await Promise.all([publicIp(), webrtcLeak()]);
  if (ip.ip) put("ip", ip.ip);
  else { put("ip", "unavailable (blocked or offline)"); box.querySelector("[data-x=ip]")?.classList.add("off"); }
  put("org", ip.org ?? "—");
  put("loc", [ip.city, ip.country].filter(Boolean).join(", ") || "—");
  if (!rtc.supported) put("rtc", "not available in this browser");
  else if (!rtc.publicIps.length) put("rtc", `<span class="up">no address exposed via STUN</span>`);
  else if (ip.ip && rtc.publicIps.some((x) => x !== ip.ip)) put("rtc", `<span class="dn">leak: ${rtc.publicIps.join(", ")} differs from your HTTP address</span>`);
  else put("rtc", `${rtc.publicIps.join(", ")} <span class="dim">(same as HTTP)</span>`);
  set("verdict", ip.ip
    ? `Every Solana RPC node, price API and swap service you touch from this browser sees <b>${ip.ip}</b> and can tie it to your wallet addresses. Moneyero routes its own traffic through WireGuard or Tor so that they do not.`
    : "Could not determine your address. The checks are blocked or offline.");
  for (const el of document.querySelectorAll("[data-ip-inline]")) el.textContent = ip.ip ?? "an address we could not read";
}
exposure();
