import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../lib/store';
import { api } from '../lib/api';
import { planTrade, type InstrumentSpec } from '../../engine/planner';
import { PageHeader } from '../components/Layout';
import { MarketPicker } from '../components/MarketPicker';
import { Badge, Card, Empty, Field, KV, Notice, Table } from '../components/ui';
import { fmtNum, fmtPrice, fmtR, fmtTime } from '../lib/format';
import { useMarketStream } from '../lib/useMarketStream';
import type { PlanRow } from '../../server/plans';

const n = (v: string) => (v.trim() === '' ? NaN : Number(v));

export function Planner() {
  const { market, setMarket, app, toast } = useStore();
  const nav = useNavigate();
  const stream = useMarketStream(market);
  const s = stream.monitor?.snapshot ?? null;
  const [balance, setBalance] = useState('');
  const [riskMode, setRiskMode] = useState<'percent' | 'cash'>('percent');
  const [riskValue, setRiskValue] = useState('');
  const [entry, setEntry] = useState('');
  const [stop, setStop] = useState('');
  const [target, setTarget] = useState('');
  const [spec, setSpec] = useState<InstrumentSpec | null>(null);
  const [specSource, setSpecSource] = useState<string>('');
  const [kind, setKind] = useState<InstrumentSpec['kind']>('units');
  const [override, setOverride] = useState({ stepSize: '', contractMultiplier: '', quoteToAccountRate: '', pipSize: '', lotSize: '' });
  const [plans, setPlans] = useState<PlanRow[]>([]);

  useEffect(() => {
    if (app && balance === '') {
      setBalance(String(app.risk.accountBalance));
      setRiskValue(String(app.risk.riskPct));
    }
  }, [app, balance]);

  useEffect(() => {
    setSpec(null);
    api
      .get<{ spec: InstrumentSpec | null }>(`/api/instruments/spec?provider=${market.provider}&symbol=${encodeURIComponent(market.symbol)}`)
      .then((r) => {
        setSpec(r.spec);
        setSpecSource(r.spec?.source ?? 'No specification available from this provider');
        if (r.spec) setKind(r.spec.kind);
      })
      .catch((e) => setSpecSource(`Specification unavailable: ${e.message}`));
  }, [market.provider, market.symbol]);

  const loadPlans = () => api.get<PlanRow[]>('/api/plans').then(setPlans).catch(() => {});
  useEffect(() => {
    void loadPlans();
    const t = setInterval(loadPlans, 15000);
    return () => clearInterval(t);
  }, []);

  const effectiveSpec: InstrumentSpec = useMemo(() => {
    const o = (v: string, d: number | null | undefined) => (v.trim() === '' ? d ?? null : Number(v));
    return {
      kind,
      tickSize: spec?.tickSize ?? null,
      stepSize: o(override.stepSize, spec?.stepSize),
      minQty: spec?.minQty ?? null,
      contractMultiplier: o(override.contractMultiplier, spec?.contractMultiplier),
      quoteToAccountRate: o(override.quoteToAccountRate, spec?.quoteToAccountRate),
      pipSize: o(override.pipSize, spec?.pipSize),
      lotSize: o(override.lotSize, spec?.lotSize),
    };
  }, [spec, kind, override]);

  const out = planTrade({ balance: n(balance), riskMode, riskValue: n(riskValue), entry: n(entry), stop: n(stop), target: target.trim() ? n(target) : null, spec: effectiveSpec, maxRiskPct: app?.risk.maxRiskPct ?? 2 });
  const ready = Number.isFinite(n(entry)) && Number.isFinite(n(stop));

  const sig = s?.lastSignal;
  const useSignal = () => {
    if (!sig) return;
    setEntry(String(sig.plan.entry));
    setStop(String(sig.plan.stop));
    setTarget(sig.plan.tp2 !== null ? String(sig.plan.tp2) : '');
  };

  const savePlan = async (activate: boolean) => {
    try {
      await api.post('/api/plans', {
        provider: market.provider,
        symbol: market.symbol,
        timeframe: market.timeframe,
        direction: out.direction,
        entry: n(entry),
        stop: n(stop),
        tp2: target.trim() ? n(target) : null,
        position_size: out.positionSize ?? null,
        source: sig && n(entry) === sig.plan.entry ? 'signal' : 'manual',
        signal_id: sig && n(entry) === sig.plan.entry ? sig.id : null,
        status: activate ? 'active' : 'planned',
      });
      toast({ title: 'Plan saved', message: activate ? 'Monitoring stop / targets on closed candles.' : 'Saved as planned.', kind: 'success' });
      void loadPlans();
    } catch (e: any) {
      toast({ title: 'Could not save plan', message: e.message, kind: 'error' });
    }
  };

  const act = async (p: PlanRow, what: 'activate' | 'cancel' | 'close') => {
    try {
      if (what === 'close') {
        const v = prompt('Exit price for manual close?', String(stream.candles.at(-1)?.close ?? p.entry));
        if (!v) return;
        await api.post(`/api/plans/${p.id}/close`, { exitPrice: Number(v) });
      } else await api.post(`/api/plans/${p.id}/${what}`);
      void loadPlans();
    } catch (e: any) {
      toast({ title: 'Action failed', message: e.message, kind: 'error' });
    }
  };

  const toJournal = (p: PlanRow) => {
    sessionStorage.setItem(
      'elf.journalDraft',
      JSON.stringify({ kind: 'actual', source: 'plan', plan_id: p.id, symbol: p.symbol, provider: p.provider, timeframe: p.timeframe, direction: p.direction, entry: p.entry, stop: p.stop, target: p.tp2, exit_price: p.exit_price, position_size: p.position_size, outcome: p.outcome === 'tp2' ? 'tp2' : p.outcome === 'sl' ? 'sl' : p.outcome ?? null, trade_time: Math.floor(p.created_at / 1000), signal_id: p.signal_id }),
    );
    nav('/journal?new=1');
  };

  return (
    <>
      <PageHeader title="Trade Planner" sub="Risk calculator and plan tracking. Decision support only — no orders are sent." right={<MarketPicker market={market} onChange={setMarket} />} />
      <div className="grid grid-2">
        <Card title="Risk calculator" right={sig ? <button className="btn btn-sm" onClick={useSignal}>Use latest ELF signal</button> : null}>
          <div className="form-grid">
            <Field label="Account balance">
              <input inputMode="decimal" value={balance} onChange={(e) => setBalance(e.target.value)} />
            </Field>
            <Field label="Risk">
              <div className="row">
                <input inputMode="decimal" value={riskValue} onChange={(e) => setRiskValue(e.target.value)} />
                <select value={riskMode} onChange={(e) => setRiskMode(e.target.value as 'percent' | 'cash')}>
                  <option value="percent">% of balance</option>
                  <option value="cash">cash amount</option>
                </select>
              </div>
            </Field>
            <Field label="Entry price">
              <input inputMode="decimal" value={entry} onChange={(e) => setEntry(e.target.value)} placeholder={fmtPrice(stream.candles.at(-1)?.close)} />
            </Field>
            <Field label="Stop-loss price">
              <input inputMode="decimal" value={stop} onChange={(e) => setStop(e.target.value)} />
            </Field>
            <Field label="Target price (optional)">
              <input inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} />
            </Field>
            <Field label="Sizing method" hint={specSource}>
              <select value={kind} onChange={(e) => setKind(e.target.value as InstrumentSpec['kind'])}>
                <option value="units">Units / shares / coins</option>
                <option value="forex">Forex units (lots)</option>
                <option value="contract">Contracts (futures/CFD)</option>
              </select>
            </Field>
            <Field label="Quantity step" hint={`Provider: ${effectiveSpec.stepSize ?? 'unknown'}`}>
              <input inputMode="decimal" value={override.stepSize} placeholder="from provider" onChange={(e) => setOverride({ ...override, stepSize: e.target.value })} />
            </Field>
            <Field label="Quote → account FX rate" hint="1 if the quote currency is your account currency">
              <input inputMode="decimal" value={override.quoteToAccountRate} placeholder={String(spec?.quoteToAccountRate ?? 'required')} onChange={(e) => setOverride({ ...override, quoteToAccountRate: e.target.value })} />
            </Field>
            {kind === 'contract' && (
              <Field label="Contract multiplier" hint="Value of a 1.0 price move per contract (e.g. ES = 50)">
                <input inputMode="decimal" value={override.contractMultiplier} onChange={(e) => setOverride({ ...override, contractMultiplier: e.target.value })} />
              </Field>
            )}
            {kind === 'forex' && (
              <>
                <Field label="Pip size">
                  <input inputMode="decimal" value={override.pipSize} placeholder={String(spec?.pipSize ?? '')} onChange={(e) => setOverride({ ...override, pipSize: e.target.value })} />
                </Field>
                <Field label="Lot size (units)">
                  <input inputMode="decimal" value={override.lotSize} placeholder={String(spec?.lotSize ?? 100000)} onChange={(e) => setOverride({ ...override, lotSize: e.target.value })} />
                </Field>
              </>
            )}
          </div>
        </Card>
        <Card title="Result">
          {!ready ? (
            <Empty>Enter an entry and stop-loss.</Empty>
          ) : (
            <>
              {out.errors.map((e) => (
                <Notice key={e} tone="bad">{e}</Notice>
              ))}
              {out.warnings.map((e) => (
                <Notice key={e} tone="warn">{e}</Notice>
              ))}
              {out.missing.length > 0 && <Notice tone="warn">Position size not calculated — missing: {out.missing.join('; ')}</Notice>}
              <div className="kv-grid">
                <KV k="Direction" v={out.direction ? <Badge tone={out.direction === 'long' ? 'good' : 'bad'}>{out.direction.toUpperCase()}</Badge> : '—'} />
                <KV k="Monetary risk" v={out.riskAmount !== null ? `${fmtNum(out.riskAmount)} (${fmtNum(out.riskPctOfBalance)}%)` : '—'} />
                <KV k="Stop distance" v={`${fmtPrice(out.stopDistance)}${out.stopPips !== null ? ` (${fmtNum(out.stopPips, 1)} pips)` : ''}`} />
                <KV k="Reward distance" v={fmtPrice(out.rewardDistance)} />
                <KV k="Planned R:R" v={out.rr !== null ? `1 : ${out.rr.toFixed(2)}` : '—'} />
                <KV k="Position size" v={out.positionSize !== null ? `${fmtNum(out.positionSize, 8)} ${out.sizeUnit}${out.lots !== null ? ` (${fmtNum(out.lots, 2)} lots)` : ''}` : '—'} />
                <KV k="Risk after rounding" v={fmtNum(out.actualRiskAfterRounding)} />
              </div>
              <div className="row gap wrap">
                <button className="btn" disabled={!out.direction || out.errors.length > 0} onClick={() => savePlan(false)}>
                  Save plan
                </button>
                <button className="btn btn-primary" disabled={!out.direction || out.errors.length > 0 || !target.trim()} onClick={() => savePlan(true)} title={!target.trim() ? 'A target is required for monitoring' : ''}>
                  Save & monitor
                </button>
              </div>
              <p className="muted small">Monitoring checks closed {market.timeframe} candles for stop / TP1 (1R) / target and alerts you. You must place and manage any real order with your broker yourself.</p>
            </>
          )}
        </Card>
      </div>
      <Card title="Plans">
        {plans.length === 0 ? (
          <Empty>No plans yet.</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>#</th>
                <th>Market</th>
                <th>Dir</th>
                <th>Entry</th>
                <th>SL</th>
                <th>TP2</th>
                <th>Status</th>
                <th>Result</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {plans.map((p) => (
                <tr key={p.id}>
                  <td>{p.id}</td>
                  <td>
                    {p.symbol} <small className="muted">{p.timeframe}</small>
                  </td>
                  <td>{p.direction === 'long' ? '▲' : '▼'}</td>
                  <td>{fmtPrice(p.entry)}</td>
                  <td>{fmtPrice(p.stop)}</td>
                  <td>{fmtPrice(p.tp2)}</td>
                  <td>
                    <Badge tone={p.status === 'active' ? 'info' : p.status === 'closed' ? 'neutral' : p.status === 'cancelled' ? 'bad' : 'warn'}>{p.status}</Badge> {p.tp1_hit ? <Badge tone="good">TP1</Badge> : null}
                  </td>
                  <td>
                    {p.outcome ?? '—'} {fmtR(p.result_r)}
                  </td>
                  <td className="small">{fmtTime(Math.floor(p.created_at / 1000))}</td>
                  <td className="row gap">
                    {p.status === 'planned' && (
                      <button className="btn btn-sm" onClick={() => act(p, 'activate')}>
                        I entered — monitor
                      </button>
                    )}
                    {p.status === 'active' && (
                      <button className="btn btn-sm" onClick={() => act(p, 'close')}>
                        Close
                      </button>
                    )}
                    {(p.status === 'planned' || p.status === 'active') && (
                      <button className="btn btn-sm btn-ghost" onClick={() => act(p, 'cancel')}>
                        Cancel
                      </button>
                    )}
                    {p.status === 'closed' && (
                      <button className="btn btn-sm" onClick={() => toJournal(p)}>
                        Journal
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
