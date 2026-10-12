// Live feed manager. One Feed per (provider, symbol, timeframe), shared by all subscribers.
//
// Status is reported honestly:
//   LIVE          — WebSocket stream connected and delivering messages
//   REST POLLING  — data arriving via periodic REST requests (never called LIVE)
//   DELAYED       — the source is delayed by nature (e.g. Yahoo)
//   DISCONNECTED  — repeated network failures / stale data; retrying with backoff
//   NEEDS KEY     — the provider requires credentials that are not configured
//   ERROR         — a non-retryable error (bad symbol, auth rejected, unsupported timeframe)

import { EventEmitter } from 'node:events';
import type { Candle, FeedState, FeedStatus, ProviderId, Timeframe } from '../shared/types.js';
import { tfSeconds } from '../shared/types.js';
import type { ProviderRegistry } from './providers/index.js';
import { ProviderError } from './providers/types.js';
import type { CandleStore } from './candles.js';
import { redact } from './secrets.js';

export interface FeedOptions {
  historyBars: number;
  pollMs?: number;
  wsStaleMs?: number;
  closeGraceMs?: number;
  maxBackoffMs?: number;
  preferStreaming?: boolean;
}

export function feedKey(provider: string, symbol: string, tf: string) {
  return `${provider}:${symbol}:${tf}`;
}

export interface FeedEvents {
  history: (candles: Candle[]) => void;
  update: (c: Candle) => void;
  closed: (c: Candle) => void;
  status: (s: FeedState, prev: FeedStatus) => void;
}

export class Feed extends EventEmitter {
  readonly key: string;
  candles: Candle[] = []; // closed + (optionally) the forming last candle
  private lastClosed: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private wsRetryTimer: NodeJS.Timeout | null = null;
  private staleTimer: NodeJS.Timeout | null = null;
  private stopWs: (() => void) | null = null;
  private failures = 0;
  private wsFailures = 0;
  private stopped = false;
  private wsActive = false;
  private lastWsMsg = 0;
  private historyLoaded = false;
  state: FeedState;
  private readonly tfMs: number;
  private readonly o: Required<FeedOptions>;

  constructor(
    readonly provider: ProviderId,
    readonly symbol: string,
    readonly timeframe: Timeframe,
    private readonly registry: ProviderRegistry,
    private readonly store: CandleStore | null,
    opts: FeedOptions,
  ) {
    super();
    this.key = feedKey(provider, symbol, timeframe);
    this.tfMs = tfSeconds(timeframe) * 1000;
    this.o = {
      historyBars: opts.historyBars,
      pollMs: opts.pollMs ?? (timeframe === '1m' ? 5000 : 10000),
      wsStaleMs: opts.wsStaleMs ?? 90_000,
      closeGraceMs: opts.closeGraceMs ?? 2000,
      maxBackoffMs: opts.maxBackoffMs ?? 60_000,
      preferStreaming: opts.preferStreaming ?? true,
    };
    this.state = { key: this.key, provider, symbol, timeframe, status: 'CONNECTING', transport: 'none', lastUpdate: null, lastCandleTime: null, message: 'Connecting…' };
  }

  private setStatus(status: FeedStatus, message: string, transport: FeedState['transport'] = this.state.transport) {
    const prev = this.state.status;
    const adapter = this.registry.get(this.provider);
    // A delayed source is never shown as LIVE / REST POLLING.
    if ((status === 'LIVE' || status === 'REST POLLING') && adapter.isDelayed(this.registry.credentials(this.provider))) {
      status = 'DELAYED';
      message = `${message} — source is delayed`;
    }
    const changed = prev !== status || this.state.message !== message || this.state.transport !== transport;
    this.state = { ...this.state, status, message, transport };
    if (changed) this.emit('status', this.state, prev);
  }

