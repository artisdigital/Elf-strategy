// Binance.US public market data (no API key required for klines / exchangeInfo).
// REST:      https://api.binance.us/api/v3/klines   (max 1000 per request)
// WebSocket: wss://stream.binance.us:9443/ws/<symbol>@kline_<interval>
// Kline open times are UTC milliseconds; we normalise to UTC seconds.

import type { Candle, InstrumentInfo, Timeframe } from '../../shared/types.js';
import { tfSeconds } from '../../shared/types.js';
import type { InstrumentSpec } from '../../engine/planner.js';
import { httpJson, ProviderError, sortDedupe, type FetchCandlesArgs, type FetchFn, type ProviderAdapter, type StreamHandlers } from './types.js';

const REST = 'https://api.binance.us';
const WS = 'wss://stream.binance.us:9443/ws';
const INTERVAL: Partial<Record<Timeframe, string>> = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h', '1d': '1d' };

const INSTRUMENTS: [string, string][] = [
  ['BTCUSD', 'Bitcoin / US Dollar'],
  ['ETHUSD', 'Ether / US Dollar'],
  ['SOLUSD', 'Solana / US Dollar'],
  ['XRPUSD', 'XRP / US Dollar'],
  ['BTCUSDT', 'Bitcoin / Tether'],
  ['ETHUSDT', 'Ether / Tether'],
];

export function parseBinanceKline(k: any[]): Candle {
  return { time: Math.floor(Number(k[0]) / 1000), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]) };
}

export class BinanceUsAdapter implements ProviderAdapter {
  readonly id = 'binanceus' as const;
  readonly name = 'Binance.US';
  readonly description = 'Spot crypto market data from Binance.US public endpoints.';
  readonly requiresKey = false;
  readonly credentialFields = [];
  readonly dataNotes = [
    'Public market data — no API key needed. Never add trading or withdrawal keys here.',
    'Real-time via WebSocket kline stream when reachable; otherwise REST polling (status shows which).',
    'Daily candles are aligned to 00:00 UTC by the exchange.',
    'Binance.US is not available in every US state; availability is the provider’s decision.',
  ];
  readonly timeframes: Timeframe[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
  readonly supportsStreaming = true;
  readonly pageSize = 1000;

  constructor(
    private readonly fetchFn: FetchFn = fetch,
    private readonly wsCtor: typeof WebSocket | undefined = (globalThis as any).WebSocket,
  ) {}

  isDelayed() {
    return false;
  }

  instruments(): InstrumentInfo[] {
    return INSTRUMENTS.map(([symbol, name]) => ({ provider: this.id, symbol, providerSymbol: symbol, name, assetClass: 'crypto' }));
  }

  async fetchCandles(args: FetchCandlesArgs): Promise<Candle[]> {
    const interval = INTERVAL[args.timeframe];
    if (!interval) throw new ProviderError(`Timeframe ${args.timeframe} not supported`, 'unsupported');
    const params = new URLSearchParams({ symbol: args.symbol.toUpperCase(), interval, limit: String(Math.min(args.limit ?? 500, this.pageSize)) });
    if (args.start != null) params.set('startTime', String(args.start * 1000));
    if (args.end != null) params.set('endTime', String(args.end * 1000 + tfSeconds(args.timeframe) * 1000 - 1));
    const body = await httpJson(this.fetchFn, `${REST}/api/v3/klines?${params}`);
    if (!Array.isArray(body)) throw new ProviderError('Unexpected klines response', 'server');
    return sortDedupe(body.map(parseBinanceKline));
  }

  stream(symbol: string, timeframe: Timeframe, h: StreamHandlers): () => void {
    const interval = INTERVAL[timeframe];
    if (!this.wsCtor || !interval) {
      queueMicrotask(() => h.onClose('WebSocket unavailable in this runtime'));
      return () => {};
    }
    let closed = false;
    let reported = false;
    // Node's WebSocket may fire 'error' without a following 'close' (e.g. failed handshake), so
    // either event ends the stream — reported exactly once.
    const end = (reason: string) => {
      if (closed || reported) return;
      reported = true;
      h.onClose(reason);
    };
    const ws = new this.wsCtor(`${WS}/${symbol.toLowerCase()}@kline_${interval}`);
    ws.onopen = () => h.onOpen();
    ws.onmessage = (m: MessageEvent) => {
      try {
        const msg = JSON.parse(String(m.data));
        if (msg.e !== 'kline' || !msg.k) return;
        const k = msg.k;
        h.onCandle({ time: Math.floor(k.t / 1000), open: Number(k.o), high: Number(k.h), low: Number(k.l), close: Number(k.c), volume: Number(k.v) }, !!k.x);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onerror = (e: Event) => {
      end(`WebSocket error: ${(e as any)?.message ?? 'connection failed'}`);
      try {
        ws.close();
      } catch {
        /* noop */
      }
    };
    ws.onclose = (e: CloseEvent) => end(`WebSocket closed (${e.code})`);
    return () => {
      closed = true;
      try {
        ws.close();
      } catch {
        /* noop */
      }
    };
  }

  async testConnection() {
    try {
      const c = await this.fetchCandles({ symbol: 'BTCUSD', timeframe: '15m', limit: 2 });
      return { ok: c.length > 0, message: c.length ? `OK — received ${c.length} BTCUSD 15m candles (latest ${new Date(c[c.length - 1].time * 1000).toISOString()})` : 'No data returned' };
    } catch (e: any) {
      return { ok: false, message: e.message };
    }
  }

  async instrumentSpec(symbol: string): Promise<InstrumentSpec | null> {
    const body = await httpJson(this.fetchFn, `${REST}/api/v3/exchangeInfo?symbol=${encodeURIComponent(symbol.toUpperCase())}`);
    const s = body?.symbols?.[0];
    if (!s) return null;
    const pf = s.filters.find((f: any) => f.filterType === 'PRICE_FILTER');
    const lot = s.filters.find((f: any) => f.filterType === 'LOT_SIZE');
    return {
      kind: 'units',
      tickSize: pf ? Number(pf.tickSize) : null,
      stepSize: lot ? Number(lot.stepSize) : null,
      minQty: lot ? Number(lot.minQty) : null,
      quoteToAccountRate: s.quoteAsset === 'USD' ? 1 : null,
      source: `Binance.US exchangeInfo (${s.baseAsset}/${s.quoteAsset})`,
    };
  }
}
