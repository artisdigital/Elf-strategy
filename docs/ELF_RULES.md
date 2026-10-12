# ELF v1.1 — rules as implemented

The engine in `src/engine/` comes in two models, selected in **Settings & Rules → Engine model**:

| Model | Source | Default |
|---|---|---|
| **ELF v1.1 (Pine parity)** — `pineV11.ts` | A faithful port of your `elf_indicator.pine` (ELF — Emerald Liquidity Flow · v1.1 · Pine Script v5). | **yes** |
| **Extended** — `engine.ts` | The multi-level engine built from the written brief before the Pine file was available. | no |

Every adjustable value lives in `src/engine/config.ts` with an origin tag:

* **ELF v1.1** — your rule or a v1.1 Pine default.
* **OPTIONAL** — an addition, off or neutral by default.
* **ASSUMPTION** — a choice neither the Pine script nor the documents pin down.

## ELF v1.1 Pine parity (default model)

These are the Pine sections and how each is ported:

* **§2 Liquidity.** The level set is exactly what Pine's `nearestAbove()` / `nearestBelow()` see:
  * the **latest** completed London, New York and (if enabled) Sydney high and low;
  * PDH/PDL from the provider's daily candle (`dayBoundary = auto`: Binance.US = UTC day, OANDA = 17:00 New York, equities = New York day);
  * the **latest** confirmed swing high and low;
  * the last 8 EQH/EQL.
  * A newer value replaces the older one.
* **§3 Swings.** These are `ta.pivothigh/low(swingLength)` pivots, known only `swingLength` bars later. On ties, the left side must be strictly lower/higher and the right side lower-or-equal (ASSUMPTION — Pine doesn't document tie handling).
* **§3 BOS.** `close > swH[1] and close[1] <= swH[1]` — the close must **cross** the swing as it stood on the previous bar. Wicks never count.
* **§3 Displacement.**
  * The candle's body must be ≥ `dispMult × ATR(14)` (1.0), and the body must be ≥ 50 % of its range.
  * With `dispBars > 1`, the bodies of consecutive same-direction candles are summed, capped at N candles. This is documented difference 2.
* **§4 Sessions.**
  * Windows in America/New_York (DST-aware): London 03:00–06:00 and New York 08:00–11:00, both on; Sydney 17:00–02:00, **off**.
  * A session's range becomes a level on the first bar after the session ends.
* **§5 EQH/EQL.** Two **consecutive** pivots within `0.10 × ATR` form one level at their **average**.
* **§6 FVG.**
  * Bullish when `low > high[2]`; bearish when `high < low[2]`.
  * Filled when a wick reaches the far edge; that rule is the default, and a close-based rule is available.
  * The *partial* and *invalidated* states are display additions.
* **§7 Order block.**
  * The last opposite-coloured candle 1–20 bars before the confirmation candle.
  * The box is the candle **body** (open–close) with its 50 % line. The full high–low range is an option.
  * Drawn for confirmed setups.
* **§8 Sweep.**
  * Allowed only inside an enabled window, with the news blackout off.
  * The wick must reach ≥ `0.05 × ATR` beyond the **nearest** level on the far side of the close.
  * By construction that means the same candle closed back. A touch or a smaller probe is not a sweep.
* **§9 State machine.**
  * IDLE → SWEPT: a sweep records the level, the sweep candle's wick, and the bar.
  * SWEPT → confirmation: one later closed candle must (a) close back beyond the swept level, (b) be a BOS cross in the setup direction, and (c) be a displacement candle in the setup direction, all **inside an enabled window**.
  * If that candle comes outside a window, nothing is issued and the engine keeps waiting.
  * The sweep expires after `maxWait` (20) bars, or at the **daily cycle reset**: the first enabled session open.
  * The plan is: entry = close; SL = sweep wick ∓ 0.10 × ATR; TP1 = 1R; TP2 = nearest liquidity beyond entry; R:R to TP2 ≥ 3 (2 selectable).
  * Filters: HTF bias (daily close vs EMA 50, completed candles only), target, R:R.
  * **Quality score 0–100** (a Pine design addition): bias 20 + sweep 25 + BOS/displacement 20 + R:R 15 + FVG confluence 10 + in-window 10.
  * **One setup per sweep.** After a confirmation, valid or **FILTERED**, the setup is monitored (SL first, then TP2, then TP1) and new sweeps are ignored until it resolves or the next cycle. `filteredSetupLocks` can turn this off for filtered setups.
  * TP1 shows "consider moving SL to breakeven". Pine does not move the stop, so `breakevenAfterTp1` is off.

### Deliberate differences from the Pine script (all documented in code)

1. **HTF bias with no completed EMA yet** is *unknown*, and setups are FILTERED with "Higher-timeframe bias unavailable". Pine silently treats `na` as short bias.
2. **`dispBars > 1`** sums at most N candles. Pine's running sum is unbounded, which contradicts its "allow up to N bars" tooltip.
3. **The news blackout** blocks new sweeps (as in Pine) **and** new entries (as in your app brief).
4. **The daily cycle reset** closes an open theoretical trade at that candle's open, marked *expired*. Pine just stops drawing it. This gives backtests a defined result.
5. **Outcomes** use the shared tracker. It applies the same stop-first priority as Pine, plus a fill at the candle open when price gaps through the stop.
6. **Realtime HTF values.** Pine's `request.security(..., lookahead_off)` returns the developing HTF close on realtime bars. The app always uses the last **completed** HTF candle, live and historically, so it never repaints.

### From your ELF documents (not in the Pine script)

* Clean Trading Checklist: the chart shows at most **2 liquidity zones above and 2 below** price, plus the nearest open FVGs and the most recent OBs.
* Risk defaults are **0.5 % per trade**, warning above 0.75 %, from the Strategy Checklist / Forex Workflow risk plan.
* Forex Workflow hard rules are available as OPTIONAL engine filters, off by default:
  * `maxTradesPerSession` (the document says 2);
  * `dailyLossLimitR` (the document says 1.5).
* The journal includes the **ELF Final Check** from the Framework Confirmation Checklist. Ticking all items marks the trade rule-compliant.
* **Not automated, because they're discretionary or not in v1.1:**
  * Fib premium/discount and the OTE 62–71 % zone;
  * RSI divergence and 60/40 shifts;
  * HH/HL trend reading;
  * "price inside a pre-marked POI";
  * entry at the OB/FVG 50 % line;
  * trailing stops.
  * These stay on your checklist. They match the Pine "v2 roadmap" items (FVG-return / OB-mitigation entries).

---

# Extended model (non-default)

The sections below describe the Extended model (`engineModel = extended`).

> Observed on real BTCUSD 15m data (60 days): Extended found 28 complete sequences, all FILTERED, mostly R:R < 3.
> ELF v1.1 found 19 confirmations, 1 entry, 18 FILTERED (17 by R:R, 12 against bias).
> In both models TP2 = "nearest liquidity" is usually very close to entry on BTC M15. That follows from the rule; it isn't an engine fault.

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
