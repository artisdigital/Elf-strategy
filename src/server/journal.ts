import { z } from 'zod';
import type { Db } from './db.js';
import { computeStats, METRIC_DEFINITIONS } from '../engine/analytics.js';

const num = z.number().finite().nullable().optional();

export const journalInputSchema = z.object({
  kind: z.enum(['actual', 'hypothetical']),
  source: z.enum(['manual', 'signal', 'replay', 'plan', 'import']).default('manual'),
  trade_time: z.number().int().positive(),
  symbol: z.string().trim().min(1).max(40),
  provider: z.string().max(40).nullable().optional(),
  direction: z.enum(['long', 'short']),
  session: z.string().max(40).nullable().optional(),
  timeframe: z.string().max(10).nullable().optional(),
  entry: num,
  stop: num,
  target: num,
  exit_price: num,
  position_size: num,
  planned_rr: num,
  result_r: num,
  fees: num,
  outcome: z.enum(['tp1', 'tp2', 'target', 'sl', 'manual', 'breakeven', 'expired', 'cancelled', 'open']).nullable().optional(),
  rule_compliant: z.boolean().nullable().optional(),
  setup_type: z.string().max(60).nullable().optional(),
  emotion_rating: z.number().int().min(1).max(5).nullable().optional(),
  mistakes: z.string().max(5000).nullable().optional(),
  improvements: z.string().max(5000).nullable().optional(),
  notes: z.string().max(20000).nullable().optional(),
  lessons: z.string().max(5000).nullable().optional(),
  screenshot: z
    .string()
    .max(4_000_000)
    .refine((s) => /^data:image\/(png|jpeg|webp);base64,/.test(s), 'Screenshot must be a PNG/JPEG/WebP data URL')
    .nullable()
    .optional(),
  signal_id: z.string().max(80).nullable().optional(),
  plan_id: z.number().int().nullable().optional(),
  config_hash: z.string().max(40).nullable().optional(),
});

export type JournalInput = z.infer<typeof journalInputSchema>;
const COLUMNS = Object.keys(journalInputSchema.shape) as (keyof JournalInput)[];

/** Derive R from prices when not given (never overriding a recorded value). */
function derive(e: JournalInput): JournalInput {
  const out = { ...e };
  if (out.result_r == null && out.entry != null && out.stop != null && out.exit_price != null && out.entry !== out.stop) {
    const dir = out.direction === 'long' ? 1 : -1;
    const risk = Math.abs(out.entry - out.stop);
    const feeR = out.fees != null && out.position_size ? out.fees / (risk * out.position_size) : 0;
    out.result_r = ((out.exit_price - out.entry) * dir) / risk - feeR;
  }
  if (out.planned_rr == null && out.entry != null && out.stop != null && out.target != null && out.entry !== out.stop) {
    out.planned_rr = Math.abs(out.target - out.entry) / Math.abs(out.entry - out.stop);
  }
  return out;
}

export interface JournalFilter {
  kind?: 'actual' | 'hypothetical';
  symbol?: string;
  direction?: string;
  outcome?: string;
  session?: string;
  q?: string;
  from?: number;
  to?: number;
  limit?: number;
}

export class JournalService {
  constructor(private readonly db: Db) {}

  create(input: unknown) {
    const e = derive(journalInputSchema.parse(input));
    const now = Date.now();
    const cols = COLUMNS.filter((c) => e[c] !== undefined);
    const vals = cols.map((c) => (typeof e[c] === 'boolean' ? (e[c] ? 1 : 0) : (e[c] as any)));
    const res = this.db
      .prepare(`INSERT INTO journal (${cols.join(',')}, created_at, updated_at) VALUES (${cols.map(() => '?').join(',')}, ?, ?)`)
      .run(...vals, now, now);
    return this.get(Number(res.lastInsertRowid))!;
  }

  update(id: number, input: unknown) {
    const cur = this.get(id);
    if (!cur) throw new Error('Not found');
    const merged = { ...cur, ...(input as object) } as any;
    for (const k of ['id', 'created_at', 'updated_at']) delete merged[k];
    const e = journalInputSchema.parse(merged);
    const cols = COLUMNS;
    const vals = cols.map((c) => (typeof e[c] === 'boolean' ? (e[c] ? 1 : 0) : ((e[c] ?? null) as any)));
    this.db.prepare(`UPDATE journal SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, Date.now(), id);
    return this.get(id)!;
  }

  delete(id: number) {
    return Number(this.db.prepare('DELETE FROM journal WHERE id = ?').run(id).changes) > 0;
  }

  get(id: number) {
    const r = this.db.prepare('SELECT * FROM journal WHERE id = ?').get(id) as any;
    return r ? this.row(r) : undefined;
  }

  private row(r: any) {
    return { ...r, rule_compliant: r.rule_compliant === null ? null : !!r.rule_compliant };
  }

  list(f: JournalFilter = {}, withScreenshots = false) {
    const where: string[] = [];
    const args: any[] = [];
    if (f.kind) (where.push('kind = ?'), args.push(f.kind));
    if (f.symbol) (where.push('symbol = ?'), args.push(f.symbol));
    if (f.direction) (where.push('direction = ?'), args.push(f.direction));
    if (f.outcome) (where.push('outcome = ?'), args.push(f.outcome));
    if (f.session) (where.push('session = ?'), args.push(f.session));
    if (f.from) (where.push('trade_time >= ?'), args.push(f.from));
    if (f.to) (where.push('trade_time <= ?'), args.push(f.to));
    if (f.q) {
      where.push('(notes LIKE ? OR lessons LIKE ? OR mistakes LIKE ? OR improvements LIKE ? OR symbol LIKE ? OR setup_type LIKE ?)');
      const like = `%${f.q}%`;
      args.push(like, like, like, like, like, like);
    }
    const cols = withScreenshots ? '*' : `id, ${COLUMNS.filter((c) => c !== 'screenshot').join(', ')}, screenshot IS NOT NULL AS has_screenshot, created_at, updated_at`;
    const rows = this.db
      .prepare(`SELECT ${cols} FROM journal ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY trade_time DESC LIMIT ?`)
      .all(...args, Math.min(f.limit ?? 1000, 10000)) as any[];
    return rows.map((r) => this.row(r));
  }

  /** Statistics for ONE kind only — actual and hypothetical are never mixed. */
  analytics(kind: 'actual' | 'hypothetical', f: Omit<JournalFilter, 'kind'> = {}) {
    const rows = this.list({ ...f, kind, limit: 10000 }).filter((r: any) => r.result_r != null && r.outcome !== 'open' && r.outcome !== 'cancelled');
    const excluded = this.list({ ...f, kind, limit: 10000 }).length - rows.length;
    const stats = computeStats(
      rows.map((r: any) => ({
        r: r.result_r,
        direction: r.direction,
        session: r.session,
        symbol: r.symbol,
        timeframe: r.timeframe,
        setup: r.setup_type,
        plannedRR: r.planned_rr,
        compliant: r.rule_compliant,
        time: r.trade_time,
      })),
    );
    return { kind, stats, excludedWithoutResult: excluded, definitions: METRIC_DEFINITIONS };
  }

  toCsv(rows: any[]): string {
    const cols = ['id', ...COLUMNS.filter((c) => c !== 'screenshot'), 'created_at', 'updated_at'];
    const esc = (v: unknown) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(c === 'trade_time' ? new Date(r[c] * 1000).toISOString() : r[c])).join(','))].join('\n');
  }
}
