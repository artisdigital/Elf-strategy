// ELF strategy configuration: documented v1.1 defaults, validation and metadata.
//
// Every rule is tagged with its origin:
//   'v1.1'      — an original ELF v1.1 rule / default (from the strategy specification)
//   'optional'  — an engineering addition. These are OFF or neutral by default and are
//                 labelled OPTIONAL in the UI so they never silently change the strategy.
//   'assumption'— a choice the specification did not pin down; documented in docs/ELF_RULES.md.

import { z } from 'zod';
import { parseHHMM } from '../shared/time.js';

/** Bump when the shape or the meaning of the config changes. Stored with every result. */
export const CONFIG_SCHEMA_VERSION = 2;
export const ELF_RULESET = 'ELF v1.1';

const hhmm = z.string().refine((v) => {
  try {
    parseHHMM(v);
    return true;
  } catch {
    return false;
  }
}, 'Expected HH:MM (24h)');

export const sessionSchema = z.object({
  enabled: z.boolean(),
  start: hhmm,
  end: hhmm,
});

export const elfConfigSchema = z.object({
  schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),

  /** 'v1.1' = faithful port of the ELF v1.1 Pine Script (default). 'extended' = multi-level engine. */
  engineModel: z.enum(['v1.1', 'extended']),

  // ── Sessions (America/New_York) ──
  sessions: z.object({
    london: sessionSchema,
    newYork: sessionSchema,
    asia: sessionSchema,
  }),
  /** Which steps must fall inside an enabled session window. */
  sessionGate: z.enum(['sweep', 'entry', 'both', 'off']),
  /** Manual news blackout — blocks NEW entries only (live use). */
  newsBlackout: z.boolean(),
  /** Calendar day boundary for previous-day high/low. */
  dayBoundary: z.enum(['auto', 'ny-midnight', 'ny-1700', 'utc-midnight']),
  /** v1.1: pending/active setups reset at the first enabled session open each day. */
  dailyCycleReset: z.boolean(),
  /** v1.1: a FILTERED setup is still monitored (SL / TP2) and blocks new sweeps until it resolves. */
  filteredSetupLocks: z.boolean(),
  /** OPTIONAL (Forex Workflow hard rule): max entries per session instance, 0 = off. */
  maxTradesPerSession: z.number().int().min(0).max(20),
  /** OPTIONAL (Forex Workflow hard rule): no new entries for the day after this realised loss in R, 0 = off. */
  dailyLossLimitR: z.number().min(0).max(20),

  // ── Indicators ──
  atrPeriod: z.number().int().min(1).max(200),

  // ── Liquidity / sweep ──
  sweepAtrMult: z.number().min(0).max(5),
  /** OPTIONAL: require the reclaim close on the sweep candle itself. */
  requireSameCandleReclaim: z.boolean(),
  swingLength: z.number().int().min(1).max(50),
  /** Tolerance for equal highs / lows as an ATR multiple. */
  equalLevelAtrTol: z.number().min(0).max(2),
  includeSwingLevels: z.boolean(),
  includeEqualLevels: z.boolean(),
  includeSessionLevels: z.boolean(),
  includePrevDayLevels: z.boolean(),
  /** OPTIONAL: liquidity levels older than this many bars stop being tracked (0 = never). */
  levelMaxAgeBars: z.number().int().min(0).max(100000),

  // ── Confirmation ──
  maxConfirmBars: z.number().int().min(1).max(500),

  // ── Displacement ──
  displacementAtrMult: z.number().min(0).max(10),
  displacementBodyRatio: z.number().min(0).max(1),
  displacementBars: z.number().int().min(1).max(5),

  // ── HTF bias ──
  htfBiasEnabled: z.boolean(),
  htfTimeframe: z.enum(['1d', '4h', '1h']),
  htfEmaLength: z.number().int().min(1).max(500),

  // ── Risk / plan ──
  slAtrBuffer: z.number().min(0).max(5),
  tp1R: z.number().min(0.1).max(20),
  /** OPTIONAL: which liquidity may serve as TP2. 'all' = v1.1 (nearest of any kind). */
  targetSources: z.enum(['all', 'major']),
  minRR: z.number().min(2).max(10).refine((v) => Math.abs(v * 2 - Math.round(v * 2)) < 1e-9, 'Minimum R:R moves in 0.5 steps'),
  /** OPTIONAL: move stop to entry after TP1 (off in v1.1). */
  breakevenAfterTp1: z.boolean(),
  /** OPTIONAL: close an open theoretical trade after N bars (0 = never). */
  tradeExpiryBars: z.number().int().min(0).max(10000),

  // ── FVG ──
  fvgEnabled: z.boolean(),
  /** How a gap counts as fully mitigated: wick fill, or a close through the far edge. */
  fvgMitigation: z.enum(['wick', 'close']),
  fvgMinAtr: z.number().min(0).max(5),
  maxFvgs: z.number().int().min(0).max(100),

  // ── Order blocks ──
  obEnabled: z.boolean(),
  /** v1.1 draws the OB candle BODY; 'range' uses the full high–low range. */
  obRange: z.enum(['body', 'range']),
  maxOrderBlocks: z.number().int().min(0).max(100),
});

