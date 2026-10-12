import { describe, expect, it } from 'vitest';
import { Feed, M15, buildBullishContext, runBullishSetup, sweepBelow97, testConfig } from './helpers.js';
import { activeSessions, sessionInstanceAt, sessionWindows, SessionTracker, tradingDayKey } from '../../src/engine/sessions.js';
import { defaultConfig } from '../../src/engine/config.js';
import { ElfEngine } from '../../src/engine/engine.js';
import { ReplaySession } from '../../src/engine/replay.js';
import { runBacktest, findGaps, parameterSearch } from '../../src/engine/backtest.js';
import { computeStats } from '../../src/engine/analytics.js';
import { zonedTimeToUtc } from '../../src/shared/time.js';
import type { Candle } from '../../src/shared/types.js';

const utc = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) / 1000;

describe('Session engine (America/New_York, DST aware)', () => {
  const w = sessionWindows(defaultConfig());

  it('London 03:00 ET is 08:00 UTC in winter (EST)', () => {
    expect(activeSessions(w, utc(2025, 3, 7, 8, 0))).toEqual(['london']);
    expect(activeSessions(w, utc(2025, 3, 7, 7, 45))).toEqual([]);
  });

  it('London 03:00 ET is 07:00 UTC after the DST change (EDT)', () => {
    expect(activeSessions(w, utc(2025, 3, 10, 7, 0))).toEqual(['london']);
    expect(activeSessions(w, utc(2025, 3, 10, 6, 45))).toEqual([]);
  });

  it('New York 08:00–11:00 ET with exclusive end, across the November change', () => {
    expect(activeSessions(w, utc(2025, 10, 31, 12, 0))).toEqual(['newYork']); // EDT
    expect(activeSessions(w, utc(2025, 11, 3, 13, 0))).toEqual(['newYork']); // EST
    expect(activeSessions(w, utc(2025, 11, 3, 16, 0))).toEqual([]); // 11:00 ET → closed
    expect(activeSessions(w, utc(2025, 11, 3, 15, 45))).toEqual(['newYork']);
  });

  it('wrapping Sydney session (v1.1: 17:00–02:00 ET) keys bars after midnight to the start date', () => {
    const cfg = defaultConfig();
    cfg.sessions.asia.enabled = true;
    const asia = sessionWindows(cfg).find((s) => s.name === 'asia')!;
    expect(sessionInstanceAt(asia, zonedTimeToUtc('2025-06-02', 20 * 60))).toBe('asia:2025-06-02');
    expect(sessionInstanceAt(asia, zonedTimeToUtc('2025-06-03', 1 * 60 + 45))).toBe('asia:2025-06-02');
    expect(sessionInstanceAt(asia, zonedTimeToUtc('2025-06-03', 2 * 60))).toBeNull();
    expect(sessionInstanceAt(asia, zonedTimeToUtc('2025-06-02', 17 * 60))).toBe('asia:2025-06-02');
  });

  it('completes a session range with its high/low when the window ends', () => {
    const tr = new SessionTracker(defaultConfig());
    let t = zonedTimeToUtc('2025-06-03', 2 * 60 + 45);
    const out = [];
    for (let k = 0; k < 14; k++) {
      const price = 100 + (k === 5 ? 3 : 0) - (k === 8 ? 2 : 0);
      out.push(tr.update({ time: t, open: price, high: price + 0.5, low: price - 0.5, close: price, volume: 1 }));
      t += M15;
    }
    const done = out.flatMap((u) => u.completed);
    expect(done).toHaveLength(1);
    expect(done[0].name).toBe('london');
    expect(done[0].high).toBe(103.5);
    expect(done[0].low).toBe(97.5);
    expect(done[0].complete).toBe(true);
  });

  it('day boundary options', () => {
    const t = utc(2025, 6, 3, 22, 0); // 18:00 ET
    expect(tradingDayKey(t, 'ny-midnight')).toBe('2025-06-03');
    expect(tradingDayKey(t, 'ny-1700')).toBe('2025-06-04');
    expect(tradingDayKey(t, 'utc-midnight')).toBe('2025-06-03');
  });
});

/** Place the bullish scenario so the sweep candle opens at `sweepUtc`. */
function sessionFeed(sweepUtc: number, cfgOver = {}) {
  // context = 90 + 8 = 98 bars before the sweep
  const start = sweepUtc - 98 * M15;
  return new Feed(testConfig({ sessionGate: 'both', ...cfgOver }), { start });
}

