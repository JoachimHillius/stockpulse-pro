# StockPulse Pro — Build Handoff

Four phase specs in this folder, built in order. This doc is the orchestration layer.

## Files

- `stockpulse-phase1-spec.md` — size-blind ranking + multi-day accumulation classifier (the foundation)
- `stockpulse-phase2-spec.md` — market regime + sector leadership (**contains the two Phase 1 amendments — apply those first**)
- `stockpulse-phase3-spec.md` — support/resistance + level alarms
- `stockpulse-phase4-spec.md` — the AI analyst note (capstone)
- `20260622-OMEN.csv`, `20260622-SMARTMONEY.csv` — real sample scans for parser confirmation

## Build order & rules

1. **One phase at a time.** Finish, deploy, and verify a phase before starting the next. Later phases reference columns earlier phases create — building out of order breaks references.
2. **Read the real schema first.** Before any migration, read the actual `omen_daily_summary` table and the raw scan storage. The specs define *logic*; the real column/table names come from the repo.
3. **Apply Phase 1 amendments before Phase 1 ships.** The ask-weighted `conviction_skew` and the earnings guardrail (top of the Phase 2 spec) supersede the original Phase 1 aggression definition.
4. **OI is per-contract.** It repeats across trade rows — never sum it. Volume (`Trade Size`) sums; OI is taken once per `(symbol, expiry, strike, side)`.
5. **Verify through the cache.** Cloudflare masks deploys — confirm each phase at `propsst.evolutionx4u.com/?v=<commithash>`.
6. **Terminal Claude Code only.** Full file edits, no partial snippets.
7. **Heuristic, not probability.** Nothing is labeled "probability" until the outcome-tracking loop (the eventual Phase 5) validates a hit-rate.

## Outside dependency

Only Phase 4 needs anything external: a news source. Default is Finnhub `company-news` (free tier, existing key). If the News Scanner already pulls from another feed, implement the same `getNews()` interface against it.

## Kickoff prompt (Phase 1)

```
Read ./specs/stockpulse-build-handoff.md first — it's the orchestration layer
(build order, guardrails, the OI-is-per-contract rule). Then read the four phase
specs in ./specs (stockpulse-phase1 through phase4).

We build them in order — Phase 1 ONLY this round. Do not start Phase 2.

Confirm your parser against the two real sample files in ./specs:
20260622-OMEN.csv and 20260622-SMARTMONEY.csv. They have different schemas —
OMEN has Implied Vol. + Earnings Date; SmartMoney has Earning Alerts, a
duplicate Option Cnt. header, and uses At Bid/At Ask where OMEN uses
Bidish/Askish.

Before writing any code:
1. Read the current index.html structure and the Supabase schema — the
   omen_daily_summary table and wherever raw OMEN/SmartMoney scan rows land.
2. Confirm prior scans are queryable by (symbol, expiry, strike, side) and
   date — Phase 1's accumulation needs that history.
3. Report back a short Phase 1 plan and the exact new columns/migration you'll
   add, then WAIT for my OK before changing anything.

Then implement Phase 1 only: the normalization layer (both OMEN and SmartMoney
schemas, parse $k/$M premium and comma numbers, and OI is per-contract — never
sum it), per-symbol aggregation, multi-day accumulation + fresh-OI flag, the
setup classifier, and the size-blind conviction ranking with paging and an
activity floor (not a premium floor).

Apply the two Phase 1 amendments from the Phase 2 spec: the ask-weighted
conviction_skew, and the earnings guardrail.

When done, deploy and give me the commit hash so I can verify at
propsst.evolutionx4u.com/?v=<hash>. Don't move to Phase 2 until I confirm.

Terminal Claude Code only. Full file edits, no partial snippets.
```
