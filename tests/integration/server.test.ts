import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp, createContext, stopBackground, type AppContext } from '../../src/server/app.js';
import { openDb } from '../../src/server/db.js';
import { Feed } from '../../src/server/feeds.js';
import { FakeAdapter } from './fakeProvider.js';
import { OandaAdapter } from '../../src/server/providers/oanda.js';
import { AlpacaAdapter } from '../../src/server/providers/alpaca.js';
import { YahooAdapter } from '../../src/server/providers/yahoo.js';
import type { Candle, FeedState } from '../../src/shared/types.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'elf-test-'));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 4000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await wait(20);
  }
}

const contexts: AppContext[] = [];
function makeCtx(opts: { adapter?: FakeAdapter; password?: string; dir?: string } = {}) {
  const adapter = opts.adapter ?? new FakeAdapter();
  const dir = opts.dir ?? tmp();
  const ctx = createContext({
    dataDir: dir,
    adapters: [adapter, new OandaAdapter(async () => new Response('{}')), new AlpacaAdapter(), new YahooAdapter()],
    env: { ELF_SECRET_KEY: '' } as any,
    feedOptions: { pollMs: 40, preferStreaming: false, maxBackoffMs: 40, closeGraceMs: 0 },
    password: opts.password ?? '',
  });
  contexts.push(ctx);
  return { ctx, adapter, dir };
}

