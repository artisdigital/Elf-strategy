import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, type AlertRecord, type AppSettings, type ConfigFieldMeta, type ElfConfig, type InstrumentInfo, type Market, type ProviderSummary } from './api';
import type { FeedState } from '../../shared/types';

interface ConfigMeta {
  defaults: ElfConfig;
  fields: ConfigFieldMeta[];
  ruleset: string;
  schemaVersion: number;
}

interface Toast {
  id: number;
  title: string;
  message: string;
  kind: 'info' | 'alert' | 'error' | 'success';
}

interface Store {
  ready: boolean;
  authRequired: boolean;
  elf: ElfConfig | null;
  app: AppSettings | null;
  meta: ConfigMeta | null;
  providers: ProviderSummary[];
  instruments: (InstrumentInfo & { providerEnabled: boolean; providerConfigured: boolean })[];
  market: Market;
  setMarket: (m: Market) => void;
  refresh: () => Promise<void>;
  saveElf: (c: ElfConfig) => Promise<{ ok: boolean; errors?: string[] }>;
  resetElf: () => Promise<void>;
  saveApp: (p: Partial<AppSettings> | Record<string, unknown>) => Promise<{ ok: boolean; errors?: string[] }>;
  alerts: AlertRecord[];
  unread: number;
  markRead: (id?: number) => Promise<void>;
  feeds: Record<string, FeedState>;
  toasts: Toast[];
  toast: (t: Omit<Toast, 'id'>) => void;
  dismissToast: (id: number) => void;
  alertStreamConnected: boolean;
}

const Ctx = createContext<Store | null>(null);

const MARKET_KEY = 'elf.market';

