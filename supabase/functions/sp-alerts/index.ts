// sp-alerts — Telegram alerts for Single Pattern, headed "SINGLE PATTERN PENNY" or "SINGLE PATTERN LARGE".
//  mode "signals": new signals on the latest trading day (public.single_pattern). Run at 3:15 PM ET (candle forming —
//                  last-hour entry) and after the close (confirmed). One alert per signal, plus a short "confirmed" note.
//  mode "ext":     pre-market (4:00–9:30 AM ET) and after-hours (4:00–8:00 PM ET) movers among the Single Pattern stocks:
//                  signals, your added lists, and stocks close to the setup (sp_watch_universe()). Alert when the move vs the
//                  prior close reaches ±3% / 6% / 10% (Large) or ±10% / 20% / 40% (Penny), with extended-hours volume.
//  mode "live":    2:30–4:00 PM ET. Stocks whose prior days already fit (sp_live_candidates(): Large 5+ down days, Penny 3+)
//                  get today's candle checked from a fresh Yahoo quote. First time it qualifies → "⏳ FORMING" alert;
//                  when it changes (doji ↔ NEAR ↔ no longer qualifies, or volume crosses its average) → "🔄 UPDATE".
//  Large alerts show the candle body % (rule ≤ 10%); NEAR = every Large rule met except the doji: body up to 30% on a red
//  candle, 20% on a green one, and not up 3%+ on the day. Stocks with a signal the day before are follow-throughs, not setups.
//  Every alert shows Options flow (last date in your Options Flow uploads + contracts that day, or none).
//  Every run with alerts also sends a PDF with ALL alerts of that run. More than 5: only the first 5 go out as messages,
//  then one "📎 +N more" message (Telegram sendDocument, TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID secrets).
//  TOTAL list: one PDF of EVERYTHING for the trading day — every stock from the last-hour checks (with Hits), the signals
//  confirmed at the close, and after-hours / next-morning pre-market movers (pre-market belongs to the prior day's list).
//  mode "total" sends it at 4:30 PM ET; after that every after-hours, confirmation or pre-market run resends the FULL list
//  (new stocks marked *) instead of a PDF of just that run.
//  mode "test":    body.symbol (+ body.tier) — send one alert for an existing signal, marked TEST.
//  mode "spread":  options bid-ask spread → public.sp_opt_spread, every 15 min in market hours (body.symbols, or signals +
//                  NEAR + your added stocks + today's live hits). Contract = ATM call (strike nearest the price), first
//                  expiry 5+ days out. Spread = ask − bid, % of the mid: green ≤ 10%, yellow 10–20%, red > 20% (too wide).
//                  No live bid/ask (outside market hours) → the last good value is kept. Live + signals runs refresh first.
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

