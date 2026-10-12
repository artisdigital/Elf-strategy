// Theoretical trade outcome tracking on candle data.
//
// Fills are THEORETICAL. Entry is assumed at the signal candle close. On every later candle:
//   * a gap through the stop fills the stop at the candle OPEN (worse than the stop);
//   * targets fill at the target price (limit-order assumption);
//   * if one candle touches both the stop and a target and the intrabar order is unknown,
//     we resolve with lower-timeframe candles when supplied, otherwise we CONSERVATIVELY
//     assume the stop was hit first and flag the outcome as `ambiguous`.

import type { Candle } from '../shared/types.js';

export type Direction = 'long' | 'short';
export type TradeOutcome = 'tp2' | 'sl' | 'manual' | 'expired' | 'cancelled' | 'breakeven';

export interface TradeLevels {
  direction: Direction;
  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
}

export interface TradeState extends TradeLevels {
  id: string;
  entryTime: number; // open time of the signal candle (entry at its close)
  entryIndex: number;
  initialStop: number;
  risk: number; // per unit, > 0
  tp1Hit: boolean;
  tp1Time: number | null;
  status: 'open' | 'closed';
  outcome: TradeOutcome | null;
  exitPrice: number | null;
  exitTime: number | null;
  resultR: number | null;
  ambiguous: boolean;
  barsHeld: number;
  breakevenAfterTp1: boolean;
}

export interface TradeStepEvent {
  type: 'tp1' | 'tp2' | 'sl' | 'expired' | 'breakeven';
  time: number;
  price: number;
  ambiguous: boolean;
}

export function newTrade(id: string, levels: TradeLevels, entryTime: number, entryIndex: number, breakevenAfterTp1 = false): TradeState {
  const risk = Math.abs(levels.entry - levels.stop);
  return {
    ...levels,
    id,
    entryTime,
    entryIndex,
    initialStop: levels.stop,
    risk,
    tp1Hit: false,
    tp1Time: null,
    status: 'open',
    outcome: null,
    exitPrice: null,
    exitTime: null,
    resultR: null,
    ambiguous: false,
    barsHeld: 0,
    breakevenAfterTp1,
  };
}

export function rMultiple(t: TradeLevels & { risk: number }, exit: number): number {
  const dir = t.direction === 'long' ? 1 : -1;
  return ((exit - t.entry) * dir) / t.risk;
}

function close(t: TradeState, outcome: TradeOutcome, price: number, time: number) {
  t.status = 'closed';
  t.outcome = outcome;
  t.exitPrice = price;
  t.exitTime = time;
  t.resultR = rMultiple(t, price);
}

/**
 * Advance an open trade by one CLOSED candle. Mutates `t`; returns the events produced.
 * `intrabar` — optional lower-timeframe candles covering exactly this candle.
 */
export function stepTrade(t: TradeState, c: Candle, intrabar?: Candle[], expiryBars = 0): TradeStepEvent[] {
  if (t.status !== 'open') return [];
  t.barsHeld++;
  const events: TradeStepEvent[] = [];
  if (intrabar && intrabar.length > 0) {
    for (const sub of intrabar) {
      events.push(...stepOne(t, sub, c.time, false));
      if (t.status !== 'open') break;
    }
  } else {
    events.push(...stepOne(t, c, c.time, true));
  }
  if (t.status === 'open' && expiryBars > 0 && t.barsHeld >= expiryBars) {
    close(t, 'expired', c.close, c.time);
    events.push({ type: 'expired', time: c.time, price: c.close, ambiguous: false });
  }
  return events;
}

function stepOne(t: TradeState, c: Candle, barTime: number, ambiguityPossible: boolean): TradeStepEvent[] {
  const long = t.direction === 'long';
  const events: TradeStepEvent[] = [];

  // 1) Gap through stop at the open.
  const gapStop = long ? c.open <= t.stop : c.open >= t.stop;
  if (gapStop) {
    const outcome: TradeOutcome = t.tp1Hit && t.stop === t.entry ? 'breakeven' : 'sl';
    close(t, outcome, c.open, barTime);
    events.push({ type: outcome === 'breakeven' ? 'breakeven' : 'sl', time: barTime, price: c.open, ambiguous: false });
    return events;
  }

  const hitStop = long ? c.low <= t.stop : c.high >= t.stop;
  const hitTp1 = !t.tp1Hit && (long ? c.high >= t.tp1 : c.low <= t.tp1);
  const hitTp2 = long ? c.high >= t.tp2 : c.low <= t.tp2;

  if (hitStop && (hitTp1 || hitTp2) && ambiguityPossible) {
    // Unknown intrabar order → conservative: stop first.
    t.ambiguous = true;
    const outcome: TradeOutcome = t.tp1Hit && t.stop === t.entry ? 'breakeven' : 'sl';
    close(t, outcome, t.stop, barTime);
    events.push({ type: outcome === 'breakeven' ? 'breakeven' : 'sl', time: barTime, price: t.stop, ambiguous: true });
    return events;
  }

  if (hitStop) {
    const outcome: TradeOutcome = t.tp1Hit && t.stop === t.entry ? 'breakeven' : 'sl';
    close(t, outcome, t.stop, barTime);
    events.push({ type: outcome === 'breakeven' ? 'breakeven' : 'sl', time: barTime, price: t.stop, ambiguous: false });
    return events;
  }

  if (hitTp1) {
    t.tp1Hit = true;
    t.tp1Time = barTime;
    events.push({ type: 'tp1', time: barTime, price: t.tp1, ambiguous: false });
  }
  if (hitTp2) {
    close(t, 'tp2', t.tp2, barTime);
    events.push({ type: 'tp2', time: barTime, price: t.tp2, ambiguous: false });
    return events;
  }
  // Breakeven move applies from the NEXT candle (we never know it happened before the close).
  if (t.tp1Hit && t.breakevenAfterTp1 && t.stop !== t.entry) t.stop = t.entry;
  return events;
}

export function closeTradeManually(t: TradeState, price: number, time: number, outcome: 'manual' | 'cancelled' = 'manual') {
  if (t.status !== 'open') return;
  close(t, outcome, price, time);
  if (outcome === 'cancelled') t.resultR = 0;
}
