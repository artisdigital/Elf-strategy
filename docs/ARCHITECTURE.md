# Architecture

```
src/
  shared/        types (Candle, Timeframe, FeedState) + America/New_York time helpers
  engine/        PURE TypeScript — no I/O, runs in Node and the browser
    config.ts      versioned ELF config, v1.1 defaults, validation, UI metadata
    indicators.ts  Wilder ATR, EMA (incremental)
    sessions.ts    session windows, developing/completed ranges, trading days
    engine.ts      ElfEngine state machine: levels → sweep → BOS → displacement → plan, FVG/OB
    trade.ts       theoretical outcome tracking (gap/ambiguity rules)
    replay.ts      ReplaySession (engine only sees candles up to the cursor)
    backtest.ts    runBacktest / parameterSearch (same ElfEngine, costs, sizing, IS/OOS, hashes)
    analytics.ts   statistics with definitions + sample-size warnings
    planner.ts     manual risk / position-size calculator
  server/        Express API + SSE, Node 22 built-in SQLite
    providers/     binanceus (REST + WebSocket), oanda, alpaca (REST), yahoo (REST, DELAYED)
    feeds.ts       shared Feed per market: history, WS/REST, backoff, gap fill, honest status
    candles.ts     closed-candle cache + range paging for replay/backtests
    monitor.ts     server ElfEngine per viewed / watch-listed market → snapshots + alerts
    alerts.ts      de-duplicated alerts, preferences, webhook channel
    plans.ts       trade plans monitored on closed candles
    journal.ts     journal CRUD, CSV export, analytics (actual and hypothetical never mixed)
    settings.ts    ELF config (archived by hash) + app settings
    secrets.ts     AES-256-GCM credential encryption
    auth.ts        optional single-user password (HMAC session cookie)
    db.ts          schema migrations
  web/           React + Vite client (PWA)
    lib/overlays.ts         snapshot → boxes / segments / markers (pure)
    lib/overlayPrimitive.ts lightweight-charts primitive that draws them
    pages/                  the 10 screens
tests/
  unit/          deterministic engine tests on SYNTHETIC candles
  integration/   server, feed outage/recovery, persistence, security, adapters (stubbed), live (opt-in)
  e2e/           Playwright on iPhone-13 and desktop viewports
```

## Data flow (live)

1. The browser opens `GET /api/stream?provider&symbol&tf` (Server-Sent Events).
2. `MonitorManager` acquires a shared `Feed`.
   * The feed loads history and tries the WebSocket where one exists (Binance.US).
   * Otherwise, or on failure, it polls REST and reports **REST POLLING**.
3. Each closed candle → `ElfEngine.update()` → events → `AlertService` (de-duplicated) → SSE `monitor` snapshot.
4. The chart, dashboard and alerts are therefore all driven by **one** computation on the server.
5. Watch-list markets keep a monitor running with no browser open, so alerts are recorded and the webhook fires.

## Charting

The charts use TradingView's open-source **lightweight-charts 4.2**. Phase 1 reportedly used a "real candlestick chart" library, but that code wasn't available to check, so lightweight-charts was chosen because:

* it's designed for financial candles;
* its custom primitives let boxes, levels and labels be drawn at real timestamps and prices;
* it supports touch pinch/drag for phones.

Overlays are mapped through bar indices, so they stay aligned even across data gaps. A compact overlay mode is used on charts narrower than 640 px.

## Persistence

All persistent state lives in SQLite at `$ELF_DATA_DIR/elf.db`:

* settings
* the config archive
* encrypted provider credentials
* the candle cache
* alerts
* journal
* plans
* backtests (full inputs and results)
* replays

Migrations are numbered and append-only (`src/server/db.ts`).

## Reproducibility

Every backtest stores:

* the exact config;
* costs, risk and split;
* the data hash (FNV-1a over OHLC);
* the result hash.

`POST /api/backtests/:id/rerun` reloads the cached candles and recomputes. It reports whether both hashes match, or whether the provider revised history.
