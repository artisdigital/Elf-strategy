import { useEffect, useRef, useState } from 'react';
import { createChart, type UTCTimestamp } from 'lightweight-charts';
import { useStore } from '../lib/store';
import { api, type Market } from '../lib/api';
import { PageHeader } from '../components/Layout';
import { MarketPicker } from '../components/MarketPicker';
import { Badge, Card, Empty, Field, KV, Notice, SampleWarning, Table, Toggle } from '../components/ui';
import { StatsGrid } from './Journal';
import { fmtNum, fmtPrice, fmtR, fmtTime, fromDateInput, toDateInput, download } from '../lib/format';
import type { BacktestResult } from '../../engine/backtest';
import { zonedParts } from '../../shared/time';

function EquityChart({ points, start }: { points: { time: number; equity: number }[]; start: number }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!el.current || points.length < 2) return;
    const chart = createChart(el.current, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: '#9ca3af', fontSize: 11 },
      grid: { vertLines: { visible: false }, horzLines: { color: '#1f293766' } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, tickMarkFormatter: (t: number) => { const p = zonedParts(t); return `${p.month}/${p.day}`; } },
      handleScroll: false,
      handleScale: false,
    });
    const s = chart.addLineSeries({ color: '#10b981', lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
    // equity points may share a timestamp (entry candle); keep the last per time
    const dedup = new Map<number, number>();
    for (const p of points) dedup.set(p.time, p.equity);
    s.setData([...dedup.entries()].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time: time as UTCTimestamp, value })));
    s.createPriceLine({ price: start, color: '#64748b', lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: 'start' });
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [points, start]);
  if (points.length < 2) return <Empty>No closed trades — no equity curve.</Empty>;
  return <div ref={el} className="equity" role="img" aria-label="Equity curve of the backtest (see trades table for values)" />;
}

