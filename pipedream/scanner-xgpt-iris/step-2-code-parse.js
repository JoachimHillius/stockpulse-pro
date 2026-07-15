// ─────────────────────────────────────────────────────────────────────────────
// Pipedream step: code  (parse)
// Workflow: Scanner – XGPT+IRIS  ·  Schedule → search_gmail → [HERE] → code1 → code2 → code3
//
// Loops every email returned by search_gmail.
// Per email: runs the XGPT/IRIS parser (same logic as the old single-email
// parse_email step). Emails that are not XGPT/IRIS, or that yield no tickers,
// are silently skipped with `continue` — never $.flow.exit(), so the rest of
// the batch is not killed.
//
// Returns: flat array — one row per (email × ticker) pair:
//   [{ email_id, symbol, scanner, list_name, sender, subject,
//      summary, score, alert_date, raw }]
//
// Downstream:
//   code1  reads steps.code.$return_value   (filters invalid items)
//   code2  reads steps.code1.$return_value  (deduplicates within the batch)
//   code3  reads steps.code2.$return_value  (writes to Supabase)
// ─────────────────────────────────────────────────────────────────────────────

export default defineComponent({
  async run({ steps, $ }) {
    // search_gmail returns a direct array of email objects
    const emails = steps.search_gmail.$return_value;

    if (!Array.isArray(emails) || emails.length === 0) {
      console.log('[code/parse] search_gmail returned no emails');
      return [];
    }

    // ── Shared skip-word set — identical to old parse_email step ─────────────
    const SKIP_WORDS = new Set([
      'THE','FOR','AND','NOT','BUY','SELL','HOLD','WITH','FROM','THAT','THIS',
      'YOUR','HAVE','BEEN','WILL','ARE','WAS','HAS','NEW','TOP','ALL','ANY',
      'EACH','HIGH','LOW','OPEN','XGPT','IRIS','HTML','TEXT','SENT','DATE',
      'VIEW','LINK','CLICK','MORE','HTTP','HTTPS','LIST','WATCH','SCAN','DAY',
      'WEEK','MONTH','YEAR','JUST','ALSO','ONLY','INTO','OVER','UNDER','NEAR',
    ]);

    const alertDate = new Date().toISOString().slice(0, 10);
    const listName  = 'xgpt_iris';
    const results   = [];

    for (const email of emails) {
      const { id: emailId, subject = '', from = '', body = '' } = email;

      // ── 1. Route check — same logic as old parse_email ────────────────────
      const fromLow = from.toLowerCase();
      const subLow  = subject.toLowerCase();

      const isXgpt = fromLow.includes('timsykeswatchlist.com') || /xgpt/.test(subLow);
      const isIris = fromLow.includes('stockstotrade.com')     || /\biris\b/.test(subLow);

      if (!isXgpt && !isIris) {
        console.log(`[code/parse] Skip ${emailId} — not XGPT/IRIS (from=${from}, subject=${subject})`);
        continue;
      }

      const scanner = isXgpt ? 'xgpt' : 'iris';

      // ── 2. Clean body — same transforms as old parse_email ────────────────
      let text = body
        .replace(/&amp;/g,  '&')
        .replace(/&lt;/g,   '<')
        .replace(/&gt;/g,   '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));

      // Strip forwarded-message header block
      text = text.replace(
        /^-{4,}\s*Forwarded message\s*-{4,}[\s\S]*?(?=\n\n|\r\n\r\n)/im, ''
      );
      // Strip quoted-reply > prefixes
      text = text.split('\n')
        .map(line => line.replace(/^(>\s*)+/, '').trim())
        .join('\n');
      // Remove "On <date>, <name> wrote:" lines
      text = text.replace(/^On .{0,120}wrote:\s*$/gim, '');
      // Strip common footer boilerplate
      text = text.replace(/^(unsubscribe|view online|view in browser|click here).*/gim, '');

      // ── 3. Parse ticker symbols — same two patterns as old parse_email ─────
      const tickerMap = new Map(); // symbol → { score, action }

      // Pattern A: $TICKER  (strongest signal)
      for (const m of text.matchAll(/\$([A-Z]{1,5})\b/g)) {
        if (!SKIP_WORDS.has(m[1])) {
          tickerMap.set(m[1], tickerMap.get(m[1]) || {});
        }
      }

      // Pattern B: line starts with TICKER, optionally followed by score/action
      // e.g.  "AAPL"  |  "AAPL 8.5"  |  "AAPL - BUY"  |  "AAPL: 9"
      for (const m of text.matchAll(/^([A-Z]{1,5})\b([\t ]*[-:]?[\t ]*[\d.]+)?([\t ]+[A-Z]+)?/gm)) {
        const sym      = m[1];
        const scoreStr = (m[2] || '').replace(/[^0-9.]/g, '');
        const actStr   = (m[3] || '').trim();
        if (SKIP_WORDS.has(sym) || sym.length < 2) continue;
        const ex = tickerMap.get(sym) || {};
        tickerMap.set(sym, {
          score:  ex.score  ?? (scoreStr ? parseFloat(scoreStr) : null),
          action: ex.action ?? (
            /^(BUY|SELL|WATCH|LONG|SHORT|HOLD)$/i.test(actStr)
              ? actStr.toUpperCase()
              : null
          ),
        });
      }

      if (tickerMap.size === 0) {
        console.log(`[code/parse] No tickers in ${emailId} (${subject}) — skip`);
        continue;
      }

      const allSymbols = [...tickerMap.keys()].map(s => s.toUpperCase());
      console.log(`[code/parse] ${emailId} (${scanner.toUpperCase()}): ${allSymbols.length} ticker(s) — ${allSymbols.join(', ')}`);

      // ── 4. Flatten — one row per ticker, carrying email context ───────────
      for (const [rawSym, meta] of tickerMap) {
        const symbol = rawSym.toUpperCase();
        results.push({
          email_id:   emailId,
          symbol,
          scanner,
          list_name:  listName,
          sender:     from,
          subject,
          summary:    `${scanner.toUpperCase()} alert: ${symbol}`,
          score:      meta.score  ?? null,
          alert_date: alertDate,
          raw:        { tickers_in_email: allSymbols },
        });
      }
    }

    console.log(`[code/parse] Returning ${results.length} ticker row(s) from ${emails.length} email(s)`);
    return results;
  },
});
