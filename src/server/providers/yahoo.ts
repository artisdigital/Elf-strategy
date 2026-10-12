// Yahoo Finance chart endpoint — an UNOFFICIAL, rate-limited fallback.
// Always labelled DELAYED: Yahoo does not guarantee real-time data, many exchanges are
// delayed 15+ minutes, and intraday history is limited (1m ≈ 7 days, 15m ≈ 60 days).

import type { Candle, InstrumentInfo, Timeframe } from '../../shared/types.js';
import { httpJson, ProviderError, type FetchCandlesArgs, type FetchFn, type ProviderAdapter } from './types.js';
import { tfSeconds } from '../../shared/types.js';

const INTERVAL: Partial<Record<Timeframe, string>> = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '60m', '1d': '1d' };
const MAX_DAYS: Partial<Record<Timeframe, number>> = { '1m': 7, '5m': 59, '15m': 59, '30m': 59, '1h': 729, '1d': 3650 };

const INSTRUMENTS: [string, string, InstrumentInfo['assetClass']][] = [
  ['SPY', 'SPDR S&P 500 ETF', 'index'],
  ['QQQ', 'Invesco QQQ', 'index'],
  ['ES=F', 'E-mini S&P 500 futures (front month)', 'index'],
  ['NQ=F', 'E-mini Nasdaq-100 futures (front month)', 'index'],
  ['GC=F', 'Gold futures (front month)', 'metal'],
  ['EURUSD=X', 'EUR/USD', 'forex'],
  ['BTC-USD', 'Bitcoin USD (Yahoo composite)', 'crypto'],
];

export class YahooAdapter implements ProviderAdapter {
  readonly id = 'yahoo' as const;
  readonly name = 'Yahoo Finance (fallback)';
  readonly description = 'Unofficial chart endpoint — use only as a fallback.';
  readonly requiresKey = false;
  readonly credentialFields = [];
  readonly dataNotes = [
    'UNOFFICIAL endpoint with no service guarantee; it may rate-limit (HTTP 429) or change without notice.',
    'Always shown as DELAYED — exchange delays vary (often 10–20 minutes for futures/equities).',
    'Intraday history is limited: 1m ≈ 7 days, 5m–30m ≈ 60 days.',
    'Futures symbols (ES=F) roll between contracts; levels can jump at the roll.',
  ];
  readonly timeframes: Timeframe[] = ['1m', '5m', '15m', '30m', '1h', '1d'];
  readonly supportsStreaming = false;
  readonly pageSize = 5000;

  constructor(private readonly fetchFn: FetchFn = fetch) {}

  isDelayed() {
    return true;
  }

  instruments(): InstrumentInfo[] {
    return INSTRUMENTS.map(([symbol, name, assetClass]) => ({ provider: this.id, symbol, providerSymbol: symbol, name, assetClass }));
  }

  async fetchCandles(args: FetchCandlesArgs): Promise<Candle[]> {
    const interval = INTERVAL[args.timeframe];
    if (!interval) throw new ProviderError(`Timeframe ${args.timeframe} not supported by Yahoo`, 'unsupported');
    const now = Math.floor(Date.now() / 1000);
    const end = args.end ?? now;
    const maxSpan = (MAX_DAYS[args.timeframe] ?? 59) * 86400;
    const start = Math.max(args.start ?? end - (args.limit ?? 500) * tfSeconds(args.timeframe) * 1.6, now - maxSpan);
    const params = new URLSearchParams({ interval, period1: String(Math.floor(start)), period2: String(end + tfSeconds(args.timeframe)), includePrePost: 'true' });
    const body = await httpJson(this.fetchFn, `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(args.symbol)}?${params}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (ELF Trading App)' },
    });
    const r = body?.chart?.result?.[0];
    if (!r) throw new ProviderError(body?.chart?.error?.description ?? 'No data', 'not_found');
    const ts: number[] = r.timestamp ?? [];
    const q = r.indicators?.quote?.[0] ?? {};
    const out: Candle[] = [];
    for (let k = 0; k < ts.length; k++) {
      const o = q.open?.[k], h = q.high?.[k], l = q.low?.[k], c = q.close?.[k];
      // Yahoo returns nulls for missing intervals — skipped (reported as gaps), never filled.
      if ([o, h, l, c].some((v) => v == null || !Number.isFinite(v))) continue;
      out.push({ time: ts[k], open: o, high: h, low: l, close: c, volume: q.volume?.[k] ?? 0 });
    }
    const limit = args.limit ?? out.length;
    return out.slice(-limit);
  }

  async testConnection() {
    try {
      const c = await this.fetchCandles({ symbol: 'SPY', timeframe: '1d', limit: 3 });
      return { ok: c.length > 0, message: `Reachable — ${c.length} SPY daily candles. Data is unofficial and DELAYED.` };
    } catch (e: any) {
      return { ok: false, message: e.message };
    }
  }
}
