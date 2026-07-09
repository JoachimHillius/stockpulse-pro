# Pipedream Scanner Workflows — Deploy Guide

These files contain the corrected step code. Pipedream doesn't deploy from git —
paste each file's content into the matching step in the Pipedream UI.

---

## Architecture (v2 — active search)

Previous architecture: passive `gmail-new-email-received` trigger → missed
archived/read emails, had no retry, depended on cursor position.

New architecture: **Schedule trigger → active Gmail search → parse+write with
dedupe → Telegram → star**.

```
Schedule (every 15 min)
  └─ search_gmail      ← Gmail API: search last 24h, fetch full message bodies
  └─ parse_and_write   ← parse tickers, dedupe on (email_id, symbol), write DB
  └─ send_telegram     ← only for newly-written tickers (not dupes)
  └─ star_email        ← best-effort label, never blocks DB writes
```

Key properties:
- Running every 15 min on the same 24h window is safe: `(email_id, symbol)` is
  checked against `scanner_alerts` before any insert. Repeat runs = 0 net rows.
- Emails are fetched by subject/from, not by read state — archived or read
  emails are recovered automatically.
- The old passive trigger steps (`parse_email`, `write_to_supabase`) are replaced
  by the two new files. `star_email` (step-4) is also updated — it no longer reads
  `steps.trigger.event.id`; instead it loops over `newTickerDetails` from step 3.

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

## 2 · Scanner – XGPT+IRIS (4hillonline) — v2 active-search

### Step order
```
1. trigger           ← Schedule, every 15 minutes (NOT gmail-new-email-received)
2. search_gmail      ← scanner-xgpt-iris/step-1-search-gmail.js  (Gmail app connected)
3. parse_and_write   ← scanner-xgpt-iris/step-2-parse-and-write.js
4. send_telegram     ← update reference to steps.parse_and_write.$return_value.newTickerDetails
5. star_email        ← scanner-xgpt-iris/step-4-star-email.js  (unchanged)
```

### Wiring steps in Pipedream

**A. Change the trigger**
1. Open the XGPT+IRIS workflow
2. Click the current trigger (Gmail New Email) → three-dot menu → **Delete**
3. Click **+ Add trigger** → **Schedule** → set interval to **Every 15 minutes**
4. Save

