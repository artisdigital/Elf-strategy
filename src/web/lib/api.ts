import type { ElfConfig, ConfigFieldMeta } from '../../engine/config';
import type { ProviderSummary } from '../../server/providers/index';
import type { AppSettings } from '../../server/settings';
import type { AlertRecord } from '../../server/alerts';
import type { Candle, InstrumentInfo, ProviderId, Timeframe } from '../../shared/types';

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly details?: string[]) {
    super(message);
  }
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    if (res.status === 401 && data?.error === 'Login required') window.dispatchEvent(new Event('elf:login-required'));
    const details = data?.details ?? data?.errors;
    throw new ApiError(data?.error ?? (Array.isArray(details) ? details.join('; ') : `HTTP ${res.status}`), res.status, details);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => req<T>('GET', url),
  post: <T>(url: string, body?: unknown) => req<T>('POST', url, body ?? {}),
  put: <T>(url: string, body?: unknown) => req<T>('PUT', url, body ?? {}),
  del: <T>(url: string) => req<T>('DELETE', url),
};

export type { ElfConfig, ConfigFieldMeta, ProviderSummary, AppSettings, AlertRecord, Candle, InstrumentInfo, ProviderId, Timeframe };

export interface Market {
  provider: ProviderId;
  symbol: string;
  timeframe: Timeframe;
}

export const marketQs = (m: Market) => `provider=${encodeURIComponent(m.provider)}&symbol=${encodeURIComponent(m.symbol)}&tf=${encodeURIComponent(m.timeframe)}`;
