// starter-lists: fills public.sp_starter with the Nasdaq-100 (list 'ndx') and the S&P 500 (list 'spx'),
// then refreshes the admin's penny list (sp_starter_penny_refresh). Runs weekly from cron; safe to call again.
// Sources: Nasdaq-100 = Nasdaq's own list API; S&P 500 = Wikipedia's constituents table, backup = the
// datasets/s-and-p-500-companies CSV on GitHub. A list is only replaced when the new count looks right,
// so a bad download never empties it. Tickers with a dot or dash (BRK.B, BF.B) are skipped: the Watchlist
// only takes plain letter tickers.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const OK = /^[A-Z]{1,6}$/;
type Row = { symbol: string; name: string | null };

async function ndx(): Promise<Row[]> {
  const r = await fetch('https://api.nasdaq.com/api/quote/list-type/nasdaq100', {
    headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error('nasdaq HTTP ' + r.status);
  const j = await r.json();
  const rows = j?.data?.data?.rows || j?.data?.rows || [];
  return rows.map((x: any) => ({ symbol: String(x.symbol || '').trim().toUpperCase(), name: x.companyName || null }));
}

async function spxWiki(): Promise<Row[]> {
  const r = await fetch('https://en.wikipedia.org/w/index.php?title=List_of_S%26P_500_companies&action=raw', {
    headers: { 'User-Agent': 'StockPulsePro/1.0 (propsst.evolutionx4u.com)' }, signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error('wikipedia HTTP ' + r.status);
  const txt = await r.text();
  const start = txt.indexOf('id="constituents"'); if (start < 0) throw new Error('wikipedia: table not found');
  const table = txt.slice(start, txt.indexOf('|}', start));
  const out: Row[] = [];
  for (const row of table.split(/\n\|-/).slice(1)) {
    const m = row.match(/\{\{\s*(?:NyseSymbol|NasdaqSymbol|Nyse|Nasdaq|NYSE|NASDAQ|CboeSymbol|BZX link)\s*\|\s*([A-Za-z.\-]+)\s*\}\}/)
      || row.match(/^\s*\|\s*\[\[[^\]|]*\|\s*([A-Z.\-]{1,7})\s*\]\]/m);
    if (!m) continue;
    const nm = row.match(/\|\s*\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
    out.push({ symbol: m[1].toUpperCase(), name: nm ? (nm[2] || nm[1]).trim() : null });
  }
  return out;
}

async function spxCsv(): Promise<Row[]> {
  const r = await fetch('https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv', { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('csv HTTP ' + r.status);
  const lines = (await r.text()).trim().split(/\r?\n/).slice(1);
  return lines.map(l => {
    const m = l.match(/^([^,]+),("([^"]*)"|[^,]*)/);
    return { symbol: (m?.[1] || '').trim().toUpperCase(), name: (m?.[3] ?? m?.[2] ?? '').trim() || null };
  });
}

async function save(supa: any, list: string, rows: Row[], min: number, max: number) {
  const seen = new Set<string>();
  const clean = rows.filter(r => OK.test(r.symbol) && !seen.has(r.symbol) && seen.add(r.symbol));
  if (rows.length < min || rows.length > max) throw new Error(`${list}: ${rows.length} tickers, expected ${min}–${max}; list kept as it was`);
  const now = new Date().toISOString();
  const { error } = await supa.from('sp_starter').upsert(clean.map(r => ({ list, symbol: r.symbol, name: r.name, updated_at: now })), { onConflict: 'list,symbol' });
  if (error) throw error;
  const { error: e2 } = await supa.from('sp_starter').delete().eq('list', list).lt('updated_at', now);
  if (e2) throw e2;
  return { list, count: clean.length, skipped: rows.filter(r => !OK.test(r.symbol)).map(r => r.symbol) };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const result: any = {};
  try { result.ndx = await save(supa, 'ndx', await ndx(), 95, 110); } catch (e) { result.ndx = { error: String((e as Error).message || e) }; }
  try {
    let rows: Row[] = [], src = 'wikipedia';
    try { rows = await spxWiki(); if (rows.length < 490) throw new Error('wikipedia: only ' + rows.length); }
    catch (e) { result.spx_wiki_error = String((e as Error).message || e); rows = await spxCsv(); src = 'github-csv'; }
    result.spx = { ...(await save(supa, 'spx', rows, 490, 510)), source: src };
  } catch (e) { result.spx = { error: String((e as Error).message || e) }; }
  const { data: n, error } = await supa.rpc('sp_starter_penny_refresh');
  result.penny = error ? { error: error.message } : { count: n };
  return new Response(JSON.stringify(result), { headers: { ...CORS, 'Content-Type': 'application/json' } });
});
