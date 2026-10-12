// Alerts: de-duplicated (UNIQUE event key), filtered by user preferences, delivered to
// in-app listeners (SSE → in-app toast + browser Notification while a tab is open) and to
// optional server-side channels (webhook). Channels are pluggable for future email/push.

import { EventEmitter } from 'node:events';
import type { EngineEvent } from '../engine/engine.js';
import { formatNy } from '../shared/time.js';
import type { Db } from './db.js';

export type AlertCategory = 'preliminary' | 'confirmation' | 'entry' | 'outcome' | 'invalidation' | 'feed' | 'plan';

export interface AlertPrefs {
  preset: 'all' | 'preliminary' | 'confirmation' | 'entry' | 'custom';
  categories: Record<AlertCategory, boolean>;
  browserNotifications: boolean;
  webhook: { enabled: boolean; url: string | null };
}

export const DEFAULT_ALERT_PREFS: AlertPrefs = {
  preset: 'all',
  categories: { preliminary: true, confirmation: true, entry: true, outcome: true, invalidation: true, feed: true, plan: true },
  browserNotifications: true,
  webhook: { enabled: false, url: null },
};

/** Apply a preset to the ELF signal categories (outcome / feed / plan / invalidation stay as set). */
export function applyPreset(p: AlertPrefs): AlertPrefs {
  const c = { ...p.categories };
  if (p.preset === 'all') Object.assign(c, { preliminary: true, confirmation: true, entry: true });
  if (p.preset === 'preliminary') Object.assign(c, { preliminary: true, confirmation: false, entry: false });
  if (p.preset === 'confirmation') Object.assign(c, { preliminary: false, confirmation: true, entry: false });
  if (p.preset === 'entry') Object.assign(c, { preliminary: false, confirmation: false, entry: true });
  return { ...p, categories: c };
}

export interface AlertRecord {
  id: number;
  eventKey: string;
  category: AlertCategory;
  type: string;
  provider: string | null;
  symbol: string | null;
  timeframe: string | null;
  direction: string | null;
  title: string;
  message: string;
  data: Record<string, unknown> | null;
  candleTime: number | null;
  createdAt: number;
  read: boolean;
}

export interface AlertChannel {
  name: string;
  send(alert: AlertRecord): Promise<void>;
}

export function categoryFor(type: EngineEvent['type']): AlertCategory | null {
  switch (type) {
    case 'sweep_preliminary':
      return 'preliminary';
    case 'confirmed':
      return 'confirmation';
    case 'entry_ready':
      return 'entry';
    case 'tp1':
    case 'tp2':
    case 'sl':
    case 'breakeven':
    case 'trade_expired':
    case 'trade_closed':
      return 'outcome';
    case 'expired':
    case 'invalidated':
    case 'filtered':
      return 'invalidation';
    default:
      return null; // bos / displacement / reclaim are drawn but not alerted
  }
}

const TITLES: Partial<Record<EngineEvent['type'], string>> = {
  sweep_preliminary: 'Preliminary sweep',
  confirmed: 'ELF confirmation',
  entry_ready: 'ENTRY READY',
  tp1: 'Target 1 reached',
  tp2: 'Target 2 reached',
  sl: 'Stop-loss reached',
  breakeven: 'Stopped at breakeven',
  trade_expired: 'Trade expired',
  expired: 'Setup expired',
  invalidated: 'Setup invalidated',
  filtered: 'Setup FILTERED',
};

export class WebhookChannel implements AlertChannel {
  name = 'webhook';
  constructor(private readonly getUrl: () => string | null, private readonly fetchFn: typeof fetch = fetch) {}
  async send(a: AlertRecord) {
    const url = this.getUrl();
    if (!url) return;
    await this.fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: a.title, message: a.message, text: `${a.title}\n${a.message}`, content: `**${a.title}**\n${a.message}`, alert: a }),
    });
  }
}

export class AlertService extends EventEmitter {
  private channels: AlertChannel[] = [];
  private lastFeedAlert = new Map<string, number>();

  constructor(private readonly db: Db, private readonly getPrefs: () => AlertPrefs) {
    super();
  }

  addChannel(c: AlertChannel) {
    this.channels.push(c);
  }