export type ElfConfig = z.infer<typeof elfConfigSchema>;
export type SessionName = keyof ElfConfig['sessions'];

/** The documented ELF v1.1 defaults. Never changed silently — bump CONFIG_SCHEMA_VERSION instead. */
export const ELF_V11_DEFAULTS: ElfConfig = Object.freeze({
  schemaVersion: CONFIG_SCHEMA_VERSION,
  sessions: {
    london: { enabled: true, start: '03:00', end: '06:00' },
    newYork: { enabled: true, start: '08:00', end: '11:00' },
    asia: { enabled: false, start: '17:00', end: '02:00' },
  },
  engineModel: 'v1.1',
  sessionGate: 'both',
  newsBlackout: false,
  dayBoundary: 'auto',
  dailyCycleReset: true,
  filteredSetupLocks: true,
  maxTradesPerSession: 0,
  dailyLossLimitR: 0,
  atrPeriod: 14,
  sweepAtrMult: 0.05,
  requireSameCandleReclaim: true,
  swingLength: 5,
  equalLevelAtrTol: 0.1,
  includeSwingLevels: true,
  includeEqualLevels: true,
  includeSessionLevels: true,
  includePrevDayLevels: true,
  levelMaxAgeBars: 0,
  maxConfirmBars: 20,
  displacementAtrMult: 1.0,
  displacementBodyRatio: 0.5,
  displacementBars: 1,
  htfBiasEnabled: true,
  htfTimeframe: '1d',
  htfEmaLength: 50,
  slAtrBuffer: 0.1,
  tp1R: 1,
  targetSources: 'all',
  minRR: 3,
  breakevenAfterTp1: false,
  tradeExpiryBars: 0,
  fvgEnabled: true,
  fvgMitigation: 'wick',
  fvgMinAtr: 0,
  maxFvgs: 12,
  obEnabled: true,
  obRange: 'body',
  maxOrderBlocks: 8,
}) as ElfConfig;

export function defaultConfig(): ElfConfig {
  return structuredClone(ELF_V11_DEFAULTS);
}

/** Validate a (possibly partial / older) config, filling gaps from v1.1 defaults. */
export function parseConfig(input: unknown): { ok: true; config: ElfConfig } | { ok: false; errors: string[] } {
  const base = defaultConfig();
  const merged =
    input && typeof input === 'object'
      ? {
          ...base,
          ...(input as object),
          sessions: { ...base.sessions, ...((input as any).sessions ?? {}) },
          schemaVersion: CONFIG_SCHEMA_VERSION,
          // Configs saved before schema 2 were created with the extended engine.
          ...((input as any).schemaVersion === 1 && (input as any).engineModel === undefined ? { engineModel: 'extended' } : {}),
        }
      : base;
  const res = elfConfigSchema.safeParse(merged);
  if (!res.success) return { ok: false, errors: res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  return { ok: true, config: res.data };
}

/** Stable hash of a config, stored alongside every backtest so results are reproducible. */
export function configHash(config: ElfConfig): string {
  return fnv1a(stableStringify(config));
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value as object).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify((value as any)[k])).join(',') + '}';
}

export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export type RuleOrigin = 'v1.1' | 'optional' | 'assumption';
export interface ConfigFieldMeta {
  key: string; // dotted path
  label: string;
  description: string;
  origin: RuleOrigin;
  group: 'Sessions' | 'Liquidity & Sweep' | 'Structure & Displacement' | 'Bias' | 'Risk & Targets' | 'FVG & Order Blocks';
  kind: 'number' | 'boolean' | 'select' | 'time';
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
}

