import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

const MIN_BARS = 20;

const YAHOO_ALIAS: Record<string, string> = {
  VIX:'^VIX', VVIX:'^VVIX', SPX:'^GSPC', NDX:'^NDX', DJI:'^DJI', DJX:'^DJI',
  RUT:'^RUT', TNX:'^TNX', XAU:'^XAU', BRKB:'BRK-B', BFB:'BF-B',
};

function dedupeByDate(rows: any[]): any[] {
  const byDate = new Map<string, any>();
  for (const row of rows) byDate.set(row.trading_date, row);
  return [...byDate.values()].sort((a, b) => a.trading_date < b.trading_date ? -1 : 1);
}

function parseChart(result: any, symbol: string): any[] {
  const ts = result?.timestamp;
  const q = result?.indicators?.quote?.[0];
  if (!ts || !ts.length || !q) return [];
  const rows: any[] = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null) continue;
    rows.push({
      symbol,
      trading_date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
      open: q.open[i] != null ? Number(q.open[i].toFixed(4)) : null,
      high: q.high[i] != null ? Number(q.high[i].toFixed(4)) : null,
      low: q.low[i] != null ? Number(q.low[i].toFixed(4)) : null,
      close: q.close[i] != null ? Number(q.close[i].toFixed(4)) : null,
      volume: q.volume[i] != null ? Number(q.volume[i]) : null,
    });
  }
  return rows;
}

async function yahooFetch(fetchSymbol: string, range: string): Promise<{result: any, httpError?: string}> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(fetchSymbol)}?range=${range}&interval=1d`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StockPulseSync/1.0)' } });
  if (!r.ok) return { result: null, httpError: `HTTP ${r.status}` };
  const data = await r.json();
  return { result: data?.chart?.result?.[0] || null };
}

async function fromYahooChart(symbol: string): Promise<{rows: any[], error?: string}> {
  const fetchSymbol = YAHOO_ALIAS[symbol] || symbol;
  try {
    let { result, httpError } = await yahooFetch(fetchSymbol, '10y');
    if (httpError) return { rows: [], error: `${httpError}` };
    if (!result) return { rows: [], error: 'no_result' };
    let rows = parseChart(result, symbol);
    if (rows.length >= MIN_BARS) return { rows };
    const valid: string[] = result?.meta?.validRanges || [];
    // Younger stocks: take whatever history exists, longest range first.
    for (const range of ['max','5y','2y','1y'].filter(r => valid.includes(r))) {
      const attempt = await yahooFetch(fetchSymbol, range);
      if (attempt.httpError || !attempt.result) continue;
      rows = parseChart(attempt.result, symbol);
      if (rows.length >= MIN_BARS) return { rows };
      await new Promise(r => setTimeout(r, 100));
    }
    return { rows: [], error: `chart_thin (bars=${rows.length}, valid=${valid.join('|')||'none'})` };
  } catch (e) {
    return { rows: [], error: 'chart_' + String(e).slice(0,40) };
  }
}

// Incremental path: last month only. Any non-empty result is valid (no MIN_BARS).
async function fromYahooRecent(symbol: string): Promise<{rows: any[], error?: string}> {
  const fetchSymbol = YAHOO_ALIAS[symbol] || symbol;
  try {
    const { result, httpError } = await yahooFetch(fetchSymbol, '1mo');
    if (httpError) return { rows: [], error: httpError };
    if (!result) return { rows: [], error: 'no_result' };
    const rows = parseChart(result, symbol);
    return rows.length >= 1 ? { rows } : { rows: [], error: 'recent_empty' };
  } catch (e) {
    return { rows: [], error: 'recent_' + String(e).slice(0,40) };
  }
}

async function fromYahooCsv(symbol: string): Promise<{rows: any[], error?: string}> {
  const fetchSymbol = YAHOO_ALIAS[symbol] || symbol;
  try {
    const p2 = Math.floor(Date.now() / 1000);
    const p1 = p2 - 10 * 365 * 24 * 60 * 60;
    const url = `https://query2.finance.yahoo.com/v7/finance/download/${encodeURIComponent(fetchSymbol)}?period1=${p1}&period2=${p2}&interval=1d&events=history`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return { rows: [], error: `csv_HTTP_${r.status}` };
    const text = await r.text();
    if (!text || text.startsWith('{') || text.startsWith('<') || !text.includes(',')) return { rows: [], error: 'csv_no_data' };
    const lines = text.trim().split('\n');
    if (lines.length < 2) return { rows: [], error: 'csv_empty' };
    const rows: any[] = [];
    for (const line of lines.slice(1)) {
      const p = line.split(',');
      if (p.length < 7) continue;
      const close = parseFloat(p[4]);
      if (!isFinite(close)) continue;
      rows.push({
        symbol, trading_date: p[0],
        open:  isFinite(parseFloat(p[1])) ? Number(parseFloat(p[1]).toFixed(4)) : null,
        high:  isFinite(parseFloat(p[2])) ? Number(parseFloat(p[2]).toFixed(4)) : null,
        low:   isFinite(parseFloat(p[3])) ? Number(parseFloat(p[3]).toFixed(4)) : null,
        close: Number(close.toFixed(4)),
        volume: isFinite(parseFloat(p[6])) ? Number(parseFloat(p[6])) : null,
      });
    }
    return rows.length >= MIN_BARS ? { rows } : { rows: [], error: `csv_thin (bars=${rows.length})` };
  } catch (e) {
    return { rows: [], error: 'csv_' + String(e).slice(0,40) };
  }
}