**B. Replace step 2 — search_gmail**
1. Delete the existing `parse_email` step (or rename it — you're replacing it)
2. Click **+ Add step** → **Run custom code** → Node.js
3. In the step's account selector, click **Connect account** → select your Gmail account
   (the same one that receives the scanner emails)
4. Paste the full content of `scanner-xgpt-iris/step-1-search-gmail.js`
5. Rename the step to `search_gmail`
6. Drag it to position 2 (right after the schedule trigger)

**C. Replace step 3 — parse_and_write**
1. Delete the existing `write_to_supabase` step
2. Add a new Node.js code step — no Gmail account needed (uses Supabase only)
3. Paste `scanner-xgpt-iris/step-2-parse-and-write.js`
4. Rename to `parse_and_write`, drag to position 3

**D. Update the Telegram step (step 4)**
The Telegram step previously read `steps.write_to_supabase.$return_value.tickers`.
Update it to use `steps.parse_and_write.$return_value.newTickerDetails` instead.
`newTickerDetails` is an array of `{symbol, scanner, emailId, subject}` — only
newly-written tickers, never duplicates.

**E. star_email (step 5) — unchanged**
Keep `step-4-star-email.js` as the last step. The only change: it now stars
messages that were searched/fetched in step 2, not triggered by the Gmail
trigger. It still reads `steps.trigger.event.id` — but with a Schedule trigger,
`steps.trigger.event` has no email ID.

→ **Update star_email**: change the message ID source:
```js
// OLD (passive trigger had the email id on the event):
const messageId = steps.trigger.event.id;

// NEW (active search — star ALL messages that produced new tickers):
const details = steps.parse_and_write.$return_value?.newTickerDetails || [];
const emailIds = [...new Set(details.map(d => d.emailId))];
// star each one
for (const messageId of emailIds) {
  try {
    await axios($, {
      method: 'POST',
      url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`,
      headers: { Authorization: `Bearer ${this.gmail.$auth.oauth_access_token}` },
      data: { addLabelIds: ['STARRED'], removeLabelIds: [] },
    });
  } catch(e) { console.warn(`star ${messageId} failed:`, e.message); }
}
return { starred: emailIds };
```

Replace the body of `star_email` with the above.

### Gmail search query used
```
(from:timsykeswatchlist.com OR from:stockstotrade.com OR subject:XGPT OR subject:IRIS) newer_than:1d
```
Catches direct emails AND forwarded emails where the subject still contains XGPT/IRIS.

---

## 3 · Scanner – Momentum (evolutionx4u) — v2 active-search

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

## 3 · Scanner – Momentum (evolutionx4u) — v2 active-search

### Step order
```
1. trigger           ← Schedule, every 15 minutes (NOT gmail-new-email-received)
2. search_gmail      ← scanner-momentum/step-1-search-gmail.js  (Gmail app connected)
3. parse_and_write   ← scanner-momentum/step-2-parse-and-write.js
4. send_telegram     ← update reference to steps.parse_and_write.$return_value.newTickerDetails
5. star_email        ← scanner-momentum/step-4-star-email.js  (last, try/catch)
```

### Wiring steps in Pipedream

**A. Change the trigger**
1. Open the Momentum workflow
2. Click the current trigger (Gmail New Email) → three-dot menu → **Delete**
3. Click **+ Add trigger** → **Schedule** → set interval to **Every 15 minutes**
4. Save

**B. Replace step 2 — search_gmail**
1. Delete the existing `parse_email` step (or rename it — you're replacing it)
2. Click **+ Add step** → **Run custom code** → Node.js
3. In the step's account selector, click **Connect account** → select your Gmail account
   (the same one that receives the Momentum emails)
4. Paste the full content of `scanner-momentum/step-1-search-gmail.js`
5. Rename the step to `search_gmail`
6. Drag it to position 2 (right after the schedule trigger)

**C. Replace step 3 — parse_and_write**
1. Delete the existing `write_to_supabase` step
2. Add a new Node.js code step — no Gmail account needed (uses Supabase only)
3. Paste `scanner-momentum/step-2-parse-and-write.js`
4. Rename to `parse_and_write`, drag to position 3

**D. Update the Telegram step (step 4)**
The Telegram step previously read `steps.write_to_supabase.$return_value.tickers`.
Update it to use `steps.parse_and_write.$return_value.newTickerDetails` instead.
`newTickerDetails` is an array of `{symbol, scanner, emailId, subject}` — only
newly-written tickers, never duplicates.

**E. star_email (step 5) — updated**
Paste `scanner-momentum/step-4-star-email.js` as the last step.
It now reads emailIds from `steps.parse_and_write.$return_value.newTickerDetails`
instead of `steps.trigger.event.id` (which doesn't exist on a Schedule trigger).
Connect the same Gmail account in the step's account selector.

### Gmail search query used
```
(from:moneyandmarkets.com OR from:evolutionx4u OR subject:momentum OR subject:10X OR subject:"money and markets") newer_than:1d
```
Catches direct emails AND forwarded emails where the subject still contains
Momentum / 10X / Money and Markets.

**Note on routing**: `step-1-search-gmail.js` does a secondary route-check after
fetching each message. It keeps the message only if `from` includes
`moneyandmarkets.com` / `evolutionx4u` OR subject matches
`/money[\s-]?markets|10x|\btenx\b|momentum/i`. Forwarded emails from
4hillonline@gmail.com pass the route-check as long as the subject is unchanged.

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
