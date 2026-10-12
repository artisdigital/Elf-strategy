// ELF v1.1 Pine-parity engine — SYNTHETIC candles only.
import { describe, expect, it } from 'vitest';
import { defaultConfig, type ElfConfig } from '../../src/engine/config.js';
import { Feed, M15, sweepBelow97 } from './helpers.js';
import { zonedTimeToUtc } from '../../src/shared/time.js';

/** 2025-03-02 18:00 UTC: the UTC day rolls after 24 bars, so the warm-up spike becomes PDH. */
const START = Date.UTC(2025, 2, 2, 18, 0) / 1000;

function v11(over: Partial<ElfConfig> = {}): ElfConfig {
  const d = defaultConfig();
  return {
    ...d,
    engineModel: 'v1.1',
    sessionGate: 'off',
    sessions: { london: { ...d.sessions.london, enabled: false }, newYork: { ...d.sessions.newYork, enabled: false }, asia: { ...d.sessions.asia, enabled: false } },
    htfBiasEnabled: false,
    dayBoundary: 'utc-midnight',
    swingLength: 2,
    ...over,
  };
}

/** Previous UTC day with a spike high (→ PDH) and a dip (→ PDL 92), then swing low 97 and swing high 101. */
function context(f: Feed, pdh = 120, extraFlat = 0) {
  f.flat(5);
  f.bar(100, pdh, 99.5, 100);
  f.flat(4);
  f.bar(100, 100.5, 92, 100); // previous-day dip → PDL 92, far below the scenario
  f.flat(19 + extraFlat); // day rolls at bar 24 → PDH = pdh, PDL = 92
  f.bar(100, 100.5, 99, 99.2);
  f.bar(99.2, 99.4, 97, 97.5); // pivot low 97
  f.bar(97.5, 98.5, 97.4, 98.3);
  f.bar(98.3, 99.5, 98.2, 99.3); // swing low 97 confirmed
  f.bar(99.3, 101, 99.2, 100.8); // pivot high 101
  f.bar(100.8, 100.9, 99.8, 100);
  f.bar(100, 100.2, 99.0, 99.2); // swing high 101 confirmed
  f.bar(99.2, 99.3, 98.5, 98.6);
}

const confirmLong = (f: Feed) => f.bar(97.3, 101.6, 97.2, 101.4); // close > level, crosses 101, body ≫ ATR

describe('ELF v1.1 — liquidity set (Pine §2/§4/§5)', () => {
  it('uses only the LATEST swing low/high, PDH/PDL and session levels', () => {
    const f = new Feed(v11(), { start: START });
    context(f);
    const lv = f.engine.snapshot().levels.filter((l) => l.status === 'untested');
    expect(lv.map((l) => l.label).sort()).toEqual(['PDH', 'PDL', 'Swing H', 'Swing L']);
    expect(lv.find((l) => l.kind === 'PDH')!.price).toBe(120);
    expect(lv.find((l) => l.kind === 'SWING_LOW')!.price).toBe(97);
  });

  it('a newer swing replaces the previous one (only the latest is liquidity)', () => {
    const f = new Feed(v11(), { start: START });
    f.flat(30);
    f.bar(100, 100.5, 99, 99.2);
    f.bar(99.2, 99.4, 96.8, 97.4); // pivot 96.8
    f.bar(97.4, 98.6, 97.9, 98.4);
    f.bar(98.4, 99.2, 98.2, 99.0);
    f.bar(99.0, 99.1, 97.6, 97.9); // pivot 97.6 (higher low, not within EQ tolerance)
    f.bar(97.9, 98.6, 97.8, 98.4);
    f.bar(98.4, 99.5, 98.3, 99.3);
    const lows = f.engine.snapshot().levels.filter((l) => l.kind === 'SWING_LOW');
    expect(lows.find((l) => l.status === 'untested')!.price).toBe(97.6);
    expect(lows.find((l) => l.price === 96.8)!.status).toBe('expired');
  });

  it('EQH/EQL = average of two consecutive pivots within 0.10 × ATR', () => {
    const f = new Feed(v11(), { start: START });
    f.flat(30);
    f.bar(100, 100.5, 99, 99.2);
    f.bar(99.2, 99.4, 97, 97.5);
    f.bar(97.5, 98.5, 97.4, 98.3);
    f.bar(98.3, 99.5, 98.2, 99.3);
    f.bar(99.3, 99.6, 98.4, 98.6);
    f.bar(98.6, 98.7, 97.04, 97.6);
    f.bar(97.6, 98.5, 97.5, 98.3);
    f.bar(98.3, 99.5, 98.2, 99.3);
    const eql = f.engine.snapshot().levels.find((l) => l.kind === 'EQL');
    expect(eql?.price).toBeCloseTo(97.02, 10);
  });
});

