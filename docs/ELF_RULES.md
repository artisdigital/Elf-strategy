# ELF v1.1 — rules as implemented

This document is the authoritative description of what the engine (`src/engine/`) does.
Every adjustable value lives in `src/engine/config.ts` with an origin tag:

| Tag | Meaning |
|---|---|
| **ELF v1.1** | Original rule / default from the ELF v1.1 specification you supplied. |
| **OPTIONAL** | Engineering addition. Neutral or off by default; it never changes v1.1 behaviour unless you switch it on. |
| **ASSUMPTION** | The specification did not pin this down. A documented, configurable choice was made (listed below). |

> **Source note.** The original Pine Script v1.1 file and the Phase 1 "rules audit" document were **not available** in
> the repository (it was empty), so the rules below are implemented from the written specification in the build brief.
> If your Pine Script differs anywhere, change the setting or tell me the exact rule and the engine will be adjusted.

## Data and timing (no lookahead)

* Candles are normalized to `{time (open, UTC seconds), open, high, low, close, volume}`.
* The engine only processes **closed** candles, strictly in time order. A live candle is closed when a newer candle
  exists, the WebSocket says so (`x: true` on Binance), or its close time + 2 s has passed.
* Signals are evaluated **at the candle close**. The proposed entry is the close of the confirmation candle.
* Swing pivots (length *L*) are only known *L* bars after the pivot candle. A pivot is a high strictly greater than the
  *L* highs before it and ≥ the *L* highs after it (mirror for lows). **ASSUMPTION** (tie handling).
* Higher-timeframe candles are used only once their close time ≤ the current candle's close time. The forming daily
  candle is never used.
* Replay feeds the engine only `candles[0..cursor-1]`; backtests run the same `ElfEngine` class over closed candles.
* Missing candles are never synthesized; backtests report gaps.

## Sessions (America/New_York, DST-aware via the IANA database)

| Session | Default | Enabled |
|---|---|---|
| London | 03:00–06:00 ET | yes (v1.1) |
| New York | 08:00–11:00 ET | yes (v1.1) |
| Asia / Sydney | 19:00–03:00 ET (wraps midnight) | **no** (OPTIONAL) |

* A candle belongs to a session when its **open time** is in `[start, end)`.
* A wrapping session is keyed to the date it started.
* A session's range becomes **liquidity only once the session has completed**. The developing range is displayed but never used as a target or sweep level.
* **Session gate** (ASSUMPTION, default `both`): the sweep must *begin* inside an enabled session, and the entry-ready candle must close inside an enabled session. They don't have to be the same session. A London sweep can therefore confirm in New York if it hasn't expired. Options: `sweep`, `entry`, `both`, `off`.
* Trade management (stop/targets) **always continues** outside session windows.
* **News blackout** is a manual switch. When it's on, new entries are FILTERED with the reason "News blackout active". It does not apply in backtests or replays (no news calendar).
* **Trading-day boundary** for PDH/PDL (ASSUMPTION, default 00:00 New York). The alternatives are 17:00 New York (the forex convention) and 00:00 UTC (the crypto exchange daily).
* **Equities:** 03:00–06:00 ET is US pre-market. Bars there are sparse and depend on the provider feed.

## Liquidity

Levels: PDH, PDL, completed session highs/lows, confirmed swing highs/lows, and EQH/EQL. Two confirmed swings within `equalLevelAtrTol × ATR` (ASSUMPTION, default 0.10) merge into one EQH/EQL at the outer price.

Levels at an identical price from two sources are merged into one pool (e.g. "New York H / Swing H"). On a new trading day, older untested PDH/PDL are marked *expired*.

Level states:

* **untested** — not yet traded beyond.
* **breached** — traded beyond and closed beyond; waiting for a close back.
* **swept** — penetration ≥ threshold followed by a close back through the level.
* **broken** — no close back within `maxConfirmBars`, or `requireSameCandleReclaim` is on and the candle closed beyond.
* **expired** — no longer relevant: an old PDH/PDL, or `levelMaxAgeBars` reached.
* **merged** — folded into an EQH/EQL.

The chart shows only the nearest 3 untested levels on each side (2 on phones), plus the last 3 swept levels.

## Sweep

* Threshold = `sweepAtrMult × ATR(atrPeriod)`. **v1.1 default 0.05 × ATR(14)**, where ATR is Wilder's RMA (same as Pine `ta.atr`), using the ATR that includes the current candle.
* Penetration = how far the wick went beyond the level. **Exactly at the threshold qualifies**; anything below it is a simple touch or probe, not a sweep.
* Preliminary sweep: the penetration reaches the threshold. Confirmed sweep: a later (or the same) candle closes back through the level, within the confirmation window.
* If one candle sweeps several levels, the setup anchors to the **furthest** level that met the threshold, and all of those levels are marked swept.
* Each level emits its preliminary-sweep event once (de-duplicated), and alerts are de-duplicated again by event key.
* A newer sweep in the same direction supersedes a pending setup. An opposite-direction sweep supersedes it only once it has closed back through its level (a close beyond an opposing level is continuation, not reversal).
* Sweeps that occur while a theoretical trade is being managed are recorded but not tracked as new setups.

