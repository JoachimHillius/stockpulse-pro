// dilution-check — dilution verdict for every Single Pattern stock, from free SEC EDGAR filings.
// Writes public.sp_dilution. Verdict:
//   risk    (red)   = HIGH: offering / prospectus / S-1 / unregistered share sale (8-K 3.02) / exchange
//                     deficiency notice (8-K 3.01) in the last 90 days
//                     MEDIUM: shelf (S-3 / F-3) in the last 12 months, or a HIGH-type filing 91–365 days ago
//   buyback (green) = no risk filing, but a buyback: issuer tender offer (SC TO-I) in 12 months
//                     or a buyback / repurchase headline in the news check (sp_news)
//   none    (gray)  = nothing found in 12 months
//   nodata  (gray)  = not in the SEC database (e.g. some foreign / OTC stocks)
// Large "well-known" issuers (filed an S-3ASR in 3 years) file 424B prospectuses mostly for debt notes,
// so their 424B filings are ignored.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const UA = 'StockPulse Pro research admin@evolutionx4u.com';
const MAX_PER_RUN = 120;
const CONCURRENCY = 4;
const DAY = 86400_000;

const HIGH_FORMS: Record<string, string> = {
  'S-1': 'Offering registration (S-1)', 'S-1/A': 'Offering registration amended (S-1/A)', 'F-1': 'Offering registration (F-1)',
  'F-1/A': 'Offering registration amended (F-1/A)', '424B1': 'Offering prospectus (424B1)', '424B3': 'Offering / resale prospectus (424B3)',
  '424B4': 'Offering priced (424B4)', '424B5': 'Offering / ATM prospectus (424B5)', '424B7': 'Resale prospectus (424B7)',
};
const SHELF_FORMS: Record<string, string> = { 'S-3': 'Shelf registered (S-3)', 'S-3/A': 'Shelf amended (S-3/A)', 'F-3': 'Shelf registered (F-3)', 'F-3/A': 'Shelf amended (F-3/A)' };

async function getJson(url: string): Promise<any | null> {
  for (let a = 0; a < 2; a++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: AbortSignal.timeout(15_000) });
      if (r.ok) return await r.json();
      try { await r.body?.cancel(); } catch (_) { /**/ }
      if (r.status === 404) return null;
    } catch (_) { /**/ }
    await new Promise(r => setTimeout(r, 1000));
  }
  return undefined; // failed (not "missing")
}

Deno.serve(async (req: Request) => {
  const started = Date.now();
  try {
    const body = await req.json().catch(() => ({}));
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    let symbols: string[] = Array.isArray(body.symbols) ? body.symbols.map((s: unknown) => String(s).toUpperCase()).slice(0, MAX_PER_RUN) : [];
    if (!symbols.length) {
      const { data, error } = await supa.rpc('sp_dilution_queue', { p_limit: MAX_PER_RUN });
      if (error) throw new Error('queue: ' + error.message);
      symbols = (data || []).map((r: any) => r.symbol);
    }
    if (!symbols.length) return Response.json({ checked: 0 });

    const map = await getJson('https://www.sec.gov/files/company_tickers.json');
    if (!map) throw new Error('SEC ticker list unavailable');
    const cikOf: Record<string, number> = {};
    for (const k of Object.keys(map)) cikOf[String(map[k].ticker).toUpperCase()] = Number(map[k].cik_str);

    // buyback headlines from the news check
    const { data: news } = await supa.from('sp_news').select('symbol,items').in('symbol', symbols);
    const bbNews: Record<string, any> = {};
    for (const n of news || []) {
      const hit = (Array.isArray(n.items) ? n.items : []).find((i: any) => /\b(buyback|repurchase)/i.test(i.h || ''));
      if (hit) bbNews[n.symbol] = hit;
    }

    const now = Date.now();
    const rows: any[] = []; let failed = 0; let cursor = 0;
    const worker = async () => {
      while (cursor < symbols.length) {
        const sym = symbols[cursor++];
        const cik = cikOf[sym] ?? cikOf[sym.replace('.', '-')];
        if (!cik) { rows.push({ symbol: sym, verdict: 'nodata', level: null, n_filings: 0, items: [], checked_at: new Date().toISOString() }); continue; }
        const sub = await getJson(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, '0')}.json`);
        await new Promise(r => setTimeout(r, 200));
        if (sub === undefined) { failed++; continue; }
        const f = sub?.filings?.recent || {};
        const forms: string[] = f.form || [];
        const wksi = forms.some((fm, i) => fm === 'S-3ASR' && now - Date.parse(f.filingDate[i]) < 3 * 365 * DAY);
        const items: any[] = []; let high = false, medium = false, buyback = false;
        for (let i = 0; i < forms.length; i++) {
          const age = now - Date.parse(f.filingDate[i]);
          if (!(age <= 365 * DAY)) continue;
          const fm = forms[i];
          const url = f.accessionNumber?.[i] ? `https://www.sec.gov/Archives/edgar/data/${cik}/${String(f.accessionNumber[i]).replace(/-/g, '')}/${f.primaryDocument?.[i] || ''}` : null;
          let label: string | null = null, kind: 'high' | 'shelf' | 'buyback' | null = null;
          if (HIGH_FORMS[fm] && !(wksi && fm.startsWith('424B'))) { label = HIGH_FORMS[fm]; kind = 'high'; }
          else if (SHELF_FORMS[fm]) { label = SHELF_FORMS[fm]; kind = 'shelf'; }
          else if (fm === '8-K' || fm === '6-K') {
            const it = String(f.items?.[i] || '');
            if (/\b3\.02\b/.test(it)) { label = 'Unregistered share sale (8-K 3.02)'; kind = 'high'; }
            else if (/\b3\.01\b/.test(it)) { label = 'Exchange deficiency / delisting notice (8-K 3.01)'; kind = 'high'; }
          } else if (fm === 'SC TO-I' || fm === 'SC TO-I/A') { label = 'Buyback — issuer tender offer (SC TO-I)'; kind = 'buyback'; }
          if (!kind) continue;
          if (kind === 'high') { if (age <= 90 * DAY) high = true; else medium = true; }
          if (kind === 'shelf') medium = true;
          if (kind === 'buyback') buyback = true;
          items.push({ form: fm, d: f.filingDate[i], label, url, kind });
        }
        if (bbNews[sym]) { buyback = true; items.push({ form: 'news', d: String(bbNews[sym].t || '').slice(0, 10), label: 'Buyback in the news: ' + bbNews[sym].h, url: bbNews[sym].url || null, kind: 'buyback' }); }
        items.sort((a, b) => b.d.localeCompare(a.d));
        const verdict = (high || medium) ? 'risk' : buyback ? 'buyback' : 'none';
        rows.push({ symbol: sym, verdict, level: high ? 'high' : medium ? 'medium' : null, n_filings: items.length, items: items.slice(0, 12), checked_at: new Date().toISOString() });
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (rows.length) {
      const { error } = await supa.from('sp_dilution').upsert(rows, { onConflict: 'symbol' });
      if (error) throw new Error('upsert: ' + error.message);
    }
    const counts = rows.reduce((m: Record<string, number>, r) => (m[r.verdict + (r.level ? '_' + r.level : '')] = (m[r.verdict + (r.level ? '_' + r.level : '')] || 0) + 1, m), {});
    return Response.json({ checked: rows.length, failed, counts, ms: Date.now() - started });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
});
