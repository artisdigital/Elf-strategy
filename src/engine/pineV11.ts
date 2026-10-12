// ELF v1.1 — faithful TypeScript port of "ELF — Emerald Liquidity Flow · v1.1 · Pine Script v5".
//
// Section numbers in comments refer to the Pine source. Every bar is a CLOSED candle
// (Pine: barstate.isconfirmed). Deliberate, documented differences from the Pine script
// (see docs/ELF_RULES.md "Pine parity"):
//   1. HTF bias with no completed EMA yet is "unknown" → setups are FILTERED (Pine treats na as short bias).
//   2. dispBars > 1 sums bodies over at most N consecutive candles (Pine's running sum is unbounded).
//   3. The manual news blackout blocks new sweeps (Pine) AND new entries (app specification).
//   4. At the daily cycle reset an open theoretical trade is closed at that candle's open (Pine just stops drawing),
//      so backtests have a defined result.
//   5. Trade outcomes use the shared outcome tracker: stop-first on ambiguous candles (same priority as Pine),
//      plus a fill at the open when price gaps through the stop.

import type { Candle, Timeframe } from '../shared/types.js';
import { tfSeconds, TIMEFRAME_SECONDS } from '../shared/types.js';
import { Atr, Ema } from './indicators.js';
import { configHash, type ElfConfig, type SessionName } from './config.js';
import { SessionTracker, SESSION_LABELS, providerDayBoundary, type RangeBox, sessionWindows, activeSessions } from './sessions.js';
import { newTrade, stepTrade, closeTradeManually, type Direction, type TradeState } from './trade.js';
import {
  computePlanLevels,
  type Bias,
  type Candidate,
  type DisplacementRecord,
  type ElfState,
  type EngineEvent,
  type EngineEventType,
  type EngineOptions,
  type EngineSnapshot,
  type Fvg,
  type LevelKind,
  type LiquidityLevel,
  type OrderBlock,
  type PlanCheck,
  type Signal,
  type StructureBreak,
  type SweepRecord,
  type SwingPoint,
} from './engine.js';

const EPS = 1e-9;

interface Lvl {
  id: string;
  kind: LevelKind;
  side: 'high' | 'low';
  price: number;
  label: string;
  originTime: number;
  availableTime: number;
  availableIndex: number;
}

interface Pending {
  id: string;
  dir: Direction;
  level: Lvl;
  ext: number;
  bar: number;
  sweep: SweepRecord;
}

interface Lock {
  signal: Signal;
  dir: Direction;
  sl: number;
  tp1: number;
  tp2: number | null;
  tp1Hit: boolean;
}

const fmt = (n: number) => {
  const a = Math.abs(n);
  return n.toFixed(a >= 1000 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : 5);
};

export class ElfV11Engine {
  readonly config: ElfConfig;
  readonly symbol: string;
  readonly timeframe: Timeframe;
  private readonly tfSec: number;
  private readonly opts: EngineOptions;
  private readonly hash: string;
  private readonly cap: number;

  private candles: Candle[] = [];
  private atr: Atr;
  private lastAtr: number | null = null;
  private sessions: SessionTracker;
  private windows: ReturnType<typeof sessionWindows>;
  private seq = 0;

  // §3 swings
  private swH: SwingPoint | null = null;
  private swL: SwingPoint | null = null;
  private prevSwHPrice: number | null = null; // swH[1]
  private prevSwLPrice: number | null = null;
  private prevPH: number | null = null;
  private prevPL: number | null = null;
  private swings: SwingPoint[] = [];
  // §3 displacement runs
  private bullBodies: number[] = [];
  private bearBodies: number[] = [];
  // §4 session levels (latest completed of each), §3 PDH/PDL, §5 EQ
  private lv = new Map<string, Lvl>(); // key: lonH, lonL, nyH, nyL, sydH, sydL, pdh, pdl, swH, swL
  private eqHs: Lvl[] = [];
  private eqLs: Lvl[] = [];
  private retired: LiquidityLevel[] = [];
  private completedRanges: RangeBox[] = [];
  private previousDay: RangeBox | null = null;
  private prevIn = new Set<SessionName>();
  // §6 FVG, §7 OB
  private fvgs: Fvg[] = [];
  private obs: OrderBlock[] = [];
  // §9 state machine
  private st: 0 | 1 | 2 = 0;
  private pending: Pending | null = null;
  private trade: TradeState | null = null;
  private lock: Lock | null = null;
  private trades: TradeState[] = [];
  private signals: Signal[] = [];
  private sweeps: SweepRecord[] = [];
  private bosList: StructureBreak[] = [];
  private displacements: DisplacementRecord[] = [];
  private state: ElfState = 'IDLE';
  private stateReason = 'Warming up indicators';
  // OPTIONAL hard rules
  private sessionEntries = new Map<string, number>();
  private dayR = new Map<string, number>();
  // HTF
  private htf: Candle[] = [];
  private htfPtr = 0;
  private htfEma: Ema;
  private bias: Bias;