## BOS (break of structure)

* Bullish: a candle **closes** above the reference swing high. Bearish: a candle **closes** below the reference swing low. Wicks never count.
* Reference = the most recent swing that is already confirmed and whose pivot candle is at or before the sweep candle.
* BOS must come on or after the close back through the swept level.
* Separately, the chart labels a structural BOS whenever a close breaks the most recent confirmed swing.

## Displacement

* A candle in the setup direction with body ≥ `displacementAtrMult × ATR` (**1.0**) and body/range ≥ `displacementBodyRatio` (**50 %**).
* Consecutive mode (`displacementBars` = N, default 1) allows up to N candles. All of them must move in the same direction, the net move (last close − first open) must be ≥ k × ATR, and the combined body/range must meet the ratio.
* It may occur on any bar from the sweep candle onward, within the window. A large candle in the wrong direction never counts.

## Confirmation window

The sequence must complete within `maxConfirmBars` (**20**) bars counted from the sweep candle. The order is: sweep → close back → BOS (close) → displacement. Displacement may come before or with the BOS candle, as long as it's on or after the sweep. Otherwise the setup **expires** with the missing step recorded, and the state becomes FILTERED.

## HTF bias (filter, not a prediction)

Bias is bullish when the last **completed** HTF close is above EMA(`htfEmaLength`) of HTF closes, and bearish when it's below. The defaults are **Daily, EMA 50, enabled**.

The EMA is seeded with an SMA of the first N closes. When fewer than N completed HTF candles exist, the bias is *unknown* and setups are FILTERED with "Higher-timeframe bias unavailable" (the engine never guesses).

## Plan, stop, targets, R:R

* Entry = the confirmation candle's close.
* **Stop** = sweep wick extreme − **0.10 × ATR** (long), or + for a short. The extreme is the farthest wick from the start of the sweep until confirmation.
* **TP1** = entry ± **1R**.
* **TP2** = the **nearest** untested opposing liquidity beyond the entry. A target is never invented.
  * OPTIONAL `targetSources = major`: TP2 ignores plain swing pivots and only uses PDH/PDL, session highs/lows and EQH/EQL. The default `all` is v1.1.
* **R:R** = |entry − TP2| ÷ |entry − stop|. The minimum defaults to **3**, can be lowered to 2, and moves in 0.5 steps.
* FILTERED reasons can be any of:
  * Against higher-timeframe bias
  * Higher-timeframe bias unavailable
  * No measurable target
  * Risk/reward x below minimum y
  * Outside the permitted session
  * News blackout active
  * Zero or negative risk
  * Required confirmation missing
  * Confirmation expired
  * A trade is already active
* All failing checks are listed, not just the first one.

> **Observed on real data (BTCUSD 15m, Binance.US):** with 5-bar swings, the nearest opposing swing is usually very
> close, so almost every confirmed sequence fails the 1:3 floor. This follows directly from the v1.1 "nearest target"
> rule. Also, on BTC M15 the ELF stop is often ≈0.2 % of price, so a 0.10 % per-side fee alone costs about 1R per round trip.
> Evaluate both effects with the backtester before trading.

## Outcome tracking (theoretical)

* Management starts on the candle after the signal.
* A gap through the stop fills at the candle **open**. Targets fill at the target price.
* If one candle touches both the stop and a target, the intrabar order is unknown. With 1m data (backtest option "Use 1m data") it is resolved minute by minute. Otherwise **the stop is assumed first**, and the trade is flagged *ambiguous* (marked `*` in the UI).
* After TP1 the trade continues to TP2 or the stop. OPTIONAL `breakevenAfterTp1` moves the stop to entry from the next candle.
* OPTIONAL `tradeExpiryBars` closes the trade at the bar close after N bars (0 = never).
* Outcomes: TP1 reached (event), TP2, stop, breakeven, expired, manually closed, cancelled.

## FVG and order blocks (displayed, never an automatic entry)

* **Bullish FVG:** `low[i] > high[i−2]`. **Bearish FVG:** `high[i] < low[i−2]`.
* FVG states:
  * **active**
  * **partial** — price entered the gap
  * **mitigated** — `wick` mode: price reached the far edge; `close` mode: a close at or through the far edge
  * **invalidated** — a close beyond the far edge; this takes precedence
* **Order block**: the last opposite-coloured candle before the first qualifying displacement candle inside the leg that produced a BOS (structural OB) or completed an ELF setup (setup OB).
  * The search goes back at most 20 bars.
  * The box spans the full candle range, with its 50 % midpoint marked.
  * OB states: **active**, **tested** (price returned into it), **invalidated** (a close beyond its far side).
