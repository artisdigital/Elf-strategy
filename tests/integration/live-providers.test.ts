// LIVE provider checks against real public endpoints. Opt-in:  npm run test:live
// (requires network access; set NODE_USE_ENV_PROXY=1 behind an HTTPS proxy).
import { describe, expect, it } from 'vitest';
import { BinanceUsAdapter } from '../../src/server/providers/binanceus.js';

const live = process.env.ELF_LIVE_TESTS === '1';

describe.skipIf(!live)('LIVE Binance.US', () => {
  it('returns 120 real BTCUSD 15m candles aligned to 15-minute boundaries', async () => {
    const a = new BinanceUsAdapter();
    const c = await a.fetchCandles({ symbol: 'BTCUSD', timeframe: '15m', limit: 120 });
    expect(c).toHaveLength(120);
    expect(c.every((x) => x.time % 900 === 0)).toBe(true);
    expect(c.every((x) => x.high >= x.low && x.high >= Math.max(x.open, x.close) && x.low <= Math.min(x.open, x.close))).toBe(true);
    const age = Date.now() / 1000 - c[c.length - 1].time;
    expect(age).toBeLessThan(1800);
  });

  it('exchangeInfo gives tick and lot sizes', async () => {
    const s = await new BinanceUsAdapter().instrumentSpec('BTCUSD');
    expect(s?.tickSize).toBeGreaterThan(0);
    expect(s?.stepSize).toBeGreaterThan(0);
  });
});