async function refreshSpreads(supa: any, symsIn: string[], ysIn: { cookie: string; crumb: string } | null = null): Promise<{ ok: number; other: number }> {
  const syms = [...new Set(symsIn.filter(Boolean))];
  const res = { ok: 0, other: 0 };
  if (!syms.length) return res;
  const ys = ysIn || await yahooSession();
  if (!ys) return res;
  const [{ data: optRows }, { data: prevRows }] = await Promise.all([
    supa.from('optionable_symbols').select('symbol').in('symbol', syms),
    supa.from('sp_opt_spread').select('symbol,status').in('symbol', syms)]);
  const optable = new Set((optRows || []).map((r: any) => r.symbol));
  const prevOk = new Set((prevRows || []).filter((r: any) => r.status === 'ok').map((r: any) => r.symbol));
  const chain = async (s: string, q: string): Promise<any> => {
    const r = await fetch(`https://query1.finance.yahoo.com/v7/finance/options/${encodeURIComponent(s.replace('.', '-'))}?${q}crumb=${encodeURIComponent(ys.crumb)}`,
      { headers: { 'User-Agent': UA, Cookie: ys.cookie }, signal: AbortSignal.timeout(12_000) });
    if (r.status === 404) { try { await r.body?.cancel(); } catch (_) { /**/ } return 'none'; }
    if (!r.ok) { try { await r.body?.cancel(); } catch (_) { /**/ } return null; }
    return (await r.json())?.optionChain?.result?.[0] ?? 'none';
  };
  const today = etParts().date.split('-').map(Number);
  const minExp = Date.UTC(today[0], today[1] - 1, today[2]) / 1000 + 5 * 86400;   // expiries are stamped 00:00 UTC of the date
  const rows: any[] = [];
  const one = async (s: string) => {
    const now = new Date().toISOString();
    if (!optable.has(s)) { rows.push({ symbol: s, status: 'none', checked_at: now }); return; }
    try {
      let r = await chain(s, '');
      if (r === 'none') { rows.push({ symbol: s, status: 'none', checked_at: now }); return; }
      if (!r) throw new Error('fetch');
      const exps: number[] = r.expirationDates || [];
      const exp = exps.find(e => e >= minExp) ?? exps[exps.length - 1];
      if (!exp) { rows.push({ symbol: s, status: 'none', checked_at: now }); return; }
      if (r.options?.[0]?.expirationDate !== exp) { r = await chain(s, `date=${exp}&`); if (!r || r === 'none') throw new Error('fetch'); }
      const px = Number(r.quote?.regularMarketPrice);
      const calls: any[] = r.options?.[0]?.calls || [];
      if (!calls.length || !isFinite(px)) throw new Error('empty');
      const c = calls.reduce((a, b) => Math.abs(Number(b.strike) - px) < Math.abs(Number(a.strike) - px) ? b : a);
      const bid = Number(c.bid) || 0, ask = Number(c.ask) || 0;
      const base = { symbol: s, expiry: new Date(exp * 1000).toISOString().slice(0, 10), strike: Number(c.strike), bid, ask,
        oi: Number(c.openInterest) || 0, vol: Number(c.volume) || 0, price: px, checked_at: now };
      if (bid > 0 && ask >= bid) rows.push({ ...base, status: 'ok', spread: Math.round((ask - bid) * 100) / 100, pct: Math.round((ask - bid) / ((ask + bid) / 2) * 1000) / 10 });
      else if (!prevOk.has(s)) rows.push({ ...base, status: 'nobid', spread: null, pct: null });   // keep the last good value
    } catch (_) { if (!prevOk.has(s)) rows.push({ symbol: s, status: 'error', checked_at: now }); }
  };
  let i = 0;
  await Promise.all(Array.from({ length: 6 }, async () => { while (i < syms.length) await one(syms[i++]); }));
  for (let k = 0; k < rows.length; k += 200) await supa.from('sp_opt_spread').upsert(rows.slice(k, k + 200), { onConflict: 'symbol' });
  for (const r of rows) r.status === 'ok' ? res.ok++ : res.other++;
  return res;
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

type Raw = Record<string, { n: string; d: string; o?: string; s?: string; sp?: number | null }>;
// Today's running volume (pre-market + regular + after-hours) from fast-scan mode "vol" → public.vol_accum.
async function volFresh(syms: string[]): Promise<Record<string, any>> {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, url = Deno.env.get('SUPABASE_URL')! + '/functions/v1/fast-scan';
  const uniq = [...new Set(syms)].slice(0, 60), out: Record<string, any> = {};
  await Promise.all(Array.from({ length: Math.ceil(uniq.length / 10) }, async (_, i) => {
    try { const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'vol', symbols: uniq.slice(i * 10, i * 10 + 10) }), signal: AbortSignal.timeout(40_000) });
      Object.assign(out, await r.json()); } catch (_) { /**/ }
  }));
  return out;
}
async function ctx(supa: any, syms: string[]): Promise<((s: string) => string) & { raw: Raw; vacc: Record<string, any> }> {
  const [n, d, of, sp, va] = await Promise.all([
    supa.from('sp_news').select('symbol,verdict').in('symbol', syms),
    supa.from('sp_dilution').select('symbol,verdict,level').in('symbol', syms),
    supa.rpc('sp_options_flow', { p_syms: syms }),
    supa.from('sp_opt_spread').select('*').in('symbol', syms),
    supa.from('vol_accum').select('*').in('symbol', syms).gte('updated_at', new Date(Date.now() - 20 * 60_000).toISOString())]);
  const vacc: Record<string, any> = {};
  for (const r of va?.data || []) vacc[r.symbol] = r;
  const volLine = (s: string) => { const a = vacc[s]; if (!a || !a.prev_vol) return '';
    return `\n📊 Volume today ${fvol(Number(a.today_vol))}${a.pre_vol && Number(a.today_vol) !== Number(a.pre_vol) ? ` (pre-market ${fvol(Number(a.pre_vol))})` : a.pre_vol ? ' pre-market' : ''}${a.post_vol ? ` (after-hours ${fvol(Number(a.post_vol))})` : ''} = ${Math.round(Number(a.today_vol) / Number(a.prev_vol) * 100)}% of yesterday's ${fvol(Number(a.prev_vol))}`; };
  const spr: Record<string, any> = {};
  for (const r of sp?.data || []) spr[r.symbol] = r;
  const flow: Record<string, any> = of?.data || {};
  const news: Record<string, string> = {}, dil: Record<string, string> = {};
  for (const r of n.data || []) news[r.symbol] = ({ good: 'Good 🟢', bad: 'Bad 🔴', check: 'Check 🟡', none: 'No news' } as any)[r.verdict] || '—';
  for (const r of d.data || []) dil[r.symbol] = r.verdict === 'risk' ? `RISK ${String(r.level || '').toUpperCase()} 🔴` : r.verdict === 'buyback' ? 'Buyback 🟢' : 'None';
  const raw: Raw = {};
  for (const r of n.data || []) (raw[r.symbol] ||= { n: '', d: '' }).n = ({ good: 'Good', bad: 'Bad', check: 'Check', none: 'No news' } as any)[r.verdict] || '';
  for (const r of d.data || []) (raw[r.symbol] ||= { n: '', d: '' }).d = r.verdict === 'risk' ? `Risk ${r.level || ''}`.trim() : r.verdict === 'buyback' ? 'Buyback' : r.verdict === 'nodata' ? 'n/a' : 'None';
  // Options flow = your Options Flow uploads (omen_flow): last date with flow + contracts that day
  for (const s of syms) { const f = flow[s]; (raw[s] ||= { n: '', d: '' }).o = f ? `${Number(String(f.d).slice(5, 7))}/${Number(String(f.d).slice(8, 10))} ${fvol(f.contracts || 0)}` : 'No'; }
  // Options spread (ATM call ~1 week out): "$0.05 10%" / No (no listed options) / n/a (no live bid-ask)
  for (const s of syms) { const x = spr[s], o = (raw[s] ||= { n: '', d: '' });
    o.s = !x ? '-' : x.status === 'none' ? 'No' : x.status !== 'ok' ? 'n/a' : `$${Number(x.spread).toFixed(2)} ${Number(x.pct) < 10 ? Number(x.pct).toFixed(1) : Math.round(Number(x.pct))}%`;
    o.sp = x && x.status === 'ok' ? Number(x.pct) : null; }
  const sprLine = (s: string) => { const x = spr[s];
    if (!x) return 'Options spread: not checked yet';
    if (x.status === 'none') return 'Options spread: no listed options';
    if (x.status !== 'ok') return 'Options spread: n/a (no live bid/ask)';
    const pct = Number(x.pct), k = Number(x.strike);
    return `Options spread: ${mdy(x.expiry)} $${Number.isInteger(k) ? k : k.toFixed(2)} call · bid ${Number(x.bid).toFixed(2)} / ask ${Number(x.ask).toFixed(2)} = $${Number(x.spread).toFixed(2)} (${pct.toFixed(1)}%) ${pct <= 10 ? '🟢' : pct <= 20 ? '🟡' : '🔴 too wide'}`; };
  const flowLine = (s: string) => { const f = flow[s]; if (!f) return 'Options flow: none on file';
    const parts = [f.calls ? `${fvol(f.calls)} calls` : '', f.puts ? `${fvol(f.puts)} puts` : ''].filter(Boolean).join(' / ');
    return `Options flow: last ${mdy(f.d)} · ${fvol(f.contracts || 0)} contracts${parts ? ` (${parts})` : ''}`; };
  return Object.assign((s: string) => `News: ${news[s] || 'not checked'} · Dilution: ${dil[s] || 'not checked'}\n${flowLine(s)}\n${sprLine(s)}${volLine(s)}`, { raw, vacc });
}

function statusLine(r: any) {
  if (r.status === 'target hit') return `Status: Target hit ${r.target_date ? mdy(r.target_date) : ''} ✅`;
  if (r.status === 'stop hit') return `Status: Stop hit ${r.stop_date ? mdy(r.stop_date) : ''} ❌`;
  const now = r.since_pct == null ? '' : ` · now ${Number(r.since_pct) >= 0 ? '+' : ''}${r.since_pct}%`;
  const best = r.best_pct == null ? '' : ` · best ${Number(r.best_pct) >= 0 ? '+' : ''}${r.best_pct}% on ${mdy(r.best_date)}`;
  return `Status: ${r.status === 'working' ? 'Working (new signal)' : 'Open'}${now}${best}`;
}
function candleLine(r: any) {
  if (r.tier !== 'large' || r.body_pct == null) return null;
  return r.near ? `⚠️ NEAR — candle body ${Math.round(r.body_pct)}% of the day's range (rule ≤ 10%) · all other rules met`
                : `Candle body ${Number(r.body_pct).toFixed(1)}% of the day's range (rule ≤ 10%) ✅`;
}
function signalText(r: any, note: string, nd: (s: string) => string) {
  return [head(r.tier) + (r.near ? ' · NEAR' : ''), `$${r.symbol}${r.name ? ' · ' + String(r.name).split(' - ')[0].slice(0, 40) : ''}`,
    `Signal ${mdy(r.signal_date)} — ${note}`, candleLine(r),
    `Entry (close) ${money(r.close)} · Target ${money(r.target)} (2× ATR10) · Stop: close below ${money(r.stop)}`,
    `Volume ${fvol(r.dollar_vol / r.close)} = ${Number(r.vol_x).toFixed(1)}× ${r.tier === 'large' ? '20' : '50'}-day avg`,
    `Days ${arrows(r.updown)} · RSI ${r.rsi_signal == null ? '—' : Math.round(r.rsi_signal)}`,
    `Latest ${money(r.last_close)} (${mdy(r.last_date)})`, statusLine(r),
    nd(r.symbol)].filter(Boolean).join('\n');
}

