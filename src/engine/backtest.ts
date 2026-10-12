// Backtesting — runs the SAME ElfEngine used live over historical candles.
//
// No-lookahead guarantees come from the engine itself (closed candles in order, delayed
// swing confirmation, HTF candles only after their close). This module adds costs,
// position sizing, gap reporting, in-sample/out-of-sample separation and reproducibility.
//
// Cost model (theoretical):
//   entry fill = signal close moved against the trade by `slippageBps`
//   exit fill  = exit price moved against the trade by `slippageBps`
//   fees       = (entryFill + exitFill) × feeRatePerSide per unit
//   net R      = ((exitFill − entryFill) × dir − fees) ÷ planned risk per unit

import type { Candle, Timeframe } from '../shared/types.js';
import { tfSeconds } from '../shared/types.js';
import { ElfEngine, type Signal } from './engine.js';
import { type ElfConfig, configHash, fnv1a, stableStringify, ELF_RULESET } from './config.js';
import { computeStats, type PerformanceStats, type TradeRecordForStats } from './analytics.js';
import type { TradeState } from './trade.js';

export const BACKTEST_ENGINE_VERSION = 'elf-bt-1';

export interface BacktestCosts {
  feeRatePerSide: number; // e.g. 0.001 = 0.10 %
  slippageBps: number; // basis points per fill, e.g. 2 = 0.02 %
}

export interface BacktestRisk {
  startingEquity: number;
  riskPct: number; // % of equity risked per trade, e.g. 1
  maxRiskPct: number; // hard cap per trade
}

export interface BacktestInput {
  provider: string;
  symbol: string;
  timeframe: Timeframe;
  candles: Candle[];
  htfCandles: Candle[];
  intrabarCandles?: Candle[];
  intrabarTimeframe?: Timeframe;
  config: ElfConfig;
  costs: BacktestCosts;
  risk: BacktestRisk;
  /** Trades with entry time < split are in-sample; >= split are out-of-sample. */
  splitTime?: number | null;
}

export interface BacktestTrade {
  id: string;
  direction: 'long' | 'short';
  entryTime: number;
  exitTime: number | null;
  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
  exit: number | null;
  outcome: string | null;
  grossR: number;
  netR: number;
  plannedRR: number;
  ambiguous: boolean;
  tp1Hit: boolean;
  session: string;
  sample: 'in' | 'out';
  units: number;
  riskAmount: number;
  pnl: number;
  equityAfter: number;
}

export interface DataGap {
  from: number;
  to: number;
  missingBars: number;
}

export interface BacktestResult {
  engineVersion: string;
  ruleset: string;
  provider: string;
  symbol: string;
  timeframe: Timeframe;
  from: number | null;
  to: number | null;
  candleCount: number;
  config: ElfConfig;
  configHash: string;
  costs: BacktestCosts;
  risk: BacktestRisk;
  splitTime: number | null;
  dataHash: string;
  resultHash: string;
  trades: BacktestTrade[];
  openTradeAtEnd: boolean;
  signals: { total: number; entryReady: number; filtered: number; filterReasons: Record<string, number> };
  stats: { all: PerformanceStats; inSample: PerformanceStats; outOfSample: PerformanceStats };
  equity: { time: number; equity: number }[];
  gaps: DataGap[];
  ambiguousCount: number;
  notes: string[];
}

export function dataHash(candles: Candle[]): string {
  let s = '';
  for (const c of candles) s += `${c.time},${c.open},${c.high},${c.low},${c.close};`;
  return fnv1a(s);
}

export function findGaps(candles: Candle[], tf: Timeframe): DataGap[] {
  const step = tfSeconds(tf);
  const gaps: DataGap[] = [];
  for (let k = 1; k < candles.length; k++) {
    const d = candles[k].time - candles[k - 1].time;
    if (d > step) gaps.push({ from: candles[k - 1].time, to: candles[k].time, missingBars: Math.round(d / step) - 1 });
  }
  return gaps;
}

function signalSession(s: Signal | undefined): string {
  return s && s.session.length ? s.session.join('+') : 'outside';
}

