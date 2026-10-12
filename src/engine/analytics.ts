// Performance analytics. Computed only from the records passed in; callers must never mix
// hypothetical (backtest / replay / signal) results with actual executed trades.

export interface TradeRecordForStats {
  r: number; // realised result in R (net of costs when known)
  direction: 'long' | 'short';
  session?: string | null;
  symbol?: string | null;
  timeframe?: string | null;
  setup?: string | null;
  plannedRR?: number | null;
  compliant?: boolean | null;
  time: number; // UTC seconds (entry)
}

export interface Breakdown {
  count: number;
  wins: number;
  winRate: number | null;
  netR: number;
  avgR: number | null;
}

export interface PerformanceStats {
  count: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  netR: number;
  avgR: number | null;
  profitFactor: number | null; // null when there are no losing trades (undefined ratio)
  maxDrawdownR: number;
  avgPlannedRR: number | null;
  complianceRate: number | null;
  byDirection: Record<string, Breakdown>;
  bySession: Record<string, Breakdown>;
  bySymbol: Record<string, Breakdown>;
  byTimeframe: Record<string, Breakdown>;
  bySetup: Record<string, Breakdown>;
  sampleWarning: string | null;
}

export const METRIC_DEFINITIONS: Record<string, string> = {
  count: 'Number of closed trades in the selection.',
  winRate: 'Trades with R > 0 divided by all trades. Breakeven (R = 0) counts as not a win.',
  avgWinR: 'Mean R of winning trades.',
  avgLossR: 'Mean R of losing trades (negative).',
  netR: 'Sum of R over all trades.',
  avgR: 'Net R divided by the number of trades (expectancy per trade).',
  profitFactor: 'Sum of winning R divided by the absolute sum of losing R. Undefined (—) with no losses.',
  maxDrawdownR: 'Largest peak-to-trough decline of cumulative R, in trade order.',
  avgPlannedRR: 'Mean planned reward:risk at entry (to TP2).',
  complianceRate: 'Share of trades marked as following the ELF rules (only trades where compliance was recorded).',
};

const EPS = 1e-9;

function breakdown(records: TradeRecordForStats[], key: (r: TradeRecordForStats) => string | null | undefined) {
  const out: Record<string, Breakdown> = {};
  for (const r of records) {
    const k = key(r) || 'unspecified';
    const b = (out[k] ??= { count: 0, wins: 0, winRate: null, netR: 0, avgR: null });
    b.count++;
    if (r.r > EPS) b.wins++;
    b.netR += r.r;
  }
  for (const b of Object.values(out)) {
    b.winRate = b.count ? b.wins / b.count : null;
    b.avgR = b.count ? b.netR / b.count : null;
  }
  return out;
}

export function sampleSizeWarning(n: number): string | null {
  if (n === 0) return 'No trades — nothing to evaluate.';
  if (n < 30) return `Only ${n} trades. Results are statistically unreliable; treat as anecdotal.`;
  if (n < 100) return `${n} trades. Small sample — confidence in these figures is limited.`;
  return null;
}

export function computeStats(records: TradeRecordForStats[]): PerformanceStats {
  const sorted = [...records].sort((a, b) => a.time - b.time);
  const wins = sorted.filter((r) => r.r > EPS);
  const losses = sorted.filter((r) => r.r < -EPS);
  const be = sorted.length - wins.length - losses.length;
  const netR = sorted.reduce((s, r) => s + r.r, 0);
  const grossWin = wins.reduce((s, r) => s + r.r, 0);
  const grossLoss = Math.abs(losses.reduce((s, r) => s + r.r, 0));
  let peak = 0;
  let cum = 0;
  let mdd = 0;
  for (const r of sorted) {
    cum += r.r;
    peak = Math.max(peak, cum);
    mdd = Math.max(mdd, peak - cum);
  }
  const planned = sorted.filter((r) => r.plannedRR != null && Number.isFinite(r.plannedRR));
  const comp = sorted.filter((r) => r.compliant != null);
  return {
    count: sorted.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: be,
    winRate: sorted.length ? wins.length / sorted.length : null,
    avgWinR: wins.length ? grossWin / wins.length : null,
    avgLossR: losses.length ? -grossLoss / losses.length : null,
    netR,
    avgR: sorted.length ? netR / sorted.length : null,
    profitFactor: grossLoss > EPS ? grossWin / grossLoss : null,
    maxDrawdownR: mdd,
    avgPlannedRR: planned.length ? planned.reduce((s, r) => s + (r.plannedRR as number), 0) / planned.length : null,
    complianceRate: comp.length ? comp.filter((r) => r.compliant).length / comp.length : null,
    byDirection: breakdown(sorted, (r) => r.direction),
    bySession: breakdown(sorted, (r) => r.session),
    bySymbol: breakdown(sorted, (r) => r.symbol),
    byTimeframe: breakdown(sorted, (r) => r.timeframe),
    bySetup: breakdown(sorted, (r) => r.setup),
    sampleWarning: sampleSizeWarning(sorted.length),
  };
}
