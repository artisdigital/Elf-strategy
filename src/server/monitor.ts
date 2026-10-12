// Server-side ELF monitors: one engine per viewed / watch-listed market, fed only with
// CLOSED candles from the shared Feed. The browser displays the monitor's snapshot, so the
// dashboard, chart overlays and alerts all come from the same computation.

import { EventEmitter } from 'node:events';
import type { Candle, ProviderId, Timeframe } from '../shared/types.js';
import { tfSeconds } from '../shared/types.js';
import type { EngineEvent, EngineSnapshot } from '../engine/engine.js';
import { createEngine, type AnyElfEngine } from '../engine/factory.js';
import type { ElfConfig } from '../engine/config.js';
import type { Feed, FeedManager } from './feeds.js';
import type { AlertService } from './alerts.js';
import type { ProviderRegistry } from './providers/index.js';

export interface MonitorUpdate {
  key: string;
  snapshot: EngineSnapshot;
  events: EngineEvent[];
  htf: { status: 'ok' | 'unavailable' | 'loading'; message: string; count: number };
}

export class Monitor extends EventEmitter {
  engine: AnyElfEngine;
  private htfCandles: Candle[] = [];
  private htfTimer: NodeJS.Timeout | null = null;
  htfStatus: MonitorUpdate['htf'] = { status: 'loading', message: 'Loading higher-timeframe candles…', count: 0 };
  private liveSince: number;
  private recentEvents: EngineEvent[] = [];
  readonly key: string;
  private readonly onHistory = () => this.rebuild();
  private readonly onClosed = (c: Candle) => this.processClosed(c);

  constructor(
    readonly feed: Feed,
    private config: ElfConfig,
    private readonly alerts: AlertService,
    private readonly registry: ProviderRegistry,
  ) {
    super();
    this.key = feed.key;
    this.liveSince = Date.now();
    this.engine = this.newEngine();
    feed.on('history', this.onHistory);
    feed.on('closed', this.onClosed);
    if (feed.closedCandles().length) this.rebuild();
    void this.loadHtf();
    this.htfTimer = setInterval(() => void this.loadHtf(), 15 * 60_000);
  }

  private newEngine() {
    return createEngine(this.config, {
      provider: this.feed.provider,
      symbol: this.feed.symbol,
      timeframe: this.feed.timeframe,
      htfCandles: this.htfCandles,
      applyNewsBlackout: true,
    });
  }

  private async loadHtf() {
    const adapter = this.registry.get(this.feed.provider);
    const tf = this.config.htfTimeframe as Timeframe;
    if (!this.config.htfBiasEnabled) {
      this.htfStatus = { status: 'ok', message: 'HTF bias filter disabled', count: 0 };
      return;
    }
    if (!adapter.timeframes.includes(tf)) {
      this.htfStatus = { status: 'unavailable', message: `${adapter.name} does not provide ${tf} candles — bias unavailable (setups will be FILTERED while the filter is on)`, count: 0 };
      this.emitUpdate([]);
      return;
    }
    if (!this.registry.hasRequiredCredentials(this.feed.provider)) return;
    try {
      const list = await adapter.fetchCandles({ symbol: this.feed.symbol, timeframe: tf, limit: Math.max(this.config.htfEmaLength * 4, 250) }, this.registry.credentials(this.feed.provider));
      const changed = list.length !== this.htfCandles.length || list.at(-1)?.close !== this.htfCandles.at(-1)?.close;
      this.htfCandles = list;
      this.htfStatus = { status: 'ok', message: `${list.length} ${tf} candles (only closed candles are used)`, count: list.length };
      if (changed) this.engine.setHtfCandles(list);
      this.emitUpdate([]);
    } catch (e: any) {
      this.htfStatus = { status: 'unavailable', message: `HTF candles unavailable: ${e.message}`, count: this.htfCandles.length };
      this.emitUpdate([]);
    }
  }

  setConfig(config: ElfConfig) {
    const htfChanged = config.htfTimeframe !== this.config.htfTimeframe || config.htfBiasEnabled !== this.config.htfBiasEnabled;
    this.config = config;
    if (htfChanged) {
      this.htfCandles = [];
      void this.loadHtf();
    }
    this.rebuild();
  }

