// ELF — Emerald Liquidity Flow strategy engine.
//
// Deterministic, incremental, closed-candle state machine:
//   BUILD → LIQUIDITY → SWEEP → BOS → DISPLACEMENT → ENTRY SETUP → TRADE MANAGEMENT
//
// Rules of the road:
//   * `update()` must be called with CLOSED candles only, in time order.
//   * Nothing in here ever reads a candle after the one being processed. Swing pivots
//     become known `swingLength` bars after they form; HTF candles are only used once
//     their close time is <= the current candle's close time.
//   * Detection (levels, sweeps, BOS, displacement, FVG, OB), confirmation (the candidate
//     state machine), planning (entry/stop/targets/R:R filters) and outcome tracking
//     (trade.ts) are separate steps.

import type { Candle, Timeframe } from '../shared/types.js';
import { tfSeconds, TIMEFRAME_SECONDS } from '../shared/types.js';
import { Atr, Ema } from './indicators.js';
import { type ElfConfig, configHash } from './config.js';
import { SessionTracker, sessionWindows, activeSessions, type RangeBox, SESSION_LABELS } from './sessions.js';
import { newTrade, stepTrade, closeTradeManually, type Direction, type TradeState } from './trade.js';
import type { SessionName } from './config.js';

export type ElfState = 'IDLE' | 'BUILD' | 'SWEPT' | 'CONFIRMED' | 'ENTRY_READY' | 'MANAGING' | 'COMPLETED' | 'FILTERED';

export type LevelKind = 'PDH' | 'PDL' | 'SESSION_HIGH' | 'SESSION_LOW' | 'SWING_HIGH' | 'SWING_LOW' | 'EQH' | 'EQL';
export type LevelStatus = 'untested' | 'breached' | 'swept' | 'broken' | 'expired' | 'merged';

export interface LiquidityLevel {
  id: string;
  kind: LevelKind;
  side: 'high' | 'low';
  price: number;
  label: string;
  originTime: number; // time of the candle that made the extreme
  availableTime: number; // open time of the candle on whose close the level became known
  availableIndex: number;
  status: LevelStatus;
  statusTime: number | null;
  breach: { startIndex: number; startTime: number; extreme: number } | null;
}

export interface SwingPoint {
  index: number;
  time: number;
  price: number;
  side: 'high' | 'low';
  confirmedIndex: number;
  confirmedTime: number;
  broken: boolean;
}

export interface SweepRecord {
  id: string;
  direction: Direction; // reversal direction (bullish sweep of lows = long)
  levelIds: string[];
  levelLabel: string;
  levelPrice: number;
  extreme: number;
  penetration: number;
  threshold: number;
  startTime: number;
  startIndex: number;
  reclaimed: boolean;
  reclaimTime: number | null;
  eligible: boolean; // false when outside session / trade active etc.
  note: string;
}

export interface StructureBreak {
  id: string;
  direction: Direction;
  price: number; // swing level broken
  swingTime: number;
  time: number; // candle that closed through
  close: number;
}

export interface DisplacementRecord {
  id: string;
  direction: Direction;
  startTime: number;
  time: number;
  body: number;
  atr: number;
  ratio: number;
  bars: number;
}

export interface Fvg {
  id: string;
  direction: 'bullish' | 'bearish';
  top: number;
  bottom: number;
  time: number; // middle candle time (box start)
  createdTime: number; // third candle
  status: 'active' | 'partial' | 'mitigated' | 'invalidated';
  statusTime: number | null;
}

export interface OrderBlock {
  id: string;
  direction: 'bullish' | 'bearish';
  high: number;
  low: number;
  mid: number;
  time: number; // the OB candle
  createdTime: number; // when it became known (BOS / confirmation bar)
  status: 'active' | 'tested' | 'invalidated';
  statusTime: number | null;
  source: 'structure' | 'setup';
}

export interface Bias {
  value: 'bullish' | 'bearish' | 'unknown';
  ema: number | null;
  close: number | null;
  htfTime: number | null; // open time of the HTF candle used
  timeframe: Timeframe;
}

export interface PlanCheck {
  rule: string;
  pass: boolean;
  detail: string;
}

export interface TradePlan {
  direction: Direction;
  entry: number;
  stop: number;
  tp1: number;
  tp2: number | null;
  tp2Label: string | null;
  riskPerUnit: number;
  rewardPerUnit: number | null;
  rr: number | null;
  minRR: number;
  invalidation: number;
  atr: number;
  checks: PlanCheck[];
}

export interface Signal {
  id: string;
  status: 'ENTRY_READY' | 'FILTERED';
  direction: Direction;
  time: number; // confirmation candle open time (entry at its close)
  closeTime: number;
  index: number;
  sweep: SweepRecord;
  bos: StructureBreak | null;
  displacement: DisplacementRecord | null;
  orderBlockId: string | null;
  plan: TradePlan;
  reasons: string[]; // filter reasons (empty when ENTRY_READY)
  session: SessionName[];
  bias: Bias;
}

export type EngineEventType =
  | 'sweep_preliminary'
  | 'sweep_reclaimed'
  | 'bos'
  | 'displacement'
  | 'confirmed'
  | 'entry_ready'
  | 'filtered'
  | 'expired'
  | 'invalidated'
  | 'tp1'
  | 'tp2'
  | 'sl'
  | 'breakeven'
  | 'trade_expired'
  | 'trade_closed';

export interface EngineEvent {
  type: EngineEventType;
  key: string; // stable de-duplication key
  time: number; // candle open time
  closeTime: number;
  index: number;
  direction?: Direction;
  message: string;
  data?: Record<string, unknown>;
}

export interface Candidate {
  id: string;
  direction: Direction;
  sweep: SweepRecord;
  anchor: LiquidityLevel;
  extreme: number;
  extremeIndex: number;
  reclaimIndex: number | null;
  bos: StructureBreak | null;
  displacement: DisplacementRecord | null;
  bosRef: SwingPoint | null;
}

export interface EngineSnapshot {
  symbol: string;
  timeframe: Timeframe;
  configHash: string;
  barCount: number;
  lastTime: number | null;
  state: ElfState;
  stateReason: string;
  atr: number | null;
  bias: Bias;
  sessions: { active: SessionName[]; developing: RangeBox[]; completed: RangeBox[]; day: RangeBox | null; previousDay: RangeBox | null };
  levels: LiquidityLevel[]; // active + recently resolved
  nearestAbove: LiquidityLevel | null;
  nearestBelow: LiquidityLevel | null;
  swings: SwingPoint[];
  sweeps: SweepRecord[];
  structureBreaks: StructureBreak[];
  displacements: DisplacementRecord[];
  fvgs: Fvg[];
  orderBlocks: OrderBlock[];
  candidate: Candidate | null;
  signals: Signal[];
  lastSignal: Signal | null;
  trade: TradeState | null;
  trades: TradeState[];
}

