// Candle cache + historical range retrieval. Only CLOSED candles are persisted.

import type { Candle, ProviderId, Timeframe } from '../shared/types.js';
import { tfSeconds } from '../shared/types.js';
import type { Db } from './db.js';
import type { ProviderRegistry } from './providers/index.js';
import { ProviderError } from './providers/types.js';

export class CandleStore {
  constructor(private readonly db: Db, private readonly providers: ProviderRegistry) {}

  saveClosed(provider: ProviderId, symbol: string, tf: Timeframe, candles: Candle[]) {
    if (!candles.length) return;
    const stmt = this.db.prepare(
      'INSERT INTO candles (provider, symbol, tf, time, open, high, low, close, volume) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT DO UPDATE SET open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close, volume=excluded.volume',
    );
    this.db.exec('BEGIN');
    try {
      for (const c of candles) stmt.run(provider, symbol, tf, c.time, c.open, c.high, c.low, c.close, c.volume);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  readCached(provider: ProviderId, symbol: string, tf: Timeframe, from: number, to: number): Candle[] {
    return this.db
      .prepare('SELECT time, open, high, low, close, volume FROM candles WHERE provider=? AND symbol=? AND tf=? AND time BETWEEN ? AND ? ORDER BY time')
      .all(provider, symbol, tf, from, to) as unknown as Candle[];
  }

  private covered(provider: ProviderId, symbol: string, tf: Timeframe, from: number, to: number): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM candle_ranges WHERE provider=? AND symbol=? AND tf=? AND from_time <= ? AND to_time >= ? LIMIT 1')
      .get(provider, symbol, tf, from, to);
    return !!row;
  }

  /**
   * Closed candles in [from, to] (UTC seconds). Uses the cache when the range was fetched
   * before; otherwise pages through the provider. Never synthesises missing candles.
   */
  async getRange(provider: ProviderId, symbol: string, tf: Timeframe, from: number, to: number, maxCandles = 200_000): Promise<{ candles: Candle[]; source: 'cache' | 'provider' }> {
    const step = tfSeconds(tf);
    const nowClosedLimit = Math.floor(Date.now() / 1000) - step;
    const end = Math.min(to, nowClosedLimit);
    if (end < from) return { candles: [], source: 'cache' };
    if ((end - from) / step > maxCandles) throw new ProviderError(`Range too large (> ${maxCandles} candles). Narrow the dates or use a higher timeframe.`, 'bad_request');
    if (this.covered(provider, symbol, tf, from, end)) return { candles: this.readCached(provider, symbol, tf, from, end), source: 'cache' };

    const adapter = this.providers.get(provider);
    const creds = this.providers.credentials(provider);
    const all: Candle[] = [];
    let cursor = from;
    let guard = 0;
    while (cursor <= end && guard++ < 1000) {
      const page = await adapter.fetchCandles({ symbol, timeframe: tf, start: cursor, end, limit: adapter.pageSize }, creds);
      const fresh = page.filter((c) => c.time >= cursor && c.time <= end);
      if (!fresh.length) {
        // Empty page: skip ahead (e.g. weekends / market closed) by one page worth of time.
        const skip = cursor + adapter.pageSize * step;
        if (page.length === 0 && skip > end) break;
        cursor = page.length ? page[page.length - 1].time + step : skip;
        continue;
      }
      all.push(...fresh);
      cursor = fresh[fresh.length - 1].time + step;
    }
    const closed = all.filter((c) => c.time + step <= Math.floor(Date.now() / 1000));
    this.saveClosed(provider, symbol, tf, closed);
    this.db.prepare('INSERT INTO candle_ranges (provider, symbol, tf, from_time, to_time) VALUES (?,?,?,?,?)').run(provider, symbol, tf, from, closed.length ? closed[closed.length - 1].time : from);
    return { candles: this.readCached(provider, symbol, tf, from, end), source: 'provider' };
  }

  /** Most recent `limit` candles from the provider (may include the forming one). */
  async latest(provider: ProviderId, symbol: string, tf: Timeframe, limit: number): Promise<Candle[]> {
    const adapter = this.providers.get(provider);
    const creds = this.providers.credentials(provider);
    const out: Candle[] = [];
    let end: number | undefined;
    let guard = 0;
    while (out.length < limit && guard++ < 50) {
      const want = Math.min(adapter.pageSize, limit - out.length);
      const page = await adapter.fetchCandles({ symbol, timeframe: tf, end, limit: want }, creds);
      const older = end === undefined ? page : page.filter((c) => c.time < (out[0]?.time ?? Infinity));
      if (!older.length) break;
      out.unshift(...older);
      if (page.length < want) break;
      end = older[0].time - tfSeconds(tf);
    }
    return out.slice(-limit);
  }

  /** Older candles for scroll-back on the chart. */
  async before(provider: ProviderId, symbol: string, tf: Timeframe, beforeTime: number, limit: number): Promise<Candle[]> {
    const adapter = this.providers.get(provider);
    const creds = this.providers.credentials(provider);
    const page = await adapter.fetchCandles({ symbol, timeframe: tf, end: beforeTime - tfSeconds(tf), limit: Math.min(limit, adapter.pageSize) }, creds);
    return page.filter((c) => c.time < beforeTime);
  }
}