function loadMarket(): Market | null {
  try {
    const raw = localStorage.getItem(MARKET_KEY);
    return raw ? (JSON.parse(raw) as Market) : null;
  } catch {
    return null;
  }
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [elf, setElf] = useState<ElfConfig | null>(null);
  const [app, setApp] = useState<AppSettings | null>(null);
  const [meta, setMeta] = useState<ConfigMeta | null>(null);
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [instruments, setInstruments] = useState<Store['instruments']>([]);
  const [market, setMarketState] = useState<Market>(loadMarket() ?? { provider: 'binanceus', symbol: 'BTCUSD', timeframe: '15m' });
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [unread, setUnread] = useState(0);
  const [feeds, setFeeds] = useState<Record<string, FeedState>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [alertStreamConnected, setAlertStreamConnected] = useState(false);
  const toastSeq = useRef(0);
  const appRef = useRef<AppSettings | null>(null);
  appRef.current = app;

  const toast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = ++toastSeq.current;
    setToasts((xs) => [...xs.slice(-3), { ...t, id }]);
    setTimeout(() => setToasts((xs) => xs.filter((x) => x.id !== id)), t.kind === 'alert' ? 12000 : 5000);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((xs) => xs.filter((x) => x.id !== id)), []);

  const refresh = useCallback(async () => {
    try {
      const status = await api.get<{ enabled: boolean; authed: boolean }>('/api/auth/status');
      if (status.enabled && !status.authed) {
        setAuthRequired(true);
        setReady(true);
        return;
      }
      setAuthRequired(false);
      const [settings, m, prov, inst, al] = await Promise.all([
        api.get<{ elf: ElfConfig; app: AppSettings }>('/api/settings'),
        api.get<ConfigMeta>('/api/config/meta'),
        api.get<ProviderSummary[]>('/api/providers'),
        api.get<Store['instruments']>('/api/instruments'),
        api.get<{ alerts: AlertRecord[]; unread: number }>('/api/alerts?limit=100'),
      ]);
      setElf(settings.elf);
      setApp(settings.app);
      setMeta(m);
      setProviders(prov);
      setInstruments(inst);
      setAlerts(al.alerts);
      setUnread(al.unread);
      if (!loadMarket()) setMarketState(settings.app.defaultMarket as Market);
    } catch (e: any) {
      toast({ title: 'Could not reach the ELF server', message: e.message, kind: 'error' });
    } finally {
      setReady(true);
    }
  }, [toast]);

  useEffect(() => {
    void refresh();
    const onLogin = () => setAuthRequired(true);
    window.addEventListener('elf:login-required', onLogin);
    return () => window.removeEventListener('elf:login-required', onLogin);
  }, [refresh]);

  // Alerts + feed status stream (in-app). Browser notifications only while this tab is open.
  useEffect(() => {
    if (!ready || authRequired) return;
    const es = new EventSource('/api/alerts/stream');
    es.addEventListener('open', () => setAlertStreamConnected(true));
    es.addEventListener('error', () => setAlertStreamConnected(false));
    es.addEventListener('hello', (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      setUnread(d.unread);
      setFeeds(Object.fromEntries((d.feeds as FeedState[]).map((f) => [f.key, f])));
    });
    es.addEventListener('feed', (e) => {
      const f = JSON.parse((e as MessageEvent).data) as FeedState;
      setFeeds((x) => ({ ...x, [f.key]: f }));
    });
    es.addEventListener('alert', (e) => {
      const a = JSON.parse((e as MessageEvent).data) as AlertRecord;
      setAlerts((xs) => [a, ...xs].slice(0, 200));
      setUnread((n) => n + 1);
      toast({ title: a.title, message: a.message.split('\n')[0], kind: 'alert' });
      const prefs = appRef.current?.alerts;
      if (prefs?.browserNotifications && 'Notification' in window && Notification.permission === 'granted') {
        try {
          new Notification(a.title, { body: a.message, tag: a.eventKey, icon: '/icon-192.png' });
        } catch {
          /* some mobile browsers require a service-worker notification */
          navigator.serviceWorker?.ready.then((r) => r.showNotification(a.title, { body: a.message, tag: a.eventKey, icon: '/icon-192.png' })).catch(() => {});
        }
      }
    });
    return () => es.close();
  }, [ready, authRequired, toast]);

  const setMarket = useCallback((m: Market) => {
    setMarketState(m);
    try {
      localStorage.setItem(MARKET_KEY, JSON.stringify(m));
    } catch {
      /* private mode */
    }
  }, []);

  const saveElf = useCallback(async (c: ElfConfig) => {
    try {
      const r = await api.put<{ ok: true; config: ElfConfig }>('/api/settings/elf', c);
      setElf(r.config);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, errors: e.details ?? [e.message] };
    }
  }, []);

  const resetElf = useCallback(async () => {
    const r = await api.post<{ ok: true; config: ElfConfig }>('/api/settings/elf/reset');
    setElf(r.config);
  }, []);

  const saveApp = useCallback(async (p: Record<string, unknown>) => {
    try {
      const r = await api.put<{ ok: true; settings: AppSettings }>('/api/settings/app', p);
      setApp(r.settings);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, errors: e.details ?? [e.message] };
    }
  }, []);

  const markRead = useCallback(async (id?: number) => {
    const r = await api.post<{ unread: number }>('/api/alerts/read', id === undefined ? {} : { id });
    setUnread(r.unread);
    setAlerts((xs) => xs.map((a) => (id === undefined || a.id === id ? { ...a, read: true } : a)));
  }, []);

  const value = useMemo<Store>(
    () => ({ ready, authRequired, elf, app, meta, providers, instruments, market, setMarket, refresh, saveElf, resetElf, saveApp: saveApp as Store['saveApp'], alerts, unread, markRead, feeds, toasts, toast, dismissToast, alertStreamConnected }),
    [ready, authRequired, elf, app, meta, providers, instruments, market, setMarket, refresh, saveElf, resetElf, saveApp, alerts, unread, markRead, feeds, toasts, toast, dismissToast, alertStreamConnected],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore outside provider');
  return s;
}
