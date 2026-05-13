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

---

## Next Phase: Auth + Admin (Tomorrow's Work)

### Requirements (from Joachim, May 12 2026 night)

1. **Password protection on Settings tab.** API keys, Sync buttons, and admin actions must be locked behind login.
2. **Admin dashboard for usage visibility.** Joachim wants to see who is using the app — which users, when they last logged in, what they viewed/uploaded.
3. **Email + password login.** Email is the username. Standard auth, not magic links.

### Recommended Stack

Use Supabase Auth (already enabled by default on the project). Email/password provider. No SSO yet.

### Schema additions needed

```sql
-- Track page visits and key actions per user
CREATE TABLE IF NOT EXISTS public.activity_log (
  id          bigserial PRIMARY KEY,
  user_id     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  event       text NOT NULL,       -- 'page_view', 'csv_upload', 'price_sync', 'login'
  detail      text,                -- e.g. tab name, filename, ticker count
  created_at  timestamptz DEFAULT now()
);

-- Admin flag — only Joachim's user_id gets is_admin = true
CREATE TABLE IF NOT EXISTS public.admin_users (
  user_id     uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  granted_at  timestamptz DEFAULT now()
);
```

### RLS changes needed

- Tighten `omen_flow`, `omen_daily_summary`, `upload_log`: require `auth.role() = 'authenticated'`
- `activity_log`: users can INSERT their own rows; only admin can SELECT all
- `admin_users`: only service role can INSERT; authenticated users can SELECT their own row

### UI changes needed (index.html)

1. **Login modal** — shown on page load if `supabase.auth.getSession()` returns null
2. **Settings tab guard** — if not authenticated, show login prompt instead of tab content
3. **Auth state listener** — `supabase.auth.onAuthStateChange` updates global `_currentUser`
4. **Admin panel tab** (new tab, hidden unless `_currentUser` is in admin_users)
   - Table: users list (email, last_sign_in_at, created_at)
   - Table: recent activity_log (last 100 rows across all users)
   - Stat boxes: uploads today, price syncs today, active users (7d)

### Implementation order

1. Enable email/password in Supabase Dashboard → Auth → Providers
2. Create Joachim's account manually via Dashboard or SQL
3. Add `activity_log` and `admin_users` tables + RLS
4. Add login modal to index.html (Supabase JS `signInWithPassword`)
5. Guard Settings tab — check session before rendering
6. Add activity logging to `handleMultipleCSV` and `startPriceSync`
7. Build Admin tab

### Key Supabase Auth calls (vanilla JS, no framework)

```javascript
// Sign in
const { data, error } = await supabase.auth.signInWithPassword({
  email: 'joachim@example.com',
  password: '...'
});

// Get current session
const { data: { session } } = await supabase.auth.getSession();

// Sign out
await supabase.auth.signOut();

// Listen for auth changes
supabase.auth.onAuthStateChange((event, session) => {
  _currentUser = session?.user || null;
  updateAuthUI();
});
```


---

## Auth + Admin — Full Spec (from Joachim, May 12 2026 night, v2)

### Schema additions needed

```sql
-- Profiles table extends auth.users with app-specific fields
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  full_name TEXT,
  role TEXT DEFAULT 'viewer' CHECK (role IN ('admin','trader','viewer')),
  created_at TIMESTAMPTZ DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

-- Usage tracking
CREATE TABLE user_activity (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  occurred_at TIMESTAMPTZ DEFAULT now(),
  event_type TEXT,        -- 'login', 'page_view', 'csv_upload', 'predictor_run', 'sync_started'
  event_detail JSONB
);
CREATE INDEX idx_user_activity_user ON user_activity(user_id, occurred_at DESC);
CREATE INDEX idx_user_activity_event ON user_activity(event_type, occurred_at DESC);
```

### Tighten RLS on existing tables

Currently all tables have permissive anon policies. After Auth is wired:
- Drop `anon_all_*` policies on omen_flow, omen_daily_summary, predictor_runs, upload_log, price_history, price_sync_status, user_settings
- Replace with `authenticated_all_*` policies that require `auth.uid() IS NOT NULL`
- Admin-only tables (user_settings, all writes to user_activity, profiles updates) get role-checked policies

### UI changes

1. **Login screen** at app entry. Block all tabs until signed in. Email + password form. "Sign up" link.
2. **First user becomes admin** — bootstrap via SQL once Joachim signs up:
   ```sql
   UPDATE profiles SET role='admin' WHERE email='[joachim email]';
   ```
3. **Settings tab** — visible to admins only. Other roles see "Access denied — admin only".
4. **New "Admin" tab** (admins only) showing:
   - Table of all profiles (email, role, created_at, last_login_at)
   - Recent user_activity stream (last 100 events with user + event type)
   - Daily active users chart (last 30 days)
5. **Sign out button** in top-right.

### Activity tracking hooks

Add lightweight `logActivity(eventType, detail)` helper called from:
- Login success: `'login'`
- `goPage`: `'page_view'` with `{page}`
- `handleMultipleCSV`: `'csv_upload'` with `{filename, source, rows_stored}`
- `initFlowPredictor`: `'predictor_run'` with `{timeframe}`
- `startPriceSync`: `'sync_started'`

Fire-and-forget inserts. Don't block UI.

### Suggested step order for tomorrow

- Step 28a: Create profiles + user_activity tables (Supabase MCP).
- Step 28b: Enable email/password provider in Supabase Auth (Settings → Authentication).
- Step 28c: Add login screen + signOut button to index.html.
- Step 28d: Wire Supabase Auth client in JS, gate all tabs.
- Step 28e: Bootstrap Joachim as admin via SQL after first signup.
- Step 28f: Build Admin tab UI (profiles list + activity stream).
- Step 28g: Wire logActivity hooks at the 5 event points.
- Step 28h: Tighten RLS — drop anon_all_* policies, add authenticated_* policies.
- Step 28i: Test by creating a second test user, verify they can't see Settings/Admin.

### Cost / risk

- Supabase Auth is free on all plans up to 50K MAU.
- RLS hardening is the highest-risk step — break order is important. Test on a single table first.
- Hardcoded anon key in index.html stays (it's safe with proper RLS).

### What NOT to do

- Don't use a single shared password. That's not auth, it's a speed bump.
- Don't store passwords in user_settings or anywhere outside auth.users.
- Don't disable RLS to "make it work" — fix the policy.
- Don't expose service_role key in the browser. Ever.

End of Auth + Admin full spec.