  constructor(config: ElfConfig, opts: EngineOptions) {
    this.config = config;
    this.opts = opts;
    this.symbol = opts.symbol;
    this.timeframe = opts.timeframe;
    this.tfSec = tfSeconds(opts.timeframe);
    this.cap = opts.historyCap ?? 400;
    this.hash = configHash(config);
    this.atr = new Atr(config.atrPeriod);
    this.sessions = new SessionTracker(config, providerDayBoundary(opts.provider));
    this.windows = sessionWindows(config);
    this.htfEma = new Ema(config.htfEmaLength);
    this.bias = { value: 'unknown', ema: null, close: null, htfTime: null, timeframe: config.htfTimeframe };
    if (opts.htfCandles) this.setHtfCandles(opts.htfCandles);
  }

  get barCount() {
    return this.candles.length;
  }

  setHtfCandles(htf: Candle[]) {
    this.htf = [...htf].sort((a, b) => a.time - b.time);
    this.htfPtr = 0;
    this.htfEma = new Ema(this.config.htfEmaLength);
    this.bias = { value: 'unknown', ema: null, close: null, htfTime: null, timeframe: this.config.htfTimeframe };
    const last = this.candles[this.candles.length - 1];
    if (last) this.advanceHtf(last.time + this.tfSec);
  }

  /** Pine: request.security(biasTF, close / ema, lookahead_off) — completed HTF candles only. */
  private advanceHtf(asOfClose: number) {
    const htfSec = TIMEFRAME_SECONDS[this.config.htfTimeframe];
    while (this.htfPtr < this.htf.length && this.htf[this.htfPtr].time + htfSec <= asOfClose) {
      const h = this.htf[this.htfPtr++];
      const ema = this.htfEma.update(h.close);
      this.bias = { value: ema === null ? 'unknown' : h.close > ema ? 'bullish' : 'bearish', ema, close: h.close, htfTime: h.time, timeframe: this.config.htfTimeframe };
    }
  }

  private id(p: string) {
    return `${p}${++this.seq}`;
  }

  private setLevel(key: string, kind: LevelKind, side: 'high' | 'low', price: number, label: string, originTime: number, i: number, t: number) {
    const old = this.lv.get(key);
    if (old) this.retire(old, t);
    this.lv.set(key, { id: this.id('lv'), kind, side, price, label, originTime, availableTime: t, availableIndex: i });
  }

  private retire(l: Lvl, t: number) {
    this.retired.push({ ...l, status: 'expired', statusTime: t, breach: null });
    if (this.retired.length > 60) this.retired.shift();
  }

  /** All current liquidity (Pine nearestAbove / nearestBelow inputs). */
  private levels(): Lvl[] {
    return [...this.lv.values(), ...this.eqHs, ...this.eqLs];
  }

  /** Pine nearestAbove(): session highs, PDH, latest swing high, EQHs strictly above close. */
  private nearest(side: 'high' | 'low', close: number): Lvl | null {
    let best: Lvl | null = null;
    for (const l of this.levels()) {
      if (l.side !== side) continue;
      if (side === 'high' ? l.price > close && (!best || l.price < best.price) : l.price < close && (!best || l.price > best.price)) best = l;
    }
    return best;
  }

