// ticker-info: a short company description (and sector / industry / website) for one ticker, looked up once and kept in public.ticker_info.
// Source: Yahoo Finance company profile (assetProfile); backup: Nasdaq company profile. The app reads it through rpc ticker_brief.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const SYM = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
// first two sentences, max ~320 characters (a sentence ends at . ! ? followed by a space and a capital letter, so "Corp., through" or "U.S. and" stay whole)
function short(t: string | null | undefined): string | null {
  const s = String(t || '').replace(/\s+/g, ' ').trim(); if (!s) return null;
  const parts = s.split(/(?<=[.!?])\s+(?=[A-Z])/);
  const sent: string[] = [];
  for (const p of parts) { if (sent.length && sent[sent.length - 1].length < 40) sent[sent.length - 1] += ' ' + p; else sent.push(p); }   // "Maison Solutions Inc." + "It operates …"
  let out = ''; for (const p of sent.slice(0, 2)) { if (out && (out + ' ' + p).length > 320) break; out = out ? out + ' ' + p : p; }
  return out.length > 340 ? out.slice(0, 337).replace(/\s+\S*$/, '') + '…' : out;
}
async function fromYahoo(sym: string) {
  const r1 = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(8000) });
  const cookies = (typeof (r1.headers as any).getSetCookie === 'function' ? (r1.headers as any).getSetCookie() : [r1.headers.get('set-cookie') || ''])
    .map((c: string) => c.split(';')[0].trim()).filter(Boolean).join('; ');
  try { await r1.body?.cancel(); } catch (_) { /**/ }
  const r2 = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, cookie: cookies }, signal: AbortSignal.timeout(8000) });
  const crumb = (await r2.text()).trim();
  if (!r2.ok || !crumb || crumb.length > 40) throw new Error('yahoo crumb ' + r2.status);
  const r3 = await fetch(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym.replace('.', '-'))}?modules=assetProfile,price&crumb=${encodeURIComponent(crumb)}`,
    { headers: { 'User-Agent': UA, cookie: cookies }, signal: AbortSignal.timeout(10000) });
  if (!r3.ok) throw new Error('yahoo HTTP ' + r3.status);
  const res = (await r3.json())?.quoteSummary?.result?.[0]; const ap = res?.assetProfile || {};
  if (!ap.longBusinessSummary) throw new Error('yahoo no summary');
  return { summary: short(ap.longBusinessSummary), sector: ap.sector || null, industry: ap.industry || null, website: ap.website || null, name: res?.price?.longName || res?.price?.shortName || null, source: 'yahoo' };
}
async function fromNasdaq(sym: string) {
  const r = await fetch(`https://api.nasdaq.com/api/company/${encodeURIComponent(sym)}/company-profile`,
    { headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('nasdaq HTTP ' + r.status);
  const d = (await r.json())?.data; const v = (k: string) => d?.[k]?.value || null;
  if (!v('CompanyDescription')) throw new Error('nasdaq no summary');
  return { summary: short(v('CompanyDescription')), sector: v('Sector'), industry: v('Industry'), website: v('CompanyUrl'), name: v('CompanyName'), source: 'nasdaq' };
}
// the ticker's own headlines from the last 3 days (Finnhub company news), newest first, max 3
async function companyNews(sym: string) {
  const token = Deno.env.get('FINNHUB_API_KEY'); if (!token) return null;
  const to = new Date().toISOString().slice(0, 10), from = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
  const r = await fetch(`https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(sym)}&from=${from}&to=${to}&token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) { try { await r.body?.cancel(); } catch (_) { /**/ } return null; }
  const a = await r.json(); if (!Array.isArray(a)) return null;
  return a.filter((n: any) => n.headline).sort((x: any, y: any) => y.datetime - x.datetime).slice(0, 3)
    .map((n: any) => ({ headline: String(n.headline).slice(0, 220), source: n.source || null, url: n.url || null, published_at: new Date(n.datetime * 1000).toISOString() }));
}
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
  try {
    const body = await req.json().catch(() => ({}));
    const symbol = String(body.symbol || '').trim().toUpperCase();
    if (!SYM.test(symbol)) return json({ error: 'bad symbol' }, 400);
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: have } = await supa.from('ticker_info').select('*').eq('symbol', symbol).maybeSingle();
    const now = new Date().toISOString();
    const needProfile = !(have && (have.summary || (have.tried_at && Date.now() - Date.parse(have.tried_at) < 7 * 864e5)));   // once per ticker (retry a failed one after a week)
    const needNews = !(have && have.news_at && Date.now() - Date.parse(have.news_at) < 30 * 60e3);                          // headlines: at most every 30 minutes
    if (!needProfile && !needNews) return json({ ok: true, cached: true, info: have });
    const row: any = { symbol };
    if (needProfile) {
      let info: any = null; const errs: string[] = [];
      for (const f of [fromYahoo, fromNasdaq]) { try { info = await f(symbol); break; } catch (e) { errs.push(String((e as Error).message || e).slice(0, 60)); } }
      Object.assign(row, { name: info?.name ?? null, sector: info?.sector ?? null, industry: info?.industry ?? null, website: info?.website ?? null,
        summary: info?.summary ?? null, source: info?.source ?? null, fetched_at: info ? now : null, tried_at: now, error: info ? null : errs.join(' · ') });
    }
    if (needNews) { try { const n = await companyNews(symbol); if (n) { row.news = n; row.news_at = now; } } catch (_) { /* keep the old headlines */ } }
    const { data: saved } = await supa.from('ticker_info').upsert(row, { onConflict: 'symbol' }).select().maybeSingle();
    return json({ ok: true, info: saved || row });
  } catch (e) {
    return json({ error: String((e as Error).message || e).slice(0, 200) }, 500);
  }
});
