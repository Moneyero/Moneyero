import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VersionedTransaction } from "@solana/web3.js";
import { useApp } from "../lib/store";
import { invoke, isTauri } from "../lib/tauri";
import type { Trade } from "../lib/types";
import { ago, errMsg, fmt, fmtPrice, fromBaseUnits, pct, short, toBaseUnits, ts, usd } from "../lib/format";
import { connectLocal, connectPhantom, phantomAvailable, phantomNote, type Signer } from "../lib/solana/wallet";
import { getConnection, getSolBalance, getTokenHoldings, isPublicRpc, rpcHealth, SOL_MINT, USDC_MINT, type TokenHolding } from "../lib/solana/rpc";
import { buildSwap, getPrices, getQuote, riskFlags, searchTokens, tokensByMints, type JupCfg, type JupQuote, type JupToken } from "../lib/solana/jupiter";
import { ohlcv, TIMEFRAMES, topPool, type Candle, type PoolInfo, type Timeframe } from "../lib/solana/gecko";
import { computePnl } from "../lib/solana/pnl";
import { solanaSwapWarnings } from "../lib/privacy";
import { recordObserver, useObservers } from "../lib/observers";
import Candles from "../components/Candles";
import { Addr, Banner, Btn, Chip, Empty, ErrLine, Field, Input, Kv, Panel, Pnl, Prompt, Seg, Tabs, Td, Th, Warnings } from "../components/ui";

const USDC_TOKEN: JupToken = { id: USDC_MINT, name: "USD Coin", symbol: "USDC", decimals: 6, isVerified: true };
const WL_KEY = "bb.watchlist";
const TRADES_KEY = "bb.trades.browser";

function loadWatchlist(): string[] {
  try {
    return JSON.parse(localStorage.getItem(WL_KEY) ?? "[]");
  } catch {
    return [];
  }
}

async function listTrades(wallet: string | null): Promise<Trade[]> {
  if (isTauri) return invoke<Trade[]>("trades_list", { wallet, limit: 500 });
  try {
    const all: Trade[] = JSON.parse(localStorage.getItem(TRADES_KEY) ?? "[]");
    return all.filter((t) => !wallet || t.wallet === wallet).sort((a, b) => b.ts - a.ts);
  } catch {
    return [];
  }
}
async function saveTrade(t: Trade): Promise<void> {
  if (isTauri) {
    await invoke("trades_add", { trade: t });
    return;
  }
  const all: Trade[] = JSON.parse(localStorage.getItem(TRADES_KEY) ?? "[]");
  const i = all.findIndex((x) => x.id === t.id);
  if (i >= 0) all[i] = t;
  else all.push(t);
  localStorage.setItem(TRADES_KEY, JSON.stringify(all));
}

