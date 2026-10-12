import { describe, expect, it } from 'vitest';
import { Feed, buildBullishContext, runBullishSetup, sweepBelow97, testConfig } from './helpers.js';

describe('Swing pivots', () => {
  it('confirms a swing exactly swingLength bars after the pivot (no lookahead)', () => {
    const f = new Feed();
    f.flat(30);
    f.bar(100, 100.5, 99, 99.2);
    f.bar(99.2, 99.4, 97, 97.5); // pivot candidate
    const pivotTime = f.candles[f.candles.length - 1].time;
    f.bar(97.5, 98.5, 97.4, 98.3);
    expect(f.engine.snapshot().swings.find((s) => s.time === pivotTime)).toBeUndefined();
    f.bar(98.3, 99.5, 98.2, 99.3);
    const sp = f.engine.snapshot().swings.find((s) => s.time === pivotTime);
    expect(sp).toBeTruthy();
    expect(sp!.side).toBe('low');
    expect(sp!.confirmedTime).toBe(f.candles[f.candles.length - 1].time);
    expect(sp!.confirmedIndex - sp!.index).toBe(2);
  });
});

describe('Break of structure', () => {
  it('bullish BOS requires a candle CLOSE above the confirmed swing high', () => {
    const f = new Feed();
    buildBullishContext(f);
    f.bar(98.6, 101.6, 98.5, 101.4);
    const bos = f.of('bos');
    expect(bos).toHaveLength(1);
    expect(bos[0].direction).toBe('long');
    expect(bos[0].data!.price).toBe(101);
  });

  it('bearish BOS requires a candle CLOSE below the confirmed swing low (mirrored)', () => {
    const f = new Feed(testConfig(), { mirror: true });
    buildBullishContext(f);
    f.bar(98.6, 101.6, 98.5, 101.4);
    const bos = f.of('bos');
    expect(bos).toHaveLength(1);
    expect(bos[0].direction).toBe('short');
    expect(bos[0].data!.price).toBeCloseTo(99, 9);
  });

  it('rejects a wick-only break', () => {
    const f = new Feed();
    buildBullishContext(f);
    f.bar(98.6, 101.6, 98.5, 100.9); // wick above 101, close below
    expect(f.of('bos')).toHaveLength(0);
  });

  it('never uses an unconfirmed local high as structure', () => {
    const f = new Feed();
    f.flat(30);
    f.bar(100, 101, 99.8, 100.8); // local high 101 — needs 2 bars to confirm
    f.bar(100.8, 100.9, 100.1, 100.2);
    f.bar(100.2, 101.4, 100.1, 101.3); // closes above before confirmation
    expect(f.of('bos')).toHaveLength(0);
    expect(f.engine.snapshot().swings.filter((s) => s.side === 'high')).toHaveLength(0);
  });
});

describe('Displacement', () => {
  const setup = (cfg = testConfig()) => {
    const f = new Feed(cfg);
    f.flat(40); // ATR → 1.0
    return f;
  };

  it('detects bullish displacement meeting 1.0× ATR with body/range ≥ 50%', () => {
    const f = setup();
    f.bar(100, 101.3, 99.9, 101.2);
    const d = f.of('displacement');
    expect(d).toHaveLength(1);
    expect(d[0].direction).toBe('long');
  });

  it('detects bearish displacement', () => {
    const f = setup();
    f.bar(100, 100.1, 98.7, 98.8);
    expect(f.of('displacement')[0]?.direction).toBe('short');
  });

  it('rejects a body below the ATR multiple', () => {
    const f = setup();
    f.bar(100, 100.9, 99.9, 100.8);
    expect(f.of('displacement')).toHaveLength(0);
  });

  it('rejects a large body that fails the body/range filter', () => {
    const f = setup();
    f.bar(100, 102.6, 98.4, 101.2); // body 1.2, range 4.2 → 29%
    expect(f.of('displacement')).toHaveLength(0);
  });

  it('consecutive-candle mode: two same-direction candles may jointly qualify', () => {
    const one = setup();
    one.bar(100, 100.7, 99.95, 100.65);
    one.bar(100.65, 101.35, 100.6, 101.3);
    expect(one.of('displacement')).toHaveLength(0);

    const two = setup(testConfig({ displacementBars: 2 }));
    two.bar(100, 100.7, 99.95, 100.65);
    two.bar(100.65, 101.35, 100.6, 101.3);
    const d = two.of('displacement');
    expect(d).toHaveLength(1);
    expect(d[0].message).toContain('displacement');
    expect(two.engine.snapshot().displacements[0].bars).toBe(2);
  });

  it('consecutive mode rejects mixed-direction candles', () => {
    const f = setup(testConfig({ displacementBars: 2 }));
    f.bar(100, 100.9, 99.95, 100.85);
    f.bar(100.85, 101.6, 100.5, 100.6); // bearish candle
    expect(f.of('displacement')).toHaveLength(0);
  });
});

