import type { Candle, InstrumentInfo, ProviderId, Timeframe } from '../../shared/types.js';
import type { InstrumentSpec } from '../../engine/planner.js';

export type Credentials = Record<string, string>;

export interface CredentialField {
  key: string;
  label: string;
  secret: boolean;
  help: string;
  options?: string[];
}

export interface FetchCandlesArgs {
  symbol: string;
  timeframe: Timeframe;
  /** inclusive UTC seconds */
  start?: number;
  /** inclusive UTC seconds */
  end?: number;
  limit?: number;
}

export interface StreamHandlers {
  onCandle: (c: Candle, closed: boolean) => void;
  onOpen: () => void;
  onClose: (reason: string) => void;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'rate_limit' | 'not_found' | 'bad_request' | 'network' | 'server' | 'unsupported',
    readonly retryAfterSec?: number,
  ) {
    super(message);
  }
  get retryable() {
    return this.kind === 'rate_limit' || this.kind === 'network' || this.kind === 'server';
  }
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly name: string;
  readonly description: string;
  readonly requiresKey: boolean;
  readonly credentialFields: CredentialField[];
  /** Plain-language data limitations shown in the UI. */
  readonly dataNotes: string[];
  readonly timeframes: Timeframe[];
  /** True when real-time WebSocket candle streaming is implemented for this provider. */
  readonly supportsStreaming: boolean;
  /** Whether quotes from this source should always be labelled DELAYED. */
  isDelayed(creds: Credentials | null): boolean;
  /** Curated instrument list (exact provider identifiers). */
  instruments(): InstrumentInfo[];
  fetchCandles(args: FetchCandlesArgs, creds: Credentials | null): Promise<Candle[]>;
  /** Max candles per request (for pagination). */
  readonly pageSize: number;
  stream?(symbol: string, timeframe: Timeframe, handlers: StreamHandlers, creds: Credentials | null): () => void;
  testConnection(creds: Credentials | null): Promise<{ ok: boolean; message: string }>;
  instrumentSpec?(symbol: string, creds: Credentials | null): Promise<InstrumentSpec | null>;
}

export type FetchFn = typeof fetch;

/** fetch with timeout and uniform error classification. */
export async function httpJson(fetchFn: FetchFn, url: string, init: RequestInit = {}, timeoutMs = 15000): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchFn(url, { ...init, signal: ctrl.signal });
  } catch (e: any) {
    throw new ProviderError(`Network error: ${e?.cause?.code ?? e?.name ?? 'request failed'}`, 'network');
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (res.ok) return body;
  const msg = typeof body === 'object' && body ? body.msg ?? body.message ?? body.errorMessage ?? JSON.stringify(body).slice(0, 200) : String(text).slice(0, 200);
  const retryAfter = Number(res.headers.get('retry-after')) || undefined;
  if (res.status === 401 || res.status === 403) throw new ProviderError(`Authentication failed (${res.status}): ${msg}`, 'auth');
  if (res.status === 429 || res.status === 418) throw new ProviderError(`Rate limited by provider (${res.status})`, 'rate_limit', retryAfter ?? 30);
  if (res.status === 404) throw new ProviderError(`Not found: ${msg}`, 'not_found');
  if (res.status >= 500) throw new ProviderError(`Provider server error ${res.status}`, 'server');
  throw new ProviderError(`Request rejected (${res.status}): ${msg}`, 'bad_request');
}

export function sortDedupe(candles: Candle[]): Candle[] {
  const m = new Map<number, Candle>();
  for (const c of candles) if ([c.open, c.high, c.low, c.close].every(Number.isFinite)) m.set(c.time, c);
  return [...m.values()].sort((a, b) => a.time - b.time);
}
