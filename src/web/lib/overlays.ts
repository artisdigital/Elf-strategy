// Pure conversion of an engine snapshot into chart drawing primitives.
// All coordinates are real candle timestamps and prices taken from the engine output.

import type { EngineSnapshot, Signal } from '../../engine/engine.js';
import type { Candle } from '../../shared/types.js';

export interface Visibility {
  sessions: boolean;
  levels: boolean;
  swings: boolean;
  sweeps: boolean;
  bos: boolean;
  displacement: boolean;
  fvg: boolean;
  orderBlocks: boolean;
  plan: boolean;
  outcomes: boolean;
  volume: boolean;
}

export interface Colors {
  up: string;
  down: string;
  accent: string;
  liquidityHigh: string;
  liquidityLow: string;
  sweep: string;
  bos: string;
  fvgBull: string;
  fvgBear: string;
  obBull: string;
  obBear: string;
  entry: string;
  stop: string;
  target: string;
  session: string;
}

export interface Box {
  t1: number;
  t2: number;
  p1: number;
  p2: number;
  fill: string;
  stroke?: string;
  dashed?: boolean;
  label?: string;
  labelColor?: string;
  midLine?: boolean;
}

export interface Segment {
  t1: number;
  t2: number;
  price: number;
  color: string;
  width?: number;
  dashed?: boolean;
  label?: string;
  labelSide?: 'left' | 'right';
  extendRight?: boolean;
}

export interface Marker {
  time: number;
  position: 'aboveBar' | 'belowBar' | 'inBar';
  shape: 'arrowUp' | 'arrowDown' | 'circle' | 'square';
  color: string;
  text?: string;
}

export interface Overlays {
  boxes: Box[];
  segments: Segment[];
  markers: Marker[];
}

const fmt = (n: number) => {
  const a = Math.abs(n);
  return n.toFixed(a >= 1000 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : 5);
};

/** The plan to draw: the active trade, else the most recent signal if it is the latest event. */
export function planToDraw(s: EngineSnapshot): Signal | null {
  if (s.trade) return s.signals.find((x) => x.id === s.trade!.id) ?? null;
  const last = s.lastSignal;
  if (last && s.lastTime !== null && last.time === s.lastTime) return last;
  return null;
}

