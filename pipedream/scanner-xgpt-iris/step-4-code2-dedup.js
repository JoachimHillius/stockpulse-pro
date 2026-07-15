// ─────────────────────────────────────────────────────────────────────────────
// Pipedream step: code2  (dedup)
// Workflow: Scanner – XGPT+IRIS  ·  … → code1 → [HERE] → code3
//
// Deduplicates the validated ticker array on (email_id, symbol).
//
// In the old single-email architecture this was never needed — processing one
// email at a time, the parser naturally produced each symbol once. With an
// array of emails, the same ticker can appear in the same email body twice
// (e.g. mentioned in a list header and body), or in two different emails in
// the same hourly batch from the same sender. This step collapses both cases:
//
//   (email_id, symbol) duplicates → keep the one with the highest score
//   (if scores are equal or both null, keep the first occurrence)
//
// Returns: deduplicated flat array, same shape as code1's output.
// ─────────────────────────────────────────────────────────────────────────────

export default defineComponent({
  async run({ steps, $ }) {
    const items = steps.code1.$return_value;

    if (!Array.isArray(items) || items.length === 0) {
      console.log('[code2/dedup] No items from code1 — nothing to dedup');
      return [];
    }

    // Key: `${email_id}::${symbol}` — dedup within the same email
    const seen = new Map();

    for (const item of items) {
      const key = `${item.email_id}::${item.symbol}`;
      const existing = seen.get(key);

      if (!existing) {
        seen.set(key, item);
        continue;
      }

      // Keep the row with the higher score; ties → keep first (existing)
      const newScore      = item.score     ?? -Infinity;
      const existingScore = existing.score ?? -Infinity;
      if (newScore > existingScore) {
        seen.set(key, item);
        console.log(`[code2/dedup] Replaced ${item.symbol} in ${item.email_id} (score ${existingScore} → ${newScore})`);
      } else {
        console.log(`[code2/dedup] Kept first ${item.symbol} in ${item.email_id} (dropped score ${newScore})`);
      }
    }

    const result = [...seen.values()];
    const dropped = items.length - result.length;
    if (dropped > 0) {
      console.log(`[code2/dedup] Removed ${dropped} duplicate (email_id, symbol) pair(s)`);
    }
    console.log(`[code2/dedup] ${result.length} unique ticker row(s) → code3`);
    return result;
  },
});
