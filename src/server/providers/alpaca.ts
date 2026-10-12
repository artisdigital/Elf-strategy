// Alpaca Market Data v2 (US equities). Requires API key id + secret.
//   GET https://data.alpaca.markets/v2/stocks/{symbol}/bars?timeframe=15Min&feed=iex
// The free plan's IEX feed is real-time but covers only IEX volume (a fraction of the
// consolidated tape). SIP requires a paid subscription; without it recent SIP data is
// unavailable — Alpaca rejects such requests, which the feed reports as ERROR.

import type { Candle, InstrumentInfo, Timeframe } from '../../shared/types.js';
import { tfSeconds } from '../../shared/types.js';
import type { InstrumentSpec } from '../../engine/planner.js';
import { httpJson, ProviderError, sortDedupe, type Credentials, type FetchCandlesArgs, type FetchFn, type ProviderAdapter } from './types.js';

const TF: Partial<Record<Timeframe, string>> = { '1m': '1Min', '5m': '5Min', '15m': '15Min', '30m': '30Min', '1h': '1Hour', '4h': '4Hour', '1d': '1Day' };

const INSTRUMENTS: [string, string, 'equity' | 'index'][] = [
  ['SPY', 'SPDR S&P 500 ETF', 'index'],
  ['QQQ', 'Invesco QQQ (Nasdaq-100)', 'index'],
  ['IWM', 'iShares Russell 2000 ETF', 'index'],
  ['AAPL', 'Apple Inc.', 'equity'],
  ['MSFT', 'Microsoft Corp.', 'equity'],
  ['NVDA', 'NVIDIA Corp.', 'equity'],
  ['TSLA', 'Tesla Inc.', 'equity'],
];

export class AlpacaAdapter implements ProviderAdapter {
  readonly id = 'alpaca' as const;
  readonly name = 'Alpaca';
  readonly description = 'US equity bars from Alpaca Market Data v2.';
  readonly requiresKey = true;
  readonly credentialFields = [
    { key: 'keyId', label: 'API key ID', secret: true, help: 'From the Alpaca dashboard. A paper-trading key is sufficient for market data.' },
    { key: 'secretKey', label: 'API secret key', secret: true, help: 'Stored encrypted on the server; never sent to the browser.' },
    { key: 'feed', label: 'Data feed', secret: false, help: 'iex (free, real-time, IEX volume only) or sip (requires a paid subscription).', options: ['iex', 'sip'] },
  ];
  readonly dataNotes = [
    'Requires an Alpaca account (free). Use a paper-trading key; the app never places orders.',
    'Free “iex” feed: real-time but only IEX exchange trades — volume and some prices differ from the consolidated tape.',
    '“sip” consolidated feed requires a paid Alpaca data subscription.',
    'The ELF London window (03:00–06:00 ET) is US pre-market; extended-hours bars are sparse and depend on the feed.',
    'Candles via REST polling.',
  ];
  readonly timeframes: Timeframe[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
  readonly supportsStreaming = false;
  readonly pageSize = 10000;

  constructor(private readonly fetchFn: FetchFn = fetch) {}

  isDelayed() {
    // Without a SIP subscription Alpaca rejects recent SIP requests (surfaced as ERROR), so data that does arrive is current.
    return false;
  }

  private headers(creds: Credentials | null) {
    if (!creds?.keyId || !creds?.secretKey) throw new ProviderError('Alpaca API key not configured', 'auth');
    return { 'APCA-API-KEY-ID': creds.keyId, 'APCA-API-SECRET-KEY': creds.secretKey };
  }

  instruments(): InstrumentInfo[] {
    return INSTRUMENTS.map(([symbol, name, assetClass]) => ({ provider: this.id, symbol, providerSymbol: symbol, name, assetClass }));
  }

  async fetchCandles(args: FetchCandlesArgs, creds: Credentials | null): Promise<Candle[]> {
    const tf = TF[args.timeframe];
    if (!tf) throw new ProviderError(`Timeframe ${args.timeframe} not supported`, 'unsupported');
    const headers = this.headers(creds);
    const limit = Math.min(args.limit ?? 500, this.pageSize);
    const params = new URLSearchParams({ timeframe: tf, feed: creds?.feed ?? 'iex', adjustment: 'raw', limit: String(limit) });
    if (args.start != null) {
      params.set('start', new Date(args.start * 1000).toISOString());
      params.set('sort', 'asc');
    } else {
      // Latest N bars: query newest-first then reverse.
      params.set('sort', 'desc');
      // Window wide enough for `limit` bars including nights/weekends.
      const span = Math.max(30 * 86400, limit * tfSeconds(args.timeframe) * (args.timeframe === '1d' ? 1.6 : 4));
      params.set('start', new Date(Date.now() - span * 1000).toISOString());
    }
    if (args.end != null) params.set('end', new Date(args.end * 1000).toISOString());
    const out: Candle[] = [];
    let pageToken: string | null = null;
    do {
      if (pageToken) params.set('page_token', pageToken);
      const body = await httpJson(this.fetchFn, `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(args.symbol)}/bars?${params}`, { headers });
      for (const b of body?.bars ?? []) out.push({ time: Math.floor(Date.parse(b.t) / 1000), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v });
      pageToken = body?.next_page_token ?? null;
    } while (pageToken && out.length < limit);
    return sortDedupe(out).slice(-limit);
  }

  async testConnection(creds: Credentials | null) {
    if (!creds?.keyId || !creds?.secretKey) return { ok: false, message: 'NEEDS KEY — enter an Alpaca key ID and secret.' };
    try {
      const c = await this.fetchCandles({ symbol: 'SPY', timeframe: '1d', limit: 3 }, creds);
      return { ok: c.length > 0, message: `OK — received ${c.length} SPY daily bars on the ${creds.feed ?? 'iex'} feed.` };
    } catch (e: any) {
      return { ok: false, message: e.message };
    }
  }

  async instrumentSpec(): Promise<InstrumentSpec | null> {
    return { kind: 'units', tickSize: 0.01, stepSize: 1, minQty: 1, quoteToAccountRate: 1, source: 'US equities: whole shares, $0.01 tick (fractional shares not assumed)' };
  }
}
