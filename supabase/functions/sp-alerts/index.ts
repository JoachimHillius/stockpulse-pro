// sp-alerts — Telegram alerts for Single Pattern, headed "SINGLE PATTERN PENNY" or "SINGLE PATTERN LARGE".
//  mode "signals": new signals on the latest trading day (public.single_pattern). Run at 3:15 PM ET (candle forming —
//                  last-hour entry) and after the close (confirmed). One alert per signal, plus a short "confirmed" note.
//  mode "ext":     pre-market (4:00–9:30 AM ET) and after-hours (4:00–8:00 PM ET) movers among the Single Pattern stocks:
//                  signals, your added lists, and stocks close to the setup (sp_watch_universe()). Alert when the move vs the
//                  prior close reaches ±3% / 6% / 10% (Large) or ±10% / 20% / 40% (Penny), with extended-hours volume.
//  mode "test":    body.symbol (+ body.tier) — send one alert for an existing signal, marked TEST.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const LEVELS: Record<string, number[]> = { large: [3, 6, 10], penny: [10, 20, 40] };

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

function etParts(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, mins: Number(p.hour) * 60 + Number(p.minute), wd: p.weekday };
}
const money = (v: any) => v == null ? '—' : '$' + (Number(v) < 1 ? Number(v).toFixed(4) : Number(v).toFixed(2));
const fvol = (v: any) => { const n = Number(v) || 0; return n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(Math.round(n)); };
const mdy = (iso: string) => { const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1, d));
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dt.getUTCDay()] + ` ${m}/${d}`; };
const head = (tier: string) => tier === 'large' ? '🟣 SINGLE PATTERN LARGE' : '🟠 SINGLE PATTERN PENNY';
const arrows = (s: string) => s ? [...s.slice(0, -1)].map(c => c === 'U' ? '↑' : c === 'D' ? '↓' : '→').join('') + ' | ' + (s.slice(-1) === 'U' ? '↑' : s.slice(-1) === 'D' ? '↓' : '→') : '';

async function ctx(supa: any, syms: string[]) {
  const [n, d] = await Promise.all([
    supa.from('sp_news').select('symbol,verdict').in('symbol', syms),
    supa.from('sp_dilution').select('symbol,verdict,level').in('symbol', syms)]);
  const news: Record<string, string> = {}, dil: Record<string, string> = {};
  for (const r of n.data || []) news[r.symbol] = ({ good: 'Good 🟢', bad: 'Bad 🔴', check: 'Check 🟡', none: 'No news' } as any)[r.verdict] || '—';
  for (const r of d.data || []) dil[r.symbol] = r.verdict === 'risk' ? `RISK ${String(r.level || '').toUpperCase()} 🔴` : r.verdict === 'buyback' ? 'Buyback 🟢' : 'None';
  return (s: string) => `News: ${news[s] || 'not checked'} · Dilution: ${dil[s] || 'not checked'}`;
}

function signalText(r: any, note: string, nd: (s: string) => string) {
  return [head(r.tier), `$${r.symbol}${r.name ? ' · ' + String(r.name).split(' - ')[0].slice(0, 40) : ''}`,
    `Signal ${mdy(r.signal_date)} — ${note}`,
    `Entry (close) ${money(r.close)} · Target ${money(r.target)} (2× ATR10) · Stop: close below ${money(r.stop)}`,
    `Volume ${fvol(r.dollar_vol / r.close)} = ${Number(r.vol_x).toFixed(1)}× ${r.tier === 'large' ? '20' : '50'}-day avg`,
    `Days ${arrows(r.updown)} · RSI ${r.rsi_signal == null ? '—' : Math.round(r.rsi_signal)}`,
    `Latest ${money(r.last_close)} (${mdy(r.last_date)}) · ${r.status}`,
    nd(r.symbol)].join('\n');
}

