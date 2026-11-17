// sector-sync — fills market_symbols.sector / industry from Nasdaq's public stock screener (all Nasdaq / NYSE / AMEX stocks in one call).
// Nasdaq sector names are mapped to the app's sector names. Runs weekly (cron) or on demand.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MAP: Record<string, string> = {
  'Technology': 'Technology', 'Telecommunications': 'Telecom', 'Health Care': 'Healthcare', 'Finance': 'Financials',
  'Consumer Discretionary': 'Consumer Disc.', 'Consumer Staples': 'Consumer Staples', 'Energy': 'Energy',
  'Industrials': 'Industrials', 'Basic Materials': 'Materials', 'Real Estate': 'Real Estate', 'Utilities': 'Utilities',
};
const SEMI_RE = /semiconductor/i;

Deno.serve(async () => {
  const started = Date.now();
  try {
    const r = await fetch('https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&download=true', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) return Response.json({ error: `nasdaq HTTP ${r.status}` }, { status: 502 });
    const rows: any[] = (await r.json())?.data?.rows || [];
    if (rows.length < 3000) return Response.json({ error: `too few rows (${rows.length})` }, { status: 502 });
    const out = rows.map(x => {
      const symbol = String(x.symbol || '').trim().toUpperCase();
      const raw = String(x.sector || '').trim();
      const industry = String(x.industry || '').trim();
      const sector = SEMI_RE.test(industry) ? 'Semiconductors' : (MAP[raw] || (raw || null));
      return { symbol, sector, industry: industry || null };
    }).filter(x => /^[A-Z]{1,5}$/.test(x.symbol) && x.sector);
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data, error } = await supa.rpc('apply_market_sectors', { p_rows: out });
    if (error) throw new Error(error.message);
    return Response.json({ fetched: rows.length, usable: out.length, updated: data, ms: Date.now() - started });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
});