export interface EngineOptions {
  symbol: string;
  timeframe: Timeframe;
  /** Higher-timeframe candles (any order, may include the still-forming one — it is ignored until closed). */
  htfCandles?: Candle[];
  /** Max drawing objects retained for snapshots (signals/trades are always kept). */
  historyCap?: number;
  /** Optional lower-timeframe provider for ambiguous stop/target candles. */
  intrabar?: (candle: Candle) => Candle[] | undefined;
  /** Live use only — the manual news blackout applies to new entries. Backtests pass false. */
  applyNewsBlackout?: boolean;
}

const EPS = 1e-9;

interface SweepHit {
  level: LiquidityLevel;
  penetration: number;
  reclaimed: boolean;
}

interface BarCtx {
  c: Candle;
  i: number;
  atr: number;
  inSession: SessionName[];
  entrySessionOk: boolean;
  disp: DisplacementRecord | null;
  bosThisBar: StructureBreak[];
  ev: (type: EngineEventType, ref: string, message: string, extra?: Partial<EngineEvent>) => void;
}

type CandidateOutcome = { kind: 'none' } | { kind: 'signal'; signal: Signal } | { kind: 'expired'; reason: string };

export class ElfEngine {
  readonly config: ElfConfig;
  readonly symbol: string;
  readonly timeframe: Timeframe;
  private readonly tfSec: number;
  private readonly cap: number;
  private readonly hash: string;
  private readonly opts: EngineOptions;

  private candles: Candle[] = [];
  private atrInd: Atr;
  private atrValues: (number | null)[] = [];
  private sessions: SessionTracker;
  private windows: ReturnType<typeof sessionWindows>;

  private levels: LiquidityLevel[] = [];
  private resolvedLevels: LiquidityLevel[] = [];
  private swings: SwingPoint[] = [];
  private sweeps: SweepRecord[] = [];
  private bosList: StructureBreak[] = [];
  private displacements: DisplacementRecord[] = [];
  private fvgs: Fvg[] = [];
  private obs: OrderBlock[] = [];
  private completedRanges: RangeBox[] = [];
  private previousDay: RangeBox | null = null;

  private candidate: Candidate | null = null;
  private signals: Signal[] = [];
  private trade: TradeState | null = null;
  private trades: TradeState[] = [];
  private state: ElfState = 'IDLE';
  private stateReason = 'Warming up indicators';

  // HTF bias
  private htf: Candle[] = [];
  private htfPtr = 0;
  private htfEma: Ema;
  private bias: Bias;

  private seq = 0;
  private emittedSweepLevels = new Set<string>();

  constructor(config: ElfConfig, opts: EngineOptions) {
    this.config = config;
    this.opts = opts;
    this.symbol = opts.symbol;
    this.timeframe = opts.timeframe;
    this.tfSec = tfSeconds(opts.timeframe);
    this.cap = opts.historyCap ?? 400;
    this.hash = configHash(config);
    this.atrInd = new Atr(config.atrPeriod);
    this.sessions = new SessionTracker(config);
    this.windows = sessionWindows(config);
    this.htfEma = new Ema(config.htfEmaLength);
    this.bias = { value: 'unknown', ema: null, close: null, htfTime: null, timeframe: config.htfTimeframe };
    if (opts.htfCandles) this.setHtfCandles(opts.htfCandles);
  }

  /** Replace the HTF series. Only candles whose close time <= current candle close are ever used. */
  setHtfCandles(htf: Candle[]) {
    const sorted = [...htf].sort((a, b) => a.time - b.time);
    // Keep already-consumed prefix consistent: rebuild the EMA from scratch.
    this.htf = sorted;
    this.htfPtr = 0;
    this.htfEma = new Ema(this.config.htfEmaLength);
    this.bias = { value: 'unknown', ema: null, close: null, htfTime: null, timeframe: this.config.htfTimeframe };
    const last = this.candles[this.candles.length - 1];
    if (last) this.advanceHtf(last.time + this.tfSec);
  }

  private advanceHtf(asOfCloseTime: number) {
    const htfSec = TIMEFRAME_SECONDS[this.config.htfTimeframe];
    while (this.htfPtr < this.htf.length && this.htf[this.htfPtr].time + htfSec <= asOfCloseTime) {
      const h = this.htf[this.htfPtr];
      const ema = this.htfEma.update(h.close);
      this.bias = {
        value: ema === null ? 'unknown' : h.close > ema ? 'bullish' : h.close < ema ? 'bearish' : 'unknown',
        ema,
        close: h.close,
        htfTime: h.time,
        timeframe: this.config.htfTimeframe,
      };
      this.htfPtr++;
    }
  }

  get barCount() {
    return this.candles.length;
  }

  private id(prefix: string) {
    return `${prefix}${++this.seq}`;
  }

  private evKey(type: string, ref: string) {
    return `${this.symbol}|${this.timeframe}|${type}|${ref}`;
  }