async function flush(supa: any) {
  const url = Deno.env.get('SUPABASE_URL')! + '/functions/v1/telegram-outbox';
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  try { const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(30_000) }); await r.text(); } catch (_) { /**/ }
}

Deno.serve(async (req: Request) => {
  try {
    const body = await req.json().catch(() => ({}));
    const mode = String(body.mode || 'ext');
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const et = etParts();
    const out: string[] = [], logKeys: string[] = [];

    if (mode === 'test') {
      const q = supa.from('single_pattern').select('*').eq('symbol', String(body.symbol || '').toUpperCase());
      const { data } = body.tier ? await q.eq('tier', body.tier) : await q;
      const r = (data || [])[0];
      if (!r) return Response.json({ error: 'no signal for that symbol' }, { status: 404 });
      const nd = await ctx(supa, [r.symbol]);
      out.push('🧪 TEST ALERT\n' + signalText(r, 'confirmed at close', nd));
    }

    if (mode === 'signals') {
      const { data: rows } = await supa.from('single_pattern').select('*').order('vol_x', { ascending: false });
      const latest = (rows || []).reduce((m: string, r: any) => r.last_date > m ? r.last_date : m, '');
      const today = (rows || []).filter((r: any) => r.signal_date === latest);
      const keys = today.flatMap((r: any) => [`sig:${r.tier}:${r.symbol}:${r.signal_date}`, `sigc:${r.tier}:${r.symbol}:${r.signal_date}`]);
      const { data: sent } = keys.length ? await supa.from('sp_alert_log').select('key').in('key', keys) : { data: [] };
      const have = new Set((sent || []).map((x: any) => x.key));
      const closed = !(latest === et.date && et.mins < 16 * 60);
      const nd = await ctx(supa, today.map((r: any) => r.symbol));
      for (const r of today) {
        const k = `sig:${r.tier}:${r.symbol}:${r.signal_date}`, kc = `sigc:${r.tier}:${r.symbol}:${r.signal_date}`;
        if (!have.has(k)) {
          out.push(signalText(r, closed ? 'confirmed at close ✅' : 'forming today ⏳ candle not final — last-hour entry', nd));
          logKeys.push(k); if (closed) logKeys.push(kc);
        } else if (closed && !have.has(kc)) {
          out.push(`${head(r.tier)}\n$${r.symbol} ✅ confirmed at close ${mdy(r.signal_date)} · entry ${money(r.close)} · target ${money(r.target)} · stop: close below ${money(r.stop)}`);
          logKeys.push(kc);
        }
      }
    }

    if (mode === 'ext') {
      const wd = et.wd !== 'Sat' && et.wd !== 'Sun';
      const session = !wd ? null : (et.mins >= 4 * 60 && et.mins < 9 * 60 + 30) ? 'pre' : (et.mins >= 16 * 60 && et.mins <= 20 * 60) ? 'post' : null;
      if (!session && !body.force) return Response.json({ skipped: 'outside pre-market / after-hours' });
      const sess = (body.session as string) || session || 'pre';
      const { data: uni, error } = await supa.rpc('sp_watch_universe');
      if (error) throw new Error('universe: ' + error.message);
      const U: any[] = Array.isArray(uni) ? uni : [];
      const bySym: Record<string, any[]> = {};
      for (const u of U) (bySym[u.symbol] ||= []).push(u);
      const syms = Object.keys(bySym);
      const ys = await yahooSession();
      if (!ys) throw new Error('Yahoo session failed');
      const fields = 'symbol,regularMarketPrice,regularMarketPreviousClose,preMarketPrice,preMarketChangePercent,postMarketPrice,postMarketChangePercent,marketState';
      const quotes: Record<string, any> = {};
      for (let i = 0; i < syms.length; i += 100) {
        const batch = syms.slice(i, i + 100);
        try {
          const r = await fetch(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(batch.join(','))}&fields=${fields}&crumb=${encodeURIComponent(ys.crumb)}`,
            { headers: { 'User-Agent': UA, Cookie: ys.cookie }, signal: AbortSignal.timeout(15_000) });
          const j = await r.json();
          for (const q of j?.quoteResponse?.result || []) quotes[q.symbol] = q;
        } catch (_) { /**/ }
      }
      const hits: any[] = [];
      for (const s of syms) {
        const q = quotes[s]; if (!q) continue;
        const px = sess === 'pre' ? q.preMarketPrice : q.postMarketPrice;
        const pct = sess === 'pre' ? q.preMarketChangePercent : q.postMarketChangePercent;
        const ref = q.regularMarketPrice; // before the open = yesterday's close; after the close = today's close
        if (px == null || pct == null || !isFinite(pct)) continue;
        for (const u of bySym[s]) {
          const lv = LEVELS[u.tier].filter(l => Math.abs(pct) >= l).pop();
          if (!lv) continue;
          hits.push({ u, px, pct, ref, lv, key: `ext:${et.date}:${sess}:${u.tier}:${s}:${pct > 0 ? 'up' : 'dn'}:${lv}` });
        }
      }
      const { data: sent } = hits.length ? await supa.from('sp_alert_log').select('key').in('key', hits.map(h => h.key)) : { data: [] };
      const have = new Set((sent || []).map((x: any) => x.key));
      const fresh = hits.filter(h => !have.has(h.key)).slice(0, 25);
      const nd = await ctx(supa, fresh.map(h => h.u.symbol));
      for (const h of fresh) {
        let xv: number | null = null;
        try {
          const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(h.u.symbol)}?range=1d&interval=5m&includePrePost=true`,
            { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) });
          const j = await r.json(); const res = j?.chart?.result?.[0];
          const per = res?.meta?.currentTradingPeriod?.[sess];
          const ts: number[] = res?.timestamp || [], vol: number[] = res?.indicators?.quote?.[0]?.volume || [];
          if (per) xv = ts.reduce((sum, t, i) => (t >= per.start && t < per.end ? sum + (vol[i] || 0) : sum), 0);
        } catch (_) { /**/ }
        const u = h.u;
        const status = u.kind === 'signal' ? `Signal ${mdy(u.signal_date)} · entry ${money(u.entry)} · target ${money(u.target)} · stop: close below ${money(u.stop)}`
          : u.kind === 'added' ? 'Your added stock'
          : `Setting up: ${u.streak} down days in a row (${u.tier === 'large' ? '5' : '3'} needed, then the candle)`;
        const volLine = xv == null ? `${sess === 'pre' ? 'Pre-market' : 'After-hours'} volume: n/a`
          : `${sess === 'pre' ? 'Pre-market' : 'After-hours'} volume ${fvol(xv)}${u.av20 ? ` = ${Math.round(xv / u.av20 * 100)}% of a normal day (${fvol(u.av20)} avg)` : ''}${u.av20 && xv >= 0.1 * u.av20 ? ' 🔥' : ''}`;
        out.push([`${head(u.tier)} · ${sess === 'pre' ? '🌅 PRE-MARKET' : '🌙 AFTER-HOURS'}`,
          `$${u.symbol} ${h.pct > 0 ? '▲' : '▼'} ${h.pct > 0 ? '+' : ''}${h.pct.toFixed(1)}% at ${money(h.px)} (${sess === 'pre' ? 'prev close' : 'today\'s close'} ${money(h.ref)})`,
          volLine, status, nd(u.symbol)].join('\n'));
        logKeys.push(h.key);
      }
    }

    if (out.length) {
      const { error } = await supa.from('telegram_outbox').insert(out.map(text => ({ text })));
      if (error) throw new Error('outbox: ' + error.message);
      if (logKeys.length) await supa.from('sp_alert_log').upsert(logKeys.map(key => ({ key })), { onConflict: 'key', ignoreDuplicates: true });
      await flush(supa);
    }
    return Response.json({ mode, sent: out.length, preview: out.slice(0, 2) });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
});
