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
                  <td className="small">{x.reasons.join('; ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Card title="How the engine decides">
        <ol className="explain">
          <li><strong>Liquidity</strong> — PDH/PDL, completed session highs/lows, confirmed swings and EQH/EQL. Developing ranges are not liquidity until complete.</li>
          <li><strong>Sweep</strong> — wick penetration ≥ sweep × ATR. A touch or a smaller probe is not a sweep. Each level alerts once.</li>
          <li><strong>Close back</strong> — a candle must close back through the swept level.</li>
          <li><strong>BOS</strong> — a CLOSE beyond the latest confirmed swing formed at/before the sweep. Wicks don’t count; swings are only known swing-length bars later.</li>
          <li><strong>Displacement</strong> — a candle (or up to N consecutive candles) in the setup direction with body ≥ k × ATR and body/range ≥ threshold, on/after the sweep candle.</li>
          <li><strong>Plan</strong> — entry = confirmation close; stop = sweep extreme ∓ buffer × ATR; TP1 = 1R; TP2 = nearest untested opposing liquidity. Filters: HTF bias, session, news blackout, R:R.</li>
          <li><strong>Expiry</strong> — if the sequence doesn’t complete within the window, the setup expires with the missing step recorded.</li>
        </ol>
      </Card>
      <Modal open={!!sel} onClose={() => setSel(null)} title={sel ? `${sel.direction.toUpperCase()} signal ${fmtTime(sel.time)}` : ''}>
        {sel && (
          <>
            <PlanView plan={sel.plan} status={sel.status} reasons={sel.reasons} />
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
