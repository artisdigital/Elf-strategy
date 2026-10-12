// Live market subscription: candles (closed + forming), honest feed status and the
// server-side ELF monitor snapshot, delivered over Server-Sent Events.

import { useEffect, useRef, useState } from 'react';
import type { EngineSnapshot } from '../../engine/engine';
import type { Candle, FeedState } from '../../shared/types';
import { marketQs, type Market } from './api';

export interface MonitorInfo {
  snapshot: EngineSnapshot;
  htf: { status: string; message: string; count: number };
}

export interface MarketStream {
  candles: Candle[];
  closedThrough: number | null;
  feed: FeedState | null;
  monitor: MonitorInfo | null;
  connected: boolean;
  error: string | null;
  version: number; // increments when candles change (for chart refresh)
}

export function useMarketStream(market: Market | null): MarketStream {
  const [state, setState] = useState<MarketStream>({ candles: [], closedThrough: null, feed: null, monitor: null, connected: false, error: null, version: 0 });
  const candlesRef = useRef<Candle[]>([]);

  useEffect(() => {
    if (!market) return;
    candlesRef.current = [];
    setState({ candles: [], closedThrough: null, feed: null, monitor: null, connected: false, error: null, version: 0 });
    const es = new EventSource(`/api/stream?${marketQs(market)}`);
    const bump = (patch: Partial<MarketStream>) => setState((s) => ({ ...s, ...patch, version: s.version + 1 }));
    const upsert = (c: Candle) => {
      const list = candlesRef.current;
      const last = list[list.length - 1];
      if (!last || c.time > last.time) list.push(c);
      else if (c.time === last.time) list[list.length - 1] = c;
      else return;
      candlesRef.current = list;
    };
    es.addEventListener('open', () => setState((s) => ({ ...s, connected: true, error: null })));
    es.addEventListener('error', () => setState((s) => ({ ...s, connected: false, error: 'Stream connection lost — reconnecting…' })));
    es.addEventListener('init', (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      candlesRef.current = d.candles;
      bump({ candles: [...d.candles], closedThrough: d.closedThrough, feed: d.feed, monitor: d.monitor, connected: true, error: null });
    });
    es.addEventListener('history', (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      candlesRef.current = d.candles;
      bump({ candles: [...d.candles], closedThrough: d.closedThrough });
    });
    es.addEventListener('candle', (e) => {
      upsert(JSON.parse((e as MessageEvent).data));
      bump({ candles: [...candlesRef.current] });
    });
    es.addEventListener('closed', (e) => {
      const c = JSON.parse((e as MessageEvent).data) as Candle;
      upsert(c);
      bump({ candles: [...candlesRef.current], closedThrough: c.time });
    });
    es.addEventListener('status', (e) => setState((s) => ({ ...s, feed: JSON.parse((e as MessageEvent).data) })));
    es.addEventListener('monitor', (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      setState((s) => ({ ...s, monitor: { snapshot: d.snapshot, htf: d.htf } }));
    });
    return () => es.close();
  }, [market?.provider, market?.symbol, market?.timeframe]);

  return state;
}
