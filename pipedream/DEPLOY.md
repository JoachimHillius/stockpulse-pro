# Pipedream Scanner Workflows — Deploy Guide

These files contain the corrected step code. Pipedream doesn't deploy from git —
paste each file's content into the matching step in the Pipedream UI.

---

## 1 · Supabase environment variables

In Pipedream → Settings → Environment Variables, add (if not already there):

| Variable | Value |
|---|---|
| `SUPABASE_URL` | `https://siwrhqcojoyxxwaxnopc.supabase.co` |
| `SUPABASE_SERVICE_KEY` | The **service_role** key from Supabase → Project Settings → API |

The service_role key bypasses RLS — it never goes in the frontend app.
The anon key (already in index.html env vars) is NOT sufficient here.

---

## 2 · Scanner – XGPT+IRIS (4hillonline)

### Step order (verify in Pipedream — drag steps if needed)
```
1. trigger           ← Gmail (15-min poll, already changed)
2. parse_email       ← replace with step-1-parse-email.js
3. write_to_supabase ← replace with step-2-write-to-supabase.js
4. send_telegram     ← keep existing (reference steps.write_to_supabase.$return_value.tickers)
5. star_email        ← DELETE the built-in "add_label_to_email", add CODE step with step-4-star-email.js
```

### What changed and why

**parse_email (step-1-parse-email.js)**
- Now handles forwarded emails: strips `---------- Forwarded message ---------`
  header, removes `>` quote prefixes line by line, removes "On ... wrote:" lines
- Handles `from` as either a string or object (Pipedream returns both formats
  depending on app version)
- Routing still works on subject alone when From is 4hillonline@gmail.com
  (forwarded) — subject "Fwd: XGPT Watch List" still matches `/xgpt/i`
- Logs a body preview on exit so you can debug if no tickers found

**write_to_supabase (step-2-write-to-supabase.js)**
- This is why scanner_alerts was always empty: the previous step likely failed
  or the alerts insert had a schema mismatch. This version writes to BOTH
  scanner_watchlist AND scanner_alerts in one step.
- Upserts on symbol (increments xgpt_count or iris_count, updates last_alert_date)
- Batch-inserts one scanner_alerts row per ticker per email
- Any single-ticker failure is logged and skipped; other tickers still write

**star_email (step-4-star-email.js)**
- Replaces the broken built-in "add_label_to_email" action
- Wrapped in try/catch — a Gmail API failure NEVER stops the DB write
- Returns `{ starred: false, error: "..." }` on failure instead of throwing
- Must be the LAST step so it can't block anything earlier

### How to apply in Pipedream
1. Open the XGPT+IRIS workflow
2. Click the `parse_email` step → click the `</>` code tab → replace all code
   with the content of `scanner-xgpt-iris/step-1-parse-email.js`
3. Click the `write_to_supabase` (or equivalent DB step) → replace all code
   with `scanner-xgpt-iris/step-2-write-to-supabase.js`
4. Find `add_label_to_email` → click the three-dot menu → **Delete step**
5. Click **+ Add step** → **Run custom code** → Node.js
6. Paste `scanner-xgpt-iris/step-4-star-email.js`
7. In the new step's header, click **Connect account** → choose the Gmail
   account already connected to the trigger
8. Rename step to `star_email` and drag it to be last
9. Click **Deploy**

---

## 3 · Scanner – Momentum (evolutionx4u)

Same process as above using files in `scanner-momentum/`.

### Step order
```
1. trigger           ← Gmail (check polling interval — set to 15 min)
2. parse_email       ← scanner-momentum/step-1-parse-email.js
3. write_to_supabase ← scanner-momentum/step-2-write-to-supabase.js
4. send_telegram     ← keep existing
5. star_email        ← scanner-momentum/step-4-star-email.js (last, try/catch)
```

**Note on routing**: The Momentum workflow routes on
`from.includes("evolutionx4u")` OR subject matching
`/money[\s-]?markets|10x|\btenx\b|momentum/i`. If the email is forwarded
and the From changes to 4hillonline@gmail.com, it still routes correctly
IF the subject keeps "Momentum" or "10X" or "Money Markets".

---

## 4 · Recovering missed 7/7–7/8 emails

The emails were archived before the poll ran — Pipedream never saw them.
To process them:

1. In Gmail, search: `from:timsykeswatchlist.com after:2026/07/07 before:2026/07/09`
2. Open each email, click **Forward**, send to yourself (4hillonline@gmail.com)
3. Subject must still contain "XGPT" or "IRIS" — don't change it
4. The 15-min poll will pick up the forwarded email and run the pipeline

Repeat for Momentum: search `from:evolutionx4u after:2026/07/07 before:2026/07/09`

---

## 5 · Verifying end-to-end after deploy

After the first real email processes, run this in Supabase SQL Editor:

```sql
-- Confirm scanner_alerts is no longer empty
SELECT scanner, count(*) as alerts, min(alert_date) as first, max(alert_date) as last
FROM scanner_alerts
GROUP BY scanner
ORDER BY scanner;

-- Confirm watchlist counters are incrementing
SELECT symbol, list_name, source_scanner, xgpt_count, iris_count,
       momentum_count, total_count, last_alert_date
FROM scanner_watchlist
ORDER BY last_alert_date DESC, total_count DESC
LIMIT 20;
```

If `scanner_alerts` has rows → pipeline ran end-to-end. ✓