describe('Session gating', () => {
  it('London sweep may confirm during New York (within the window)', () => {
    const sweepAt = zonedTimeToUtc('2025-03-04', 5 * 60 + 45); // 05:45 ET
    const f = sessionFeed(sweepAt, { maxConfirmBars: 20 });
    buildBullishContext(f);
    sweepBelow97(f, 2);
    expect(f.candles.at(-1)!.time).toBe(sweepAt);
    // wait quietly 06:00 → 07:45 (8 bars), then displacement + BOS at 08:00 / 08:15 ET
    for (let k = 0; k < 8; k++) f.bar(97.6, 98.2, 97.5, 98.0);
    f.bar(98.0, 100.4, 97.9, 100.2);
    f.bar(100.2, 101.8, 100.1, 101.6);
    const s = f.engine.snapshot().lastSignal!;
    expect(s).toBeTruthy();
    expect(s.session).toEqual(['newYork']);
    expect(s.status).toBe('ENTRY_READY');
  });

  it('a confirmation outside any enabled session is FILTERED with the reason', () => {
    const sweepAt = zonedTimeToUtc('2025-03-04', 5 * 60 + 30); // 05:30 ET
    const f = sessionFeed(sweepAt);
    buildBullishContext(f);
    sweepBelow97(f, 2);
    f.bar(97.3, 98.2, 97.2, 98.0); // 05:45
    f.bar(98.0, 100.4, 97.9, 100.2); // 06:00 — outside
    f.bar(100.2, 101.8, 100.1, 101.6); // 06:15 — BOS outside
    const s = f.engine.snapshot().lastSignal!;
    expect(s.status).toBe('FILTERED');
    expect(s.reasons).toContain('Outside the permitted session');
  });

  it('a sweep outside the session is recorded but not tracked as a setup', () => {
    const sweepAt = zonedTimeToUtc('2025-03-04', 13 * 60); // 13:00 ET
    const f = sessionFeed(sweepAt);
    buildBullishContext(f);
    sweepBelow97(f, 2);
    const sw = f.of('sweep_preliminary')[0];
    expect(sw.data!.eligible).toBe(false);
    expect(f.engine.snapshot().candidate).toBeNull();
  });
});

describe('FVG', () => {
  const base = (mode: 'wick' | 'close' = 'wick') => {
    const f = new Feed(testConfig({ fvgMitigation: mode }));
    f.flat(30);
    f.bar(100, 100.5, 99.5, 100.2); // A: high 100.5
    f.bar(100.2, 102.5, 100.1, 102.3); // B
    f.bar(102.3, 103, 101.2, 102.8); // C: low 101.2 > A.high → bullish FVG 100.5–101.2
    return f;
  };

  it('detects a bullish three-candle gap', () => {
    const f = base();
    const g = f.engine.snapshot().fvgs.at(-1)!;
    expect(g.direction).toBe('bullish');
    expect(g.bottom).toBe(100.5);
    expect(g.top).toBe(101.2);
    expect(g.status).toBe('active');
  });

  it('partial → mitigated (wick) → stays mitigated', () => {
    const f = base('wick');
    f.bar(102.8, 102.9, 101.0, 102.0);
    expect(f.engine.snapshot().fvgs.at(-1)!.status).toBe('partial');
    f.bar(102.0, 102.1, 100.5, 101.5);
    expect(f.engine.snapshot().fvgs.at(-1)!.status).toBe('mitigated');
  });

  it('close-mode only mitigates on a close through, and invalidation wins', () => {
    const f = base('close');
    f.bar(102.8, 102.9, 100.4, 101.5);
    expect(f.engine.snapshot().fvgs.at(-1)!.status).toBe('partial');
    f.bar(101.5, 101.6, 100.0, 100.2);
    expect(f.engine.snapshot().fvgs.at(-1)!.status).toBe('invalidated');
  });

  it('detects a bearish gap', () => {
    const f = new Feed();
    f.flat(30);
    f.bar(100, 100.5, 99.5, 99.8);
    f.bar(99.8, 99.9, 97.5, 97.7);
    f.bar(97.7, 98.8, 97.0, 97.2);
    const g = f.engine.snapshot().fvgs.at(-1)!;
    expect(g.direction).toBe('bearish');
    expect(g.top).toBe(99.5);
    expect(g.bottom).toBe(98.8);
  });
});

describe('Order blocks', () => {
  it('selects the last bearish candle before the bullish displacement leg of a confirmed setup', () => {
    const f = new Feed();
    runBullishSetup(f);
    const s = f.engine.snapshot();
    const sig = s.lastSignal!;
    expect(sig.orderBlockId).toBeTruthy();
    const ob = s.orderBlocks.find((o) => o.id === sig.orderBlockId)!;
    const sweepCandle = f.candles.at(-3)!; // sweep candle is bearish, right before displacement
    expect(ob.direction).toBe('bullish');
    expect(ob.time).toBe(sweepCandle.time);
    expect(ob.high).toBe(sweepCandle.high);
    expect(ob.low).toBe(sweepCandle.low);
    expect(ob.mid).toBeCloseTo((sweepCandle.high + sweepCandle.low) / 2, 10);
  });

  it('creates no order block for a BOS leg without qualifying displacement', () => {
    const f = new Feed();
    buildBullishContext(f);
    let p = 98.6;
    while (p < 101.2) {
      f.bar(p, p + 0.55, p - 0.05, p + 0.5);
      p += 0.5;
    }
    expect(f.of('bos').length).toBeGreaterThan(0);
    expect(f.engine.snapshot().orderBlocks).toHaveLength(0);
  });
});

