import { useEffect, useRef } from "react";
import { createChart, ColorType, CrosshairMode, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import type { Candle } from "../lib/solana/gecko";

export default function Candles(p: { data: Candle[]; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const vol = useRef<ISeriesApi<"Histogram"> | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const c = createChart(ref.current, {
      layout: { background: { type: ColorType.Solid, color: "#070707" }, textColor: "#8e8c84", fontFamily: "ui-monospace, Consolas, monospace", fontSize: 10 },
      grid: { vertLines: { color: "#141414" }, horzLines: { color: "#141414" } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: "#ff660066", labelBackgroundColor: "#ff6600" }, horzLine: { color: "#ff660066", labelBackgroundColor: "#ff6600" } },
      rightPriceScale: { borderColor: "#232323" },
      timeScale: { borderColor: "#232323", timeVisible: true, secondsVisible: false },
      handleScroll: true,
      handleScale: true,
    });
    const s = c.addCandlestickSeries({
      upColor: "#ff6600",
      downColor: "#2a2a2a",
      borderUpColor: "#ff6600",
      borderDownColor: "#555",
      wickUpColor: "#ff6600",
      wickDownColor: "#666",
      priceFormat: { type: "price", precision: 6, minMove: 0.000001 },
    });
    const v = c.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "", color: "#333" });
    v.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chart.current = c;
    series.current = s;
    vol.current = v;
    const ro = new ResizeObserver(() => {
      if (ref.current) c.applyOptions({ width: ref.current.clientWidth, height: ref.current.clientHeight });
    });
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      c.remove();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    if (!series.current || !vol.current) return;
    const d = p.data;
    series.current.setData(d.map((k) => ({ time: k.time as UTCTimestamp, open: k.open, high: k.high, low: k.low, close: k.close })));
    vol.current.setData(d.map((k) => ({ time: k.time as UTCTimestamp, value: k.volume, color: k.close >= k.open ? "#ff660055" : "#44444488" })));
    if (d.length) {
      const last = d[d.length - 1].close;
      const precision = last < 0.001 ? 9 : last < 1 ? 6 : last < 100 ? 4 : 2;
      series.current.applyOptions({ priceFormat: { type: "price", precision, minMove: 1 / 10 ** precision } });
      chart.current?.timeScale().fitContent();
    }
  }, [p.data]);

  return <div ref={ref} className="chart" style={{ height: p.height }} />;
}