  /** Process one CLOSED candle. Returns the events it produced. */
  update(c: Candle): EngineEvent[] {
    const prev = this.candles[this.candles.length - 1];
    if (prev && c.time <= prev.time) throw new Error(`Candles must be strictly increasing in time (${c.time} after ${prev.time})`);
    if (![c.open, c.high, c.low, c.close].every(Number.isFinite) || c.high < c.low) throw new Error(`Invalid candle at ${c.time}`);

    const i = this.candles.length;
    this.candles.push(c);
    const closeTime = c.time + this.tfSec;
    const atr = this.atrInd.update(c);
    this.atrValues.push(atr);
    this.advanceHtf(closeTime);
    const events: EngineEvent[] = [];
    const ev = (type: EngineEventType, ref: string, message: string, extra: Partial<EngineEvent> = {}) => {
      events.push({ type, key: this.evKey(type, ref), time: c.time, closeTime, index: i, message, ...extra });
    };

    // ── BUILD: sessions / days → completed ranges become liquidity ─────────────────
    const su = this.sessions.update(c);
    for (const box of su.completed) {
      this.pushCapped(this.completedRanges, box);
      if (this.config.includeSessionLevels) {
        this.addLevel('SESSION_HIGH', 'high', box.high, `${box.label} H`, box.highTime, i - 1, prev?.time ?? c.time);
        this.addLevel('SESSION_LOW', 'low', box.low, `${box.label} L`, box.lowTime, i - 1, prev?.time ?? c.time);
      }
    }
    if (su.dayCompleted) {
      this.previousDay = su.dayCompleted;
      // Older PDH/PDL are no longer "previous day".
      for (const l of this.levels) if ((l.kind === 'PDH' || l.kind === 'PDL') && l.status === 'untested') this.resolveLevel(l, 'expired', c.time);
      if (this.config.includePrevDayLevels) {
        this.addLevel('PDH', 'high', su.dayCompleted.high, 'PDH', su.dayCompleted.highTime, i - 1, prev?.time ?? c.time);
        this.addLevel('PDL', 'low', su.dayCompleted.low, 'PDL', su.dayCompleted.lowTime, i - 1, prev?.time ?? c.time);
      }
    }

    // ── Swing pivots (confirmed swingLength bars later) ──────────────────────────────
    this.detectSwing(i, atr);

    if (atr === null) {
      this.state = 'IDLE';
      this.stateReason = `Warming up ATR(${this.config.atrPeriod}) — ${i + 1}/${this.config.atrPeriod} bars`;
      this.cleanup();
      return events;
    }

    const threshold = this.config.sweepAtrMult * atr;
    const inSession = su.inSession;
    const sessionOk = (when: 'sweep' | 'entry') =>
      this.config.sessionGate === 'off' || (this.config.sessionGate !== 'both' && this.config.sessionGate !== when) || inSession.length > 0;

    // ── Trade management (always, also outside sessions) ────────────────────────────
    let completedThisBar = false;
    if (this.trade && this.trade.entryIndex < i) {
      const t = this.trade;
      const stepEvents = stepTrade(t, c, this.opts.intrabar?.(c), this.config.tradeExpiryBars);
      for (const se of stepEvents) {
        const map = { tp1: 'tp1', tp2: 'tp2', sl: 'sl', breakeven: 'breakeven', expired: 'trade_expired' } as const;
        const type = map[se.type];
        ev(type, `${t.id}`, `${t.direction.toUpperCase()} ${se.type.toUpperCase()} at ${fmt(se.price)}${se.ambiguous ? ' (ambiguous candle — stop assumed first)' : ''}`, {
          direction: t.direction,
          data: { tradeId: t.id, price: se.price, ambiguous: se.ambiguous, resultR: t.resultR, entry: t.entry, stop: t.initialStop, tp1: t.tp1, tp2: t.tp2 },
        });
      }
      if (t.status === 'closed') {
        this.trade = null;
        completedThisBar = true;
      }
    }

    // ── LIQUIDITY / SWEEP detection ─────────────────────────────────────────────────
    // A "hit" is a level whose wick penetration reached the threshold this bar (preliminary),
    // or a qualified breach that closed back through the level this bar (reclaimed).
    const hits: SweepHit[] = [];
    for (const l of this.levels) {
      if (l.availableIndex >= i || (l.status !== 'untested' && l.status !== 'breached')) continue;
      if (this.config.levelMaxAgeBars > 0 && i - l.availableIndex > this.config.levelMaxAgeBars) {
        this.resolveLevel(l, 'expired', c.time);
        continue;
      }
      const isHigh = l.side === 'high';
      const beyond = isHigh ? c.high > l.price : c.low < l.price;
      const closedBack = isHigh ? c.close < l.price : c.close > l.price;
      if (l.status === 'untested') {
        if (!beyond) continue;
        const pen = isHigh ? c.high - l.price : l.price - c.low;
        if (closedBack) {
          if (pen + EPS >= threshold) {
            l.status = 'swept';
            l.statusTime = c.time;
            l.breach = { startIndex: i, startTime: c.time, extreme: isHigh ? c.high : c.low };
            hits.push({ level: l, penetration: pen, reclaimed: true });
          }
          // else: a simple touch / sub-threshold probe — not a sweep; the level stays untested.
        } else {
          l.breach = { startIndex: i, startTime: c.time, extreme: isHigh ? c.high : c.low };
          if (this.config.requireSameCandleReclaim) {
            this.resolveLevel(l, 'broken', c.time);
          } else {
            l.status = 'breached';
            l.statusTime = c.time;
            if (pen + EPS >= threshold) hits.push({ level: l, penetration: pen, reclaimed: false });
          }
        }
      } else {
        // breached: waiting for a close back through the level.
        const b = l.breach!;
        const wasQualified = Math.abs(b.extreme - l.price) + EPS >= threshold;
        b.extreme = isHigh ? Math.max(b.extreme, c.high) : Math.min(b.extreme, c.low);
        const pen = Math.abs(b.extreme - l.price);
        const qualified = pen + EPS >= threshold;
        if (closedBack) {
          if (qualified) {
            l.status = 'swept';
            l.statusTime = c.time;
            hits.push({ level: l, penetration: pen, reclaimed: true });
          } else {
            // Closed back without the required penetration: an ordinary probe, still liquidity.
            l.status = 'untested';
            l.breach = null;
          }
        } else {
          if (!wasQualified && qualified) hits.push({ level: l, penetration: pen, reclaimed: false });
          if (i - b.startIndex >= this.config.maxConfirmBars) this.resolveLevel(l, 'broken', c.time);
        }
      }
    }

    // ── Structure BOS (by CLOSE beyond the most recent confirmed swing) ──────────────
    const bosThisBar: StructureBreak[] = [];
    const lastHigh = this.lastSwing('high', i);
    const lastLow = this.lastSwing('low', i);
    if (lastHigh && !lastHigh.broken && c.close > lastHigh.price) {
      lastHigh.broken = true;
      const b: StructureBreak = { id: this.id('bos'), direction: 'long', price: lastHigh.price, swingTime: lastHigh.time, time: c.time, close: c.close };
      bosThisBar.push(b);
      this.pushCapped(this.bosList, b);
      ev('bos', `long|${lastHigh.time}`, `Bullish BOS: close ${fmt(c.close)} above swing high ${fmt(lastHigh.price)}`, { direction: 'long', data: { price: lastHigh.price } });
      this.maybeStructureOrderBlock(b, lastHigh, i);
    }
    if (lastLow && !lastLow.broken && c.close < lastLow.price) {
      lastLow.broken = true;
      const b: StructureBreak = { id: this.id('bos'), direction: 'short', price: lastLow.price, swingTime: lastLow.time, time: c.time, close: c.close };
      bosThisBar.push(b);
      this.pushCapped(this.bosList, b);
      ev('bos', `short|${lastLow.time}`, `Bearish BOS: close ${fmt(c.close)} below swing low ${fmt(lastLow.price)}`, { direction: 'short', data: { price: lastLow.price } });
      this.maybeStructureOrderBlock(b, lastLow, i);
    }

    // ── Displacement ────────────────────────────────────────────────────────────────
    const disp = this.detectDisplacement(i);
    if (disp) {
      this.pushCapped(this.displacements, disp);
      ev('displacement', `${disp.direction}|${disp.time}`, `${disp.direction === 'long' ? 'Bullish' : 'Bearish'} displacement: body ${fmt(disp.body)} = ${(disp.body / disp.atr).toFixed(2)}× ATR`, { direction: disp.direction });
    }

    // ── FVG / order-block lifecycle ────────────────────────────────────────────────
    this.updateFvgs(i, atr);
    this.updateOrderBlocks(c);

    const ctx: BarCtx = { c, i, atr, inSession, entrySessionOk: sessionOk('entry'), disp, bosThisBar, ev };
    let outcome: CandidateOutcome = { kind: 'none' };

    // ── 1) Progress the PENDING candidate first (its anchor level's reclaim is handled here) ──
    const pendingAnchor = this.candidate?.anchor.id;
    if (this.candidate) outcome = this.progressCandidate(this.candidate, ctx);

    // ── 2) New sweeps → preliminary alerts and (maybe) a new candidate ─────────────
    for (const dir of ['long', 'short'] as Direction[]) {
      const side = dir === 'long' ? 'low' : 'high';
      const group = hits.filter((h) => h.level.side === side && h.level.id !== pendingAnchor);
      if (group.length === 0) continue;
      // Anchor: the furthest level that met the threshold (most liquidity taken).
      group.sort((a, b) => (side === 'low' ? a.level.price - b.level.price : b.level.price - a.level.price));
      const anchor = group[0];
      const fresh = group.filter((g) => !this.emittedSweepLevels.has(g.level.id));
      const extreme = anchor.level.breach!.extreme;
      const rec: SweepRecord = {
        id: this.id('sw'),
        direction: dir,
        levelIds: group.map((g) => g.level.id),
        levelLabel: group.map((g) => g.level.label).join(' + '),
        levelPrice: anchor.level.price,
        extreme,
        penetration: anchor.penetration,
        threshold,
        startTime: anchor.level.breach!.startTime,
        startIndex: anchor.level.breach!.startIndex,
        reclaimed: anchor.reclaimed,
        reclaimTime: anchor.reclaimed ? c.time : null,
        eligible: true,
        note: '',
      };
      const pending = this.candidate;
      if (this.trade) {
        rec.eligible = false;
        rec.note = 'A trade is already being managed — sweep recorded, not tracked as a new setup.';
      } else if (pending && pending.direction !== dir && !anchor.reclaimed) {
        // A close beyond an opposing level is continuation, not a reversal sweep (yet).
        rec.eligible = false;
        rec.note = `Not reclaimed — the pending ${pending.direction} setup stays active.`;
      } else if (this.config.sessionGate !== 'off' && (this.config.sessionGate === 'sweep' || this.config.sessionGate === 'both') && !this.sessions.isInSession(rec.startTime)) {
        rec.eligible = false;
        rec.note = 'Outside the permitted session (the sweep began outside an enabled session window).';
      }
      if (fresh.length > 0) {
        for (const g of fresh) this.emittedSweepLevels.add(g.level.id);
        this.pushCapped(this.sweeps, rec);
        ev('sweep_preliminary', `${anchor.level.id}`, `${dir === 'long' ? 'Bullish' : 'Bearish'} sweep of ${rec.levelLabel} @ ${fmt(rec.levelPrice)} — wick ${fmt(extreme)}, penetration ${fmt(rec.penetration)} (≥ ${fmt(threshold)})${rec.reclaimed ? ', closed back' : ', awaiting close back'}${rec.eligible ? '' : ' — ' + rec.note}`, {
          direction: dir,
          data: { level: rec.levelPrice, extreme, penetration: rec.penetration, threshold, levels: rec.levelLabel, eligible: rec.eligible, reclaimed: rec.reclaimed },
        });
      } else {
        const existing = this.sweeps.find((s) => s.levelIds.includes(anchor.level.id));
        if (existing && anchor.reclaimed) {
          existing.reclaimed = true;
          existing.reclaimTime = c.time;
        }
      }
      if (!rec.eligible) continue;
      if (anchor.reclaimed) ev('sweep_reclaimed', `${anchor.level.id}`, `Close back ${dir === 'long' ? 'above' : 'below'} ${rec.levelLabel} (${fmt(c.close)})`, { direction: dir });
      if (this.candidate) {
        ev('invalidated', `${this.candidate.id}`, `Pending ${this.candidate.direction} setup superseded by a newer ${dir} sweep`, {
          direction: this.candidate.direction,
          data: { reason: 'Superseded by a newer sweep' },
        });
      }
      const cand: Candidate = {
        id: rec.id,
        direction: dir,
        sweep: rec,
        anchor: anchor.level,
        extreme,
        extremeIndex: i,
        reclaimIndex: anchor.reclaimed ? i : null,
        bos: null,
        displacement: null,
        bosRef: null,
      };
      this.candidate = cand;
      // The sweep candle itself may already complete the sequence.
      const o = this.progressCandidate(cand, ctx);
      if (o.kind !== 'none') outcome = o;
    }

    // ── State ─────────────────────────────────────────────────────────────────────
    if (outcome.kind === 'signal') {
      const s = outcome.signal;
      this.state = s.status;
      this.stateReason = s.status === 'ENTRY_READY' ? `${s.direction.toUpperCase()} plan ready — R:R ${s.plan.rr!.toFixed(2)}` : s.reasons.join('; ');
    } else if (outcome.kind === 'expired' && !this.candidate) {
      this.state = 'FILTERED';
      this.stateReason = outcome.reason;
    } else if (completedThisBar) {
      const t = this.trades[this.trades.length - 1];
      this.state = 'COMPLETED';
      this.stateReason = `Trade closed: ${t.outcome?.toUpperCase()} (${t.resultR?.toFixed(2)}R)`;
    } else if (this.trade) {
      this.state = 'MANAGING';
      this.stateReason = `${this.trade.direction.toUpperCase()} from ${fmt(this.trade.entry)}${this.trade.tp1Hit ? ' — TP1 reached' : ''}`;
    } else if (this.candidate) {
      const cd = this.candidate;
      this.state = 'SWEPT';
      const need = [cd.reclaimIndex === null ? 'reclaim close' : null, cd.bos ? null : `BOS ${cd.bosRef ? '@ ' + fmt(cd.bosRef.price) : '(no confirmed swing yet)'}`, cd.displacement ? null : 'displacement'].filter(Boolean);
      this.stateReason = `${cd.direction === 'long' ? 'Bullish' : 'Bearish'} sweep of ${cd.sweep.levelLabel} — waiting for ${need.join(', ')} (${i - cd.sweep.startIndex}/${this.config.maxConfirmBars} bars)`;
    } else {
      const active = this.levels.filter((l) => l.status === 'untested');
      this.state = active.length ? 'BUILD' : 'IDLE';
      this.stateReason = active.length ? `Tracking ${active.length} liquidity levels — waiting for a qualifying sweep` : 'No liquidity levels established yet';
    }
    this.cleanup();
    return events;
  }

