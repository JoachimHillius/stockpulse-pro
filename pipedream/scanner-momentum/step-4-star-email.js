// ─────────────────────────────────────────────────────────────────────────────
// Pipedream step: star_email   ← MUST BE THE LAST STEP
// Workflow: Scanner – Momentum (evolutionx4u)
//
// Identical to the XGPT+IRIS version — see pipedream/scanner-xgpt-iris/step-4-star-email.js
// for full setup instructions.
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
    const messageId = steps.trigger.event.id;

    if (!messageId) {
      console.warn('[star_email] No message ID on trigger event — skipping');
      return { starred: false, reason: 'no_message_id' };
    }

    try {
      await axios($, {
        method: 'POST',
        url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`,
        headers: {
          Authorization: `Bearer ${this.gmail.$auth.oauth_access_token}`,
          'Content-Type': 'application/json',
        },
        data: {
          addLabelIds:    ['STARRED'],
          removeLabelIds: [],
        },
      });

      console.log(`[star_email] Starred message ${messageId}`);
      return { starred: true, messageId };

    } catch (err) {
      console.warn('[star_email] Failed to star email (non-fatal):', err.message);
      return { starred: false, error: err.message, messageId };
    }
  },
});
