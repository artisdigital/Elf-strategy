import { useEffect, useState } from 'react';
import { useStore } from '../lib/store';
import { PageHeader } from '../components/Layout';
import { Badge, Card, Field, Notice, Toggle } from '../components/ui';
import { MarketPicker } from '../components/MarketPicker';
import { getPath, setPath, type ElfConfig, type ConfigFieldMeta } from '../../engine/config';
import { VisibilityToggles } from './LiveChart';
import type { Market } from '../lib/api';

const GROUPS: ConfigFieldMeta['group'][] = ['Sessions', 'Liquidity & Sweep', 'Structure & Displacement', 'Bias', 'Risk & Targets', 'FVG & Order Blocks'];
const ORIGIN_TONE = { 'v1.1': 'accent', optional: 'warn', assumption: 'info' } as const;
const ORIGIN_LABEL = { 'v1.1': 'ELF v1.1', optional: 'OPTIONAL', assumption: 'ASSUMPTION' } as const;

function RuleField({ f, cfg, def, onChange }: { f: ConfigFieldMeta; cfg: ElfConfig; def: ElfConfig; onChange: (v: unknown) => void }) {
  const v = getPath(cfg, f.key);
  const d = getPath(def, f.key);
  const changed = JSON.stringify(v) !== JSON.stringify(d);
  return (
    <div className={`rule ${changed ? 'changed' : ''}`}>
      <div className="rule-h">
        <strong>{f.label}</strong>
        <Badge tone={ORIGIN_TONE[f.origin]}>{ORIGIN_LABEL[f.origin]}</Badge>
        {changed && (
          <button className="btn btn-sm btn-ghost" onClick={() => onChange(d)} title={`Default: ${String(d)}`}>
            Reset ({String(d)})
          </button>
        )}
      </div>
      <p className="muted small">{f.description}</p>
      {f.kind === 'boolean' && <Toggle checked={!!v} onChange={onChange} label={v ? 'On' : 'Off'} />}
      {f.kind === 'number' && <input type="number" min={f.min} max={f.max} step={f.step} value={v as number} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />}
      {f.kind === 'time' && <input type="time" value={v as string} onChange={(e) => onChange(e.target.value)} />}
      {f.kind === 'select' && (
        <select value={v as string} onChange={(e) => onChange(e.target.value)}>
          {f.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
    </div>
  );
}

export function Settings() {
  const { elf, meta, app, saveElf, resetElf, saveApp, toast } = useStore();
  const [draft, setDraft] = useState<ElfConfig | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [watch, setWatch] = useState<Market>({ provider: 'binanceus', symbol: 'BTCUSD', timeframe: '15m' });
  useEffect(() => {
    if (elf) setDraft(elf);
  }, [elf]);
  if (!elf || !meta || !app || !draft) return null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(elf);
  const set = (k: string, v: unknown) => setDraft((d) => setPath(d!, k, v));
  const save = async () => {
    const r = await saveElf(draft);
    setErrors(r.ok ? [] : r.errors ?? []);
    if (r.ok) toast({ title: 'Rules saved', message: 'All live monitors were recomputed with the new rules. Historical backtests keep the settings they ran with.', kind: 'success' });
  };
  const appSave = async (p: Record<string, unknown>) => {
    const r = await saveApp(p);
    if (!r.ok) toast({ title: 'Not saved', message: (r.errors ?? []).join('; '), kind: 'error' });
  };

  return (
    <>
      <PageHeader
        title="Settings & Rules"
        sub={`${meta.ruleset} · config schema v${meta.schemaVersion} · timezone America/New_York`}
        right={
          <div className="row gap wrap">
            <button className="btn" onClick={async () => { if (confirm('Restore all documented ELF v1.1 defaults?')) { await resetElf(); toast({ title: 'Defaults restored', message: 'ELF v1.1 defaults are active.', kind: 'success' }); } }}>
              Restore ELF v1.1 defaults
            </button>
            <button className="btn btn-primary" disabled={!dirty} onClick={save}>Save rules</button>
          </div>
        }
      />
      {dirty && <Notice tone="warn">Unsaved rule changes.</Notice>}
      {errors.length > 0 && <Notice tone="bad">{errors.join(' · ')}</Notice>}
      <Notice tone="info">
        <Badge tone="accent">ELF v1.1</Badge> original rule · <Badge tone="warn">OPTIONAL</Badge> engineering addition (neutral/off by default) · <Badge tone="info">ASSUMPTION</Badge> a choice the v1.1 specification did not pin down — see docs/ELF_RULES.md. Defaults never change silently.
      </Notice>
      <div className="grid grid-2">
        {GROUPS.map((g) => (
          <Card key={g} title={g}>
            {meta.fields.filter((f) => f.group === g).map((f) => (
              <RuleField key={f.key} f={f} cfg={draft} def={meta.defaults} onChange={(v) => set(f.key, v)} />
            ))}
          </Card>
        ))}
      </div>

      <h2 className="section-h">Application</h2>
      <div className="grid grid-2">
        <Card title="Default market">
          <MarketPicker market={app.defaultMarket as Market} onChange={(m) => appSave({ defaultMarket: m })} />
        </Card>
        <Card title="Watch-list (server monitors & alerts)">
          <p className="muted small">The server keeps an ELF monitor running for these markets and generates alerts even when no browser is open.</p>
          <ul className="feeds">
            {app.watchlist.map((w, i) => (
              <li key={`${w.provider}:${w.symbol}:${w.timeframe}`}>
                <strong>{w.symbol}</strong> <span className="muted">{w.timeframe} · {w.provider}</span>{' '}
                <button className="btn btn-sm btn-ghost" onClick={() => appSave({ watchlist: app.watchlist.filter((_, j) => j !== i) })}>Remove</button>
              </li>
            ))}
          </ul>
          <MarketPicker market={watch} onChange={setWatch} />
          <button className="btn btn-sm" onClick={() => appSave({ watchlist: [...app.watchlist.filter((w) => !(w.provider === watch.provider && w.symbol === watch.symbol && w.timeframe === watch.timeframe)), watch] })}>
            Add to watch-list
          </button>
        </Card>
        <Card title="Chart layers">
          <VisibilityToggles vis={app.chart.visibility as any} toggle={(k, v) => appSave({ chart: { visibility: { ...app.chart.visibility, [k]: v } } })} />
          <Field label="History bars loaded for the live engine" hint="200–5000. More bars = more context, slower first load.">
            <input type="number" min={200} max={5000} defaultValue={app.chart.historyBars} onBlur={(e) => appSave({ chart: { historyBars: Number(e.target.value) } })} />
          </Field>
        </Card>
        <Card title="Chart colours">
          <div className="colors">
            {Object.entries(app.chart.colors).map(([k, v]) => (
              <label key={k} className="color">
                <input type="color" value={(v as string).slice(0, 7)} onChange={(e) => appSave({ chart: { colors: { ...app.chart.colors, [k]: e.target.value + ((v as string).length > 7 ? (v as string).slice(7) : '') } } })} />
                <span className="small">{k}</span>
              </label>
            ))}
          </div>
        </Card>
        <Card title="Risk defaults">
          <div className="form-grid">
            <Field label="Account balance"><input type="number" defaultValue={app.risk.accountBalance} onBlur={(e) => appSave({ risk: { accountBalance: Number(e.target.value) } })} /></Field>
            <Field label="Default risk %"><input type="number" step={0.1} defaultValue={app.risk.riskPct} onBlur={(e) => appSave({ risk: { riskPct: Number(e.target.value) } })} /></Field>
            <Field label="Maximum risk % (warning / cap)"><input type="number" step={0.1} defaultValue={app.risk.maxRiskPct} onBlur={(e) => appSave({ risk: { maxRiskPct: Number(e.target.value) } })} /></Field>
          </div>
        </Card>
        <Card title="Backtest & replay defaults">
          <div className="form-grid">
            <Field label="Fee per side (%)"><input type="number" step={0.01} defaultValue={app.backtest.feeRatePerSide * 100} onBlur={(e) => appSave({ backtest: { feeRatePerSide: Number(e.target.value) / 100 } })} /></Field>
            <Field label="Slippage (bps)"><input type="number" step={0.5} defaultValue={app.backtest.slippageBps} onBlur={(e) => appSave({ backtest: { slippageBps: Number(e.target.value) } })} /></Field>
            <Field label="Starting equity"><input type="number" defaultValue={app.backtest.startingEquity} onBlur={(e) => appSave({ backtest: { startingEquity: Number(e.target.value) } })} /></Field>
            <Field label="Risk per trade %"><input type="number" step={0.1} defaultValue={app.backtest.riskPct} onBlur={(e) => appSave({ backtest: { riskPct: Number(e.target.value) } })} /></Field>
          </div>
        </Card>
      </div>
    </>
  );
}