describe('Timing & no-lookahead', () => {
  it('signals are produced on candle close: entry = close of the confirmation candle', () => {
    const f = new Feed();
    const ev = runBullishSetup(f);
    const last = f.candles.at(-1)!;
    const er = ev.find((e) => e.type === 'entry_ready')!;
    expect(er.time).toBe(last.time);
    expect(er.closeTime).toBe(last.time + M15);
    expect(er.data!.entry).toBe(last.close);
  });

  it('HTF bias ignores the still-forming daily candle', () => {
    const day0 = utc(2025, 1, 1, 0);
    const htf: Candle[] = Array.from({ length: 60 }, (_, k) => ({ time: day0 + k * 86400, open: 100 + k, high: 101 + k, low: 99 + k, close: 100 + k, volume: 1 }));
    const today = day0 + 60 * 86400;
    htf.push({ time: today, open: 160, high: 160, low: 1, close: 1, volume: 1 }); // forming, absurd close
    const e = new ElfEngine({ ...testConfig({ htfBiasEnabled: true, htfEmaLength: 20 }) }, { symbol: 'X', timeframe: '15m', htfCandles: htf });
    e.update({ time: today + 10 * 3600, open: 1, high: 2, low: 0.5, close: 1, volume: 1 });
    const b = e.snapshot().bias;
    expect(b.value).toBe('bullish');
    expect(b.htfTime).toBe(today - 86400);
    // after the daily candle closes, it is used
    const e2 = new ElfEngine({ ...testConfig({ htfBiasEnabled: true, htfEmaLength: 20 }) }, { symbol: 'X', timeframe: '15m', htfCandles: htf });
    e2.update({ time: today + 86400, open: 1, high: 2, low: 0.5, close: 1, volume: 1 });
    expect(e2.snapshot().bias.htfTime).toBe(today);
    expect(e2.snapshot().bias.value).toBe('bearish');
  });

  it('incremental results never depend on future candles (prefix invariance)', () => {
    const f = new Feed();
    runBullishSetup(f);
    for (let k = 0; k < 10; k++) f.bar(101.4 + k * 0.3, 102 + k * 0.3, 101 + k * 0.3, 101.7 + k * 0.3);
    const all = f.candles;
    for (const k of [60, 95, 99, 100, 101, 105]) {
      const a = new ElfEngine(f.engine.config, { symbol: 'TEST', timeframe: '15m' });
      all.slice(0, k).forEach((c) => a.update(c));
      const b = new ElfEngine(f.engine.config, { symbol: 'TEST', timeframe: '15m' });
      all.forEach((c, idx) => idx < k && b.update(c));
      expect(JSON.stringify(a.snapshot())).toBe(JSON.stringify(b.snapshot()));
    }
  });

  it('rejects out-of-order and invalid candles', () => {
    const e = new ElfEngine(testConfig(), { symbol: 'X', timeframe: '15m' });
    e.update({ time: 1000, open: 1, high: 2, low: 0.5, close: 1, volume: 0 });
    expect(() => e.update({ time: 1000, open: 1, high: 2, low: 0.5, close: 1, volume: 0 })).toThrow();
    expect(() => e.update({ time: 2000, open: 1, high: 0.4, low: 0.5, close: 1, volume: 0 })).toThrow();
  });
});

describe('Replay', () => {
  it('never reveals or computes with future candles', () => {
    const f = new Feed();
    runBullishSetup(f);
    for (let k = 0; k < 20; k++) f.bar(101.4 + k * 0.5, 102 + k * 0.5, 101 + k * 0.5, 101.9 + k * 0.5);
    const r = new ReplaySession(f.candles, f.engine.config, { symbol: 'TEST', timeframe: '15m', startCursor: 50 });
    while (!r.done) {
      r.step();
      const now = r.currentTime!;
      expect(r.visible().every((c) => c.time <= now)).toBe(true);
      const snap = r.snapshot();
      expect(snap.lastTime).toBe(now);
      const times: number[] = [];
      JSON.stringify(snap, (k, v) => {
        // closeTime = the current candle's own close (open + 15m), not future data.
        if (typeof v === 'number' && /time$/i.test(k)) times.push(k === 'closeTime' ? v - M15 : v);
        return v;
      });
      expect(times.every((t) => t <= now)).toBe(true);
    }
  });

  it('stepping backwards rebuilds the identical state', () => {
    const f = new Feed();
    runBullishSetup(f);
    const r = new ReplaySession(f.candles, f.engine.config, { symbol: 'TEST', timeframe: '15m' });
    r.seek(f.candles.length);
    r.seek(97);
    const a = JSON.stringify(r.snapshot());
    const r2 = new ReplaySession(f.candles, f.engine.config, { symbol: 'TEST', timeframe: '15m', startCursor: 97 });
    expect(JSON.stringify(r2.snapshot())).toBe(a);
  });
});

