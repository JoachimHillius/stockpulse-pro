// ─────────────────────────────────────────────────────────────────────────────
// Pipedream step: write_to_supabase
// Workflow: Scanner – Momentum (evolutionx4u)
//
// Same logic as the XGPT+IRIS version — increments momentum_count instead.
// Requires same env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js';

export default defineComponent({
  async run({ steps, $ }) {
    const { scanner, listName, sender, subject, emailId, alertDate, tickers } =
      steps.parse_email.$return_value;

    const supa = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const results   = [];
    const alertRows = [];

    for (const { symbol, score, action } of tickers) {
      const sym = symbol.toUpperCase();

      // ── 1. Upsert scanner_watchlist ──────────────────────────────────────
      const { data: existing, error: selErr } = await supa
        .from('scanner_watchlist')
        .select('id, momentum_count, tenx_count, total_count')
        .eq('symbol', sym)
        .maybeSingle();

      if (selErr) {
        console.error(`[watchlist] select error for ${sym}:`, selErr.message);
        continue;
      }

      let watchlistId;

      if (existing) {
        const totalVal = (existing.total_count   || 0) + 1;
        const momVal   = (existing.momentum_count || 0) + 1;
        const tenxVal  = (existing.tenx_count     || 0) + 1;

        const patch = {
          last_scanner:    scanner,
          last_alert_date: alertDate,
          total_count:     totalVal,
          momentum_count:  momVal,
          tenx_count:      tenxVal,
          updated_at:      new Date().toISOString(),
        };
        if (score  != null) patch.rating_xgpt = score; // tenx uses xgpt rating slot
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
        const newRow = {
          symbol:          sym,
          list_name:       listName,
          source_scanner:  scanner,
          last_scanner:    scanner,
          first_seen_date: alertDate,
          last_alert_date: alertDate,
          momentum_count:  1,
          tenx_count:      1,
          total_count:     1,
          is_new:          true,
          status:          'open',
        };
        if (score  != null) newRow.rating_xgpt = score;
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
        summary:      `MOMENTUM alert: ${sym}`,
        raw:          { tickers_in_email: tickers.map(t => t.symbol) },
      });
    }

    if (alertRows.length > 0) {
      const { error: alertErr } = await supa.from('scanner_alerts').insert(alertRows);
      if (alertErr) console.error('[scanner_alerts] batch insert error:', alertErr.message);
      else console.log(`[scanner_alerts] inserted ${alertRows.length} alert rows`);
    }

    console.log(`[write_to_supabase] MOMENTUM — ${results.length}/${tickers.length} symbols written`);

    return {
      scanner,
      symbolsWritten: results.length,
      symbolsTotal:   tickers.length,
      alertsInserted: alertRows.length,
      results,
      tickers:   tickers.map(t => t.symbol),
      alertDate,
      subject,
    };
  },
});