  /** Advance a candidate by the current bar: reclaim → BOS → displacement → plan, or expiry. */
  private progressCandidate(cand: Candidate, ctx: BarCtx): CandidateOutcome {
    const { c, i, atr, ev } = ctx;
    const long = cand.direction === 'long';
    // Track the wick extreme (stop anchor) until confirmation.
    if (long ? c.low < cand.extreme : c.high > cand.extreme) {
      cand.extreme = long ? c.low : c.high;
      cand.extremeIndex = i;
      cand.sweep.extreme = cand.extreme;
    }
    // Reclaim (close back through the anchor level).
    const closedBack = long ? c.close > cand.anchor.price : c.close < cand.anchor.price;
    if (cand.reclaimIndex === null && closedBack) {
      cand.reclaimIndex = i;
      cand.sweep.reclaimed = true;
      cand.sweep.reclaimTime = c.time;
      ev('sweep_reclaimed', `${cand.anchor.id}`, `Close back ${long ? 'above' : 'below'} ${cand.sweep.levelLabel} (${fmt(c.close)})`, { direction: cand.direction });
    } else if (cand.reclaimIndex !== null && !closedBack && cand.reclaimIndex < i && !cand.bos) {
      // Reclaim lost before BOS: wait for a new close back.
      cand.reclaimIndex = null;
      cand.sweep.reclaimed = false;
    }
    // BOS reference: latest confirmed swing whose pivot is at/before the sweep candle.
    const ref = this.swingRefFor(cand, i);
    cand.bosRef = ref;
    if (!cand.bos && ref && cand.reclaimIndex !== null && (long ? c.close > ref.price : c.close < ref.price)) {
      cand.bos = { id: this.id('bos'), direction: cand.direction, price: ref.price, swingTime: ref.time, time: c.time, close: c.close };
      if (!ctx.bosThisBar.some((b) => b.direction === cand.direction && b.swingTime === ref.time)) {
        this.pushCapped(this.bosList, cand.bos);
        ev('bos', `${cand.direction}|${ref.time}`, `${long ? 'Bullish' : 'Bearish'} BOS: close ${fmt(c.close)} ${long ? 'above' : 'below'} swing ${fmt(ref.price)}`, { direction: cand.direction, data: { price: ref.price } });
      }
    }
    // Displacement in the setup direction, starting on/after the sweep candle.
    const disp = ctx.disp;
    if (!cand.displacement && disp && disp.direction === cand.direction && this.indexOfTime(disp.startTime) >= cand.sweep.startIndex) {
      cand.displacement = disp;
    }

    const age = i - cand.sweep.startIndex;
    if (cand.reclaimIndex !== null && cand.bos && cand.displacement) {
      ev('confirmed', `${cand.id}`, `ELF ${cand.direction.toUpperCase()} confirmed: sweep → BOS → displacement`, { direction: cand.direction });
      const signal = this.buildSignal(cand, c, i, atr, ctx.inSession, ctx.entrySessionOk);
      this.signals.push(signal);
      this.candidate = null;
      const p = signal.plan;
      if (signal.status === 'ENTRY_READY') {
        ev('entry_ready', `${signal.id}`, `ENTRY READY ${cand.direction.toUpperCase()} @ ${fmt(p.entry)} SL ${fmt(p.stop)} TP1 ${fmt(p.tp1)} TP2 ${fmt(p.tp2!)} R:R ${p.rr!.toFixed(2)}`, {
          direction: cand.direction,
          data: { entry: p.entry, stop: p.stop, tp1: p.tp1, tp2: p.tp2, rr: p.rr, signalId: signal.id },
        });
        this.trade = newTrade(signal.id, { direction: cand.direction, entry: p.entry, stop: p.stop, tp1: p.tp1, tp2: p.tp2! }, c.time, i, this.config.breakevenAfterTp1);
        this.trades.push(this.trade);
      } else {
        ev('filtered', `${signal.id}`, `FILTERED ${cand.direction.toUpperCase()}: ${signal.reasons.join('; ')}`, {
          direction: cand.direction,
          data: { reasons: signal.reasons, entry: p.entry, stop: p.stop, tp2: p.tp2, rr: p.rr },
        });
      }
      return { kind: 'signal', signal };
    }
    if (age >= this.config.maxConfirmBars) {
      const missing = [cand.reclaimIndex === null ? 'reclaim close' : null, cand.bos ? null : 'BOS', cand.displacement ? null : 'displacement'].filter(Boolean) as string[];
      ev('expired', `${cand.id}`, `Setup expired after ${age} bars — missing ${missing.join(', ')}`, { direction: cand.direction, data: { reason: 'Confirmation expired', missing } });
      this.candidate = null;
      return { kind: 'expired', reason: `Confirmation expired (missing ${missing.join(', ')})` };
    }
    return { kind: 'none' };
  }

