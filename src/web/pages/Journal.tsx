import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { PageHeader } from '../components/Layout';
import { Badge, Card, Empty, Field, KV, Modal, Notice, SampleWarning, Stat, Table } from '../components/ui';
import { fmtPct, fmtPrice, fmtR, fmtTime, fmtNum, download } from '../lib/format';
import type { PerformanceStats, Breakdown } from '../../engine/analytics';

type Entry = Record<string, any>;

const BLANK: Entry = { kind: 'actual', source: 'manual', direction: 'long', symbol: '', timeframe: '15m', session: '', outcome: null, rule_compliant: null };

const toLocalInput = (s: number) => {
  const d = new Date(s * 1000);
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
};

async function shrinkImage(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = url;
    });
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.82);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function Journal() {
  const { toast, market } = useStore();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<'entries' | 'analytics'>('entries');
  const [rows, setRows] = useState<Entry[]>([]);
  const [filter, setFilter] = useState({ kind: '', symbol: '', direction: '', outcome: '', q: '' });
  const [edit, setEdit] = useState<Entry | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  const qs = () => new URLSearchParams(Object.entries(filter).filter(([, v]) => v)).toString();
  const load = () => api.get<Entry[]>(`/api/journal?${qs()}`).then(setRows).catch((e) => toast({ title: 'Journal', message: e.message, kind: 'error' }));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter.kind, filter.symbol, filter.direction, filter.outcome]);

  useEffect(() => {
    if (params.get('new')) {
      let draft: Entry = { ...BLANK, symbol: market.symbol, provider: market.provider, timeframe: market.timeframe, trade_time: Math.floor(Date.now() / 1000) };
      try {
        const d = sessionStorage.getItem('elf.journalDraft');
        if (d) draft = { ...draft, ...JSON.parse(d) };
        sessionStorage.removeItem('elf.journalDraft');
      } catch {
        /* ignore */
      }
      setEdit(draft);
      setParams({}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const open = async (id: number) => setEdit(await api.get<Entry>(`/api/journal/${id}`));

  const save = async () => {
    if (!edit) return;
    const body: Entry = { ...edit };
    for (const k of ['entry', 'stop', 'target', 'exit_price', 'position_size', 'planned_rr', 'result_r', 'fees', 'emotion_rating']) {
      if (body[k] === '' || body[k] === undefined) body[k] = null;
      else if (body[k] !== null) body[k] = Number(body[k]);
    }
    for (const k of ['session', 'setup_type', 'notes', 'lessons', 'mistakes', 'improvements', 'provider', 'timeframe']) if (body[k] === '') body[k] = null;
    delete body.has_screenshot;
    try {
      if (body.id) await api.put(`/api/journal/${body.id}`, body);
      else await api.post('/api/journal', body);
      setEdit(null);
      setErrors([]);
      void load();
      toast({ title: 'Saved', message: `${body.kind === 'actual' ? 'Actual trade' : 'Hypothetical'} ${body.symbol} recorded.`, kind: 'success' });
    } catch (e: any) {
      setErrors(e.details ?? [e.message]);
    }
  };

  const remove = async () => {
    if (!edit?.id || !confirm('Delete this journal entry?')) return;
    await api.del(`/api/journal/${edit.id}`);
    setEdit(null);
    void load();
  };

  const exportAs = async (format: 'csv' | 'json') => {
    const res = await fetch(`/api/journal/export?format=${format}&${qs()}`);
    download(`elf-journal.${format}`, await res.text(), format === 'csv' ? 'text/csv' : 'application/json');
  };

  const set = (k: string, v: unknown) => setEdit((e) => ({ ...e!, [k]: v }));

  return (
    <>
      <PageHeader
        title="Trade Journal"
        sub="Actual executed trades and hypothetical (signal / replay) records are always kept separate."
        right={
          <div className="row gap wrap">
            <div className="seg">
              <button className={tab === 'entries' ? 'on' : ''} onClick={() => setTab('entries')}>Entries</button>
              <button className={tab === 'analytics' ? 'on' : ''} onClick={() => setTab('analytics')}>Analytics</button>
            </div>
            <button className="btn btn-primary" onClick={() => setEdit({ ...BLANK, symbol: market.symbol, provider: market.provider, timeframe: market.timeframe, trade_time: Math.floor(Date.now() / 1000) })}>
              + New entry
            </button>
          </div>
        }
      />
      {tab === 'entries' ? (
        <Card
          title={`${rows.length} entries`}
          right={
            <div className="row gap">
              <button className="btn btn-sm" onClick={() => exportAs('csv')}>CSV</button>
              <button className="btn btn-sm" onClick={() => exportAs('json')}>JSON</button>
            </div>
          }
        >
          <div className="filters">
            <select value={filter.kind} onChange={(e) => setFilter({ ...filter, kind: e.target.value })}>
              <option value="">All kinds</option>
              <option value="actual">Actual</option>
              <option value="hypothetical">Hypothetical</option>
            </select>
            <input placeholder="Symbol" value={filter.symbol} onChange={(e) => setFilter({ ...filter, symbol: e.target.value.toUpperCase() })} />
            <select value={filter.direction} onChange={(e) => setFilter({ ...filter, direction: e.target.value })}>
              <option value="">Long & short</option>
              <option value="long">Long</option>
              <option value="short">Short</option>
            </select>
            <select value={filter.outcome} onChange={(e) => setFilter({ ...filter, outcome: e.target.value })}>
              <option value="">Any outcome</option>
              {['tp1', 'tp2', 'target', 'sl', 'manual', 'breakeven', 'expired', 'cancelled', 'open'].map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
            <input placeholder="Search notes…" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && load()} />
            <button className="btn btn-sm" onClick={load}>Search</button>
          </div>
          {rows.length === 0 ? (
            <Empty>No journal entries match.</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th>Date (ET)</th>
                  <th>Kind</th>
                  <th>Symbol</th>
                  <th>Dir</th>
                  <th>Entry</th>
                  <th>Exit</th>
                  <th>Outcome</th>
                  <th>R</th>
                  <th>Rules</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => open(r.id)}>
                    <td>{fmtTime(r.trade_time)}</td>
                    <td>
                      <Badge tone={r.kind === 'actual' ? 'accent' : 'neutral'}>{r.kind === 'actual' ? 'ACTUAL' : 'HYPO'}</Badge>
                    </td>
                    <td>
                      {r.symbol} <small className="muted">{r.timeframe}</small>
                    </td>
                    <td>{r.direction === 'long' ? '▲' : '▼'}</td>
                    <td>{fmtPrice(r.entry)}</td>
                    <td>{fmtPrice(r.exit_price)}</td>
                    <td>{r.outcome ?? '—'}</td>
                    <td className={r.result_r > 0 ? 'pos' : r.result_r < 0 ? 'neg' : ''}>{fmtR(r.result_r)}</td>
                    <td>{r.rule_compliant === null ? '—' : r.rule_compliant ? '✓' : '✗'}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      ) : (
        <Analytics />
      )}

      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? `Edit entry #${edit.id}` : 'New journal entry'} wide>
        {edit && (
          <>
            {errors.length > 0 && <Notice tone="bad">{errors.join('; ')}</Notice>}
            <div className="form-grid">
              <Field label="Record type" hint="Only mark ACTUAL if you really executed the trade with a broker.">
                <select value={edit.kind} onChange={(e) => set('kind', e.target.value)}>
                  <option value="actual">Actual executed trade</option>
                  <option value="hypothetical">Hypothetical (signal / replay / paper)</option>
                </select>
              </Field>
              <Field label="Date & time (your local time)">
                <input type="datetime-local" value={edit.trade_time ? toLocalInput(edit.trade_time) : ''} onChange={(e) => set('trade_time', Math.floor(new Date(e.target.value).getTime() / 1000))} />
              </Field>
              <Field label="Symbol">
                <input value={edit.symbol ?? ''} onChange={(e) => set('symbol', e.target.value.toUpperCase())} />
              </Field>
              <Field label="Direction">
                <select value={edit.direction} onChange={(e) => set('direction', e.target.value)}>
                  <option value="long">Long</option>
                  <option value="short">Short</option>
                </select>
              </Field>
              <Field label="Session">
                <select value={edit.session ?? ''} onChange={(e) => set('session', e.target.value)}>
                  <option value="">—</option>
                  <option value="london">London</option>
                  <option value="newYork">New York</option>
                  <option value="asia">Asia</option>
                  <option value="outside">Outside sessions</option>
                </select>
              </Field>
              <Field label="Timeframe">
                <input value={edit.timeframe ?? ''} onChange={(e) => set('timeframe', e.target.value)} />
              </Field>
              {(['entry', 'stop', 'target', 'exit_price', 'position_size', 'fees'] as const).map((k) => (
                <Field key={k} label={{ entry: 'Entry', stop: 'Stop-loss', target: 'Target', exit_price: 'Actual exit', position_size: 'Position size', fees: 'Fees (account currency)' }[k]}>
                  <input inputMode="decimal" value={edit[k] ?? ''} onChange={(e) => set(k, e.target.value)} />
                </Field>
              ))}
              <Field label="Planned R:R" hint="Calculated from entry/stop/target if blank">
                <input inputMode="decimal" value={edit.planned_rr ?? ''} onChange={(e) => set('planned_rr', e.target.value)} />
              </Field>
              <Field label="Actual result (R)" hint="Calculated from entry/stop/exit (minus fees) if blank">
                <input inputMode="decimal" value={edit.result_r ?? ''} onChange={(e) => set('result_r', e.target.value)} />
              </Field>
              <Field label="Outcome">
                <select value={edit.outcome ?? ''} onChange={(e) => set('outcome', e.target.value || null)}>
                  <option value="">—</option>
                  {['tp1', 'tp2', 'target', 'sl', 'manual', 'breakeven', 'expired', 'cancelled', 'open'].map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              </Field>
              <Field label="Followed ELF rules?">
                <select value={edit.rule_compliant === null || edit.rule_compliant === undefined ? '' : edit.rule_compliant ? 'yes' : 'no'} onChange={(e) => set('rule_compliant', e.target.value === '' ? null : e.target.value === 'yes')}>
                  <option value="">Not recorded</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </Field>
              <Field label="Setup type">
                <input value={edit.setup_type ?? ''} onChange={(e) => set('setup_type', e.target.value)} placeholder="e.g. ELF PDL sweep" />
              </Field>
              <Field label="Discipline rating (1–5, optional)">
                <select value={edit.emotion_rating ?? ''} onChange={(e) => set('emotion_rating', e.target.value || null)}>
                  <option value="">—</option>
                  {[1, 2, 3, 4, 5].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Notes">
              <textarea rows={3} value={edit.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
            </Field>
            <div className="form-grid">
              <Field label="Mistakes">
                <textarea rows={2} value={edit.mistakes ?? ''} onChange={(e) => set('mistakes', e.target.value)} />
              </Field>
              <Field label="Improvements">
                <textarea rows={2} value={edit.improvements ?? ''} onChange={(e) => set('improvements', e.target.value)} />
              </Field>
              <Field label="Lessons learned">
                <textarea rows={2} value={edit.lessons ?? ''} onChange={(e) => set('lessons', e.target.value)} />
              </Field>
            </div>
            <Field label="Setup screenshot">
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) set('screenshot', await shrinkImage(f));
                }}
              />
            </Field>
            {edit.screenshot && (
              <div className="shot">
                <img src={edit.screenshot} alt="Setup screenshot" />
                <button className="btn btn-sm btn-ghost" onClick={() => set('screenshot', null)}>Remove image</button>
              </div>
            )}
            <div className="row gap">
              <button className="btn btn-primary" onClick={save}>Save</button>
              {edit.id && <button className="btn btn-danger" onClick={remove}>Delete</button>}
              <span className="muted small">Source: {edit.source}</span>
            </div>
          </>
        )}
      </Modal>
    </>
  );
}

function BreakdownTable({ title, data }: { title: string; data: Record<string, Breakdown> }) {
  const keys = Object.keys(data);
  if (!keys.length) return null;
  return (
    <Card title={title}>
      <Table>
        <thead>
          <tr><th /><th>Trades</th><th>Win rate</th><th>Net R</th><th>Avg R</th></tr>
        </thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k}>
              <td>{k}</td>
              <td>{data[k].count}</td>
              <td>{fmtPct(data[k].winRate)}</td>
              <td className={data[k].netR >= 0 ? 'pos' : 'neg'}>{fmtR(data[k].netR)}</td>
              <td>{fmtR(data[k].avgR)}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

export function StatsGrid({ s }: { s: PerformanceStats }) {
  return (
    <div className="stats">
      <Stat label="Trades" value={s.count} sub={`${s.wins}W / ${s.losses}L / ${s.breakeven}BE`} />
      <Stat label="Win rate" value={fmtPct(s.winRate)} />
      <Stat label="Net R" value={fmtR(s.netR)} tone={s.netR > 0 ? 'pos' : s.netR < 0 ? 'neg' : ''} />
      <Stat label="Avg R / trade" value={fmtR(s.avgR)} />
      <Stat label="Avg win" value={fmtR(s.avgWinR)} />
      <Stat label="Avg loss" value={fmtR(s.avgLossR)} />
      <Stat label="Profit factor" value={s.profitFactor === null ? '—' : fmtNum(s.profitFactor)} sub={s.profitFactor === null ? 'undefined (no losses)' : undefined} />
      <Stat label="Max drawdown" value={`${fmtNum(s.maxDrawdownR)}R`} />
      <Stat label="Avg planned R:R" value={s.avgPlannedRR === null ? '—' : fmtNum(s.avgPlannedRR)} />
      <Stat label="Rule compliance" value={fmtPct(s.complianceRate)} />
    </div>
  );
}

function Analytics() {
  const [kind, setKind] = useState<'actual' | 'hypothetical'>('actual');
  const [days, setDays] = useState(0);
  const [data, setData] = useState<{ stats: PerformanceStats; excludedWithoutResult: number; definitions: Record<string, string> } | null>(null);
  useEffect(() => {
    const from = days ? Math.floor(Date.now() / 1000) - days * 86400 : '';
    api.get<typeof data>(`/api/analytics?kind=${kind}${from ? `&from=${from}` : ''}`).then(setData).catch(() => setData(null));
  }, [kind, days]);
  return (
    <>
      <div className="row gap wrap">
        <div className="seg">
          <button className={kind === 'actual' ? 'on' : ''} onClick={() => setKind('actual')}>Actual trades</button>
          <button className={kind === 'hypothetical' ? 'on' : ''} onClick={() => setKind('hypothetical')}>Hypothetical</button>
        </div>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={0}>All time</option>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={365}>Last 12 months</option>
        </select>
      </div>
      {data && (
        <>
          <SampleWarning text={data.stats.sampleWarning} />
          {data.excludedWithoutResult > 0 && <Notice tone="info">{data.excludedWithoutResult} entries without a recorded R result (or open/cancelled) are excluded.</Notice>}
          <Card title={kind === 'actual' ? 'Actual trading results' : 'Hypothetical results (not real trading)'}>
            <StatsGrid s={data.stats} />
          </Card>
          <div className="grid grid-2">
            <BreakdownTable title="Long vs short" data={data.stats.byDirection} />
            <BreakdownTable title="By session" data={data.stats.bySession} />
            <BreakdownTable title="By symbol" data={data.stats.bySymbol} />
            <BreakdownTable title="By timeframe" data={data.stats.byTimeframe} />
            <BreakdownTable title="By setup type" data={data.stats.bySetup} />
          </div>
          <Card title="Metric definitions">
            <div className="kv-grid">
              {Object.entries(data.definitions).map(([k, v]) => (
                <KV key={k} k={k} v={<small>{v}</small>} />
              ))}
            </div>
          </Card>
        </>
      )}
    </>
  );
}