// Minimal dependency-free PDF (Helvetica, Letter). PDF base fonts are Latin-1 only, so emojis / arrows become words.
function pdfSafe(t: string): string {
  const map: Record<string, string> = { '↑': 'up', '↓': 'dn', '→': '>', '≤': '<=', '≥': '>=', '×': 'x', '—': '-', '–': '-', '’': "'", '▲': 'UP', '▼': 'DOWN',
    '✅': '[OK]', '❌': '[X]', '⚠️': '[!]', '⚠': '[!]', '⏳': '[...]', '🔄': '', '🔥': '[HOT]', '🟢': '(green)', '🔴': '(red)', '🟡': '(yellow)',
    '🟣': '', '🟠': '', '🌅': '', '🌙': '', '🧪': '', '📎': '' };
  let o = '';
  for (const ch of t) { if (map[ch] !== undefined) o += map[ch]; else { const c = ch.codePointAt(0)!; if (c >= 32 && c <= 126) o += ch; else if (c === 183) o += '-'; else if (c === 0xFE0F) o += ''; } }
  return o.replace(/\s+$/, '');
}
// Landscape table PDF: one section per tier (PENNY, then LARGE), one row per alert.
const COLS_STD: [string, number, string][] = [   // header, width, key
  ['Ticker', 44, 'sym'], ['Alert', 70, 'status'], ['Price', 46, 'price'], ['Chg', 38, 'chg'], ['High', 42, 'high'], ['Low', 42, 'low'],
  ['Volume', 44, 'vol'], ['Vol x Avg', 46, 'volX'], ['Down', 30, 'down'], ['Body', 32, 'body'], ['Target', 46, 'target'], ['Stop', 46, 'stop'],
  ['News', 42, 'news'], ['Dilution', 48, 'dil'], ['Options', 48, 'opt'], ['Spread', 44, 'spr']];
// running (live) list: Hits + Now up front, a shorter Alert column
const COLS_LIVE: [string, number, string][] = [
  ['Ticker', 40, 'sym'], ['Hits', 32, 'hits'], ['Now', 38, 'now'], ['Candle', 62, 'status'], ['Price', 44, 'price'], ['Chg', 32, 'chg'], ['High', 36, 'high'], ['Low', 36, 'low'],
  ['Volume', 38, 'vol'], ['Vol x Avg', 46, 'volX'], ['Down', 26, 'down'], ['Target', 40, 'target'], ['Stop', 40, 'stop'], ['News', 38, 'news'], ['Dilution', 46, 'dil'], ['Options', 44, 'opt'], ['Spread', 42, 'spr'], ['Last', 32, 'at']];
// TOTAL list: like the running list, without High/Low, plus Ext = after-hours / pre-market move
const COLS_TOTAL: [string, number, string][] = [
  ['Ticker', 40, 'sym'], ['Hits', 32, 'hits'], ['Final', 40, 'now'], ['Candle', 66, 'status'], ['Price', 44, 'price'], ['Chg', 32, 'chg'],
  ['Volume', 38, 'vol'], ['Vol x Avg', 46, 'volX'], ['Down', 26, 'down'], ['Target', 40, 'target'], ['Stop', 40, 'stop'], ['News', 38, 'news'],
  ['Dilution', 46, 'dil'], ['Options', 44, 'opt'], ['Spread', 42, 'spr'], ['Ext', 54, 'ext'], ['Last', 32, 'at']];
