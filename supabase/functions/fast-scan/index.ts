// fast-scan — every-minute checks on stocks that are moving.
//  The 5-minute scans keep running. 2 minutes after each one, fast_promote() puts every stock that moved > 5¢ (under $10)
//  or >= 1% ($10+) since the previous scan on public.fast_watch; a stock leaves after 30 minutes without such a move.
//  This function runs every minute (4:00 AM – 8:00 PM ET, weekdays), prices the list from Yahoo and sends a Telegram
//  message ONLY when something happens (extended-hours price before / after the bell):
//   🚀 up:   under $10 +3% in 1 min or +6% in 5 min · $10+ +5% in 1 min or +10% in 5 min
//   🔻 down: −5% in 1 min or −10% in 5 min (any price)
//   📈/📉 new session high / low (pre-market, regular, after-hours) once the stock is >= 10% (under $10) / 5% ($10+) away from
//        the reference (previous close before / during the session, today's close after hours); re-sent only when the
//        high / low extends at least another 2%.
//  Junk filter: price >= $0.10 and >= $250K traded today. A stock is not re-sent within 5 minutes unless it is higher.
//  Telegram commands (from your chat only): STOP XYZ → no more alerts for XYZ (here and the 👀 / ⚡ spike alerts) until
//  START XYZ. Several tickers work too: STOP INHD, AKAN. The bot confirms each command.
//  mode "diag": checks the bot (webhook / another program already reading its messages) without reading any message.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const MIN_PRICE = 0.10, MIN_DOLLARS = 250_000;
const UP = (px: number) => px < 10 ? [0.03, 0.06] : [0.05, 0.10];   // [1 min, 5 min]
const DOWN = [0.05, 0.10], BIG = (px: number) => px < 10 ? 10 : 5, EXTEND = 0.02;

function etParts(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, mins: Number(p.hour) * 60 + Number(p.minute), wd: p.weekday };
}
async function yahooSession(): Promise<{ cookie: string; crumb: string } | null> {
  try {
    const home = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    const setCookie = home.headers.get('set-cookie') || '';
    try { await home.body?.cancel(); } catch (_) { /**/ }
    const cookie = setCookie.split(',').map(c => c.trim().split(';')[0]).filter(c => c.startsWith('A')).join('; ') || setCookie.split(';')[0];
    const res = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookie }, signal: AbortSignal.timeout(10_000) });
    const crumb = await res.text();
    return res.ok && crumb.length > 0 && crumb.length < 40 && !/\s/.test(crumb) ? { cookie, crumb } : null;
  } catch (_) { return null; }
}
const money = (v: number) => '$' + (v < 1 ? v.toFixed(4) : v.toFixed(2));

// Telegram — the token never leaves this function (errors are scrubbed).
async function tg(method: string, params: Record<string, unknown>): Promise<any> {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
  if (!token) return { ok: false, description: 'missing TELEGRAM_BOT_TOKEN' };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params), signal: AbortSignal.timeout(15_000) });
    return await r.json().catch(() => ({ ok: false, error_code: r.status }));
  } catch (e) { return { ok: false, description: String(e).split(token).join('***') }; }
}

