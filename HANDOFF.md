# StockPulse Pro — Handoff Document

No backend beyond Supabase. No build step.

## Supabase Project

- **Project ID:** siwrhqcojoyxxwaxnopc
- **Project name:** stockpulse-pro
- **Org:** Joachim-APP (Pro plan, $10/mo)
- **URL:** https://siwrhqcojoyxxwaxnopc.supabase.co
- **Anon key:** stored in user_settings table where key='supabase_anon_key' (also hardcoded in index.html as fallback)

### Tables (public schema)

| Table | Rows (May 12) | Purpose |
|---|---|---|
| omen_flow | 45,976 | Raw trade rows from OMEN/Smart Money CSVs. 12 trading days. |
| omen_daily_summary | 4,419 | Per-ticker per-day aggregates. UNIQUE(trading_date, symbol). Powers Flow Predictor. |
| predictor_runs | 0 | Reserved for saved predictor outputs. Not actively used. |
| rolling_baselines | 0 | Per-ticker rolling avgs (5d/20d/60d). Not populated yet. |
| user_settings | ~4 | API keys backup. Columns: id, key, value, updated_at. |
| upload_log | growing | Per-CSV-upload audit trail. |
| price_history | ~800K (target) | 3-year daily OHLCV from Yahoo. UNIQUE(symbol, trading_date). |
| price_sync_status | growing | Per-ticker sync state for price_history. |

### SQL Functions

- parse_premium(text) — converts "$270k" / "$1.22M" / "$5.50" strings to numeric dollars.

### Edge Functions

- sync-price-history (v2 active, verify_jwt=false) — fetches 3y Yahoo Finance OHLCV per ticker. Paginated. Processes 30 tickers per call. ~6s per batch.

### RLS

All tables have permissive anon policies. TODO: tighten with Supabase Auth. Advisor warnings noted.

## App Tabs

| Tab | Status |
|---|---|
| Morning Brief | Untouched original |
| Watchlist | Untouched. 130 tickers across 15 sectors. |
| Options Flow | Active. CSV upload (OMEN + Smart Money), RFC-4180 parser, source detection, earnings_context tagging, intraday/EOD replacement, D/W/M/Y sentiment filter, Upload Log audit panel. |
| News Scanner | Untouched original. |
| Predictor (OLD) | Inactive. Multi-factor weighted scorer. Coexists with new Flow Predictor. |
| Flow Predictor (NEW) | Active. V3 model. Top 10 bullish + Top 5 bearish. Direction/Confidence/Momentum chips. Sliding date columns. Earnings badges. D/W/M/Y. Pie split + V3 sentiment with click-to-verify math. |
| History | Untouched original. |
| Settings | Active. API keys, Data Sync (old), Quick Load, Price History (NEW with Sync Now). |

## API Keys

All keys stored in browser localStorage + Supabase user_settings backup:

| Key | localStorage key |
|---|---|
| Finnhub | sp_fh |
| Twelve Data | sp_td |
| Anthropic | sp_anthropic |

## Recent Step History

- Step 26: This HANDOFF.md.
- Step 25: Pause ticker carousel outside 4am-8pm EST trading window.
- Step 23: Price History Sync UI. Edge function v2 deployed with pagination.
- Step 22: Upload Log with per-file row-count verification.
- Step 21: Earnings badge uses today's context only.
- Step 20: Nav regression fix + trading_date in _supaRowToFlow.
- Step 19: Paginated Supabase fetches (break 1000-row cap).
- Step 18: D/W/M/Y on Options Flow + Supabase row cap attempt.
- Step 17: Flow Predictor v3 model — full implementation.
- Step 15: Wrap localStorage in try/catch.
- Step 14: CSV parser RFC-4180 + trading_date from filename.
- Step 13: Upload pipeline source/earnings detection.
- Step 11A: Initial v4 xlsx backfill.

## Pending Work (ordered by priority)

1. Polish bundle:
   - Split "TOTAL TRADES" stat into "OMEN ROWS" + "SMART MONEY ROWS"
   - Ticker filter on Options Flow (searchable dropdown)
   - Bigger "Refresh" button on Upload Log
2. LLM "Why?" drill-down on Flow Predictor rows (Anthropic Haiku ~$0.003/row)
3. PDF + XLSX export for Flow Predictor (html2pdf.js + SheetJS)
4. Cosmetic: fix "oldest: 12/05/2026" date display bug on DB-status line
5. Backtest tracking (compare yesterday's predictions vs actual price moves)
6. Rolling baselines: populate rolling_baselines table, show anomaly column
7. Multi-class share fix (BRK-B, BF-B symbol mapping in edge function)
8. Unify old Data Sync 3-phase with new Price History
9. RLS hardening with Supabase Auth
10. Mobile responsive (currently desktop-only)

## Known Bugs / Quirks

- DB status line: "oldest: 12/05/2026 newest: 12/05/2026" wrong (cosmetic, actual data correct).
- 2 price sync failures: BRKB, BFB (need hyphenated symbol mapping for Yahoo).
- WATCHLIST may have stale/delisted tickers (not validated against Yahoo).
- Two predictor systems coexist — don't confuse old "Predictor" with new "Flow Predictor".

## How to Resume

### As Joachim (the user)

1. Open browser: https://propsst.evolutionx4u.com — Settings shows current state.
2. Open terminal: cd /Users/joachimhillius/stockpulse-pro && claude
3. Paste prompts from chat into Claude Code.
4. Verify push confirmations and screenshot the live site.

### As an AI agent picking up

1. Read this HANDOFF.md completely first.
2. Check current state via Supabase MCP:
   - SELECT trading_date, COUNT(*) FROM omen_daily_summary GROUP BY trading_date ORDER BY trading_date;
   - SELECT COUNT(*) FROM price_history;
   - SELECT MAX(last_synced_at) FROM price_sync_status;
3. Check latest commits: git log --oneline -10
4. Write paste-ready Claude Code prompts for the user to run.
5. Include git diff + verification step in patches.
6. Honor "Step N:" numbering — user tracks progress this way.

### Critical reminders

- Single index.html is the entire app. Vanilla JS + Chart.js CDN. No build.
- Don't break what works. Use try/catch defensively for new features.
- Two predictors coexist (old multi-factor, new V3). Don't confuse them.
- Anon key is public-safe (RLS). Service role key is sensitive.
- GitHub Pages caches — always tell user to hard-refresh (Cmd+Shift+R) after pushing.
- User prefers numbered steps and copy-paste-ready prompts.
- Always verify before declaring done — query Supabase, ask for screenshots.

## Contact

All product decisions: Joachim Hillius. This file is the canonical source of project state. Update on every milestone.

End of HANDOFF.md.
