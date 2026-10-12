import type { EngineSnapshot, Signal, TradePlan } from '../../engine/engine';
import { SESSION_LABELS } from '../../engine/sessions';
import { fmtPrice, fmtTime, fmtR } from '../lib/format';
import { Badge, Card, KV, StateBadge, Notice } from './ui';

export function PlanView({ plan, status, reasons }: { plan: TradePlan; status: Signal['status']; reasons: string[] }) {
  const long = plan.direction === 'long';
  return (
    <div className="plan">
      <div className="plan-h">
        <Badge tone={long ? 'good' : 'bad'}>{long ? 'LONG' : 'SHORT'}</Badge>
        <Badge tone={status === 'ENTRY_READY' ? 'accent' : 'bad'}>{status.replace('_', ' ')}</Badge>
        <span className="muted small">Theoretical levels — not a broker order</span>
      </div>
      <div className="plan-grid">
        <KV k="Entry" v={fmtPrice(plan.entry)} />
        <KV k="Stop-loss" v={<span className="neg">{fmtPrice(plan.stop)}</span>} />
        <KV k="Target 1 (1R)" v={<span className="pos">{fmtPrice(plan.tp1)}</span>} />
        <KV k="Target 2" v={plan.tp2 !== null ? <span className="pos">{fmtPrice(plan.tp2)} <small className="muted">{plan.tp2Label}</small></span> : '— none'} />
        <KV k="Risk / unit" v={fmtPrice(plan.riskPerUnit)} />
        <KV k="Reward / unit" v={fmtPrice(plan.rewardPerUnit)} />
        <KV k="R:R (to TP2)" v={plan.rr !== null ? `${plan.rr.toFixed(2)} (min ${plan.minRR.toFixed(1)})` : '—'} />
        <KV k="Invalidation" v={fmtPrice(plan.invalidation)} />
      </div>
      <Checks checks={plan.checks} />
      {reasons.length > 0 && <Notice tone="bad">FILTERED: {reasons.join(' · ')}</Notice>}
    </div>
  );
}

export function Checks({ checks }: { checks: TradePlan['checks'] }) {
  return (
    <ul className="checks">
      {checks.map((c) => (
        <li key={c.rule} className={c.pass ? 'ok' : 'fail'}>
          <span className="ck">{c.pass ? '✓' : '✗'}</span>
          <span className="ck-r">{c.rule}</span>
          <span className="ck-d muted">{c.detail}</span>
        </li>
      ))}
    </ul>
  );
}

export const SEQUENCE: { key: string; label: string }[] = [
  { key: 'BUILD', label: 'Build' },
  { key: 'LIQUIDITY', label: 'Liquidity' },
  { key: 'SWEEP', label: 'Sweep' },
  { key: 'BOS', label: 'BOS' },
  { key: 'DISP', label: 'Displacement' },
  { key: 'ENTRY', label: 'Entry setup' },
  { key: 'MANAGE', label: 'Management' },
];

/** Which sequence steps are satisfied right now. */
export function sequenceProgress(s: EngineSnapshot | null): Record<string, 'done' | 'active' | 'todo'> {
  const r: Record<string, 'done' | 'active' | 'todo'> = Object.fromEntries(SEQUENCE.map((x) => [x.key, 'todo']));
  if (!s) return r;
  const hasLevels = s.levels.some((l) => l.status === 'untested');
  if (s.barCount > 0) r.BUILD = 'done';
  if (hasLevels) r.LIQUIDITY = 'done';
  const c = s.candidate;
  if (s.trade) {
    for (const k of ['SWEEP', 'BOS', 'DISP', 'ENTRY']) r[k] = 'done';
    r.MANAGE = 'active';
  } else if (c) {
    r.SWEEP = c.reclaimIndex !== null ? 'done' : 'active';
    r.BOS = c.bos ? 'done' : 'active';
    r.DISP = c.displacement ? 'done' : 'active';
  } else if (s.state === 'ENTRY_READY' || s.state === 'FILTERED') {
    if (s.lastSignal && s.lastSignal.time === s.lastTime) {
      for (const k of ['SWEEP', 'BOS', 'DISP']) r[k] = 'done';
      r.ENTRY = s.state === 'ENTRY_READY' ? 'done' : 'active';
    }
  } else if (hasLevels) r.SWEEP = 'active';
  return r;
}