  async start() {
    this.stopped = false;
    const adapter = this.registry.get(this.provider);
    if (!this.registry.isEnabled(this.provider)) {
      this.setStatus('DISCONNECTED', `${adapter.name} is disabled in Market Data Providers`, 'none');
      return;
    }
    if (!this.registry.hasRequiredCredentials(this.provider)) {
      this.setStatus('NEEDS KEY', `${adapter.name} requires an API key (Market Data Providers page)`, 'none');
      return;
    }
    if (!adapter.timeframes.includes(this.timeframe)) {
      this.setStatus('ERROR', `${adapter.name} does not support ${this.timeframe}`, 'none');
      return;
    }
    await this.loadHistory();
    if (this.stopped || this.state.status === 'ERROR' || this.state.status === 'NEEDS KEY') return;
    if (this.o.preferStreaming && adapter.supportsStreaming && adapter.stream) this.openWs();
    else this.schedulePoll(0);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.wsRetryTimer) clearTimeout(this.wsRetryTimer);
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.stopWs?.();
    this.stopWs = null;
    this.timer = this.wsRetryTimer = this.staleTimer = null;
    this.wsActive = false;
  }

  async restart() {
    this.stop();
    this.candles = [];
    this.lastClosed = null;
    this.historyLoaded = false;
    this.failures = 0;
    this.wsFailures = 0;
    this.state = { ...this.state, status: 'CONNECTING', transport: 'none', message: 'Reconnecting…' };
    await this.start();
  }

  private async loadHistory() {
    try {
      const store = this.store;
      const list = store
        ? await store.latest(this.provider, this.symbol, this.timeframe, this.o.historyBars + 1)
        : await this.registry.get(this.provider).fetchCandles({ symbol: this.symbol, timeframe: this.timeframe, limit: this.o.historyBars + 1 }, this.registry.credentials(this.provider));
      this.candles = list;
      const closed = list.filter((c) => this.isClosedByTime(c) || c !== list[list.length - 1]);
      this.lastClosed = closed.length ? closed[closed.length - 1].time : null;
      if (closed.length && store) store.saveClosed(this.provider, this.symbol, this.timeframe, closed);
      this.historyLoaded = true;
      this.state = { ...this.state, lastUpdate: Date.now(), lastCandleTime: list.at(-1)?.time ?? null };
      this.emit('history', closed);
      if (list.length === 0) this.setStatus('ERROR', 'Provider returned no candles for this instrument', 'rest');
      else this.setStatus('REST POLLING', `History loaded (${closed.length} closed candles)`, 'rest');
      this.failures = 0;
    } catch (e) {
      this.handleError(e, true);
    }
  }

  private isClosedByTime(c: Candle) {
    return Date.now() >= c.time * 1000 + this.tfMs + this.o.closeGraceMs;
  }

  /** Merge one candle update. `closedFlag` comes from the stream when known. */
  ingest(c: Candle, closedFlag?: boolean) {
    const last = this.candles[this.candles.length - 1];
    if (this.lastClosed !== null && c.time <= this.lastClosed) return; // never rewrite closed candles
    if (!last || c.time > last.time) {
      // A newer candle proves the previous one has closed.
      if (last && (this.lastClosed === null || last.time > this.lastClosed)) this.markClosed(last);
      this.candles.push(c);
      if (this.candles.length > this.o.historyBars + 50) this.candles.splice(0, this.candles.length - (this.o.historyBars + 50));
    } else if (c.time === last.time) {
      this.candles[this.candles.length - 1] = c;
    } else return;
    this.state = { ...this.state, lastUpdate: Date.now(), lastCandleTime: c.time };
    if (closedFlag === true || (closedFlag === undefined && this.isClosedByTime(c))) this.markClosed(c);
    else this.emit('update', c);
  }

  private markClosed(c: Candle) {
    if (this.lastClosed !== null && c.time <= this.lastClosed) return;
    this.lastClosed = c.time;
    this.store?.saveClosed(this.provider, this.symbol, this.timeframe, [c]);
    this.emit('closed', c);
  }

  /** Close the forming candle by time when no newer data arrives (quiet markets). */
  private closeByTime() {
    const last = this.candles[this.candles.length - 1];
    if (last && (this.lastClosed === null || last.time > this.lastClosed) && this.isClosedByTime(last)) this.markClosed(last);
  }

  private schedulePoll(ms: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.poll(), ms);
  }

  private backoffMs(n: number) {
    return Math.min(this.o.maxBackoffMs, 2000 * Math.pow(2, Math.max(0, n - 1)));
  }

  private async poll() {
    if (this.stopped) return;
    const adapter = this.registry.get(this.provider);
    try {
      // After an outage, fetch everything since the last closed candle (gap fill).
      const since = this.lastClosed !== null ? this.lastClosed + tfSeconds(this.timeframe) : undefined;
      const wasDown = this.state.status === 'DISCONNECTED' || this.state.status === 'ERROR';
      const list = await adapter.fetchCandles(
        since !== undefined && wasDown ? { symbol: this.symbol, timeframe: this.timeframe, start: since, limit: adapter.pageSize } : { symbol: this.symbol, timeframe: this.timeframe, limit: 3 },
        this.registry.credentials(this.provider),
      );
      if (this.stopped) return;
      for (const c of list) this.ingest(c);
      this.closeByTime();
      this.failures = 0;
      if (!this.wsActive) {
        const note = adapter.supportsStreaming && this.wsFailures > 0 ? `WebSocket unavailable — polling REST every ${this.o.pollMs / 1000}s` : `Polling REST every ${this.o.pollMs / 1000}s`;
        this.setStatus('REST POLLING', note, 'rest');
        this.schedulePoll(this.o.pollMs);
      }
    } catch (e) {
      this.handleError(e, false);
    }
  }

  private handleError(e: unknown, duringHistory: boolean) {
    if (this.stopped) return;
    const creds = this.registry.credentials(this.provider);
    const msg = redact(e instanceof Error ? e.message : String(e), Object.values(creds ?? {}));
    if (e instanceof ProviderError && !e.retryable) {
      this.setStatus(e.kind === 'auth' && !this.registry.hasRequiredCredentials(this.provider) ? 'NEEDS KEY' : 'ERROR', msg, 'none');
      // Non-retryable: try again slowly in case the user fixes credentials / provider recovers.
      this.schedulePollOrHistory(5 * 60_000, duringHistory);
      return;
    }
    this.failures++;
    const wait = e instanceof ProviderError && e.retryAfterSec ? e.retryAfterSec * 1000 : this.backoffMs(this.failures);
    if (this.failures >= 3 || duringHistory) this.setStatus('DISCONNECTED', `${msg} — retry ${this.failures} in ${Math.round(wait / 1000)}s`, 'none');
    this.schedulePollOrHistory(wait, duringHistory);
  }

  private schedulePollOrHistory(ms: number, history: boolean) {
    if (this.stopped) return;
    if (history || !this.historyLoaded) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(async () => {
        await this.loadHistory();
        if (this.historyLoaded && !this.stopped) {
          const a = this.registry.get(this.provider);
          if (this.o.preferStreaming && a.supportsStreaming && a.stream && !this.wsActive) this.openWs();
          else this.schedulePoll(this.o.pollMs);
        }
      }, ms);
    } else this.schedulePoll(ms);
  }

  private openWs() {
    const adapter = this.registry.get(this.provider);
    if (!adapter.stream || this.stopped) return;
    // Keep REST polling running until the socket proves itself.
    if (!this.timer) this.schedulePoll(0);
    let opened = false;
    let gotData = false;
    this.stopWs = adapter.stream(
      this.symbol,
      this.timeframe,
      {
        onOpen: () => {
          opened = true;
        },
        onCandle: (c, closed) => {
          if (!gotData) {
            gotData = true;
            this.wsActive = true;
            this.wsFailures = 0;
            if (this.timer) clearTimeout(this.timer);
            this.timer = null;
          }
          this.lastWsMsg = Date.now();
          this.ingest(c, closed);
          this.setStatus('LIVE', 'WebSocket stream', 'websocket');
        },
        onClose: (reason) => {
          this.wsActive = false;
          this.stopWs = null;
          if (this.stopped) return;
          this.wsFailures++;
          // Fall back to REST immediately; retry the socket with backoff.
          this.setStatus('REST POLLING', `${opened ? 'WebSocket dropped' : 'WebSocket unavailable'} (${reason}) — polling REST every ${this.o.pollMs / 1000}s`, 'rest');
          this.schedulePoll(0);
          const wait = Math.min(5 * 60_000, this.backoffMs(this.wsFailures) * 2);
          if (this.wsRetryTimer) clearTimeout(this.wsRetryTimer);
          this.wsRetryTimer = setTimeout(() => this.openWs(), wait);
        },
      },
      this.registry.credentials(this.provider),
    );
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.staleTimer = setInterval(() => {
      this.closeByTime();
      if (this.wsActive && Date.now() - this.lastWsMsg > this.o.wsStaleMs) {
        this.stopWs?.();
        this.stopWs = null;
        this.wsActive = false;
        this.wsFailures++;
        this.setStatus('REST POLLING', 'WebSocket went silent — polling REST', 'rest');
        this.schedulePoll(0);
        if (this.wsRetryTimer) clearTimeout(this.wsRetryTimer);
        this.wsRetryTimer = setTimeout(() => this.openWs(), this.backoffMs(this.wsFailures));
      }
    }, 5000);
  }

  closedCandles(): Candle[] {
    if (this.lastClosed === null) return [];
    return this.candles.filter((c) => c.time <= this.lastClosed!);
  }

  formingCandle(): Candle | null {
    const last = this.candles[this.candles.length - 1];
    return last && (this.lastClosed === null || last.time > this.lastClosed) ? last : null;
  }
}