describe('ELF v1.1 — sweep (Pine §8)', () => {
  it('requires the wick past the NEAREST level by ≥ threshold AND a close back on the same candle', () => {
    const f = new Feed(v11(), { start: START });
    context(f);
    sweepBelow97(f, 2, 96.9); // wick deep enough but closes BELOW the level
    expect(f.of('sweep_preliminary')).toHaveLength(0);
  });

  it('touch / sub-threshold is not a sweep; exactly the threshold is', () => {
    const a = new Feed(v11(), { start: START });
    context(a);
    sweepBelow97(a, 0.999);
    expect(a.of('sweep_preliminary')).toHaveLength(0);
    const b = new Feed(v11(), { start: START });
    context(b);
    sweepBelow97(b, 1);
    expect(b.of('sweep_preliminary')).toHaveLength(1);
    expect(b.engine.snapshot().state).toBe('SWEPT');
  });

  it('one setup per sweep: new sweeps are ignored while a setup is pending', () => {
    const f = new Feed(v11(), { start: START });
    context(f);
    sweepBelow97(f, 2);
    const atr = f.atr();
    f.bar(97.3, 101 + atr * 0.5, 97.2, 100.5); // wicks above swing high 101 and closes back (would be a bearish sweep)
    expect(f.of('sweep_preliminary')).toHaveLength(1);
  });

  it('news blackout blocks new sweeps (live use)', () => {
    const f = new Feed(v11({ newsBlackout: true }), { start: START });
    context(f);
    sweepBelow97(f, 2);
    expect(f.of('sweep_preliminary')).toHaveLength(0);
  });
});

describe('ELF v1.1 — confirmation on ONE closed candle (Pine §9)', () => {
  it('close back beyond the level + BOS cross + displacement → ENTRY SETUP with v1.1 plan and quality score', () => {
    const f = new Feed(v11(), { start: START });
    context(f);
    const sweepBar = f.candles.length;
    sweepBelow97(f, 2);
    const sweepLow = f.candles[sweepBar].low;
    f.bar(97.3, 97.5, sweepLow - 1, 97.4); // trades lower after the sweep (no close below level → still pending)
    const ev = confirmLong(f);
    expect(ev.map((e) => e.type)).toEqual(expect.arrayContaining(['bos', 'displacement', 'confirmed', 'entry_ready']));
    const s = f.engine.snapshot().lastSignal!;
    expect(s.status).toBe('ENTRY_READY');
    // v1.1 stop: the SWEEP CANDLE's wick ± 0.10 ATR — not the later lower low
    expect(s.plan.stop).toBeCloseTo(sweepLow - 0.1 * s.plan.atr, 10);
    expect(s.plan.tp2).toBe(120);
    expect(s.plan.tp2Label).toBe('PDH');
    expect(s.plan.rr).toBeCloseTo((120 - 101.4) / (101.4 - s.plan.stop), 10);
    // quality: bias 20 (filter off) + sweep 25 + BOS/disp 20 + R:R 15 (+ FVG 10) + window 0 (gate off, no sessions)
    expect(s.quality).toBeGreaterThanOrEqual(80);
  });

  it('BOS and displacement on different candles do NOT confirm (v1.1), then the setup expires', () => {
    const f = new Feed(v11({ maxConfirmBars: 4 }), { start: START });
    context(f);
    sweepBelow97(f, 2);
    f.bar(97.3, 99.6, 97.2, 99.4); // displacement, no BOS
    const half = 0.5 * f.atr();
    f.bar(101.2 - half, 101.3, 101.2 - half - 0.1, 101.2); // BOS by close, body 0.5× ATR
    f.flat(3, 101.2, 0.2);
    expect(f.of('confirmed')).toHaveLength(0);
    expect(f.of('expired')).toHaveLength(1);
    expect(f.engine.snapshot().state === 'FILTERED' || f.engine.snapshot().state === 'BUILD').toBe(true);
  });

  it('BOS must be a CROSS: if the prior close is already above the swing, no confirmation', () => {
    const f = new Feed(v11(), { start: START });
    context(f);
    sweepBelow97(f, 2);
    const small = 0.4 * f.atr();
    f.bar(101.1 - small, 101.3, 101.1 - small - 0.1, 101.1); // closes above 101 without displacement
    f.bar(101.1, 104.5, 101.0, 104.3); // big candle, but prev close already > 101 → no bosUp
    expect(f.of('confirmed')).toHaveLength(0);
  });

  it('a large candle in the wrong direction never confirms', () => {
    const f = new Feed(v11(), { start: START });
    context(f);
    sweepBelow97(f, 2);
    f.bar(99, 99.1, 97.1, 97.2);
    expect(f.of('confirmed')).toHaveLength(0);
  });

  it('order block = last opposite candle before confirmation, drawn as its BODY with a 50% line', () => {
    const f = new Feed(v11(), { start: START });
    context(f);
    sweepBelow97(f, 2);
    const sweepCandle = f.candles.at(-1)!; // bearish candle 98.6 → 97.3
    confirmLong(f);
    const s = f.engine.snapshot();
    const ob = s.orderBlocks.find((o) => o.id === s.lastSignal!.orderBlockId)!;
    expect(ob.time).toBe(sweepCandle.time);
    expect(ob.high).toBe(Math.max(sweepCandle.open, sweepCandle.close));
    expect(ob.low).toBe(Math.min(sweepCandle.open, sweepCandle.close));
    expect(ob.mid).toBeCloseTo((ob.high + ob.low) / 2, 10);
  });
});

