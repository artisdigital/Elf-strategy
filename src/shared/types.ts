// Shared, framework-free types used by the engine, the server and the web client.

/** Supported chart / execution timeframes plus the daily HTF timeframe. */
export type Timeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d';

export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
};

export const CHART_TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '30m', '1h'];

/**
 * Normalized OHLCV candle.
 * `time` is the candle OPEN time in UTC seconds (provider timestamps are converted).
 * A candle is closed at `time + TIMEFRAME_SECONDS[tf]`.
 */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type ProviderId = 'binanceus' | 'oanda' | 'alpaca' | 'yahoo';

/** Honest feed status. REST polling is never reported as LIVE streaming. */
export type FeedStatus = 'LIVE' | 'REST POLLING' | 'DELAYED' | 'DISCONNECTED' | 'NEEDS KEY' | 'ERROR' | 'CONNECTING';

export type AssetClass = 'crypto' | 'forex' | 'metal' | 'equity' | 'index' | 'other';

export interface InstrumentInfo {
  provider: ProviderId;
  symbol: string; // app-facing symbol, e.g. BTCUSD, EUR_USD, SPY
  providerSymbol: string; // exact identifier sent to the provider
  name: string;
  assetClass: AssetClass;
}

export interface FeedState {
  key: string;
  provider: ProviderId;
  symbol: string;
  timeframe: Timeframe;
  status: FeedStatus;
  transport: 'websocket' | 'rest' | 'none';
  lastUpdate: number | null; // ms
  lastCandleTime: number | null; // s
  message: string;
  delayedBySec?: number;
}

export function tfSeconds(tf: Timeframe): number {
  return TIMEFRAME_SECONDS[tf];
}
