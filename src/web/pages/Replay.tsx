import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { api, type Market } from '../lib/api';
import { PageHeader } from '../components/Layout';
import { MarketPicker } from '../components/MarketPicker';
import { ElfChart } from '../components/ElfChart';
import { Badge, Card, Empty, Field, Notice, StateBadge, Table } from '../components/ui';
import { SignalCard, StructureCard, SequenceBar } from '../components/ElfPanels';
import { ReplaySession } from '../../engine/replay';
import { newTrade, stepTrade, closeTradeManually, type TradeState } from '../../engine/trade';
import type { Candle } from '../../shared/types';
import { fmtPrice, fmtR, fmtTime, fromDateInput, toDateInput } from '../lib/format';
import { useVisibility, VisibilityToggles } from './LiveChart';

const SPEEDS = [1, 2, 4, 8, 16, 32];

export function Replay() {
  const { market: liveMarket, elf, app, toast } = useStore();
  const [market, setMarket] = useState<Market>(liveMarket);
  const now = Math.floor(Date.now() / 1000);
  const [from, setFrom] = useState(toDateInput(now - 7 * 86400));
  const [to, setTo] = useState(toDateInput(now - 86400));
  const [warmup, setWarmup] = useState(200);
  const [session, setSession] = useState<ReplaySession | null>(null);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4);
  const [, setTick] = useState(0);
  const [manual, setManual] = useState<TradeState[]>([]);
  const [form, setForm] = useState({ dir: 'long', stop: '', target: '' });
  const [notes, setNotes] = useState('');
  const [showLayers, setShowLayers] = useState(false);
  const { vis, toggle } = useVisibility();
  const meta = useRef<{ from: number; to: number; count: number } | null>(null);
  const manualRef = useRef<TradeState[]>([]);
  manualRef.current = manual;

  const load = async () => {
    if (!elf) return;
    setLoading(true);
    setPlaying(false);
    try {
      const f = fromDateInput(from);
      const t = fromDateInput(to, true);
      const tfSec = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 }[market.timeframe];
      const warmFrom = f - warmup * tfSec * (market.provider === 'binanceus' ? 1 : 2.5);
      const qs = `provider=${market.provider}&symbol=${encodeURIComponent(market.symbol)}`;
      const [main, htf] = await Promise.all([
        api.get<{ candles: Candle[] }>(`/api/candles?${qs}&tf=${market.timeframe}&from=${Math.floor(warmFrom)}&to=${t}`),
        elf.htfBiasEnabled ? api.get<{ candles: Candle[] }>(`/api/candles?${qs}&tf=${elf.htfTimeframe}&from=${f - 400 * 86400}&to=${t}`).catch(() => ({ candles: [] })) : Promise.resolve({ candles: [] as Candle[] }),
      ]);
      if (main.candles.length < 20) throw new Error(`Only ${main.candles.length} candles available for this range.`);
      const startCursor = Math.max(1, main.candles.findIndex((c) => c.time >= f));
      const s = new ReplaySession(main.candles, elf, { symbol: market.symbol, timeframe: market.timeframe, htfCandles: htf.candles, startCursor });
      meta.current = { from: f, to: t, count: main.candles.length };
      setManual([]);
      setSession(s);
      setTick((x) => x + 1);
      if (elf.htfBiasEnabled && !htf.candles.length) toast({ title: 'HTF candles unavailable', message: 'Bias filter will reject setups during this replay.', kind: 'info' });
    } catch (e: any) {
      toast({ title: 'Replay load failed', message: e.message, kind: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const step = (n = 1) => {
    if (!session) return;
    for (let k = 0; k < n && !session.done; k++) {
      session.step(1);
      const c = session.visible().at(-1)!;
      for (const t of manualRef.current) if (t.status === 'open') stepTrade(t, c);
    }
    if (session.done) setPlaying(false);
    setManual([...manualRef.current]);
    setTick((x) => x + 1);
  };

  const back = (n = 1) => {
    if (!session) return;
    setPlaying(false);
    const target = Math.max(1, session.cursor - n);
    session.seek(target);
    // Manual trades opened after the new cursor are removed; others are re-simulated from scratch.
    const vis = session.visible();
    const keep = manualRef.current.filter((t) => t.entryIndex < target).map((t) => {
      const fresh = newTrade(t.id, { direction: t.direction, entry: t.entry, stop: t.initialStop, tp1: t.tp1, tp2: t.tp2 }, t.entryTime, t.entryIndex);
      for (let k = t.entryIndex + 1; k < vis.length; k++) stepTrade(fresh, vis[k]);
      return fresh;
    });
    setManual(keep);
    setTick((x) => x + 1);
  };

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => step(1), 1000 / speed);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, speed, session]);

  const visible = session ? session.visible() : [];
  const snap = session ? session.snapshot() : null;
  const last = visible.at(-1);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const candles = useMemo(() => visible, [visible.length, session]);

  const addManual = () => {
    if (!last || !session) return;
    const stop = Number(form.stop);
    const target = Number(form.target);
    const long = form.dir === 'long';
    if (!(stop > 0 && target > 0) || (long ? !(stop < last.close && target > last.close) : !(stop > last.close && target < last.close))) {
      toast({ title: 'Invalid levels', message: `For a ${form.dir}, stop must be ${long ? 'below' : 'above'} and target ${long ? 'above' : 'below'} the current close ${fmtPrice(last.close)}.`, kind: 'error' });
      return;
    }
    const risk = Math.abs(last.close - stop);
    const t = newTrade(`m${Date.now()}`, { direction: long ? 'long' : 'short', entry: last.close, stop, tp1: long ? last.close + risk : last.close - risk, tp2: target }, last.time, session.cursor - 1);
    setManual((m) => [...m, t]);
  };

  const allTrades = [...(snap?.trades ?? []).map((t) => ({ ...t, src: 'ELF engine' })), ...manual.map((t) => ({ ...t, src: 'Manual' }))];

  const save = async () => {
    if (!session || !meta.current || !elf) return;
    await api.post('/api/replays', { provider: market.provider, symbol: market.symbol, timeframe: market.timeframe, from_time: meta.current.from, to_time: meta.current.to, cursor_time: session.currentTime, config: elf, notes, trades: allTrades });
    toast({ title: 'Replay saved', message: `${allTrades.length} hypothetical trades stored with the exact rule settings.`, kind: 'success' });
  };

  const toJournal = async () => {
    const closed = allTrades.filter((t) => t.status === 'closed' && t.outcome !== 'cancelled');
    for (const t of closed) {
      await api.post('/api/journal', {
        kind: 'hypothetical', source: 'replay', trade_time: t.entryTime + 1, symbol: market.symbol, provider: market.provider, timeframe: market.timeframe, direction: t.direction,
        entry: t.entry, stop: t.initialStop, target: t.tp2, exit_price: t.exitPrice, result_r: t.resultR, outcome: t.outcome === 'tp2' ? 'tp2' : t.outcome === 'sl' ? 'sl' : t.outcome === 'expired' ? 'expired' : t.outcome === 'breakeven' ? 'breakeven' : 'manual',
        setup_type: t.src === 'ELF engine' ? 'ELF (replay)' : 'Manual (replay)', notes: `Replay ${market.symbol} ${market.timeframe}${t.ambiguous ? ' — ambiguous candle, stop assumed first' : ''}`, rule_compliant: t.src === 'ELF engine' ? true : null, signal_id: t.src === 'ELF engine' ? t.id : null,
      });
    }
    toast({ title: 'Added to journal', message: `${closed.length} hypothetical trades (kind = hypothetical).`, kind: 'success' });
  };

  if (!app || !vis || !elf) return null;
  return (
    <>
      <PageHeader title="Replay" sub="Candle-by-candle historical simulation. Future candles are never shown or used." right={<MarketPicker market={market} onChange={(m) => { setMarket(m); setSession(null); }} />} />
      <Notice tone="warn">HISTORICAL SIMULATION — not live data. Hypothetical results only.</Notice>
      <Card>
        <div className="form-row">
          <Field label="From (UTC date)">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To (UTC date)">
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Field label="Warm-up bars before start">
            <input type="number" min={0} max={2000} value={warmup} onChange={(e) => setWarmup(Number(e.target.value))} />
          </Field>
          <button className="btn btn-primary" onClick={load} disabled={loading}>
            {loading ? 'Loading…' : 'Load replay'}
          </button>
        </div>
      </Card>
      {!session ? (
        <Empty>Choose a market and date range, then load. Candles before the start date warm up indicators but the replay starts at the start date.</Empty>
      ) : (
        <>
          <div className="replay-controls">
            <button className="btn" onClick={() => back(10)} aria-label="Back 10">⏪ 10</button>
            <button className="btn" onClick={() => back(1)} aria-label="Back 1">◀ 1</button>
            <button className="btn btn-primary" onClick={() => setPlaying((p) => !p)} disabled={session.done}>
              {playing ? '❚❚ Pause' : '▶ Play'}
            </button>
            <button className="btn" onClick={() => step(1)} disabled={session.done}>1 ▶</button>
            <button className="btn" onClick={() => step(10)} disabled={session.done}>10 ⏩</button>
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Speed">
              {SPEEDS.map((s) => (
                <option key={s} value={s}>{s} bars/s</option>
              ))}
            </select>
            <span className="muted small">
              {fmtTime(session.currentTime)} · bar {session.cursor}/{session.length}
            </span>
            <StateBadge state={snap?.state} />
            <button className="btn btn-sm" onClick={() => setShowLayers((v) => !v)}>Layers</button>
          </div>
          {showLayers && <VisibilityToggles vis={vis} toggle={toggle} />}
          <p className="muted small ellipsis">{snap?.stateReason}</p>
          <div className="chart-layout with-panel">
            <ElfChart candles={candles} snapshot={snap} visibility={vis} colors={app.chart.colors as any} resetKey={`replay:${meta.current?.from}:${market.symbol}:${market.timeframe}`} watermark="REPLAY" height="56vh" />
            <div className="side-panel">
              <SequenceBar snapshot={snap} />
              <SignalCard s={snap} />
              <StructureCard s={snap} />
            </div>
          </div>
          <div className="grid grid-2">
            <Card title="Record a hypothetical trade at the current close">
              <div className="form-row">
                <Field label="Direction">
                  <select value={form.dir} onChange={(e) => setForm({ ...form, dir: e.target.value })}>
                    <option value="long">Long</option>
                    <option value="short">Short</option>
                  </select>
                </Field>
                <Field label={`Stop (close ${fmtPrice(last?.close)})`}>
                  <input inputMode="decimal" value={form.stop} onChange={(e) => setForm({ ...form, stop: e.target.value })} />
                </Field>
                <Field label="Target">
                  <input inputMode="decimal" value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} />
                </Field>
                <button className="btn" onClick={addManual}>Add</button>
              </div>
              <p className="muted small">ELF engine trades are recorded automatically when a setup is ENTRY READY. Manual trades let you compare your discretion against the rules.</p>
            </Card>
            <Card title="Save">
              <Field label="Notes">
                <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What did you observe vs. the rules?" />
              </Field>
              <div className="row gap wrap">
                <button className="btn" onClick={save}>Save replay</button>
                <button className="btn" onClick={toJournal}>Send closed trades to journal (hypothetical)</button>
              </div>
            </Card>
          </div>
          <Card title={`Hypothetical trades (${allTrades.length})`}>
            {allTrades.length === 0 ? (
              <Empty>None yet.</Empty>
            ) : (
              <Table>
                <thead>
                  <tr><th>Source</th><th>Entry time</th><th>Dir</th><th>Entry</th><th>SL</th><th>TP2</th><th>Status</th><th>Result</th><th /></tr>
                </thead>
                <tbody>
                  {allTrades.map((t) => (
                    <tr key={t.id}>
                      <td><Badge tone={t.src === 'Manual' ? 'neutral' : 'accent'}>{t.src}</Badge></td>
                      <td>{fmtTime(t.entryTime)}</td>
                      <td>{t.direction === 'long' ? '▲' : '▼'}</td>
                      <td>{fmtPrice(t.entry)}</td>
                      <td>{fmtPrice(t.initialStop)}</td>
                      <td>{fmtPrice(t.tp2)}</td>
                      <td>{t.status === 'open' ? (t.tp1Hit ? 'open · TP1 hit' : 'open') : t.outcome}{t.ambiguous ? '*' : ''}</td>
                      <td className={(t.resultR ?? 0) >= 0 ? 'pos' : 'neg'}>{fmtR(t.resultR)}</td>
                      <td>
                        {t.status === 'open' && (
                          <button
                            className="btn btn-sm"
                            onClick={() => {
                              if (t.src === 'Manual') {
                                const m = manual.find((x) => x.id === t.id)!;
                                closeTradeManually(m, last!.close, last!.time);
                                setManual([...manual]);
                              } else {
                                session.closeTrade(last!.close);
                                setTick((x) => x + 1);
                              }
                            }}
                          >
                            Close @ {fmtPrice(last?.close)}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            <p className="muted small">* ambiguous candle touched stop and target — stop assumed first (intrabar order unknown).</p>
          </Card>
        </>
      )}
    </>
  );
}
