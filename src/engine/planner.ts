// Manual trade planner / risk calculator — independent of the signal engine.
// Never invents instrument specifications: if a required input is missing it is reported
// in `missing` and no position size is produced.

export type SizingKind = 'units' | 'forex' | 'contract';

export interface InstrumentSpec {
  kind: SizingKind;
  /** Minimum price increment (display / rounding of prices). */
  tickSize?: number | null;
  /** Quantity increment (e.g. 0.00001 BTC, 1 share, 1 unit). */
  stepSize?: number | null;
  minQty?: number | null;
  /** Account-currency value of a 1.0 price move for ONE contract (contract kind). */
  contractMultiplier?: number | null;
  /** Units per standard lot (forex; usually 100 000). */
  lotSize?: number | null;
  /** Pip size (forex; 0.0001 for most pairs, 0.01 for JPY pairs). */
  pipSize?: number | null;
  /** Multiply a quote-currency amount by this to get account currency (1 when they match). */
  quoteToAccountRate?: number | null;
  source?: string;
}

export interface PlannerInput {
  balance: number;
  riskMode: 'percent' | 'cash';
  riskValue: number;
  entry: number;
  stop: number;
  target?: number | null;
  spec: InstrumentSpec | null;
  maxRiskPct: number;
}

export interface PlannerOutput {
  direction: 'long' | 'short' | null;
  riskAmount: number | null;
  riskPctOfBalance: number | null;
  stopDistance: number | null;
  rewardDistance: number | null;
  rr: number | null;
  positionSize: number | null;
  sizeUnit: string | null;
  lots: number | null;
  stopPips: number | null;
  /** Account-currency value of one pip for one standard lot (forex). */
  pipValuePerLot: number | null;
  actualRiskAfterRounding: number | null;
  missing: string[];
  warnings: string[];
  errors: string[];
}

const pos = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

export function planTrade(p: PlannerInput): PlannerOutput {
  const out: PlannerOutput = {
    direction: null,
    riskAmount: null,
    riskPctOfBalance: null,
    stopDistance: null,
    rewardDistance: null,
    rr: null,
    positionSize: null,
    sizeUnit: null,
    lots: null,
    stopPips: null,
    pipValuePerLot: null,
    actualRiskAfterRounding: null,
    missing: [],
    warnings: [],
    errors: [],
  };
  if (!pos(p.balance)) out.errors.push('Account balance must be greater than 0.');
  if (!pos(p.riskValue)) out.errors.push('Risk must be greater than 0.');
  if (!pos(p.entry)) out.errors.push('Entry price must be greater than 0.');
  if (!pos(p.stop)) out.errors.push('Stop-loss price must be greater than 0.');
  if (out.errors.length) return out;
  if (p.entry === p.stop) {
    out.errors.push('Stop-loss equals entry — risk per unit is zero.');
    return out;
  }
  out.direction = p.stop < p.entry ? 'long' : 'short';
  out.stopDistance = Math.abs(p.entry - p.stop);
  out.riskAmount = p.riskMode === 'percent' ? (p.balance * p.riskValue) / 100 : p.riskValue;
  out.riskPctOfBalance = (out.riskAmount / p.balance) * 100;
  if (out.riskPctOfBalance > p.maxRiskPct + 1e-9) {
    out.warnings.push(`Risk ${out.riskPctOfBalance.toFixed(2)}% exceeds your maximum of ${p.maxRiskPct}% per trade.`);
  }
  if (p.target != null && Number.isFinite(p.target)) {
    const right = out.direction === 'long' ? p.target > p.entry : p.target < p.entry;
    if (!right) out.errors.push(`Target is on the wrong side of entry for a ${out.direction}.`);
    else {
      out.rewardDistance = Math.abs(p.target - p.entry);
      out.rr = out.rewardDistance / out.stopDistance;
    }
  }

  const s = p.spec;
  if (!s) {
    out.missing.push('Instrument specification (sizing method, quantity step, value per price move)');
    return out;
  }
  const fx = s.quoteToAccountRate;
  if (!pos(fx)) out.missing.push('Quote → account currency conversion rate (1 if the quote currency is your account currency)');
  let valuePerUnit: number | null = null; // account currency per 1.0 price move per unit/contract
  if (s.kind === 'contract') {
    if (!pos(s.contractMultiplier)) out.missing.push('Contract multiplier (value of a 1.0 price move per contract)');
    else if (pos(fx)) valuePerUnit = s.contractMultiplier * fx;
    out.sizeUnit = 'contracts';
  } else {
    if (pos(fx)) valuePerUnit = fx;
    out.sizeUnit = s.kind === 'forex' ? 'units' : 'units';
  }
  if (s.kind === 'forex' && pos(s.pipSize)) {
    out.stopPips = out.stopDistance / s.pipSize;
    if (pos(fx)) out.pipValuePerLot = s.pipSize * (pos(s.lotSize) ? s.lotSize : 100_000) * fx;
  }
  if (valuePerUnit === null || out.missing.length) return out;

  let size = out.riskAmount / (out.stopDistance * valuePerUnit);
  const step = pos(s.stepSize) ? s.stepSize : s.kind === 'contract' ? 1 : null;
  if (step) size = Math.floor((size / step) * (1 + 1e-9)) * step; // relative tolerance: 0.0025000000000001 must not cost a unit
  else out.warnings.push('No quantity step known — size is not rounded to an exchange increment.');
  size = Number(size.toPrecision(12));
  if (pos(s.minQty) && size < s.minQty) {
    out.warnings.push(`Calculated size ${size} is below the minimum quantity ${s.minQty}. The trade cannot be sized within your risk.`);
  }
  if (size <= 0) out.warnings.push('Risk is too small for even one quantity increment.');
  out.positionSize = size;
  out.actualRiskAfterRounding = size * out.stopDistance * valuePerUnit;
  if (s.kind === 'forex') out.lots = size / (pos(s.lotSize) ? s.lotSize : 100_000);
  return out;
}