/** UI metadata for every adjustable rule. */
export const CONFIG_FIELDS: ConfigFieldMeta[] = [
  {
    key: 'engineModel', label: 'Engine model', description: 'v1.1 = faithful port of your ELF v1.1 Pine Script (nearest-level same-candle sweeps, one-candle BOS + displacement confirmation, latest-level liquidity set, one setup per sweep). Extended = multi-level engine where the close back, BOS and displacement may occur on separate candles.',
    origin: 'v1.1', group: 'Sessions', kind: 'select', options: [ { value: 'v1.1', label: 'ELF v1.1 (Pine parity)' }, { value: 'extended', label: 'Extended (multi-candle sequence)' } ],
  },
  { key: 'sessions.london.enabled', label: 'London session', description: 'Enable the London entry window.', origin: 'v1.1', group: 'Sessions', kind: 'boolean' },
  { key: 'sessions.london.start', label: 'London start (ET)', description: 'Session start, America/New_York.', origin: 'v1.1', group: 'Sessions', kind: 'time' },
  { key: 'sessions.london.end', label: 'London end (ET)', description: 'Session end (exclusive), America/New_York.', origin: 'v1.1', group: 'Sessions', kind: 'time' },
  { key: 'sessions.newYork.enabled', label: 'New York session', description: 'Enable the New York entry window.', origin: 'v1.1', group: 'Sessions', kind: 'boolean' },
  { key: 'sessions.newYork.start', label: 'New York start (ET)', description: 'Session start, America/New_York.', origin: 'v1.1', group: 'Sessions', kind: 'time' },
  { key: 'sessions.newYork.end', label: 'New York end (ET)', description: 'Session end (exclusive), America/New_York.', origin: 'v1.1', group: 'Sessions', kind: 'time' },
  { key: 'sessions.asia.enabled', label: 'Sydney session', description: 'v1.1 toggle, OFF by default (17:00–02:00 ET). When on, its range is tracked and its H/L become sweep levels.', origin: 'v1.1', group: 'Sessions', kind: 'boolean' },
  { key: 'sessions.asia.start', label: 'Sydney start (ET)', description: 'Session start, America/New_York.', origin: 'v1.1', group: 'Sessions', kind: 'time' },
  { key: 'sessions.asia.end', label: 'Sydney end (ET)', description: 'Session end (exclusive). Earlier than start means it wraps midnight.', origin: 'v1.1', group: 'Sessions', kind: 'time' },
  {
    key: 'sessionGate', label: 'Session gate applies to', description: 'Which steps must occur inside an enabled session. "both": the sweep AND the entry-ready candle must each be inside an enabled session (not necessarily the same one), so a London sweep may confirm in New York. Monitoring of active trades always continues outside windows. v1.1 = sweep and entry.',
    origin: 'v1.1', group: 'Sessions', kind: 'select',
    options: [ { value: 'both', label: 'Sweep and entry' }, { value: 'sweep', label: 'Sweep only' }, { value: 'entry', label: 'Entry only' }, { value: 'off', label: 'Off (24h)' } ],
  },
  { key: 'newsBlackout', label: 'News blackout (manual)', description: 'When on, new entries are FILTERED with reason "News blackout". No automatic news feed is used.', origin: 'v1.1', group: 'Sessions', kind: 'boolean' },
  {
    key: 'dayBoundary', label: 'Trading-day boundary', description: 'Defines "previous day" for PDH/PDL. v1.1 reads the chart feed’s daily candle (auto).', origin: 'v1.1', group: 'Sessions', kind: 'select',
    options: [ { value: 'auto', label: 'Auto — the provider’s daily candle (v1.1)' }, { value: 'ny-midnight', label: '00:00 New York' }, { value: 'ny-1700', label: '17:00 New York (forex convention)' }, { value: 'utc-midnight', label: '00:00 UTC (crypto exchange daily)' } ],
  },
  { key: 'dailyCycleReset', label: 'Daily cycle reset', description: 'v1.1: pending sweeps and monitored setups reset at the first enabled session open each day. An open theoretical trade is closed at that candle’s open (marked expired).', origin: 'v1.1', group: 'Sessions', kind: 'boolean' },
  { key: 'filteredSetupLocks', label: 'Filtered setups lock the machine', description: 'v1.1 behaviour (one setup per sweep): after a FILTERED confirmation the engine keeps watching its SL / TP2 and ignores new sweeps until it resolves or the next cycle. Turn off to look for the next sweep immediately.', origin: 'v1.1', group: 'Risk & Targets', kind: 'boolean' },
  { key: 'maxTradesPerSession', label: 'Max entries per session', description: 'OPTIONAL (ELF Forex Workflow hard rule: two trades max per session). 0 = off.', origin: 'optional', group: 'Risk & Targets', kind: 'number', min: 0, max: 20, step: 1 },
  { key: 'dailyLossLimitR', label: 'Daily loss limit (R)', description: 'OPTIONAL (ELF Forex Workflow hard rule: stop after −1.5R). No new entries that trading day once realised theoretical losses reach this. 0 = off.', origin: 'optional', group: 'Risk & Targets', kind: 'number', min: 0, max: 20, step: 0.5 },
  { key: 'atrPeriod', label: 'ATR period', description: "Wilder ATR length used for sweep, displacement and stop buffer.", origin: 'v1.1', group: 'Structure & Displacement', kind: 'number', min: 1, max: 200, step: 1 },
  { key: 'sweepAtrMult', label: 'Sweep penetration (× ATR)', description: 'Minimum wick penetration beyond a level to count as a sweep. Exactly at the threshold qualifies.', origin: 'v1.1', group: 'Liquidity & Sweep', kind: 'number', min: 0, max: 5, step: 0.01 },
  { key: 'requireSameCandleReclaim', label: 'Require same-candle reclaim', description: '[Extended model] v1.1 requires the sweep candle itself to close back through the level (default on). Off: the close back may come later within the window.', origin: 'v1.1', group: 'Liquidity & Sweep', kind: 'boolean' },
  { key: 'swingLength', label: 'Swing length', description: 'Bars on each side for a confirmed swing pivot. A pivot is only known swingLength bars after it forms (no lookahead).', origin: 'v1.1', group: 'Structure & Displacement', kind: 'number', min: 1, max: 50, step: 1 },
  { key: 'equalLevelAtrTol', label: 'Equal highs/lows tolerance (× ATR)', description: 'Two consecutive confirmed swings within this distance form one EQH / EQL at their average (v1.1 design addition, 0.10).', origin: 'v1.1', group: 'Liquidity & Sweep', kind: 'number', min: 0, max: 2, step: 0.01 },
  { key: 'includePrevDayLevels', label: 'Use PDH / PDL', description: '[Extended model] Previous day high/low as liquidity.', origin: 'v1.1', group: 'Liquidity & Sweep', kind: 'boolean' },
  { key: 'includeSessionLevels', label: 'Use session highs/lows', description: '[Extended model] Completed session ranges as liquidity.', origin: 'v1.1', group: 'Liquidity & Sweep', kind: 'boolean' },
  { key: 'includeSwingLevels', label: 'Use swing highs/lows', description: '[Extended model] Confirmed swing pivots as liquidity.', origin: 'v1.1', group: 'Liquidity & Sweep', kind: 'boolean' },
  { key: 'includeEqualLevels', label: 'Use EQH / EQL', description: '[Extended model] Equal highs / lows as liquidity.', origin: 'v1.1', group: 'Liquidity & Sweep', kind: 'boolean' },
  { key: 'levelMaxAgeBars', label: 'Level max age (bars)', description: '[Extended model] OPTIONAL. Stop tracking levels older than this. 0 = keep until swept/broken.', origin: 'optional', group: 'Liquidity & Sweep', kind: 'number', min: 0, max: 100000, step: 1 },
  { key: 'maxConfirmBars', label: 'Max sweep → confirmation bars', description: 'A sweep expires if BOS + displacement are not complete within this many bars.', origin: 'v1.1', group: 'Structure & Displacement', kind: 'number', min: 1, max: 500, step: 1 },
  { key: 'displacementAtrMult', label: 'Displacement body (× ATR)', description: 'Minimum directional body size.', origin: 'v1.1', group: 'Structure & Displacement', kind: 'number', min: 0, max: 10, step: 0.05 },
  { key: 'displacementBodyRatio', label: 'Displacement body / range', description: 'Minimum body-to-range ratio (0.5 = 50%).', origin: 'v1.1', group: 'Structure & Displacement', kind: 'number', min: 0, max: 1, step: 0.05 },
  { key: 'displacementBars', label: 'Displacement candles', description: 'Up to N consecutive same-direction candles may jointly form displacement (net body vs ATR, combined body/range).', origin: 'v1.1', group: 'Structure & Displacement', kind: 'number', min: 1, max: 5, step: 1 },
  { key: 'htfBiasEnabled', label: 'Higher-timeframe bias filter', description: 'Only longs above / shorts below the HTF EMA, using completed HTF candles only. An analytical filter, not a prediction.', origin: 'v1.1', group: 'Bias', kind: 'boolean' },
  { key: 'htfTimeframe', label: 'Bias timeframe', description: 'Higher timeframe used for the bias.', origin: 'v1.1', group: 'Bias', kind: 'select', options: [ { value: '1d', label: 'Daily' }, { value: '4h', label: '4 hour' }, { value: '1h', label: '1 hour' } ] },
  { key: 'htfEmaLength', label: 'Bias EMA length', description: 'EMA length on the bias timeframe.', origin: 'v1.1', group: 'Bias', kind: 'number', min: 1, max: 500, step: 1 },
  { key: 'slAtrBuffer', label: 'Stop buffer (× ATR)', description: 'Stop placed this far beyond the recorded sweep extreme.', origin: 'v1.1', group: 'Risk & Targets', kind: 'number', min: 0, max: 5, step: 0.01 },
  { key: 'tp1R', label: 'Target 1 (R)', description: 'TP1 distance in multiples of risk.', origin: 'v1.1', group: 'Risk & Targets', kind: 'number', min: 0.1, max: 20, step: 0.1 },
  {
    key: 'targetSources', label: 'TP2 liquidity sources', description: 'OPTIONAL. v1.1 uses the nearest opposing liquidity of any kind. "Major only" ignores plain swing pivots and targets PDH/PDL, session highs/lows and EQH/EQL. This changes which setups qualify — compare in a backtest before relying on it.',
    origin: 'optional', group: 'Risk & Targets', kind: 'select', options: [ { value: 'all', label: 'All liquidity (v1.1)' }, { value: 'major', label: 'Major only (no plain swings)' } ],
  },
  { key: 'minRR', label: 'Minimum R:R (to TP2)', description: '|entry − TP2| ÷ |entry − stop|. Default 3; may be lowered to 2 in 0.5 steps.', origin: 'v1.1', group: 'Risk & Targets', kind: 'number', min: 2, max: 10, step: 0.5 },
  { key: 'breakevenAfterTp1', label: 'Breakeven after TP1', description: '[Extended model] OPTIONAL. Move the theoretical stop to entry once TP1 is reached.', origin: 'optional', group: 'Risk & Targets', kind: 'boolean' },
  { key: 'tradeExpiryBars', label: 'Trade expiry (bars)', description: '[Extended model] OPTIONAL. Close an open theoretical trade at the bar close after N bars. 0 = never.', origin: 'optional', group: 'Risk & Targets', kind: 'number', min: 0, max: 10000, step: 1 },
  { key: 'fvgEnabled', label: 'Detect FVGs', description: 'Three-candle fair value gaps. Displayed only — never an automatic entry.', origin: 'v1.1', group: 'FVG & Order Blocks', kind: 'boolean' },
  { key: 'fvgMitigation', label: 'FVG full-mitigation rule', description: 'v1.1: filled when a wick trades to the far edge. close: a candle closes beyond the far edge (also invalidates).', origin: 'v1.1', group: 'FVG & Order Blocks', kind: 'select', options: [ { value: 'wick', label: 'Wick fills gap' }, { value: 'close', label: 'Close through gap' } ] },
  { key: 'fvgMinAtr', label: 'FVG minimum size (× ATR)', description: 'OPTIONAL. Ignore gaps smaller than this. 0 = all gaps.', origin: 'optional', group: 'FVG & Order Blocks', kind: 'number', min: 0, max: 5, step: 0.05 },
  { key: 'maxFvgs', label: 'Max FVGs kept', description: 'Performance cap on tracked gaps.', origin: 'optional', group: 'FVG & Order Blocks', kind: 'number', min: 0, max: 100, step: 1 },
  { key: 'obEnabled', label: 'Detect order blocks', description: 'Last opposite candle before a qualifying displacement leg that breaks structure.', origin: 'v1.1', group: 'FVG & Order Blocks', kind: 'boolean' },
  { key: 'obRange', label: 'Order-block box', description: 'v1.1 draws the OB candle body (open–close) with its 50% line. "Full range" uses high–low.', origin: 'v1.1', group: 'FVG & Order Blocks', kind: 'select', options: [ { value: 'body', label: 'Candle body (v1.1)' }, { value: 'range', label: 'Full high–low range' } ] },
  { key: 'maxOrderBlocks', label: 'Max order blocks kept', description: 'Performance cap on tracked order blocks.', origin: 'optional', group: 'FVG & Order Blocks', kind: 'number', min: 0, max: 100, step: 1 },
];

export function getPath(obj: any, path: string): any {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath<T>(obj: T, path: string, value: unknown): T {
  const clone: any = structuredClone(obj);
  const keys = path.split('.');
  let cur = clone;
  for (let i = 0; i < keys.length - 1; i++) cur = cur[keys[i]];
  cur[keys[keys.length - 1]] = value;
  return clone;
}
