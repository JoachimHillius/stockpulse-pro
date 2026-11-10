import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { yahooSession, YAHOO_UA, type YahooSession } from "../_shared/yahoo.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

// Keep in sync with WATCHLIST in index.html (same list rsi-scan uses)
const BUILT_IN_WATCHLIST = [
'A', 'AA', 'AAL', 'AAPL', 'ADBE', 'AEP', 'AMD', 'AMZN', 'APD', 'APLD', 'AVGO', 'AXP', 'B', 'BABA', 'BAC',
  'BE', 'BMNR', 'BTDR', 'C', 'CAR', 'CCJ', 'CEG', 'CELH', 'CENX', 'CIFR', 'CL', 'CLF', 'CLSK', 'CMG', 'COIN',
  'COP', 'COST', 'CRCL', 'CRH', 'CRM', 'CSTM', 'CTVA', 'CVS', 'CVX', 'D', 'DAL', 'DUK', 'EEM', 'ET', 'EXC',
  'FANG', 'FCX', 'FLNC', 'FMC', 'FNMA', 'FSLR', 'GDX', 'GLD', 'GOOGL', 'HL', 'HOOD', 'HUM', 'HYG', 'IBIT',
  'INTC', 'IREN', 'IWM', 'JPM', 'KALU', 'KMI', 'KO', 'LEVI', 'LIN', 'MARA', 'MDLZ', 'META', 'MLM', 'MNST',
  'MO', 'MRNA', 'MRVL', 'MSFT', 'MSTR', 'MU', 'NEE', 'NEM', 'NFLX', 'NKE', 'NUE', 'NVDA', 'ONDS', 'ORCL',
  'OXY', 'PEP', 'PFE', 'PG', 'PL', 'PLTR', 'PM', 'PSX', 'PTON', 'PYPL', 'QBTS', 'QCOM', 'QQQ', 'R', 'RIG',
  'RIO', 'RIVN', 'RR', 'RS', 'SCHW', 'SHEL', 'SLB', 'SLV', 'SMCI', 'SOFI', 'SOXL', 'SPY', 'SRE', 'T', 'TMUS',
  'TSLA', 'TTD', 'TTE', 'UNF', 'UNH', 'V', 'VST', 'VZ', 'WFC', 'WMB', 'WMT', 'WULF', 'XEL', 'XLE', 'XOM',
];

const BATCH_SIZE = 100;
const CONCURRENCY = 4;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REHANDSHAKES = 3;
// Gate: ET weekdays, 04:00 through the 20:05 final run (minutes after midnight).
const WINDOW_START_MIN = 4 * 60;
const WINDOW_END_MIN = 20 * 60 + 5;
const SYMBOL_RE = /^[A-Z][A-Z.\-]{0,5}$/;
const QUOTE_FIELDS = ['symbol', 'regularMarketPrice', 'regularMarketChange', 'regularMarketChangePercent', 'regularMarketPreviousClose',
  'regularMarketVolume', 'regularMarketTime', 'marketState', 'preMarketPrice', 'preMarketChange', 'preMarketChangePercent',
  'postMarketPrice', 'postMarketChange', 'postMarketChangePercent'].join(',');

const etFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
function insideWindow(): boolean {
  const parts = etFormatter.formatToParts(new Date());
  const pick = (type: string) => parts.find(p => p.type === type)?.value || '';
  const weekday = pick('weekday');
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const minutes = (Number(pick('hour')) % 24) * 60 + Number(pick('minute')); // hour12:false can render midnight as "24"
  return minutes >= WINDOW_START_MIN && minutes <= WINDOW_END_MIN;
}

async function pagedSymbols(supa: any, table: string): Promise<string[]> {
  const PAGE = 1000; const out: string[] = []; let from = 0;
  while (true) {
    const { data, error } = await supa.from(table).select('symbol').order('symbol').range(from, from + PAGE - 1);
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    (data || []).forEach((r: any) => out.push(r.symbol));
    if (!data || data.length < PAGE) break;
    from += PAGE; if (from > 100000) break;
  }
  return out;
}

async function loadUniverse(supa: any): Promise<string[]> {
  const all = new Set<string>(BUILT_IN_WATCHLIST);
  for (const table of ['user_watchlist', 'rsi_universe']) {
    for (const raw of await pagedSymbols(supa, table)) {
      const sym = String(raw ?? '').trim().toUpperCase();
      if (SYMBOL_RE.test(sym)) all.add(sym);
    }
  }
  return [...all].sort();
}

const num = (value: unknown, decimals = 4): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 10 ** decimals) / 10 ** decimals : null;
};