async function commands(supa: any): Promise<number> {
  const chat = String(Deno.env.get('TELEGRAM_CHAT_ID') || '');
  const { data: st } = await supa.from('tg_state').select('key,val').in('key', ['tg_poll', 'tg_offset']);
  const s: Record<string, string> = Object.fromEntries((st || []).map((r: any) => [r.key, r.val]));
  if (s.tg_poll !== 'on' || !chat) return 0;
  const up = await tg('getUpdates', { offset: Number(s.tg_offset || 0), timeout: 0, allowed_updates: ['message', 'channel_post'] });
  if (!up.ok) return 0;
  let next = Number(s.tg_offset || 0), n = 0;
  for (const u of up.result || []) {
    next = Math.max(next, u.update_id + 1);
    const m = u.message || u.channel_post;
    if (!m || String(m.chat?.id) !== chat) continue;   // only your own chat can give commands
    const cmd = String(m.text || '').trim().match(/^\/?(stop|start)(?:@\w+)?\s+(.+)$/i);
    if (!cmd) continue;
    const syms = [...new Set(cmd[2].toUpperCase().split(/[\s,]+/).map(x => x.replace(/^\$/, '')).filter(x => /^[A-Z][A-Z.\-]{0,6}$/.test(x)))];
    if (!syms.length) continue;
    if (cmd[1].toLowerCase() === 'stop') {
      await supa.from('tg_mute').upsert(syms.map(symbol => ({ symbol })), { onConflict: 'symbol' });
      await tg('sendMessage', { chat_id: chat, text: `🔕 Stopped: ${syms.join(', ')} — no more alerts for ${syms.length > 1 ? 'these' : 'it'} until you send START ${syms.join(' ')}` });
    } else {
      await supa.from('tg_mute').delete().in('symbol', syms);
      await tg('sendMessage', { chat_id: chat, text: `🔔 Started again: ${syms.join(', ')}` });
    }
    n++;
  }
  if (next !== Number(s.tg_offset || 0)) await supa.from('tg_state').upsert({ key: 'tg_offset', val: String(next) }, { onConflict: 'key' });
  return n;
}

async function flush() {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  try { const r = await fetch(Deno.env.get('SUPABASE_URL')! + '/functions/v1/telegram-outbox', { method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(30_000) }); await r.text(); } catch (_) { /**/ }
}

