// wide-scan — tier 2 of the spike alerts.
// Every 5 minutes (ET weekdays 04:00–20:05) it prices every Nasdaq / NYSE / AMEX common stock that is NOT already in the
// priority scan (price-scan: built-in watchlist + user_watchlist + rsi_universe) and stores the quotes in market_live.
// A stock up >= PROMOTE_PCT today (price >= $0.10) is promoted into hot_list for the rest of the day; promoted stocks are
// written into price_live every run, so check_spike_alerts() gives them the same 👀 / ⚡ alerts as Watchlist stocks.
// The symbol list (market_symbols) is refreshed from nasdaqtrader.com when it is older than 6 days (or body.refresh_symbols).
// No price history is loaded for these stocks; the volume check uses Yahoo's 10-day average volume.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const YAHOO_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
interface YahooSession { cookie: string; crumb: string; }
async function yahooSession(timeoutMs = 10_000): Promise<YahooSession | null> {
  try {
    const home = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': YAHOO_UA }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    const setCookie = home.headers.get('set-cookie') || '';
    const cookie = setCookie.split(',').map(c => c.trim().split(';')[0]).filter(c => c.startsWith('A')).join('; ') || setCookie.split(';')[0];
    const res = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': YAHOO_UA, Cookie: cookie }, signal: AbortSignal.timeout(timeoutMs) });
    const crumb = await res.text();
    return res.ok && crumb.length > 0 && crumb.length < 40 && !/\s/.test(crumb) ? { cookie, crumb } : null;
  } catch (_) { return null; }
}

// Keep in sync with price-scan's BUILT_IN_WATCHLIST (those are already priced by the priority scan).
const BUILT_IN_WATCHLIST = new Set([
  'A', 'AA', 'AAL', 'AAPL', 'ADBE', 'AEP', 'AMD', 'AMZN', 'APD', 'APLD', 'AVGO', 'AXP', 'B', 'BABA', 'BAC',
  'BE', 'BMNR', 'BTDR', 'C', 'CAR', 'CCJ', 'CEG', 'CELH', 'CENX', 'CIFR', 'CL', 'CLF', 'CLSK', 'CMG', 'COIN',
  'COP', 'COST', 'CRCL', 'CRH', 'CRM', 'CSTM', 'CTVA', 'CVS', 'CVX', 'D', 'DAL', 'DUK', 'EEM', 'ET', 'EXC',
  'FANG', 'FCX', 'FLNC', 'FMC', 'FNMA', 'FSLR', 'GDX', 'GLD', 'GOOGL', 'HL', 'HOOD', 'HUM', 'HYG', 'IBIT',
  'INTC', 'IREN', 'IWM', 'JPM', 'KALU', 'KMI', 'KO', 'LEVI', 'LIN', 'MARA', 'MDLZ', 'META', 'MLM', 'MNST',
  'MO', 'MRNA', 'MRVL', 'MSFT', 'MSTR', 'MU', 'NEE', 'NEM', 'NFLX', 'NKE', 'NUE', 'NVDA', 'ONDS', 'ORCL',
  'OXY', 'PEP', 'PFE', 'PG', 'PL', 'PLTR', 'PM', 'PSX', 'PTON', 'PYPL', 'QBTS', 'QCOM', 'QQQ', 'R', 'RIG',
  'RIO', 'RIVN', 'RR', 'RS', 'SCHW', 'SHEL', 'SLB', 'SLV', 'SMCI', 'SOFI', 'SOXL', 'SPY', 'SRE', 'T', 'TMUS',
  'TSLA', 'TTD', 'TTE', 'UNF', 'UNH', 'V', 'VST', 'VZ', 'WFC', 'WMB', 'WMT', 'WULF', 'XEL', 'XLE', 'XOM',
]);