  fromEngineEvent(e: EngineEvent, ctx: { provider: string; symbol: string; timeframe: string; feedStatus: string }): AlertRecord | null {
    const category = categoryFor(e.type);
    if (!category) return null;
    if (e.type === 'sweep_preliminary' && e.data?.eligible === false) return null;
    const d = e.data ?? {};
    const parts = [e.message, `Candle ${formatNy(e.time)} (closed ${formatNy(e.closeTime, false)})`, `Feed: ${ctx.feedStatus}`];
    if (e.type === 'filtered' && Array.isArray(d.reasons)) parts.push(`Rejected: ${(d.reasons as string[]).join('; ')}`);
    return this.record({
      eventKey: `${ctx.provider}|${e.key}`,
      category,
      type: e.type,
      provider: ctx.provider,
      symbol: ctx.symbol,
      timeframe: ctx.timeframe,
      direction: e.direction ?? null,
      title: `${ctx.symbol} ${ctx.timeframe} · ${TITLES[e.type] ?? e.type}${e.direction ? ' ' + e.direction.toUpperCase() : ''}`,
      message: parts.join('\n'),
      data: { ...d, feedStatus: ctx.feedStatus, timezone: 'America/New_York' },
      candleTime: e.time,
    });
  }

  feedChange(key: string, symbol: string, timeframe: string, provider: string, status: string, prev: string, message: string): AlertRecord | null {
    const good = (s: string) => s === 'LIVE' || s === 'REST POLLING' || s === 'DELAYED';
    const bad = (s: string) => s === 'DISCONNECTED' || s === 'ERROR';
    let kind: 'down' | 'up' | null = null;
    if (good(prev) && bad(status)) kind = 'down';
    if (bad(prev) && good(status)) kind = 'up';
    if (!kind) return null;
    const now = Date.now();
    const last = this.lastFeedAlert.get(key + kind) ?? 0;
    if (now - last < 60_000) return null; // anti-flap
    this.lastFeedAlert.set(key + kind, now);
    return this.record({
      eventKey: `feed|${key}|${kind}|${now}`,
      category: 'feed',
      type: kind === 'down' ? 'feed_down' : 'feed_up',
      provider,
      symbol,
      timeframe,
      direction: null,
      title: `${symbol} ${timeframe} · Data feed ${kind === 'down' ? 'DISCONNECTED' : 'recovered'}`,
      message: `${provider}: ${prev} → ${status}. ${message}`,
      data: { status, prev },
      candleTime: null,
    });
  }

  plan(eventKey: string, title: string, message: string, data: Record<string, unknown>, symbol: string, timeframe: string, provider: string, direction: string) {
    return this.record({ eventKey, category: 'plan', type: 'plan', provider, symbol, timeframe, direction, title, message, data, candleTime: null });
  }

  /** Insert once; returns null when the key was already recorded or the category is muted. */
  record(a: Omit<AlertRecord, 'id' | 'createdAt' | 'read'>): AlertRecord | null {
    const prefs = applyPreset(this.getPrefs());
    if (!prefs.categories[a.category]) return null;
    const createdAt = Date.now();
    const res = this.db
      .prepare(
        'INSERT OR IGNORE INTO alerts (event_key, category, type, provider, symbol, timeframe, direction, title, message, data, candle_time, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(a.eventKey, a.category, a.type, a.provider, a.symbol, a.timeframe, a.direction, a.title, a.message, a.data ? JSON.stringify(a.data) : null, a.candleTime, createdAt);
    if (Number(res.changes) === 0) return null;
    const rec: AlertRecord = { ...a, id: Number(res.lastInsertRowid), createdAt, read: false };
    this.emit('alert', rec);
    if (prefs.webhook.enabled && prefs.webhook.url) {
      for (const ch of this.channels) ch.send(rec).catch(() => this.emit('channelError', ch.name));
    }
    return rec;
  }

  list(limit = 100, unreadOnly = false): AlertRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM alerts ${unreadOnly ? 'WHERE read = 0' : ''} ORDER BY id DESC LIMIT ?`)
      .all(limit) as any[];
    return rows.map((r) => ({
      id: r.id,
      eventKey: r.event_key,
      category: r.category,
      type: r.type,
      provider: r.provider,
      symbol: r.symbol,
      timeframe: r.timeframe,
      direction: r.direction,
      title: r.title,
      message: r.message,
      data: r.data ? JSON.parse(r.data) : null,
      candleTime: r.candle_time,
      createdAt: r.created_at,
      read: !!r.read,
    }));
  }

  markRead(id?: number) {
    if (id === undefined) this.db.prepare('UPDATE alerts SET read = 1').run();
    else this.db.prepare('UPDATE alerts SET read = 1 WHERE id = ?').run(id);
  }

  unreadCount(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM alerts WHERE read = 0').get() as any).n);
  }
}