Deno.serve(async (req: Request) => {
  try {
    const body = await req.json().catch(() => ({}));
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    if (body.mode === 'diag') {   // reads no messages: getUpdates with limit 1 and no offset confirms nothing
      const [me, wh, up] = await Promise.all([tg('getMe', {}), tg('getWebhookInfo', {}), tg('getUpdates', { limit: 1, timeout: 0 })]);
      return Response.json({ bot: me.ok ? '@' + me.result.username : me.description, webhook: wh.ok ? (wh.result.url ? 'SET' : 'none') : wh.description,
        pending: wh.result?.pending_update_count, poll: up.ok ? 'free' : `${up.error_code || ''} ${up.description || ''}`.trim(),
        chat_type: (up.result?.[0]?.message || up.result?.[0]?.channel_post)?.chat?.type || null });
    }

    const cmds = await commands(supa);
    const et = etParts();
    const open = et.wd !== 'Sat' && et.wd !== 'Sun' && et.mins >= 4 * 60 && et.mins <= 20 * 60;
    if (!open && !body.force) return Response.json({ cmds, skipped: 'outside 4 AM – 8 PM ET' });

    const [{ data: watch }, { data: mute }] = await Promise.all([supa.from('fast_watch').select('symbol').limit(1000), supa.from('tg_mute').select('symbol')]);
    const muted = new Set((mute || []).map((r: any) => r.symbol));
    const syms = (watch || []).map((r: any) => r.symbol).filter((s: string) => !muted.has(s));
    if (!syms.length) return Response.json({ cmds, on_list: 0 });

    const ys = await yahooSession();
    if (!ys) throw new Error('Yahoo session failed');
    const fields = 'symbol,regularMarketPrice,regularMarketChangePercent,regularMarketPreviousClose,regularMarketVolume,marketState,preMarketPrice,preMarketChangePercent,postMarketPrice,postMarketChangePercent';
    const now = new Date(), nowIso = now.toISOString();
    const q: Record<string, { px: number; pct: number | null; vol: number; sess: string; sk: string }> = {};
    await Promise.all(Array.from({ length: Math.ceil(syms.length / 100) }, async (_, i) => {
      try {
        const r = await fetch(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(syms.slice(i * 100, i * 100 + 100).join(','))}&fields=${fields}&crumb=${encodeURIComponent(ys.crumb)}`,
          { headers: { 'User-Agent': UA, Cookie: ys.cookie }, signal: AbortSignal.timeout(15_000) });
        const j = await r.json();
        for (const x of j?.quoteResponse?.result || []) {
          const st = String(x.marketState || '');
          const pre = st === 'PRE' && x.preMarketPrice != null, post = (st === 'POST' || st === 'POSTPOST') && x.postMarketPrice != null;
          const px = Number(pre ? x.preMarketPrice : post ? x.postMarketPrice : x.regularMarketPrice);
          if (!isFinite(px) || px <= 0) continue;
          q[x.symbol] = { px, pct: Number(pre ? x.preMarketChangePercent : post ? x.postMarketChangePercent : x.regularMarketChangePercent), vol: Number(x.regularMarketVolume) || 0,
            sess: pre ? ' pre-market' : post ? ' after-hours' : '', sk: pre ? 'pre' : post ? 'post' : (st === 'REGULAR' ? 'reg' : '') };
        }
      } catch (_) { /**/ }
    }));

    const got = Object.keys(q);
    const since = new Date(now.getTime() - 7 * 60_000).toISOString();
    const [{ data: ticks }, { data: recent }, { data: sessRows }] = await Promise.all([
      supa.from('fast_ticks').select('symbol,at,px').in('symbol', got).gte('at', since).limit(10000),
      supa.from('fast_alerts').select('symbol,at,px,kind').in('symbol', got).gte('at', new Date(now.getTime() - 5 * 60_000).toISOString()),
      supa.from('fast_session').select('*').in('symbol', got).eq('d', et.date)]);
    const sessMap: Record<string, any> = {};
    for (const r of sessRows || []) sessMap[`${r.symbol}:${r.sess}`] = r;
    const hist: Record<string, { t: number; px: number }[]> = {};
    for (const t of ticks || []) (hist[t.symbol] ||= []).push({ t: Date.parse(t.at), px: Number(t.px) });
    const lastUp: Record<string, number> = {}, lastDn: Record<string, number> = {};
    for (const a of recent || []) {
      if (String(a.kind).startsWith('dn')) lastDn[a.symbol] = Math.min(lastDn[a.symbol] ?? Infinity, Number(a.px));
      else if (!String(a.kind).startsWith('hi') && !String(a.kind).startsWith('lo')) lastUp[a.symbol] = Math.max(lastUp[a.symbol] || 0, Number(a.px));
    }
    const at = (s: string, agoMin: number) => {   // the tick closest to agoMin minutes ago (within ±40 s)
      const target = now.getTime() - agoMin * 60_000;
      const c = (hist[s] || []).filter(h => Math.abs(h.t - target) <= 40_000).sort((a, b) => Math.abs(a.t - target) - Math.abs(b.t - target))[0];
      return c ? c.px : null;
    };

    const msgs: string[] = [], alerts: any[] = [], keep: string[] = [], sessUp: any[] = [];
    for (const s of got) {
      const { px, pct, vol, sess, sk } = q[s];
      const p1 = at(s, 1), p5 = at(s, 5);
      if (p5 && ((px < 10 && Math.abs(px - p5) > 0.05) || (px >= 10 && Math.abs(px / p5 - 1) >= 0.01))) keep.push(s);   // still moving → stays on the list
      // session high / low (kept even when the junk filter skips the alert)
      const key = `${s}:${sk}`, ss = sk ? (sessMap[key] || { symbol: s, d: et.date, sess: sk, hi: px, lo: px, hi_sent: null, lo_sent: null }) : null;
      const newHi = ss && px > Number(ss.hi), newLo = ss && px < Number(ss.lo);
      if (ss) { ss.hi = Math.max(Number(ss.hi), px); ss.lo = Math.min(Number(ss.lo), px); ss.updated_at = nowIso; sessUp.push(ss); }
      if (px < MIN_PRICE || px * vol < MIN_DOLLARS) continue;
      const tail = `${pct != null && isFinite(pct) ? ` · ${pct >= 0 ? '+' : ''}${Math.round(pct)}% ${sk === 'post' ? 'vs close' : 'today'}` : ''}${sess}\nSTOP ${s} to mute`;
      const j1 = p1 ? px / p1 - 1 : 0, j5 = p5 ? px / p5 - 1 : 0, [u1, u5] = UP(px);
      let sent = false;
      if ((j1 >= u1 || j5 >= u5) && !(lastUp[s] && px <= lastUp[s])) {   // up: not re-sent within 5 min unless higher
        const in1 = j1 >= u1, mv = in1 ? j1 : j5, from = in1 ? p1! : p5!;
        msgs.push(`🚀 ${s} +${Math.round(mv * 100)}% in ${in1 ? '1 min' : '5 min'} · ${money(px)} (from ${money(from)})${tail}`);
        alerts.push({ symbol: s, px, kind: in1 ? '1m' : '5m', move_pct: Math.round(mv * 1000) / 10 }); sent = true;
      }
      if ((j1 <= -DOWN[0] || j5 <= -DOWN[1]) && !(lastDn[s] && px >= lastDn[s])) {   // down: not re-sent within 5 min unless lower
        const in1 = j1 <= -DOWN[0], mv = in1 ? j1 : j5, from = in1 ? p1! : p5!;
        msgs.push(`🔻 ${s} ${Math.round(mv * 100)}% in ${in1 ? '1 min' : '5 min'} · ${money(px)} (from ${money(from)})${tail}`);
        alerts.push({ symbol: s, px, kind: in1 ? 'dn1m' : 'dn5m', move_pct: Math.round(mv * 1000) / 10 }); sent = true;
      }
      // new session high / low once the stock is far enough from its reference (pct = Yahoo's change for this session)
      if (ss && !sent && pct != null && isFinite(pct) && Math.abs(pct) >= BIG(px)) {
        const label = sk === 'pre' ? 'pre-market' : sk === 'post' ? 'after-hours' : 'intraday';
        if (newHi && pct > 0 && (!ss.hi_sent || px >= Number(ss.hi_sent) * (1 + EXTEND))) {
          msgs.push(`📈 ${s} new ${label} high ${money(px)} · +${Math.round(pct)}% ${sk === 'post' ? 'vs close' : 'today'}\nSTOP ${s} to mute`);
          alerts.push({ symbol: s, px, kind: 'hi', move_pct: Math.round(pct * 10) / 10 }); ss.hi_sent = px;
        } else if (newLo && pct < 0 && (!ss.lo_sent || px <= Number(ss.lo_sent) * (1 - EXTEND))) {
          msgs.push(`📉 ${s} new ${label} low ${money(px)} · ${Math.round(pct)}% ${sk === 'post' ? 'vs close' : 'today'}\nSTOP ${s} to mute`);
          alerts.push({ symbol: s, px, kind: 'lo', move_pct: Math.round(pct * 10) / 10 }); ss.lo_sent = px;
        }
      }
    }
    if (sessUp.length) for (let i = 0; i < sessUp.length; i += 500) await supa.from('fast_session').upsert(sessUp.slice(i, i + 500), { onConflict: 'symbol,d,sess' });

    await supa.from('fast_ticks').insert(got.map(s => ({ symbol: s, at: nowIso, px: q[s].px, pct: isFinite(Number(q[s].pct)) ? q[s].pct : null })));
    await supa.from('fast_ticks').delete().lt('at', new Date(now.getTime() - 20 * 60_000).toISOString());
    if (keep.length) await supa.from('fast_watch').update({ last_move_at: nowIso }).in('symbol', keep);
    if (alerts.length) await supa.from('fast_alerts').insert(alerts);
    if (msgs.length) { await supa.from('telegram_outbox').insert(msgs.map(text => ({ text }))); await flush(); }
    return Response.json({ cmds, on_list: syms.length, priced: got.length, sent: msgs.length, muted: muted.size });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
});