const PROMOTE_PCT = 10;
const MIN_PRICE = 0.10;
const BATCH_SIZE = 100;
const CONCURRENCY = 3;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REHANDSHAKES = 3;
const WINDOW_START_MIN = 4 * 60;
const WINDOW_END_MIN = 20 * 60 + 5;
const SYMBOL_RE = /^[A-Z]{1,5}$/;
const SKIP_NAME_RE = /\b(warrants?|rights?|units?|preferred|depositary shares? representing|notes due|debentures)\b/i;
const QUOTE_FIELDS = ['symbol', 'regularMarketPrice', 'regularMarketChange', 'regularMarketChangePercent', 'regularMarketPreviousClose',
  'regularMarketVolume', 'regularMarketTime', 'marketState', 'preMarketPrice', 'preMarketChange', 'preMarketChangePercent',
  'postMarketPrice', 'postMarketChange', 'postMarketChangePercent', 'averageDailyVolume10Day'].join(',');

const etParts = (d: Date) => Object.fromEntries(new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
}).formatToParts(d).map(p => [p.type, p.value]));
function insideWindow(): boolean {
  const p = etParts(new Date());
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return false;
  const minutes = (Number(p.hour) % 24) * 60 + Number(p.minute);
  return minutes >= WINDOW_START_MIN && minutes <= WINDOW_END_MIN;
}
const etDate = () => { const p = etParts(new Date()); return `${p.year}-${p.month}-${p.day}`; };

const num = (value: unknown, decimals = 4): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 10 ** decimals) / 10 ** decimals : null;
};

