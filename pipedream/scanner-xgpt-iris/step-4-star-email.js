// ─────────────────────────────────────────────────────────────────────────────
// Pipedream step: star_email   ← MUST BE THE LAST STEP
// Workflow: Scanner – XGPT+IRIS (4hillonline)
//
// REPLACES the built-in "add_label_to_email" action entirely.
// Use a CODE step (not the pre-built Gmail action) so we can wrap in try/catch.
// A label failure must NEVER prevent earlier steps (DB write, Telegram) from
// completing — this step just silently logs and returns if the Gmail API call
// fails.
//
// How to add in Pipedream:
//   1. Delete (or disable) the existing "add_label_to_email" step.
//   2. Click "+ Add step" → "Run custom code" → Node.js.
//   3. In the step's "Connected accounts" section connect your Gmail account
//      (same one already connected to the trigger).
//   4. Paste this entire file into the code editor.
//   5. Rename the step to "star_email" and drag it to be the LAST step.
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
      // Non-fatal — log and move on. The DB write already succeeded.
      console.warn('[star_email] Failed to star email (non-fatal):', err.message);
      return { starred: false, error: err.message, messageId };
    }
  },
});
