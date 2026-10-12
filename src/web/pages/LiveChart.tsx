import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { useMarketStream } from '../lib/useMarketStream';
import { PageHeader } from '../components/Layout';
import { MarketPicker } from '../components/MarketPicker';
import { ElfChart } from '../components/ElfChart';
import { FeedBadge, Notice, StateBadge, Toggle } from '../components/ui';
import { SignalCard, StructureCard, SequenceBar } from '../components/ElfPanels';
import { api, marketQs } from '../lib/api';
import type { Candle } from '../../shared/types';
import type { Visibility } from '../lib/overlays';

export const VIS_LABELS: Record<keyof Visibility, string> = {
  sessions: 'Sessions',
  levels: 'Liquidity',
  swings: 'Swings',
  sweeps: 'Sweeps',
  bos: 'BOS',
  displacement: 'Displacement',
  fvg: 'FVG',
  orderBlocks: 'Order blocks',
  plan: 'Entry / SL / TP',
  outcomes: 'Signals & outcomes',
  volume: 'Volume',
};

export function useVisibility() {
  const { app, saveApp } = useStore();
  const [vis, setVis] = useState<Visibility | null>(null);
  useEffect(() => {
    if (app && !vis) setVis(app.chart.visibility as Visibility);
  }, [app, vis]);
  const toggle = (k: keyof Visibility, v: boolean) => {
    const next = { ...(vis ?? (app!.chart.visibility as Visibility)), [k]: v };
    setVis(next);
    void saveApp({ chart: { visibility: next } });
  };
  return { vis: vis ?? (app?.chart.visibility as Visibility | undefined), toggle };
}

export function VisibilityToggles({ vis, toggle }: { vis: Visibility; toggle: (k: keyof Visibility, v: boolean) => void }) {
  return (
    <div className="vis">
      {(Object.keys(VIS_LABELS) as (keyof Visibility)[]).map((k) => (
        <Toggle key={k} checked={vis[k]} onChange={(v) => toggle(k, v)} label={VIS_LABELS[k]} />
      ))}
    </div>
  );
}

export function LiveChart() {
  const { market, setMarket, app } = useStore();
  const stream = useMarketStream(market);
  const { vis, toggle } = useVisibility();
  const [older, setOlder] = useState<Candle[]>([]);
  const [showPanel, setShowPanel] = useState(false);
  const [showToggles, setShowToggles] = useState(false);
  const loading = useRef(false);
  const exhausted = useRef(false);
  const s = stream.monitor?.snapshot ?? null;

  useEffect(() => {
    setOlder([]);
    exhausted.current = false;
  }, [market.provider, market.symbol, market.timeframe]);

  const candles = older.length && stream.candles.length ? [...older.filter((c) => c.time < stream.candles[0].time), ...stream.candles] : stream.candles;

  const loadOlder = useCallback(async () => {
    if (loading.current || exhausted.current || !candles.length) return;
    loading.current = true;
    try {
      const r = await api.get<{ candles: Candle[] }>(`/api/candles?${marketQs(market)}&limit=500&before=${candles[0].time}`);
      if (!r.candles.length) exhausted.current = true;
      setOlder((o) => [...r.candles, ...o].filter((c, i, a) => i === 0 || c.time > a[i - 1].time));
    } catch {
      exhausted.current = true;
    } finally {
      loading.current = false;
    }
  }, [candles, market]);

  if (!app || !vis) return null;
  return (
    <>
      <PageHeader
        title="Live Charts"
        right={
          <div className="row wrap gap">
            <MarketPicker market={market} onChange={setMarket} />
          </div>
        }
      />
      <div className="chart-bar">
        <FeedBadge feed={stream.feed} compact />
        <StateBadge state={s?.state} />
        <span className="muted small grow ellipsis" title={s?.stateReason}>
          {s?.stateReason ?? 'Loading…'}
        </span>
        <button className="btn btn-sm" onClick={() => setShowToggles((v) => !v)}>
          Layers
        </button>
        <button className="btn btn-sm" onClick={() => setShowPanel((v) => !v)}>
          {showPanel ? 'Hide' : 'Details'}
        </button>
      </div>
      {showToggles && <VisibilityToggles vis={vis} toggle={toggle} />}
      {stream.feed?.status === 'NEEDS KEY' && <Notice tone="warn">This provider needs an API key — see Market Data.</Notice>}
      <div className={`chart-layout ${showPanel ? 'with-panel' : ''}`}>
        <ElfChart
          candles={candles}
          snapshot={s}
          visibility={vis}
          colors={app.chart.colors as any}
          onNeedOlder={loadOlder}
          resetKey={`${market.provider}:${market.symbol}:${market.timeframe}`}
          watermark={`${market.symbol} ${market.timeframe}`}
        />
        {showPanel && (
          <div className="side-panel">
            <SequenceBar snapshot={s} />
            <SignalCard s={s} />
            <StructureCard s={s} />
          </div>
        )}
      </div>
      <p className="muted small">
        Times in America/New_York. Drawings come from the server ELF engine on closed candles; the last candle may still be forming. Older candles loaded by scrolling are display-only (the engine uses the
        latest {app.chart.historyBars} bars).
      </p>
    </>
  );
}
