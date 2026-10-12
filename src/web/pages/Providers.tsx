import { useEffect, useState } from 'react';
import { useStore } from '../lib/store';
import { api, type ProviderSummary } from '../lib/api';
import { PageHeader } from '../components/Layout';
import { Badge, Card, FeedBadge, Field, Notice, Toggle } from '../components/ui';
import type { FeedState } from '../../shared/types';

function ProviderCard({ p, onChange }: { p: ProviderSummary; onChange: () => void }) {
  const { toast } = useStore();
  const [values, setValues] = useState<Record<string, string>>({});
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.put(`/api/providers/${p.id}`, { credentials: values });
      setValues({});
      toast({ title: `${p.name} saved`, message: 'Credentials stored encrypted on the server.', kind: 'success' });
      onChange();
    } catch (e: any) {
      toast({ title: 'Save failed', message: e.message, kind: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const doTest = async () => {
    setBusy(true);
    setTest(null);
    try {
      setTest(await api.post(`/api/providers/${p.id}/test`));
    } catch (e: any) {
      setTest({ ok: false, message: e.message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      title={
        <span className="row gap">
          {p.name} {p.requiresKey ? <Badge tone={p.configured ? 'good' : 'warn'}>{p.configured ? 'key configured' : 'NEEDS KEY'}</Badge> : <Badge>no key needed</Badge>}
          {p.delayed && <Badge tone="warn">DELAYED</Badge>}
        </span>
      }
      right={<Toggle checked={p.enabled} onChange={async (v) => { await api.put(`/api/providers/${p.id}`, { enabled: v }); onChange(); }} label={p.enabled ? 'Enabled' : 'Disabled'} />}
    >
      <p className="muted">{p.description}</p>
      <ul className="small notes">{p.dataNotes.map((n) => <li key={n}>{n}</li>)}</ul>
      <p className="small muted">Timeframes: {p.timeframes.join(', ')} · Transport: {p.supportsStreaming ? 'WebSocket with REST fallback' : 'REST polling'}</p>
      {p.credentialFields.length > 0 && (
        <div className="form-grid">
          {p.credentialFields.map((f) => (
            <Field key={f.key} label={f.label} hint={f.help}>
              {f.options ? (
                <select value={values[f.key] ?? f.value ?? f.options[0]} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
                  {f.options.map((o) => <option key={o}>{o}</option>)}
                </select>
              ) : (
                <input
                  type={f.secret ? 'password' : 'text'}
                  autoComplete="off"
                  value={values[f.key] ?? (f.secret ? '' : f.value ?? '')}
                  placeholder={f.secret && f.hasValue ? '•••••••• (stored — leave blank to keep)' : ''}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                />
              )}
            </Field>
          ))}
        </div>
      )}
      {p.credentialSource === 'env' && <Notice tone="info">Credentials come from server environment variables (they override values saved here).</Notice>}
      <div className="row gap wrap">
        {p.credentialFields.length > 0 && <button className="btn btn-primary" disabled={busy || Object.keys(values).length === 0} onClick={save}>Save credentials</button>}
        <button className="btn" disabled={busy} onClick={doTest}>Test connection</button>
        {p.credentialSource === 'stored' && (
          <button className="btn btn-ghost" onClick={async () => { if (confirm(`Remove stored ${p.name} credentials?`)) { await api.del(`/api/providers/${p.id}/credentials`); onChange(); } }}>
            Remove stored key
          </button>
        )}
      </div>
      {test && <Notice tone={test.ok ? 'good' : 'bad'}>{test.message}</Notice>}
    </Card>
  );
}

export function Providers() {
  const { providers, refresh, feeds } = useStore();
  const [live, setLive] = useState<FeedState[]>([]);
  useEffect(() => {
    const load = () => api.get<{ feeds: FeedState[] }>('/api/feeds').then((r) => setLive(r.feeds)).catch(() => {});
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  const merged = live.map((f) => feeds[f.key] ?? f);
  return (
    <>
      <PageHeader title="Market Data Providers" sub="Real provider data only. Keys stay on the server, encrypted at rest, and are never sent to the browser." />
      <Card title="Active feeds">
        {merged.length === 0 ? <p className="muted">No feeds running.</p> : (
          <ul className="feeds">
            {merged.map((f) => (
              <li key={f.key}>
                <strong>{f.symbol}</strong> <span className="muted">{f.timeframe} · {f.provider}</span> <FeedBadge feed={f} />
              </li>
            ))}
          </ul>
        )}
        <p className="muted small">LIVE = WebSocket stream delivering data · REST POLLING = periodic requests · DELAYED = delayed source · DISCONNECTED = retrying with backoff · NEEDS KEY = credentials missing · ERROR = rejected request.</p>
      </Card>
      <div className="grid grid-2">
        {providers.map((p) => <ProviderCard key={p.id} p={p} onChange={refresh} />)}
      </div>
    </>
  );
}
