# ELF Trading App — Emerald Liquidity Flow

A personal trading workstation built around the **ELF** framework. It is decision support only — the app never places orders.

**BUILD → LIQUIDITY → SWEEP → BOS → DISPLACEMENT → ENTRY SETUP → TRADE MANAGEMENT**

* Real market data from Binance.US (public, no key), OANDA, Alpaca and Yahoo (fallback, always DELAYED).
* Feed status is reported honestly: LIVE / REST POLLING / DELAYED / DISCONNECTED / NEEDS KEY / ERROR.
* A deterministic, closed-candle ELF state machine (`src/engine`) is shared by the live monitor, replay and backtests.
  * The default is a **faithful port of your ELF v1.1 Pine Script** (`pineV11.ts`).
  * An *Extended* multi-candle model is also available.
* Chart overlays:
  * sessions
  * PDH/PDL, session, swing and EQH/EQL liquidity
  * sweeps, BOS and displacement
  * FVGs and order blocks
  * entry, SL, TP1 and TP2
  * outcomes
* Alerts are de-duplicated and delivered in-app, as browser notifications, and by an optional server webhook.
* Trade planner and risk calculator, managed plans, a journal with analytics (actual and hypothetical kept separate), replay, and backtesting with costs, in/out-of-sample splits and reproducibility hashes.
* Mobile-first PWA: it installs to the iPhone Home Screen, works on tablets and desktop, and uses a dark theme with emerald accents.

> **Not financial advice. No profitability is implied.** Backtests and replays are theoretical simulations.

## Get it on your iPhone

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/artisdigital/Elf-strategy)

1. Deploy the server with the button above. The `render.yaml` blueprint sets up HTTPS, a persistent disk and a required password.
2. Open your URL in Safari → Share → **Add to Home Screen**.
3. In the installed app: **Alerts → Enable push on this device**.

Full walkthrough: **[docs/DEPLOY.md](docs/DEPLOY.md)**.

## Quick start

Requirements: **Node.js ≥ 22.13** (it uses the built-in `node:sqlite`; no native modules).

```bash
npm install
cp .env.example .env          # optional — fill in keys / password
npm run dev                   # API on :8787 + Vite dev server on :5173 (open http://localhost:5173)
```

Production (single process, serves the built client):

```bash
npm run build
ELF_APP_PASSWORD='choose-a-long-password' npm start     # http://localhost:8787
```

Behind a corporate/sandbox HTTPS proxy, add `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21) so the server can reach providers.

### Open it on your iPhone

1. Run the server on a machine your phone can reach (see Deployment), **with `ELF_APP_PASSWORD` set**.
2. Open the URL in Safari → Share → **Add to Home Screen**.
3. On iOS 16.4 and later, the installed app receives **Web Push** alerts even when it's closed. Enable push on the Alerts page. A webhook (ntfy, Slack, Discord) is also available.

## Tests

```bash
npm test               # unit (synthetic candles) + integration (server, feeds, persistence, security)
npm run test:live      # opt-in: real Binance.US requests
npm run test:e2e       # Playwright on iPhone-13 + desktop viewports (builds first)
npm run typecheck
```

## Market data providers

| Provider | Key | Transport | Notes |
|---|---|---|---|
| Binance.US | none (public) | WebSocket kline stream → REST polling fallback | Spot crypto. Daily candles are UTC-aligned. |
| OANDA | API token (practice or live) | REST polling | Forex/metals mid prices. Tokens can't be made read-only — the app only calls market-data endpoints. |
| Alpaca | key ID + secret | REST polling | `iex` feed is free (IEX volume only); `sip` needs a paid subscription. |
| Yahoo | none | REST polling | Unofficial, rate-limited, always **DELAYED**. |

Keys are entered on the **Market Data Providers** page. They're stored encrypted on the server (AES-256-GCM) and never sent to the browser. Environment variables (see `.env.example`) take precedence. Use market-data-only or paper keys, and never enable withdrawals.

## Deployment

### Docker

```bash
docker build -t elf .
docker run -d --name elf -p 8787:8787 -v elf-data:/app/data \
  -e ELF_APP_PASSWORD='long-password' -e ELF_SECRET_KEY="$(openssl rand -hex 32)" elf
```

### Any Node host (VPS, Raspberry Pi, Fly.io, Render, Railway…)

```bash
npm ci && npm run build && NODE_ENV=production ELF_APP_PASSWORD=… npm start
```

* Put it behind HTTPS (Caddy, nginx or the platform's TLS). The session cookie is marked `Secure` when served over HTTPS.
* Persist `ELF_DATA_DIR` (the default is `./data`). It holds the SQLite database and `secret.key`. **Back up both together**: credentials can't be decrypted without the key.
* Set `ELF_SECRET_KEY` explicitly on hosts with ephemeral disks.
* The server must stay running for watch-list monitoring, plan monitoring and webhook alerts.

## Documentation

* [`docs/ELF_RULES.md`](docs/ELF_RULES.md) — every rule, default, timing detail and assumption.
* [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — modules and data flow.
* [`docs/FEATURE_STATUS.md`](docs/FEATURE_STATUS.md) — completion report, verification evidence and known limitations.
