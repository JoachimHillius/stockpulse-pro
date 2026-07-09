// ─────────────────────────────────────────────────────────────────────────────
// Pipedream step: star_email   ← MUST BE THE LAST STEP
// Workflow: Scanner – XGPT+IRIS (4hillonline)
//
// Stars every email that produced newly-written tickers in parse_and_write.
// Uses the Schedule trigger architecture — steps.trigger.event has no email ID.
// Instead reads emailIds from steps.parse_and_write.$return_value.newTickerDetails.
//
// Non-fatal: a Gmail API failure is logged and never blocks prior steps.
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
      console.log('[star_email] No new tickers this run — nothing to star');
      return { starred: [] };
    }

    const token = this.gmail.$auth.oauth_access_token;
    const starred = [];

    for (const messageId of emailIds) {
      try {
        await axios($, {
          method: 'POST',
          url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`,
          headers: {
            Authorization:  `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          data: {
            addLabelIds:    ['STARRED'],
            removeLabelIds: [],
          },
        });
        console.log(`[star_email] Starred message ${messageId}`);
        starred.push(messageId);
      } catch (err) {
        console.warn(`[star_email] Failed to star ${messageId} (non-fatal):`, err.message);
      }
    }

    return { starred };
  },
});
