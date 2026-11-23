import { createClient } from 'npm:@supabase/supabase-js@2';

// Sends unsent rows from public.telegram_outbox to the configured chat (up to 25 per call, oldest first).
// The request body is ignored: only text already stored in the outbox (RLS-locked) can be sent.
// Optional per row: reply_markup (buttons, e.g. the RUNNER alert's Add to Watchlist / Ignore today) and parse_mode ('HTML' for bold / quote box).
Deno.serve(async () => {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
  const chatId = Deno.env.get('TELEGRAM_CHAT_ID');
  if (!token || !chatId) return Response.json({ status: 'skipped_no_secrets' });
  const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: rows, error } = await supa.from('telegram_outbox')
    .select('id, text, reply_markup, parse_mode').is('sent_at', null).is('status', null).order('id').limit(25);
  if (error) return Response.json({ status: 'db_error', error: error.message }, { status: 500 });
  const results: any[] = [];
  for (const r of rows || []) {
    // Claim the row first so an overlapping call can't send it twice.
    const { data: claimed } = await supa.from('telegram_outbox').update({ status: 'sending' })
      .eq('id', r.id).is('status', null).select('id');
    if (!claimed || !claimed.length) continue;
    let status = 'failed';
    const send = async (withFormat: boolean) => {
      const body: Record<string, unknown> = { chat_id: chatId, text: String(r.text).slice(0, 4000) };
      if (r.reply_markup) body.reply_markup = r.reply_markup;
      if (withFormat && r.parse_mode) body.parse_mode = r.parse_mode;
      if (!withFormat) body.text = String(r.text).replace(/<\/?(b|blockquote)>/g, '').slice(0, 4000);
      return await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
      });
    };
    try {
      let res = await send(true);
      if (!res.ok && res.status === 400 && r.parse_mode) { try { await res.body?.cancel(); } catch (_) { /**/ } res = await send(false); }   // formatting rejected → plain text
      status = res.ok ? 'sent' : `failed_http_${res.status}`;
      try { await res.body?.cancel(); } catch (_) { /**/ }
    } catch (e) {
      console.error('[telegram] send failed:', String(e).split(token).join('***').slice(0, 120));
    }
    await supa.from('telegram_outbox').update({ status, sent_at: status === 'sent' ? new Date().toISOString() : null }).eq('id', r.id);
    results.push({ id: r.id, status });
  }
  return Response.json({ results });
});
