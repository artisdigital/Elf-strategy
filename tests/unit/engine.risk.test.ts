import { describe, expect, it } from 'vitest';
import { computePlanLevels } from '../../src/engine/engine.js';
import { Feed, runBullishSetup, testConfig } from './helpers.js';

describe('Risk, stop and targets', () => {
  it('valid 1:3 setup: stop = extreme − 0.10×ATR, TP1 = 1R, TP2 = nearest opposing liquidity', () => {
    const f = new Feed();
    runBullishSetup(f, 120);
    const s = f.engine.snapshot().lastSignal!;
    const p = s.plan;
    expect(s.status).toBe('ENTRY_READY');
    expect(p.entry).toBe(101.4);
    expect(p.stop).toBeCloseTo(s.sweep.extreme - 0.1 * p.atr, 10);
    expect(p.riskPerUnit).toBeCloseTo(p.entry - p.stop, 10);
    expect(p.tp1).toBeCloseTo(p.entry + p.riskPerUnit, 10);
    expect(p.tp2).toBe(120);
    expect(p.rr).toBeCloseTo((120 - p.entry) / (p.entry - p.stop), 10);
    expect(p.rr!).toBeGreaterThanOrEqual(3);
  });

  it('short plan mirrors the long calculation', () => {
    const f = new Feed(testConfig(), { mirror: true });
    runBullishSetup(f, 120);
    const s = f.engine.snapshot().lastSignal!;
    const p = s.plan;
    expect(s.status).toBe('ENTRY_READY');
    expect(s.direction).toBe('short');
    expect(p.entry).toBeCloseTo(98.6, 10);
    expect(p.stop).toBeCloseTo(s.sweep.extreme + 0.1 * p.atr, 10);
    expect(p.tp1).toBeCloseTo(p.entry - p.riskPerUnit, 10);
    expect(p.tp2).toBeCloseTo(80, 10);
    expect(p.rr).toBeCloseTo((p.entry - 80) / (p.stop - p.entry), 10);
  });

  it('rejects a setup below the configured R:R floor', () => {
    const f = new Feed(testConfig({ minRR: 3 }));
    runBullishSetup(f, 112);
    const s = f.engine.snapshot().lastSignal!;
    expect(s.plan.rr!).toBeGreaterThan(2);
    expect(s.plan.rr!).toBeLessThan(3);
    expect(s.status).toBe('FILTERED');
    expect(s.reasons.join()).toMatch(/Risk\/reward .* below minimum 3\.0/);
    expect(f.of('filtered')).toHaveLength(1);
    expect(f.engine.snapshot().trade).toBeNull();
  });

  it('accepts the same 1:2.x setup when the minimum is lowered to 1:2', () => {
    const f = new Feed(testConfig({ minRR: 2 }));
    runBullishSetup(f, 112);
    const s = f.engine.snapshot().lastSignal!;
    expect(s.status).toBe('ENTRY_READY');
    expect(s.plan.minRR).toBe(2);
  });

  it('rejects when no measurable target exists (never invents one)', () => {
    const f = new Feed();
    runBullishSetup(f, null);
    const s = f.engine.snapshot().lastSignal!;
    expect(s.status).toBe('FILTERED');
    expect(s.plan.tp2).toBeNull();
    expect(s.plan.rr).toBeNull();
    expect(s.reasons).toContain('No measurable target');
  });

  it('rejects zero risk (pure plan function)', () => {
    const p = computePlanLevels({ direction: 'long', entry: 100, extreme: 100, atr: 1, slAtrBuffer: 0, tp1R: 1, targets: [{ price: 110, label: 'X' }] });
    expect(p.risk).toBe(0);
    expect(p.rr).toBeNull();
  });

  it('pure plan: short target must be below entry; nearest wins', () => {
    const p = computePlanLevels({
      direction: 'short', entry: 100, extreme: 102, atr: 2, slAtrBuffer: 0.1, tp1R: 1,
      targets: [ { price: 90, label: 'far' }, { price: 94, label: 'near' }, { price: 105, label: 'wrong side' } ],
    });
    expect(p.stop).toBeCloseTo(102.2, 10);
    expect(p.risk).toBeCloseTo(2.2, 10);
    expect(p.tp1).toBeCloseTo(97.8, 10);
    expect(p.target!.label).toBe('near');
    expect(p.rr).toBeCloseTo(6 / 2.2, 10);
  });

  it('filters against HTF bias and explains it', () => {
    const htf = Array.from({ length: 80 }, (_, k) => ({ time: Date.UTC(2024, 11, 1) / 1000 + k * 86400, open: 200 - k, high: 201 - k, low: 199 - k, close: 200 - k, volume: 1 }));
    const f = new Feed(testConfig({ htfBiasEnabled: true, htfEmaLength: 10 }), { htf });
    runBullishSetup(f, 120);
    const s = f.engine.snapshot().lastSignal!;
    expect(s.bias.value).toBe('bearish');
    expect(s.status).toBe('FILTERED');
    expect(s.reasons).toContain('Against higher-timeframe bias');
  });

  it('filters when HTF bias is unavailable rather than guessing', () => {
    const f = new Feed(testConfig({ htfBiasEnabled: true }));
    runBullishSetup(f, 120);
    const s = f.engine.snapshot().lastSignal!;
    expect(s.status).toBe('FILTERED');
    expect(s.reasons).toContain('Higher-timeframe bias unavailable');
  });

  it('news blackout blocks new entries with a reason', () => {
    const f = new Feed(testConfig({ newsBlackout: true }));
    runBullishSetup(f, 120);
    const s = f.engine.snapshot().lastSignal!;
    expect(s.status).toBe('FILTERED');
    expect(s.reasons).toContain('News blackout active');
  });
});

