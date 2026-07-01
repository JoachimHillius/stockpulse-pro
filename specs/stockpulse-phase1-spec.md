# StockPulse Pro — Phase 1 Spec

**Size-blind ranking + multi-day accumulation classifier**

This is an implementation spec for Claude Code to execute against the real `stockpulse-pro` repo. It defines logic, field mappings, and thresholds. Where it references storage, Claude Code should resolve column/table names against the actual Supabase schema (`omen_daily_summary` and wherever raw scan rows land) — read the schema first, then map.

Goal of Phase 1: replace the premium-dollar ranking with a **size-blind** view that ranks by directional skew, classifies each name by trade horizon (day-trade / swing / long / fading) using multi-day history, and pages results instead of truncating. No market cap or premium floor decides visibility.

---

## 0. Field map (from the real CSVs)

| Signal needed | OMEN column | SmartMoney column | Notes |
|---|---|---|---|
| Ticker | `Symbol` | `Symbol` | — |
| Side | `Call/Put` | `Call/Put` | values `Call` / `Put` |
| Premium ($) | `Premium` | `Premium` | string like `$59.38k`, `$584.19k` — parse suffix |
| Contracts traded | `Trade Size` | `Trade Size` | comma-formatted, e.g. `25,594` |
| Open interest | `Open Interest` | `Open Interest` | per-CONTRACT, repeats across trades — do not sum |
| Expiry | `Expiration Date` | `Expiration Date` | `MM/DD/YYYY` |
| Strike | `Strike` | `Strike` | float |
| Underlying price | `Stock Last` | `Stock Last` | `$313.44` — strip `$` |
| Aggression | `Trade Spread` | `Trade Spread` | OMEN: `Askish`/`Bidish`; SM: `At Ask`/`At Bid` — normalize |
| Sweep/block | `Flags` | `Flags` | `Sweep`, `Block Trade` |
| Repeat-flow tag | `Alerts` | `Alerts` | `Repeater_Bullish` / `Repeater_Bearish` etc. |
| Implied vol | `Implied Vol.` | _absent_ | OMEN only; `0` = missing |
| Earnings | `Earnings Date` | `Earning Alerts` | OMEN = date; SM = e.g. `Next 5 Days` |

---

## 1. Normalization layer

Both source types must collapse into one normalized trade record before any aggregation.

- `premium_usd`: parse `Premium` — strip `$`, multiply by 1,000 for `k`, 1,000,000 for `M`, else as-is.
- `size`: parse `Trade Size` — strip commas → int.
- `oi`: parse `Open Interest` — strip commas → int.
- `spread_side`: map `{Askish, At Ask}` → `ask`, `{Bidish, At Bid}` → `bid`, anything else → `mid`.
- `strike`, `stock_last`: strip `$`/commas → float.
- `expiry`: parse `Expiration Date` → date.
- `iv`: OMEN only; `0` or blank → null.
- SmartMoney has a **duplicate `Option Cnt.` header** — read by position, not by name, or the second column will overwrite the first. Inspect what the trailing column actually holds before relying on it.
- Keep the existing dedup key (`omen_flow_natural_key`) — do not change it.

---

## 2. Per-symbol daily aggregation

For each `symbol` on the scan date:

- `call_premium` = sum `premium_usd` where side = Call
- `put_premium` = sum `premium_usd` where side = Put
- `skew_pct` = (call_premium − put_premium) / (call_premium + put_premium) × 100
- `total_size` = sum `size` (all trades) — this is the activity measure
- `aggressive_pct` = share of premium that is aggressive: calls `spread_side = ask` + puts `spread_side = bid`, over total premium
- Tenor bucket per trade, from `expiry − scan_date` in calendar days:
  - `DAY`: ≤ 14 days
  - `SWING`: 15–65 days  (the 1–2 month sweet spot)
  - `LONG`: > 65 days
  - store premium split per bucket: `day_prem`, `swing_prem`, `long_prem`

**Per-contract OI (for the diff):** group by `(symbol, expiry, strike, side)` and take OI **once** (max or last seen) — never sum. Sum `size` within the group for that contract's daily volume.

---

## 3. Multi-day accumulation (uses stored scan history)

For each `(symbol, expiry, strike, side)`:

- `oi_delta` = today's OI − OI from the most recent prior scan of the same contract
- `fresh_oi_flag` (green): prior OI is low (bottom tier, e.g. < 1,000) AND today's `size` ≥ 3× prior OI → fresh positions opening into a thin contract
- `accum_streak`: count of consecutive prior scans where OI rose AND same-side premium was present in the same expiry bucket

Roll these up to the symbol level: a symbol "accumulating" has rising OI + same-direction premium concentrated in one expiry bucket across ≥ 2–3 scans. Fold OMEN's `Repeater_Bullish/Bearish` alerts in as a confirming hint.

---

## 4. Classifier (label each symbol, size-blind)

Assign one `setup_class` per symbol:

- `DAY_TRADE`: premium concentrated in the DAY bucket, today's total premium well above its trailing average, little/no prior OI build.
- `SWING`: majority premium in SWING bucket + rising OI over ≥ 2 prior scans, same side.
- `LONG`: LONG bucket dominant + multi-day OI rise.
- `FADING`: previously accumulating, now seeing opposite-side flow or declining OI.

Direction = sign of `skew_pct`. None of this references premium size or market cap.

---

## 5. Ranking & paging

- Rank **within each `setup_class`** by `abs(skew_pct)` — pure, size-blind. Tiebreak by `accum_streak`, then `fresh_oi_flag`, then `aggressive_pct`.
- **Activity floor only** (not a size floor): `total_size` ≥ 20 contracts to qualify, so a single 1-lot can't print a fake 100% skew and jump the list. Make it a tunable toggle.
- Page results 1–10 / 11–20 / 21–N. List length is paging, never a filter.

---

## 6. Columns to persist (Claude Code maps to real schema)

Add to the per-symbol daily summary: `skew_pct`, `call_premium`, `put_premium`, `total_size`, `aggressive_pct`, `day_prem`, `swing_prem`, `long_prem`, `accum_streak`, `fresh_oi_flag`, `setup_class`, `direction`.

---

## Honesty notes (carry into the build)

- `setup_class`, ranking, and the green flag are **heuristics**, not validated predictions. They become a real hit-rate only after outcome-tracking logs "flagged → what happened" over time. Do not label anything "probability" yet.
- `Implied Vol.` exists in OMEN only — IV-based expected-range (Phase 3/4) works on OMEN rows; SmartMoney rows will have null IV.
- News is **not** in these files. Phase 4's catalyst layer needs the News Scanner source.

---

## How Phases 2–4 hang off this

- **Phase 2** reads `setup_class` + direction and overlays SPY/VIX regime and sector-ETF leadership.
- **Phase 3** uses `stock_last` + high-OI strikes (the magnet levels) to compute support/resistance and set alarms.
- **Phase 4** feeds every field above, plus news + IV + earnings timing, into the `generate_prompt` builder to write the per-name note.