async function serve(ctx: AppContext) {
  const app = createApp(ctx);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

afterEach(() => {
  while (contexts.length) stopBackground(contexts.pop()!);
});

describe('Feed: closed candles, disconnection and recovery', () => {
  it('emits each closed candle once, reports honest REST POLLING status, recovers with gap fill', async () => {
    const { ctx, adapter } = makeCtx();
    const feed = new Feed('binanceus', 'FAKE', '1m', ctx.registry, ctx.store, { historyBars: 200, pollMs: 30, maxBackoffMs: 40, closeGraceMs: 0, preferStreaming: false });
    const statuses: FeedState['status'][] = [];
    const closed: Candle[] = [];
    let history: Candle[] = [];
    feed.on('status', (s: FeedState) => statuses.push(s.status));
    feed.on('closed', (c: Candle) => closed.push(c));
    feed.on('history', (h: Candle[]) => (history = h));
    await feed.start();
    await until(() => statuses.includes('REST POLLING'));
    expect(history.length).toBe(200);
    expect(feed.state.transport).toBe('rest');
    expect(feed.state.status).not.toBe('LIVE');

    // market moves: the forming candle becomes closed exactly once
    const before = closed.length;
    adapter.advance();
    await until(() => closed.length > before);
    await wait(150);
    const times = closed.map((c) => c.time);
    expect(new Set(times).size).toBe(times.length);

    // outage
    adapter.fail = 'network';
    await until(() => feed.state.status === 'DISCONNECTED');
    expect(feed.state.message).toMatch(/Network error/);
    // candles that happen during the outage
    adapter.advance();
    adapter.advance();
    adapter.advance();
    const lastBefore = closed.at(-1)!.time;
    adapter.fail = 'none';
    await until(() => feed.state.status === 'REST POLLING');
    await until(() => closed.at(-1)!.time >= lastBefore + 3 * 60);
    // gap filled in order, nothing duplicated
    const after = closed.filter((c) => c.time > lastBefore).map((c) => c.time);
    expect(after).toEqual([...after].sort((a, b) => a - b));
    expect(new Set(closed.map((c) => c.time)).size).toBe(closed.length);
    feed.stop();
  });

  it('records feed disconnect / recovery alerts once per transition', async () => {
    const { ctx, adapter } = makeCtx();
    const feed = ctx.feeds.acquire('binanceus', 'FAKE', '1m');
    await until(() => feed.state.status === 'REST POLLING');
    adapter.fail = 'network';
    await until(() => feed.state.status === 'DISCONNECTED', 8000);
    adapter.fail = 'none';
    await until(() => feed.state.status === 'REST POLLING', 8000);
    const types = ctx.alerts.list().map((a) => a.type);
    expect(types.filter((t) => t === 'feed_down')).toHaveLength(1);
    expect(types.filter((t) => t === 'feed_up')).toHaveLength(1);
  });

  it('reports NEEDS KEY for a keyed provider without credentials', async () => {
    const { ctx } = makeCtx();
    const feed = ctx.feeds.acquire('oanda', 'EUR_USD', '15m');
    await until(() => feed.state.status !== 'CONNECTING');
    expect(feed.state.status).toBe('NEEDS KEY');
  });
});

describe('Alerts', () => {
  it('de-duplicates by event key and honours category preferences', () => {
    const { ctx } = makeCtx();
    const ev = { type: 'entry_ready' as const, key: 'FAKE|1m|entry_ready|x1', time: 1, closeTime: 61, index: 1, direction: 'long' as const, message: 'ENTRY READY', data: {} };
    const c = { provider: 'binanceus', symbol: 'FAKE', timeframe: '1m', feedStatus: 'REST POLLING' };
    expect(ctx.alerts.fromEngineEvent(ev, c)).toBeTruthy();
    expect(ctx.alerts.fromEngineEvent(ev, c)).toBeNull();
    expect(ctx.alerts.list()).toHaveLength(1);
    expect(ctx.alerts.list()[0].message).toMatch(/Feed: REST POLLING/);
    // entry-only preset mutes preliminary sweeps
    ctx.settings.setApp({ alerts: { preset: 'entry' } });
    expect(ctx.alerts.fromEngineEvent({ ...ev, type: 'sweep_preliminary', key: 'k2', data: { eligible: true } }, c)).toBeNull();
    // ineligible sweeps never alert
    ctx.settings.setApp({ alerts: { preset: 'all' } });
    expect(ctx.alerts.fromEngineEvent({ ...ev, type: 'sweep_preliminary', key: 'k3', data: { eligible: false } }, c)).toBeNull();
  });
});

describe('Persistence', () => {
  it('journal entries and settings survive a restart', async () => {
    const dir = tmp();
    const a = makeCtx({ dir });
    const e = a.ctx.journal.create({ kind: 'actual', trade_time: 1_700_000_000, symbol: 'BTCUSD', direction: 'long', entry: 100, stop: 95, target: 115, exit_price: 110, notes: 'kept' });
    expect(e.result_r).toBeCloseTo(2, 10);
    expect(e.planned_rr).toBeCloseTo(3, 10);
    a.ctx.journal.create({ kind: 'hypothetical', source: 'replay', trade_time: 1_700_000_100, symbol: 'BTCUSD', direction: 'short', result_r: -1 });
    a.ctx.settings.setElf({ ...a.ctx.settings.elf(), minRR: 2.5 });
    a.ctx.db.close();

    const db2 = openDb(dir);
    const b = createContext({ dataDir: dir, db: db2, adapters: [new FakeAdapter()], password: '' });
    contexts.push(b);
    const list = b.journal.list();
    expect(list).toHaveLength(2);
    expect(b.journal.get(e.id)!.notes).toBe('kept');
    expect(b.settings.elf().minRR).toBe(2.5);
    // analytics never mix kinds
    expect(b.journal.analytics('actual').stats.count).toBe(1);
    expect(b.journal.analytics('actual').stats.netR).toBeCloseTo(2, 10);
    expect(b.journal.analytics('hypothetical').stats.netR).toBe(-1);
  });

  it('rejects invalid journal input', () => {
    const { ctx } = makeCtx();
    expect(() => ctx.journal.create({ kind: 'real', symbol: '', direction: 'up' })).toThrow();
    expect(() => ctx.journal.create({ kind: 'actual', trade_time: 1, symbol: 'X', direction: 'long', screenshot: 'javascript:alert(1)' })).toThrow();
  });
});

describe('Credentials security', () => {
  it('encrypts credentials at rest and never returns secret values', async () => {
    const { ctx, dir } = makeCtx();
    ctx.registry.setCredentials('oanda', { token: 'super-secret-token-123', environment: 'practice' });
    const raw = fs.readFileSync(path.join(dir, 'elf.db'));
    expect(raw.includes(Buffer.from('super-secret-token-123'))).toBe(false);
    expect(ctx.registry.credentials('oanda')!.token).toBe('super-secret-token-123');
    const { base, close } = await serve(ctx);
    const body = await (await fetch(`${base}/api/providers`)).text();
    expect(body).not.toContain('super-secret-token-123');
    expect(body).toContain('"hasValue":true');
    await close();
  });
});

describe('HTTP API', () => {
  it('validates settings, restores defaults, and serves candles + SSE stream', async () => {
    const { ctx } = makeCtx();
    const { base, close } = await serve(ctx);
    const bad = await fetch(`${base}/api/settings/elf`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ minRR: 1.2 }) });
    expect(bad.status).toBe(400);
    const odd = await fetch(`${base}/api/settings/elf`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ minRR: 2.3 }) });
    expect(odd.status).toBe(400); // 0.5 steps only
    const ok = await fetch(`${base}/api/settings/elf`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ minRR: 2 }) });
    expect(ok.status).toBe(200);
    const reset = await (await fetch(`${base}/api/settings/elf/reset`, { method: 'POST' })).json();
    expect(reset.config.minRR).toBe(3);
    expect(reset.config.sweepAtrMult).toBe(0.05);

    const c = await (await fetch(`${base}/api/candles?provider=binanceus&symbol=FAKE&tf=1m&limit=50`)).json();
    expect(c.candles).toHaveLength(50);

    const res = await fetch(`${base}/api/stream?provider=binanceus&symbol=FAKE&tf=1m`);
    const reader = res.body!.getReader();
    let text = '';
    const t0 = Date.now();
    while (!text.includes('event: init') && Date.now() - t0 < 4000) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    expect(text).toContain('event: init');
    const bad2 = await fetch(`${base}/api/stream?provider=nope&symbol=FAKE&tf=1m`);
    expect(bad2.status).toBe(400);
    await close();
  });

  it('runs a reproducible backtest on stored candles and re-verifies it', async () => {
    const adapter = new FakeAdapter(10, '1m');
    adapter.candles.set('15m', FakeAdapter.series(1500, '15m'));
    const { ctx } = makeCtx({ adapter });
    const { base, close } = await serve(ctx);
    const to = Math.floor(Date.now() / 1000) - 3600;
    const body = {
      provider: 'binanceus', symbol: 'FAKE', timeframe: '15m', from: to - 1400 * 900, to,
      costs: { feeRatePerSide: 0.001, slippageBps: 2 }, risk: { startingEquity: 10000, riskPct: 1, maxRiskPct: 2 }, splitPct: 30,
      config: { ...ctx.settings.elf(), htfBiasEnabled: false, sessionGate: 'off', minRR: 2 },
    };
    const r = await (await fetch(`${base}/api/backtests`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    expect(r.id).toBeGreaterThan(0);
    expect(r.result.candleCount).toBeGreaterThan(1000);
    expect(r.result.config.minRR).toBe(2);
    const rerun = await (await fetch(`${base}/api/backtests/${r.id}/rerun`, { method: 'POST' })).json();
    expect(rerun.reproduced).toBe(true);
    const csv = await (await fetch(`${base}/api/backtests/${r.id}/export?format=csv`)).text();
    expect(csv.split('\n')[0]).toContain('netR');
    await close();
  });

  it('requires login when a password is configured', async () => {
    const { ctx } = makeCtx({ password: 'hunter2-long-password' });
    const { base, close } = await serve(ctx);
    expect((await fetch(`${base}/api/settings`)).status).toBe(401);
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
    const bad = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'nope' }) });
    expect(bad.status).toBe(401);
    const good = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'hunter2-long-password' }) });
    const cookie = good.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    const authed = await fetch(`${base}/api/settings`, { headers: { cookie: cookie.split(';')[0] } });
    expect(authed.status).toBe(200);
    const forged = await fetch(`${base}/api/settings`, { headers: { cookie: `elf_session=${Date.now() + 1e9}.forged` } });
    expect(forged.status).toBe(401);
    await close();
  });

  it('manages a plan from active to closed via closed candles', async () => {
    const adapter = new FakeAdapter(50, '1m');
    const { ctx } = makeCtx({ adapter });
    const last = adapter.candles.get('1m')!.at(-1)!;
    const plan = ctx.plans.create({ provider: 'binanceus', symbol: 'FAKE', timeframe: '1m', direction: 'long', entry: last.close, stop: last.close - 1, tp1: null, tp2: last.close + 0.5, source: 'manual', signal_id: null, position_size: null, notes: null, status: 'active' });
    // candle that opened after activation hits TP2
    ctx.plans.onClosed('binanceus:FAKE:1m', { time: Math.floor(Date.now() / 1000) + 60, open: last.close, high: last.close + 0.6, low: last.close - 0.1, close: last.close + 0.4, volume: 1 });
    const p = ctx.plans.get(plan.id)!;
    expect(p.status).toBe('closed');
    expect(p.outcome).toBe('tp2');
    expect(p.result_r).toBeCloseTo(0.5, 10);
    expect(ctx.alerts.list().some((a) => a.category === 'plan')).toBe(true);
  });
});