describe('Backtest', () => {
  const make = () => {
    const f = new Feed();
    runBullishSetup(f);
    f.bar(101.4, 120.5, 101.3, 120.2); // TP2
    f.flat(40, 110, 0.6);
    // second setup (mirrored context would be complex) — enough for reproducibility checks
    return f;
  };

  it('uses the production engine and is reproducible from its inputs', () => {
    const f = make();
    const input = {
      provider: 'synthetic', symbol: 'TEST', timeframe: '15m' as const, candles: f.candles, htfCandles: [],
      config: f.engine.config, costs: { feeRatePerSide: 0.001, slippageBps: 2 }, risk: { startingEquity: 10000, riskPct: 1, maxRiskPct: 2 },
    };
    const a = runBacktest(input);
    const b = runBacktest(input);
    expect(a.resultHash).toBe(b.resultHash);
    expect(a.dataHash).toBe(b.dataHash);
    expect(a.trades).toHaveLength(1);
    expect(a.trades[0].outcome).toBe('tp2');
    expect(a.trades[0].grossR).toBeCloseTo(f.engine.snapshot().trades[0].resultR!, 10);
    expect(a.trades[0].netR).toBeLessThan(a.trades[0].grossR); // costs applied
    expect(a.equity.at(-1)!.equity).toBeCloseTo(10000 + a.trades[0].netR * 100, 6);
    // changing the config changes the hash
    const c = runBacktest({ ...input, config: { ...input.config, minRR: 4.5 } });
    expect(c.configHash).not.toBe(a.configHash);
    expect(c.trades).toHaveLength(0);
    expect(c.signals.filtered).toBe(1);
  });

  it('reports data gaps', () => {
    const cs: Candle[] = [0, 1, 2, 5, 6].map((k) => ({ time: k * 900, open: 1, high: 1, low: 1, close: 1, volume: 0 }));
    expect(findGaps(cs, '15m')).toEqual([{ from: 1800, to: 4500, missingBars: 2 }]);
  });

  it('splits in-sample / out-of-sample and runs parameter search on in-sample only', () => {
    const f = make();
    const split = f.candles[50].time;
    const input = {
      provider: 'synthetic', symbol: 'TEST', timeframe: '15m' as const, candles: f.candles, htfCandles: [],
      config: f.engine.config, costs: { feeRatePerSide: 0, slippageBps: 0 }, risk: { startingEquity: 10000, riskPct: 1, maxRiskPct: 2 }, splitTime: split,
    };
    const r = runBacktest(input);
    expect(r.stats.inSample.count + r.stats.outOfSample.count).toBe(r.stats.all.count);
    expect(r.trades.every((t) => (t.entryTime >= split ? t.sample === 'out' : t.sample === 'in'))).toBe(true);
    const ps = parameterSearch(input, [{ key: 'minRR', values: [2, 3] }]);
    expect(ps.rows).toHaveLength(2);
    expect(ps.rows.every((row) => row.inSampleTrades === 0)).toBe(true); // all trades are after the split
  });
});

describe('Analytics', () => {
  it('computes metrics with clear definitions and sample warnings', () => {
    const s = computeStats([
      { r: 3, direction: 'long', time: 1, session: 'london' },
      { r: -1, direction: 'short', time: 2, session: 'newYork' },
      { r: -1, direction: 'long', time: 3, session: 'london' },
      { r: 0, direction: 'long', time: 4, session: 'london' },
    ]);
    expect(s.count).toBe(4);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(2);
    expect(s.breakeven).toBe(1);
    expect(s.winRate).toBe(0.25);
    expect(s.netR).toBe(1);
    expect(s.profitFactor).toBe(1.5);
    expect(s.maxDrawdownR).toBe(2);
    expect(s.bySession.london.count).toBe(3);
    expect(s.sampleWarning).toMatch(/unreliable/);
    expect(computeStats([{ r: 2, direction: 'long', time: 1 }]).profitFactor).toBeNull();
  });
});
