// Session and trading-day tracking in America/New_York.
//
// A candle belongs to a session when its OPEN time falls in [start, end) local time.
// Sessions whose end is earlier than their start wrap midnight (e.g. Sydney 17:00–02:00);
// the instance is keyed by the local date on which it STARTED.

import type { Candle } from '../shared/types.js';
import { NY_TZ, parseHHMM, shiftDateKey, zonedParts } from '../shared/time.js';
import type { ElfConfig, SessionName } from './config.js';

export const SESSION_LABELS: Record<SessionName, string> = { london: 'London', newYork: 'New York', asia: 'Sydney' };
export const SESSION_ORDER: SessionName[] = ['asia', 'london', 'newYork'];

export interface SessionWindow {
  name: SessionName;
  start: number; // minute of day
  end: number;
  wraps: boolean;
}

export function sessionWindows(config: ElfConfig): SessionWindow[] {
  return SESSION_ORDER.filter((n) => config.sessions[n].enabled).map((name) => {
    const start = parseHHMM(config.sessions[name].start);
    const end = parseHHMM(config.sessions[name].end);
    return { name, start, end, wraps: end <= start };
  });
}

/** Returns the instance key ("london:2025-03-10") if the timestamp is inside the window. */
export function sessionInstanceAt(w: SessionWindow, utcSeconds: number): string | null {
  const p = zonedParts(utcSeconds, NY_TZ);
  const m = p.minuteOfDay;
  if (!w.wraps) return m >= w.start && m < w.end ? `${w.name}:${p.dateKey}` : null;
  if (m >= w.start) return `${w.name}:${p.dateKey}`;
  if (m < w.end) return `${w.name}:${shiftDateKey(p.dateKey, -1)}`;
  return null;
}

/** Names of enabled sessions containing this timestamp. */
export function activeSessions(windows: SessionWindow[], utcSeconds: number): SessionName[] {
  return windows.filter((w) => sessionInstanceAt(w, utcSeconds) !== null).map((w) => w.name);
}

/** Trading-day key for PDH/PDL according to the configured boundary. */
export type DayBoundary = Exclude<ElfConfig['dayBoundary'], 'auto'>;

/** The daily candle each provider prints (what Pine's request.security("D") sees on that feed). */
export function providerDayBoundary(provider: string | undefined): DayBoundary {
  if (provider === 'binanceus') return 'utc-midnight';
  if (provider === 'oanda') return 'ny-1700';
  return 'ny-midnight';
}

export function tradingDayKey(utcSeconds: number, boundary: ElfConfig['dayBoundary']): string {
  if (boundary === 'auto') boundary = 'ny-midnight';
  if (boundary === 'utc-midnight') return new Date(utcSeconds * 1000).toISOString().slice(0, 10);
  const p = zonedParts(utcSeconds, NY_TZ);
  if (boundary === 'ny-1700') return p.minuteOfDay >= 17 * 60 ? shiftDateKey(p.dateKey, 1) : p.dateKey;
  return p.dateKey;
}

export interface RangeBox {
  key: string;
  name: SessionName | 'day';
  label: string;
  startTime: number;
  endTime: number; // open time of the last candle in the range
  high: number;
  low: number;
  highTime: number;
  lowTime: number;
  complete: boolean;
}

export interface SessionUpdate {
  completed: RangeBox[]; // ranges that completed BEFORE this candle (finalized on this candle)
  inSession: SessionName[];
  dayCompleted: RangeBox | null;
}

/** Tracks developing / completed session ranges and trading days, one closed candle at a time. */
export class SessionTracker {
  private readonly windows: SessionWindow[];
  developing = new Map<SessionName, RangeBox>();
  day: RangeBox | null = null;

  private readonly boundary: ElfConfig['dayBoundary'];
  constructor(private readonly config: ElfConfig, dayBoundary?: DayBoundary) {
    this.windows = sessionWindows(config);
    this.boundary = config.dayBoundary === 'auto' ? dayBoundary ?? 'ny-midnight' : config.dayBoundary;
  }

  update(c: Candle): SessionUpdate {
    const completed: RangeBox[] = [];
    const inSession: SessionName[] = [];
    for (const w of this.windows) {
      const key = sessionInstanceAt(w, c.time);
      const cur = this.developing.get(w.name);
      if (cur && cur.key !== key) {
        cur.complete = true;
        completed.push(cur);
        this.developing.delete(w.name);
      }
      if (key) {
        inSession.push(w.name);
        const box = this.developing.get(w.name);
        if (!box) {
          this.developing.set(w.name, newBox(key, w.name, SESSION_LABELS[w.name], c));
        } else extendBox(box, c);
      }
    }

    let dayCompleted: RangeBox | null = null;
    const dayKey = 'day:' + tradingDayKey(c.time, this.boundary);
    if (this.day && this.day.key !== dayKey) {
      this.day.complete = true;
      dayCompleted = this.day;
      this.day = null;
    }
    if (!this.day) this.day = newBox(dayKey, 'day', 'Day', c);
    else extendBox(this.day, c);

    return { completed, inSession, dayCompleted };
  }

  isInSession(utcSeconds: number): boolean {
    return activeSessions(this.windows, utcSeconds).length > 0;
  }
}

function newBox(key: string, name: SessionName | 'day', label: string, c: Candle): RangeBox {
  return { key, name, label, startTime: c.time, endTime: c.time, high: c.high, low: c.low, highTime: c.time, lowTime: c.time, complete: false };
}

function extendBox(b: RangeBox, c: Candle) {
  b.endTime = c.time;
  if (c.high > b.high) {
    b.high = c.high;
    b.highTime = c.time;
  }
  if (c.low < b.low) {
    b.low = c.low;
    b.lowTime = c.time;
  }
}