describe('ELF v1.1 — filters and the one-setup lock', () => {
  it('R:R below 1:3 is FILTERED; the filtered setup locks new sweeps until it resolves (v1.1)', () => {
    const f = new Feed(v11(), { start: START });
    context(f, 112);
    sweepBelow97(f, 2);
    confirmLong(f);
    const s = f.engine.snapshot().lastSignal!;
    expect(s.status).toBe('FILTERED');
    expect(s.reasons.join()).toMatch(/below minimum 3\.0/);
    f.bar(101.4, 101.6, 101.2, 101.5);
    expect(f.engine.snapshot().stateReason).toMatch(/monitored until SL \/ TP2/);
    // while locked, a fresh sweep is ignored
    const atr = f.atr();
    f.bar(101.5, 101.6, 97 - atr, 101.3);
    expect(f.of('sweep_preliminary')).toHaveLength(1);
    expect(f.engine.snapshot().trade).toBeNull();
    // stop hit → lock released
    f.bar(101.4, 101.5, s.plan.stop - 0.1, 97.0);
    expect(s.lockedOutcome ?? f.engine.snapshot().lastSignal!.lockedOutcome).toBe('sl');
  });

  it('1:2 minimum accepts the same setup', () => {
    const f = new Feed(v11({ minRR: 2 }), { start: START });
    context(f, 112);
    sweepBelow97(f, 2);
    confirmLong(f);
    expect(f.engine.snapshot().lastSignal!.status).toBe('ENTRY_READY');
  });

  it('no measurable target → FILTERED', () => {
    const f = new Feed(v11(), { start: START });
    context(f, 101.2); // PDH above every context high (not swept) but below the 101.4 entry → nothing above
    sweepBelow97(f, 2);
    confirmLong(f);
    const s = f.engine.snapshot().lastSignal!;
    expect(s.reasons).toContain('No measurable target');
  });

  it('HTF bias unavailable is FILTERED rather than guessed (documented deviation)', () => {
    const f = new Feed(v11({ htfBiasEnabled: true }), { start: START });
    context(f);
    sweepBelow97(f, 2);
    confirmLong(f);
    expect(f.engine.snapshot().lastSignal!.reasons).toContain('Higher-timeframe bias unavailable');
  });
});