export default function Terminal() {
  const { settings, vault, wallet, setWallet, setPrices, prices, net, treasury, setTreasury, setPnl, handoff, setHandoff, setView, toast } = useApp();
  const observers = useObservers();
  const jup = useMemo<JupCfg>(() => ({ base: settings["jupiter.base_url"] || "https://lite-api.jup.ag", keyedBase: settings["jupiter.keyed_base_url"] || "https://api.jup.ag", apiKey: null }), [settings]);
  const rpcUrl = settings["solana.rpc_url"] || "https://api.mainnet-beta.solana.com";
  const geckoBase = settings["gecko.base_url"] || "https://api.geckoterminal.com/api/v2";
  const conn = useMemo(() => getConnection(rpcUrl, (settings["solana.commitment"] as "confirmed") || "confirmed"), [rpcUrl, settings]);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<JupToken[]>([]);
  const [searching, setSearching] = useState(false);
  const [token, setToken] = useState<JupToken | null>(null);
  const [pool, setPool] = useState<PoolInfo | null>(null);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [tf, setTf] = useState<Timeframe>("15m");
  const [chartErr, setChartErr] = useState<string | null>(null);
  const [watch, setWatch] = useState<string[]>(loadWatchlist);
  const [watchTokens, setWatchTokens] = useState<Record<string, JupToken>>({});
  const [mintPrices, setMintPrices] = useState<Record<string, number>>({});
  const [signer, setSigner] = useState<Signer | null>(null);
  const [solBal, setSolBal] = useState<number | null>(null);
  const [holdings, setHoldings] = useState<TokenHolding[]>([]);
  const [holdMeta, setHoldMeta] = useState<Record<string, JupToken>>({});
  const [rpcInfo, setRpcInfo] = useState<{ slot: number; ms: number } | null>(null);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [slip, setSlip] = useState(Number(settings["trade.default_slippage_bps"] ?? 50));
  const [quote, setQuote] = useState<JupQuote | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [swapping, setSwapping] = useState<string | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [tab, setTab] = useState<"positions" | "trades">("positions");
  const quoteSeq = useRef(0);

  // Hydrate SOL as the default instrument.
  useEffect(() => {
    tokensByMints(jup, [SOL_MINT]).then((t) => { const s = t.find((x) => x.id === SOL_MINT); if (s && !token) setToken(s); }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Agent hand-off: propose_swap prefill.
  useEffect(() => {
    const a = handoff?.proposal.action;
    if (a?.kind === "propose_swap") {
      searchTokens(jup, a.from_symbol === "SOL" ? "SOL" : a.from_symbol).then((r) => {
        const t = r.find((x) => x.symbol.toUpperCase() === a.from_symbol.toUpperCase()) ?? r[0];
        if (t) {
          setToken(t);
          setSide("sell");
          if (a.amount) setAmount(String(a.amount));
        }
      }).catch(() => {});
    }
  }, [handoff, jup]);

  // Search (debounced).
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    const h = setTimeout(async () => {
      setSearching(true);
      try {
        setResults((await searchTokens(jup, q)).slice(0, 40));
      } catch (e) {
        toast(`search: ${errMsg(e)}`, "err");
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(h);
  }, [query, jup, toast]);

  // Chart data.
  const loadChart = useCallback(async () => {
    if (!token) return;
    try {
      setChartErr(null);
      let p = pool;
      if (!p || !p.name.toUpperCase().includes(token.symbol.toUpperCase())) {
        p = await topPool(geckoBase, token.id);
        setPool(p);
      }
      if (!p) {
        setCandles([]);
        setChartErr("no pool on GeckoTerminal for this mint");
        return;
      }
      setCandles(await ohlcv(geckoBase, p.address, tf, p.tokenIsBase));
    } catch (e) {
      setChartErr(errMsg(e));
    }
  }, [token, pool, tf, geckoBase]);

  useEffect(() => {
    setPool(null);
    setCandles([]);
    setQuote(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token?.id]);
  useEffect(() => {
    loadChart();
    const t = setInterval(loadChart, tf === "1m" ? 20_000 : 60_000);
    return () => clearInterval(t);
  }, [loadChart, tf]);

  // Watchlist metadata.
  useEffect(() => {
    localStorage.setItem(WL_KEY, JSON.stringify(watch));
    const missing = watch.filter((m) => !watchTokens[m]);
    if (missing.length) tokensByMints(jup, missing).then((ts_) => setWatchTokens((w) => ({ ...w, ...Object.fromEntries(ts_.map((t) => [t.id, t])) }))).catch(() => {});
  }, [watch, jup, watchTokens]);

  // Prices (Jupiter price v3) for everything on screen.
  const priceMints = useMemo(() => [...new Set([SOL_MINT, USDC_MINT, token?.id, ...watch, ...holdings.map((h) => h.mint)].filter(Boolean) as string[])], [token?.id, watch, holdings]);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const p = await getPrices(jup, priceMints);
        if (!alive) return;
        setMintPrices((m) => ({ ...m, ...p }));
        if (p[SOL_MINT]) setPrices({ SOL: p[SOL_MINT] });
      } catch {
        /* next tick */
      }
    };
    tick();
    const t = setInterval(tick, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [priceMints, jup, setPrices]);

  // Wallet balances.
  const refreshBalances = useCallback(async () => {
    if (!signer) return;
    try {
      const [s, h, hp] = await Promise.all([getSolBalance(conn, signer.publicKey), getTokenHoldings(conn, signer.publicKey), rpcHealth(conn).catch(() => null)]);
      setSolBal(s);
      setHoldings(h);
      if (hp) setRpcInfo(hp);
      const usdcH = h.find((x) => x.mint === USDC_MINT)?.amount ?? 0;
      setTreasury({ sol: s, usdc: usdcH });
      const missing = h.map((x) => x.mint).filter((m) => !holdMeta[m] && m !== USDC_MINT);
      if (missing.length) {
        const metas = await tokensByMints(jup, missing).catch(() => [] as JupToken[]);
        setHoldMeta((hm) => ({ ...hm, ...Object.fromEntries(metas.map((t) => [t.id, t])) }));
      }
    } catch (e) {
      toast(`rpc: ${errMsg(e)}`, "err");
    }
  }, [signer, conn, setTreasury, holdMeta, jup, toast]);

  useEffect(() => {
    refreshBalances();
    const t = setInterval(refreshBalances, 30_000);
    return () => clearInterval(t);
  }, [refreshBalances]);

  // Tokens USD value into treasury.
  useEffect(() => {
    const v = holdings.filter((h) => h.mint !== USDC_MINT).reduce((a, h) => a + h.amount * (mintPrices[h.mint] ?? 0), 0);
    setTreasury({ solTokensUsd: v });
  }, [holdings, mintPrices, setTreasury]);

  // Trades + P&L.
  const loadTrades = useCallback(async () => {
    try {
      setTrades(await listTrades(wallet.pubkey));
    } catch {
      /* backend missing */
    }
  }, [wallet.pubkey]);
  useEffect(() => {
    loadTrades();
  }, [loadTrades]);
  const pnl = useMemo(() => computePnl(trades, mintPrices), [trades, mintPrices]);
  useEffect(() => {
    setPnl(pnl.realizedUsd, pnl.unrealizedUsd);
  }, [pnl.realizedUsd, pnl.unrealizedUsd, setPnl]);

  // Reconnect local signer if the store says so (e.g. picked in VAULT).
  useEffect(() => {
    if (wallet.kind === "local" && !signer && vault?.unlocked) connectLocal().then(setSigner).catch(() => {});
  }, [wallet.kind, signer, vault?.unlocked]);

  // The swap always runs SOL against a counter token. When the chart instrument is SOL itself,
  // the counter token is USDC so the form is usable immediately instead of reading "SOL → SOL".
  const pairTok: JupToken | null = token ? (token.id === SOL_MINT ? USDC_TOKEN : token) : null;

  // Quote (debounced).
  const inMint = side === "buy" ? SOL_MINT : pairTok?.id ?? null;
  const outMint = side === "buy" ? pairTok?.id ?? null : SOL_MINT;
  const inDecimals = side === "buy" ? 9 : pairTok?.decimals ?? 9;
  const outDecimals = side === "buy" ? pairTok?.decimals ?? 9 : 9;
  const inSymbol = side === "buy" ? "SOL" : pairTok?.symbol ?? "";
  const outSymbol = side === "buy" ? pairTok?.symbol ?? "" : "SOL";
  useEffect(() => {
    setQuote(null);
    setQuoteErr(null);
    if (!inMint || !outMint || inMint === outMint || !amount || !(Number(amount) > 0)) return;
    const seq = ++quoteSeq.current;
    const h = setTimeout(async () => {
      setQuoting(true);
      try {
        const q = await getQuote(jup, { inputMint: inMint, outputMint: outMint, amount: toBaseUnits(amount, inDecimals), slippageBps: slip });
        if (seq === quoteSeq.current) setQuote(q);
      } catch (e) {
        if (seq === quoteSeq.current) setQuoteErr(errMsg(e));
      } finally {
        if (seq === quoteSeq.current) setQuoting(false);
      }
    }, 500);
    return () => clearTimeout(h);
  }, [inMint, outMint, amount, slip, inDecimals, jup]);

  const connect = async (kind: "phantom" | "local") => {
    try {
      const s = kind === "phantom" ? await connectPhantom() : await connectLocal();
      if (kind === "phantom") recordObserver("phantom (extension)", "wallet extension", "your address and every transaction you sign; it simulates and may submit through its own RPC, outside any tunnel set here");
      setSigner(s);
      setWallet({ kind, pubkey: s.publicKey.toBase58() });
      toast(`${kind} connected ${short(s.publicKey.toBase58())}`, "ok");
    } catch (e) {
      toast(errMsg(e), "err");
    }
  };
  // What the big button should do next, so it is never a dead "connect wallet" label.
  const maxSlip = Number(settings["trade.max_slippage_bps"] ?? 300);
  const insufficient = side === "buy" && solBal != null && Number(amount) > solBal;
  const canPhantom = !isTauri && phantomAvailable();
  const step = !signer
    ? { label: isTauri || canPhantom ? "connect wallet" : "install phantom to trade", disabled: !isTauri && !canPhantom, run: () => connect(isTauri ? "local" : "phantom") }
    : !amount || !(Number(amount) > 0)
      ? { label: `enter ${inSymbol} amount`, disabled: false, run: () => document.getElementById("swap-amount")?.focus() }
      : quoting
        ? { label: "quoting…", disabled: true, run: () => {} }
        : !quote
          ? { label: quoteErr ? "no route" : "enter amount", disabled: true, run: () => {} }
          : slip > maxSlip
            ? { label: `slippage over ${maxSlip} bps limit`, disabled: true, run: () => {} }
            : insufficient
              ? { label: "insufficient SOL", disabled: true, run: () => {} }
              : { label: `${side} ${pairTok?.symbol ?? ""}`, disabled: false, run: () => execute() };

  const disconnect = async () => {
    await signer?.disconnect().catch(() => {});
    setSigner(null);
    setWallet({ kind: null, pubkey: null });
    setSolBal(null);
    setHoldings([]);
    setTreasury({ sol: 0, usdc: 0, solTokensUsd: 0 });
  };

  const execute = async () => {
    if (!signer || !quote || !pairTok || !inMint || !outMint) return;
    const maxSlip = Number(settings["trade.max_slippage_bps"] ?? 300);
    if (slip > maxSlip) return toast(`slippage ${slip} bps exceeds trade.max_slippage_bps (${maxSlip})`, "err");
    const id = crypto.randomUUID();
    const inAmt = fromBaseUnits(quote.inAmount, inDecimals);
    const outAmt = fromBaseUnits(quote.outAmount, outDecimals);
    const rec: Trade = {
      id,
      ts: Math.floor(Date.now() / 1000),
      wallet: signer.publicKey.toBase58(),
      in_mint: inMint,
      in_symbol: inSymbol,
      in_amount: inAmt,
      out_mint: outMint,
      out_symbol: outSymbol,
      out_amount: outAmt,
      in_usd: mintPrices[inMint] ? inAmt * mintPrices[inMint] : null,
      out_usd: mintPrices[outMint] ? outAmt * mintPrices[outMint] : null,
      signature: null,
      status: "pending",
      slippage_bps: slip,
      route: quote.routePlan.map((r) => r.swapInfo.label ?? "?").join(">"),
    };
    try {
      setSwapping("building");
      const sw = await buildSwap(jup, { quoteResponse: quote, userPublicKey: signer.publicKey.toBase58(), priorityFee: "auto" });
      if (sw.simulationError) throw new Error(`simulation: ${sw.simulationError.error}`);
      const tx = VersionedTransaction.deserialize(Buffer.from(sw.swapTransaction, "base64"));
      setSwapping("signing");
      const signed = await signer.signTransaction(tx);
      setSwapping("sending");
      const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 3 });
      rec.signature = sig;
      await saveTrade(rec).catch(() => {});
      setSwapping("confirming");
      const res = await conn.confirmTransaction({ signature: sig, blockhash: tx.message.recentBlockhash, lastValidBlockHeight: sw.lastValidBlockHeight }, "confirmed");
      if (res.value.err) throw new Error(`on-chain error: ${JSON.stringify(res.value.err)}`);
      rec.status = "confirmed";
      await saveTrade(rec).catch(() => {});
      toast(`swap confirmed ${short(sig)}`, "ok");
      setAmount("");
      setQuote(null);
      if (handoff?.proposal.action.kind === "propose_swap") {
        await invoke("agent_result", { id: handoff.proposal.id, ok: true, result: `swap ${sig}` }).catch(() => {});
        setHandoff(null);
      }
    } catch (e) {
      rec.status = "failed";
      await saveTrade(rec).catch(() => {});
      toast(`swap failed: ${errMsg(e)}`, "err");
      if (handoff?.proposal.action.kind === "propose_swap") {
        await invoke("agent_result", { id: handoff.proposal.id, ok: false, result: errMsg(e) }).catch(() => {});
        setHandoff(null);
      }
    } finally {
      setSwapping(null);
      loadTrades();
      setTimeout(refreshBalances, 2000);
    }
  };

  const flags = useMemo(() => riskFlags(token), [token]);
  const redFlags = flags.filter((f) => f.level === "err").length;
  const warnings = useMemo(
    () => solanaSwapWarnings({ signerKind: signer?.kind ?? null, net: { proxyEnabled: net.proxyEnabled, torReachable: net.torReachable, tunnelUp: net.tunnelUp }, rpcIsPublic: isPublicRpc(rpcUrl), tokenRisk: redFlags, sameWalletAsExchangeSettle: false }),
    [signer?.kind, net, rpcUrl, redFlags],
  );
  const tokenPrice = token ? (mintPrices[token.id] ?? token.usdPrice ?? pool?.priceUsd ?? null) : null;
  const inBalance = side === "buy" ? solBal : holdings.find((h) => h.mint === token?.id)?.amount ?? 0;
  const priceImpact = quote ? Number(quote.priceImpactPct) * 100 : null;
  const minOut = quote ? fromBaseUnits(quote.otherAmountThreshold, outDecimals) : null;
  const selectToken = (t: JupToken) => {
    setToken(t);
    setQuery("");
    setResults([]);
  };

  return (
    <div className="view">
      {handoff?.proposal.action.kind === "propose_swap" && <Banner tone="warn">Executing approved agent proposal: <b>{handoff.proposal.title}</b>. A confirmed swap marks it executed. <Btn size="xs" variant="ghost" onClick={() => setHandoff(null)}>detach</Btn></Banner>}
      <div className="row" style={{ minHeight: 440, flexShrink: 0, alignItems: "stretch" }}>
        {/* ------------------------------------------------ left: search / watchlist */}
        <div className="col" style={{ width: 330 }}>
          <Panel title="Market search" tight>
            <div style={{ padding: 6 }}>
              <Prompt value={query} onChange={setQuery} placeholder="symbol, name or mint" prefix={searching ? "…" : ">"} />
            </div>
            {results.length > 0 && (
              <table className="tbl dense">
                <thead><tr><Th>sym</Th><Th num>price</Th><Th num>24h</Th><Th num>liq</Th><Th num>mcap</Th><Th></Th></tr></thead>
                <tbody>
                  {results.map((t) => (
                    <tr key={t.id} className="click" onClick={() => selectToken(t)}>
                      <Td><span className={t.isVerified ? "" : "warn"} title={t.name}>{t.symbol}</span>{t.isVerified ? <span className="ok xs"> ✓</span> : null}</Td>
                      <Td num>{fmtPrice(t.usdPrice)}</Td>
                      <Td num className={(t.stats24h?.priceChange ?? 0) >= 0 ? "ok" : "err"}>{pct(t.stats24h?.priceChange, 1)}</Td>
                      <Td num className="dim">{t.liquidity != null ? usd(t.liquidity) : "-"}</Td>
                      <Td num className="dim">{t.mcap != null ? usd(t.mcap) : "-"}</Td>
                      <Td><Btn size="xs" variant="ghost" onClick={(e) => { e.stopPropagation(); if (!watch.includes(t.id)) setWatch([...watch, t.id]); }}>+</Btn></Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
          <Panel title="Watchlist" fill tight>
            <table className="tbl dense">
              <thead><tr><Th>sym</Th><Th num>price</Th><Th num>24h</Th><Th num>liq</Th><Th></Th></tr></thead>
              <tbody>
                {[SOL_MINT, ...watch.filter((w) => w !== SOL_MINT)].map((m) => {
                  const t = m === SOL_MINT ? token?.id === SOL_MINT ? token : watchTokens[m] : watchTokens[m];
                  return (
                    <tr key={m} className={`click ${token?.id === m ? "sel" : ""}`} onClick={() => (t ? selectToken(t) : tokensByMints(jup, [m]).then((r) => r[0] && selectToken(r[0])))}>
                      <Td>{t?.symbol ?? short(m, 4, 4)}</Td>
                      <Td num>{fmtPrice(mintPrices[m] ?? t?.usdPrice)}</Td>
                      <Td num className={(t?.stats24h?.priceChange ?? 0) >= 0 ? "ok" : "err"}>{pct(t?.stats24h?.priceChange, 1)}</Td>
                      <Td num className="dim">{t?.liquidity != null ? usd(t.liquidity) : "-"}</Td>
                      <Td>{m !== SOL_MINT && <Btn size="xs" variant="ghost" onClick={(e) => { e.stopPropagation(); setWatch(watch.filter((w) => w !== m)); }}>×</Btn>}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>
          <Panel title="Observers · this session" tight right={<Chip tone={net.vpnUp || net.tunnelUp || net.proxyEnabled ? "ok" : "warn"}>{net.vpnUp ? "built-in vpn" : net.proxyEnabled ? "tor" : net.tunnelUp ? "system wg" : "clearnet"}</Chip>}>
            <table className="tbl dense">
              <thead><tr><Th>who</Th><Th num>req</Th><Th>learns</Th></tr></thead>
              <tbody>
                {observers.map((o) => (
                  <tr key={o.host} title={o.host}>
                    <Td><div>{o.role}</div><div className="dim xs">{o.host}</div></Td>
                    <Td num className="dim">{o.count || "-"}</Td>
                    <Td wrap className="muted xs">{o.learns}</Td>
                  </tr>
                ))}
                {!observers.length && <tr><Td colSpan={3}><Empty>no outbound requests yet</Empty></Td></tr>}
              </tbody>
            </table>
            <div style={{ padding: 6 }} className="dim xs">Every host this page has contacted since it loaded, counted live. {net.vpnUp || net.proxyEnabled ? "They see the tunnel's exit, not you." : "On clearnet each of them sees your real IP next to what it learns."}</div>
          </Panel>
        </div>

        {/* ------------------------------------------------ center: ticker + chart */}
        <div className="col grow">
          <Panel
            title={token ? <span>{token.symbol} <span className="dim">/ USD</span> <span className="muted" style={{ textTransform: "none", letterSpacing: 0 }}>{token.name}</span></span> : "instrument"}
            right={<Seg options={TIMEFRAMES} value={tf} onChange={setTf} />}
            fill
            tight
          >
            <div className="row ac wrap" style={{ padding: "6px 8px", borderBottom: "1px solid var(--line)", gap: 16 }}>
              <span className="big">{fmtPrice(tokenPrice)}</span>
              {tokenPrice != null && prices.XMR && prices.ZEC && (
                <Kv items={[["in XMR", <span className="or">{fmt(tokenPrice / prices.XMR, 5)}</span>], ["in ZEC", <span style={{ color: "var(--gold)" }}>{fmt(tokenPrice / prices.ZEC, 5)}</span>]]} />
              )}
              <Kv items={[["24h", <span className={(token?.stats24h?.priceChange ?? pool?.priceChange24h ?? 0) >= 0 ? "ok" : "err"}>{pct(token?.stats24h?.priceChange ?? pool?.priceChange24h)}</span>], ["1h", <span className={(token?.stats1h?.priceChange ?? 0) >= 0 ? "ok" : "err"}>{pct(token?.stats1h?.priceChange)}</span>]]} />
              <Kv items={[["liq", token?.liquidity != null ? usd(token.liquidity) : pool ? usd(pool.reserveUsd) : "-"], ["mcap", token?.mcap != null ? usd(token.mcap) : "-"]]} />
              <Kv items={[["vol24h", pool ? usd(pool.volume24h) : token?.stats24h ? usd((token.stats24h.buyVolume ?? 0) + (token.stats24h.sellVolume ?? 0)) : "-"], ["holders", token?.holderCount != null ? fmt(token.holderCount, 0) : "-"]]} />
              <Kv items={[["pool", pool ? <span title={pool.address}>{pool.dex} {short(pool.address, 4, 4)}</span> : "-"], ["mint", token ? <Addr value={token.id} head={6} tail={6} /> : "-"]]} />
              <div className="flags" style={{ marginLeft: "auto" }}>
                {flags.map((f) => <Chip key={f.label} tone={f.level === "ok" ? "ok" : f.level === "warn" ? "warn" : "err"} title={f.detail}>{f.label}</Chip>)}
              </div>
            </div>
            <div style={{ flex: 1, minHeight: 300, position: "relative" }}>
              <Candles data={candles} />
              {chartErr && <div className="dim small" style={{ position: "absolute", top: 8, left: 8 }}>chart: {chartErr}</div>}
              {!candles.length && !chartErr && <div className="dim small" style={{ position: "absolute", top: 8, left: 8 }}>loading candles…</div>}
            </div>
          </Panel>
        </div>

        {/* ------------------------------------------------ right: swap */}
        <div className="col" style={{ width: 340 }}>
          <Panel title="Wallet" right={signer ? <Btn size="xs" variant="ghost" onClick={disconnect}>disconnect</Btn> : null}>
            {!signer ? (
              <>
                <div className="row">
                  <Btn variant="primary" className="grow" disabled={!phantomAvailable()} title={phantomNote()} onClick={() => connect("phantom")}>phantom</Btn>
                  <Btn variant="primary" className="grow" disabled={!isTauri} title={isTauri ? "vault-encrypted local key" : "desktop only"} onClick={() => connect("local")}>local signer</Btn>
                </div>
                <div className="dim xs">{phantomNote()}</div>
              </>
            ) : (
              <Kv items={[["signer", <span><Chip tone={signer.kind === "local" ? "or" : "ok"}>{signer.kind}</Chip> <Addr value={signer.publicKey.toBase58()} /></span>], ["SOL", solBal != null ? `${solBal.toFixed(4)} (${usd(solBal * (mintPrices[SOL_MINT] ?? 0))})` : "…"], ["tokens", `${holdings.length} · ${usd(holdings.reduce((a, h) => a + h.amount * (mintPrices[h.mint] ?? 0), 0))}`], ["rpc", rpcInfo ? <span>slot {rpcInfo.slot} · {rpcInfo.ms}ms {isPublicRpc(rpcUrl) && <span className="warn">· public</span>}</span> : "-"]]} />
            )}
          </Panel>
          <Panel title={`Swap · ${side === "buy" ? `SOL → ${pairTok?.symbol ?? "?"}` : `${pairTok?.symbol ?? "?"} → SOL`}`} right={<Seg options={["buy", "sell"] as const} value={side} onChange={setSide} />}>
            <Field label={`amount ${inSymbol}`} hint={inBalance != null ? `balance ${fmt(inBalance, 6)}` : undefined}>
              <div className="row">
                <Input id="swap-amount" mono value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0" disabled={!pairTok} />
                {[25, 50, 100].map((p) => <Btn key={p} size="xs" variant="ghost" disabled={inBalance == null} onClick={() => setAmount(String(Math.max(0, ((inBalance ?? 0) - (side === "buy" ? 0.01 : 0)) * p / 100).toFixed(side === "buy" ? 4 : Math.min(6, inDecimals))))}>{p}%</Btn>)}
              </div>
            </Field>
            <Field label="slippage (bps)">
              <div className="row ac">
                <Seg options={["10", "50", "100", "300"] as const} value={String(slip) as "10"} onChange={(v) => setSlip(Number(v))} />
                <Input mono value={String(slip)} onChange={(e) => setSlip(Number(e.target.value) || 0)} style={{ width: 70 }} />
                {slip > maxSlip && <span className="err xs">&gt; max {maxSlip}</span>}
              </div>
            </Field>
            {token?.id === SOL_MINT && <Empty>SOL against USDC. Search a token on the left to trade that instead.</Empty>}
            {quoteErr && <ErrLine e={quoteErr} />}
            {quote && (
              <Kv items={[
                ["receive", <b>{fmt(fromBaseUnits(quote.outAmount, outDecimals), 6)} {outSymbol}</b>],
                ["min received", `${fmt(minOut, 6)} ${outSymbol}`],
                ["price", `${fmtPrice(fromBaseUnits(quote.inAmount, inDecimals) / fromBaseUnits(quote.outAmount, outDecimals))} ${inSymbol}/${outSymbol}`],
                ["impact", <span className={priceImpact != null && priceImpact > 2 ? "err" : priceImpact != null && priceImpact > 0.5 ? "warn" : ""}>{priceImpact != null ? `${priceImpact.toFixed(3)}%` : "-"}</span>],
                ["route", <span className="dim" style={{ whiteSpace: "normal" }}>{quote.routePlan.map((r) => `${r.swapInfo.label ?? "?"} ${r.percent}%`).join(" › ")}</span>],
                ["value", mintPrices[inMint!] ? usd(fromBaseUnits(quote.inAmount, inDecimals) * mintPrices[inMint!]) : "-"],
              ]} />
            )}
            <Btn variant="primary" block size="lg" busy={!!swapping} disabled={step.disabled} onClick={step.run}>
              {swapping ? swapping : step.label}
            </Btn>
            <Warnings items={warnings} compact />
          </Panel>
          <Panel title="Private side" className="scrollx" right={<span className="dim xs">settlement</span>}>
            {(() => {
              const px = prices.XMR ?? 0, pz = prices.ZEC ?? 0, ps = prices.SOL ?? 0;
              const pub = treasury.sol * ps + treasury.usdc + treasury.solTokensUsd + treasury.zecTransparent * pz;
              const priv = treasury.xmr * px + Math.max(0, treasury.zec - treasury.zecTransparent) * pz;
              const tot = pub + priv;
              const pubPct = tot > 0 ? (pub / tot) * 100 : 100;
              return (
                <>
                  <table className="tbl dense">
                    <thead><tr><Th></Th><Th num>usd</Th><Th num>1 SOL =</Th><Th num>held</Th></tr></thead>
                    <tbody>
                      <tr><Td className="or">XMR <span className="dim xs">Monero</span></Td><Td num>{px ? fmtPrice(px) : "-"}</Td><Td num>{px && ps ? fmt(ps / px, 4) : "-"}</Td><Td num className={treasury.xmrOpen ? "" : "dim"}>{treasury.xmrOpen ? fmt(treasury.xmr, 4) : isTauri ? "wallet closed" : "desktop"}</Td></tr>
                      <tr><Td className="gold">ZEC <span className="dim xs">Zcash</span></Td><Td num>{pz ? fmtPrice(pz) : "-"}</Td><Td num>{pz && ps ? fmt(ps / pz, 4) : "-"}</Td><Td num className={treasury.zecReachable ? "" : "dim"}>{treasury.zecReachable ? <span>{fmt(treasury.zec - treasury.zecTransparent, 4)}{treasury.zecTransparent > 0 && <span className="warn" title="transparent, not yet shielded"> +{fmt(treasury.zecTransparent, 4)}t</span>}</span> : isTauri ? "node offline" : "desktop"}</Td></tr>
                    </tbody>
                  </table>
                  <div style={{ marginTop: 8 }}>
                    <div className="row" style={{ justifyContent: "space-between" }} >
                      <span className="xs muted">on a public ledger <b className={pubPct > 50 ? "warn" : "ok"}>{tot > 0 ? `${pubPct.toFixed(0)}%` : "all of it"}</b></span>
                      <span className="xs muted">private <b className="or">{tot > 0 ? `${(100 - pubPct).toFixed(0)}%` : "0%"}</b></span>
                    </div>
                    <div style={{ display: "flex", height: 4, background: "var(--bg4)", marginTop: 4 }}>
                      <div style={{ width: `${pubPct}%`, background: "var(--fg3)" }} />
                      <div style={{ flex: 1, background: "var(--or)" }} />
                    </div>
                    <div className="dim xs" style={{ marginTop: 6 }}>
                      {tot > 0 ? `${usd(pub)} visible to anyone with your address, ${usd(priv)} not.` : "Everything this terminal can see is on a public chain."} {isTauri ? "Take profit into the private side through Exchange." : "The private side needs the desktop app: Monero and shielded Zcash wallets run on your machine."}
                    </div>
                  </div>
                  <div className="row mt8">
                    <Btn size="sm" variant="primary" disabled={!isTauri} title={isTauri ? "quote SOL → XMR across providers" : "desktop only"} onClick={() => setView("exchange")}>settle to XMR</Btn>
                    <Btn size="sm" variant="gold" disabled={!isTauri} title={isTauri ? "quote SOL → ZEC across providers" : "desktop only"} onClick={() => setView("exchange")}>settle to ZEC</Btn>
                    <Btn size="sm" variant="ghost" disabled={!isTauri} title={isTauri ? "" : "desktop only"} onClick={() => setView("vault")}>vault</Btn>
                  </div>
                </>
              );
            })()}
          </Panel>
        </div>
      </div>

      {/* ------------------------------------------------ bottom: positions / trades */}
      <Panel title="Book" tight fill className="scrollx" right={<span className="dim xs">rPNL <Pnl v={pnl.realizedUsd} fmt={(n) => usd(n)} /> · uPNL <Pnl v={pnl.unrealizedUsd} fmt={(n) => usd(n)} /> · {pnl.tradeCount} trades tracked</span>} style={{ minHeight: 180 }}>
        <Tabs tabs={[{ id: "positions", label: "positions & p&l" }, { id: "trades", label: "trades / tx history" }]} active={tab} onChange={setTab} />
        {tab === "positions" ? (
          <table className="tbl dense">
            <thead><tr><Th>token</Th><Th num>on-chain</Th><Th num>tracked pos</Th><Th num>avg cost</Th><Th num>mark</Th><Th num>value</Th><Th num>realised</Th><Th num>unrealised</Th><Th num>untracked sold</Th></tr></thead>
            <tbody>
              {(() => {
                const mints = new Set([...holdings.map((h) => h.mint), ...pnl.positions.map((p) => p.mint)]);
                const rows = [...mints].map((m) => {
                  const h = holdings.find((x) => x.mint === m);
                  const p = pnl.positions.find((x) => x.mint === m);
                  const sym = p?.symbol ?? holdMeta[m]?.symbol ?? (m === USDC_MINT ? "USDC" : short(m, 4, 4));
                  const mark = mintPrices[m] ?? (m === USDC_MINT ? 1 : null);
                  return { m, h, p, sym, mark, value: (h?.amount ?? 0) * (mark ?? 0) };
                }).sort((a, b) => b.value - a.value);
                if (!rows.length) return <tr><Td colSpan={9}><Empty>{signer ? "no token positions" : "connect a wallet"}</Empty></Td></tr>;
                return rows.map((r) => (
                  <tr key={r.m} className="click" onClick={() => (holdMeta[r.m] ? selectToken(holdMeta[r.m]) : null)}>
                    <Td>{r.sym}</Td>
                    <Td num>{r.h ? fmt(r.h.amount, 4) : "-"}</Td>
                    <Td num className="dim">{r.p ? fmt(r.p.position, 4) : "-"}</Td>
                    <Td num className="dim">{r.p && r.p.position > 0 ? fmtPrice(r.p.avgCost) : "-"}</Td>
                    <Td num>{fmtPrice(r.mark)}</Td>
                    <Td num>{usd(r.value)}</Td>
                    <Td num><Pnl v={r.p?.realizedUsd} fmt={(n) => usd(n)} /></Td>
                    <Td num><Pnl v={r.p?.unrealizedUsd} fmt={(n) => usd(n)} /></Td>
                    <Td num className="dim">{r.p?.untrackedSold ? fmt(r.p.untrackedSold, 4) : ""}</Td>
                  </tr>
                ));
              })()}
            </tbody>
          </table>
        ) : (
          <table className="tbl dense">
            <thead><tr><Th>time</Th><Th>status</Th><Th num>in</Th><Th num>out</Th><Th num>in $</Th><Th num>out $</Th><Th num>slip</Th><Th>route</Th><Th>signature</Th></tr></thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.id}>
                  <Td className="dim" title={ts(t.ts)}>{ago(t.ts)} ago</Td>
                  <Td className={t.status === "confirmed" ? "ok" : t.status === "failed" ? "err" : "warn"}>{t.status}</Td>
                  <Td num>{fmt(t.in_amount, 6)} {t.in_symbol}</Td>
                  <Td num>{fmt(t.out_amount, 6)} {t.out_symbol}</Td>
                  <Td num className="dim">{usd(t.in_usd)}</Td>
                  <Td num className="dim">{usd(t.out_usd)}</Td>
                  <Td num className="dim">{t.slippage_bps}</Td>
                  <Td className="dim">{t.route}</Td>
                  <Td>{t.signature ? <a href={`https://solscan.io/tx/${t.signature}`} target="_blank" rel="noreferrer" title="opens a block explorer (third party sees the lookup)">{short(t.signature, 8, 8)}</a> : "-"}</Td>
                </tr>
              ))}
              {!trades.length && <tr><Td colSpan={9}><Empty>no trades recorded by Moneyero for this wallet</Empty></Td></tr>}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
