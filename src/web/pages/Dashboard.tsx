import { Link } from 'react-router-dom';
import { useStore } from '../lib/store';
import { useMarketStream } from '../lib/useMarketStream';
import { PageHeader } from '../components/Layout';
import { MarketPicker } from '../components/MarketPicker';
import { BiasCard, LiquidityCard, SessionCard, SignalCard, StateCard, StructureCard } from '../components/ElfPanels';
import { Card, FeedBadge, KV, Notice } from '../components/ui';
import { fmtPrice, fmtTime } from '../lib/format';

export function Dashboard() {
  const { market, setMarket, providers, elf } = useStore();
  const stream = useMarketStream(market);
  const s = stream.monitor?.snapshot ?? null;
  const prov = providers.find((p) => p.id === market.provider);
  const last = stream.candles.at(-1);
  return (
    <>
      <PageHeader title="Dashboard" sub="Live ELF state computed on the server from closed candles." right={<MarketPicker market={market} onChange={setMarket} />} />
      {stream.error && <Notice tone="warn">{stream.error}</Notice>}
      {stream.feed?.status === 'NEEDS KEY' && (
        <Notice tone="warn">
          {prov?.name} needs an API key. <Link to="/providers">Configure it on the Market Data page.</Link>
        </Notice>
      )}
      {elf?.newsBlackout && <Notice tone="bad">News blackout is ON — new entries are blocked (Settings & Rules).</Notice>}
      <div className="grid">
        <Card title="Market" right={<FeedBadge feed={stream.feed} compact />}>
          <div className="price-big">{fmtPrice(last?.close)}</div>
          <div className="kv-grid">
            <KV k="Symbol / timeframe" v={`${market.symbol} · ${market.timeframe}`} />
            <KV k="Provider" v={prov?.name ?? market.provider} />
            <KV k="Feed" v={<small>{stream.feed?.message ?? '—'}</small>} />
            <KV k="Last candle" v={fmtTime(last?.time)} />
            <KV k="Candles loaded" v={stream.candles.length} />
          </div>
        </Card>
        <StateCard s={s} />
        <SignalCard s={s} />
        <BiasCard s={s} htfMessage={stream.monitor?.htf.message} />
        <SessionCard s={s} />
        <LiquidityCard s={s} />
        <StructureCard s={s} />
        <Card title="Rules in force">
          <div className="kv-grid">
            <KV k="Engine" v={elf?.engineModel === 'extended' ? 'Extended model' : 'ELF v1.1 (Pine parity)'} />
            <KV k="Sweep threshold" v={`${elf?.sweepAtrMult} × ATR(${elf?.atrPeriod})`} />
            <KV k="Displacement" v={`${elf?.displacementAtrMult} × ATR, body ≥ ${Math.round((elf?.displacementBodyRatio ?? 0) * 100)}%`} />
            <KV k="Confirmation window" v={`${elf?.maxConfirmBars} bars`} />
            <KV k="Minimum R:R" v={`1 : ${elf?.minRR}`} />
            <KV k="HTF bias" v={elf?.htfBiasEnabled ? `${elf.htfTimeframe} EMA ${elf.htfEmaLength}` : 'off'} />
            <KV k="Session gate" v={elf?.sessionGate} />
          </div>
          <p className="muted small">
            <Link to="/settings">Edit rules</Link> · the engine never invents confirmations; a sweep is not a trade and a confirmed setup is not a guarantee.
          </p>
        </Card>
      </div>
      {s && s.signals.length === 0 && <p className="muted small">The loaded history ({s.barCount} candles) contains no confirmed ELF sequence yet.</p>}
      {last && <p className="muted small">Prices: {prov?.name}. Last update {fmtTime(last.time)}. Not financial advice.</p>}
    </>
  );
}
