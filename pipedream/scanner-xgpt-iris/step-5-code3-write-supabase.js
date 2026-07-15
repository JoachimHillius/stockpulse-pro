// ─────────────────────────────────────────────────────────────────────────────
// Pipedream step: code3  (write to Supabase)
// Workflow: Scanner – XGPT+IRIS  ·  … → code2 → [HERE] → (star_email)
//
// For each ticker row from code2:
//
//   1. INSERT into scanner_alerts.
//      scanner_alerts has a UNIQUE index on (email_id, symbol).
//      23505 (unique violation) = this ticker was already written in a prior
//      run → skip it entirely (do NOT update the watchlist counter; that was
//      already incremented when the alert was first inserted).
//
//   2. Only if the alert insert succeeded → upsert scanner_watchlist.
//      Reads the existing row first to correctly increment xgpt_count /
//      iris_count and total_count (same logic as parse_and_write step).
//      Also enrolls the symbol in price_sync_status so the cron builds
//      price_history for it.
//
// Running this workflow multiple times is always safe — re-runs are idempotent.
//
// Requires Pipedream environment variables:
//   SUPABASE_URL         — e.g. https://siwrhqcojoyxxwaxnopc.supabase.co
//   SUPABASE_SERVICE_KEY — service role key (bypasses RLS; never expose client-side)
//
// Returns:
//   { newEmailIds: string[] }
//   newEmailIds — unique email IDs that produced at least 1 newly-written ticker.
//   star_email reads this to decide which emails to label STARRED + IMPORTED.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js';

export default defineComponent({
  async run({ steps, $ }) {
    const items = steps.code2.$return_value;

    if (!Array.isArray(items) || items.length === 0) {
      console.log('[code3/write] No ticker rows from code2 — nothing to write');
      return { newEmailIds: [] };
    }

    const supa = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY  // service role — bypasses RLS
    );

    // email IDs that had at least one successfully inserted (new) ticker
    const newEmailIdSet = new Set();

    for (const item of items) {
      const {
        email_id,
        symbol,
        scanner,
        list_name,
        sender,
        subject,
        summary,
        score,
        alert_date,
        raw,
      } = item;

      // ── 1. Insert scanner_alert — unique on (email_id, symbol) ─────────────
      const alertRow = {
        symbol,
        scanner,
        list_name,
        sender,
        subject,
        email_id,
        alert_date,
        score:   score   ?? null,
        summary: summary ?? `${scanner.toUpperCase()} alert: ${symbol}`,
        raw:     raw     ?? null,
      };

      const { error: alertErr } = await supa
        .from('scanner_alerts')
        .insert(alertRow);

      if (alertErr) {
        if (alertErr.code === '23505') {
          // Already written in a prior run — skip watchlist update too
          console.log(`[code3/write] Dupe (email_id, symbol) — skip ${symbol} in ${email_id}`);
          continue;
        }
        console.error(`[code3/write] scanner_alerts insert ${symbol}:`, alertErr.message);
        continue;
      }

      // ── 2. Alert was new → upsert scanner_watchlist ────────────────────────
      // Read the existing row to correctly compute incremented counters
      const { data: existing, error: selErr } = await supa
        .from('scanner_watchlist')
        .select('id, xgpt_count, iris_count, total_count')
        .eq('symbol', symbol)
        .maybeSingle();

      if (selErr) {
        console.error(`[code3/write] watchlist select ${symbol}:`, selErr.message);
      } else if (existing) {
        const countField = scanner === 'xgpt' ? 'xgpt_count' : 'iris_count';
        const patch = {
          last_scanner:    scanner,
          last_alert_date: alert_date,
          total_count:     (existing.total_count || 0) + 1,
          [countField]:    (existing[countField]  || 0) + 1,
          updated_at:      new Date().toISOString(),
        };
        if (score  != null) patch[`rating_${scanner}`] = score;

        const { error: upErr } = await supa
          .from('scanner_watchlist')
          .update(patch)
          .eq('id', existing.id);

        if (upErr) {
          console.error(`[code3/write] watchlist update ${symbol}:`, upErr.message);
        }
      } else {
        // New symbol — insert
        const newRow = {
          symbol,
          list_name,
          source_scanner:  scanner,
          last_scanner:    scanner,
          first_seen_date: alert_date,
          last_alert_date: alert_date,
          xgpt_count:      scanner === 'xgpt' ? 1 : 0,
          iris_count:      scanner === 'iris'  ? 1 : 0,
          total_count:     1,
          is_new:          true,
          status:          'open',
        };
        if (score != null) newRow[`rating_${scanner}`] = score;

        const { error: insErr } = await supa
          .from('scanner_watchlist')
          .insert(newRow);

        if (insErr) {
          console.error(`[code3/write] watchlist insert ${symbol}:`, insErr.message);
        }
      }

      // ── 3. Enroll in price_sync_status so cron builds price_history ─────────
      await supa
        .from('price_sync_status')
        .upsert(
          [{ symbol, last_status: 'pending' }],
          { onConflict: 'symbol', ignoreDuplicates: true }
        );

      newEmailIdSet.add(email_id);
      console.log(`[code3/write] Wrote ${symbol} (${scanner}) from ${email_id}`);
    }

    const newEmailIds = [...newEmailIdSet];
    console.log(`[code3/write] Done. New email IDs: ${newEmailIds.length} — ${newEmailIds.join(', ') || 'none'}`);
    return { newEmailIds };
  },
});