  /** Manual close / cancel of the engine's theoretical trade (replay & live workflow). */
  closeActiveTrade(price: number, outcome: 'manual' | 'cancelled' = 'manual'): TradeState | null {
    if (!this.trade) return null;
    const last = this.candles[this.candles.length - 1];
    closeTradeManually(this.trade, price, last?.time ?? 0, outcome);
    const t = this.trade;
    this.trade = null;
    this.state = 'COMPLETED';
    this.stateReason = `Trade ${outcome === 'manual' ? 'manually closed' : 'cancelled'}`;
    return t;
  }

  // ── helpers ───────────────────────────────────────────────────────────────────────

  private buildSignal(cand: Candidate, c: Candle, i: number, atr: number, inSession: SessionName[], sessionPass: boolean): Signal {
    const long = cand.direction === 'long';
    const opposing = this.levels.filter((l) => l.status === 'untested' && l.availableIndex <= i && l.side === (long ? 'high' : 'low'));
    const lv = computePlanLevels({
      direction: cand.direction,
      entry: c.close,
      extreme: cand.extreme,
      atr,
      slAtrBuffer: this.config.slAtrBuffer,
      tp1R: this.config.tp1R,
      targets: opposing.map((l) => ({ price: l.price, label: l.label })),
    });
    const { entry, stop, risk, tp1, rr } = lv;
    const target = lv.target;
    const tp2 = target ? target.price : null;
    const reward = lv.reward;

    const checks: PlanCheck[] = [];
    const reasons: string[] = [];
    const check = (rule: string, pass: boolean, detail: string, reason?: string) => {
      checks.push({ rule, pass, detail });
      if (!pass && reason) reasons.push(reason);
    };
    check('Sweep', true, `${cand.sweep.levelLabel} swept, wick ${fmt(cand.sweep.extreme)}`);
    check('Reclaim close', cand.reclaimIndex !== null, 'Closed back through the swept level', 'Required confirmation missing (reclaim)');
    check('BOS (close)', !!cand.bos, cand.bos ? `Close beyond swing ${fmt(cand.bos.price)}` : 'missing', 'Required confirmation missing (BOS)');
    check('Displacement', !!cand.displacement, cand.displacement ? `${(cand.displacement.body / cand.displacement.atr).toFixed(2)}× ATR, body/range ${(cand.displacement.ratio * 100).toFixed(0)}%` : 'missing', 'Required confirmation missing (displacement)');
    if (this.config.htfBiasEnabled) {
      const b = this.bias.value;
      const ok = b === (long ? 'bullish' : 'bearish');
      check(
        'HTF bias',
        ok,
        b === 'unknown' ? `No completed ${this.config.htfTimeframe} EMA(${this.config.htfEmaLength}) available` : `${this.config.htfTimeframe} close ${fmt(this.bias.close!)} ${b === 'bullish' ? '>' : '<'} EMA ${fmt(this.bias.ema!)} (${b})`,
        b === 'unknown' ? 'Higher-timeframe bias unavailable' : 'Against higher-timeframe bias',
      );
    } else checks.push({ rule: 'HTF bias', pass: true, detail: 'Filter disabled' });
    check('Session', sessionPass, inSession.length ? `In ${inSession.map((s) => SESSION_LABELS[s]).join(', ')}` : 'No enabled session active', 'Outside the permitted session');
    const blackout = this.config.newsBlackout && this.opts.applyNewsBlackout !== false;
    check('News blackout', !blackout, blackout ? 'Manual news blackout is ON' : 'Off', 'News blackout active');
    check('Risk > 0', risk > EPS, `Risk per unit ${fmt(risk)}`, 'Zero or negative risk');
    check('Target', tp2 !== null, target ? `${target.label} @ ${fmt(target.price)}` : 'No untested opposing liquidity beyond entry', 'No measurable target');
    if (tp2 !== null && risk > EPS) check('Min R:R', rr! + EPS >= this.config.minRR, `${rr!.toFixed(2)} vs required ${this.config.minRR.toFixed(1)}`, `Risk/reward ${rr!.toFixed(2)} below minimum ${this.config.minRR.toFixed(1)}`);
    if (this.trade) check('No active trade', false, 'A trade is already being managed', 'A trade is already active');

    const ob = this.config.obEnabled ? this.setupOrderBlock(cand, i) : null;

    return {
      id: cand.id,
      status: reasons.length === 0 ? 'ENTRY_READY' : 'FILTERED',
      direction: cand.direction,
      time: c.time,
      closeTime: c.time + this.tfSec,
      index: i,
      sweep: { ...cand.sweep },
      bos: cand.bos,
      displacement: cand.displacement,
      orderBlockId: ob?.id ?? null,
      plan: {
        direction: cand.direction,
        entry,
        stop,
        tp1,
        tp2,
        tp2Label: target?.label ?? null,
        riskPerUnit: risk,
        rewardPerUnit: reward,
        rr,
        minRR: this.config.minRR,
        invalidation: stop,
        atr,
        checks,
      },
      reasons,
      session: inSession,
      bias: { ...this.bias },
    };
  }