export function runBacktest(input: BacktestInput): BacktestResult {
  const candles = [...input.candles].sort((a, b) => a.time - b.time);
  const tfSec = tfSeconds(input.timeframe);
  let intrabar: ((c: Candle) => Candle[] | undefined) | undefined;
  if (input.intrabarCandles && input.intrabarCandles.length) {
    const byParent = new Map<number, Candle[]>();
    for (const sub of input.intrabarCandles) {
      const parent = Math.floor(sub.time / tfSec) * tfSec;
      (byParent.get(parent) ?? byParent.set(parent, []).get(parent)!).push(sub);
    }
    for (const list of byParent.values()) list.sort((a, b) => a.time - b.time);
    intrabar = (c) => byParent.get(c.time);
  }
  const engine = new ElfEngine(input.config, {
    symbol: input.symbol,
    timeframe: input.timeframe,
    htfCandles: input.htfCandles,
    historyCap: 50,
    intrabar,
    applyNewsBlackout: false,
  });
  for (const c of candles) engine.update(c);
  const { signals, trades } = engine.results();
  const sigById = new Map(signals.map((s) => [s.id, s]));

  const slip = input.costs.slippageBps / 10_000;
  const fee = input.costs.feeRatePerSide;
  const riskPct = Math.min(input.risk.riskPct, input.risk.maxRiskPct);
  let equity = input.risk.startingEquity;
  const equityCurve: { time: number; equity: number }[] = [];
  if (candles.length) equityCurve.push({ time: candles[0].time, equity });
  const out: BacktestTrade[] = [];
  const closed = trades.filter((t) => t.status === 'closed');
  for (const t of closed) out.push(toBtTrade(t));

  function toBtTrade(t: TradeState): BacktestTrade {
    const dir = t.direction === 'long' ? 1 : -1;
    const entryFill = t.entry * (1 + dir * slip);
    const exitFill = t.exitPrice! * (1 - dir * slip);
    const fees = (entryFill + exitFill) * fee;
    const netR = ((exitFill - entryFill) * dir - fees) / t.risk;
    const riskAmount = (equity * riskPct) / 100;
    const units = riskAmount / t.risk;
    const pnl = netR * riskAmount;
    equity += pnl;
    equityCurve.push({ time: t.exitTime!, equity });
    const sig = sigById.get(t.id);
    return {
      id: t.id,
      direction: t.direction,
      entryTime: t.entryTime,
      exitTime: t.exitTime,
      entry: t.entry,
      stop: t.initialStop,
      tp1: t.tp1,
      tp2: t.tp2,
      exit: t.exitPrice,
      outcome: t.outcome,
      grossR: t.resultR ?? 0,
      netR,
      plannedRR: sig?.plan.rr ?? Math.abs(t.tp2 - t.entry) / t.risk,
      ambiguous: t.ambiguous,
      tp1Hit: t.tp1Hit,
      session: signalSession(sig),
      sample: input.splitTime != null && t.entryTime >= input.splitTime ? 'out' : 'in',
      units,
      riskAmount,
      pnl,
      equityAfter: equity,
    };
  }

  const toRec = (t: BacktestTrade): TradeRecordForStats => ({
    r: t.netR,
    direction: t.direction,
    session: t.session,
    symbol: input.symbol,
    timeframe: input.timeframe,
    setup: 'ELF',
    plannedRR: t.plannedRR,
    compliant: true,
    time: t.entryTime,
  });
  const filterReasons: Record<string, number> = {};
  for (const s of signals) if (s.status === 'FILTERED') for (const r of s.reasons) {
    const key = r.replace(/[\d.]+/g, '#');
    filterReasons[key] = (filterReasons[key] ?? 0) + 1;
  }

  const notes = [
    'Theoretical fills: entry at the confirmation candle close; stop gaps fill at the open; targets fill at the target price.',
    'Candles touching both stop and target are resolved with lower-timeframe data when supplied, otherwise the stop is assumed first (conservative).',
    'The manual news blackout is not applied historically (no news calendar).',
    'Past simulated results do not predict future performance.',
  ];
  if (!intrabar) notes.push('No lower-timeframe data supplied: ambiguous candles use the stop-first assumption.');
  const open = trades.some((t) => t.status === 'open');
  if (open) notes.push('One trade was still open at the end of the data and is excluded from the statistics.');

  const partial = {
    engineVersion: BACKTEST_ENGINE_VERSION,
    ruleset: ELF_RULESET,
    provider: input.provider,
    symbol: input.symbol,
    timeframe: input.timeframe,
    from: candles[0]?.time ?? null,
    to: candles[candles.length - 1]?.time ?? null,
    candleCount: candles.length,
    config: input.config,
    configHash: configHash(input.config),
    costs: input.costs,
    risk: input.risk,
    splitTime: input.splitTime ?? null,
    dataHash: dataHash(candles),
    trades: out,
    openTradeAtEnd: open,
    signals: {
      total: signals.length,
      entryReady: signals.filter((s) => s.status === 'ENTRY_READY').length,
      filtered: signals.filter((s) => s.status === 'FILTERED').length,
      filterReasons,
    },
    stats: {
      all: computeStats(out.map(toRec)),
      inSample: computeStats(out.filter((t) => t.sample === 'in').map(toRec)),
      outOfSample: computeStats(out.filter((t) => t.sample === 'out').map(toRec)),
    },
    equity: equityCurve,
    gaps: findGaps(candles, input.timeframe),
    ambiguousCount: out.filter((t) => t.ambiguous).length,
    notes,
  };
  const resultHash = fnv1a(stableStringify({ trades: partial.trades, stats: partial.stats, signals: partial.signals }));
  return { ...partial, resultHash };
}

/**
 * In-sample parameter search: evaluates each combination ONLY on in-sample data, picks the
 * best by in-sample net R, then reports that single choice on the untouched out-of-sample period.
 */
export function parameterSearch(
  input: BacktestInput,
  grid: { key: keyof ElfConfig; values: number[] }[],
): { rows: { params: Record<string, number>; inSampleNetR: number; inSampleTrades: number }[]; best: Record<string, number> | null; outOfSample: BacktestResult | null } {
  if (input.splitTime == null) throw new Error('parameterSearch requires a split time');
  const isCandles = input.candles.filter((c) => c.time < input.splitTime!);
  const combos: Record<string, number>[] = [{}];
  for (const g of grid) {
    const next: Record<string, number>[] = [];
    for (const c of combos) for (const v of g.values) next.push({ ...c, [g.key]: v });
    combos.splice(0, combos.length, ...next);
  }
  if (combos.length > 64) throw new Error('Parameter grid too large (max 64 combinations)');
  const rows = combos.map((params) => {
    const r = runBacktest({ ...input, candles: isCandles, config: { ...input.config, ...params } as ElfConfig, splitTime: null });
    return { params, inSampleNetR: r.stats.all.netR, inSampleTrades: r.stats.all.count };
  });
  const best = rows.length ? rows.reduce((a, b) => (b.inSampleNetR > a.inSampleNetR ? b : a)).params : null;
  const outOfSample = best ? runBacktest({ ...input, config: { ...input.config, ...best } as ElfConfig }) : null;
  return { rows, best, outOfSample };
}
