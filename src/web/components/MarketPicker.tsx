import { useStore } from '../lib/store';
import type { Market, ProviderId, Timeframe } from '../lib/api';
import { CHART_TIMEFRAMES } from '../../shared/types';

export function MarketPicker({ market, onChange, timeframes = CHART_TIMEFRAMES }: { market: Market; onChange: (m: Market) => void; timeframes?: Timeframe[] }) {
  const { instruments, providers } = useStore();
  const prov = providers.find((p) => p.id === market.provider);
  const list = instruments.filter((i) => i.provider === market.provider);
  const known = list.some((i) => i.symbol === market.symbol);
  const tfs = timeframes.filter((t) => !prov || prov.timeframes.includes(t));
  return (
    <div className="picker">
      <select
        aria-label="Data provider"
        value={market.provider}
        onChange={(e) => {
          const p = e.target.value as ProviderId;
          const first = instruments.find((i) => i.provider === p);
          onChange({ provider: p, symbol: first?.symbol ?? market.symbol, timeframe: market.timeframe });
        }}
      >
        {providers.map((p) => (
          <option key={p.id} value={p.id} disabled={!p.enabled}>
            {p.name}
            {!p.configured ? ' — needs key' : ''}
            {!p.enabled ? ' (disabled)' : ''}
          </option>
        ))}
      </select>
      <select aria-label="Symbol" value={market.symbol} onChange={(e) => onChange({ ...market, symbol: e.target.value })}>
        {!known && <option value={market.symbol}>{market.symbol}</option>}
        {list.map((i) => (
          <option key={i.symbol} value={i.symbol}>
            {i.symbol} — {i.name}
          </option>
        ))}
      </select>
      <div className="seg" role="group" aria-label="Timeframe">
        {tfs.map((t) => (
          <button key={t} className={t === market.timeframe ? 'on' : ''} onClick={() => onChange({ ...market, timeframe: t })}>
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}