export function Backtest() {
  const { market: liveMarket, app, elf, toast } = useStore();
  const [market, setMarket] = useState<Market>(liveMarket);
  const now = Math.floor(Date.now() / 1000);
  const [from, setFrom] = useState(toDateInput(now - 60 * 86400));
  const [to, setTo] = useState(toDateInput(now - 86400));
  const [fee, setFee] = useState('');
  const [slip, setSlip] = useState('');
  const [equity, setEquity] = useState('');
  const [riskPct, setRiskPct] = useState('');
  const [split, setSplit] = useState(30);
  const [intrabar, setIntrabar] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ id: number; result: BacktestResult } | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [repro, setRepro] = useState<string | null>(null);
  const [grid, setGrid] = useState({ key: 'minRR', values: '2,2.5,3,3.5' });
  const [search, setSearch] = useState<any>(null);

  useEffect(() => {
    if (app && fee === '') {
      setFee(String(app.backtest.feeRatePerSide * 100));
      setSlip(String(app.backtest.slippageBps));
      setEquity(String(app.backtest.startingEquity));
      setRiskPct(String(app.backtest.riskPct));
    }
  }, [app, fee]);
  const loadHistory = () => api.get<any[]>('/api/backtests').then(setHistory).catch(() => {});
  useEffect(() => void loadHistory(), []);

  const body = () => ({
    provider: market.provider,
    symbol: market.symbol,
    timeframe: market.timeframe,
    from: fromDateInput(from),
    to: fromDateInput(to, true),
    config: elf,
    costs: { feeRatePerSide: Number(fee) / 100, slippageBps: Number(slip) },
    risk: { startingEquity: Number(equity), riskPct: Number(riskPct), maxRiskPct: app?.risk.maxRiskPct ?? 2 },
    splitPct: split,
    intrabar,
  });

  const run = async () => {
    setRunning(true);
    setRepro(null);
    try {
      const r = await api.post<{ id: number; result: BacktestResult }>('/api/backtests', body());
      setResult(r);
      void loadHistory();
    } catch (e: any) {
      toast({ title: 'Backtest failed', message: e.message, kind: 'error' });
    } finally {
      setRunning(false);
    }
  };

  const runSearch = async () => {
    setRunning(true);
    try {
      const values = grid.values.split(',').map((v) => Number(v.trim())).filter((v) => Number.isFinite(v));
      setSearch(await api.post('/api/backtests/search', { ...body(), grid: [{ key: grid.key, values }] }));
    } catch (e: any) {
      toast({ title: 'Search failed', message: e.message, kind: 'error' });
    } finally {
      setRunning(false);
    }
  };

  const open = async (id: number) => {
    const r = await api.get<{ id: number; result: BacktestResult }>(`/api/backtests/${id}`);
    setResult(r);
    setRepro(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const rerun = async () => {
    if (!result) return;
    const r = await api.post<{ reproduced: boolean; dataMatches: boolean; original: any; rerun: any }>(`/api/backtests/${result.id}/rerun`);
    setRepro(r.reproduced ? `Reproduced exactly (data ${r.rerun.dataHash}, result ${r.rerun.resultHash}).` : r.dataMatches ? 'Data identical but results differ — engine version changed.' : `Underlying candle data changed (was ${r.original.dataHash}, now ${r.rerun.dataHash}) — the provider revised history.`);
  };
  const exportAs = async (format: 'csv' | 'json') => {
    if (!result) return;
    const res = await fetch(`/api/backtests/${result.id}/export?format=${format}`);
    download(`elf-backtest-${result.id}.${format}`, await res.text(), format === 'csv' ? 'text/csv' : 'application/json');
  };

  const r = result?.result;
  return (
    <>
      <PageHeader title="Backtesting" sub="Same production ELF engine, closed candles in order, no lookahead. Hypothetical results only." right={<MarketPicker market={market} onChange={setMarket} />} />
      <Card title="Test setup">
        <div className="form-grid">
          <Field label="From (UTC date)"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To (UTC date)"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          <Field label="Fee per side (%)" hint="e.g. Binance.US taker fees; 0 if unknown"><input inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} /></Field>
          <Field label="Slippage per fill (bps)"><input inputMode="decimal" value={slip} onChange={(e) => setSlip(e.target.value)} /></Field>
          <Field label="Starting equity"><input inputMode="decimal" value={equity} onChange={(e) => setEquity(e.target.value)} /></Field>
          <Field label="Risk per trade (%)" hint={`Capped at your max ${app?.risk.maxRiskPct ?? 2}%`}><input inputMode="decimal" value={riskPct} onChange={(e) => setRiskPct(e.target.value)} /></Field>
          <Field label="Out-of-sample share (%)" hint="The last N% of candles is held out for evaluation"><input type="number" min={0} max={95} value={split} onChange={(e) => setSplit(Number(e.target.value))} /></Field>
          <Field label="Intrabar resolution" hint="Fetch 1m candles to order ambiguous stop/target candles (slower)"><Toggle checked={intrabar} onChange={setIntrabar} label="Use 1m data" /></Field>
        </div>
        <div className="row gap wrap">
          <button className="btn btn-primary" disabled={running} onClick={run}>{running ? 'Running…' : 'Run backtest'}</button>
          <span className="muted small">Uses your current ELF rules (config {elf ? '' : '—'}). Large ranges on 1m–5m data take longer to download the first time; candles are cached.</span>
        </div>
      </Card>

      {r && (
        <>
          <Notice tone="warn">Simulated, theoretical results. A favourable backtest does not show that the strategy is profitable going forward.</Notice>
          <SampleWarning text={r.stats.all.sampleWarning} />
          <Card
            title={`Result #${result!.id} — ${r.symbol} ${r.timeframe}`}
            right={
              <div className="row gap wrap">
                <button className="btn btn-sm" onClick={rerun}>Verify reproducibility</button>
                <button className="btn btn-sm" onClick={() => exportAs('csv')}>CSV</button>
                <button className="btn btn-sm" onClick={() => exportAs('json')}>JSON</button>
              </div>
            }
          >
            {repro && <Notice tone={repro.startsWith('Reproduced') ? 'good' : 'warn'}>{repro}</Notice>}
            <StatsGrid s={r.stats.all} />
            <div className="kv-grid">
              <KV k="Test period" v={`${fmtTime(r.from)} → ${fmtTime(r.to)}`} />
              <KV k="Data source" v={`${r.provider} · ${r.candleCount} candles`} />
              <KV k="Signals" v={`${r.signals.total} (${r.signals.entryReady} entry-ready, ${r.signals.filtered} filtered)`} />
              <KV k="Ambiguous candles" v={r.ambiguousCount} />
              <KV k="Costs" v={`${(r.costs.feeRatePerSide * 100).toFixed(3)}% / side, ${r.costs.slippageBps} bps slippage`} />
              <KV k="Hashes" v={<code>cfg {r.configHash} · data {r.dataHash} · result {r.resultHash}</code>} />
            </div>
          </Card>
          <Card title="Equity curve (account currency, theoretical)">
            <EquityChart points={r.equity} start={r.risk.startingEquity} />
          </Card>
          <div className="grid grid-2">
            <Card title="In-sample">
              <SampleWarning text={r.stats.inSample.sampleWarning} />
              <StatsGrid s={r.stats.inSample} />
            </Card>
            <Card title={`Out-of-sample${r.splitTime ? ` (from ${fmtTime(r.splitTime)})` : ' — none'}`}>
              <SampleWarning text={r.stats.outOfSample.sampleWarning} />
              <StatsGrid s={r.stats.outOfSample} />
            </Card>
            <Card title="Long / short & sessions">
              <Table>
                <thead><tr><th /><th>Trades</th><th>Net R</th><th>Avg R</th></tr></thead>
                <tbody>
                  {Object.entries({ ...r.stats.all.byDirection, ...r.stats.all.bySession }).map(([k, b]) => (
                    <tr key={k}><td>{k}</td><td>{b.count}</td><td>{fmtR(b.netR)}</td><td>{fmtR(b.avgR)}</td></tr>
                  ))}
                </tbody>
              </Table>
            </Card>
            <Card title="Why setups were filtered">
              {Object.keys(r.signals.filterReasons).length === 0 ? <Empty>None.</Empty> : (
                <Table>
                  <tbody>
                    {Object.entries(r.signals.filterReasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                      <tr key={k}><td>{k}</td><td>{v}</td></tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          </div>
          <Card title={`Trades (${r.trades.length})`}>
            {r.trades.length === 0 ? <Empty>No closed trades in this period.</Empty> : (
              <Table>
                <thead><tr><th>Entry (ET)</th><th>Dir</th><th>Entry</th><th>SL</th><th>TP2</th><th>Exit</th><th>Outcome</th><th>Gross R</th><th>Net R</th><th>Sample</th><th>Equity</th></tr></thead>
                <tbody>
                  {r.trades.map((t) => (
                    <tr key={t.id}>
                      <td>{fmtTime(t.entryTime)}</td><td>{t.direction === 'long' ? '▲' : '▼'}</td><td>{fmtPrice(t.entry)}</td><td>{fmtPrice(t.stop)}</td><td>{fmtPrice(t.tp2)}</td><td>{fmtPrice(t.exit)}</td>
                      <td>{t.outcome}{t.ambiguous ? '*' : ''}</td><td>{fmtR(t.grossR)}</td><td className={t.netR >= 0 ? 'pos' : 'neg'}>{fmtR(t.netR)}</td>
                      <td><Badge tone={t.sample === 'out' ? 'info' : 'neutral'}>{t.sample === 'out' ? 'OOS' : 'IS'}</Badge></td><td>{fmtNum(t.equityAfter)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <div className="grid grid-2">
            <Card title={`Data gaps (${r.gaps.length})`}>
              {r.gaps.length === 0 ? <Empty>No missing candles.</Empty> : (
                <ul className="small">
                  {r.gaps.slice(0, 30).map((g) => (<li key={g.from}>{fmtTime(g.from)} → {fmtTime(g.to)}: {g.missingBars} bars missing{g.missingBars > 100 ? ' (likely market closure)' : ''}</li>))}
                  {r.gaps.length > 30 && <li>… {r.gaps.length - 30} more</li>}
                </ul>
              )}
            </Card>
            <Card title="Assumptions">
              <ul className="small">{r.notes.map((n) => (<li key={n}>{n}</li>))}</ul>
            </Card>
          </div>
        </>
      )}

      <Card title="In-sample parameter search">
        <p className="muted small">Evaluates each value on the in-sample period ONLY, picks the best in-sample net R, then reports that single choice on the untouched out-of-sample period. Requires an out-of-sample share &gt; 0.</p>
        <div className="form-row">
          <Field label="Parameter">
            <select value={grid.key} onChange={(e) => setGrid({ ...grid, key: e.target.value })}>
              {['minRR', 'displacementAtrMult', 'sweepAtrMult', 'swingLength', 'maxConfirmBars', 'displacementBodyRatio'].map((k) => <option key={k}>{k}</option>)}
            </select>
          </Field>
          <Field label="Values (comma-separated)"><input value={grid.values} onChange={(e) => setGrid({ ...grid, values: e.target.value })} /></Field>
          <button className="btn" disabled={running || split <= 0} onClick={runSearch}>Run search</button>
        </div>
        {search && (
          <>
            <Table>
              <thead><tr><th>{grid.key}</th><th>IS trades</th><th>IS net R</th></tr></thead>
              <tbody>{search.rows.map((row: any) => (<tr key={JSON.stringify(row.params)} className={JSON.stringify(row.params) === JSON.stringify(search.best) ? 'hl' : ''}><td>{Object.values(row.params).join(', ')}</td><td>{row.inSampleTrades}</td><td>{fmtR(row.inSampleNetR)}</td></tr>))}</tbody>
            </Table>
            {search.outOfSample && (
              <Notice tone="info">
                Best in-sample: {JSON.stringify(search.best)} → out-of-sample: {search.outOfSample.stats.outOfSample.count} trades, net {fmtR(search.outOfSample.stats.outOfSample.netR)}. {search.outOfSample.stats.outOfSample.sampleWarning ?? ''}
              </Notice>
            )}
          </>
        )}
      </Card>

      <Card title="Saved backtests">
        {history.length === 0 ? <Empty>None yet.</Empty> : (
          <Table>
            <thead><tr><th>#</th><th>Name</th><th>Period</th><th>Trades</th><th>Net R</th><th>Result hash</th><th>Run</th></tr></thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id} className="clickable" onClick={() => open(h.id)}>
                  <td>{h.id}</td><td>{h.name}</td><td className="small">{fmtTime(h.input.from)} → {fmtTime(h.input.to)}</td><td>{h.summary.trades}</td><td>{fmtR(h.summary.netR)}</td><td><code>{h.resultHash}</code></td><td className="small">{fmtTime(Math.floor(h.createdAt / 1000))}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
