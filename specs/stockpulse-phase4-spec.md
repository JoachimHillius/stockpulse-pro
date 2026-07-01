# StockPulse Pro — Phase 4 Spec

**AI analyst note generator**

Implementation spec for Claude Code, the capstone over Phases 1–3. The note reads every signal the prior phases produce and writes a plain-language read per name: setup type, direction, why, the level to watch, what kills it, and the horizon — honestly framed.

---

## A. Context pack (assembled per symbol)

Build one structured object per symbol from the prior phases — this is what the note reasons over:

- **Phase 1:** `setup_class`, `direction`, `conviction_skew`, `skew_pct`, `accum_streak`, `fresh_oi_flag`, day/swing/long premium split, `aggressive_pct`, `total_size`, sweep/block flags, `Repeater_*` alert.
- **Phase 2:** `regime_label` (+ `spy_trend`, `vix_band`), `sector`, `sector_rank`, `sector_aligned`, `earnings_risk`, earnings date.
- **Phase 3:** `key_level`, `key_level_type`, `distance_pct`, `nearest_support`, `nearest_resistance`, `room_to_target`.
- **From scan:** `Stock Last`, `Implied Vol.` (OMEN only), expiry tenor.
- **News:** recent headlines (see B).

---

## B. News layer (the one external dependency)

Define a single interface so the source is swappable:

```
getNews(symbol, lookbackDays) -> [{ headline, date, source, url }]
```

- **Default implementation:** Finnhub `company-news` (`/company-news?symbol=X&from=&to=`) — free tier, existing key.
- If the News Scanner already pulls from another feed, implement the same interface against it; nothing downstream changes.
- Pass the top N recent headlines (with dates) into the prompt. The note cites fresh catalysts or explicitly says "no fresh catalyst." Stale headlines are not catalysts — pass dates and let the note weigh recency.

---

## C. Fix the `generate_prompt` builder

The modular builder must actually assemble and return the prompt:

1. **Concatenate + return.** Join `instructions + persona + formatting + worksheet + sections 001–006` in order and `return` the string. (Currently returns `None`.)
2. **Wire `long_position_threshold_score`.** Use it: if the symbol's conviction score ≥ threshold, inject the long-bias verdict path; otherwise the cautious/wait path. (Currently a dead parameter.)
3. **Remove `.replace("0", "")` on `verdict_006`.** It strips every `0` and corrupts prices/percentages (`$220` → `$22`).
4. **Standardize placeholder tokens.** Pick one form (e.g. `{{FIELD}}`) and use it everywhere; the mixed `_old:` / `_old` won't all match.
5. **Use `with open(...)`** so file handles close.
6. **Replace the `.replace()` chain with one templating pass** — load the section files, then do a single `{{token}}` substitution from a context-pack dict (`str.format_map` or one regex sub). Adding a field later becomes a dict entry, not another fragile replace.

---

## D. Prompt structure (your section files, retargeted)

Keep the modular layout; the tokens now map to the context pack:

- **001-summary:** setup type + direction + one-line thesis.
- **002-risk-assessment:** earnings risk, regime fighting-the-tape, sector divergence, IV rich/cheap, thin-OI caveat.
- **003-levels:** the level to clear or lose, the invalidation, room to target.
- **004-trading-strategy:** horizon from `setup_class` (day / swing / long); the `<<LONG_THREAD>>` token → entry and management notes sized to the tenor.
- **005-conclusion:** the net read.
- **006-final-verdict:** BUY CALLS / WAIT / BUY PUTS — gated by the threshold **and** regime **and** earnings. Never advise holding through earnings.

---

## E. LLM call

- Anthropic API with the existing key.
- **System prompt** = persona + instructions + formatting + the honesty constraints below.
- **User message** = worksheet + context-pack JSON + news headlines. Request the six sections in a fixed format (or JSON) so the UI renders them consistently.
- **Model:** a current Sonnet is the right cost/quality balance for per-name notes at volume; reserve Opus for the top few names if you want deeper reasoning there.

**Honesty constraints (in the system prompt):**
- Always surface the watch-outs — overextended run, IV crush into earnings, news already priced, thin OI — not just the bull case.
- Frame as an assessment with risk flags, never a guaranteed call. The user pulls the trigger.
- Never invent a probability or a price target with false precision.
- Honor the earnings rule: do not advise holding a position through an earnings date.

---

## F. Cost & caching

- Notes are LLM calls — **cache one note per `(symbol, scan_date)`**. Regenerate only when the symbol's data changes (new upload) or the user hits refresh. Never regenerate the board every price poll.
- Generate on-demand for an expanded row, or batch the top-N ranked names after each upload so the best candidates have notes ready.

---

## Closing the loop (what makes this trustworthy)

Log each note against what the stock actually did over its horizon. Once enough `note → outcome` pairs accumulate, you can measure how often the read was right — and only *then* does "conviction" earn the word "probability." That validation loop is the natural step after all four phases are in, and it's what turns the tool from a smart summarizer into something with a track record.

---

## Data dependencies

- Anthropic API key wired (exists).
- News source confirmed — default Finnhub `company-news` until told otherwise.
