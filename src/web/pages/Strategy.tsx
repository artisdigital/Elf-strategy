import { useState } from 'react';
import { useStore } from '../lib/store';
import { useMarketStream } from '../lib/useMarketStream';
import { PageHeader } from '../components/Layout';
import { MarketPicker } from '../components/MarketPicker';
import { Badge, Card, Empty, KV, Modal, Table } from '../components/ui';
import { PlanView, SequenceBar, StateCard } from '../components/ElfPanels';
import { fmtPrice, fmtTime } from '../lib/format';
import type { Signal } from '../../engine/engine';

const STATES = [
  ['IDLE', 'Warming up indicators or no liquidity established yet.'],
  ['BUILD', 'Ranges and liquidity levels are tracked; waiting for a qualifying sweep.'],
  ['SWEPT', 'A level was penetrated by ≥ the sweep threshold. Waiting for close back, BOS and displacement within the window.'],
  ['CONFIRMED', 'Sweep → BOS (close) → displacement complete. The plan is evaluated on the same candle close.'],
  ['ENTRY READY', 'All mandatory filters passed (bias, session, target, R:R). A theoretical plan is shown — no order is placed.'],
  ['MANAGING', 'Tracking the theoretical trade against stop / TP1 / TP2 on closed candles.'],
  ['COMPLETED', 'Target, stop, expiry or manual close recorded.'],
  ['FILTERED', 'A setup was rejected or expired — the exact reason is recorded.'],
];

export function Strategy() {
  const { market, setMarket } = useStore();
  const stream = useMarketStream(market);
  const s = stream.monitor?.snapshot ?? null;
  const [sel, setSel] = useState<Signal | null>(null);
  const signals = [...(s?.signals ?? [])].reverse();
  return (
    <>
      <PageHeader title="ELF Strategy" sub="BUILD → LIQUIDITY → SWEEP → BOS → DISPLACEMENT → ENTRY → MANAGEMENT" right={<MarketPicker market={market} onChange={setMarket} />} />
      <div className="grid">
        <StateCard s={s} />
        <Card title="Pending setup">
          {s?.candidate ? (
            <div className="kv-grid">
              <KV k="Direction" v={<Badge tone={s.candidate.direction === 'long' ? 'good' : 'bad'}>{s.candidate.direction.toUpperCase()}</Badge>} />
              <KV k="Swept level" v={`${s.candidate.sweep.levelLabel} @ ${fmtPrice(s.candidate.sweep.levelPrice)}`} />
              <KV k="Wick extreme" v={fmtPrice(s.candidate.extreme)} />
              <KV k="Penetration" v={`${fmtPrice(s.candidate.sweep.penetration)} (threshold ${fmtPrice(s.candidate.sweep.threshold)})`} />
              <KV k="Close back" v={s.candidate.reclaimIndex !== null ? '✓' : 'waiting'} />
              <KV k="BOS" v={s.candidate.bos ? `✓ ${fmtPrice(s.candidate.bos.price)}` : s.candidate.bosRef ? `needs close beyond ${fmtPrice(s.candidate.bosRef.price)}` : 'no confirmed swing'} />
              <KV k="Displacement" v={s.candidate.displacement ? '✓' : 'waiting'} />
              <KV k="Sweep time" v={fmtTime(s.candidate.sweep.startTime)} />
            </div>
          ) : (
            <Empty>No pending sweep. {s?.state === 'MANAGING' ? 'A theoretical trade is being managed.' : ''}</Empty>
          )}
        </Card>
        <Card title="State machine">
          <SequenceBar snapshot={s} />
          <ul className="states">
            {STATES.map(([k, d]) => (
              <li key={k} className={s?.state.replace('_', ' ') === k ? 'on' : ''}>
                <strong>{k}</strong> <span className="muted">{d}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <Card title={`Signals in loaded history (${signals.length})`}>
        {signals.length === 0 ? (
          <Empty>No confirmed sequences yet.</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Time (ET)</th>
                <th>Dir</th>
                <th>Status</th>
                <th>Entry</th>
                <th>SL</th>
                <th>TP2</th>
                <th>R:R</th>
                <th>Q</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {signals.map((x) => (
                <tr key={x.id} onClick={() => setSel(x)} className="clickable">
                  <td>{fmtTime(x.time)}</td>
                  <td>{x.direction === 'long' ? '▲' : '▼'}</td>
                  <td>
                    <Badge tone={x.status === 'ENTRY_READY' ? 'accent' : 'bad'}>{x.status.replace('_', ' ')}</Badge>
                  </td>
                  <td>{fmtPrice(x.plan.entry)}</td>
                  <td>{fmtPrice(x.plan.stop)}</td>
                  <td>{fmtPrice(x.plan.tp2)}</td>
                  <td>{x.plan.rr?.toFixed(2) ?? '—'}</td>
                  <td>{x.quality ?? '—'}</td>
                  <td className="small">{x.reasons.join('; ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Card title="How the engine decides">
        <ol className="explain">
          <li><strong>Liquidity (v1.1)</strong> — the latest completed London / New York (/ Sydney) high and low, PDH/PDL, the latest confirmed swing high and low, and the last 8 EQH/EQL. Developing ranges are not liquidity until complete.</li>
          <li><strong>Sweep</strong> — inside an enabled window, a wick goes ≥ 0.05 × ATR beyond the NEAREST level and the same candle closes back. A touch or smaller probe is not a sweep.</li>
          <li><strong>Confirmation</strong> — ONE later closed candle, within 20 bars, that closes back beyond the swept level, crosses the latest swing by its close (BOS) and is a displacement candle (body ≥ 1 × ATR, body ≥ 50% of range) — inside an enabled window.</li>
          <li><strong>Plan</strong> — entry = confirmation close; stop = sweep candle wick ∓ 0.10 × ATR; TP1 = 1R; TP2 = nearest liquidity beyond entry; R:R to TP2 ≥ 3 (2 selectable). HTF bias filter: daily close vs EMA 50.</li>
          <li><strong>One setup per sweep</strong> — no new sweeps while a setup is pending or monitored (including a FILTERED one); everything resets at the first enabled session open each day.</li>
          <li>The <em>Extended</em> model (Settings) allows the close back, BOS and displacement on separate candles and tracks many levels.</li>
        </ol>
      </Card>
      <Modal open={!!sel} onClose={() => setSel(null)} title={sel ? `${sel.direction.toUpperCase()} signal ${fmtTime(sel.time)}` : ''}>
        {sel && (
          <>
            <PlanView plan={sel.plan} status={sel.status} reasons={sel.reasons} quality={sel.quality} />
            <div className="kv-grid">
              <KV k="Sweep" v={`${sel.sweep.levelLabel} ${fmtPrice(sel.sweep.levelPrice)} @ ${fmtTime(sel.sweep.startTime)}`} />
              <KV k="BOS" v={sel.bos ? `${fmtPrice(sel.bos.price)} @ ${fmtTime(sel.bos.time)}` : '—'} />
              <KV k="Displacement" v={sel.displacement ? `${fmtTime(sel.displacement.time)} (${sel.displacement.bars} bar)` : '—'} />
              <KV k="Session" v={sel.session.join(', ') || 'outside'} />
              <KV k="Bias" v={sel.bias.value} />
            </div>
          </>
        )}
      </Modal>
    </>
  );
}