export function SequenceBar({ snapshot }: { snapshot: EngineSnapshot | null }) {
  const p = sequenceProgress(snapshot);
  return (
    <ol className="sequence">
      {SEQUENCE.map((x) => (
        <li key={x.key} className={p[x.key]}>
          {x.label}
        </li>
      ))}
    </ol>
  );
}

export function StateCard({ s }: { s: EngineSnapshot | null }) {
  return (
    <Card title="ELF state" right={<StateBadge state={s?.state} />}>
      <p className="state-reason">{s?.stateReason ?? 'Waiting for data…'}</p>
      <SequenceBar snapshot={s} />
      <div className="kv-grid">
        <KV k="ATR" v={fmtPrice(s?.atr)} />
        <KV k="Bars processed" v={s?.barCount ?? '—'} />
        <KV k="Last closed candle" v={fmtTime(s?.lastTime)} />
        <KV k="Config" v={<code>{s?.configHash ?? '—'}</code>} />
      </div>
    </Card>
  );
}

export function BiasCard({ s, htfMessage }: { s: EngineSnapshot | null; htfMessage?: string }) {
  const b = s?.bias;
  return (
    <Card title="Higher-timeframe bias" right={<Badge tone={b?.value === 'bullish' ? 'good' : b?.value === 'bearish' ? 'bad' : 'neutral'}>{b?.value ?? '—'}</Badge>}>
      <div className="kv-grid">
        <KV k={`${b?.timeframe ?? ''} close`} v={fmtPrice(b?.close)} />
        <KV k="EMA" v={fmtPrice(b?.ema)} />
        <KV k="HTF candle" v={b?.htfTime ? new Date(b.htfTime * 1000).toISOString().slice(0, 10) : '—'} />
      </div>
      <p className="muted small">Analytical filter from completed candles only — not a prediction. {htfMessage}</p>
    </Card>
  );
}

export function SessionCard({ s }: { s: EngineSnapshot | null }) {
  const active = s?.sessions.active ?? [];
  return (
    <Card title="Session" right={<Badge tone={active.length ? 'accent' : 'neutral'}>{active.length ? active.map((a) => SESSION_LABELS[a]).join(', ') : 'Outside windows'}</Badge>}>
      <div className="kv-grid">
        {(s?.sessions.developing ?? []).map((d) => (
          <KV key={d.key} k={`${d.label} (developing)`} v={`${fmtPrice(d.low)} – ${fmtPrice(d.high)}`} />
        ))}
        {(s?.sessions.completed ?? []).slice(-2).map((d) => (
          <KV key={d.key} k={`${d.label} ${d.key.split(':')[1]}`} v={`${fmtPrice(d.low)} – ${fmtPrice(d.high)}`} />
        ))}
        <KV k="Previous day H / L" v={s?.sessions.previousDay ? `${fmtPrice(s.sessions.previousDay.high)} / ${fmtPrice(s.sessions.previousDay.low)}` : '—'} />
        <KV k="Today H / L (developing)" v={s?.sessions.day ? `${fmtPrice(s.sessions.day.high)} / ${fmtPrice(s.sessions.day.low)}` : '—'} />
      </div>
    </Card>
  );
}

