// FAKE provider adapter for integration tests only — synthetic candles, never live data.
import type { Candle, InstrumentInfo, Timeframe } from '../../src/shared/types.js';
import { tfSeconds } from '../../src/shared/types.js';
import { ProviderError, type FetchCandlesArgs, type ProviderAdapter } from '../../src/server/providers/types.js';

export class FakeAdapter implements ProviderAdapter {
  readonly id = 'binanceus' as const; // occupies a real id slot so routes accept it
  readonly name = 'Fake (tests)';
  readonly description = 'Synthetic test data';
  readonly requiresKey = false;
  readonly credentialFields = [];
  readonly dataNotes = ['synthetic'];
  readonly timeframes: Timeframe[] = ['1m', '5m', '15m', '1h', '1d'];
  readonly supportsStreaming = false;
  readonly pageSize = 1000;
  fail: 'none' | 'network' | 'auth' = 'none';
  calls = 0;
  candles = new Map<Timeframe, Candle[]>();

  constructor(bars = 300, tf: Timeframe = '1m') {
    this.candles.set(tf, FakeAdapter.series(bars, tf));
    this.candles.set('1d', FakeAdapter.series(120, '1d'));
  }

  /** Deterministic zig-zag series ending with the current (forming) candle. */
  static series(n: number, tf: Timeframe, endTime = Math.floor(Date.now() / 1000)): Candle[] {
    const step = tfSeconds(tf);
    const last = Math.floor(endTime / step) * step;
    const out: Candle[] = [];
    for (let k = 0; k < n; k++) {
      const t = last - (n - 1 - k) * step;
      const base = 100 + 5 * Math.sin(k / 9) + (k % 7) * 0.2;
      out.push({ time: t, open: base, high: base + 1 + (k % 3) * 0.3, low: base - 1 - (k % 4) * 0.25, close: base + ((k % 5) - 2) * 0.3, volume: 10 + k });
    }
    return out;
  }

  isDelayed() {
    return false;
  }
  instruments(): InstrumentInfo[] {
    return [{ provider: 'binanceus', symbol: 'FAKE', providerSymbol: 'FAKE', name: 'Fake', assetClass: 'crypto' }];
  }

  async fetchCandles(a: FetchCandlesArgs): Promise<Candle[]> {
    this.calls++;
    if (this.fail === 'network') throw new ProviderError('Network error: ECONNRESET', 'network');
    if (this.fail === 'auth') throw new ProviderError('Authentication failed (401)', 'auth');
    let list = this.candles.get(a.timeframe) ?? [];
    if (a.start != null) list = list.filter((c) => c.time >= a.start!);
    if (a.end != null) list = list.filter((c) => c.time <= a.end!);
    const limit = a.limit ?? 500;
    return a.start != null ? list.slice(0, limit) : list.slice(-limit);
  }

  /** Append the next candle (simulates the market moving on). */
  advance(tf: Timeframe = '1m') {
    const list = this.candles.get(tf)!;
    const last = list[list.length - 1];
    const step = tfSeconds(tf);
    list.push({ ...last, time: last.time + step, open: last.close, close: last.close + 0.1 });
  }

  async testConnection() {
    return { ok: this.fail === 'none', message: this.fail === 'none' ? 'ok' : 'fail' };
  }
}
