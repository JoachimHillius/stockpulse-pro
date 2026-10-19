import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

const CHUNK_SIZE = 50;          // hard cap per compute_mover_indicators call
const QUOTE_CONCURRENCY = 10;
const TIME_BUDGET_MS = 100_000; // hand off to a new invocation after this

// ET wall-clock start of each scheduled slot, in minutes after midnight.
const SLOT_START_MIN: Record<string, number> = {
  open: 9 * 60 + 35,
  midday: 12 * 60 + 30,
  close: 15 * 60 + 30,
};
const WINDOW_MIN = 10;

const YAHOO_ALIAS: Record<string, string> = {
  VIX:'^VIX', VVIX:'^VVIX', SPX:'^GSPC', NDX:'^NDX', DJI:'^DJI', DJX:'^DJI',
  RUT:'^RUT', TNX:'^TNX', XAU:'^XAU', BRKB:'BRK-B', BFB:'BF-B',
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function easternNow(): { weekday: string, minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(new Date());
  const get = (type: string) => parts.find(p => p.type === type)?.value || '';
  // hour12:false can render midnight as "24"
  return { weekday: get('weekday'), minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')) };
}

function insideSlotWindow(slot: string): boolean {
  const { weekday, minutes } = easternNow();
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const delta = minutes - SLOT_START_MIN[slot];
  return delta >= 0 && delta <= WINDOW_MIN;
}

// Copied from sync-price-history (live mode).
async function fetchLiveQuote(symbol: string): Promise<{row: any, error?: string, used?: string}> {
  const fetchSymbol = YAHOO_ALIAS[symbol] || symbol;
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(fetchSymbol)}?range=1d&interval=1m&includePrePost=true`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StockPulseSync/1.0)' } });
    if (!r.ok) return { row: null, error: `HTTP ${r.status}` };
    const data = await r.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return { row: null, error: 'no_meta' };
    const pre = meta.preMarketPrice;
    const reg = meta.regularMarketPrice;
    const prev = meta.previousClose ?? meta.chartPreviousClose;
    let price: number | null = null; let used = '';
    if (pre != null) { price = Number(pre); used = 'pre'; }
    else if (reg != null) { price = Number(reg); used = 'regular'; }
    else if (prev != null) { price = Number(prev); used = 'prev_close'; }
    if (price == null || !isFinite(price)) return { row: null, error: 'no_price_in_meta' };
    const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const trading_date = etNow.toISOString().slice(0, 10);
    const dayOpen = meta.regularMarketOpen != null ? Number(meta.regularMarketOpen) : price;
    const dayHigh = meta.regularMarketDayHigh != null ? Number(meta.regularMarketDayHigh) : price;
    const dayLow  = meta.regularMarketDayLow  != null ? Number(meta.regularMarketDayLow)  : price;
    const dayVol  = meta.regularMarketVolume  != null ? Number(meta.regularMarketVolume)  : null;
    return {
      row: {
        symbol, trading_date,
        open: Number(dayOpen.toFixed(4)),
        high: Number(dayHigh.toFixed(4)),
        low:  Number(dayLow.toFixed(4)),
        close: Number(price.toFixed(4)),
        volume: dayVol,
      },
      used,
    };
  } catch (e) {
    return { row: null, error: 'live_' + String(e).slice(0,40) };
  }
}

// Same update-then-insert logic as sync-price-history live mode.
async function writeTodayBar(supa: any, row: any, nowIso: string): Promise<string | null> {
  const { data: upd, error: updErr } = await supa.from('price_history')
    .update({ open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume, fetched_at: nowIso })
    .eq('symbol', row.symbol).eq('trading_date', row.trading_date)
    .select('id');
  if (updErr) return 'update_' + updErr.message;
  if (upd && upd.length) return null;
  const { error: insErr } = await supa.from('price_history').insert(row);
  return insErr ? 'insert_' + insErr.message : null;
}

async function loadUniverse(supa: any): Promise<string[]> {
  const PAGE = 1000;
  const uniq = new Set<string>();
  let from = 0;
  while (true) {
    const { data, error } = await supa.rpc('get_mover_universe').range(from, from + PAGE - 1);
    if (error) throw new Error('get_mover_universe failed: ' + error.message);
    (data || []).forEach((r: any) => { if (r.symbol) uniq.add(r.symbol); });
    if (!data || data.length < PAGE) break;
    from += PAGE; if (from > 100000) break;
  }
  // Sorted so offsets stay stable across self-invocations.
  return [...uniq].sort();
}

async function refreshQuotes(supa: any, symbols: string[]): Promise<{ok: number, failed: number}> {
  let ok = 0; let failed = 0;
  for (let i = 0; i < symbols.length; i += QUOTE_CONCURRENCY) {
    const wave = symbols.slice(i, i + QUOTE_CONCURRENCY);
    const nowIso = new Date().toISOString();
    const outcomes = await Promise.all(wave.map(async (symbol) => {
      const { row, error } = await fetchLiveQuote(symbol);
      if (error || !row) return false;
      return (await writeTodayBar(supa, row, nowIso)) === null;
    }));
    outcomes.forEach(o => o ? ok++ : failed++);
    await sleep(150);
  }
  return { ok, failed };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const startedAt = Date.now();
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

  try {
    const body = await req.json().catch(() => ({}));
    const slot: string = body.slot || 'manual';
    const offset: number = Math.max(0, Number(body.offset) || 0);
    if (!['open', 'midday', 'close', 'manual'].includes(slot)) return json({ error: 'invalid slot' }, 400);

    // Gate only the first invocation: continuations of an admitted run may finish after the window closes.
    if (slot !== 'manual' && offset === 0 && !insideSlotWindow(slot)) return json({ skipped: 'outside window' });

    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const universe = await loadUniverse(supa);

    let next = offset;
    let quotesOk = 0; let quotesFailed = 0; let indicatorRows = 0; let chunksDone = 0;
    const chunkErrors: string[] = [];

    while (next < universe.length) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        // Fire-and-forget: abort after the request is on the wire so we don't wait for the next run to finish.
        const controller = new AbortController();
        const handoff = fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/mover-scan`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slot, offset: next }),
          signal: controller.signal,
        }).catch(() => {});
        await Promise.race([handoff, sleep(3000)]);
        controller.abort();
        return json({ continued_at: next, universe_size: universe.length, chunks_done: chunksDone,
          quotes_ok: quotesOk, quotes_failed: quotesFailed, indicator_rows: indicatorRows, chunk_errors: chunkErrors });
      }

      const chunk = universe.slice(next, next + CHUNK_SIZE);
      const quotes = await refreshQuotes(supa, chunk);
      quotesOk += quotes.ok; quotesFailed += quotes.failed;

      const { data: upserted, error: rpcErr } = await supa.rpc('compute_mover_indicators', { p_symbols: chunk });
      if (rpcErr) {
        console.error('[compute_mover_indicators]', next, rpcErr.message);
        chunkErrors.push(`${next}: ${rpcErr.message}`);
      } else {
        indicatorRows += Number(upserted) || 0;
      }
      chunksDone++;
      next += CHUNK_SIZE;
    }

    const { data: ranked, error: rankErr } = await supa.rpc('rank_movers', { p_slot: slot });
    if (rankErr) return json({ error: 'rank_movers failed: ' + rankErr.message, slot }, 500);

    return json({ done: true, slot, universe_size: universe.length, ranked: ranked,
      chunks_done: chunksDone, quotes_ok: quotesOk, quotes_failed: quotesFailed,
      indicator_rows: indicatorRows, chunk_errors: chunkErrors, elapsed_ms: Date.now() - startedAt });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
