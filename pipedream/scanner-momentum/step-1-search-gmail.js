// ─────────────────────────────────────────────────────────────────────────────
// Pipedream step: search_gmail
// Workflow: Scanner – Momentum (evolutionx4u)
//
// TRIGGER: Schedule — every hour
//   (Delete the Gmail "New Email Received" trigger; add a Schedule trigger)
//
// Searches Gmail for Momentum / Trade Alert emails in the last 24 hours.
// -label:IMPORTED skips emails already processed in a prior run, so repeat
// runs are safe and never reprocess.
//
// Connected accounts: connect the Gmail account that receives these emails.
//
// Returns: { messages: [{id, subject, from, body}] }
//   Empty array → parse_and_write exits immediately; no DB writes, no Telegram.
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
    const token = this.gmail.$auth.oauth_access_token;
    const BASE  = 'https://gmail.googleapis.com/gmail/v1/users/me';

    const QUERY = '(from:moneyandmarkets.com OR subject:"Trade Alert" OR subject:"10X") newer_than:1d -label:IMPORTED';

    // ── 1. Collect matching message IDs (paginated) ───────────────────────────
    const msgIds = [];
    let pageToken;
    do {
      const params = new URLSearchParams({ q: QUERY, maxResults: '100' });
      if (pageToken) params.set('pageToken', pageToken);

      const list = await axios($, {
        url:     `${BASE}/messages?${params}`,
        headers: { Authorization: `Bearer ${token}` },
      });

      (list.messages || []).forEach(m => msgIds.push(m.id));
      pageToken = list.nextPageToken;
    } while (pageToken);

    if (msgIds.length === 0) {
      console.log('[search_gmail] No unimported Momentum emails in last 24h');
      return { messages: [] };
    }

    console.log(`[search_gmail] ${msgIds.length} candidate message(s) to fetch`);

    // ── Helpers ───────────────────────────────────────────────────────────────
    const decode = (b64) =>
      Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');

    function extractBody(payload) {
      if (!payload) return '';
      if (payload.body?.data) return decode(payload.body.data);
      const parts = payload.parts || [];
      for (const part of parts) {
        if (part.mimeType === 'text/plain' && part.body?.data) return decode(part.body.data);
        const nested = extractBody(part);
        if (nested) return nested;
      }
      for (const part of parts) {
        if (part.mimeType === 'text/html' && part.body?.data) {
          return decode(part.body.data)
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/p>/gi, '\n')
            .replace(/<\/div>/gi, '\n')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>');
        }
      }
      return '';
    }

    const header = (msg, name) =>
      (msg.payload?.headers || []).find(
        h => h.name.toLowerCase() === name.toLowerCase()
      )?.value || '';

    // ── 2. Fetch each message; route-check; return keepers ───────────────────
    const messages = [];
    for (const id of msgIds) {
      try {
        const msg = await axios($, {
          url:     `${BASE}/messages/${id}?format=full`,
          headers: { Authorization: `Bearer ${token}` },
        });

        const subject = header(msg, 'Subject');
        const from    = header(msg, 'From').toLowerCase();
        const body    = extractBody(msg.payload);

        // Route-check: confirm this is actually a Momentum / Trade Alert email
        const isMomentum =
          from.includes('moneyandmarkets.com') ||
          /trade\s*alert|10x/i.test(subject);

        if (!isMomentum) {
          console.log(`[search_gmail] Skip id=${id} — route-check failed (from=${from}, subject=${subject})`);
          continue;
        }

        messages.push({ id, subject, from, body });
        console.log(`[search_gmail] Queued id=${id} subject="${subject}"`);
      } catch (err) {
        console.warn(`[search_gmail] Failed to fetch ${id}:`, err.message);
      }
    }

    console.log(`[search_gmail] Returning ${messages.length} message(s) for parse_and_write`);
    return { messages };
  },
});