  update(c: Candle): EngineEvent[] {
    const prev = this.candles[this.candles.length - 1];
    if (prev && c.time <= prev.time) throw new Error(`Candles must be strictly increasing in time (${c.time} after ${prev.time})`);
    if (![c.open, c.high, c.low, c.close].every(Number.isFinite) || c.high < c.low) throw new Error(`Invalid candle at ${c.time}`);
    const i = this.candles.length;
    this.candles.push(c);
    const closeTime = c.time + this.tfSec;
    const atr = this.atr.update(c);
    this.lastAtr = atr;
    this.advanceHtf(closeTime);
    const events: EngineEvent[] = [];
    const ev = (type: EngineEventType, ref: string, message: string, extra: Partial<EngineEvent> = {}) => {
      events.push({ type, key: `${this.symbol}|${this.timeframe}|${type}|${ref}`, time: c.time, closeTime, index: i, message, ...extra });
    };
    const cfg = this.config;

    // ── §3 swings (ta.pivothigh/low confirmed swingLength bars later) ───────────────
    this.prevSwHPrice = this.swH?.price ?? null; // swH[1]
    this.prevSwLPrice = this.swL?.price ?? null;
    const L = cfg.swingLength;
    const p = i - L;
    let ph: number | null = null;
    let pl: number | null = null;
    if (p - L >= 0) {
      const pc = this.candles[p];
      let isH = true;
      let isL = true;
      for (let k = p - L; k <= p + L; k++) {
        if (k === p) continue;
        const ck = this.candles[k];
        if (k < p ? ck.high >= pc.high : ck.high > pc.high) isH = false;
        if (k < p ? ck.low <= pc.low : ck.low < pc.low) isL = false;
      }
      if (isH) ph = pc.high;
      if (isL) pl = pc.low;
      for (const side of ['high', 'low'] as const) {
        const v = side === 'high' ? ph : pl;
        if (v === null) continue;
        const sp: SwingPoint = { index: p, time: pc.time, price: v, side, confirmedIndex: i, confirmedTime: c.time, broken: false };
        this.swings.push(sp);
        if (this.swings.length > 500) this.swings.shift();
        if (side === 'high') {
          this.swH = sp;
          this.setLevel('swH', 'SWING_HIGH', 'high', v, 'Swing H', pc.time, i, c.time);
        } else {
          this.swL = sp;
          this.setLevel('swL', 'SWING_LOW', 'low', v, 'Swing L', pc.time, i, c.time);
        }
      }
    }

    // ── §5 equal highs / lows: consecutive pivots within tolerance → average ─────────
    if (atr !== null) {
      if (ph !== null) {
        if (this.prevPH !== null && Math.abs(ph - this.prevPH) <= cfg.equalLevelAtrTol * atr + EPS) {
          this.eqHs.push({ id: this.id('lv'), kind: 'EQH', side: 'high', price: (ph + this.prevPH) / 2, label: 'EQH', originTime: this.candles[p].time, availableTime: c.time, availableIndex: i });
          if (this.eqHs.length > 8) this.retire(this.eqHs.shift()!, c.time);
        }
        this.prevPH = ph;
      }
      if (pl !== null) {
        if (this.prevPL !== null && Math.abs(pl - this.prevPL) <= cfg.equalLevelAtrTol * atr + EPS) {
          this.eqLs.push({ id: this.id('lv'), kind: 'EQL', side: 'low', price: (pl + this.prevPL) / 2, label: 'EQL', originTime: this.candles[p].time, availableTime: c.time, availableIndex: i });
          if (this.eqLs.length > 8) this.retire(this.eqLs.shift()!, c.time);
        }
        this.prevPL = pl;
      }
    }

    // ── §3 BOS: close beyond swing[1] with prior close not beyond (a cross) ──────────
    const bosUp = this.prevSwHPrice !== null && c.close > this.prevSwHPrice && prev !== undefined && prev.close <= this.prevSwHPrice;
    const bosDn = this.prevSwLPrice !== null && c.close < this.prevSwLPrice && prev !== undefined && prev.close >= this.prevSwLPrice;
    if (bosUp) {
      const b: StructureBreak = { id: this.id('bos'), direction: 'long', price: this.prevSwHPrice!, swingTime: this.swH?.price === this.prevSwHPrice ? this.swH!.time : c.time, time: c.time, close: c.close };
      this.push(this.bosList, b);
      ev('bos', `long|${b.swingTime}|${c.time}`, `Bullish BOS: close ${fmt(c.close)} above swing high ${fmt(b.price)}`, { direction: 'long', data: { price: b.price } });
    }
    if (bosDn) {
      const b: StructureBreak = { id: this.id('bos'), direction: 'short', price: this.prevSwLPrice!, swingTime: this.swL?.price === this.prevSwLPrice ? this.swL!.time : c.time, time: c.time, close: c.close };
      this.push(this.bosList, b);
      ev('bos', `short|${b.swingTime}|${c.time}`, `Bearish BOS: close ${fmt(c.close)} below swing low ${fmt(b.price)}`, { direction: 'short', data: { price: b.price } });
    }

    // ── §3 displacement ────────────────────────────────────────────────────────────
    const body = Math.abs(c.close - c.open);
    const rng = c.high - c.low;
    const ratioOK = cfg.displacementBodyRatio <= 0 || rng === 0 || body / rng + EPS >= cfg.displacementBodyRatio;
    const nMax = Math.max(1, cfg.displacementBars);
    this.bullBodies = c.close > c.open ? [...this.bullBodies, body].slice(-nMax) : [];
    this.bearBodies = c.close < c.open ? [...this.bearBodies, body].slice(-nMax) : [];
    const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
    const need = atr === null ? Infinity : cfg.displacementAtrMult * atr;
    const trigBull = c.close > c.open && (nMax === 1 ? body : sum(this.bullBodies)) + EPS >= need && ratioOK;
    const trigBear = c.close < c.open && (nMax === 1 ? body : sum(this.bearBodies)) + EPS >= need && ratioOK;
    let disp: DisplacementRecord | null = null;
    if ((trigBull || trigBear) && atr !== null) {
      const runs = trigBull ? this.bullBodies : this.bearBodies;
      const n = nMax === 1 ? 1 : runs.length;
      disp = { id: this.id('dp'), direction: trigBull ? 'long' : 'short', startTime: this.candles[i - n + 1].time, time: c.time, body: nMax === 1 ? body : sum(runs), atr, ratio: rng ? body / rng : 0, bars: n };
      this.push(this.displacements, disp);
      ev('displacement', `${disp.direction}|${c.time}`, `${trigBull ? 'Bullish' : 'Bearish'} displacement: ${(disp.body / atr).toFixed(2)}× ATR`, { direction: disp.direction });
    }

    // ── §4 sessions & PDH/PDL ──────────────────────────────────────────────────────
    const su = this.sessions.update(c);
    for (const box of su.completed) {
      this.push(this.completedRanges, box);
      const k = box.name === 'london' ? 'lon' : box.name === 'newYork' ? 'ny' : 'syd';
      const lab = SESSION_LABELS[box.name as SessionName];
      this.setLevel(k + 'H', 'SESSION_HIGH', 'high', box.high, `${lab} H`, box.highTime, i - 1, prev?.time ?? c.time);
      this.setLevel(k + 'L', 'SESSION_LOW', 'low', box.low, `${lab} L`, box.lowTime, i - 1, prev?.time ?? c.time);
    }
    if (su.dayCompleted) {
      this.previousDay = su.dayCompleted;
      this.setLevel('pdh', 'PDH', 'high', su.dayCompleted.high, 'PDH', su.dayCompleted.highTime, i - 1, prev?.time ?? c.time);
      this.setLevel('pdl', 'PDL', 'low', su.dayCompleted.low, 'PDL', su.dayCompleted.lowTime, i - 1, prev?.time ?? c.time);
    }
    const inSession = su.inSession;
    const order: SessionName[] = ['london', 'newYork', 'asia'];
    const firstEnabled = order.find((n) => cfg.sessions[n].enabled);
    const cycleNew = cfg.dailyCycleReset && !!firstEnabled && inSession.includes(firstEnabled) && !this.prevIn.has(firstEnabled);
    this.prevIn = new Set(inSession);
    const inWindow = inSession.length > 0;
    const sweepWindowOK = cfg.sessionGate === 'off' || cfg.sessionGate === 'entry' || inWindow;
    const entryWindowOK = cfg.sessionGate === 'off' || cfg.sessionGate === 'sweep' || inWindow;
    const blackout = cfg.newsBlackout && this.opts.applyNewsBlackout !== false;

    // ── §6 FVG ────────────────────────────────────────────────────────────────────
    this.updateFvgs(i);

    // §7 OB lifecycle
    for (const ob of this.obs) {
      if (ob.status === 'invalidated' || ob.createdTime >= c.time) continue;
      const bull = ob.direction === 'bullish';
      if (bull ? c.close < ob.low : c.close > ob.high) (ob.status = 'invalidated'), (ob.statusTime = c.time);
      else if (ob.status === 'active' && (bull ? c.low <= ob.high : c.high >= ob.low)) (ob.status = 'tested'), (ob.statusTime = c.time);
    }

    if (atr === null) {
      this.state = 'IDLE';
      this.stateReason = `Warming up ATR(${cfg.atrPeriod}) — ${i + 1}/${cfg.atrPeriod} bars`;
      return events;
    }

    // ── §8 sweep detection (nearest level above / below the close) ─────────────────
    const upLvl = this.nearest('high', c.close);
    const dnLvl = this.nearest('low', c.close);
    const thresh = cfg.sweepAtrMult * atr;
    const canDetect = sweepWindowOK && !blackout;
    const sweepUp = canDetect && upLvl !== null && c.high + EPS >= upLvl.price + thresh;
    const sweepDn = canDetect && dnLvl !== null && c.low <= dnLvl.price - thresh + EPS;

    // ── §9 state machine ──────────────────────────────────────────────────────────
    let newSignal: Signal | null = null;
    let completedThisBar = false;
    let expiredReason: string | null = null;
    if (this.st === 0) {
      const hit = sweepUp ? { dir: 'short' as Direction, l: upLvl!, ext: c.high } : sweepDn ? { dir: 'long' as Direction, l: dnLvl!, ext: c.low } : null;
      if (hit) {
        const pen = hit.dir === 'short' ? c.high - hit.l.price : hit.l.price - c.low;
        const rec: SweepRecord = {
          id: this.id('sw'), direction: hit.dir, levelIds: [hit.l.id], levelLabel: hit.l.label, levelPrice: hit.l.price, extreme: hit.ext, penetration: pen, threshold: thresh,
          startTime: c.time, startIndex: i, reclaimed: true, reclaimTime: c.time, eligible: true, note: '',
        };
        this.push(this.sweeps, rec);
        this.pending = { id: rec.id, dir: hit.dir, level: hit.l, ext: hit.ext, bar: i, sweep: rec };
        this.st = 1;
        ev('sweep_preliminary', `${hit.l.id}|${c.time}`, `[PRELIMINARY — not a trade] ${hit.dir === 'long' ? 'BULLISH sweep BELOW' : 'BEARISH sweep ABOVE'} ${hit.l.label} ${fmt(hit.l.price)} — penetration ${(pen / atr).toFixed(2)}× ATR. Needs close back + BOS + displacement.`, {
          direction: hit.dir,
          data: { level: hit.l.price, extreme: hit.ext, penetration: pen, threshold: thresh, levels: hit.l.label, eligible: true, reclaimed: true },
        });
      }
    } else if (this.st === 1 && this.pending) {
      const pd = this.pending;
      if (cycleNew || i - pd.bar > cfg.maxConfirmBars) {
        expiredReason = cycleNew ? 'Daily cycle reset (first session open)' : `Confirmation expired (no BOS + displacement within ${cfg.maxConfirmBars} bars)`;
        ev('expired', pd.id, `Setup expired — ${expiredReason}`, { direction: pd.dir, data: { reason: expiredReason } });
        this.st = 0;
        this.pending = null;
      } else {
        const short = pd.dir === 'short';
        const conf = short ? c.close < pd.level.price && bosDn && trigBear : c.close > pd.level.price && bosUp && trigBull;
        if (conf && entryWindowOK) {
          newSignal = this.confirm(pd, c, i, atr, inSession, blackout, ev);
          this.pending = null;
          this.st = this.trade || this.lock ? 2 : 0;
        } else if (conf) {
          ev('invalidated', `${pd.id}|outside|${c.time}`, 'Confirmation candle outside an enabled window — no entry issued (v1.1); still waiting', { direction: pd.dir, data: { reason: 'Outside the permitted session' } });
        }
      }
    } else if (this.st === 2) {
      if (cycleNew) {
        if (this.trade) {
          const t = this.trade;
          closeTradeManually(t, c.open, c.time, 'manual');
          t.outcome = 'expired';
          ev('trade_expired', t.id, `${t.direction.toUpperCase()} closed at ${fmt(c.open)} — daily cycle reset`, { direction: t.direction, data: { tradeId: t.id, resultR: t.resultR } });
          this.recordR(t);
          this.trade = null;
          completedThisBar = true;
        }
        if (this.lock) this.lock.signal.lockedOutcome = 'cycle';
        this.lock = null;
        this.st = 0;
      } else if (this.trade) {
        const t = this.trade;
        for (const se of stepTrade(t, c, this.opts.intrabar?.(c), cfg.tradeExpiryBars)) {
          const map = { tp1: 'tp1', tp2: 'tp2', sl: 'sl', breakeven: 'breakeven', expired: 'trade_expired' } as const;
          ev(map[se.type], t.id, `${t.direction.toUpperCase()} ${se.type === 'tp1' ? 'TP1 → consider moving SL to breakeven' : se.type.toUpperCase()} at ${fmt(se.price)}${se.ambiguous ? ' (ambiguous candle — stop assumed first)' : ''}`, {
            direction: t.direction,
            data: { tradeId: t.id, price: se.price, ambiguous: se.ambiguous, resultR: t.resultR, entry: t.entry, stop: t.initialStop, tp1: t.tp1, tp2: t.tp2 },
          });
        }
        if (t.status === 'closed') {
          this.recordR(t);
          this.trade = null;
          this.st = 0;
          completedThisBar = true;
        }
      } else if (this.lock) {
        // v1.1: a filtered setup is still monitored (SL first, then TP2, then TP1) and blocks new sweeps.
        const k = this.lock;
        const long = k.dir === 'long';
        if (long ? c.low <= k.sl : c.high >= k.sl) k.signal.lockedOutcome = 'sl';
        else if (k.tp2 !== null && (long ? c.high >= k.tp2 : c.low <= k.tp2)) k.signal.lockedOutcome = 'tp2';
        else if (!k.tp1Hit && (long ? c.high >= k.tp1 : c.low <= k.tp1)) k.tp1Hit = true;
        if (k.signal.lockedOutcome) {
          this.lock = null;
          this.st = 0;
        }
      } else this.st = 0;
    }

    // ── state for the UI ──────────────────────────────────────────────────────────
    if (newSignal) {
      this.state = newSignal.status;
      this.stateReason = newSignal.status === 'ENTRY_READY' ? `${newSignal.direction.toUpperCase()} plan ready — R:R ${newSignal.plan.rr!.toFixed(2)} · Q${newSignal.quality}` : newSignal.reasons.join('; ');
    } else if (expiredReason) {
      this.state = 'FILTERED';
      this.stateReason = expiredReason;
    } else if (completedThisBar) {
      const t = this.trades[this.trades.length - 1];
      this.state = 'COMPLETED';
      this.stateReason = `Trade closed: ${t.outcome?.toUpperCase()} (${t.resultR?.toFixed(2)}R)`;
    } else if (this.st === 2 && this.trade) {
      this.state = 'MANAGING';
      this.stateReason = `${this.trade.direction.toUpperCase()} from ${fmt(this.trade.entry)}${this.trade.tp1Hit ? ' — TP1 reached' : ''}`;
    } else if (this.st === 2 && this.lock) {
      this.state = 'FILTERED';
      this.stateReason = `Filtered ${this.lock.dir} setup monitored until SL / TP2 or the next cycle (v1.1: one setup per sweep) — ${this.lock.signal.reasons.join('; ')}`;
    } else if (this.st === 1 && this.pending) {
      const pd = this.pending;
      const ref = pd.dir === 'long' ? this.swH : this.swL;
      this.state = 'SWEPT';
      this.stateReason = `${pd.dir === 'long' ? 'Bullish' : 'Bearish'} sweep of ${pd.level.label} ${fmt(pd.level.price)} — waiting for one candle that closes ${pd.dir === 'long' ? 'above' : 'below'} it with BOS${ref ? ' (' + fmt(ref.price) + ')' : ''} + displacement (${i - pd.bar}/${cfg.maxConfirmBars} bars)`;
    } else {
      const n = this.levels().length;
      this.state = n ? 'BUILD' : 'IDLE';
      this.stateReason = n
        ? inWindow
          ? `${inSession.map((s) => SESSION_LABELS[s]).join(', ')} window — watching ${n} liquidity levels for a sweep`
          : `Outside session windows — ranges and levels are tracked; sweeps are only taken inside enabled windows`
        : 'No liquidity levels established yet';
    }
    return events;
  }

