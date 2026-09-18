// Shared forum chrome: header, tabs, news strip with live prices, breadcrumb, footer, number-key navigation.
// No analytics, no third-party scripts. The only outbound request is to CoinGecko for prices.

export const COINS = {
  XMR: { id: "monero", name: "Monero", color: "#ff6600", light: "#d64f00" },
  ZEC: { id: "zcash", name: "Zcash", color: "#e3ad2c", light: "#b8860b" },
  SOL: { id: "solana", name: "Solana", color: "#9945ff", light: "#6a2fd0" },
};

const X_URL = "https://x.com/TryMoneyero";
// Set to the repository URL once it is public; until then the icon points at the build instructions.
const GITHUB_URL = "download.html#build";

const NAV = [
  ["terminal.html", "Terminal"], ["vault.html", "Vault"], ["exchange.html", "Exchange"], ["agent.html", "Agent"],
  ["network.html", "Network"], ["privacy.html", "Security"], ["download.html", "Download"],
];
// Board each page lives in, for the breadcrumb.
const BOARD = {
  "guide.html": ["Newbies", "Beginner's guide"],
  "terminal.html": ["Trading (public ledger)", "Terminal"],
  "vault.html": ["Settlement (private)", "Vault"],
  "exchange.html": ["Settlement (private)", "Exchange"],
  "agent.html": ["Settlement (private)", "Agent"],
  "network.html": ["Infrastructure", "Network"],
  "privacy.html": ["Infrastructure", "Security and threat model"],
  "download.html": ["Infrastructure", "Download and build"],
};
// Cloudflare serves /vault for vault.html, the dev server serves /vault.html; normalise both.
const seg = location.pathname.replace(/\/+$/, "").split("/").pop() || "index";
const here = seg.endsWith(".html") ? seg : seg + ".html";

function clock() {
  const d = new Date();
  return d.toLocaleString("en-US", { month: "long", day: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

document.getElementById("hdr")?.insertAdjacentHTML(
  "afterbegin",
  `<div id="header"><div class="in">
    <a class="logo" href="index.html"><img src="/logo.svg" alt="" width="58" height="58" />Moneyero<small>Trade on Solana. Settle in Monero and Zcash. Your machine, your keys.</small></a>
    <div class="userbox">
      <div>Welcome, <b>Guest</b>. There is no login here and never will be. <a href="app.html">Open the terminal</a> or <a href="download.html">build the desktop app</a>.</div>
      <div class="time" id="clock">${clock()}</div>
    </div>
  </div></div>
  <div id="tabs">
    <a href="index.html" class="${here === "index.html" ? "active" : ""}">Home</a>
    <a href="guide.html" class="${here === "guide.html" ? "active" : ""}">Guide</a>
    ${NAV.map(([h, l]) => `<a href="${h}" class="${h === here ? "active" : ""}">${l}</a>`).join("")}
    <span class="right">
      <a class="social" href="${X_URL}" target="_blank" rel="noopener noreferrer" title="Moneyero on X" aria-label="Moneyero on X"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg></a>
      <a class="social" href="${GITHUB_URL}" ${GITHUB_URL.startsWith("http") ? 'target="_blank" rel="noopener noreferrer"' : ""} title="Source code" aria-label="Source code on GitHub"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg></a>
      <a class="open" href="app.html">Open terminal »</a>
    </span>
  </div>
  <div id="news"><b>News:</b><span class="items" id="news-items">
    ${Object.keys(COINS).map((s) => `<span class="px"><b style="color:${COINS[s].light}">${s}</b> <span data-px="${s}">…</span> <span data-chg="${s}"></span></span>`).join("")}  </span></div>
  <div class="nav"><a href="index.html">Moneyero</a>${BOARD[here] ? BOARD[here].map((x) => `<span class="sep">»</span>${x}`).join("") : `<span class="sep">»</span>Index`}</div>`,
);
setInterval(() => { const el = document.getElementById("clock"); if (el) el.textContent = clock(); }, 1000);

document.getElementById("ftr")?.insertAdjacentHTML(
  "afterbegin",
  `<div id="footer">
    <span class="cols">
      <a href="guide.html">Beginner's guide</a><a href="terminal.html">Terminal</a><a href="vault.html">Vault</a><a href="exchange.html">Exchange</a><a href="agent.html">Agent</a><a href="network.html">Network</a><a href="privacy.html">Security</a><a href="download.html">Download</a>
    </span>
    <span>Powered by nothing that watches you. Page loaded with 0 trackers and 0 queries about you. Keys 1–7 switch boards, 0 returns home.</span>
  </div>`,
);

// ---------------------------------------------------------------- CoinGecko, with a short per-tab cache
export async function gecko(path, ttlMs = 120_000) {
  const key = "bb:" + path;
  try {
    const hit = JSON.parse(sessionStorage.getItem(key) || "null");
    if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  } catch { /* no storage */ }
  const r = await fetch("https://api.coingecko.com/api/v3/" + path, { cache: "no-store" });
  if (!r.ok) throw new Error("coingecko " + r.status);
  const v = await r.json();
  try { sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), v })); } catch { /* no storage */ }
  return v;
}

const fmt = (n) => n.toLocaleString("en-US", { maximumFractionDigits: n < 10 ? 3 : 2, minimumFractionDigits: 2 });
export async function prices() {
  try {
    const rows = await gecko("coins/markets?vs_currency=usd&ids=monero,zcash,solana&price_change_percentage=24h,7d", 60_000);
    const by = Object.fromEntries(rows.map((x) => [x.id, x]));
    for (const s of Object.keys(COINS)) {
      const d = by[COINS[s].id];
      if (!d) continue;
      const c = d.price_change_percentage_24h ?? 0;
      for (const el of document.querySelectorAll(`[data-px="${s}"]`)) el.textContent = "$" + fmt(d.current_price);
      for (const el of document.querySelectorAll(`[data-chg="${s}"]`)) {
        el.textContent = `${c >= 0 ? "▲" : "▼"} ${Math.abs(c).toFixed(2)}%`;
        el.className = (el.className.replace(/\b(up|dn)\b/g, "").trim() + (c >= 0 ? " up" : " dn")).trim();
      }
      for (const el of document.querySelectorAll(`[data-vol="${s}"]`)) el.textContent = "$" + (d.total_volume / 1e6).toFixed(0) + "M";
      for (const el of document.querySelectorAll(`[data-mcap="${s}"]`)) el.textContent = "$" + (d.market_cap / 1e9).toFixed(2) + "B";
    }
    document.dispatchEvent(new CustomEvent("bb:prices", { detail: by }));
  } catch {
    for (const el of document.querySelectorAll("[data-px]")) if (el.textContent === "…") el.textContent = "offline";
  }
}
prices();
setInterval(prices, 60_000);

// ---------------------------------------------------------------- number keys, like the terminal
addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  if (e.key === "0") location.href = "index.html";
  const i = Number(e.key);
  if (i >= 1 && i <= NAV.length) location.href = NAV[i - 1][0];
});