function cellText(r: any, k: string): string {
  const m = (v: any) => v == null || !isFinite(Number(v)) ? '-' : '$' + (Number(v) < 1 ? Number(v).toFixed(4) : Number(v).toFixed(2));
  switch (k) {
    case 'price': case 'high': case 'low': case 'target': case 'stop': return m(r[k]);
    case 'chg': return r.chg == null ? '-' : `${r.chg >= 0 ? '+' : ''}${Number(r.chg).toFixed(1)}%`;
    case 'vol': return r.vol == null ? '-' : fvol(r.vol);
    case 'volX': { const x = r.volX ?? (r.volPct == null ? null : r.volPct / 100); return x == null ? '-' : `${Number(x).toFixed(1)}x ${r.avgDays ? r.avgDays + 'd' : ''}`.trim(); }
    case 'hits': return r.hits == null ? '-' : `${r.hits} of ${r.runs}`;
    case 'sym': return (r.isNew ? '*' : '') + (r.sym || '-');
    case 'down': return r.down == null ? '-' : String(r.down);
    case 'body': return r.body == null ? '-' : `${Number(r.body).toFixed(r.body < 10 ? 1 : 0)}%`;
    default: return pdfSafe(String(r[k] ?? '-')) || '-';
  }
}
function cellColor(r: any, k: string): string | null {
  const G = '0 0.5 0.2', R = '0.8 0.1 0.1', Y = '0.7 0.45 0';
  if (k === 'news') return r.news === 'Good' ? G : r.news === 'Bad' ? R : r.news === 'Check' ? Y : null;
  if (k === 'dil') return /^Risk/.test(r.dil || '') ? R : r.dil === 'Buyback' ? G : null;
  if (k === 'volX') return (r.volX ?? (r.volPct == null ? 0 : r.volPct / 100)) >= 1 ? G : null;
  if (k === 'opt') return r.opt && r.opt !== 'No' ? G : null;
  if (k === 'spr') return r.sprPct == null ? null : r.sprPct <= 10 ? G : r.sprPct <= 20 ? Y : R;
  if (k === 'ext') return !r.extPct ? null : r.extPct > 0 ? G : R;
  if (k === 'now') return r.now === 'YES' || r.now === 'CLOSE' ? G : r.now === 'NEAR' || r.now === 'CLOSE NEAR' ? Y : r.now === 'dropped' ? R : null;
  if (k === 'hits') return r.hits >= 3 ? G : null;
  if (k === 'chg') return r.chg == null ? null : r.chg >= 0 ? G : R;
  if (k === 'status') return /no longer|\[X\]/i.test(r.status || '') ? R : /NEAR/.test(r.status || '') ? Y : null;
  return null;
}
function makePdf(title: string, rows: any[], kind: boolean | 'total' = false): Uint8Array {
  const live = kind === true;
  const COLS = kind === 'total' ? COLS_TOTAL : live ? COLS_LIVE : COLS_STD;
  const W = 792, H = 612, M = 40, RH = 14;
  const esc = (t: string) => t.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const fit = (t: string, w: number) => { const max = Math.floor(w / 3.9); return t.length > max ? t.slice(0, max - 1) + '.' : t; };
  const pagesOps: string[] = []; let ops = ''; let y = 0; let page = 0;
  const newPage = () => { if (ops) pagesOps.push(ops); page++; ops = ''; y = H - M;
    ops += `BT /F2 12 Tf ${M} ${y} Td (${esc(pdfSafe(title))}) Tj ET\n`; y -= 22; };
  const header = () => {
    ops += `0.88 0.9 0.94 rg ${M} ${y - 4} ${COLS.reduce((a, c) => a + c[1], 0)} ${RH} re f 0 0 0 rg\n`;
    let x = M; for (const [h, w] of COLS) { ops += `BT /F2 8 Tf ${x + 2} ${y} Td (${esc(h)}) Tj ET\n`; x += w; } y -= RH; };
  newPage();
  for (const [tier, label] of [['penny', 'PENNY STOCKS'], ['large', 'LARGE STOCKS']] as const) {
    const list = rows.filter(r => r.tier === tier);
    if (!list.length) continue;
    if (y < M + RH * 4) newPage();
    ops += `BT /F2 11 Tf ${M} ${y} Td (${esc(`${label} (${list.length})`)}) Tj ET\n`; y -= 16;
    header();
    list.forEach((r, i) => {
      if (y < M + RH) { newPage(); ops += `BT /F2 11 Tf ${M} ${y} Td (${esc(label + ' (continued)')}) Tj ET\n`; y -= 16; header(); }
      if (i % 2) ops += `0.96 0.97 0.98 rg ${M} ${y - 4} ${COLS.reduce((a, c) => a + c[1], 0)} ${RH} re f 0 0 0 rg\n`;
      let x = M;
      for (const [, w, k] of COLS) {
        const c = cellColor(r, k);
        ops += `${c ? c + ' rg ' : ''}BT /${k === 'sym' ? 'F2' : 'F1'} 8 Tf ${x + 2} ${y} Td (${esc(fit(cellText(r, k), w))}) Tj ET${c ? ' 0 0 0 rg' : ''}\n`;
        x += w;
      }
      y -= RH;
    });
    y -= 10;
  }
  ops += `BT /F1 7 Tf ${M} ${M - 18} Td (${esc(kind === 'total'
    ? '* = new since the last list. Hits = last-hour checks qualified. Final: CLOSE = confirmed at close, YES/NEAR = last check, dropped, AH/PM = mover only. Ext = after-hours / pre-market move.'
    : live
    ? 'Hits = how many of today\'s checks (2:30, 2:45, 3:00, 3:15, 3:30, 3:45, 3:55) the stock qualified in. Now = qualifies at this check. Vol x Avg = volume so far today / normal daily volume (20-day Large, 50-day Penny); needs > 1.0x by the close.'
    : 'Vol x Avg = that day\'s volume / the average daily volume (20-day Large, 50-day Penny), e.g. 2.9x = almost 3 times a normal day. Body = candle body as % of the day\'s range (Large rule <= 10%). Down = straight down days before the signal day.')}) Tj ET\n`;
  ops += `BT /F1 7 Tf ${M} ${M - 27} Td (${esc('Spread = ask - bid of the at-the-money call, first expiry 5+ days out, as % of the mid price: green <= 10%, yellow 10-20%, red > 20% (too wide).')}) Tj ET\n`;
  pagesOps.push(ops);
  const objs: string[] = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  const kids: string[] = [];
  pagesOps.forEach((st, pi) => {
    st += `BT /F1 8 Tf ${W - M - 50} ${H - M + 14} Td (page ${pi + 1} of ${pagesOps.length}) Tj ET\n`;
    const pObj = objs.length < 5 ? 5 : objs.length, cObj = pObj + 1;
    objs[pObj] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${cObj} 0 R >>`;
    objs[cObj] = `<< /Length ${st.length} >>\nstream\n${st}endstream`;
    kids.push(`${pObj} 0 R`);
  });
  objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n'; const offs: number[] = [];
  for (let i = 1; i < objs.length; i++) { offs[i] = out.length; out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n` + offs.slice(1).map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Uint8Array([...out].map(c => c.charCodeAt(0) & 0xff));
}
async function sendPdf(name: string, caption: string, pdf: Uint8Array): Promise<string | null> {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN'), chat = Deno.env.get('TELEGRAM_CHAT_ID');
  if (!token || !chat) return 'missing Telegram secrets';
  const fd = new FormData();
  fd.append('chat_id', chat); fd.append('caption', caption.slice(0, 1000));
  fd.append('document', new Blob([pdf as unknown as BlobPart], { type: 'application/pdf' }), name);
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: fd, signal: AbortSignal.timeout(30_000) });
    const j = await r.json().catch(() => ({}));
    return r.ok && j?.ok ? null : `telegram ${r.status}`;
  } catch (e) { return String(e).split(token).join('***'); }   // never let the bot token reach a response
}

