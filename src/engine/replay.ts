// Candle-by-candle historical replay. HISTORICAL SIMULATION — not live data.
//
// The engine only ever receives candles[0 .. cursor-1]. Future candles are never passed to
// it and `visible()` never returns them, so neither the chart nor the calculations can see
// the future. Stepping backwards rebuilds the engine from scratch up to the new cursor.

import type { Candle, Timeframe } from '../shared/types.js';
import { ElfEngine, type EngineEvent, type EngineSnapshot } from './engine.js';
import type { ElfConfig } from './config.js';

export interface ReplayOptions {
  symbol: string;
  timeframe: Timeframe;
  htfCandles?: Candle[];
  /** Number of candles revealed initially (warm-up). */
  startCursor?: number;
}

export class ReplaySession {
  private engine!: ElfEngine;
  private _cursor = 0;
  private log: EngineEvent[] = [];
  private readonly all: readonly Candle[];

  constructor(candles: Candle[], private readonly config: ElfConfig, private readonly opts: ReplayOptions) {
    this.all = Object.freeze([...candles].sort((a, b) => a.time - b.time));
    this.reset(opts.startCursor ?? 0);
  }

  get cursor() {
    return this._cursor;
  }
  get length() {
    return this.all.length;
  }
  get done() {
    return this._cursor >= this.all.length;
  }
  /** Open time of the most recent revealed candle. */
  get currentTime(): number | null {
    return this._cursor > 0 ? this.all[this._cursor - 1].time : null;
  }

  private reset(cursor: number) {
    this.engine = new ElfEngine(this.config, {
      symbol: this.opts.symbol,
      timeframe: this.opts.timeframe,
      htfCandles: this.opts.htfCandles,
      applyNewsBlackout: false,
    });
    this._cursor = 0;
    this.log = [];
    this.advance(Math.max(0, Math.min(cursor, this.all.length)));
  }

  private advance(n: number): EngineEvent[] {
    const out: EngineEvent[] = [];
    for (let k = 0; k < n && this._cursor < this.all.length; k++) {
      const ev = this.engine.update(this.all[this._cursor]);
      this._cursor++;
      out.push(...ev);
    }
    this.log.push(...out);
    return out;
  }

  step(n = 1): EngineEvent[] {
    return this.advance(n);
  }

  /** Jump to an absolute cursor (backwards rebuilds deterministically). */
  seek(cursor: number): void {
    if (cursor >= this._cursor) this.advance(cursor - this._cursor);
    else this.reset(cursor);
  }

  /** Only candles up to the cursor. */
  visible(): Candle[] {
    return this.all.slice(0, this._cursor);
  }

  snapshot(): EngineSnapshot {
    return this.engine.snapshot();
  }

  events(): EngineEvent[] {
    return [...this.log];
  }

  closeTrade(price: number, outcome: 'manual' | 'cancelled' = 'manual') {
    return this.engine.closeActiveTrade(price, outcome);
  }
}
