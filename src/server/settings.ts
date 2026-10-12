import { z } from 'zod';
import type { Db } from './db.js';
import { getSetting, putSetting } from './db.js';
import { configHash, defaultConfig, parseConfig, type ElfConfig } from '../engine/config.js';
import { DEFAULT_ALERT_PREFS, type AlertPrefs } from './alerts.js';
import type { WatchItem } from './monitor.js';

const tf = z.enum(['1m', '5m', '15m', '30m', '1h', '4h', '1d']);
const provider = z.enum(['binanceus', 'oanda', 'alpaca', 'yahoo']);
const color = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/);

export const appSettingsSchema = z.object({
  defaultMarket: z.object({ provider, symbol: z.string().min(1).max(40), timeframe: tf }),
  watchlist: z.array(z.object({ provider, symbol: z.string().min(1).max(40), timeframe: tf })).max(20),
  alerts: z.object({
    preset: z.enum(['all', 'preliminary', 'confirmation', 'entry', 'custom']),
    categories: z.object({ preliminary: z.boolean(), confirmation: z.boolean(), entry: z.boolean(), outcome: z.boolean(), invalidation: z.boolean(), feed: z.boolean(), plan: z.boolean() }),
    browserNotifications: z.boolean(),
    push: z.boolean(),
    webhook: z.object({ enabled: z.boolean(), url: z.string().url().startsWith('https://').nullable() }),
  }),
  chart: z.object({
    historyBars: z.number().int().min(200).max(5000),
    visibility: z.object({
      sessions: z.boolean(), levels: z.boolean(), swings: z.boolean(), sweeps: z.boolean(), bos: z.boolean(), displacement: z.boolean(),
      fvg: z.boolean(), orderBlocks: z.boolean(), plan: z.boolean(), outcomes: z.boolean(), volume: z.boolean(),
    }),
    colors: z.object({
      up: color, down: color, accent: color, liquidityHigh: color, liquidityLow: color, sweep: color, bos: color,
      fvgBull: color, fvgBear: color, obBull: color, obBear: color, entry: color, stop: color, target: color, session: color,
    }),
  }),
  risk: z.object({ accountBalance: z.number().positive(), riskPct: z.number().positive().max(100), maxRiskPct: z.number().positive().max(100) }),
  backtest: z.object({ feeRatePerSide: z.number().min(0).max(0.05), slippageBps: z.number().min(0).max(500), startingEquity: z.number().positive(), riskPct: z.number().positive().max(100) }),
});

export type AppSettings = z.infer<typeof appSettingsSchema>;

export const DEFAULT_APP_SETTINGS: AppSettings = {
  defaultMarket: { provider: 'binanceus', symbol: 'BTCUSD', timeframe: '15m' },
  watchlist: [{ provider: 'binanceus', symbol: 'BTCUSD', timeframe: '15m' }],
  alerts: DEFAULT_ALERT_PREFS as AppSettings['alerts'],
  chart: {
    historyBars: 1000,
    visibility: { sessions: true, levels: true, swings: false, sweeps: true, bos: true, displacement: true, fvg: true, orderBlocks: true, plan: true, outcomes: true, volume: true },
    colors: {
      up: '#26a69a', down: '#ef5350', accent: '#10b981', liquidityHigh: '#f59e0b', liquidityLow: '#38bdf8', sweep: '#e879f9', bos: '#a3e635',
      fvgBull: '#10b98133', fvgBear: '#f43f5e33', obBull: '#22c55e40', obBear: '#ef444440', entry: '#e5e7eb', stop: '#ef4444', target: '#10b981', session: '#64748b',
    },
  },
  risk: { accountBalance: 10000, riskPct: 0.5, maxRiskPct: 0.75 }, // ELF checklists: risk 0.25–0.5% per trade
  backtest: { feeRatePerSide: 0.001, slippageBps: 2, startingEquity: 10000, riskPct: 0.5 },
};

function deepMerge(base: any, over: any): any {
  if (Array.isArray(base) || Array.isArray(over) || typeof base !== 'object' || base === null || typeof over !== 'object' || over === null) return over === undefined ? base : over;
  const out: any = { ...base };
  for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
  return out;
}

export class SettingsService {
  constructor(private readonly db: Db) {}

  elf(): ElfConfig {
    const stored = getSetting<unknown>(this.db, 'elfConfig');
    if (!stored) return defaultConfig();
    const r = parseConfig(stored);
    return r.ok ? r.config : defaultConfig();
  }

  /** Validate, persist, and archive the exact config (by hash) for later reproduction. */
  setElf(input: unknown): { ok: true; config: ElfConfig; hash: string } | { ok: false; errors: string[] } {
    const r = parseConfig(input);
    if (!r.ok) return r;
    putSetting(this.db, 'elfConfig', r.config);
    const hash = configHash(r.config);
    this.db.prepare('INSERT OR IGNORE INTO config_versions (hash, config, created_at) VALUES (?, ?, ?)').run(hash, JSON.stringify(r.config), Date.now());
    return { ok: true, config: r.config, hash };
  }

  resetElf() {
    return this.setElf(defaultConfig());
  }

  configVersion(hash: string): ElfConfig | null {
    const row = this.db.prepare('SELECT config FROM config_versions WHERE hash = ?').get(hash) as { config: string } | undefined;
    return row ? JSON.parse(row.config) : null;
  }

  app(): AppSettings {
    const stored = getSetting<unknown>(this.db, 'app');
    const merged = deepMerge(DEFAULT_APP_SETTINGS, stored ?? {});
    const r = appSettingsSchema.safeParse(merged);
    return r.success ? r.data : DEFAULT_APP_SETTINGS;
  }

  setApp(partial: unknown): { ok: true; settings: AppSettings } | { ok: false; errors: string[] } {
    const merged = deepMerge(this.app(), partial ?? {});
    const r = appSettingsSchema.safeParse(merged);
    if (!r.success) return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
    putSetting(this.db, 'app', r.data);
    return { ok: true, settings: r.data };
  }

  alertPrefs(): AlertPrefs {
    return this.app().alerts as AlertPrefs;
  }

  watchlist(): WatchItem[] {
    return this.app().watchlist as WatchItem[];
  }
}