// The list a run belongs to: pre-market (and weekends) → the last trading day that had last-hour checks; otherwise today.
async function listDate(supa: any, et: { date: string; mins: number; wd: string }): Promise<string> {
  const weekend = et.wd === 'Sat' || et.wd === 'Sun';
  if (!weekend && et.mins >= 9 * 60 + 30) return et.date;
  const { data } = await supa.from('sp_live_state').select('key').like('key', 'run:%').lt('key', `run:${et.date}`).order('key', { ascending: false }).limit(1);
  return data?.[0] ? String(data[0].key).slice(4) : et.date;
}
async function totalRows(supa: any, d: string, newKeys: Set<string> = new Set()): Promise<any[]> {
  const [{ data: live }, { data: runRow }, { data: sig }, { data: ext }] = await Promise.all([
    supa.from('sp_live_state').select('key,state,hits,snap').like('key', `live:${d}:%`).gt('hits', 0).limit(2000),
    supa.from('sp_live_state').select('hits').eq('key', `run:${d}`).maybeSingle(),
    supa.from('single_pattern').select('*').eq('signal_date', d),
    supa.from('sp_live_state').select('key,snap').like('key', `ext:${d}:%`).limit(2000)]);
  const runs = runRow?.hits || 0;
  const by: Record<string, any> = {};
  for (const r of live || []) if (r.snap) by[`${r.snap.tier}:${r.snap.sym}`] = { ...r.snap, hits: r.hits, runs,
    now: r.state === 'signal' ? 'YES' : r.state === 'near' ? 'NEAR' : 'dropped' };
  const syms = [...new Set([...(sig || []).map((r: any) => r.symbol), ...Object.values(by).map((r: any) => r.sym), ...(ext || []).map((r: any) => r.snap?.sym)].filter(Boolean))];
  const nd = await ctx(supa, syms as string[]);
  for (const r of sig || []) {   // confirmed at the close: final candle numbers win, Hits stay
    const k = `${r.tier}:${r.symbol}`, prev = by[k];
    by[k] = { ...rowFromSignal(r, (r.near ? 'NEAR ' : 'doji ') + (r.tier === 'large' && r.body_pct != null ? `${Number(r.body_pct).toFixed(1)}%` : 'close'), nd),
      hits: prev?.hits ?? null, runs, now: r.near ? 'CLOSE NEAR' : 'CLOSE', at: 'close' };
  }
  for (const e of ext || []) { const x = e.snap; if (!x) continue;
    const k = `${x.tier}:${x.sym}`;
    if (by[k]) { by[k].ext = x.ext; by[k].extPct = x.extPct; }
    else by[k] = { ...x, hits: null, runs, now: x.sess === 'pre' ? 'PM' : 'AH' };
  }
  const out = Object.entries(by).map(([k, r]: [string, any]) => { const x = nd.raw[r.sym] || ({} as any);
    return { ...r, news: x.n || r.news, dil: x.d || r.dil, opt: x.o || r.opt, spr: x.s && x.s !== '-' ? x.s : r.spr, sprPct: x.sp ?? r.sprPct, isNew: newKeys.has(k) }; });
  const rank = (r: any) => r.now === 'CLOSE' ? 0 : r.now === 'CLOSE NEAR' ? 1 : r.now === 'YES' ? 2 : r.now === 'NEAR' ? 3 : r.now === 'dropped' ? 4 : 5;
  return out.sort((a, b) => rank(a) - rank(b) || ((b.hits || 0) - (a.hits || 0)) || ((b.volX ?? (b.volPct || 0) / 100) - (a.volX ?? (a.volPct || 0) / 100)));
}
async function sendTotal(supa: any, et: { date: string; mins: number; wd: string }, why: string, newKeys: Set<string> = new Set()): Promise<{ err: string | null; rows: number; d: string }> {
  const d = await listDate(supa, et);
  const R = await totalRows(supa, d, newKeys);
  if (!R.length) return { err: 'empty', rows: 0, d };
  const hh = Math.floor(et.mins / 60), mm = et.mins % 60;
  const clock = `${hh > 12 ? hh - 12 : hh || 12}:${String(mm).padStart(2, '0')} ${hh >= 12 ? 'PM' : 'AM'} ET`;
  const np = R.filter(r => r.tier === 'penny').length, nl = R.filter(r => r.tier === 'large').length, nn = R.filter(r => r.isNew).length;
  const title = `Single Pattern - TOTAL list for ${mdy(d)} - updated ${et.date === d ? '' : mdy(et.date) + ' '}${clock}`;
  const err = await sendPdf(`single-pattern-TOTAL-${d}-${String(hh).padStart(2, '0')}${String(mm).padStart(2, '0')}.pdf`,
    `📋 Single Pattern · TOTAL list for ${mdy(d)} · Penny ${np} · Large ${nl}${nn ? ` · ${nn} new (*)` : ''} · ${why}, ${clock}`, makePdf(title, R, 'total'));
  return { err, rows: R.length, d };
}