describe('ELF v1.1 — sessions and the daily cycle', () => {
  const withLondon = (over: Partial<ElfConfig> = {}) => {
    const d = defaultConfig();
    return v11({ sessions: { london: { enabled: true, start: '03:00', end: '06:00' }, newYork: { enabled: true, start: '08:00', end: '11:00' }, asia: { ...d.sessions.asia, enabled: false } }, ...over });
  };

  it('sweeps outside an enabled window are not taken; inside they are', () => {
    // context ends at 13:00 ET (outside) on 2025-03-04
    const sweepAt = zonedTimeToUtc('2025-03-04', 13 * 60);
    const f = new Feed(withLondon({ sessionGate: 'both', dailyCycleReset: false }), { start: sweepAt - 38 * M15 });
    context(f);
    sweepBelow97(f, 2);
    expect(f.of('sweep_preliminary')).toHaveLength(0);
    const g = new Feed(withLondon({ sessionGate: 'both', dailyCycleReset: false }), { start: zonedTimeToUtc('2025-03-04', 5 * 60) - 38 * M15 });
    context(g);
    sweepBelow97(g, 2); // 05:00 ET — London
    expect(g.of('sweep_preliminary')).toHaveLength(1);
  });

  it('a confirmation candle outside the window issues nothing; the London sweep confirms in New York', () => {
    const sweepAt = zonedTimeToUtc('2025-03-04', 5 * 60 + 45);
    const start = Date.UTC(2025, 2, 4) / 1000 - 24 * M15; // previous UTC day holds the PDH spike
    const f = new Feed(withLondon({ sessionGate: 'both', dailyCycleReset: false, maxConfirmBars: 20 }), { start });
    context(f, 120, (sweepAt - start) / M15 - 38);
    expect(f.candles.length * M15 + start).toBe(sweepAt);
    sweepBelow97(f, 2); // 05:45 ET
    f.bar(97.3, 101.6, 97.2, 101.4); // 06:00 ET — would confirm, but outside windows
    expect(f.of('entry_ready')).toHaveLength(0);
    expect(f.engine.snapshot().state).toBe('SWEPT');
    // price returns below the swing so a later cross is possible
    f.bar(101.4, 101.5, 99.8, 100.0);
    for (let k = 0; k < 6; k++) f.bar(100.0, 100.4, 99.6, 100.0); // → 07:45
    const cl = Math.max(101.7, 100 + 1.2 * f.atr());
    f.bar(100.0, cl + 0.1, 99.9, cl); // 08:00 ET New York: cross + displacement
    const s = f.engine.snapshot().lastSignal!;
    expect(s.session).toEqual(['newYork']);
    expect(s.status).toBe('ENTRY_READY');
  });

  it('the first enabled session open resets a pending sweep (daily cycle)', () => {
    const f = new Feed(withLondon({ sessionGate: 'off', dailyCycleReset: true, maxConfirmBars: 50 }), { start: zonedTimeToUtc('2025-03-04', 2 * 60) - 38 * M15 });
    context(f);
    sweepBelow97(f, 2); // 02:00 ET
    for (let k = 0; k < 4; k++) f.bar(97.5, 98, 97.4, 97.8); // → 03:00 ET London open
    const ex = f.of('expired');
    expect(ex).toHaveLength(1);
    expect(String(ex[0].data!.reason)).toMatch(/Daily cycle reset/);
  });
});

describe('ELF v1.1 — outcomes and optional hard rules', () => {
  it('TP2 and stop-loss outcomes', () => {
    const a = new Feed(v11(), { start: START });
    context(a);
    sweepBelow97(a, 2);
    confirmLong(a);
    a.bar(101.4, 120.5, 101.3, 120.2);
    expect(a.engine.snapshot().trades.at(-1)!.outcome).toBe('tp2');
    const b = new Feed(v11(), { start: START });
    context(b);
    sweepBelow97(b, 2);
    confirmLong(b);
    const t = b.engine.snapshot().trade!;
    b.bar(101.4, 101.5, t.stop - 0.1, 97);
    expect(b.engine.snapshot().trades.at(-1)!.resultR).toBeCloseTo(-1, 10);
  });

  it('OPTIONAL daily loss limit blocks the next entry that day', () => {
    const f = new Feed(v11({ dailyLossLimitR: 1 }), { start: START });
    context(f);
    sweepBelow97(f, 2);
    confirmLong(f);
    const t = f.engine.snapshot().trade!;
    f.bar(101.4, 101.5, t.stop - 0.1, 97); // −1R
    f.flat(12, 100, 0.5);
    // second identical structure on the same UTC day
    f.bar(100, 100.5, 99, 99.2);
    f.bar(99.2, 99.4, 97, 97.5);
    f.bar(97.5, 98.5, 97.4, 98.3);
    f.bar(98.3, 99.5, 98.2, 99.3);
    f.bar(99.3, 101, 99.2, 100.8);
    f.bar(100.8, 100.9, 99.8, 100);
    f.bar(100, 100.2, 99.0, 99.2);
    f.bar(99.2, 99.3, 98.5, 98.6);
    sweepBelow97(f, 2);
    confirmLong(f);
    const s = f.engine.snapshot().lastSignal!;
    expect(s.reasons.join()).toMatch(/Daily loss limit reached/);
  });
});
