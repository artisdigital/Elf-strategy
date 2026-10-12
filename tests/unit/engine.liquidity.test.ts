import { describe, expect, it } from 'vitest';
import { Feed, buildBullishContext, sweepBelow97, testConfig } from './helpers.js';

describe('Liquidity & sweep detection', () => {
  it('detects a valid sweep below a known low (bullish reversal candidate)', () => {
    const f = new Feed();
    buildBullishContext(f);
    const { events } = sweepBelow97(f, 2);
    const sweep = events.find((e) => e.type === 'sweep_preliminary');
    expect(sweep).toBeTruthy();
    expect(sweep!.direction).toBe('long');
    expect(sweep!.data!.level).toBe(97);
    expect(sweep!.data!.reclaimed).toBe(true);
    expect(f.engine.snapshot().state).toBe('SWEPT');
  });

  it('detects a valid sweep above a known high (bearish, mirrored)', () => {
    const f = new Feed(testConfig(), { mirror: true });
    buildBullishContext(f);
    const { events } = sweepBelow97(f, 2);
    const sweep = events.find((e) => e.type === 'sweep_preliminary');
    expect(sweep).toBeTruthy();
    expect(sweep!.direction).toBe('short');
    expect(sweep!.data!.level).toBeCloseTo(103, 9);
  });

  it('does not treat a simple touch of the level as a sweep', () => {
    const f = new Feed();
    buildBullishContext(f);
    f.bar(98.6, 98.7, 97, 97.3); // low exactly at the level
    expect(f.of('sweep_preliminary')).toHaveLength(0);
    const lvl = f.engine.snapshot().levels.find((l) => l.price === 97);
    expect(lvl?.status).toBe('untested');
  });

  it('rejects penetration just below the threshold', () => {
    const f = new Feed();
    buildBullishContext(f);
    sweepBelow97(f, 0.999);
    expect(f.of('sweep_preliminary')).toHaveLength(0);
    expect(f.engine.snapshot().state).toBe('BUILD');
  });

  it('accepts penetration exactly at the threshold', () => {
    const f = new Feed();
    buildBullishContext(f);
    const { pen } = sweepBelow97(f, 1);
    const sweep = f.of('sweep_preliminary')[0];
    expect(sweep).toBeTruthy();
    expect(sweep.data!.penetration as number).toBeCloseTo(pen, 9);
    expect(Math.abs((sweep.data!.penetration as number) - (sweep.data!.threshold as number))).toBeLessThan(1e-9);
  });

  it('groups multiple nearby levels into one sweep anchored at the furthest level', () => {
    const f = new Feed();
    f.flat(5);
    f.bar(100, 120, 99.5, 100);
    f.flat(84);
    // swing low 96.8, then a higher low at 97.0, then swing high 101
    f.bar(100, 100.5, 99, 99.2);
    f.bar(99.2, 99.4, 96.8, 97.4);
    f.bar(97.4, 98.6, 97.3, 98.4);
    f.bar(98.4, 99.2, 98.2, 99.0);
    f.bar(99.0, 99.1, 97.0, 97.6);
    f.bar(97.6, 98.6, 97.5, 98.4);
    f.bar(98.4, 101, 98.3, 100.8);
    f.bar(100.8, 100.9, 99.8, 100);
    f.bar(100, 100.2, 99.0, 99.2);
    const lows = f.engine.snapshot().levels.filter((l) => l.side === 'low' && l.status === 'untested').map((l) => l.price).sort();
    expect(lows).toEqual([96.8, 97]);
    sweepBelow97(f, 3, 97.4, 99.1, 96.8);
    const sweeps = f.of('sweep_preliminary');
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0].data!.level).toBe(96.8);
    expect(String(sweeps[0].data!.levels)).toContain('+');
    const snap = f.engine.snapshot();
    expect(snap.levels.filter((l) => l.side === 'low' && l.status === 'swept').map((l) => l.price).sort()).toEqual([96.8, 97]);
  });

  it('prevents duplicate sweep events for the same level', () => {
    const f = new Feed();
    buildBullishContext(f);
    // breach without close back, extend, then close back → only one preliminary event
    const atr = f.atr();
    f.bar(98.6, 98.7, 97 - atr * 0.2, 96.95);
    f.bar(96.95, 97.0, 97 - atr * 0.4, 96.9);
    f.bar(96.9, 97.5, 96.8, 97.4);
    f.bar(97.4, 97.5, 96.9, 97.2);
    expect(f.of('sweep_preliminary')).toHaveLength(1);
    expect(f.of('sweep_reclaimed')).toHaveLength(1);
    const keys = f.events.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('tracks a breach that has not closed back as preliminary (awaiting reclaim)', () => {
    const f = new Feed();
    buildBullishContext(f);
    const atr = f.atr();
    f.bar(98.6, 98.7, 97 - atr * 0.3, 96.9);
    const sw = f.of('sweep_preliminary')[0];
    expect(sw.data!.reclaimed).toBe(false);
    expect(f.engine.snapshot().stateReason).toMatch(/reclaim close/);
    f.bar(96.9, 97.6, 96.85, 97.5);
    expect(f.of('sweep_reclaimed')).toHaveLength(1);
  });

  it('marks a level broken when the breach never closes back inside the window', () => {
    const f = new Feed(testConfig({ maxConfirmBars: 3 }));
    buildBullishContext(f);
    const atr = f.atr();
    f.bar(98.6, 98.7, 97 - atr * 0.3, 96.5);
    f.bar(96.5, 96.6, 96.0, 96.2);
    f.bar(96.2, 96.3, 95.8, 96.0);
    f.bar(96.0, 96.1, 95.5, 95.7);
    expect(f.of('expired')).toHaveLength(1);
    const lvl = f.engine.snapshot().levels.find((l) => l.price === 97);
    expect(lvl?.status).toBe('broken');
  });

  it('requireSameCandleReclaim (OPTIONAL) breaks a level that closes beyond', () => {
    const f = new Feed(testConfig({ requireSameCandleReclaim: true }));
    buildBullishContext(f);
    const atr = f.atr();
    f.bar(98.6, 98.7, 97 - atr * 0.3, 96.9);
    expect(f.of('sweep_preliminary')).toHaveLength(0);
    expect(f.engine.snapshot().levels.find((l) => l.price === 97)?.status).toBe('broken');
  });

  it('forms EQL from two swing lows within tolerance', () => {
    const f = new Feed(testConfig({ includeEqualLevels: true, equalLevelAtrTol: 0.1 }));
    f.flat(30);
    f.bar(100, 100.5, 99, 99.2);
    f.bar(99.2, 99.4, 97, 97.5);
    f.bar(97.5, 98.5, 97.4, 98.3);
    f.bar(98.3, 99.5, 98.2, 99.3);
    f.bar(99.3, 99.6, 98.4, 98.6);
    f.bar(98.6, 98.7, 97.02, 97.6);
    f.bar(97.6, 98.5, 97.5, 98.3);
    f.bar(98.3, 99.5, 98.2, 99.3);
    const lv = f.engine.snapshot().levels;
    const eql = lv.find((l) => l.kind === 'EQL');
    expect(eql).toBeTruthy();
    expect(eql!.price).toBe(97);
    expect(lv.find((l) => l.kind === 'SWING_LOW' && l.price === 97)?.status).toBe('merged');
  });
});