function rowFromSignal(r: any, status: string, nd: any) {
  const x = nd.raw[r.symbol] || { n: '', d: '' };
  return { tier: r.tier, sym: r.symbol, status, price: r.close, chg: r.day_chg_pct == null ? null : Number(r.day_chg_pct), high: r.high, low: r.low,
    vol: r.close ? Number(r.dollar_vol) / Number(r.close) : null, volPct: r.vol_x == null ? null : Number(r.vol_x) * 100, avgDays: r.tier === 'large' ? 20 : 50,
    down: r.down5, body: r.tier === 'large' ? (r.body_pct == null ? null : Number(r.body_pct)) : null, target: r.target, stop: r.stop, news: x.n, dil: x.d, opt: x.o, spr: x.s, sprPct: x.sp };
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
    const out: string[] = [], logKeys: string[] = [], rows: any[] = [];
    const newKeys = new Set<string>();   // tier:symbol added to the TOTAL list by this run
    let afterClose = false;              // confirmations / after-hours / pre-market → send the TOTAL list
    let livePdf: { rows: any[]; runNo: number; clock: string; more: number } | null = null;

    if (mode === 'test') {
      const q = supa.from('single_pattern').select('*').eq('symbol', String(body.symbol || '').toUpperCase());
      const { data } = body.tier ? await q.eq('tier', body.tier) : await q;
      const r = (data || [])[0];
      if (!r) return Response.json({ error: 'no signal for that symbol' }, { status: 404 });
      const nd = await ctx(supa, [r.symbol]);
      out.push('🧪 TEST ALERT\n' + signalText(r, 'confirmed at close', nd)); rows.push(rowFromSignal(r, (r.near ? 'NEAR ' : '') + 'Signal ' + mdy(r.signal_date), nd));
    }

    if (mode === 'spread') {
      let syms: string[] = Array.isArray(body.symbols) ? body.symbols.map((x: any) => String(x).toUpperCase()) : [];
      if (!syms.length) {
        const { data: uni } = await supa.rpc('sp_watch_universe');
        syms = (Array.isArray(uni) ? uni : []).filter((u: any) => u.kind !== 'setup').map((u: any) => u.symbol);
        const { data: sp } = await supa.from('single_pattern').select('symbol');
        syms.push(...(sp || []).map((r: any) => r.symbol));
        const { data: lv } = await supa.from('sp_live_state').select('key').like('key', `live:${et.date}:%`).gt('hits', 0).limit(1000);
        syms.push(...(lv || []).map((r: any) => String(r.key).split(':').pop()));
      }
      const r = await refreshSpreads(supa, syms);
      return Response.json({ mode, symbols: new Set(syms).size, ...r });
    }

    if (mode === 'total') {
      const t = await sendTotal(supa, et, 'end of day');
      return Response.json({ mode, list: t.d, rows: t.rows, pdf: t.err || 'sent' });
    }

    if (mode === 'pdftest') {
      const { data } = await supa.from('single_pattern').select('*').order('vol_x', { ascending: false }).limit(60);
      const R = (data || []).filter((r: any) => !r.near).concat((data || []).filter((r: any) => r.near).slice(0, 10));
      const nd = await ctx(supa, R.map((r: any) => r.symbol));
      const tr = R.map((r: any) => rowFromSignal(r, (r.near ? 'NEAR ' : '') + 'Signal ' + mdy(r.signal_date) + ' - ' + r.status, nd));
      const err = await sendPdf(`single-pattern-sample-${et.date}.pdf`, `🧪 Sample PDF · current Single Pattern signals · Penny ${tr.filter((r: any) => r.tier === 'penny').length} · Large ${tr.filter((r: any) => r.tier === 'large').length}`,
        makePdf(`Single Pattern - current signals (sample) - ${et.date}`, tr));
      return Response.json({ mode, rows: tr.length, pdf: err || 'sent' });
    }

    if (mode === 'signals') {
      const { data: rows } = await supa.from('single_pattern').select('*').order('vol_x', { ascending: false });
      const latest = (rows || []).reduce((m: string, r: any) => r.last_date > m ? r.last_date : m, '');
      const todayAll = (rows || []).filter((r: any) => r.signal_date === latest);
      const today = [...todayAll.filter((r: any) => !r.near), ...todayAll.filter((r: any) => r.near).slice(0, 10)];
      const keys = today.flatMap((r: any) => [`sig:${r.tier}:${r.symbol}:${r.signal_date}`, `sigc:${r.tier}:${r.symbol}:${r.signal_date}`]);
      const { data: sent } = keys.length ? await supa.from('sp_alert_log').select('key').in('key', keys) : { data: [] };
      const have = new Set((sent || []).map((x: any) => x.key));
      const closed = !(latest === et.date && et.mins < 16 * 60);
      if (!closed) await refreshSpreads(supa, today.map((r: any) => r.symbol));
      await volFresh(today.filter((r: any) => !have.has(`sigc:${r.tier}:${r.symbol}:${r.signal_date}`)).map((r: any) => r.symbol));
      afterClose = closed;
      const nd = await ctx(supa, today.map((r: any) => r.symbol));
      for (const r of today) {
        const k = `sig:${r.tier}:${r.symbol}:${r.signal_date}`, kc = `sigc:${r.tier}:${r.symbol}:${r.signal_date}`;
        if (!have.has(k)) {
          newKeys.add(`${r.tier}:${r.symbol}`);
          out.push(signalText(r, closed ? 'confirmed at close ✅' : 'forming today ⏳ candle not final — last-hour entry', nd));
          rows.push(rowFromSignal(r, (r.near ? 'NEAR ' : '') + (closed ? 'Confirmed at close' : 'Forming'), nd));
          logKeys.push(k); if (closed) logKeys.push(kc);
        } else if (closed && !have.has(kc)) {
          rows.push(rowFromSignal(r, (r.near ? 'NEAR ' : '') + 'Confirmed at close', nd));
          out.push(`${head(r.tier)}${r.near ? ' · NEAR' : ''}\n$${r.symbol} ✅ confirmed at close ${mdy(r.signal_date)} · entry ${money(r.close)} · target ${money(r.target)} · stop: close below ${money(r.stop)}`);
          logKeys.push(kc);
        }
      }
    }

    if (mode === 'live') {
      // 7 checks a day: 2:30, 2:45, 3:00, 3:15, 3:30, 3:45, 3:55 PM ET. Each check: up to 5 messages (new stocks / real
      // changes only) + ONE running PDF of every stock that qualified today, with Hits = checks it qualified in.
      const open = et.wd !== 'Sat' && et.wd !== 'Sun' && et.mins >= 9 * 60 + 30 && et.mins < 16 * 60;
      if (!open && !body.force) return Response.json({ skipped: 'market closed' });
      const { data: cand, error } = await supa.rpc('sp_live_candidates');
      if (error) throw new Error('candidates: ' + error.message);
      const C: any[] = Array.isArray(cand) ? cand : [];
      const ys = await yahooSession();
      if (!ys) throw new Error('Yahoo session failed');
      const fields = 'symbol,regularMarketPrice,regularMarketOpen,regularMarketDayHigh,regularMarketDayLow,regularMarketVolume';
      const quotes: Record<string, any> = {};
      const syms = C.map(c => c.symbol);
      for (let i = 0; i < syms.length; i += 100) {
        try {
          const r = await fetch(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(syms.slice(i, i + 100).join(','))}&fields=${fields}&crumb=${encodeURIComponent(ys.crumb)}`,
            { headers: { 'User-Agent': UA, Cookie: ys.cookie }, signal: AbortSignal.timeout(15_000) });
          const j = await r.json();
          for (const q of j?.quoteResponse?.result || []) quotes[q.symbol] = q;
        } catch (_) { /**/ }
      }
      const prefix = `live:${et.date}:`;
      const prevState: Record<string, any> = {};
      { const { data } = await supa.from('sp_live_state').select('key,state,body,vol_ok,hits,snap,first_at').like('key', prefix + '%').limit(2000);
        for (const r of data || []) prevState[r.key] = r; }
      const runKey = `run:${et.date}`;
      const { data: runRow } = await supa.from('sp_live_state').select('hits').eq('key', runKey).maybeSingle();
      const runNo = (runRow?.hits || 0) + 1;
      const hh = Math.floor(et.mins / 60), mm = et.mins % 60;
      const clock = `${hh > 12 ? hh - 12 : hh}:${String(mm).padStart(2, '0')} PM`;
      const evald: any[] = [];
      for (const c of C) {
        const q = quotes[c.symbol]; if (!q) continue;
        const o = Number(q.regularMarketOpen), h = Number(q.regularMarketDayHigh), l = Number(q.regularMarketDayLow), px = Number(q.regularMarketPrice), v = Number(q.regularMarketVolume) || 0;
        if (![o, h, l, px].every(isFinite) || !(h > l) || o <= 0) continue;
        const bodyPct = Math.abs(px - o) / (h - l) * 100;
        let state = 'none';
        const dayChg = c.prev_close ? (px / Number(c.prev_close) - 1) * 100 : 0;
        if (c.tier === 'large') {
          // doji = body <= 10%. NEAR = body up to 30% on a red candle / 20% on a green one, and not already up 3%+ (too late)
          if (px >= 10) state = bodyPct <= 10 ? 'signal' : (dayChg < 3 && bodyPct <= (px < o ? 30 : 20)) ? 'near' : 'none';
        } else {
          const pos = (px - l) / (h - l), lower = Math.min(o, px) - l;
          if (px >= 0.40 && px < 10 && pos >= 0.75 && lower >= 2 * Math.max(Math.abs(px - o), (h - l) * 0.05)) state = 'signal';
        }
        const avg = c.tier === 'large' ? Number(c.av20) : Number(c.av50);
        const minDollar = c.tier === 'large' ? 5e6 : 1e6;
        const volOk = avg > 0 && v > avg && px * v >= minDollar;
        if (state === 'near' && !volOk) state = 'none';   // NEAR candles count only once volume is above average
        const key = prefix + `${c.tier}:${c.symbol}`;
        const prev = prevState[key];
        const was = prev?.state || 'none';
        let kind: string | null = null;
        if (state !== 'none' && was === 'none') kind = prev && prev.hits ? 'back' : 'new';
        else if (state !== was) kind = 'change';
        else if (state !== 'none' && volOk && prev && !prev.vol_ok) kind = 'vol';
        if (state === 'none' && !prev) continue;
        evald.push({ c, o, h, l, px, v, bodyPct, state, avg, volOk, key, prev, kind });
      }
      await refreshSpreads(supa, evald.filter(e => e.state !== 'none').map(e => e.c.symbol), ys);   // fresh spread for the alerts
      await volFresh(evald.filter(e => e.kind).map(e => e.c.symbol));                                // and running volume
      const nd = await ctx(supa, evald.map(e => e.c.symbol));
      const upserts: any[] = [];
      const msgs: { text: string; sym: string; pri: number }[] = [];
      for (const e of evald) {
        const { c, o, h, l, px, v, bodyPct, state, avg, volOk, key, prev, kind } = e;
        const x = nd.raw[c.symbol] || { n: '', d: '' };
        const what = state === 'signal' ? (c.tier === 'large' ? `doji (body ${bodyPct.toFixed(1)}%)` : 'candle OK') : state === 'near' ? `NEAR (body ${Math.round(bodyPct)}%)` : '';
        const snap = state !== 'none' ? { tier: c.tier, sym: c.symbol, status: what, price: px, chg: c.prev_close ? (px / Number(c.prev_close) - 1) * 100 : null, high: h, low: l, vol: v,
            volX: avg > 0 ? v / avg : null, avgVol: avg, avgDays: c.tier === 'large' ? 20 : 50, down: c.streak, body: c.tier === 'large' ? bodyPct : null,
            target: px + 2 * Number(c.atr10), stop: l, news: x.n, dil: x.d, opt: x.o, spr: x.s, sprPct: x.sp, at: clock }
          : prev?.snap ? { ...prev.snap, news: x.n || prev.snap.news, dil: x.d || prev.snap.dil, opt: x.o || prev.snap.opt,
              spr: x.s && x.s !== '-' ? x.s : prev.snap.spr, sprPct: x.sp ?? prev.snap.sprPct } : null;
        upserts.push({ key, state, body: Math.round(bodyPct * 10) / 10, vol_ok: volOk, updated_at: new Date().toISOString(),
          hits: (prev?.hits || 0) + (state !== 'none' ? 1 : 0), snap, first_at: prev?.first_at || (state !== 'none' ? new Date().toISOString() : null) });
        if (!kind) continue;
        const label = state === 'signal' ? (c.tier === 'large' ? `✅ doji forming — body ${bodyPct.toFixed(1)}% of range (rule ≤ 10%)` : '✅ candle forming — closing near the high with a long lower wick')
          : state === 'near' ? `⚠️ NEAR — body ${Math.round(bodyPct)}% of range (rule ≤ 10%)` : `❌ no longer qualifies — body ${Math.round(bodyPct)}% of range${c.tier === 'penny' ? ' / not near the high' : ''}`;
        const lines = [`${head(c.tier)} · ${kind === 'new' ? '⏳ FORMING' : '🔄 UPDATE'} ${clock}`,
          `$${c.symbol}${c.name ? ' · ' + String(c.name).split(' - ')[0].slice(0, 40) : ''}`,
          kind === 'vol' ? `Volume now above the ${c.tier === 'large' ? '20' : '50'}-day average ✅` : label,
          `Price ${money(px)} · O ${money(o)} H ${money(h)} L ${money(l)}`,
          `Volume so far ${fvol(v)} = ${avg > 0 ? (v / avg).toFixed(1) + '×' : '—'} the ${c.tier === 'large' ? '20' : '50'}-day avg (${fvol(avg)}) ${volOk ? '✅' : '(needs > 1.0× by the close) ⏳'}`,
          `${c.streak} down days before today ✅`];
        if (state !== 'none') lines.push(`If it closes here: entry ${money(px)} · target ${money(px + 2 * Number(c.atr10))} (2× ATR10) · stop: close below ${money(l)}`);
        lines.push(nd(c.symbol));
        msgs.push({ text: lines.join('\n'), sym: c.symbol, pri: state === 'signal' ? 0 : kind === 'change' && state === 'none' ? 1 : 2 });
      }
      if (!body.dry) {   // dry = build the example PDF only: nothing saved, nothing counted
        for (let i = 0; i < upserts.length; i += 200) await supa.from('sp_live_state').upsert(upserts.slice(i, i + 200), { onConflict: 'key' });
        await supa.from('sp_live_state').upsert({ key: runKey, state: 'run', hits: runNo, updated_at: new Date().toISOString() }, { onConflict: 'key' });
      }
      msgs.sort((a, b) => a.pri - b.pri);
      if (!body.dry) for (const m of msgs.slice(0, 5)) out.push(m.text);
      // running PDF: everything that qualified today (saved state + this check)
      const merged: Record<string, any> = { ...prevState };
      for (const u of upserts) merged[u.key] = u;
      const all = Object.values(merged).filter((r: any) => r.hits > 0);
      const R = all.filter((r: any) => r.snap).map((r: any) => ({ ...r.snap, hits: r.hits, runs: runNo,
          now: r.state === 'signal' ? 'YES' : r.state === 'near' ? 'NEAR' : 'dropped' }))
        .sort((a: any, b: any) => (b.hits - a.hits) || ((b.now !== 'dropped' ? 1 : 0) - (a.now !== 'dropped' ? 1 : 0)) || ((b.volX || 0) - (a.volX || 0)));
      livePdf = R.length ? { rows: R, runNo, clock, more: Math.max(0, msgs.length - 5) } : null;
    }

    if (mode === 'ext') {
      const wd = et.wd !== 'Sat' && et.wd !== 'Sun';
      const session = !wd ? null : (et.mins >= 4 * 60 && et.mins < 9 * 60 + 30) ? 'pre' : (et.mins >= 16 * 60 && et.mins <= 20 * 60) ? 'post' : null;
      if (!session && !body.force) return Response.json({ skipped: 'outside pre-market / after-hours' });
      const sess = (body.session as string) || session || 'pre';
      afterClose = true;
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
      let extList = '';
      await volFresh(fresh.map(h => h.u.symbol));
      const nd = await ctx(supa, fresh.map(h => h.u.symbol));
      for (const h of fresh) {
        // extended-hours volume: Nasdaq via fast-scan (Yahoo's chart reports 0 for pre-market / after-hours)
        const vv = nd.vacc[h.u.symbol];
        const xv: number | null = vv ? Number(sess === 'pre' ? vv.pre_vol : vv.post_vol) : null;
        const u = h.u;
        const status = u.kind === 'near' ? `NEAR signal ${mdy(u.signal_date)} (candle body over 10%) · entry ${money(u.entry)} · target ${money(u.target)} · stop: close below ${money(u.stop)}`
          : u.kind === 'signal' ? `Signal ${mdy(u.signal_date)} · entry ${money(u.entry)} · target ${money(u.target)} · stop: close below ${money(u.stop)}`
          : u.kind === 'added' ? 'Your added stock'
          : `Setting up: ${u.streak} down days in a row (${u.tier === 'large' ? '5' : '3'} needed, then the candle)`;
        const volLine = xv == null ? `${sess === 'pre' ? 'Pre-market' : 'After-hours'} volume: n/a`
          : `${sess === 'pre' ? 'Pre-market' : 'After-hours'} volume ${fvol(xv)}${u.av20 ? ` = ${Math.round(xv / u.av20 * 100)}% of a normal day (${fvol(u.av20)} avg)` : ''}${u.av20 && xv >= 0.1 * u.av20 ? ' 🔥' : ''}`;
        { const x = nd.raw[u.symbol] || { n: '', d: '' };
          rows.push({ tier: u.tier, sym: u.symbol, status: `${sess === 'pre' ? 'Pre-mkt' : 'After-hrs'} ${h.pct > 0 ? 'UP' : 'DOWN'} - ${u.kind === 'signal' ? 'signal ' + mdy(u.signal_date) : u.kind === 'near' ? 'NEAR ' + mdy(u.signal_date) : u.kind === 'added' ? 'your stock' : 'setting up'}`,
            price: h.px, chg: h.pct, high: null, low: null, vol: xv, volPct: xv != null && u.av20 ? xv / u.av20 * 100 : null, avgDays: 20,
            down: u.streak, body: null, target: u.target, stop: u.stop, news: x.n, dil: x.d, opt: x.o, spr: x.s, sprPct: x.sp }); }
        { const x = nd.raw[u.symbol] || { n: '', d: '' };   // keep it for the TOTAL list (pre-market → prior day's list)
          const ld = extList || (extList = await listDate(supa, et));
          const ext = `${sess === 'pre' ? 'PM' : 'AH'} ${h.pct > 0 ? '+' : ''}${h.pct.toFixed(1)}%`;
          await supa.from('sp_live_state').upsert({ key: `ext:${ld}:${u.tier}:${u.symbol}`, state: 'ext', updated_at: new Date().toISOString(),
            snap: { tier: u.tier, sym: u.symbol, sess, ext, extPct: h.pct, status: u.kind === 'signal' ? 'signal ' + mdy(u.signal_date) : u.kind === 'near' ? 'NEAR ' + mdy(u.signal_date) : u.kind === 'added' ? 'your stock' : `setting up (${u.streak} dn)`,
              price: h.px, chg: null, vol: xv, volPct: xv != null && u.av20 ? xv / u.av20 * 100 : null, avgDays: 20, down: u.streak, target: u.target, stop: u.stop,
              news: x.n, dil: x.d, opt: x.o, spr: x.s, sprPct: x.sp, at: sess === 'pre' ? 'pre' : 'AH' } }, { onConflict: 'key' });
          newKeys.add(`${u.tier}:${u.symbol}`); }
        out.push([`${head(u.tier)} · ${sess === 'pre' ? '🌅 PRE-MARKET' : '🌙 AFTER-HOURS'}`,
          `$${u.symbol} ${h.pct > 0 ? '▲' : '▼'} ${h.pct > 0 ? '+' : ''}${h.pct.toFixed(1)}% at ${money(h.px)} (${sess === 'pre' ? 'prev close' : 'today\'s close'} ${money(h.ref)})`,
          volLine, status, nd(u.symbol)].join('\n'));
        logKeys.push(h.key);
      }
    }

    let pdfErr: string | null = null, pdfB64: string | null = null;
    if (livePdf) {   // last-hour running file: messages (max 5) then one PDF of the whole day so far
      if (out.length && !body.dry) { await supa.from('telegram_outbox').insert(out.map(text => ({ text }))); await flush(supa); }
      const P = livePdf.rows, np = P.filter((r: any) => r.tier === 'penny').length, nl = P.filter((r: any) => r.tier === 'large').length;
      const title = `Single Pattern - TODAY, forming now (live) - ${et.date} ${livePdf.clock} ET - check ${livePdf.runNo} of 7`;
      const pdf = makePdf(title, P, true);
      if (body.return_pdf) pdfB64 = btoa(String.fromCharCode(...pdf));
      if (!body.no_send) pdfErr = await sendPdf(`single-pattern-today-${et.date}-${String(Math.floor(et.mins / 60)).padStart(2, '0')}${String(et.mins % 60).padStart(2, '0')}.pdf`,
        `📎 Single Pattern · TODAY running list · ${livePdf.clock} ET (check ${livePdf.runNo} of 7) · Penny ${np} · Large ${nl}${livePdf.more ? ` · ${livePdf.more} more changes only in the PDF` : ''}`, pdf);
      return Response.json({ mode, sent: out.length, rows: P.length, pdf: pdfErr || 'sent', pdf_b64: pdfB64 });
    }
    if (out.length) {
      const many = out.length > 5;
      const label = mode === 'live' ? 'last hour' : mode === 'ext' ? (et.mins < 12 * 60 ? 'pre-market' : 'after-hours') : mode === 'signals' ? 'signals' : mode;
      const hh = Math.floor(et.mins / 60), mm = et.mins % 60;
      const clock = `${hh > 12 ? hh - 12 : hh || 12}:${String(mm).padStart(2, '0')} ${hh >= 12 ? 'PM' : 'AM'} ET`;
      const syms = [...new Set(out.map(t => (t.match(/\$([A-Z][A-Z.\-]{0,6})/) || [])[1]).filter(Boolean))];
      const texts = many ? [...out.slice(0, 5), `📎 SINGLE PATTERN · ${out.length - 5} more alerts (${label}, ${clock}) — all ${out.length} are in the ${afterClose ? 'TOTAL list ' : ''}PDF below:\n${syms.slice(5).join(', ')}`] : out;
      const { error } = await supa.from('telegram_outbox').insert(texts.map(text => ({ text })));
      if (error) throw new Error('outbox: ' + error.message);
      if (logKeys.length) await supa.from('sp_alert_log').upsert(logKeys.map(key => ({ key })), { onConflict: 'key', ignoreDuplicates: true });
      await flush(supa);
      if (afterClose) {   // after the close: always the FULL day list (new stocks marked *), not just this run
        const t = await sendTotal(supa, et, mode === 'ext' ? `${label} update` : 'confirmed at close', newKeys);
        pdfErr = t.err;
      } else {   // always a PDF overview with every alert of this run (not only when there are more than 5)
        const title = `Single Pattern alerts - ${label} - ${et.date} ${clock} - ${out.length} alerts`;
        pdfErr = await sendPdf(`single-pattern-${label.replace(/\s+/g, '-')}-${et.date}-${String(hh).padStart(2, '0')}${String(mm).padStart(2, '0')}.pdf`,
          `📎 Single Pattern · ${out.length} alerts (${label}, ${clock}) · Penny ${rows.filter(r => r.tier === 'penny').length} · Large ${rows.filter(r => r.tier === 'large').length}`, makePdf(title, rows));
      }
    }
    return Response.json({ mode, sent: out.length, pdf: out.length ? (pdfErr || 'sent') : null, preview: out.slice(0, 2) });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
});
