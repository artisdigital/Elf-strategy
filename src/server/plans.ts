// Trade plans: manually recorded or created from an ELF signal. An ACTIVE plan is monitored
// against closed candles (stop / TP1 / TP2) with the same outcome logic as the engine.
// Plans are decision-support records — nothing here places or tracks broker orders.

import type { Candle, ProviderId, Timeframe } from '../shared/types.js';
import { newTrade, stepTrade, rMultiple } from '../engine/trade.js';
import { formatNy } from '../shared/time.js';
import type { Db } from './db.js';
import type { FeedManager, Feed } from './feeds.js';
import type { AlertService } from './alerts.js';

export interface PlanRow {
  id: number;
  provider: ProviderId;
  symbol: string;
  timeframe: Timeframe;
  direction: 'long' | 'short';
  entry: number;
  stop: number;
  tp1: number | null;
  tp2: number | null;
  status: 'planned' | 'active' | 'closed' | 'cancelled';
  source: string;
  signal_id: string | null;
  position_size: number | null;
  tp1_hit: number;
  outcome: string | null;
  exit_price: number | null;
  exit_time: number | null;
  result_r: number | null;
  last_checked_time: number | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

export class PlanService {
  private watchers = new Map<string, { feed: Feed; handler: (c: Candle) => void }>();

  constructor(private readonly db: Db, private readonly feeds: FeedManager, private readonly alerts: AlertService) {}

  list(): PlanRow[] {
    return this.db.prepare('SELECT * FROM plans ORDER BY id DESC LIMIT 500').all() as unknown as PlanRow[];
  }

  get(id: number): PlanRow | undefined {
    return this.db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as unknown as PlanRow | undefined;
  }

  create(p: Pick<PlanRow, 'provider' | 'symbol' | 'timeframe' | 'direction' | 'entry' | 'stop' | 'tp1' | 'tp2' | 'source' | 'signal_id' | 'position_size' | 'notes'> & { status?: 'planned' | 'active' }) {
    const longOk = p.direction === 'long' ? p.stop < p.entry : p.stop > p.entry;
    if (!longOk) throw new Error(`Stop must be ${p.direction === 'long' ? 'below' : 'above'} entry for a ${p.direction}`);
    const now = Date.now();
    const tp1 = p.tp1 ?? (p.direction === 'long' ? p.entry + (p.entry - p.stop) : p.entry - (p.stop - p.entry));
    const res = this.db
      .prepare(
        'INSERT INTO plans (provider, symbol, timeframe, direction, entry, stop, tp1, tp2, status, source, signal_id, position_size, notes, created_at, updated_at, last_checked_time) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(p.provider, p.symbol, p.timeframe, p.direction, p.entry, p.stop, tp1, p.tp2, p.status ?? 'planned', p.source, p.signal_id, p.position_size, p.notes, now, now, Math.floor(now / 1000));
    this.sync();
    return this.get(Number(res.lastInsertRowid))!;
  }

  setStatus(id: number, status: 'active' | 'cancelled') {
    const now = Date.now();
    this.db.prepare('UPDATE plans SET status = ?, updated_at = ?, last_checked_time = ? WHERE id = ? AND status IN (\'planned\',\'active\')').run(status, now, Math.floor(now / 1000), id);
    if (status === 'cancelled') this.db.prepare("UPDATE plans SET outcome = 'cancelled' WHERE id = ?").run(id);
    this.sync();
    return this.get(id);
  }

  closeManually(id: number, exitPrice: number) {
    const p = this.get(id);
    if (!p || p.status !== 'active') throw new Error('Only active plans can be closed');
    const r = rMultiple({ direction: p.direction, entry: p.entry, risk: Math.abs(p.entry - p.stop) } as any, exitPrice);
    this.db.prepare("UPDATE plans SET status='closed', outcome='manual', exit_price=?, exit_time=?, result_r=?, updated_at=? WHERE id=?").run(exitPrice, Math.floor(Date.now() / 1000), r, Date.now(), id);
    this.sync();
    return this.get(id);
  }

  /** Subscribe to feeds for every active plan; unsubscribe when none remain. */
  sync() {
    const active = (this.db.prepare("SELECT * FROM plans WHERE status = 'active'").all() as unknown as PlanRow[]);
    const needed = new Set(active.map((p) => `${p.provider}:${p.symbol}:${p.timeframe}`));
    for (const [key, w] of this.watchers) {
      if (!needed.has(key)) {
        w.feed.off('closed', w.handler);
        this.feeds.release(w.feed);
        this.watchers.delete(key);
      }
    }
    for (const p of active) {
      const key = `${p.provider}:${p.symbol}:${p.timeframe}`;
      if (this.watchers.has(key)) continue;
      try {
        const feed = this.feeds.acquire(p.provider, p.symbol, p.timeframe);
        const handler = (c: Candle) => this.onClosed(key, c);
        feed.on('closed', handler);
        this.watchers.set(key, { feed, handler });
      } catch {
        /* provider removed */
      }
    }
  }

  onClosed(key: string, c: Candle) {
    const [provider, symbol, timeframe] = key.split(':');
    const plans = this.db
      .prepare("SELECT * FROM plans WHERE status = 'active' AND provider = ? AND symbol = ? AND timeframe = ?")
      .all(provider, symbol, timeframe) as unknown as PlanRow[];
    for (const p of plans) {
      // Only candles that OPENED after the plan was activated count.
      if (p.last_checked_time !== null && c.time < p.last_checked_time) continue;
      if (p.tp2 === null) continue;
      const t = newTrade(String(p.id), { direction: p.direction, entry: p.entry, stop: p.stop, tp1: p.tp1 ?? p.entry, tp2: p.tp2 }, 0, -1);
      t.tp1Hit = !!p.tp1_hit;
      const events = stepTrade(t, c);
      for (const e of events) {
        this.alerts.plan(
          `plan|${p.id}|${e.type}`,
          `${p.symbol} ${p.timeframe} · Plan #${p.id} ${e.type.toUpperCase()}${e.ambiguous ? ' (ambiguous candle)' : ''}`,
          `${p.direction.toUpperCase()} plan from ${p.entry}: ${e.type.toUpperCase()} at ${e.price} on the ${formatNy(c.time)} candle.`,
          { planId: p.id, price: e.price, ambiguous: e.ambiguous },
          p.symbol,
          p.timeframe,
          p.provider,
          p.direction,
        );
      }
      const now = Date.now();
      if (t.status === 'closed') {
        this.db.prepare("UPDATE plans SET status='closed', outcome=?, exit_price=?, exit_time=?, result_r=?, tp1_hit=?, updated_at=? WHERE id=?").run(t.outcome, t.exitPrice, c.time, t.resultR, t.tp1Hit ? 1 : 0, now, p.id);
      } else if (t.tp1Hit && !p.tp1_hit) {
        this.db.prepare('UPDATE plans SET tp1_hit = 1, updated_at = ? WHERE id = ?').run(now, p.id);
      }
    }
  }

  dispose() {
    for (const w of this.watchers.values()) {
      w.feed.off('closed', w.handler);
      this.feeds.release(w.feed);
    }
    this.watchers.clear();
  }
}