async function pagedSymbols(supa: any, table: string, extra?: (q: any) => any): Promise<string[]> {
  const PAGE = 1000; const out: string[] = []; let from = 0;
  while (true) {
    let q = supa.from(table).select('symbol').order('symbol').range(from, from + PAGE - 1);
    if (extra) q = extra(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    (data || []).forEach((r: any) => out.push(String(r.symbol || '').toUpperCase()));
    if (!data || data.length < PAGE) break;
    from += PAGE; if (from > 200000) break;
  }
  return out;
}

// Nasdaq Trader symbol directory: nasdaqlisted.txt (Nasdaq) + otherlisted.txt (NYSE, NYSE American, NYSE Arca, Cboe…).
async function refreshSymbolList(supa: any): Promise<number> {
  const rows = new Map<string, { symbol: string; exchange: string; name: string }>();
  const get = async (url: string) => {
    const r = await fetch(url, { headers: { 'User-Agent': YAHOO_UA }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`${url} HTTP ${r.status}`);
    return (await r.text()).split(/\r?\n/);
  };
  // Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares
  for (const line of (await get('https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt')).slice(1)) {
    const f = line.split('|');
    if (f.length < 7 || f[0].startsWith('File Creation')) continue;
    const [sym, name, , test, , , etf] = f;
    if (test !== 'N' || etf !== 'N' || !SYMBOL_RE.test(sym) || SKIP_NAME_RE.test(name)) continue;
    if (sym.length === 5 && /[WRU]$/.test(sym)) continue; // Nasdaq 5th-letter codes: W warrant, R rights, U unit
    rows.set(sym, { symbol: sym, exchange: 'NASDAQ', name: name.slice(0, 120) });
  }
  // ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol
  const exch: Record<string, string> = { N: 'NYSE', A: 'NYSE American', P: 'NYSE Arca', Z: 'Cboe BZX', V: 'IEX' };
  for (const line of (await get('https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt')).slice(1)) {
    const f = line.split('|');
    if (f.length < 7 || f[0].startsWith('File Creation')) continue;
    const [sym, name, ex, , etf, , test] = f;
    if (test !== 'N' || etf !== 'N' || !SYMBOL_RE.test(sym) || SKIP_NAME_RE.test(name)) continue;
    if (!['N', 'A'].includes(ex)) continue; // NYSE + NYSE American common stocks
    rows.set(sym, { symbol: sym, exchange: exch[ex] || ex, name: name.slice(0, 120) });
  }
  if (rows.size < 3000) throw new Error(`symbol list too small (${rows.size}) — not replacing`);
  const nowIso = new Date().toISOString();
  const list = [...rows.values()].map(r => ({ ...r, updated_at: nowIso }));
  for (let i = 0; i < list.length; i += 1000) {
    const { error } = await supa.from('market_symbols').upsert(list.slice(i, i + 1000), { onConflict: 'symbol' });
    if (error) throw new Error('market_symbols upsert failed: ' + error.message);
  }
  // Drop delisted symbols (not seen in this refresh).
  await supa.from('market_symbols').delete().lt('updated_at', nowIso);
  return list.length;
}

Deno.serve(async (req: Request) => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const startedAt = Date.now();
  try {
    const body = await req.json().catch(() => ({}));
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // 1. Symbol list (weekly, or on request).
    let refreshed: number | null = null;
    const { data: newest } = await supa.from('market_symbols').select('updated_at').order('updated_at', { ascending: false }).limit(1);
    const stale = !newest?.length || (Date.now() - new Date(newest[0].updated_at).getTime()) > 6 * 86400_000;
    if (body.refresh_symbols || stale) {
      try { refreshed = await refreshSymbolList(supa); } catch (e) { console.error('[wide-scan] symbol refresh failed:', String(e).slice(0, 160)); }
    }
    if (!body.force && !insideWindow()) return json({ ran: false, skipped: 'outside window', refreshed });

    // 2. Universe = market symbols minus the priority scan's symbols.
    const priority = new Set<string>([...BUILT_IN_WATCHLIST, ...await pagedSymbols(supa, 'user_watchlist'), ...await pagedSymbols(supa, 'rsi_universe')]);
    const symbols = (await pagedSymbols(supa, 'market_symbols')).filter(s => !priority.has(s));

    // 3. Quotes.
    let session: YahooSession | null = await yahooSession(FETCH_TIMEOUT_MS);
    if (!session) return json({ ran: true, symbols: symbols.length, ok: 0, error: 'yahoo_handshake_failed', ms: Date.now() - startedAt }, 502);
    let rehandshakes = 0; let refresh: Promise<void> | null = null;
    const rehandshake = async (used: YahooSession) => {
      if (session !== used) return;
      if (!refresh) refresh = (async () => { rehandshakes++; session = await yahooSession(FETCH_TIMEOUT_MS) || session; })().finally(() => { refresh = null; });
      await refresh;
    };
    const batches: string[][] = [];
    for (let i = 0; i < symbols.length; i += BATCH_SIZE) batches.push(symbols.slice(i, i + BATCH_SIZE));
    const nowIso = new Date().toISOString();
    const quotes: any[] = [];
    const statuses: Record<string, number> = {};
    let cursor = 0;
    const worker = async () => {
      while (cursor < batches.length) {
        const batch = batches[cursor++];
        for (let attempt = 0; attempt <= MAX_REHANDSHAKES; attempt++) {
          const used = session!;
          try {
            const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(batch.join(','))}&fields=${QUOTE_FIELDS}&crumb=${encodeURIComponent(used.crumb)}`;
            const res = await fetch(url, { headers: { 'User-Agent': YAHOO_UA, Cookie: used.cookie }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
            statuses[res.status] = (statuses[res.status] || 0) + 1;
            if (res.status === 401 && rehandshakes < MAX_REHANDSHAKES) { try { await res.body?.cancel(); } catch (_) { /**/ } await rehandshake(used); continue; }
            if (!res.ok) { try { await res.body?.cancel(); } catch (_) { /**/ } break; }
            quotes.push(...((await res.json())?.quoteResponse?.result || []));
            break;
          } catch (e) {
            statuses['exc'] = (statuses['exc'] || 0) + 1;
            console.error('[wide-scan] batch failed:', String(e).slice(0, 80));
            break;
          }
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    // 4. market_live rows.
    const liveRows: any[] = []; const priceRows = new Map<string, any>();
    for (const q of quotes) {
      const symbol = String(q.symbol || '').toUpperCase();
      const price = num(q.regularMarketPrice);
      if (!symbol || price === null) continue;
      const state = typeof q.marketState === 'string' ? q.marketState : null;
      let ext: { p: unknown, c: unknown, pct: unknown } = { p: null, c: null, pct: null };
      if (state === 'PRE') ext = { p: q.preMarketPrice, c: q.preMarketChange, pct: q.preMarketChangePercent };
      else if (state === 'POST' || state === 'POSTPOST') ext = { p: q.postMarketPrice, c: q.postMarketChange, pct: q.postMarketChangePercent };
      const volume = q.regularMarketVolume != null && Number.isFinite(Number(q.regularMarketVolume)) ? Math.round(Number(q.regularMarketVolume)) : null;
      liveRows.push({
        symbol, price, change_pct: num(q.regularMarketChangePercent), prev_close: num(q.regularMarketPreviousClose), volume,
        avg_vol10: q.averageDailyVolume10Day != null ? Math.round(Number(q.averageDailyVolume10Day)) : null,
        market_state: state, ext_price: num(ext.p), ext_change_pct: num(ext.pct), updated_at: nowIso,
      });
      // Same shape price-scan writes to price_live (used only for promoted stocks).
      priceRows.set(symbol, {
        symbol, price, change: num(q.regularMarketChange), change_pct: num(q.regularMarketChangePercent), prev_close: num(q.regularMarketPreviousClose),
        volume, market_state: state, ext_price: num(ext.p), ext_change: num(ext.c), ext_change_pct: num(ext.pct),
        quote_time: q.regularMarketTime ? new Date(Number(q.regularMarketTime) * 1000).toISOString() : null, updated_at: nowIso,
      });
    }
    for (let i = 0; i < liveRows.length; i += 1000) {
      const { error } = await supa.from('market_live').upsert(liveRows.slice(i, i + 1000), { onConflict: 'symbol' });
      if (error) throw new Error('market_live upsert failed: ' + error.message);
    }

    // 5. Promotion: up >= PROMOTE_PCT today (extended-hours move in pre/post market), price >= MIN_PRICE.
    const today = etDate();
    const promote = liveRows.filter(r => {
      const ext = (r.market_state === 'PRE' || r.market_state === 'POST' || r.market_state === 'POSTPOST') && r.ext_price != null;
      const px = ext ? r.ext_price : r.price; const pct = ext ? r.ext_change_pct : r.change_pct;
      return px != null && px >= MIN_PRICE && pct != null && pct >= PROMOTE_PCT;
    }).map(r => {
      const ext = (r.market_state === 'PRE' || r.market_state === 'POST' || r.market_state === 'POSTPOST') && r.ext_price != null;
      return { symbol: r.symbol, hot_date: today, pct_at_promotion: ext ? r.ext_change_pct : r.change_pct, price_at_promotion: ext ? r.ext_price : r.price };
    });
    if (promote.length) {
      const { error } = await supa.from('hot_list').upsert(promote, { onConflict: 'symbol,hot_date', ignoreDuplicates: true });
      if (error) console.error('[wide-scan] hot_list upsert failed:', error.message);
    }

    // 6. Every promoted stock of today gets its fresh quote in price_live (→ 👀 / ⚡ alerts like the Watchlist).
    const { data: hot } = await supa.from('hot_list').select('symbol').eq('hot_date', today);
    const hotRows = (hot || []).map((h: any) => priceRows.get(h.symbol)).filter(Boolean);
    if (hotRows.length) {
      const { error } = await supa.from('price_live').upsert(hotRows, { onConflict: 'symbol' });
      if (error) console.error('[wide-scan] price_live upsert failed:', error.message);
    }

    const out = { ran: true, refreshed, symbols: symbols.length, ok: liveRows.length, promoted_now: promote.length, hot_today: hotRows.length,
      requests: batches.length, statuses, rehandshakes, ms: Date.now() - startedAt };
    console.log('[wide-scan]', JSON.stringify(out));
    return json(out);
  } catch (e) {
    console.error('[wide-scan]', String(e).slice(0, 200));
    return json({ error: String(e) }, 500);
  }
});
