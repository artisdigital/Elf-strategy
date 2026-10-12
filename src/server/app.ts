import express, { type Request, type Response, type NextFunction } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';
import type { Candle, ProviderId, Timeframe } from '../shared/types.js';
import { CONFIG_FIELDS, ELF_V11_DEFAULTS, ELF_RULESET, CONFIG_SCHEMA_VERSION, parseConfig } from '../engine/config.js';
import { runBacktest, parameterSearch, BACKTEST_ENGINE_VERSION, type BacktestInput } from '../engine/backtest.js';
import { planTrade } from '../engine/planner.js';
import { openDb, type Db } from './db.js';
import { SecretBox, redact } from './secrets.js';
import { ProviderRegistry, defaultAdapters } from './providers/index.js';
import type { ProviderAdapter } from './providers/types.js';
import { ProviderError } from './providers/types.js';
import { CandleStore } from './candles.js';
import { FeedManager } from './feeds.js';
import { MonitorManager } from './monitor.js';
import { AlertService, WebhookChannel, type AlertRecord } from './alerts.js';
import { PlanService } from './plans.js';
import { JournalService } from './journal.js';
import { SettingsService } from './settings.js';
import { Auth } from './auth.js';

export interface AppContext {
  db: Db;
  dataDir: string;
  registry: ProviderRegistry;
  store: CandleStore;
  feeds: FeedManager;
  monitors: MonitorManager;
  alerts: AlertService;
  plans: PlanService;
  journal: JournalService;
  settings: SettingsService;
  auth: Auth;
}

export function createContext(opts: { dataDir: string; db?: Db; adapters?: ProviderAdapter[]; env?: NodeJS.ProcessEnv; feedOptions?: { pollMs?: number; preferStreaming?: boolean; maxBackoffMs?: number; closeGraceMs?: number }; password?: string }): AppContext {
  const db = opts.db ?? openDb(opts.dataDir);
  const box = new SecretBox(opts.dataDir, opts.env?.ELF_SECRET_KEY ?? process.env.ELF_SECRET_KEY);
  const registry = new ProviderRegistry(db, box, opts.adapters ?? defaultAdapters(), opts.env ?? process.env);
  const settings = new SettingsService(db);
  const store = new CandleStore(db, registry);
  const feeds = new FeedManager(registry, store, { historyBars: settings.app().chart.historyBars, ...opts.feedOptions });
  const alerts = new AlertService(db, () => settings.alertPrefs());
  alerts.addChannel(new WebhookChannel(() => settings.alertPrefs().webhook.url));
  const monitors = new MonitorManager(feeds, alerts, registry, () => settings.elf());
  const plans = new PlanService(db, feeds, alerts);
  const journal = new JournalService(db);
  const auth = new Auth(opts.password ?? process.env.ELF_APP_PASSWORD);
  feeds.on('status', (s, prev) => alerts.feedChange(s.key, s.symbol, s.timeframe, s.provider, s.status, prev, s.message));
  return { db, dataDir: opts.dataDir, registry, store, feeds, monitors, alerts, plans, journal, settings, auth };
}

export function startBackground(ctx: AppContext) {
  ctx.monitors.syncWatchlist(ctx.settings.watchlist());
  ctx.plans.sync();
}

export function stopBackground(ctx: AppContext) {
  ctx.plans.dispose();
  ctx.monitors.disposeAll();
  ctx.feeds.stopAll();
}

const TF = z.enum(['1m', '5m', '15m', '30m', '1h', '4h', '1d']);
const PROVIDER = z.enum(['binanceus', 'oanda', 'alpaca', 'yahoo']);
const SYMBOL = z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_=.\-/^]+$/, 'Invalid symbol');

const marketQuery = z.object({ provider: PROVIDER, symbol: SYMBOL, tf: TF });

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const wrap = (h: Handler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(h(req, res)).catch(next);
};

function sseInit(res: Response) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const hb = setInterval(() => res.write(': ping\n\n'), 20_000);
  return { send, stop: () => clearInterval(hb) };
}

