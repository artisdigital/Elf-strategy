import { describe, expect, it } from 'vitest';
import { planTrade } from '../../src/engine/planner.js';

describe('Trade planner', () => {
  it('sizes a crypto position by % risk and rounds down to the quantity step', () => {
    const r = planTrade({ balance: 10000, riskMode: 'percent', riskValue: 1, entry: 60000, stop: 59400, target: 61800, maxRiskPct: 2, spec: { kind: 'units', stepSize: 0.0001, quoteToAccountRate: 1 } });
    expect(r.direction).toBe('long');
    expect(r.riskAmount).toBe(100);
    expect(r.stopDistance).toBe(600);
    expect(r.rr).toBe(3);
    expect(r.positionSize).toBe(0.1666);
    expect(r.actualRiskAfterRounding!).toBeLessThanOrEqual(100);
  });

  it('sizes forex in units/lots with pip distance and conversion', () => {
    const r = planTrade({ balance: 5000, riskMode: 'cash', riskValue: 50, entry: 1.1, stop: 1.095, target: null, maxRiskPct: 2, spec: { kind: 'forex', stepSize: 1, pipSize: 0.0001, lotSize: 100000, quoteToAccountRate: 1 } });
    expect(r.stopPips).toBeCloseTo(50, 6);
    expect(r.positionSize).toBe(10000);
    expect(r.lots).toBeCloseTo(0.1, 10);
  });

  it('does not invent a size when specs are missing', () => {
    const r = planTrade({ balance: 10000, riskMode: 'percent', riskValue: 1, entry: 100, stop: 99, maxRiskPct: 2, spec: { kind: 'contract', quoteToAccountRate: 1 } });
    expect(r.positionSize).toBeNull();
    expect(r.missing.join()).toMatch(/Contract multiplier/);
    const r2 = planTrade({ balance: 10000, riskMode: 'percent', riskValue: 1, entry: 100, stop: 99, maxRiskPct: 2, spec: null });
    expect(r2.positionSize).toBeNull();
    expect(r2.missing).toHaveLength(1);
  });

  it('warns above the maximum risk and rejects zero risk / wrong-side targets', () => {
    expect(planTrade({ balance: 1000, riskMode: 'percent', riskValue: 5, entry: 10, stop: 9, maxRiskPct: 2, spec: null }).warnings[0]).toMatch(/exceeds/);
    expect(planTrade({ balance: 1000, riskMode: 'percent', riskValue: 1, entry: 10, stop: 10, maxRiskPct: 2, spec: null }).errors[0]).toMatch(/zero/);
    expect(planTrade({ balance: 1000, riskMode: 'percent', riskValue: 1, entry: 10, stop: 11, target: 12, maxRiskPct: 2, spec: null }).errors[0]).toMatch(/wrong side/);
  });
});

describe('Pip value (Master Lot Size chart: 1 lot ≈ $10 / pip on USD-quoted pairs)', () => {
  it('reports $10 per pip per standard lot for EUR/USD', () => {
    const r = planTrade({ balance: 10000, riskMode: 'percent', riskValue: 0.5, entry: 1.1, stop: 1.0975, maxRiskPct: 0.75, spec: { kind: 'forex', stepSize: 1, pipSize: 0.0001, lotSize: 100000, quoteToAccountRate: 1 } });
    expect(r.pipValuePerLot).toBeCloseTo(10, 10);
    expect(r.stopPips).toBeCloseTo(25, 6);
    expect(r.lots).toBeCloseTo(0.2, 10); // $50 risk / (25 pips × $10)
  });
});
