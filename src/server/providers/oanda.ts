// OANDA v20 REST (forex & metals). Requires a personal API token.
//   practice: https://api-fxpractice.oanda.com   live: https://api-fxtrade.oanda.com
//   GET /v3/instruments/{instrument}/candles?granularity=M15&price=M  (max 5000 per request)
// Candles are fetched by REST polling — OANDA's streaming endpoint provides prices, not candles,
// so the feed is honestly labelled REST POLLING.

import type { Candle, InstrumentInfo, Timeframe } from '../../shared/types.js';
import { tfSeconds } from '../../shared/types.js';
import type { InstrumentSpec } from '../../engine/planner.js';
import { httpJson, ProviderError, sortDedupe, type Credentials, type FetchCandlesArgs, type FetchFn, type ProviderAdapter } from './types.js';

const GRAN: Partial<Record<Timeframe, string>> = { '1m': 'M1', '5m': 'M5', '15m': 'M15', '30m': 'M30', '1h': 'H1', '4h': 'H4', '1d': 'D' };

const INSTRUMENTS: [string, string, 'forex' | 'metal' | 'index'][] = [
  ['EUR_USD', 'Euro / US Dollar', 'forex'],
  ['GBP_USD', 'British Pound / US Dollar', 'forex'],
  ['USD_JPY', 'US Dollar / Japanese Yen', 'forex'],
  ['AUD_USD', 'Australian Dollar / US Dollar', 'forex'],
  ['USD_CAD', 'US Dollar / Canadian Dollar', 'forex'],
  ['GBP_JPY', 'British Pound / Japanese Yen', 'forex'],
  ['EUR_JPY', 'Euro / Japanese Yen', 'forex'],
  ['USD_CHF', 'US Dollar / Swiss Franc', 'forex'],
  ['NZD_USD', 'New Zealand Dollar / US Dollar', 'forex'],
  ['XAU_USD', 'Gold / US Dollar', 'metal'],
  ['XAG_USD', 'Silver / US Dollar', 'metal'],
  ['US30_USD', 'US Wall St 30 (CFD)', 'index'],
  ['NAS100_USD', 'US Nas 100 (CFD)', 'index'],
  ['SPX500_USD', 'US SPX 500 (CFD)', 'index'],
];