export function createApp(ctx: AppContext) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    );
    next();
  });
  app.use(express.json({ limit: '6mb' }));

  const api = express.Router();
  api.get('/health', (_req, res) => res.json({ ok: true, time: Date.now(), auth: ctx.auth.enabled }));
  api.get('/auth/status', (req, res) => res.json({ enabled: ctx.auth.enabled, authed: ctx.auth.isAuthed(req) }));
  api.post('/auth/login', ctx.auth.login);
  api.post('/auth/logout', ctx.auth.logout);
  api.use(ctx.auth.middleware);

  // ── Providers ──────────────────────────────────────────────────────────────
  api.get('/providers', (_req, res) => res.json(ctx.registry.list()));
  api.put(
    '/providers/:id',
    wrap((req, res) => {
      const id = PROVIDER.parse(req.params.id) as ProviderId;
      const body = z.object({ enabled: z.boolean().optional(), credentials: z.record(z.string()).optional() }).parse(req.body);
      if (body.credentials) ctx.registry.setCredentials(id, body.credentials);
      if (body.enabled !== undefined) ctx.registry.setEnabled(id, body.enabled);
      res.json(ctx.registry.summary(id));
    }),
  );
  api.delete(
    '/providers/:id/credentials',
    wrap((req, res) => {
      const id = PROVIDER.parse(req.params.id) as ProviderId;
      ctx.registry.clearCredentials(id);
      res.json(ctx.registry.summary(id));
    }),
  );
  api.post(
    '/providers/:id/test',
    wrap(async (req, res) => {
      const id = PROVIDER.parse(req.params.id) as ProviderId;
      const creds = ctx.registry.credentials(id);
      const r = await ctx.registry.get(id).testConnection(creds);
      res.json({ ...r, message: redact(r.message, Object.values(creds ?? {})), testedAt: Date.now() });
    }),
  );
  api.get('/instruments', (req, res) => {
    const list = ctx.registry.list().flatMap((p) => ctx.registry.get(p.id).instruments().map((i) => ({ ...i, providerEnabled: p.enabled, providerConfigured: p.configured })));
    const provider = typeof req.query.provider === 'string' ? req.query.provider : null;
    res.json(provider ? list.filter((i) => i.provider === provider) : list);
  });
  api.get(
    '/instruments/spec',
    wrap(async (req, res) => {
      const q = z.object({ provider: PROVIDER, symbol: SYMBOL }).parse(req.query);
      const a = ctx.registry.get(q.provider);
      const spec = a.instrumentSpec ? await a.instrumentSpec(q.symbol, ctx.registry.credentials(q.provider as ProviderId)) : null;
      res.json({ spec });
    }),
  );

  // ── Candles & live stream ────────────────────────────────────────────────
  api.get(
    '/candles',
    wrap(async (req, res) => {
      const q = marketQuery
        .extend({ limit: z.coerce.number().int().min(1).max(5000).default(500), before: z.coerce.number().int().optional(), from: z.coerce.number().int().optional(), to: z.coerce.number().int().optional() })
        .parse(req.query);
      const p = q.provider as ProviderId;
      if (!ctx.registry.hasRequiredCredentials(p)) return res.status(400).json({ error: 'NEEDS KEY', status: 'NEEDS KEY' });
      let candles: Candle[];
      let source = 'provider';
      if (q.from != null && q.to != null) {
        const r = await ctx.store.getRange(p, q.symbol, q.tf as Timeframe, q.from, q.to);
        candles = r.candles;
        source = r.source;
      } else if (q.before != null) candles = await ctx.store.before(p, q.symbol, q.tf as Timeframe, q.before, q.limit);
      else candles = await ctx.store.latest(p, q.symbol, q.tf as Timeframe, q.limit);
      res.json({ provider: p, symbol: q.symbol, timeframe: q.tf, source, candles });
    }),
  );

  api.get('/feeds', (_req, res) => res.json({ feeds: ctx.feeds.states(), monitors: ctx.monitors.list() }));

  api.get('/stream', (req, res) => {
    const parsed = marketQuery.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join('; ') });
    const q = parsed.data;
    const monitor = ctx.monitors.acquire(q.provider as ProviderId, q.symbol, q.tf as Timeframe);
    const feed = monitor.feed;
    const { send, stop } = sseInit(res);
    send('init', { feed: feed.state, candles: feed.candles, closedThrough: feed.closedCandles().at(-1)?.time ?? null, monitor: monitor.current() });
    let lastSent = 0;
    let pending: Candle | null = null;
    let flushTimer: NodeJS.Timeout | null = null;
    const onUpdate = (c: Candle) => {
      pending = c;
      const now = Date.now();
      if (now - lastSent >= 500) {
        send('candle', c);
        lastSent = now;
        pending = null;
      } else if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = null;
          if (pending) send('candle', pending);
          lastSent = Date.now();
          pending = null;
        }, 500);
      }
    };
    const onClosed = (c: Candle) => send('closed', c);
    const onHistory = () => send('history', { candles: feed.candles, closedThrough: feed.closedCandles().at(-1)?.time ?? null });
    const onStatus = (s: unknown) => send('status', s);
    const onMonitor = (u: unknown) => send('monitor', u);
    feed.on('update', onUpdate);
    feed.on('closed', onClosed);
    feed.on('history', onHistory);
    feed.on('status', onStatus);
    monitor.on('update', onMonitor);
    req.on('close', () => {
      stop();
      if (flushTimer) clearTimeout(flushTimer);
      feed.off('update', onUpdate);
      feed.off('closed', onClosed);
      feed.off('history', onHistory);
      feed.off('status', onStatus);
      monitor.off('update', onMonitor);
      ctx.monitors.release(monitor);
    });
  });

  // ── Settings ─────────────────────────────────────────────────────────────
  api.get('/settings', (_req, res) => res.json({ elf: ctx.settings.elf(), app: ctx.settings.app() }));
  api.get('/config/meta', (_req, res) => res.json({ defaults: ELF_V11_DEFAULTS, fields: CONFIG_FIELDS, ruleset: ELF_RULESET, schemaVersion: CONFIG_SCHEMA_VERSION }));
  api.put('/settings/elf', (req, res) => {
    const r = ctx.settings.setElf(req.body);
    if (!r.ok) return res.status(400).json({ errors: r.errors });
    ctx.monitors.reconfigure();
    res.json(r);
  });
  api.post('/settings/elf/reset', (_req, res) => {
    const r = ctx.settings.resetElf();
    ctx.monitors.reconfigure();
    res.json(r);
  });
  api.put('/settings/app', (req, res) => {
    const r = ctx.settings.setApp(req.body);
    if (!r.ok) return res.status(400).json({ errors: r.errors });
    ctx.monitors.syncWatchlist(r.settings.watchlist as any);
    res.json(r);
  });

  // ── Alerts ───────────────────────────────────────────────────────────────
  api.get('/alerts', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json({ alerts: ctx.alerts.list(limit, req.query.unread === '1'), unread: ctx.alerts.unreadCount() });
  });
  api.post('/alerts/read', (req, res) => {
    const id = req.body?.id;
    ctx.alerts.markRead(typeof id === 'number' ? id : undefined);
    res.json({ ok: true, unread: ctx.alerts.unreadCount() });
  });
  api.post(
    '/alerts/test',
    wrap(async (_req, res) => {
      const rec = ctx.alerts.record({
        eventKey: `test|${Date.now()}`, category: 'feed', type: 'test', provider: null, symbol: 'TEST', timeframe: null, direction: null,
        title: 'Test alert', message: 'This is a test notification from your ELF Trading App.', data: null, candleTime: null,
      });
      res.json({ ok: !!rec, alert: rec, note: rec ? 'Delivered to in-app listeners and the webhook (if enabled).' : 'Feed/system alerts are muted in your preferences.' });
    }),
  );
  api.get('/alerts/stream', (req, res) => {
    const { send, stop } = sseInit(res);
    send('hello', { unread: ctx.alerts.unreadCount(), feeds: ctx.feeds.states() });
    const onAlert = (a: AlertRecord) => send('alert', a);
    const onStatus = (s: unknown) => send('feed', s);
    ctx.alerts.on('alert', onAlert);
    ctx.feeds.on('status', onStatus);
    req.on('close', () => {
      stop();
      ctx.alerts.off('alert', onAlert);
      ctx.feeds.off('status', onStatus);
    });
  });

  // ── Journal & analytics ──────────────────────────────────────────────────
  const journalFilter = z.object({
    kind: z.enum(['actual', 'hypothetical']).optional(), symbol: z.string().max(40).optional(), direction: z.enum(['long', 'short']).optional(),
    outcome: z.string().max(20).optional(), session: z.string().max(40).optional(), q: z.string().max(100).optional(),
    from: z.coerce.number().int().optional(), to: z.coerce.number().int().optional(), limit: z.coerce.number().int().optional(),
  });
  api.get('/journal', (req, res) => res.json(ctx.journal.list(journalFilter.parse(req.query))));
  api.get('/journal/export', (req, res) => {
    const f = journalFilter.parse(req.query);
    const rows = ctx.journal.list({ ...f, limit: 10000 });
    if (req.query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="elf-journal.csv"');
      return res.send(ctx.journal.toCsv(rows));
    }
    res.setHeader('Content-Disposition', 'attachment; filename="elf-journal.json"');
    res.json(rows);
  });
  api.get('/journal/:id', (req, res) => {
    const e = ctx.journal.get(Number(req.params.id));
    if (!e) return res.status(404).json({ error: 'Not found' });
    res.json(e);
  });
  api.post('/journal', (req, res) => res.status(201).json(ctx.journal.create(req.body)));
  api.put('/journal/:id', (req, res) => res.json(ctx.journal.update(Number(req.params.id), req.body)));
  api.delete('/journal/:id', (req, res) => res.json({ ok: ctx.journal.delete(Number(req.params.id)) }));
  api.get('/analytics', (req, res) => {
    const f = journalFilter.parse(req.query);
    res.json(ctx.journal.analytics(f.kind ?? 'actual', f));
  });

  // ── Trade planner & plans ───────────────────────────────────────────────
  api.post('/planner/calc', (req, res) => res.json(planTrade(req.body)));
  api.get('/plans', (_req, res) => res.json(ctx.plans.list()));
  api.post('/plans', (req, res) => {
    const b = z
      .object({
        provider: PROVIDER, symbol: SYMBOL, timeframe: TF, direction: z.enum(['long', 'short']),
        entry: z.number().positive(), stop: z.number().positive(), tp1: z.number().positive().nullable().optional(), tp2: z.number().positive().nullable().optional(),
        source: z.enum(['manual', 'signal']).default('manual'), signal_id: z.string().max(80).nullable().optional(), position_size: z.number().positive().nullable().optional(),
        notes: z.string().max(5000).nullable().optional(), status: z.enum(['planned', 'active']).optional(),
      })
      .parse(req.body);
    res.status(201).json(ctx.plans.create({ ...b, provider: b.provider as ProviderId, timeframe: b.timeframe as Timeframe, tp1: b.tp1 ?? null, tp2: b.tp2 ?? null, signal_id: b.signal_id ?? null, position_size: b.position_size ?? null, notes: b.notes ?? null }));
  });
  api.post('/plans/:id/activate', (req, res) => res.json(ctx.plans.setStatus(Number(req.params.id), 'active')));
  api.post('/plans/:id/cancel', (req, res) => res.json(ctx.plans.setStatus(Number(req.params.id), 'cancelled')));
  api.post('/plans/:id/close', (req, res) => res.json(ctx.plans.closeManually(Number(req.params.id), z.number().positive().parse(req.body?.exitPrice))));

  // ── Backtests ────────────────────────────────────────────────────────────
  const btSchema = z.object({
    name: z.string().max(100).nullable().optional(),
    provider: PROVIDER, symbol: SYMBOL, timeframe: TF,
    from: z.number().int(), to: z.number().int(),
    config: z.unknown().optional(),
    costs: z.object({ feeRatePerSide: z.number().min(0).max(0.05), slippageBps: z.number().min(0).max(500) }),
    risk: z.object({ startingEquity: z.number().positive(), riskPct: z.number().positive().max(100), maxRiskPct: z.number().positive().max(100) }),
    splitPct: z.number().min(0).max(95).default(0),
    intrabar: z.boolean().default(false),
  });

  async function prepareBacktest(body: unknown): Promise<{ input: BacktestInput; meta: Record<string, unknown> }> {
    const b = btSchema.parse(body);
    if (b.to <= b.from) throw new ProviderError('End date must be after start date', 'bad_request');
    const cfg = b.config === undefined ? { ok: true as const, config: ctx.settings.elf() } : parseConfig(b.config);
    if (!cfg.ok) throw new ProviderError(`Invalid config: ${cfg.errors.join('; ')}`, 'bad_request');
    const p = b.provider as ProviderId;
    if (!ctx.registry.hasRequiredCredentials(p)) throw new ProviderError('NEEDS KEY — configure this provider first', 'auth');
    const { candles } = await ctx.store.getRange(p, b.symbol, b.timeframe as Timeframe, b.from, b.to);
    if (candles.length < 50) throw new ProviderError(`Only ${candles.length} candles available for this range — not enough to test.`, 'bad_request');
    const htfTf = cfg.config.htfTimeframe as Timeframe;
    const htfFrom = b.from - (cfg.config.htfEmaLength * 3 + 10) * (htfTf === '1d' ? 86400 : htfTf === '4h' ? 14400 : 3600);
    let htf: Candle[] = [];
    const notes: string[] = [];
    if (cfg.config.htfBiasEnabled) {
      try {
        htf = (await ctx.store.getRange(p, b.symbol, htfTf, htfFrom, b.to)).candles;
      } catch (e: any) {
        notes.push(`HTF candles unavailable (${e.message}) — bias filter will reject setups.`);
      }
    }
    let intrabar: Candle[] | undefined;
    if (b.intrabar && b.timeframe !== '1m') {
      try {
        intrabar = (await ctx.store.getRange(p, b.symbol, '1m', b.from, b.to + 86400)).candles;
      } catch (e: any) {
        notes.push(`1m intrabar data unavailable (${e.message}) — ambiguous candles use the stop-first assumption.`);
      }
    }
    const splitTime = b.splitPct > 0 ? candles[Math.floor(candles.length * (1 - b.splitPct / 100))]?.time ?? null : null;
    return {
      input: { provider: p, symbol: b.symbol, timeframe: b.timeframe as Timeframe, candles, htfCandles: htf, intrabarCandles: intrabar, intrabarTimeframe: intrabar ? '1m' : undefined, config: cfg.config, costs: b.costs, risk: b.risk, splitTime },
      meta: { name: b.name ?? null, from: b.from, to: b.to, splitPct: b.splitPct, intrabar: b.intrabar, notes },
    };
  }

  api.post(
    '/backtests',
    wrap(async (req, res) => {
      const { input, meta } = await prepareBacktest(req.body);
      const result = runBacktest(input);
      result.notes.push(...((meta.notes as string[]) ?? []));
      const stored = { ...meta, provider: input.provider, symbol: input.symbol, timeframe: input.timeframe, config: input.config, costs: input.costs, risk: input.risk, splitTime: input.splitTime, engineVersion: BACKTEST_ENGINE_VERSION };
      const r = ctx.db
        .prepare('INSERT INTO backtests (name, input, result, data_hash, result_hash, created_at) VALUES (?,?,?,?,?,?)')
        .run((meta.name as string) ?? `${input.symbol} ${input.timeframe}`, JSON.stringify(stored), JSON.stringify(result), result.dataHash, result.resultHash, Date.now());
      res.status(201).json({ id: Number(r.lastInsertRowid), result });
    }),
  );
  api.post(
    '/backtests/search',
    wrap(async (req, res) => {
      const grid = z.array(z.object({ key: z.enum(['minRR', 'displacementAtrMult', 'sweepAtrMult', 'swingLength', 'maxConfirmBars', 'displacementBodyRatio']), values: z.array(z.number()).min(1).max(8) })).min(1).max(2).parse(req.body?.grid);
      const { input } = await prepareBacktest(req.body);
      if (input.splitTime == null) throw new ProviderError('Parameter search requires an out-of-sample split (splitPct > 0)', 'bad_request');
      const out = parameterSearch(input, grid as any);
      res.json({ rows: out.rows, best: out.best, outOfSample: out.outOfSample ? { stats: out.outOfSample.stats, resultHash: out.outOfSample.resultHash, trades: out.outOfSample.trades.length } : null });
    }),
  );
  api.get('/backtests', (_req, res) => {
    const rows = ctx.db.prepare('SELECT id, name, input, data_hash, result_hash, created_at, result FROM backtests ORDER BY id DESC LIMIT 100').all() as any[];
    res.json(
      rows.map((r) => {
        const result = JSON.parse(r.result);
        return { id: r.id, name: r.name, input: JSON.parse(r.input), dataHash: r.data_hash, resultHash: r.result_hash, createdAt: r.created_at, summary: { trades: result.stats.all.count, netR: result.stats.all.netR, winRate: result.stats.all.winRate } };
      }),
    );
  });
  api.get('/backtests/:id', (req, res) => {
    const r = ctx.db.prepare('SELECT * FROM backtests WHERE id = ?').get(Number(req.params.id)) as any;
    if (!r) return res.status(404).json({ error: 'Not found' });
    res.json({ id: r.id, name: r.name, input: JSON.parse(r.input), result: JSON.parse(r.result), createdAt: r.created_at });
  });
  api.post(
    '/backtests/:id/rerun',
    wrap(async (req, res) => {
      const r = ctx.db.prepare('SELECT * FROM backtests WHERE id = ?').get(Number(req.params.id)) as any;
      if (!r) return res.status(404).json({ error: 'Not found' });
      const stored = JSON.parse(r.input);
      const { input } = await prepareBacktest({ ...stored, splitPct: stored.splitPct ?? 0 });
      const again = runBacktest(input);
      res.json({ reproduced: again.dataHash === r.data_hash && again.resultHash === r.result_hash, dataMatches: again.dataHash === r.data_hash, original: { dataHash: r.data_hash, resultHash: r.result_hash }, rerun: { dataHash: again.dataHash, resultHash: again.resultHash } });
    }),
  );
  api.get('/backtests/:id/export', (req, res) => {
    const r = ctx.db.prepare('SELECT * FROM backtests WHERE id = ?').get(Number(req.params.id)) as any;
    if (!r) return res.status(404).json({ error: 'Not found' });
    const result = JSON.parse(r.result);
    if (req.query.format === 'csv') {
      const cols = ['id', 'direction', 'entryTime', 'exitTime', 'entry', 'stop', 'tp1', 'tp2', 'exit', 'outcome', 'grossR', 'netR', 'plannedRR', 'ambiguous', 'session', 'sample', 'riskAmount', 'pnl', 'equityAfter'];
      const lines = [cols.join(','), ...result.trades.map((t: any) => cols.map((c) => (c.endsWith('Time') && t[c] ? new Date(t[c] * 1000).toISOString() : t[c] ?? '')).join(','))];
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="elf-backtest-${r.id}.csv"`);
      return res.send(lines.join('\n'));
    }
    res.setHeader('Content-Disposition', `attachment; filename="elf-backtest-${r.id}.json"`);
    res.json({ input: JSON.parse(r.input), result });
  });
  api.delete('/backtests/:id', (req, res) => res.json({ ok: Number(ctx.db.prepare('DELETE FROM backtests WHERE id = ?').run(Number(req.params.id)).changes) > 0 }));

  // ── Replays ──────────────────────────────────────────────────────────────
  api.get('/replays', (_req, res) => {
    const rows = ctx.db.prepare('SELECT * FROM replays ORDER BY id DESC LIMIT 100').all() as any[];
    res.json(rows.map((r) => ({ ...r, config: JSON.parse(r.config), trades: JSON.parse(r.trades) })));
  });
  api.post('/replays', (req, res) => {
    const b = z
      .object({ provider: PROVIDER, symbol: SYMBOL, timeframe: TF, from_time: z.number().int(), to_time: z.number().int(), cursor_time: z.number().int().nullable().optional(), config: z.unknown(), notes: z.string().max(10000).nullable().optional(), trades: z.array(z.unknown()).max(1000) })
      .parse(req.body);
    const cfg = parseConfig(b.config);
    if (!cfg.ok) return res.status(400).json({ errors: cfg.errors });
    const r = ctx.db
      .prepare('INSERT INTO replays (provider, symbol, timeframe, from_time, to_time, cursor_time, config, notes, trades, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(b.provider, b.symbol, b.timeframe, b.from_time, b.to_time, b.cursor_time ?? null, JSON.stringify(cfg.config), b.notes ?? null, JSON.stringify(b.trades), Date.now());
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });
  api.delete('/replays/:id', (req, res) => res.json({ ok: Number(ctx.db.prepare('DELETE FROM replays WHERE id = ?').run(Number(req.params.id)).changes) > 0 }));

  api.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use('/api', api);

  // ── Static web client ─────────────────────────────────────────────────────
  const webDir = path.resolve(process.cwd(), 'dist/web');
  if (fs.existsSync(webDir)) {
    app.use(express.static(webDir, { index: false, maxAge: '1h', setHeaders: (res, file) => {
      if (file.endsWith('sw.js') || file.endsWith('.html') || file.endsWith('manifest.webmanifest')) res.setHeader('Cache-Control', 'no-cache');
    } }));
    app.get('*', (_req, res) => res.sendFile(path.join(webDir, 'index.html')));
  }

  // ── Errors (never leak credentials or stack traces) ───────────────────────
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input', details: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    if (err instanceof ProviderError) {
      const code = err.kind === 'auth' ? 401 : err.kind === 'rate_limit' ? 429 : err.kind === 'not_found' ? 404 : err.kind === 'bad_request' || err.kind === 'unsupported' ? 400 : 502;
      return res.status(code).json({ error: err.message, kind: err.kind });
    }
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
    const msg = err instanceof Error ? err.message : 'Internal error';
    res.status(/not found/i.test(msg) ? 404 : 400).json({ error: msg.slice(0, 300) });
  });
  return app;
}
