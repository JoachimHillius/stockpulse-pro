// ─────────────────────────────────────────────────────────────────────────────
// Pipedream step: write_to_supabase
// Workflow: Scanner – XGPT+IRIS (4hillonline)
//
// Paste this entire block into the CODE step that writes to the DB.
// This step must run AFTER parse_email and BEFORE telegram / star_email.
//
// Requires Pipedream environment variables:
//   SUPABASE_URL         = https://siwrhqcojoyxxwaxnopc.supabase.co
//   SUPABASE_SERVICE_KEY = (service role key — from Supabase dashboard →
//                           Project Settings → API → service_role key)
//                          Service key bypasses RLS — never expose client-side.
//
// Writes to:
//   scanner_watchlist  — upsert on symbol (increments xgpt_count / iris_count)
//   scanner_alerts     — appends one row per ticker per email
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js';

export default defineComponent({
  async run({ steps, $ }) {
    const { scanner, listName, sender, subject, emailId, alertDate, tickers } =
      steps.parse_email.$return_value;

    const supa = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY  // service role — bypasses RLS
    );

    const results   = [];
    const alertRows = [];

    for (const { symbol, score, action } of tickers) {
      const sym = symbol.toUpperCase();

      // ── 1. Upsert scanner_watchlist ─────────────────────────────────────
      const { data: existing, error: selErr } = await supa
        .from('scanner_watchlist')
        .select('id, xgpt_count, iris_count, total_count')
        .eq('symbol', sym)
        .maybeSingle();

      if (selErr) {
        console.error(`[watchlist] select error for ${sym}:`, selErr.message);
        continue;
      }

      let watchlistId;

      if (existing) {
        // Increment counter for the scanner that fired
        const countField  = scanner === 'xgpt' ? 'xgpt_count' : 'iris_count';
        const countVal    = (existing[countField] || 0) + 1;
        const totalVal    = (existing.total_count  || 0) + 1;

        const patch = {
          last_scanner:   scanner,
          last_alert_date: alertDate,
          total_count:    totalVal,
          updated_at:     new Date().toISOString(),
          [countField]:   countVal,
        };
        if (score  != null) patch[`rating_${scanner}`] = score;
        if (action != null) patch.action = action;

        const { data: up, error: upErr } = await supa
          .from('scanner_watchlist')
          .update(patch)
          .eq('id', existing.id)
          .select('id')
          .single();

        if (upErr) { console.error(`[watchlist] update error for ${sym}:`, upErr.message); continue; }
        watchlistId = up.id;
        results.push({ symbol: sym, op: 'updated', watchlistId });
      } else {
        // New symbol — insert
        const newRow = {
          symbol:          sym,
          list_name:       listName,
          source_scanner:  scanner,
          last_scanner:    scanner,
          first_seen_date: alertDate,
          last_alert_date: alertDate,
          xgpt_count:      scanner === 'xgpt' ? 1 : 0,
          iris_count:      scanner === 'iris'  ? 1 : 0,
          total_count:     1,
          is_new:          true,
          status:          'open',
        };
        if (score  != null) newRow[`rating_${scanner}`] = score;
        if (action != null) newRow.action = action;

        const { data: ins, error: insErr } = await supa
          .from('scanner_watchlist')
          .insert(newRow)
          .select('id')
          .single();

        if (insErr) { console.error(`[watchlist] insert error for ${sym}:`, insErr.message); continue; }
        watchlistId = ins.id;
        results.push({ symbol: sym, op: 'inserted', watchlistId });
      }

      // ── 2. Append to scanner_alerts ──────────────────────────────────────
      alertRows.push({
        watchlist_id: watchlistId,
        symbol:       sym,
        scanner,
        list_name:    listName,
        sender,
        subject,
        email_id:     emailId,
        alert_date:   alertDate,
        score:        score  ?? null,
        action:       action ?? null,
        summary:      `${scanner.toUpperCase()} alert: ${sym}`,
        raw:          { tickers_in_email: tickers.map(t => t.symbol) },
      });
    }

    // Batch-insert all alert rows at once
    if (alertRows.length > 0) {
      const { error: alertErr } = await supa.from('scanner_alerts').insert(alertRows);
      if (alertErr) console.error('[scanner_alerts] batch insert error:', alertErr.message);
      else console.log(`[scanner_alerts] inserted ${alertRows.length} alert rows`);
    }

    console.log(`[write_to_supabase] ${scanner.toUpperCase()} — ${results.length}/${tickers.length} symbols written`);

    return {
      scanner,
      symbolsWritten: results.length,
      symbolsTotal:   tickers.length,
      alertsInserted: alertRows.length,
      results,
      // Pass the ticker list forward so the Telegram step can use it
      tickers:   tickers.map(t => t.symbol),
      alertDate,
      subject,
    };
  },
});