  private addLevel(kind: LevelKind, side: 'high' | 'low', price: number, label: string, originTime: number, availableIndex: number, availableTime: number) {
    this.levels.push({ id: this.id('lv'), kind, side, price, label, originTime, availableTime, availableIndex, status: 'untested', statusTime: null, breach: null });
  }

  private resolveLevel(l: LiquidityLevel, status: LevelStatus, time: number) {
    l.status = status;
    l.statusTime = time;
  }

  private detectSwing(i: number, atr: number | null) {
    const L = this.config.swingLength;
    const p = i - L;
    if (p - L < 0) return;
    const cs = this.candles;
    const pc = cs[p];
    let isHigh = true;
    let isLow = true;
    for (let k = p - L; k <= p + L; k++) {
      if (k === p) continue;
      if (k < p) {
        if (cs[k].high >= pc.high) isHigh = false;
        if (cs[k].low <= pc.low) isLow = false;
      } else {
        if (cs[k].high > pc.high) isHigh = false;
        if (cs[k].low < pc.low) isLow = false;
      }
    }
    const confirmedTime = cs[i].time;
    for (const side of ['high', 'low'] as const) {
      if (side === 'high' ? !isHigh : !isLow) continue;
      const price = side === 'high' ? pc.high : pc.low;
      const sp: SwingPoint = { index: p, time: pc.time, price, side, confirmedIndex: i, confirmedTime, broken: false };
      this.swings.push(sp);
      if (this.swings.length > 2000) this.swings.splice(0, this.swings.length - 2000);
      if (this.config.includeEqualLevels && atr !== null) {
        const tol = this.config.equalLevelAtrTol * atr;
        const kind: LevelKind = side === 'high' ? 'SWING_HIGH' : 'SWING_LOW';
        const match = this.levels.find((l) => l.status === 'untested' && (l.kind === kind) && Math.abs(l.price - price) <= tol);
        if (match) {
          this.resolveLevel(match, 'merged', confirmedTime);
          const eqPrice = side === 'high' ? Math.max(match.price, price) : Math.min(match.price, price);
          this.addLevel(side === 'high' ? 'EQH' : 'EQL', side, eqPrice, side === 'high' ? 'EQH' : 'EQL', pc.time, i, confirmedTime);
          continue;
        }
      }
      if (this.config.includeSwingLevels) {
        this.addLevel(side === 'high' ? 'SWING_HIGH' : 'SWING_LOW', side, price, side === 'high' ? 'Swing H' : 'Swing L', pc.time, i, confirmedTime);
      }
    }
  }