// Extended-hours values are only meaningful for the current session: Yahoo keeps yesterday's post-market fields during PRE.
function quoteToRow(q: any, symbol: string, nowIso: string): any | null {
  const price = num(q.regularMarketPrice);
  if (price === null) return null; // nothing usable: leave the previous row in place
  const state = typeof q.marketState === 'string' ? q.marketState : null;
  let ext: { p: unknown, c: unknown, pct: unknown } = { p: null, c: null, pct: null };
  if (state === 'PRE') ext = { p: q.preMarketPrice, c: q.preMarketChange, pct: q.preMarketChangePercent };
  else if (state === 'POST' || state === 'POSTPOST') ext = { p: q.postMarketPrice, c: q.postMarketChange, pct: q.postMarketChangePercent };
  return {
    symbol, price,
    change: num(q.regularMarketChange), change_pct: num(q.regularMarketChangePercent), prev_close: num(q.regularMarketPreviousClose),
    volume: q.regularMarketVolume != null && Number.isFinite(Number(q.regularMarketVolume)) ? Math.round(Number(q.regularMarketVolume)) : null,
    market_state: state,
    ext_price: num(ext.p), ext_change: num(ext.c), ext_change_pct: num(ext.pct),
    quote_time: q.regularMarketTime ? new Date(Number(q.regularMarketTime) * 1000).toISOString() : null,
    updated_at: nowIso,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  const startedAt = Date.now();

  try {
    const body = await req.json().catch(() => ({}));
    if (!body.force && !insideWindow()) return json({ ran: false, skipped: 'outside window' });

    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const symbols = await loadUniverse(supa);

    // One handshake per run; a 401 triggers a (serialised) re-handshake, at most MAX_REHANDSHAKES times.
    let session: YahooSession | null = await yahooSession(FETCH_TIMEOUT_MS);
    if (!session) return json({ ran: true, symbols: symbols.length, ok: 0, missing: symbols.length, requests: 0, error: 'yahoo_handshake_failed', ms: Date.now() - startedAt }, 502);
    let rehandshakes = 0; let refresh: Promise<void> | null = null;
    const rehandshake = async (stale: YahooSession) => {
      if (session !== stale) return; // another worker already refreshed it
      if (!refresh) refresh = (async () => { rehandshakes++; session = await yahooSession(FETCH_TIMEOUT_MS) || session; })().finally(() => { refresh = null; });
      await refresh;
    };

    const batches: string[][] = [];
    for (let i = 0; i < symbols.length; i += BATCH_SIZE) batches.push(symbols.slice(i, i + BATCH_SIZE));

    const nowIso = new Date().toISOString();
    const rows: any[] = [];
    const statuses: Record<string, number> = {};
    let requests = 0; let cursor = 0;

    const worker = async () => {
      while (cursor < batches.length) {
        const batch = batches[cursor++];
        const yahooToOurs = new Map(batch.map(s => [s.replace('.', '-'), s]));
        for (let attempt = 0; attempt <= MAX_REHANDSHAKES; attempt++) {
          const used = session!;
          requests++;
          try {
            const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent([...yahooToOurs.keys()].join(','))}&fields=${QUOTE_FIELDS}&crumb=${encodeURIComponent(used.crumb)}`;
            const res = await fetch(url, { headers: { 'User-Agent': YAHOO_UA, Cookie: used.cookie }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
            statuses[res.status] = (statuses[res.status] || 0) + 1;
            if (res.status === 401 && rehandshakes < MAX_REHANDSHAKES) { try { await res.body?.cancel(); } catch (_) { /* ignore */ } await rehandshake(used); continue; }
            if (!res.ok) { try { await res.body?.cancel(); } catch (_) { /* ignore */ } console.error('[price-scan] batch HTTP', res.status); break; }
            const result = (await res.json())?.quoteResponse?.result || [];
            for (const q of result) {
              const symbol = yahooToOurs.get(String(q.symbol));
              const row = symbol ? quoteToRow(q, symbol, nowIso) : null;
              if (row) rows.push(row);
            }
            break;
          } catch (e) {
            statuses['exc'] = (statuses['exc'] || 0) + 1;
            console.error('[price-scan] batch failed:', String(e).slice(0, 80));
            break;
          }
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    // Symbols Yahoo didn't return (or returned without a price) are simply not written, so their previous row stays.
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supa.from('price_live').upsert(rows.slice(i, i + 500), { onConflict: 'symbol' });
      if (error) throw new Error('price_live upsert failed: ' + error.message);
    }
    const ms = Date.now() - startedAt;
    console.log(`[price-scan] symbols=${symbols.length} ok=${rows.length} missing=${symbols.length - rows.length} requests=${requests} statuses=${JSON.stringify(statuses)} rehandshakes=${rehandshakes} ms=${ms}`);
    return json({ ran: true, symbols: symbols.length, ok: rows.length, missing: symbols.length - rows.length, requests, statuses, rehandshakes, ms });
  } catch (e) {
    console.error('[price-scan]', String(e).slice(0, 200));
    return json({ error: String(e) }, 500);
  }
});
