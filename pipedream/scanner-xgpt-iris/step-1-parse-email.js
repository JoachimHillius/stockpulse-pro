// ─────────────────────────────────────────────────────────────────────────────
// Pipedream step: parse_email
// Workflow: Scanner – XGPT+IRIS (4hillonline)
//
// Paste this entire block into the CODE step that currently parses the email.
// Returns: { scanner, listName, sender, subject, emailId, alertDate, tickers[] }
//          where tickers = [{ symbol, score, action }]
// ─────────────────────────────────────────────────────────────────────────────

export default defineComponent({
  async run({ steps, $ }) {
    const event = steps.trigger.event;

    // ── 1. Normalise from/subject ─────────────────────────────────────────
    // Pipedream may give `from` as "Name <email@domain.com>" or just the email
    const fromRaw = (
      (typeof event.from === 'object' ? event.from?.email : event.from) || ''
    ).toLowerCase();
    const subjectRaw = (event.subject || '').toLowerCase();

    const isXgpt = fromRaw.includes('timsykeswatchlist.com') || /xgpt/.test(subjectRaw);
    const isIris = fromRaw.includes('stockstotrade.com')     || /\biris\b/.test(subjectRaw);

    if (!isXgpt && !isIris) {
      return $.flow.exit(
        `Skipping — not XGPT or IRIS. From: ${fromRaw} | Subject: ${event.subject}`
      );
    }

    const scanner  = isXgpt ? 'xgpt' : 'iris';
    const listName = 'xgpt_iris';

    // ── 2. Extract body — try plain text then HTML ────────────────────────
    let body = event.text || event.body?.text || '';

    if (!body && event.html) {
      body = event.html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<[^>]+>/g, '');
    }

    // Decode HTML entities
    body = body
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g,  '<')
      .replace(/&gt;/g,  '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));

    // ── 3. Strip forwarded-email artifacts ────────────────────────────────
    // Remove the Gmail "---------- Forwarded message ---------" block header
    body = body.replace(
      /^-{4,}\s*Forwarded message\s*-{4,}[\s\S]*?(?=\n\n|\r\n\r\n)/im,
      ''
    );
    // Strip quoted reply ">" prefixes (any nesting)
    body = body
      .split('\n')
      .map(line => line.replace(/^(>\s*)+/, '').trim())
      .join('\n');
    // Remove "On <date>, <name> wrote:" lines
    body = body.replace(/^On .{0,120}wrote:\s*$/gim, '');
    // Strip common email footer boilerplate
    body = body.replace(/^(unsubscribe|view online|view in browser|click here).*/gim, '');

    // ── 4. Parse ticker symbols ───────────────────────────────────────────
    const SKIP_WORDS = new Set([
      'THE','FOR','AND','NOT','BUY','SELL','HOLD','WITH','FROM','THAT','THIS',
      'YOUR','HAVE','BEEN','WILL','ARE','WAS','HAS','NEW','TOP','ALL','ANY',
      'EACH','HIGH','LOW','OPEN','XGPT','IRIS','HTML','TEXT','SENT','DATE',
      'VIEW','LINK','CLICK','MORE','HTTP','HTTPS','LIST','WATCH','SCAN','DAY',
      'WEEK','MONTH','YEAR','JUST','ALSO','ONLY','INTO','OVER','UNDER','NEAR',
    ]);

    const tickerMap = new Map(); // symbol → { score, action }

    // Pattern A: $TICKER  (strongest signal)
    for (const m of body.matchAll(/\$([A-Z]{1,5})\b/g)) {
      if (!SKIP_WORDS.has(m[1])) tickerMap.set(m[1], tickerMap.get(m[1]) || {});
    }

    // Pattern B: line starts with TICKER (1–5 caps), optionally followed by score/action
    // e.g.  "AAPL"  |  "AAPL 8.5"  |  "AAPL - BUY"  |  "AAPL: 9"
    for (const m of body.matchAll(/^([A-Z]{1,5})\b([\t ]*[-:]?[\t ]*[\d.]+)?([\t ]+[A-Z]+)?/gm)) {
      const sym    = m[1];
      const scoreStr = (m[2] || '').replace(/[^0-9.]/g, '');
      const actionStr = (m[3] || '').trim();
      if (SKIP_WORDS.has(sym)) continue;
      if (sym.length < 2) continue; // single-letter false positives
      const existing = tickerMap.get(sym) || {};
      tickerMap.set(sym, {
        score:  existing.score  ?? (scoreStr  ? parseFloat(scoreStr)  : null),
        action: existing.action ?? (actionStr && /^(BUY|SELL|WATCH|LONG|SHORT|HOLD)$/i.test(actionStr)
          ? actionStr.toUpperCase() : null),
      });
    }

    const tickers = [...tickerMap.entries()].map(([symbol, meta]) => ({
      symbol,
      score:  meta.score  ?? null,
      action: meta.action ?? null,
    }));

    if (tickers.length === 0) {
      return $.flow.exit(
        `No tickers found in ${scanner.toUpperCase()} email. Subject: ${event.subject}\nBody preview: ${body.slice(0, 300)}`
      );
    }

    console.log(`[parse_email] ${scanner.toUpperCase()} — found ${tickers.length} tickers:`, tickers.map(t => t.symbol).join(', '));

    return {
      scanner,
      listName,
      sender:    fromRaw,
      subject:   event.subject || '',
      emailId:   event.id || '',
      alertDate: new Date().toISOString().slice(0, 10),
      tickers,
    };
  },
});