  private recordR(t: TradeState) {
    const day = this.dayKey(t.exitTime ?? t.entryTime);
    this.dayR.set(day, (this.dayR.get(day) ?? 0) + (t.resultR ?? 0));
  }

  private dayKey(t: number) {
    return new Date(t * 1000).toISOString().slice(0, 10);
  }

  private confirm(pd: Pending, c: Candle, i: number, atr: number, inSession: SessionName[], blackout: boolean, ev: (type: EngineEventType, ref: string, message: string, extra?: Partial<EngineEvent>) => void): Signal {
    const cfg = this.config;
    const long = pd.dir === 'long';
    ev('confirmed', pd.id, `[CONFIRMED closed candle] ${long ? 'BULLISH' : 'BEARISH'} — sweep ${fmt(pd.level.price)} → BOS + displacement ${(Math.abs(c.close - c.open) / atr).toFixed(1)}× ATR`, { direction: pd.dir });
    const opposing = this.levels().filter((l) => l.side === (long ? 'high' : 'low'));
    const lv = computePlanLevels({ direction: pd.dir, entry: c.close, extreme: pd.ext, atr, slAtrBuffer: cfg.slAtrBuffer, tp1R: cfg.tp1R, targets: opposing.map((l) => ({ price: l.price, label: l.label })) });
    const risk = Math.abs(lv.entry - lv.stop);
    const rr = lv.target && risk > EPS ? Math.abs(lv.target.price - lv.entry) / risk : null;
    const bok = !cfg.htfBiasEnabled || this.bias.value === (long ? 'bullish' : 'bearish');
    const hasTarget = lv.target !== null;
    const rok = hasTarget && rr !== null && rr + EPS >= cfg.minRR;
    const fvgConf = this.fvgs.some((g) => (g.status === 'active' || g.status === 'partial') && g.direction === (long ? 'bullish' : 'bearish') && c.low <= g.top && c.high >= g.bottom);
    const quality = (bok ? 20 : 0) + 25 + 20 + (rok ? 15 : 0) + (fvgConf ? 10 : 0) + (inSession.length ? 10 : 0);

    const checks: PlanCheck[] = [];
    const reasons: string[] = [];
    const check = (rule: string, pass: boolean, detail: string, reason?: string) => {
      checks.push({ rule, pass, detail });
      if (!pass && reason) reasons.push(reason);
    };
    check('Sweep', true, `${pd.level.label} ${fmt(pd.level.price)} swept, wick ${fmt(pd.ext)} (same-candle close back)`);
    check('Close back', true, `Confirmation close ${fmt(c.close)} ${long ? 'above' : 'below'} the swept level`);
    check('BOS (close)', true, `Close crossed swing ${fmt((long ? this.prevSwHPrice : this.prevSwLPrice) ?? NaN)}`);
    check('Displacement', true, `${(Math.abs(c.close - c.open) / atr).toFixed(2)}× ATR on the confirmation candle`);
    if (cfg.htfBiasEnabled) {
      const b = this.bias.value;
      check('HTF bias', bok, b === 'unknown' ? `No completed ${cfg.htfTimeframe} EMA(${cfg.htfEmaLength}) yet` : `${cfg.htfTimeframe} close ${fmt(this.bias.close!)} ${b === 'bullish' ? '>' : '<'} EMA ${fmt(this.bias.ema!)} (${b})`, b === 'unknown' ? 'Higher-timeframe bias unavailable' : 'Against higher-timeframe bias');
    } else checks.push({ rule: 'HTF bias', pass: true, detail: 'Filter disabled' });
    check('Session', true, inSession.length ? `In ${inSession.map((s) => SESSION_LABELS[s]).join(', ')}` : 'Session gate off');
    check('News blackout', !blackout, blackout ? 'Manual news blackout is ON' : 'Off', 'News blackout active');
    check('Risk > 0', risk > EPS, `Risk per unit ${fmt(risk)}`, 'Zero or negative risk');
    check('Target', hasTarget, lv.target ? `${lv.target.label} @ ${fmt(lv.target.price)}` : 'No liquidity beyond entry', 'No measurable target');
    if (hasTarget && risk > EPS) check('Min R:R', rok, `${rr!.toFixed(2)} vs required ${cfg.minRR.toFixed(1)}`, `Risk/reward ${rr!.toFixed(2)} below minimum ${cfg.minRR.toFixed(1)}`);
    const sesKey = inSession.length ? `${inSession[0]}:${new Date(c.time * 1000).toISOString().slice(0, 10)}` : 'none';
    if (cfg.maxTradesPerSession > 0) {
      const n = this.sessionEntries.get(sesKey) ?? 0;
      check('Session limit', n < cfg.maxTradesPerSession, `${n}/${cfg.maxTradesPerSession} entries this session`, `Session trade limit reached (${cfg.maxTradesPerSession})`);
    }
    if (cfg.dailyLossLimitR > 0) {
      const r = this.dayR.get(this.dayKey(c.time)) ?? 0;
      check('Daily loss limit', r > -cfg.dailyLossLimitR + EPS, `${r.toFixed(2)}R today (limit −${cfg.dailyLossLimitR}R)`, `Daily loss limit reached (−${cfg.dailyLossLimitR}R)`);
    }

    // §7 OB: last opposite candle 1–20 bars before the confirmation candle.
    let obId: string | null = null;
    if (cfg.obEnabled) {
      for (let j = 1; j <= 20 && i - j >= 0; j++) {
        const ck = this.candles[i - j];
        if (long ? ck.close < ck.open : ck.close > ck.open) {
          const hi = cfg.obRange === 'body' ? Math.max(ck.open, ck.close) : ck.high;
          const lo = cfg.obRange === 'body' ? Math.min(ck.open, ck.close) : ck.low;
          const ob: OrderBlock = { id: this.id('ob'), direction: long ? 'bullish' : 'bearish', high: hi, low: lo, mid: (hi + lo) / 2, time: ck.time, createdTime: c.time, status: 'active', statusTime: null, source: 'setup' };
          this.obs.push(ob);
          if (this.obs.length > Math.max(6, cfg.maxOrderBlocks)) this.obs.shift();
          obId = ob.id;
          break;
        }
      }
    }

    const tp2 = lv.target?.price ?? null;
    const signal: Signal = {
      id: pd.id,
      status: reasons.length === 0 ? 'ENTRY_READY' : 'FILTERED',
      direction: pd.dir,
      time: c.time,
      closeTime: c.time + this.tfSec,
      index: i,
      sweep: { ...pd.sweep },
      bos: { id: this.id('bos'), direction: pd.dir, price: (long ? this.prevSwHPrice : this.prevSwLPrice) ?? c.close, swingTime: (long ? this.swH?.time : this.swL?.time) ?? c.time, time: c.time, close: c.close },
      displacement: this.displacements[this.displacements.length - 1] ?? null,
      orderBlockId: obId,
      plan: { direction: pd.dir, entry: lv.entry, stop: lv.stop, tp1: lv.tp1, tp2, tp2Label: lv.target?.label ?? null, riskPerUnit: risk, rewardPerUnit: lv.reward, rr, minRR: cfg.minRR, invalidation: lv.stop, atr, checks },
      reasons,
      session: inSession,
      bias: { ...this.bias },
      quality,
      lockedOutcome: null,
    };
    this.signals.push(signal);
    if (signal.status === 'ENTRY_READY') {
      ev('entry_ready', signal.id, `ENTRY SETUP ${pd.dir.toUpperCase()} @ ${fmt(lv.entry)} | SL ${fmt(lv.stop)} | TP1 ${fmt(lv.tp1)} | TP2 ${fmt(tp2!)} | R:R ${rr!.toFixed(2)} | quality ${quality}/100 | HTF bias ${this.bias.value}`, {
        direction: pd.dir,
        data: { entry: lv.entry, stop: lv.stop, tp1: lv.tp1, tp2, rr, quality, signalId: signal.id },
      });
      this.trade = newTrade(signal.id, { direction: pd.dir, entry: lv.entry, stop: lv.stop, tp1: lv.tp1, tp2: tp2! }, c.time, i, cfg.breakevenAfterTp1);
      this.trades.push(this.trade);
      this.sessionEntries.set(sesKey, (this.sessionEntries.get(sesKey) ?? 0) + 1);
    } else {
      ev('filtered', signal.id, `FILTERED ${pd.dir.toUpperCase()} (Q${quality}): ${reasons.join('; ')}`, { direction: pd.dir, data: { reasons, entry: lv.entry, stop: lv.stop, tp2, rr, quality } });
      if (cfg.filteredSetupLocks) this.lock = { signal, dir: pd.dir, sl: lv.stop, tp1: lv.tp1, tp2, tp1Hit: false };
    }
    return signal;
  }

