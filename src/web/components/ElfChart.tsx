import { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, CrosshairMode, type IChartApi, type ISeriesApi, type Time, type UTCTimestamp, type LogicalRange } from 'lightweight-charts';
import type { EngineSnapshot } from '../../engine/engine';
import type { Candle } from '../../shared/types';
import { zonedParts } from '../../shared/time';
import { ElfOverlayPrimitive } from '../lib/overlayPrimitive';
import { buildOverlays, type Colors, type Visibility } from '../lib/overlays';
import { fmtPrice } from '../lib/format';

interface Props {
  candles: Candle[];
  snapshot: EngineSnapshot | null;
  visibility: Visibility;
  colors: Colors;
  height?: number | string;
  /** Called when the user scrolls to the left edge (load older candles). */
  onNeedOlder?: () => void;
  /** Changing this key resets the viewport (e.g. symbol/timeframe change). */
  resetKey?: string;
  watermark?: string;
}

// Axis labels in New York time to match the session engine.
const tickFormatter = (t: Time) => {
  const p = zonedParts(t as number);
  return p.hour === 0 && p.minute === 0 ? `${p.month}/${p.day}` : `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
};

export function ElfChart({ candles, snapshot, visibility, colors, height = '62vh', onNeedOlder, resetKey, watermark }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const primRef = useRef<ElfOverlayPrimitive | null>(null);
  const needOlderRef = useRef(onNeedOlder);
  needOlderRef.current = onNeedOlder;
  const lastResetKey = useRef<string | undefined>(undefined);
  const firstTimeRef = useRef<number | null>(null);
  const [legend, setLegend] = useState<Candle | null>(null);

  useEffect(() => {
    if (!el.current) return;
    const chart = createChart(el.current, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: '#9ca3af', fontSize: 11, fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif' },
      grid: { vertLines: { color: '#1f293766' }, horzLines: { color: '#1f293766' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#1f2937', scaleMargins: { top: 0.08, bottom: 0.18 } },
      timeScale: { borderColor: '#1f2937', timeVisible: true, secondsVisible: false, rightOffset: 6, tickMarkFormatter: tickFormatter },
      localization: { timeFormatter: (t: Time) => { const p = zonedParts(t as number); return `${p.dateKey} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')} ET`; } },
      handleScale: { axisPressedMouseMove: true, pinch: true, mouseWheel: true },
      handleScroll: { horzTouchDrag: true, vertTouchDrag: false, mouseWheel: true, pressedMouseMove: true },
    });
    const cs = chart.addCandlestickSeries({ upColor: colors.up, downColor: colors.down, borderVisible: false, wickUpColor: colors.up, wickDownColor: colors.down, priceLineVisible: true });
    const vs = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    const prim = new ElfOverlayPrimitive();
    cs.attachPrimitive(prim);
    chartRef.current = chart;
    candleRef.current = cs;
    volRef.current = vs;
    primRef.current = prim;
    chart.subscribeCrosshairMove((p) => {
      const d = p.seriesData.get(cs) as any;
      setLegend(d && d.open !== undefined ? { time: p.time as number, open: d.open, high: d.high, low: d.low, close: d.close, volume: 0 } : null);
    });
    const onRange = (r: LogicalRange | null) => {
      if (r && r.from < 5 && needOlderRef.current) needOlderRef.current();
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    return () => {
      chart.remove();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    candleRef.current?.applyOptions({ upColor: colors.up, downColor: colors.down, wickUpColor: colors.up, wickDownColor: colors.down });
  }, [colors.up, colors.down]);

  useEffect(() => {
    chartRef.current?.applyOptions({ watermark: { visible: !!watermark, text: watermark ?? '', color: '#10b98122', fontSize: 28 } });
  }, [watermark]);

  // Data
  useEffect(() => {
    const cs = candleRef.current;
    const vs = volRef.current;
    const chart = chartRef.current;
    if (!cs || !vs || !chart) return;
    const prevFirst = firstTimeRef.current;
    const range = chart.timeScale().getVisibleLogicalRange();
    cs.setData(candles.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })));
    vs.setData(visibility.volume ? candles.map((c) => ({ time: c.time as UTCTimestamp, value: c.volume, color: c.close >= c.open ? colors.up + '55' : colors.down + '55' })) : []);
    const newFirst = candles[0]?.time ?? null;
    firstTimeRef.current = newFirst;
    if (lastResetKey.current !== resetKey && candles.length) {
      lastResetKey.current = resetKey;
      const n = candles.length;
      const show = window.innerWidth < 700 ? 70 : 140;
      chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - show), to: n + 4 });
    } else if (range && prevFirst !== null && newFirst !== null && newFirst < prevFirst) {
      // Older candles prepended: keep the viewport on the same bars.
      const added = candles.findIndex((c) => c.time === prevFirst);
      if (added > 0) chart.timeScale().setVisibleLogicalRange({ from: range.from + added, to: range.to + added });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, visibility.volume, resetKey]);

  const [compact, setCompact] = useState(false);
  useEffect(() => {
    if (!el.current) return;
    const ro = new ResizeObserver(([e]) => setCompact(e.contentRect.width < 640));
    ro.observe(el.current);
    return () => ro.disconnect();
  }, []);
  const overlays = useMemo(() => buildOverlays(snapshot, candles, visibility, colors, { compact }), [snapshot, candles, visibility, colors, compact]);

  useEffect(() => {
    primRef.current?.setData(candles.map((c) => c.time), overlays.boxes, overlays.segments);
    const times = new Set(candles.map((c) => c.time));
    candleRef.current?.setMarkers(overlays.markers.filter((m) => times.has(m.time)).map((m) => ({ ...m, time: m.time as UTCTimestamp })));
  }, [overlays, candles]);

  const last = candles[candles.length - 1];
  const shown = legend ?? last ?? null;
  return (
    <div className="chart-wrap" style={{ height }}>
      {shown && (
        <div className="chart-legend">
          <span>O {fmtPrice(shown.open)}</span> <span>H {fmtPrice(shown.high)}</span> <span>L {fmtPrice(shown.low)}</span>{' '}
          <span className={shown.close >= shown.open ? 'pos' : 'neg'}>C {fmtPrice(shown.close)}</span>
        </div>
      )}
      <div ref={el} className="chart" />
    </div>
  );
}