/** Ref-counted feed registry with idle shutdown. */
export class FeedManager extends EventEmitter {
  private feeds = new Map<string, { feed: Feed; refs: number; idleTimer: NodeJS.Timeout | null }>();

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly store: CandleStore | null,
    private readonly opts: FeedOptions,
    private readonly idleMs = 5 * 60_000,
  ) {
    super();
    registry.on('change', (id: string) => {
      for (const { feed } of this.feeds.values()) if (feed.provider === id) void feed.restart();
    });
  }

  acquire(provider: ProviderId, symbol: string, tf: Timeframe): Feed {
    this.registry.get(provider); // validates provider id
    const key = feedKey(provider, symbol, tf);
    let entry = this.feeds.get(key);
    if (!entry) {
      const feed = new Feed(provider, symbol, tf, this.registry, this.store, this.opts);
      entry = { feed, refs: 0, idleTimer: null };
      this.feeds.set(key, entry);
      feed.on('status', (s: FeedState, prev: FeedStatus) => this.emit('status', s, prev));
      this.emit('created', feed);
      void feed.start();
    }
    entry.refs++;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    return entry.feed;
  }

  release(feed: Feed) {
    const entry = this.feeds.get(feed.key);
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs === 0 && !entry.idleTimer) {
      entry.idleTimer = setTimeout(() => {
        if (entry!.refs === 0) {
          entry!.feed.stop();
          this.feeds.delete(feed.key);
          this.emit('removed', feed);
        }
      }, this.idleMs);
    }
  }

  get(key: string): Feed | undefined {
    return this.feeds.get(key)?.feed;
  }

  all(): Feed[] {
    return [...this.feeds.values()].map((e) => e.feed);
  }

  states(): FeedState[] {
    return this.all().map((f) => f.state);
  }

  stopAll() {
    for (const { feed, idleTimer } of this.feeds.values()) {
      if (idleTimer) clearTimeout(idleTimer);
      feed.stop();
    }
    this.feeds.clear();
  }
}
