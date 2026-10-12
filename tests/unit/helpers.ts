// SYNTHETIC candle builders for deterministic unit tests only. Never used with live data.
import { ElfEngine, type EngineEvent, type EngineEventType } from '../../src/engine/engine.js';
import { defaultConfig, type ElfConfig } from '../../src/engine/config.js';
import type { Candle } from '../../src/shared/types.js';

/** Monday 2025-03-03 00:00 UTC */
export const T0 = Date.UTC(2025, 2, 3, 0, 0) / 1000;
export const M15 = 900;

/** A config with gating disabled so individual rules can be isolated. */
export function testConfig(overrides: Partial<ElfConfig> = {}): ElfConfig {
  return {
    ...defaultConfig(),
    sessionGate: 'off',
    htfBiasEnabled: false,
    includePrevDayLevels: false,
    includeSessionLevels: false,
    includeEqualLevels: false,
    swingLength: 2,
    ...overrides,
  };
}

export class Feed {
  engine: ElfEngine;
  candles: Candle[] = [];
  events: EngineEvent[] = [];
  t: number;
  mirror: boolean;

  constructor(config: ElfConfig = testConfig(), opts: { start?: number; mirror?: boolean; htf?: Candle[] } = {}) {
    this.engine = new ElfEngine(config, { symbol: 'TEST', timeframe: '15m', htfCandles: opts.htf, applyNewsBlackout: true });
    this.t = opts.start ?? T0;
    this.mirror = !!opts.mirror;
  }

  /** Add a closed candle. With `mirror`, prices are reflected around 100 (bullish ↔ bearish). */
  bar(o: number, h: number, l: number, c: number): EngineEvent[] {
    const candle: Candle = this.mirror
      ? { time: this.t, open: 200 - o, high: 200 - l, low: 200 - h, close: 200 - c, volume: 1 }
      : { time: this.t, open: o, high: h, low: l, close: c, volume: 1 };
    this.t += M15;
    this.candles.push(candle);
    const ev = this.engine.update(candle);
    this.events.push(...ev);
    return ev;
  }

  flat(n: number, p = 100, half = 0.5) {
    for (let k = 0; k < n; k++) this.bar(p, p + half, p - half, p);
  }

  atr(): number {
    return this.engine.snapshot().atr!;
  }

  lastClose(): number {
    const c = this.candles[this.candles.length - 1];
    return this.mirror ? 200 - c.close : c.close;
  }

  of(type: EngineEventType) {
    return this.events.filter((e) => e.type === type);
  }

  /** Price in un-mirrored space for assertions. */
  px(p: number) {
    return this.mirror ? 200 - p : p;
  }
}

/**
 * Next ATR given current ATR, the candle's true range and period (Wilder RMA).
 */
export function nextAtr(atr: number, tr: number, period = 14) {
  return (atr * (period - 1) + tr) / period;
}

/**
 * Builds the standard bullish context (un-mirrored coordinates):
 *   * warm-up with a spike swing high at `targetHigh` (later TP2 liquidity)
 *   * a confirmed swing low at 97 (the liquidity to sweep)
 *   * a confirmed swing high at 101 (the BOS reference)
 */
export function buildBullishContext(f: Feed, targetHigh: number | null = 120) {
  f.flat(5);
  if (targetHigh !== null) f.bar(100, targetHigh, 99.5, 100);
  else f.flat(1);
  f.flat(84);
  f.bar(100, 100.5, 99, 99.2);
  f.bar(99.2, 99.4, 97, 97.5); // swing low 97
  f.bar(97.5, 98.5, 97.4, 98.3);
  f.bar(98.3, 99.5, 98.2, 99.3); // ← swing low confirmed here
  f.bar(99.3, 101, 99.2, 100.8); // swing high 101
  f.bar(100.8, 100.9, 99.8, 100);
  f.bar(100, 100.2, 99.0, 99.2); // ← swing high confirmed here
  f.bar(99.2, 99.3, 98.5, 98.6);
}

/**
 * Sweep candle below 97 with penetration = mult × (ATR including this candle).
 * Solves the ATR fixed point exactly: the candle's TR is high − low.
 */
export function sweepBelow97(f: Feed, mult: number, close = 97.3, high = 98.7, level = 97) {
  const atrPrev = f.atr();
  const prevClose = f.lastClose();
  const k = (f.engine.config.sweepAtrMult * mult) / 14;
  // pen = k * (13*atrPrev + (high - level + pen))  →  pen = k*(13*atrPrev + high - level) / (1 - k)
  const hh = Math.max(high, prevClose);
  const pen = (k * (13 * atrPrev + hh - level)) / (1 - k);
  return { events: f.bar(prevClose, high, level - pen, close), pen };
}

/** Full bullish ELF sequence: context → sweep → displacement → BOS. */
export function runBullishSetup(f: Feed, targetHigh: number | null = 120) {
  buildBullishContext(f, targetHigh);
  sweepBelow97(f, 2);
  f.bar(97.3, 99.6, 97.2, 99.4); // bullish displacement
  return f.bar(99.4, 101.6, 99.3, 101.4); // close above 101 → BOS (+ displacement) → confirmation
}
