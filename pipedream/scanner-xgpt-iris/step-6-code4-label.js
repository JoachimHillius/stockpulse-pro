// ─────────────────────────────────────────────────────────────────────────────
// Pipedream step: code4  (label)
// Workflow: Scanner – XGPT+IRIS
//   … → code3 (write) → [HERE]
//
// Applies two Gmail labels to every email that produced at least one new ticker:
//   STARRED  — red follow-up flag visible in Outlook / Gmail
//   IMPORTED — in-Gmail label; also used by search_gmail's query (-label:IMPORTED)
//              to skip already-processed emails on future runs
//
// If code3 wrote nothing new (all dupes or parse failures) → nothing is marked,
// future runs will re-check those emails.
//
// Non-fatal: label failures are logged and do not affect the DB writes already
// completed in code3.
//
// Connected account: same Gmail account used in step-1-search-gmail.
//
// Previously: step-4-star-email.js read steps.parse_and_write.$return_value
//             and extracted emailIds via .map(d => d.emailId).
// Now:        code3 returns { newEmailIds: string[] } — consumed directly.
// ─────────────────────────────────────────────────────────────────────────────

import { axios } from '@pipedream/platform';

export default defineComponent({
  props: {
    gmail: {
      type: 'app',
      app:  'gmail',
    },
  },
  async run({ steps, $ }) {
    // code3 returns { newEmailIds: [...] } — already deduplicated email ID strings
    const emailIds = steps.code3.$return_value?.newEmailIds ?? [];

    if (emailIds.length === 0) {
      console.log('[code4/label] No new tickers this run — skipping label step (promo, parse fail, or all dupes)');
      return { marked: [] };
    }

    const token = this.gmail.$auth.oauth_access_token;
    const BASE  = 'https://gmail.googleapis.com/gmail/v1/users/me';

    // ── Get or create the IMPORTED label ─────────────────────────────────────
    // Gmail modify requires a label ID, not its display name.
    // Look it up once per run; create on first use.
    let importedLabelId = null;
    try {
      const { labels = [] } = await axios($, {
        url:     `${BASE}/labels`,
        headers: { Authorization: `Bearer ${token}` },
      });

      const found = labels.find(l => l.name === 'IMPORTED');
      if (found) {
        importedLabelId = found.id;
        console.log('[code4/label] Found IMPORTED label:', importedLabelId);
      } else {
        const created = await axios($, {
          method:  'POST',
          url:     `${BASE}/labels`,
          headers: {
            Authorization:  `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          data: {
            name:                  'IMPORTED',
            labelListVisibility:   'labelShow',
            messageListVisibility: 'show',
          },
        });
        importedLabelId = created.id;
        console.log('[code4/label] Created IMPORTED label:', importedLabelId);
      }
    } catch (err) {
      // Non-fatal — we'll still star without the IMPORTED label
      console.warn('[code4/label] Could not get/create IMPORTED label:', err.message);
    }

    // ── Apply STARRED + IMPORTED to each email ────────────────────────────────
    const addLabelIds = ['STARRED'];
    if (importedLabelId) addLabelIds.push(importedLabelId);

    const marked = [];
    for (const messageId of emailIds) {
      try {
        await axios($, {
          method:  'POST',
          url:     `${BASE}/messages/${messageId}/modify`,
          headers: {
            Authorization:  `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          data: { addLabelIds, removeLabelIds: [] },
        });
        console.log(`[code4/label] Marked ${messageId} — labels: ${addLabelIds.join(', ')}`);
        marked.push(messageId);
      } catch (err) {
        console.warn(`[code4/label] Failed to mark ${messageId} (non-fatal):`, err.message);
      }
    }

    return { marked, labelIds: addLabelIds };
  },
});
