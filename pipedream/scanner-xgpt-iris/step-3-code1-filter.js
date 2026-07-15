// ─────────────────────────────────────────────────────────────────────────────
// Pipedream step: code1  (filter)
// Workflow: Scanner – XGPT+IRIS  ·  … → code → [HERE] → code2 → code3
//
// Reads the flat ticker array from `code` and applies the same defensive
// validation that existed implicitly in the old single-email flow:
//   - symbol must be at least 2 chars and not in SKIP_WORDS
//   - scanner must be 'xgpt' or 'iris'
//   - email_id and symbol must be present
//   - score is coerced to a finite number or null (guards against NaN from parser)
//
// In the old single-email architecture these checks ran inside parse_email
// and parse_and_write. Pulling them here makes each step's contract explicit
// and prevents bad rows from reaching the Supabase write in code3.
//
// Returns: same array shape as code, filtered and cleaned.
// ─────────────────────────────────────────────────────────────────────────────

export default defineComponent({
  async run({ steps, $ }) {
    const items = steps.code.$return_value;

    if (!Array.isArray(items) || items.length === 0) {
      console.log('[code1/filter] No items from code — nothing to filter');
      return [];
    }

    // Same SKIP_WORDS set as the parser — belt-and-suspenders guard
    const SKIP_WORDS = new Set([
      'THE','FOR','AND','NOT','BUY','SELL','HOLD','WITH','FROM','THAT','THIS',
      'YOUR','HAVE','BEEN','WILL','ARE','WAS','HAS','NEW','TOP','ALL','ANY',
      'EACH','HIGH','LOW','OPEN','XGPT','IRIS','HTML','TEXT','SENT','DATE',
      'VIEW','LINK','CLICK','MORE','HTTP','HTTPS','LIST','WATCH','SCAN','DAY',
      'WEEK','MONTH','YEAR','JUST','ALSO','ONLY','INTO','OVER','UNDER','NEAR',
    ]);

    const VALID_SCANNERS = new Set(['xgpt', 'iris']);
    const valid   = [];
    let   dropped = 0;

    for (const item of items) {
      const { email_id, symbol, scanner, score } = item;

      // Must have email_id and symbol
      if (!email_id || !symbol) {
        console.warn('[code1/filter] Drop — missing email_id or symbol:', item);
        dropped++;
        continue;
      }

      // Symbol validation (same rules as the parser)
      if (symbol.length < 2 || SKIP_WORDS.has(symbol)) {
        console.warn(`[code1/filter] Drop — invalid symbol: ${symbol}`);
        dropped++;
        continue;
      }

      // Scanner must be a known value
      if (!VALID_SCANNERS.has(scanner)) {
        console.warn(`[code1/filter] Drop — unknown scanner: ${scanner} (${symbol})`);
        dropped++;
        continue;
      }

      // Coerce score: reject NaN, keep null for "no score"
      const cleanScore = (score != null && !isNaN(Number(score)))
        ? Number(score)
        : null;

      valid.push({ ...item, score: cleanScore });
    }

    console.log(`[code1/filter] ${valid.length} valid / ${dropped} dropped from ${items.length} input rows`);
    return valid;
  },
});
