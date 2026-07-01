# StockPulse Pro — Phase 2 Spec

**Market regime (SPY + VIX) + sector leadership**

Implementation spec for Claude Code, building on Phase 1. Logic and thresholds are defined here; map storage references to the real Supabase schema.

Goal of Phase 2: wrap every Phase 1 setup in context — is the broad tape with it or against it, and is its sector leading or fading — so a bullish name in a risk-off tape or a rolling-over sector gets flagged instead of trusted blindly.

---

## Amendments to Phase 1 (apply first)

These supersede the original Phase 1 definitions.

**1. Aggression is "at ask," either side.** A trade at the ask is buyer-initiated = conviction; at the bid = usually closing/selling = discount. Direction still comes from Call vs Put. Replace the old `aggressive_pct` (which incorrectly used "calls at ask + puts at bid") with:

- `aggressive_pct` = share of total premium that is **at ask** (`spread_side = ask`), regardless of side.
- `conviction_skew`: weight each trade's premium by `spread_side` — `ask = 1.0`, `mid = 0.6`, `bid = 0.3` — then compute skew on the weighted premiums:
  - `conv_call = Σ(call premium × weight)`, `conv_put = Σ(put premium × weight)`
  - `conviction_skew = (conv_call − conv_put) / (conv_call + conv_put) × 100`
- Rank by `conviction_skew` as the primary directional read; keep raw `skew_pct` for reference.

**2. Earnings guardrail (rarely hold over earnings).** For each symbol:

- Earnings date source: OMEN `Earnings Date`; SmartMoney `Earning Alerts` (e.g. `Next 5 Days`).
- `earnings_risk` = true if the setup's expiry is **after** the next earnings date, or earnings falls inside the expected holding window. For SmartMoney rows tagged `Next 5 Days`, always true.
- Surface as a warning pill on the row and a prominent line in the note: "expires past earnings — IV crush + gap risk; rarely hold through." Down-rank `SWING`/`LONG` setups that span earnings unless the trade is explicitly an earnings play.

---

## A. Market regime banner (SPY + VIX)

A persistent banner at the top of the Flow Predictor.

**Inputs:** SPY daily price history (already fetched via Yahoo), VIX level + 1-day direction (already in the header).

**SPY trend:**
- `uptrend`: SPY above both 20-day and 50-day MA, and 20-day > 50-day
- `downtrend`: SPY below both, and 20-day < 50-day
- `chop`: anything mixed

**VIX bands:** `<13` complacent · `13–18` calm · `18–22` normal-elevated · `22–30` caution · `>30` fear. Track rising vs falling day-over-day.

**Regime label (SPY trend × VIX):**
- uptrend + VIX low/falling → **Risk-on** — tailwind for longs
- uptrend + VIX rising/elevated → **Cautious bull** — longs ok, expect chop
- downtrend + VIX high/rising → **Risk-off** — longs fighting the tape; favor puts or wait
- chop + mid VIX → **Neutral** — lower conviction both directions

**Interaction with setups (modulate, don't override):** a bullish setup in a Risk-off regime gets a "⚠ fighting the tape" flag; in Risk-on it gets a tailwind note. Bearish setups invert. Store `regime_label`, `spy_trend`, `vix_band`.

---

## B. Sector leadership panel

**Step 1 — tag tickers with a sector.** Static lookup map for the ~130-name universe (Claude Code seeds it, or pulls Finnhub `profile2` `finnhubIndustry` on the free tier). Examples: NVDA/AMD/MRVL → semis; MSFT/ORCL/IGV-names → software; XLF-names → financials; etc.

**Step 2 — sector → ETF proxy map** (use ones already ingested where possible):

| Sector | Proxy ETF |
|---|---|
| Semiconductors | SMH (or SOXX) |
| Software | IGV |
| Broad tech | XLK / QQQ |
| Financials | XLF |
| Energy | XLE |
| Healthcare | XLV |
| Biotech | XBI |
| Industrials | XLI |
| Consumer disc. | XLY |
| Homebuilders | XHB / ITB |
| Materials | XLB |
| Communication | XLC |
| Crypto / Bitcoin | IBIT |
| Credit / high-yield | HYG |
| Emerging mkts | EEM |
| Region (Korea) | EWY |
| Small caps | IWM |

**Step 3 — leadership & rotation.** For each proxy ETF compute rolling performance over 1-week, 2-week, 1-month windows; rank sectors by recent return. Show a leaderboard with up/down arrows for rising vs falling relative strength.

**Rotation inflection (the "when does it flip" early-warning):** flag a sector when its short-window RS crosses its longer-window RS — a lagging sector whose 1-week RS turns up through its 1-month is *starting* to rotate in; a leader whose short RS rolls under is rotating out. This is an early signal, **not** a predicted flip date — label it as such.

**Interaction with setups:** tag each symbol `sector_aligned` = true if its setup direction matches its sector's leadership (bullish name in a leading sector, bearish in a lagging one). Divergence (bullish name in a rolling-over sector) gets a caution flag in the note.

---

## Columns to persist

Regime: `spy_trend`, `vix_band`, `vix_dir`, `regime_label`.
Sector: per-sector `rs_1w`, `rs_2w`, `rs_1m`, `sector_rank`, `rotation_flag`.
Per-symbol: `sector`, `sector_rank`, `sector_aligned`, plus the Phase-1 amendments `conviction_skew`, `aggressive_pct`, `earnings_risk`.

---

## Data dependencies

- Confirm **SPY** and every **sector-proxy ETF** above are in the daily price fetch — add any that are missing.
- Provide or generate the ticker → sector static map.

---

## Honesty notes

- Regime **contextualizes**, it does not predict — it tells you which way the wind blows, not what the stock will do.
- Rotation inflection is an **early-warning**, never a guaranteed flip date.
- `earnings_risk` is a binary-risk flag, not a directional opinion.
- All of this stays heuristic until outcome-tracking validates it.