export class OandaAdapter implements ProviderAdapter {
  readonly id = 'oanda' as const;
  readonly name = 'OANDA';
  readonly description = 'Forex and metals candles from the OANDA v20 REST API (mid prices).';
  readonly requiresKey = true;
  readonly credentialFields = [
    { key: 'token', label: 'API token', secret: true, help: 'Personal access token from OANDA “Manage API Access”. Market data only — the app never places orders.' },
    { key: 'environment', label: 'Environment', secret: false, help: 'practice (fxPractice demo) or live (fxTrade).', options: ['practice', 'live'] },
    { key: 'accountId', label: 'Account ID (optional)', secret: false, help: 'Only needed for instrument specifications (pip location, minimum size).' },
  ];
  readonly dataNotes = [
    'Requires an OANDA account and API token (a free practice account works).',
    'OANDA tokens cannot be restricted to read-only; the app only calls market-data endpoints. Keep the token server-side and rotate it if exposed.',
    'Candles via REST polling (not a candle WebSocket). Mid prices (bid/ask average).',
    'Daily candles aligned to 17:00 America/New_York.',
  ];
  readonly timeframes: Timeframe[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
  readonly supportsStreaming = false;
  readonly pageSize = 5000;

  constructor(private readonly fetchFn: FetchFn = fetch) {}

  isDelayed() {
    return false;
  }

  private base(creds: Credentials | null) {
    return (creds?.environment ?? 'practice') === 'live' ? 'https://api-fxtrade.oanda.com' : 'https://api-fxpractice.oanda.com';
  }

  private headers(creds: Credentials | null) {
    if (!creds?.token) throw new ProviderError('OANDA API token not configured', 'auth');
    return { Authorization: `Bearer ${creds.token}`, 'Accept-Datetime-Format': 'UNIX' };
  }

  instruments(): InstrumentInfo[] {
    return INSTRUMENTS.map(([symbol, name, assetClass]) => ({ provider: this.id, symbol, providerSymbol: symbol, name, assetClass }));
  }

  async fetchCandles(args: FetchCandlesArgs, creds: Credentials | null): Promise<Candle[]> {
    const g = GRAN[args.timeframe];
    if (!g) throw new ProviderError(`Timeframe ${args.timeframe} not supported`, 'unsupported');
    const params = new URLSearchParams({ granularity: g, price: 'M', dailyAlignment: '17', alignmentTimezone: 'America/New_York' });
    if (args.start != null) {
      params.set('from', String(args.start));
      // OANDA rejects from+to spans wider than 5000 candles → use from+count for wide ranges.
      if (args.end != null && (args.end - args.start) / tfSeconds(args.timeframe) < this.pageSize) params.set('to', String(args.end + 1));
      else params.set('count', String(Math.min(args.limit ?? 500, this.pageSize)));
    } else {
      params.set('count', String(Math.min(args.limit ?? 500, this.pageSize)));
      if (args.end != null) params.set('to', String(args.end + 1));
    }
    const body = await httpJson(this.fetchFn, `${this.base(creds)}/v3/instruments/${encodeURIComponent(args.symbol)}/candles?${params}`, { headers: this.headers(creds) });
    const list = Array.isArray(body?.candles) ? body.candles : [];
    return sortDedupe(
      list
        .filter((c: any) => c.mid)
        .map((c: any) => ({ time: Math.floor(Number(c.time)), open: Number(c.mid.o), high: Number(c.mid.h), low: Number(c.mid.l), close: Number(c.mid.c), volume: Number(c.volume ?? 0) })),
    );
  }

  async testConnection(creds: Credentials | null) {
    if (!creds?.token) return { ok: false, message: 'NEEDS KEY — enter an OANDA API token.' };
    try {
      const c = await this.fetchCandles({ symbol: 'EUR_USD', timeframe: '15m', limit: 2 }, creds);
      return { ok: c.length > 0, message: `OK — received ${c.length} EUR_USD candles from the ${creds.environment ?? 'practice'} environment.` };
    } catch (e: any) {
      return { ok: false, message: e.message };
    }
  }

  async instrumentSpec(symbol: string, creds: Credentials | null): Promise<InstrumentSpec | null> {
    const [base, quote] = symbol.split('_');
    const metal = base === 'XAU' || base === 'XAG';
    if (['US30', 'NAS100', 'SPX500'].includes(base)) {
      return { kind: 'contract', contractMultiplier: 1, stepSize: 1, minQty: 1, quoteToAccountRate: quote === 'USD' ? 1 : null, source: 'OANDA index CFD: 1 unit = 1 USD per point (verify with your broker)' };
    }
    const spec: InstrumentSpec = {
      kind: 'forex',
      pipSize: quote === 'JPY' ? 0.01 : metal ? (base === 'XAU' ? 0.01 : 0.001) : 0.0001,
      lotSize: metal ? 1 : 100000,
      stepSize: 1,
      quoteToAccountRate: quote === 'USD' ? 1 : null,
      source: 'Standard conventions (verify with your broker)',
    };
    if (creds?.token && creds.accountId) {
      try {
        const body = await httpJson(this.fetchFn, `${this.base(creds)}/v3/accounts/${encodeURIComponent(creds.accountId)}/instruments?instruments=${encodeURIComponent(symbol)}`, { headers: this.headers(creds) });
        const inst = body?.instruments?.[0];
        if (inst) {
          spec.pipSize = Math.pow(10, Number(inst.pipLocation));
          spec.stepSize = Math.pow(10, -Number(inst.tradeUnitsPrecision ?? 0));
          spec.minQty = Number(inst.minimumTradeSize ?? 1);
          spec.source = 'OANDA account instruments endpoint';
        }
      } catch {
        /* fall back to conventions */
      }
    }
    return spec;
  }
}