export function LiquidityCard({ s }: { s: EngineSnapshot | null }) {
  const active = (s?.levels ?? []).filter((l) => l.status === 'untested');
  return (
    <Card title="Nearest liquidity">
      <div className="liq">
        <div>
          <div className="liq-h pos">Above</div>
          {s?.nearestAbove ? (
            <div className="liq-v">
              {fmtPrice(s.nearestAbove.price)} <small className="muted">{s.nearestAbove.label}</small>
            </div>
          ) : (
            <div className="muted">none tracked</div>
          )}
        </div>
        <div>
          <div className="liq-h neg">Below</div>
          {s?.nearestBelow ? (
            <div className="liq-v">
              {fmtPrice(s.nearestBelow.price)} <small className="muted">{s.nearestBelow.label}</small>
            </div>
          ) : (
            <div className="muted">none tracked</div>
          )}
        </div>
      </div>
      <p className="muted small">{active.length} untested levels tracked (PDH/PDL, session, swing, EQH/EQL).</p>
    </Card>
  );
}

export function StructureCard({ s }: { s: EngineSnapshot | null }) {
  const sw = s?.sweeps.at(-1);
  const bos = s?.structureBreaks.at(-1);
  const d = s?.displacements.at(-1);
  const fvgActive = (s?.fvgs ?? []).filter((f) => f.status === 'active' || f.status === 'partial');
  const obActive = (s?.orderBlocks ?? []).filter((o) => o.status !== 'invalidated');
  const c = s?.candidate;
  return (
    <Card title="Structure">
      <div className="kv-grid">
        <KV
          k="Latest sweep"
          v={sw ? <>{sw.direction === 'long' ? '▲' : '▼'} {sw.levelLabel} {fmtPrice(sw.levelPrice)} <small className="muted">wick {fmtPrice(sw.extreme)} · {fmtTime(sw.startTime)}{sw.eligible ? '' : ' · not eligible'}</small></> : '—'}
        />
        <KV k="BOS status" v={c ? (c.bos ? `confirmed @ ${fmtPrice(c.bos.price)}` : c.bosRef ? `waiting for close beyond ${fmtPrice(c.bosRef.price)}` : 'no confirmed swing yet') : bos ? `last ${bos.direction === 'long' ? 'bullish' : 'bearish'} @ ${fmtPrice(bos.price)} (${fmtTime(bos.time)})` : '—'} />
        <KV k="Displacement" v={c ? (c.displacement ? `confirmed (${(c.displacement.body / c.displacement.atr).toFixed(2)}× ATR)` : 'waiting') : d ? `last ${d.direction === 'long' ? 'bullish' : 'bearish'} ${(d.body / d.atr).toFixed(2)}× ATR (${fmtTime(d.time)})` : '—'} />
        <KV k="FVGs" v={`${fvgActive.length} open (${fvgActive.filter((f) => f.direction === 'bullish').length} bull / ${fvgActive.filter((f) => f.direction === 'bearish').length} bear)`} />
        <KV k="Order blocks" v={`${obActive.length} active/tested`} />
      </div>
    </Card>
  );
}

export function SignalCard({ s }: { s: EngineSnapshot | null }) {
  const sig = s?.trade ? s.signals.find((x) => x.id === s.trade!.id) : s?.lastSignal;
  return (
    <Card title={s?.trade ? 'Managing (theoretical)' : 'Latest signal'} right={sig ? <span className="muted small">{fmtTime(sig.time)}</span> : null}>
      {sig ? <PlanView plan={sig.plan} status={sig.status} reasons={sig.reasons} /> : <p className="muted">No confirmed ELF setup in the loaded history.</p>}
      {s?.trade && (
        <div className="kv-grid">
          <KV k="TP1 reached" v={s.trade.tp1Hit ? 'yes' : 'no'} />
          <KV k="Bars held" v={s.trade.barsHeld} />
        </div>
      )}
      {s?.trades.length ? (
        <p className="muted small">
          Last theoretical outcome: {s.trades.at(-1)!.outcome ?? 'open'} {fmtR(s.trades.at(-1)!.resultR)}
          {s.trades.at(-1)!.ambiguous ? ' (ambiguous candle — stop assumed first)' : ''}
        </p>
      ) : null}
    </Card>
  );
}