export function buildOverlays(s: EngineSnapshot | null, candles: Candle[], vis: Visibility, col: Colors, opts: { maxLevelsEachSide?: number; maxFvgs?: number; compact?: boolean } = {}): Overlays {
  const out: Overlays = { boxes: [], segments: [], markers: [] };
  if (!s || !candles.length) return out;
  const first = candles[0].time;
  const last = candles[candles.length - 1].time;
  const within = (t: number) => t >= first && t <= last;
  const clampT = (t: number) => Math.min(Math.max(t, first), last);
  const compact = !!opts.compact;
  const maxEach = opts.maxLevelsEachSide ?? (compact ? 2 : 3);
  const short = (label: string) => label.split(' / ')[0];

  if (vis.sessions) {
    const boxes = [...s.sessions.completed, ...s.sessions.developing].filter((b) => b.endTime >= first);
    const labelled = new Set(boxes.slice(-3).map((b) => b.key));
    for (const b of boxes) {
      out.boxes.push({
        t1: clampT(b.startTime),
        t2: clampT(b.endTime),
        p1: b.high,
        p2: b.low,
        fill: col.session + (b.complete ? '1f' : '14'),
        stroke: col.session + 'aa',
        dashed: !b.complete,
        label: compact || !labelled.has(b.key) ? undefined : `${b.label}${b.complete ? '' : ' (developing)'}`,
        labelColor: col.session,
      });
    }
  }

  if (vis.levels) {
    const price = candles[candles.length - 1].close;
    const untested = s.levels.filter((l) => l.status === 'untested' || l.status === 'breached');
    const above = untested.filter((l) => l.price >= price).sort((a, b) => a.price - b.price).slice(0, maxEach);
    const below = untested.filter((l) => l.price < price).sort((a, b) => b.price - a.price).slice(0, maxEach);
    for (const l of [...above, ...below]) {
      const color = l.side === 'high' ? col.liquidityHigh : col.liquidityLow;
      out.segments.push({ t1: clampT(l.originTime), t2: last, price: l.price, color, width: l.kind === 'PDH' || l.kind === 'PDL' ? 2 : 1, dashed: l.status === 'breached', label: compact ? `${short(l.label)} ${fmt(l.price)}` : `${l.label} ${fmt(l.price)}`, labelSide: 'right', extendRight: true });
    }
    // Recently swept levels (dimmed, ending at the sweep).
    for (const l of s.levels.filter((x) => x.status === 'swept' && x.statusTime !== null && x.statusTime >= first).slice(-3)) {
      out.segments.push({ t1: clampT(l.originTime), t2: clampT(l.statusTime!), price: l.price, color: col.sweep + '99', dashed: true, label: compact ? undefined : `${short(l.label)} swept`, labelSide: 'left' });
    }
  }

  if (vis.fvg) {
    // Uncluttered by default: only open gaps, the ones nearest to price.
    const px = candles[candles.length - 1].close;
    const open = s.fvgs
      .filter((g) => (g.status === 'active' || g.status === 'partial') && g.time >= first)
      .sort((a, b) => Math.abs((a.top + a.bottom) / 2 - px) - Math.abs((b.top + b.bottom) / 2 - px))
      .slice(0, opts.maxFvgs ?? 4);
    for (const g of open) {
      const end = last;
      const bull = g.direction === 'bullish';
      out.boxes.push({
        t1: clampT(g.time),
        t2: clampT(end),
        p1: g.top,
        p2: g.bottom,
        fill: bull ? col.fvgBull : col.fvgBear,
        dashed: g.status !== 'active',
        label: compact ? undefined : `FVG ${bull ? '▲' : '▼'}${g.status === 'active' ? '' : ' ' + g.status}`,
        labelColor: bull ? col.target : col.stop,
      });
    }
  }

  if (vis.orderBlocks) {
    for (const ob of s.orderBlocks.filter((o) => o.status !== 'invalidated' && o.time >= first).slice(-4)) {
      const end = last;
      const bull = ob.direction === 'bullish';
      out.boxes.push({
        t1: clampT(ob.time),
        t2: clampT(end),
        p1: ob.high,
        p2: ob.low,
        fill: bull ? col.obBull : col.obBear,
        stroke: bull ? col.target : col.stop,
        dashed: ob.status !== 'active',
        midLine: true,
        label: compact ? undefined : `${bull ? 'Bull' : 'Bear'} OB${ob.status === 'active' ? '' : ' ' + ob.status}`,
        labelColor: bull ? col.target : col.stop,
      });
    }
  }

  if (vis.bos) {
    for (const b of s.structureBreaks.slice(-12)) {
      if (!within(b.time)) continue;
      out.segments.push({ t1: clampT(b.swingTime), t2: b.time, price: b.price, color: col.bos, width: 1, label: 'BOS', labelSide: 'right' });
    }
  }

  if (vis.sweeps) {
    for (const sw of s.sweeps) {
      if (!within(sw.startTime) || !sw.eligible) continue;
      out.markers.push({
        time: sw.startTime,
        position: sw.direction === 'long' ? 'belowBar' : 'aboveBar',
        shape: sw.direction === 'long' ? 'arrowUp' : 'arrowDown',
        color: sw.eligible ? col.sweep : col.sweep + '77',
        text: compact ? undefined : 'Sweep',
      });
    }
  }

  if (vis.displacement) {
    // Only displacement that formed part of an ELF setup (signal or pending candidate).
    const setupDisp = new Set([...s.signals.map((x) => x.displacement?.id), s.candidate?.displacement?.id].filter(Boolean));
    for (const d of s.displacements) {
      if (!within(d.time) || !setupDisp.has(d.id)) continue;
      out.markers.push({ time: d.time, position: d.direction === 'long' ? 'belowBar' : 'aboveBar', shape: 'circle', color: col.accent + 'aa', text: compact ? undefined : 'D' });
    }
  }

  if (vis.swings) {
    for (const sp of s.swings) {
      if (!within(sp.time)) continue;
      out.markers.push({ time: sp.time, position: sp.side === 'high' ? 'aboveBar' : 'belowBar', shape: 'square', color: '#94a3b8', text: sp.side === 'high' ? 'SH' : 'SL' });
    }
  }

  if (vis.plan) {
    const sig = planToDraw(s);
    if (sig && within(sig.time)) {
      const p = sig.plan;
      const muted = sig.status === 'FILTERED';
      const sfx = muted ? ' (filtered)' : '';
      out.segments.push({ t1: sig.time, t2: last, price: p.entry, color: col.entry + (muted ? '88' : ''), width: 2, label: `Entry ${fmt(p.entry)}${sfx}`, labelSide: 'right', extendRight: true });
      out.segments.push({ t1: sig.time, t2: last, price: p.stop, color: col.stop + (muted ? '88' : ''), width: 2, label: `SL ${fmt(p.stop)}`, labelSide: 'right', extendRight: true });
      out.segments.push({ t1: sig.time, t2: last, price: p.tp1, color: col.target + (muted ? '88' : ''), dashed: true, label: `TP1 ${fmt(p.tp1)}`, labelSide: 'right', extendRight: true });
      if (p.tp2 !== null) out.segments.push({ t1: sig.time, t2: last, price: p.tp2, color: col.target + (muted ? '88' : ''), width: 2, label: `TP2 ${fmt(p.tp2)} (${p.rr?.toFixed(2)}R)`, labelSide: 'right', extendRight: true });
    }
  }

  if (vis.outcomes) {
    for (const sg of s.signals) {
      if (!within(sg.time)) continue;
      out.markers.push({
        time: sg.time,
        position: sg.direction === 'long' ? 'belowBar' : 'aboveBar',
        shape: sg.direction === 'long' ? 'arrowUp' : 'arrowDown',
        color: sg.status === 'ENTRY_READY' ? col.accent : '#9ca3af',
        text: sg.status === 'ENTRY_READY' ? `ELF ${sg.direction.toUpperCase()}` : 'Filtered',
      });
    }
    for (const t of s.trades) {
      if (t.exitTime !== null && within(t.exitTime)) {
        const win = (t.resultR ?? 0) > 0;
        out.markers.push({ time: t.exitTime, position: 'inBar', shape: 'circle', color: win ? col.target : col.stop, text: `${(t.outcome ?? '').toUpperCase()} ${(t.resultR ?? 0) >= 0 ? '+' : ''}${(t.resultR ?? 0).toFixed(2)}R${t.ambiguous ? '*' : ''}` });
      }
      if (t.tp1Time !== null && within(t.tp1Time)) out.markers.push({ time: t.tp1Time, position: t.direction === 'long' ? 'aboveBar' : 'belowBar', shape: 'circle', color: col.target, text: 'TP1' });
    }
  }

  out.markers.sort((a, b) => a.time - b.time);
  return out;
}