  private updateFvgs(i: number) {
    const c = this.candles[i];
    for (const g of this.fvgs) {
      if (g.status === 'mitigated' || g.status === 'invalidated' || g.createdTime >= c.time) continue;
      const bull = g.direction === 'bullish';
      const invalid = bull ? c.close < g.bottom : c.close > g.top;
      const full = this.config.fvgMitigation === 'wick' ? (bull ? c.low <= g.bottom : c.high >= g.top) : bull ? c.close <= g.bottom : c.close >= g.top;
      if (invalid) (g.status = 'invalidated'), (g.statusTime = c.time);
      else if (full) (g.status = 'mitigated'), (g.statusTime = c.time);
      else if (g.status === 'active' && (bull ? c.low < g.top : c.high > g.bottom)) (g.status = 'partial'), (g.statusTime = c.time);
    }
    if (!this.config.fvgEnabled || i < 2) return;
    const a = this.candles[i - 2];
    const minSize = this.config.fvgMinAtr * (this.lastAtr ?? 0);
    if (c.low > a.high && c.low - a.high >= minSize) this.fvgs.push({ id: this.id('fvg'), direction: 'bullish', top: c.low, bottom: a.high, time: this.candles[i - 1].time, createdTime: c.time, status: 'active', statusTime: null });
    else if (c.high < a.low && a.low - c.high >= minSize) this.fvgs.push({ id: this.id('fvg'), direction: 'bearish', top: a.low, bottom: c.high, time: this.candles[i - 1].time, createdTime: c.time, status: 'active', statusTime: null });
    if (this.fvgs.length > Math.max(10, this.config.maxFvgs) * 3) this.fvgs.splice(0, this.fvgs.length - Math.max(10, this.config.maxFvgs) * 3);
  }

