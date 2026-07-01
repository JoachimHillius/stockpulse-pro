# StockPulse Pro — Phase 3 Spec

**Support / resistance levels + level alarms**

Implementation spec for Claude Code, building on Phases 1–2. Logic and thresholds defined here; map storage to the real Supabase schema.

Goal of Phase 3: give every setup the price level that makes or breaks it, computed from price action **and** option open-interest magnets, then let an alarm fire when price reaches it.

---

## A. Level computation (per symbol)

### Price-action levels (from fetched price history)

- **Swing pivots:** local highs and lows over two lookbacks — 20-day (recent) and 60-day (structural). A pivot high = a bar whose high exceeds N bars on each side; pivot low inverse.
- **Prior day** high / low / close.
- **Moving averages** 20 / 50 / 200-day — dynamic S/R.
- **Round numbers** nearest the current price (whole/half-dollar for low-priced, $5/$10 increments for high-priced).
- **52-week** high / low.

Merge levels within a tight band (~0.5–1%) into a single **zone**, and score each by confluence — how many independent methods land there. A zone where a swing high, a round number, and a moving average coincide is strong; a lone pivot is weak.

### Option-derived levels (from the scan: `Strike` + `Open Interest`)

- **OI-magnet strikes:** top strikes by open interest per symbol. These attract price near expiry — weight each magnet by proximity to expiry (near-dated = strong pull, far-dated = weak). Remember OI is per-contract: dedupe by `(symbol, expiry, strike, side)`, don't sum across trades.
- **Flow-target strikes:** strikes where today's premium / `Trade Size` concentrated — where the fresh money is aimed.

### Output: one level set per symbol

Each level carries: `price`, `type` (swing / ma / round / 52w / oi_magnet / flow_target), `strength` (confluence score), and `side` (support or resistance relative to `Stock Last`).

---

## B. Setup ↔ level wiring

Using `Stock Last` as current price:

- `nearest_resistance` = lowest level above price; `nearest_support` = highest level below.
- For a **bullish** setup: `key_level` = `nearest_resistance` → "must clear $X; fails if rejected there." Invalidation = `nearest_support`.
- For a **bearish** setup: `key_level` = `nearest_support` → "must lose $X; fails if it holds." Invalidation = `nearest_resistance`.
- `distance_pct` = how far price sits from `key_level`.
- `room_to_target` = the next level beyond `key_level` (where it runs if it breaks).

Surface `key_level` + `distance_pct` on the row, and feed both into the Phase 4 note.

---

## C. Alarms

**Auto-suggested** per setup: one alarm at the `key_level` (the break) and one at the invalidation level (the stop). User can accept, edit, or ignore.

**Manual:** user arms `{symbol, level, direction: above|below, optional note}`.

**Evaluation engine:** piggyback on the existing per-minute Yahoo price poll (`pg_cron`). On each poll, for every armed alarm, check whether the latest price crossed the level in the armed direction. Fire **once** (debounce: set `triggered_at`, flip status to `triggered`, don't re-fire).

**Delivery:** in-app badge by default; optional email via Resend, or a GHL webhook, reusing existing infrastructure. Keep delivery channel a per-alarm setting.

**Persist** an `alarms` table: `id, symbol, level, direction, note, channel, status (armed|triggered|dismissed), created_at, triggered_at`.

---

## Columns / storage

- Per-symbol: `levels` (JSONB level set), `nearest_support`, `nearest_resistance`, `key_level`, `key_level_type`, `distance_pct`, `room_to_target`.
- New `alarms` table as above.

---

## Data dependencies

- Price history depth: need ~250 trading days per symbol for 52-week and 200-day MA; ~60 for swing structure. Confirm the fetch stores enough history, not just recent days.
- Confirm the per-minute price poll is live (it is, per the existing `pg_cron` job) — that's the alarm engine.

---

## Honesty notes

- Support/resistance is **descriptive, not predictive** — levels mark where reactions have happened and where positioning sits, not where price must turn.
- OI magnets pull **hardest near expiry** and weaken the further out the expiry is; weight accordingly so a far-dated strike isn't treated as a wall.
- Swing-pivot sensitivity (the N bars on each side, the merge band) is a tunable — expose it rather than hard-coding one setting.
