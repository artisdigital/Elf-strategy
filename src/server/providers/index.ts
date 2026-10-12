import { EventEmitter } from 'node:events';
import type { ProviderId } from '../../shared/types.js';
import type { Db } from '../db.js';
import { SecretBox } from '../secrets.js';
import { AlpacaAdapter } from './alpaca.js';
import { BinanceUsAdapter } from './binanceus.js';
import { OandaAdapter } from './oanda.js';
import type { Credentials, ProviderAdapter } from './types.js';
import { YahooAdapter } from './yahoo.js';

export interface ProviderSummary {
  id: ProviderId;
  name: string;
  description: string;
  enabled: boolean;
  requiresKey: boolean;
  configured: boolean;
  credentialSource: 'env' | 'stored' | 'none';
  credentialFields: { key: string; label: string; secret: boolean; help: string; options?: string[]; hasValue: boolean; value?: string }[];
  dataNotes: string[];
  timeframes: string[];
  supportsStreaming: boolean;
  delayed: boolean;
}

const ENV_MAP: Record<string, Record<string, string>> = {
  oanda: { token: 'OANDA_API_TOKEN', environment: 'OANDA_ENVIRONMENT', accountId: 'OANDA_ACCOUNT_ID' },
  alpaca: { keyId: 'ALPACA_API_KEY_ID', secretKey: 'ALPACA_API_SECRET_KEY', feed: 'ALPACA_DATA_FEED' },
};

export function defaultAdapters(): ProviderAdapter[] {
  return [new BinanceUsAdapter(), new OandaAdapter(), new AlpacaAdapter(), new YahooAdapter()];
}

/** Provider settings & credentials. Emits 'change' (providerId) when either changes. */
export class ProviderRegistry extends EventEmitter {
  readonly adapters = new Map<ProviderId, ProviderAdapter>();

  constructor(private readonly db: Db, private readonly box: SecretBox, adapters: ProviderAdapter[] = defaultAdapters(), private readonly env = process.env) {
    super();
    for (const a of adapters) this.adapters.set(a.id, a);
  }

  get(id: string): ProviderAdapter {
    const a = this.adapters.get(id as ProviderId);
    if (!a) throw new Error(`Unknown provider "${id}"`);
    return a;
  }

  isEnabled(id: ProviderId): boolean {
    const row = this.db.prepare('SELECT enabled FROM provider_settings WHERE id = ?').get(id) as { enabled: number } | undefined;
    return row ? row.enabled === 1 : true;
  }

  private stored(id: ProviderId): Credentials | null {
    const row = this.db.prepare('SELECT credentials_enc FROM provider_settings WHERE id = ?').get(id) as { credentials_enc: string | null } | undefined;
    if (!row?.credentials_enc) return null;
    try {
      return JSON.parse(this.box.decrypt(row.credentials_enc));
    } catch {
      return null;
    }
  }

  private fromEnv(id: ProviderId): Credentials | null {
    const map = ENV_MAP[id];
    if (!map) return null;
    const out: Credentials = {};
    for (const [k, envName] of Object.entries(map)) if (this.env[envName]) out[k] = String(this.env[envName]);
    return Object.keys(out).length ? out : null;
  }

  /** Server-side only. Environment variables take precedence over stored values. */
  credentials(id: ProviderId): Credentials | null {
    const s = this.stored(id);
    const e = this.fromEnv(id);
    if (!s && !e) return null;
    return { ...(s ?? {}), ...(e ?? {}) };
  }

  hasRequiredCredentials(id: ProviderId): boolean {
    const a = this.get(id);
    if (!a.requiresKey) return true;
    const c = this.credentials(id);
    return a.credentialFields.filter((f) => f.secret).every((f) => !!c?.[f.key]);
  }

  setEnabled(id: ProviderId, enabled: boolean) {
    this.get(id);
    this.db
      .prepare('INSERT INTO provider_settings (id, enabled, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at')
      .run(id, enabled ? 1 : 0, Date.now());
    this.emit('change', id);
  }

  /** Merge new values into stored credentials. Empty strings leave existing values unchanged. */
  setCredentials(id: ProviderId, values: Credentials) {
    const a = this.get(id);
    const allowed = new Set(a.credentialFields.map((f) => f.key));
    const cur = this.stored(id) ?? {};
    for (const [k, v] of Object.entries(values)) {
      if (!allowed.has(k)) throw new Error(`Unknown credential field "${k}"`);
      if (typeof v !== 'string') throw new Error(`Credential "${k}" must be a string`);
      if (v.trim() !== '') cur[k] = v.trim();
    }
    const enc = this.box.encrypt(JSON.stringify(cur));
    this.db
      .prepare('INSERT INTO provider_settings (id, enabled, credentials_enc, updated_at) VALUES (?, 1, ?, ?) ON CONFLICT(id) DO UPDATE SET credentials_enc = excluded.credentials_enc, updated_at = excluded.updated_at')
      .run(id, enc, Date.now());
    this.emit('change', id);
  }

  clearCredentials(id: ProviderId) {
    this.db.prepare('UPDATE provider_settings SET credentials_enc = NULL, updated_at = ? WHERE id = ?').run(Date.now(), id);
    this.emit('change', id);
  }

  /** Safe summary for the client: never includes secret values. */
  summary(id: ProviderId): ProviderSummary {
    const a = this.get(id);
    const creds = this.credentials(id);
    const envCreds = this.fromEnv(id);
    return {
      id: a.id,
      name: a.name,
      description: a.description,
      enabled: this.isEnabled(a.id),
      requiresKey: a.requiresKey,
      configured: this.hasRequiredCredentials(a.id),
      credentialSource: envCreds ? 'env' : this.stored(a.id) ? 'stored' : 'none',
      credentialFields: a.credentialFields.map((f) => ({
        key: f.key,
        label: f.label,
        secret: f.secret,
        help: f.help,
        options: f.options,
        hasValue: !!creds?.[f.key],
        ...(f.secret ? {} : { value: creds?.[f.key] }),
      })),
      dataNotes: a.dataNotes,
      timeframes: a.timeframes,
      supportsStreaming: a.supportsStreaming,
      delayed: a.isDelayed(creds),
    };
  }

  list(): ProviderSummary[] {
    return [...this.adapters.keys()].map((id) => this.summary(id));
  }
}