  /** Most recent confirmed swing (known as of bar i). */
  private lastSwing(side: 'high' | 'low', i: number): SwingPoint | null {
    for (let k = this.swings.length - 1; k >= 0; k--) {
      const s = this.swings[k];
      if (s.side === side && s.confirmedIndex <= i - 1) return s;
    }
    return null;
  }

  private swingRefFor(cand: Candidate, i: number): SwingPoint | null {
    const side = cand.direction === 'long' ? 'high' : 'low';
    let best: SwingPoint | null = null;
    for (let k = this.swings.length - 1; k >= 0; k--) {
      const s = this.swings[k];
      if (s.side !== side || s.confirmedIndex > i - 1 || s.index > cand.sweep.startIndex) continue;
      if (!best || s.index > best.index) best = s;
    }
    return best;
  }

  private detectDisplacement(i: number): DisplacementRecord | null {
    const atr = this.atrValues[i];
    if (atr === null || atr <= 0) return null;
    const cs = this.candles;
    for (let n = 1; n <= this.config.displacementBars; n++) {
      const s = i - n + 1;
      if (s < 0) break;
      const first = cs[s];
      const last = cs[i];
      const dirUp = last.close > first.open;
      // All candles must agree with the direction.
      let agree = true;
      let bodySum = 0;
      let hi = -Infinity;
      let lo = Infinity;
      for (let k = s; k <= i; k++) {
        const ck = cs[k];
        if (dirUp ? ck.close <= ck.open : ck.close >= ck.open) agree = false;
        bodySum += Math.abs(ck.close - ck.open);
        hi = Math.max(hi, ck.high);
        lo = Math.min(lo, ck.low);
      }
      if (!agree) continue;
      const net = Math.abs(last.close - first.open);
      const range = hi - lo;
      const ratio = range > 0 ? bodySum / range : 0;
      if (net + EPS >= this.config.displacementAtrMult * atr && ratio + EPS >= this.config.displacementBodyRatio) {
        return { id: this.id('dp'), direction: dirUp ? 'long' : 'short', startTime: first.time, time: last.time, body: net, atr, ratio, bars: n };
      }
    }
    return null;
  }