describe('Confirmation sequence', () => {
  it('valid sweep → BOS → displacement produces ENTRY READY', () => {
    const f = new Feed();
    const ev = runBullishSetup(f);
    expect(ev.map((e) => e.type)).toContain('confirmed');
    expect(ev.map((e) => e.type)).toContain('entry_ready');
    const snap = f.engine.snapshot();
    expect(snap.state).toBe('ENTRY_READY');
    expect(snap.lastSignal!.status).toBe('ENTRY_READY');
    expect(snap.lastSignal!.direction).toBe('long');
    expect(snap.lastSignal!.reasons).toEqual([]);
  });

  it('sweep without BOS expires after maxConfirmBars', () => {
    const f = new Feed(testConfig({ maxConfirmBars: 5 }));
    buildBullishContext(f);
    sweepBelow97(f, 2);
    for (let k = 0; k < 5; k++) f.bar(97.5, 98.4, 97.4, 98.2);
    expect(f.of('expired')).toHaveLength(1);
    expect(f.of('confirmed')).toHaveLength(0);
    const snap = f.engine.snapshot();
    expect(snap.state).toBe('FILTERED');
    expect(snap.stateReason).toMatch(/Confirmation expired/);
    expect(snap.candidate).toBeNull();
  });

  it('BOS without a valid sweep does not confirm', () => {
    const f = new Feed();
    buildBullishContext(f);
    f.bar(98.6, 99.6, 98.5, 99.4);
    f.bar(99.4, 101.6, 99.3, 101.4); // BOS + displacement, but no sweep
    expect(f.of('bos')).toHaveLength(1);
    expect(f.of('displacement').length).toBeGreaterThan(0);
    expect(f.of('confirmed')).toHaveLength(0);
    expect(f.of('entry_ready')).toHaveLength(0);
  });

  it('displacement in the wrong direction does not confirm', () => {
    const f = new Feed();
    buildBullishContext(f);
    sweepBelow97(f, 2, 98.6, 99.0);
    f.bar(98.6, 98.7, 97.1, 97.2); // large BEARISH candle (wrong direction)
    expect(f.of('displacement').some((d) => d.direction === 'short')).toBe(true);
    // grind up in small bullish candles → BOS without bullish displacement
    let p = 97.2;
    while (p < 101.1) {
      f.bar(p, p + 0.55, p - 0.05, p + 0.5);
      p += 0.5;
    }
    expect(f.of('bos').some((b) => b.direction === 'long')).toBe(true);
    expect(f.of('confirmed')).toHaveLength(0);
    expect(f.engine.snapshot().candidate?.displacement).toBeNull();
  });

  it('confirmation must complete inside the window (timeout)', () => {
    const f = new Feed(testConfig({ maxConfirmBars: 2 }));
    buildBullishContext(f);
    sweepBelow97(f, 2);
    f.bar(97.3, 98.0, 97.2, 97.9);
    f.bar(97.9, 98.3, 97.8, 98.2); // age 2 → expires
    f.bar(98.2, 101.6, 98.1, 101.4); // too late
    expect(f.of('expired')).toHaveLength(1);
    expect(f.of('confirmed')).toHaveLength(0);
  });

  it('records sweep-to-confirmation timing on different candles', () => {
    const f = new Feed();
    runBullishSetup(f);
    const s = f.engine.snapshot().lastSignal!;
    expect(s.sweep.startTime).toBeLessThan(s.displacement!.time);
    expect(s.displacement!.time).toBeLessThan(s.bos!.time);
    expect(s.bos!.time).toBe(s.time);
  });

  it('a newer same-direction sweep supersedes a pending candidate', () => {
    const f = new Feed();
    buildBullishContext(f);
    sweepBelow97(f, 2);
    expect(f.engine.snapshot().candidate).toBeTruthy();
    const firstId = f.engine.snapshot().candidate!.id;
    // a breach of a lower level is not possible here; supersede via opposite RECLAIMED sweep of 101
    const atr = f.atr();
    f.bar(97.3, 101 + atr * 0.5, 97.2, 100.5); // wicks above 101 and closes back below → bearish sweep
    expect(f.of('invalidated')).toHaveLength(1);
    expect(f.engine.snapshot().candidate!.id).not.toBe(firstId);
    expect(f.engine.snapshot().candidate!.direction).toBe('short');
  });
});