  private push<T>(arr: T[], v: T) {
    arr.push(v);
    if (arr.length > this.cap) arr.splice(0, arr.length - this.cap);
  }

  closeActiveTrade(price: number, outcome: 'manual' | 'cancelled' = 'manual'): TradeState | null {
    if (!this.trade) return null;
    const last = this.candles[this.candles.length - 1];
    closeTradeManually(this.trade, price, last?.time ?? 0, outcome);
    const t = this.trade;
    this.recordR(t);
    this.trade = null;
    this.st = 0;
    this.state = 'COMPLETED';
    this.stateReason = `Trade ${outcome === 'manual' ? 'manually closed' : 'cancelled'}`;
    return t;
  }

  private asLevel(l: Lvl): LiquidityLevel {
    return { ...l, status: 'untested', statusTime: null, breach: null };
  }

  snapshot(): EngineSnapshot {
    const last = this.candles[this.candles.length - 1] ?? null;
    const price = last?.close ?? null;
    const pd = this.pending;
    const candidate: Candidate | null = pd
      ? {
          id: pd.id,
          direction: pd.dir,
          sweep: { ...pd.sweep },
          anchor: this.asLevel(pd.level),
          extreme: pd.ext,
          extremeIndex: pd.bar,
          reclaimIndex: pd.bar,
          bos: null,
          displacement: null,
          bosRef: pd.dir === 'long' ? this.swH && { ...this.swH } : this.swL && { ...this.swL },
        }
      : null;
    const above = price === null ? null : this.nearest('high', price);
    const below = price === null ? null : this.nearest('low', price);
    return {
      symbol: this.symbol,
      timeframe: this.timeframe,
      configHash: this.hash,
      barCount: this.candles.length,
      lastTime: last?.time ?? null,
      state: this.state,
      stateReason: this.stateReason,
      atr: this.lastAtr,
      bias: { ...this.bias },
      sessions: {
        active: last ? activeSessions(this.windows, last.time) : [],
        developing: [...this.sessions.developing.values()].map((b) => ({ ...b })),
        completed: this.completedRanges.slice(-30),
        day: this.sessions.day ? { ...this.sessions.day } : null,
        previousDay: this.previousDay,
      },
      levels: [...this.levels().map((l) => this.asLevel(l)), ...this.retired.slice(-20)],
      nearestAbove: above ? this.asLevel(above) : null,
      nearestBelow: below ? this.asLevel(below) : null,
      swings: this.swings.slice(-80).map((s) => ({ ...s })),
      sweeps: this.sweeps.slice(-60).map((s) => ({ ...s })),
      structureBreaks: this.bosList.slice(-60),
      displacements: this.displacements.slice(-60),
      fvgs: this.fvgs.slice(-Math.max(10, this.config.maxFvgs)).map((f) => ({ ...f })),
      orderBlocks: this.obs.map((o) => ({ ...o })),
      candidate,
      signals: this.signals.slice(-100),
      lastSignal: this.signals[this.signals.length - 1] ?? null,
      trade: this.trade ? { ...this.trade } : null,
      trades: this.trades.slice(-200).map((t) => ({ ...t })),
    };
  }

  results() {
    return { signals: this.signals, trades: this.trades };
  }
}
