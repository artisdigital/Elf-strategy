// Incremental indicators. Each `update` consumes one CLOSED candle / value.

import type { Candle } from '../shared/types.js';

/**
 * Wilder ATR (matches Pine `ta.atr`): TR seeded with an SMA of the first `period`
 * true ranges, then RMA smoothing. `value` is null until `period` bars are seen.
 */
export class Atr {
  private prevClose: number | null = null;
  private count = 0;
  private sum = 0;
  value: number | null = null;
  constructor(readonly period: number) {}

  update(c: Candle): number | null {
    const tr =
      this.prevClose === null
        ? c.high - c.low
        : Math.max(c.high - c.low, Math.abs(c.high - this.prevClose), Math.abs(c.low - this.prevClose));
    this.prevClose = c.close;
    this.count++;
    if (this.value === null) {
      this.sum += tr;
      if (this.count === this.period) this.value = this.sum / this.period;
    } else {
      this.value = (this.value * (this.period - 1) + tr) / this.period;
    }
    return this.value;
  }
}

/** EMA seeded with the SMA of the first `period` values; null until then. */
export class Ema {
  private count = 0;
  private sum = 0;
  value: number | null = null;
  private readonly alpha: number;
  constructor(readonly period: number) {
    this.alpha = 2 / (period + 1);
  }
  update(v: number): number | null {
    this.count++;
    if (this.value === null) {
      this.sum += v;
      if (this.count === this.period) this.value = this.sum / this.period;
    } else {
      this.value = this.alpha * v + (1 - this.alpha) * this.value;
    }
    return this.value;
  }
}

/** Batch helper: ATR series aligned with candles (null during warm-up). */
export function atrSeries(candles: Candle[], period: number): (number | null)[] {
  const a = new Atr(period);
  return candles.map((c) => a.update(c));
}

export function emaSeries(values: number[], period: number): (number | null)[] {
  const e = new Ema(period);
  return values.map((v) => e.update(v));
}
