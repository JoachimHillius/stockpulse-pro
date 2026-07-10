// ─────────────────────────────────────────────────────────────────────────────
// Pipedream step: parse_and_write
// Workflow: Scanner – Momentum (evolutionx4u)
//
// Same pattern as scanner-xgpt-iris/step-2-parse-and-write.js.
// Differences: scanner='tenx', listName='money_markets',
//              increments momentum_count + tenx_count.
//
// Loops over messages from search_gmail. For each ticker found:
//   1. Insert into scanner_alerts first.
//      scanner_alerts has a UNIQUE index on (email_id, symbol).
//      A 23505 error = already written in a prior run → skip this ticker.
//   2. Only if the alert insert succeeded → upsert scanner_watchlist
//      (increment momentum_count + tenx_count, update last_alert_date).
//
// Requires env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY
//
// Returns:
//   { messagesProcessed, newTickers, newTickerDetails }
//   newTickerDetails: [{symbol, scanner, emailId, subject}] — newly-written only.
//   send_telegram and star_email both consume newTickerDetails.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js';

const SKIP_WORDS = new Set([
  'THE','FOR','AND','NOT','BUY','SELL','HOLD','WITH','FROM','THAT','THIS',
  'YOUR','HAVE','BEEN','WILL','ARE','WAS','HAS','NEW','TOP','ALL','ANY',
  'EACH','HIGH','LOW','OPEN','HTML','TEXT','SENT','DATE','VIEW','LINK',
  'CLICK','MORE','HTTP','HTTPS','LIST','WATCH','SCAN','DAY','WEEK','MONTH',
  'YEAR','JUST','ALSO','ONLY','INTO','OVER','UNDER','NEAR','TENX','MONEY',
  'MARKETS','MOMENTUM','MARKET','STOCK','TRADE','STOCKS','ALERT',
]);

function parseTickers(body) {
  const text = body
    .replace(/^-{4,}\s*Forwarded message\s*-{4,}[\s\S]*?(?=\n\n|\r\n\r\n)/im, '')
    .split('\n').map(l => l.replace(/^(>\s*)+/, '').trim()).join('\n')
    .replace(/^On .{0,120}wrote:\s*$/gim, '')
    .replace(/^(unsubscribe|view online|view in browser|click here).*/gim, '');

  const tickerMap = new Map();

  for (const m of text.matchAll(/\$([A-Z]{1,5})\b/g)) {
    if (!SKIP_WORDS.has(m[1])) tickerMap.set(m[1], tickerMap.get(m[1]) || {});
  }

  for (const m of text.matchAll(/^([A-Z]{1,5})\b([\t ]*[-:]?[\t ]*[\d.]+)?([\t ]+[A-Z]+)?/gm)) {
    const sym      = m[1];
    const scoreStr = (m[2] || '').replace(/[^0-9.]/g, '');
    const actStr   = (m[3] || '').trim();
    if (SKIP_WORDS.has(sym) || sym.length < 2) continue;
    const ex = tickerMap.get(sym) || {};
    tickerMap.set(sym, {
      score:  ex.score  ?? (scoreStr ? parseFloat(scoreStr) : null),
      action: ex.action ?? (/^(BUY|SELL|WATCH|LONG|SHORT|HOLD)$/i.test(actStr) ? actStr.toUpperCase() : null),
    });
  }

  return [...tickerMap.entries()].map(([symbol, meta]) => ({
    symbol, score: meta.score ?? null, action: meta.action ?? null,
  }));
}

export default defineComponent({
  async run({ steps, $ }) {
    const { messages } = steps.search_gmail.$return_value;

    if (!messages || messages.length === 0) {
      console.log('[parse_and_write] No messages — exiting');
      return { messagesProcessed: 0, newTickers: 0, newTickerDetails: [] };
    }

    const supa = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const alertDate        = new Date().toISOString().slice(0, 10);
    const scanner          = 'tenx';
    const listName         = 'money_markets';
    const newTickerDetails = [];

    for (const msg of messages) {
      const { id: emailId, subject, from, body } = msg;

      const tickers = parseTickers(body);
      if (tickers.length === 0) {
        console.log(`[parse_and_write] No tickers found in ${emailId} (${subject})`);
        continue;
      }

      console.log(`[parse_and_write] ${emailId}: ${tickers.length} ticker(s)`);

      for (const { symbol, score, action } of tickers) {
        const sym = symbol.toUpperCase();

        // ── 1. Insert alert — unique index (email_id, symbol) handles dedupe ──
        const alertRow = {
          symbol,
          scanner,
          list_name:  listName,
          sender:     from,
          subject,
          email_id:   emailId,
          alert_date: alertDate,
          score:      score  ?? null,
          action:     action ?? null,
          summary:    `MOMENTUM alert: ${sym}`,
          raw:        { tickers_in_email: tickers.map(t => t.symbol) },
        };

        const { error: alertErr } = await supa.from('scanner_alerts').insert(alertRow);

        if (alertErr) {
          if (alertErr.code === '23505') {
            console.log(`[parse_and_write] Dupe (email_id, symbol) — skip ${sym} in ${emailId}`);
            continue;
          }
          console.error(`[scanner_alerts] insert ${sym}:`, alertErr.message);
          continue;
        }

        // ── 2. Alert was new — upsert watchlist and increment counters ────────
        const { data: existing } = await supa
          .from('scanner_watchlist')
          .select('id, momentum_count, tenx_count, total_count')
          .eq('symbol', sym)
          .maybeSingle();

        if (existing) {
          const patch = {
            last_scanner:    scanner,
            last_alert_date: alertDate,
            total_count:     (existing.total_count    || 0) + 1,
            momentum_count:  (existing.momentum_count || 0) + 1,
            tenx_count:      (existing.tenx_count     || 0) + 1,
            updated_at:      new Date().toISOString(),
          };
          if (score  != null) patch.rating_xgpt = score;
          if (action != null) patch.action = action;

          const { error: upErr } = await supa
            .from('scanner_watchlist').update(patch).eq('id', existing.id);
          if (upErr) console.error(`[watchlist] update ${sym}:`, upErr.message);
        } else {
          const newRow = {
            symbol,
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

          const { error: insErr } = await supa.from('scanner_watchlist').insert(newRow);
          if (insErr) console.error(`[watchlist] insert ${sym}:`, insErr.message);
        }

        // Enroll in price_sync_status so the cron builds price_history for this symbol
        await supa.from('price_sync_status')
          .upsert([{ symbol: sym, last_status: 'pending' }], { onConflict: 'symbol', ignoreDuplicates: true });

        newTickerDetails.push({ symbol: sym, scanner, emailId, subject });
        console.log(`[parse_and_write] Wrote ${sym} from ${emailId}`);
      }
    }

    console.log(`[parse_and_write] Done. New tickers: ${newTickerDetails.length}`);
    return {
      messagesProcessed: messages.length,
      newTickers:        newTickerDetails.length,
      newTickerDetails,  // [{symbol, scanner, emailId, subject}]
    };
  },
});