describe('Provider adapters (stubbed responses in the documented formats)', () => {
  it('OANDA parses mid candles and sends the bearer token', async () => {
    let seen: { url: string; auth: string | null } | null = null;
    const a = new OandaAdapter(async (url: any, init: any) => {
      seen = { url: String(url), auth: init.headers.Authorization };
      return new Response(JSON.stringify({ instrument: 'EUR_USD', granularity: 'M15', candles: [{ complete: true, volume: 10, time: '1700000000.000000000', mid: { o: '1.1', h: '1.2', l: '1.0', c: '1.15' } }] }));
    });
    const c = await a.fetchCandles({ symbol: 'EUR_USD', timeframe: '15m', limit: 1 }, { token: 'tok' });
    expect(c).toEqual([{ time: 1700000000, open: 1.1, high: 1.2, low: 1.0, close: 1.15, volume: 10 }]);
    expect(seen!.auth).toBe('Bearer tok');
    expect(seen!.url).toContain('granularity=M15');
    expect(seen!.url).toContain('api-fxpractice.oanda.com');
  });

  it('Alpaca parses bars with pagination and key headers', async () => {
    const pages = [
      { bars: [{ t: '2024-01-02T14:30:00Z', o: 1, h: 2, l: 0.5, c: 1.5, v: 100 }], next_page_token: 'p2' },
      { bars: [{ t: '2024-01-02T14:45:00Z', o: 1.5, h: 2.5, l: 1, c: 2, v: 50 }], next_page_token: null },
    ];
    let n = 0;
    const a = new AlpacaAdapter(async (_u: any, init: any) => {
      expect(init.headers['APCA-API-KEY-ID']).toBe('id');
      return new Response(JSON.stringify(pages[n++]));
    });
    const c = await a.fetchCandles({ symbol: 'SPY', timeframe: '15m', start: 1704205800, limit: 10 }, { keyId: 'id', secretKey: 's' });
    expect(c.map((x) => x.time)).toEqual([1704205800, 1704206700]);
  });

  it('Yahoo skips null intervals instead of inventing prices and is always DELAYED', async () => {
    const a = new YahooAdapter(async () =>
      new Response(JSON.stringify({ chart: { result: [{ timestamp: [1, 2, 3], indicators: { quote: [{ open: [1, null, 3], high: [1, null, 3], low: [1, null, 3], close: [1, null, 3], volume: [0, 0, 0] }] } }] } })),
    );
    const c = await a.fetchCandles({ symbol: 'SPY', timeframe: '15m' });
    expect(c.map((x) => x.time)).toEqual([1, 3]);
    expect(a.isDelayed()).toBe(true);
  });

  it('classifies rate limits and auth failures', async () => {
    const a = new OandaAdapter(async () => new Response('{"errorMessage":"Insufficient authorization"}', { status: 401 }));
    await expect(a.fetchCandles({ symbol: 'EUR_USD', timeframe: '15m' }, { token: 'x' })).rejects.toMatchObject({ kind: 'auth' });
    const b = new OandaAdapter(async () => new Response('{}', { status: 429, headers: { 'retry-after': '7' } }));
    await expect(b.fetchCandles({ symbol: 'EUR_USD', timeframe: '15m' }, { token: 'x' })).rejects.toMatchObject({ kind: 'rate_limit', retryAfterSec: 7 });
  });
});