describe('Trade outcome tracking', () => {
  it('reaches TP1 then TP2', () => {
    const f = new Feed();
    runBullishSetup(f, 120);
    const t0 = f.engine.snapshot().trade!;
    f.bar(101.4, t0.tp1 + 0.1, 101.3, t0.tp1);
    expect(f.of('tp1')).toHaveLength(1);
    expect(f.engine.snapshot().state).toBe('MANAGING');
    f.bar(t0.tp1, 120.2, t0.tp1 - 0.2, 120);
    expect(f.of('tp2')).toHaveLength(1);
    const snap = f.engine.snapshot();
    expect(snap.state).toBe('COMPLETED');
    const t = snap.trades[snap.trades.length - 1];
    expect(t.outcome).toBe('tp2');
    expect(t.resultR).toBeCloseTo(snap.lastSignal!.plan.rr!, 10);
  });

  it('stop-loss gives −1R', () => {
    const f = new Feed();
    runBullishSetup(f, 120);
    const t0 = f.engine.snapshot().trade!;
    f.bar(101.4, 101.5, t0.stop - 0.01, 97);
    const t = f.engine.snapshot().trades.at(-1)!;
    expect(t.outcome).toBe('sl');
    expect(t.resultR).toBeCloseTo(-1, 10);
  });

  it('ambiguous candle touching stop and target → conservative stop-first, flagged', () => {
    const f = new Feed();
    runBullishSetup(f, 120);
    const t0 = f.engine.snapshot().trade!;
    f.bar(101.4, 121, t0.stop - 1, 110);
    const t = f.engine.snapshot().trades.at(-1)!;
    expect(t.outcome).toBe('sl');
    expect(t.ambiguous).toBe(true);
    expect(f.of('sl')[0].data!.ambiguous).toBe(true);
  });

  it('gap through the stop fills at the open (worse than the stop)', () => {
    const f = new Feed();
    runBullishSetup(f, 120);
    const t0 = f.engine.snapshot().trade!;
    f.bar(t0.stop - 2, t0.stop - 1.5, t0.stop - 3, t0.stop - 2.5);
    const t = f.engine.snapshot().trades.at(-1)!;
    expect(t.exitPrice).toBe(t0.stop - 2);
    expect(t.resultR!).toBeLessThan(-1);
  });

  it('keeps managing an active trade outside session windows', () => {
    // Session gate on, but management is never gated.
    const f = new Feed(testConfig({ sessionGate: 'off' }));
    runBullishSetup(f, 120);
    expect(f.engine.snapshot().state).toBe('ENTRY_READY');
    f.bar(101.4, 102, 101, 101.8);
    expect(f.engine.snapshot().state).toBe('MANAGING');
  });

  it('manual close records a manual outcome', () => {
    const f = new Feed();
    runBullishSetup(f, 120);
    const t = f.engine.closeActiveTrade(103, 'manual')!;
    expect(t.outcome).toBe('manual');
    expect(t.resultR!).toBeCloseTo((103 - t.entry) / t.risk, 10);
    expect(f.engine.snapshot().state).toBe('COMPLETED');
  });
});
