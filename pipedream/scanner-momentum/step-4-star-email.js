// ─────────────────────────────────────────────────────────────────────────────
// Pipedream step: star_email   ← MUST BE THE LAST STEP
// Workflow: Scanner – Momentum (evolutionx4u)
//
// Identical to scanner-xgpt-iris/step-4-star-email.js — see that file for
// full inline documentation.
//
// Runs ONLY when parse_and_write wrote new tickers (newTickerDetails.length > 0).
// For each email that produced new tickers:
//   - Applies STARRED label  → shows as red follow-up flag in Outlook
//   - Applies IMPORTED label → in-Gmail visibility; also used by search_gmail
//     step-1 to SKIP already-processed emails on future runs (-label:IMPORTED)
//
// Connected account: same Gmail account as step-2 (search_gmail).
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
    const details  = steps.parse_and_write.$return_value?.newTickerDetails || [];
    const emailIds = [...new Set(details.map(d => d.emailId))];

    if (emailIds.length === 0) {
      console.log('[star_email] No new tickers this run — skipping (promo or all dupes)');
      return { marked: [] };
    }

    const token = this.gmail.$auth.oauth_access_token;
    const BASE  = 'https://gmail.googleapis.com/gmail/v1/users/me';

    // ── Get or create the IMPORTED label ─────────────────────────────────────
    let importedLabelId = null;
    try {
      const { labels = [] } = await axios($, {
        url:     `${BASE}/labels`,
        headers: { Authorization: `Bearer ${token}` },
      });

      const existing = labels.find(l => l.name === 'IMPORTED');
      if (existing) {
        importedLabelId = existing.id;
        console.log('[star_email] Found IMPORTED label:', importedLabelId);
      } else {
        const created = await axios($, {
          method: 'POST',
          url:    `${BASE}/labels`,
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
        console.log('[star_email] Created IMPORTED label:', importedLabelId);
      }
    } catch (err) {
      console.warn('[star_email] Could not get/create IMPORTED label:', err.message);
    }

    // ── Apply STARRED + IMPORTED to each processed email ─────────────────────
    const addLabelIds = ['STARRED'];
    if (importedLabelId) addLabelIds.push(importedLabelId);

    const marked = [];
    for (const messageId of emailIds) {
      try {
        await axios($, {
          method: 'POST',
          url:    `${BASE}/messages/${messageId}/modify`,
          headers: {
            Authorization:  `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          data: { addLabelIds, removeLabelIds: [] },
        });
        console.log(`[star_email] Marked ${messageId} — labels: ${addLabelIds.join(', ')}`);
        marked.push(messageId);
      } catch (err) {
        console.warn(`[star_email] Failed to mark ${messageId} (non-fatal):`, err.message);
      }
    }

    return { marked, labelIds: addLabelIds };
  },
});