  private indexOfTime(t: number): number {
    // Candles are evenly spaced except for gaps; binary search.
    let lo = 0;
    let hi = this.candles.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = this.candles[mid].time;
      if (v === t) return mid;
      if (v < t) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  private updateFvgs(i: number, atr: number) {
    const c = this.candles[i];
    // Lifecycle of existing gaps.
    for (const g of this.fvgs) {
      if (g.status === 'mitigated' || g.status === 'invalidated' || g.createdTime >= c.time) continue;
      const bull = g.direction === 'bullish';
      const invalid = bull ? c.close < g.bottom : c.close > g.top;
      const full = this.config.fvgMitigation === 'wick' ? (bull ? c.low <= g.bottom : c.high >= g.top) : bull ? c.close <= g.bottom : c.close >= g.top;
      const partial = bull ? c.low < g.top : c.high > g.bottom;
      if (invalid) {
        g.status = 'invalidated';
        g.statusTime = c.time;
      } else if (full) {
        g.status = 'mitigated';
        g.statusTime = c.time;
      } else if (partial && g.status === 'active') {
        g.status = 'partial';
        g.statusTime = c.time;
      }
    }
    if (!this.config.fvgEnabled || i < 2) return;
    const a = this.candles[i - 2];
    const minSize = this.config.fvgMinAtr * atr;
    if (c.low > a.high && c.low - a.high >= minSize) {
      this.fvgs.push({ id: this.id('fvg'), direction: 'bullish', top: c.low, bottom: a.high, time: this.candles[i - 1].time, createdTime: c.time, status: 'active', statusTime: null });
    } else if (c.high < a.low && a.low - c.high >= minSize) {
      this.fvgs.push({ id: this.id('fvg'), direction: 'bearish', top: a.low, bottom: c.high, time: this.candles[i - 1].time, createdTime: c.time, status: 'active', statusTime: null });
    }
    const max = Math.max(this.config.maxFvgs, 0);
    if (this.fvgs.length > max * 3) this.fvgs.splice(0, this.fvgs.length - max * 3);
  }

  private updateOrderBlocks(c: Candle) {
    for (const ob of this.obs) {
      if (ob.status === 'invalidated' || ob.createdTime >= c.time) continue;
      const bull = ob.direction === 'bullish';
      if (bull ? c.close < ob.low : c.close > ob.high) {
        ob.status = 'invalidated';
        ob.statusTime = c.time;
      } else if (ob.status === 'active' && (bull ? c.low <= ob.high : c.high >= ob.low)) {
        ob.status = 'tested';
        ob.statusTime = c.time;
      }
    }
  }

  /** OB for a structural BOS: requires a qualifying displacement inside the breaking leg. */
  private maybeStructureOrderBlock(b: StructureBreak, swing: SwingPoint, i: number) {
    if (!this.config.obEnabled) return;
    const long = b.direction === 'long';
    // Leg start: the extreme opposite price between the broken swing and the BOS candle.
    let legStart = swing.index;
    for (let k = swing.index; k <= i; k++) {
      const ck = this.candles[k];
      const cur = this.candles[legStart];
      if (long ? ck.low < cur.low : ck.high > cur.high) legStart = k;
    }
    this.orderBlockFromLeg(legStart, i, b.direction, 'structure');
  }

  private setupOrderBlock(cand: Candidate, i: number): OrderBlock | null {
    return this.orderBlockFromLeg(Math.min(cand.extremeIndex, cand.sweep.startIndex), i, cand.direction, 'setup');
  }

  private orderBlockFromLeg(legStart: number, end: number, dir: Direction, source: OrderBlock['source']): OrderBlock | null {
    const long = dir === 'long';
    // First qualifying displacement candle inside the leg.
    let dispIndex = -1;
    for (const d of this.displacements) {
      const di = this.indexOfTime(d.startTime);
      if (d.direction === dir && di >= legStart && di <= end) {
        dispIndex = di;
        break;
      }
    }
    if (dispIndex < 0) return null;
    // Last opposite-coloured candle before the displacement leg (searching back to the leg start, max 20 bars).
    for (let k = dispIndex - 1; k >= Math.max(0, legStart - 1, dispIndex - 20); k--) {
      const ck = this.candles[k];
      const opposite = long ? ck.close < ck.open : ck.close > ck.open;
      if (!opposite) continue;
      const existing = this.obs.find((o) => o.time === ck.time && o.direction === (long ? 'bullish' : 'bearish'));
      if (existing) return existing;
      const ob: OrderBlock = {
        id: this.id('ob'),
        direction: long ? 'bullish' : 'bearish',
        high: ck.high,
        low: ck.low,
        mid: (ck.high + ck.low) / 2,
        time: ck.time,
        createdTime: this.candles[end].time,
        status: 'active',
        statusTime: null,
        source,
      };
      this.obs.push(ob);
      const max = Math.max(this.config.maxOrderBlocks, 0);
      if (this.obs.length > max * 3) this.obs.splice(0, this.obs.length - max * 3);
      return ob;
    }
    return null;
  }

  private pushCapped<T>(arr: T[], v: T) {
    arr.push(v);
    if (arr.length > this.cap) arr.splice(0, arr.length - this.cap);
  }

  private cleanup() {
    // Move resolved levels out of the hot list (kept briefly for drawing).
    const keep: LiquidityLevel[] = [];
    for (const l of this.levels) {
      if (l.status === 'untested' || l.status === 'breached') keep.push(l);
      else this.resolvedLevels.push(l);
    }
    this.levels = keep;
    if (this.resolvedLevels.length > this.cap) this.resolvedLevels.splice(0, this.resolvedLevels.length - this.cap);
    // Bound the active list too (oldest swing levels first) to keep the engine fast.
    if (this.levels.length > 300) {
      const removable = this.levels.filter((l) => l.kind === 'SWING_HIGH' || l.kind === 'SWING_LOW').slice(0, this.levels.length - 300);
      const ids = new Set(removable.map((l) => l.id));
      this.levels = this.levels.filter((l) => !ids.has(l.id));
    }
  }

  snapshot(): EngineSnapshot {
    const last = this.candles[this.candles.length - 1] ?? null;
    const price = last?.close ?? null;
    const active = this.levels.filter((l) => l.status === 'untested');
    const above = price === null ? [] : active.filter((l) => l.price > price).sort((a, b) => a.price - b.price);
    const below = price === null ? [] : active.filter((l) => l.price < price).sort((a, b) => b.price - a.price);
    const maxF = this.config.maxFvgs;
    const maxOb = this.config.maxOrderBlocks;
    return {
      symbol: this.symbol,
      timeframe: this.timeframe,
      configHash: this.hash,
      barCount: this.candles.length,
      lastTime: last?.time ?? null,
      state: this.state,
      stateReason: this.stateReason,
      atr: this.atrValues[this.atrValues.length - 1] ?? null,
      bias: { ...this.bias },
      sessions: {
        active: last ? activeSessions(this.windows, last.time) : [],
        developing: [...this.sessions.developing.values()].map((b) => ({ ...b })),
        completed: this.completedRanges.slice(-30),
        day: this.sessions.day ? { ...this.sessions.day } : null,
        previousDay: this.previousDay,
      },
      levels: [...this.levels.map(cloneLevel), ...this.resolvedLevels.slice(-60).map(cloneLevel)],
      nearestAbove: above[0] ? cloneLevel(above[0]) : null,
      nearestBelow: below[0] ? cloneLevel(below[0]) : null,
      swings: this.swings.slice(-80).map((s) => ({ ...s })),
      sweeps: this.sweeps.slice(-60).map((s) => ({ ...s })),
      structureBreaks: this.bosList.slice(-60),
      displacements: this.displacements.slice(-60),
      fvgs: this.fvgs.slice(-maxF).map((f) => ({ ...f })),
      orderBlocks: this.obs.slice(-maxOb).map((o) => ({ ...o })),
      candidate: this.candidate ? { ...this.candidate, sweep: { ...this.candidate.sweep } } : null,
      signals: this.signals.slice(-100),
      lastSignal: this.signals[this.signals.length - 1] ?? null,
      trade: this.trade ? { ...this.trade } : null,
      trades: this.trades.slice(-200).map((t) => ({ ...t })),
    };
  }

  /** Full (uncapped) list of signals and trades — used by backtests. */
  results() {
    return { signals: this.signals, trades: this.trades };
  }
}

function cloneLevel(l: LiquidityLevel): LiquidityLevel {
  return { ...l, breach: l.breach ? { ...l.breach } : null };
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  const d = abs >= 1000 ? 2 : abs >= 10 ? 3 : abs >= 1 ? 4 : 5;
  return n.toFixed(d);
}

export interface PlanInput {
  direction: Direction;
  entry: number;
  extreme: number; // recorded sweep wick extreme
  atr: number;
  slAtrBuffer: number;
  tp1R: number;
  /** Candidate opposing liquidity (untested). Only those beyond entry qualify. */
  targets: { price: number; label: string }[];
}

/**
 * Pure stop / target / R:R computation (ELF v1.1):
 *   stop  = sweep extreme ∓ slAtrBuffer × ATR
 *   TP1   = entry ± tp1R × risk
 *   TP2   = NEAREST qualifying opposing liquidity beyond entry (never invented)
 *   R:R   = |entry − TP2| ÷ |entry − stop|
 */
export function computePlanLevels(p: PlanInput) {
  const long = p.direction === 'long';
  const stop = long ? p.extreme - p.slAtrBuffer * p.atr : p.extreme + p.slAtrBuffer * p.atr;
  const risk = long ? p.entry - stop : stop - p.entry;
  const tp1 = long ? p.entry + p.tp1R * Math.max(risk, 0) : p.entry - p.tp1R * Math.max(risk, 0);
  const beyond = p.targets.filter((t) => (long ? t.price > p.entry : t.price < p.entry)).sort((a, b) => (long ? a.price - b.price : b.price - a.price));
  const target = beyond[0] ?? null;
  const reward = target ? Math.abs(target.price - p.entry) : null;
  const rr = reward !== null && risk > EPS ? reward / risk : null;
  return { entry: p.entry, stop, risk, tp1, target, reward, rr };
}

/** Convenience: run the engine over a candle array (closed candles only). */
export function runEngine(candles: Candle[], config: ElfConfig, opts: EngineOptions) {
  const engine = new ElfEngine(config, opts);
  const events: EngineEvent[] = [];
  for (const c of candles) events.push(...engine.update(c));
  return { engine, events, snapshot: engine.snapshot() };
}