  /** Recompute from the feed's closed candles. Historical events are NOT alerted. */
  rebuild() {
    this.engine = this.newEngine();
    const events: EngineEvent[] = [];
    for (const c of this.feed.closedCandles()) {
      try {
        events.push(...this.engine.update(c));
      } catch {
        /* skip malformed */
      }
    }
    this.recentEvents = events.slice(-50);
    this.liveSince = Date.now();
    this.emitUpdate([]);
  }

  private processClosed(c: Candle) {
    let events: EngineEvent[] = [];
    try {
      events = this.engine.update(c);
    } catch {
      return;
    }
    this.recentEvents.push(...events);
    if (this.recentEvents.length > 50) this.recentEvents.splice(0, this.recentEvents.length - 50);
    // Alert only for candles that closed while we were running (never for history replays).
    const isLive = (c.time + tfSeconds(this.feed.timeframe)) * 1000 >= this.liveSince - tfSeconds(this.feed.timeframe) * 1000;
    if (isLive) {
      for (const e of events) this.alerts.fromEngineEvent(e, { provider: this.feed.provider, symbol: this.feed.symbol, timeframe: this.feed.timeframe, feedStatus: this.feed.state.status });
    }
    this.emitUpdate(events);
  }

  private emitUpdate(events: EngineEvent[]) {
    this.emit('update', { key: this.key, snapshot: this.engine.snapshot(), events, htf: this.htfStatus } satisfies MonitorUpdate);
  }

  current(): MonitorUpdate {
    return { key: this.key, snapshot: this.engine.snapshot(), events: [...this.recentEvents], htf: this.htfStatus };
  }

  dispose() {
    this.feed.off('history', this.onHistory);
    this.feed.off('closed', this.onClosed);
    if (this.htfTimer) clearInterval(this.htfTimer);
    this.removeAllListeners();
  }
}

export interface WatchItem {
  provider: ProviderId;
  symbol: string;
  timeframe: Timeframe;
}

export class MonitorManager {
  private monitors = new Map<string, { monitor: Monitor; refs: number; watch: boolean }>();

  constructor(
    private readonly feeds: FeedManager,
    private readonly alerts: AlertService,
    private readonly registry: ProviderRegistry,
    private getConfig: () => ElfConfig,
  ) {}

  acquire(provider: ProviderId, symbol: string, tf: Timeframe, watch = false): Monitor {
    const feed = this.feeds.acquire(provider, symbol, tf);
    let entry = this.monitors.get(feed.key);
    if (!entry) {
      entry = { monitor: new Monitor(feed, this.getConfig(), this.alerts, this.registry), refs: 0, watch: false };
      this.monitors.set(feed.key, entry);
    } else this.feeds.release(feed); // the monitor already holds one feed ref
    if (watch) entry.watch = true;
    else entry.refs++;
    return entry.monitor;
  }

  release(m: Monitor) {
    const entry = this.monitors.get(m.key);
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    this.maybeDispose(m.key);
  }

  private maybeDispose(key: string) {
    const entry = this.monitors.get(key);
    if (!entry || entry.refs > 0 || entry.watch) return;
    entry.monitor.dispose();
    this.feeds.release(entry.monitor.feed);
    this.monitors.delete(key);
  }

  /** Keep monitors running for the watch-list (alerts while no browser is open). */
  syncWatchlist(items: WatchItem[]) {
    const keys = new Set(items.map((w) => `${w.provider}:${w.symbol}:${w.timeframe}`));
    for (const [key, entry] of this.monitors) {
      if (entry.watch && !keys.has(key)) {
        entry.watch = false;
        this.maybeDispose(key);
      }
    }
    for (const w of items) {
      try {
        this.acquire(w.provider, w.symbol, w.timeframe, true);
      } catch {
        /* unknown provider in settings — ignored */
      }
    }
  }

  reconfigure() {
    const cfg = this.getConfig();
    for (const { monitor } of this.monitors.values()) monitor.setConfig(cfg);
  }

  list() {
    return [...this.monitors.values()].map((e) => ({ key: e.monitor.key, watch: e.watch, viewers: e.refs, state: e.monitor.engine.snapshot().state }));
  }

  get(key: string) {
    return this.monitors.get(key)?.monitor;
  }

  disposeAll() {
    for (const { monitor } of this.monitors.values()) monitor.dispose();
    this.monitors.clear();
  }
}