async function fetchHistory(symbol: string): Promise<{rows: any[], error?: string, source?: string}> {
  const a = await fromYahooChart(symbol);
  if (a.rows.length >= MIN_BARS) return { rows: a.rows, source: 'chart' };
  const b = await fromYahooCsv(symbol);
  if (b.rows.length >= MIN_BARS) return { rows: b.rows, source: 'csv' };
  return { rows: [], error: `chart[${a.error}] csv[${b.error}]` };
}

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

async function getAllUniqueSymbols(supa: any): Promise<string[]> {
  // PostgREST caps a single response at 1,000 rows, so page through the RPC.
  const PAGE = 1000;
  const uniq = new Set<string>();
  let from = 0;
  while (true) {
    const { data, error } = await supa.rpc('get_sync_universe').range(from, from + PAGE - 1);
    if (error) throw new Error('get_sync_universe failed: ' + error.message);
    (data || []).forEach((r: any) => { if (r.symbol) uniq.add(r.symbol); });
    if (!data || data.length < PAGE) break;
    from += PAGE; if (from > 100000) break;
  }
  return [...uniq].sort();
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supa = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const body = await req.json().catch(() => ({}));
    const requestedTickers: string[] = body.tickers || [];
    const forceRefresh: boolean = !!body.force_refresh;
    const liveMode: boolean = !!body.live;
    const maxBatch: number = Math.min(body.max_batch || 30, 60);
    const staleDays: number = Number(body.stale_days ?? 1);
    const deadAfter: number = Number(body.dead_after ?? 5);

    let tickers = requestedTickers.filter(t => typeof t === 'string' && t.length > 0 && t.length <= 6);
    let universeSize = tickers.length;

    if (tickers.length === 0) {
      tickers = await getAllUniqueSymbols(supa);
      universeSize = tickers.length;
    }

    // ===== LIVE MODE =====
    if (liveMode) {
      const todo = tickers.slice(0, maxBatch);
      const results: any[] = [];
      const nowIso = new Date().toISOString();
      for (const symbol of todo) {
        const { row, error, used } = await fetchLiveQuote(symbol);
        if (error || !row) { results.push({ symbol, status: 'error', error }); continue; }
        const { data: upd, error: updErr } = await supa.from('price_history')
          .update({ open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume, fetched_at: nowIso })
          .eq('symbol', row.symbol).eq('trading_date', row.trading_date)
          .select('id');
        if (updErr) { results.push({ symbol, status: 'error', error: 'update_' + updErr.message }); continue; }
        let wrote = (upd && upd.length) ? upd.length : 0;
        if (wrote === 0) {
          const { error: insErr } = await supa.from('price_history').insert(row);
          if (insErr) { results.push({ symbol, status: 'error', error: 'insert_' + insErr.message }); continue; }
          wrote = 1;
        }
        const { error: liveStatusErr } = await supa.from('price_sync_status').upsert(
          { symbol: row.symbol, last_synced_at: nowIso, last_status: 'success',
            rows_loaded: 1, latest_date: row.trading_date, error_message: 'live_quote', fail_streak: 0 },
          { onConflict: 'symbol' }
        );
        if (liveStatusErr) console.error('[sync_status live]', symbol, liveStatusErr.message);
        results.push({ symbol, status: 'success', price: row.close, used, wrote });
      }
      const ok = results.filter(r => r.status === 'success').length;
      return new Response(JSON.stringify({
        version: 'v11-live', mode: 'live', requested: todo.length,
        succeeded: ok, failed: todo.length - ok, results,
      }), { headers: { ...corsHeaders, 'Content-Type':'application/json' } });
    }
    // ===== END LIVE MODE =====

    if (!forceRefresh) {
      const skipSet = new Set<string>();
      const PAGE = 1000;
      const cutoff = new Date(Date.now() - staleDays * 864e5).toISOString();
      let from = 0;
      while (true) {
        const { data } = await supa.from('price_sync_status')
          .select('symbol').eq('last_status','success').gte('last_synced_at',cutoff)
          .order('symbol').range(from, from+PAGE-1);
        if (!data || !data.length) break;
        data.forEach((s:any)=>skipSet.add(s.symbol));
        if (data.length < PAGE) break;
        from += PAGE; if (from > 100000) break;
      }
      if (deadAfter > 0) {
        from = 0;
        while (true) {
          const { data } = await supa.from('price_sync_status')
            .select('symbol, fail_streak').eq('last_status','error').gte('fail_streak',deadAfter)
            .order('symbol').range(from, from+PAGE-1);
          if (!data || !data.length) break;
          data.forEach((s:any)=>skipSet.add(s.symbol));
          if (data.length < PAGE) break;
          from += PAGE; if (from > 100000) break;
        }
      }
      tickers = tickers.filter(t => !skipSet.has(t));
    }

    const todo = tickers.slice(0, maxBatch);
    const remaining = tickers.length - todo.length;
    const results: any[] = [];

    for (const symbol of todo) {
      const { data: statusRow } = await supa.from('price_sync_status')
        .select('full_history_loaded, earliest_date').eq('symbol', symbol).maybeSingle();
      const incremental = !forceRefresh && statusRow?.full_history_loaded === true;

      const { rows: rawRows, error, source } = incremental
        ? { ...(await fromYahooRecent(symbol)), source: 'chart_1mo' }
        : await fetchHistory(symbol);

      if (error || rawRows.length < (incremental ? 1 : MIN_BARS)) {
        const { data: prev } = await supa.from('price_sync_status')
          .select('fail_streak').eq('symbol', symbol).maybeSingle();
        const streak = (prev?.fail_streak || 0) + 1;
        const { error: errStatusErr } = await supa.from('price_sync_status').upsert(
          { symbol, last_synced_at: new Date().toISOString(), last_status: 'error',
            rows_loaded: 0, error_message: error || 'thin', fail_streak: streak },
          { onConflict: 'symbol' }
        );
        if (errStatusErr) console.error('[sync_status error]', symbol, errStatusErr.message);
        results.push({ symbol, status:'error', error, fail_streak: streak });
        continue;
      }

      const rows = dedupeByDate(rawRows);

      const { error: insErr } = await supa.from('price_history')
        .upsert(rows, { onConflict: 'symbol,trading_date', ignoreDuplicates: false });
      if (insErr) {
        const { error: dbStatusErr } = await supa.from('price_sync_status').upsert(
          { symbol, last_synced_at: new Date().toISOString(), last_status: 'error',
            rows_loaded: 0, error_message: insErr.message, fail_streak: 1 },
          { onConflict: 'symbol' }
        );
        if (dbStatusErr) console.error('[sync_status db_error]', symbol, dbStatusErr.message);
        results.push({ symbol, status:'db_error', error: insErr.message });
        continue;
      }

      const latest = rows[rows.length-1].trading_date;
      // earliest_date must stay the true oldest date; an incremental run only sees ~1 month.
      const earliest = statusRow?.earliest_date && statusRow.earliest_date < rows[0].trading_date
        ? statusRow.earliest_date : rows[0].trading_date;

      // Always set last_status='success' — never leave a completed sync as 'pending'.
      // onConflict:'symbol' is explicit so the upsert always updates the existing row.
      const { error: syncStatusErr } = await supa.from('price_sync_status').upsert(
        {
          symbol, last_synced_at: new Date().toISOString(), last_status: 'success',
          rows_loaded: rows.length, earliest_date: earliest, latest_date: latest,
          error_message: source === 'csv' ? 'via_csv_fallback' : null, fail_streak: 0,
          ...(incremental ? {} : { full_history_loaded: true }),
        },
        { onConflict: 'symbol' }
      );
      if (syncStatusErr) {
        // upsert failed — log it and flag the result as an error so the client
        // knows this symbol needs to be retried despite the data write succeeding.
        console.error('[sync_status success]', symbol, syncStatusErr.message);
        results.push({ symbol, status: 'error', error: 'sync_status_write: ' + syncStatusErr.message,
          count: rows.length, earliest, latest, source });
        continue;
      }

      results.push({ symbol, status:'success', count: rows.length, earliest, latest, source });
      await new Promise(r => setTimeout(r, 150));
    }

    const succeeded = results.filter(r=>r.status==='success').length;
    const viaCsv = results.filter(r=>r.source==='csv').length;
    const failed = results.length - succeeded;
    const totalRows = results.reduce((s,r)=>s+(r.count||0),0);

    return new Response(JSON.stringify({
      version:'v12', min_bars:MIN_BARS, universe_size:universeSize, processed:results.length,
      succeeded, failed, via_csv: viaCsv, total_rows_inserted: totalRows,
      remaining, results,
    }), { headers: { ...corsHeaders, 'Content-Type':'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status:500, headers: { ...corsHeaders, 'Content-Type':'application/json' }
    });
  }
});
