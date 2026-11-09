import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

// Keep in sync with WATCHLIST in index.html
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

const CONCURRENCY = 6;
const FETCH_TIMEOUT_MS = 10_000;
const RSI_PERIOD = 14;
// ET scan slots (minutes after midnight) and how far either side of them the gate stays open.
const SLOTS_ET: Array<[string, number]> = [
  ['07:00', 7 * 60], ['09:00', 9 * 60], ['11:00', 11 * 60],
  ['13:00', 13 * 60], ['15:00', 15 * 60], ['16:15', 16 * 60 + 15],
];
const SLOT_TOLERANCE_MIN = 10;
const MAX_ALERT_LINES = 25;
const TIMEFRAMES = ['1h', '4h', '1d', '1w'] as const;
type Timeframe = typeof TIMEFRAMES[number];

interface Bar { date: string; close: number; }
interface HourBar { date: string; hour: number; ts: number; close: number; }

const etFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
});

function etParts(date: Date) {
  const parts = etFormatter.formatToParts(date);
  const pick = (type: string) => parts.find(p => p.type === type)?.value || '';
  return {
    date: `${pick('year')}-${pick('month')}-${pick('day')}`,
    weekday: pick('weekday'),
    hour: Number(pick('hour')) % 24, // hour12:false can render midnight as "24"
    minute: Number(pick('minute')),
  };
}

// Per-bar ET conversion dominated CPU (Intl.formatToParts ~260k calls per run). ET offsets are whole hours,
// so the ET date + hour depend only on the UTC hour; all symbols share these timestamps, so memoise per UTC hour.
const etHourCache = new Map<number, { date: string, hour: number }>();
function etDateHour(unixSeconds: number): { date: string, hour: number } {
  const utcHourKey = Math.floor(unixSeconds / 3600);
  let hit = etHourCache.get(utcHourKey);
  if (!hit) {
    const { date, hour } = etParts(new Date(utcHourKey * 3600 * 1000));
    hit = { date, hour };
    etHourCache.set(utcHourKey, hit);
  }
  return hit;
}

function matchedSlot(): string | null {
  const now = etParts(new Date());
  if (now.weekday === 'Sat' || now.weekday === 'Sun') return null;
  const minutes = now.hour * 60 + now.minute;
  const hit = SLOTS_ET.find(([, slotMin]) => Math.abs(minutes - slotMin) <= SLOT_TOLERANCE_MIN);
  return hit ? hit[0] : null;
}

async function fetchChart(symbol: string, query: string): Promise<any> {
  const fetchSymbol = symbol.replace('.', '-');
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(fetchSymbol)}?${query}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StockPulseRSI/1.0)' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const result = (await res.json())?.chart?.result?.[0];
  if (!result?.timestamp?.length) throw new Error('no_data');
  return result;
}

function parseHourly(result: any): HourBar[] {
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const bars: HourBar[] = [];
  result.timestamp.forEach((ts: number, i: number) => {
    if (closes[i] == null) return;
    const et = etDateHour(ts);
    bars.push({ date: et.date, hour: et.hour, ts, close: Number(closes[i]) });
  });
  return bars.sort((a, b) => a.ts - b.ts);
}

function parseDaily(result: any): Bar[] {
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const byDate = new Map<string, number>();
  result.timestamp.forEach((ts: number, i: number) => {
    if (closes[i] == null) return;
    byDate.set(etDateHour(ts).date, Number(closes[i]));
  });
  return [...byDate.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([date, close]) => ({ date, close }));
}

// 4H blocks in ET: 04-08, 08-12, 12-16, 16-20. Each block's close is its last hourly close.
function fourHourCloses(hourly: HourBar[]): number[] {
  const blocks = new Map<string, number>();
  for (const bar of hourly) {
    if (bar.hour < 4 || bar.hour >= 20) continue;
    const blockStart = Math.floor(bar.hour / 4) * 4;
    blocks.set(`${bar.date}-${String(blockStart).padStart(2, '0')}`, bar.close); // hourly is time-sorted, so last wins
  }
  return [...blocks.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([, close]) => close);
}

function isoWeekKey(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dayOfWeek = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek); // Thursday of this ISO week decides the year
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function weeklyCloses(daily: Bar[]): number[] {
  const weeks = new Map<string, number>();
  for (const bar of daily) weeks.set(isoWeekKey(bar.date), bar.close); // daily is date-sorted, so last wins
  return [...weeks.values()];
}

// Wilder RSI: first average is the simple mean of the first 14 changes, then (prev*13 + current)/14.
function wilderRsi(closes: number[]): number | null {
  if (closes.length < RSI_PERIOD + 1) return null;
  let avgGain = 0; let avgLoss = 0;
  for (let i = 1; i <= RSI_PERIOD; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change; else avgLoss -= change;
  }
  avgGain /= RSI_PERIOD; avgLoss /= RSI_PERIOD;
  for (let i = RSI_PERIOD + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain = (avgGain * (RSI_PERIOD - 1) + Math.max(change, 0)) / RSI_PERIOD;
    avgLoss = (avgLoss * (RSI_PERIOD - 1) + Math.max(-change, 0)) / RSI_PERIOD;
  }
  const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  return Math.round(rsi * 10) / 10;
}

const zoneOf = (rsi: number | null): string | null => rsi == null ? null : rsi >= 70 ? 'ob' : rsi < 30 ? 'os' : 'mid';

async function computeSymbol(symbol: string): Promise<any> {
  const [hourlyResult, dailyResult] = await Promise.all([
    fetchChart(symbol, 'range=3mo&interval=60m&includePrePost=true'),
    fetchChart(symbol, 'range=2y&interval=1d'),
  ]);
  const hourly = parseHourly(hourlyResult);
  const daily = parseDaily(dailyResult);
  if (!hourly.length || !daily.length) throw new Error('empty_series');

  const lastHourly = hourly[hourly.length - 1];
  const todayEt = etParts(new Date()).date;
  // Premarket: Yahoo has no daily bar for today yet, so use the latest hourly close as today's bar.
  // Requiring an hourly bar dated today skips weekends/holidays, where this would add a fake flat bar.
  if (daily[daily.length - 1].date < todayEt && lastHourly.date === todayEt) {
    daily.push({ date: todayEt, close: lastHourly.close });
  }

  const rsi = {
    '1h': wilderRsi(hourly.map(b => b.close)),
    '4h': wilderRsi(fourHourCloses(hourly)),
    '1d': wilderRsi(daily.map(b => b.close)),
    '1w': wilderRsi(weeklyCloses(daily)),
  };
  return {
    symbol,
    price: Math.round(lastHourly.close * 10000) / 10000,
    rsi_1h: rsi['1h'], rsi_4h: rsi['4h'], rsi_1d: rsi['1d'], rsi_1w: rsi['1w'],
    zone_1h: zoneOf(rsi['1h']), zone_4h: zoneOf(rsi['4h']), zone_1d: zoneOf(rsi['1d']), zone_1w: zoneOf(rsi['1w']),
  };
}

async function loadUniverse(supa: any): Promise<string[]> {
  const PAGE = 1000;
  const symbols = new Set<string>(BUILT_IN_WATCHLIST);
  let from = 0;
  while (true) {
    const { data, error } = await supa.from('user_watchlist').select('symbol').order('symbol').range(from, from + PAGE - 1);
    if (error) throw new Error('user_watchlist read failed: ' + error.message);
    (data || []).forEach((r: any) => { if (r.symbol) symbols.add(String(r.symbol).toUpperCase()); });
    if (!data || data.length < PAGE) break;
    from += PAGE; if (from > 100000) break;
  }
  return [...symbols].filter(s => /^[A-Z.\-]{1,6}$/.test(s)).sort();
}

async function loadPreviousZones(supa: any): Promise<Map<string, any>> {
  const PAGE = 1000;
  const previous = new Map<string, any>();
  let from = 0;
  while (true) {
    const { data, error } = await supa.from('rsi_snapshot')
      .select('symbol, zone_1h, zone_4h, zone_1d, zone_1w').order('symbol').range(from, from + PAGE - 1);
    if (error) throw new Error('rsi_snapshot read failed: ' + error.message);
    (data || []).forEach((r: any) => previous.set(r.symbol, r));
    if (!data || data.length < PAGE) break;
    from += PAGE; if (from > 100000) break;
  }
  return previous;
}

interface Crossing { symbol: string; direction: 'up' | 'down'; frames: Array<[Timeframe, number]>; price: number; }

function findCrossings(rows: any[], previous: Map<string, any>): Crossing[] {
  const crossings: Crossing[] = [];
  for (const row of rows) {
    const before = previous.get(row.symbol);
    if (!before) continue; // first run for a symbol: don't alert
    const up: Array<[Timeframe, number]> = []; const down: Array<[Timeframe, number]> = [];
    for (const tf of TIMEFRAMES) {
      const wasNeutral = before[`zone_${tf}`] == null || before[`zone_${tf}`] === 'mid';
      if (!wasNeutral) continue;
      if (row[`zone_${tf}`] === 'ob') up.push([tf, row[`rsi_${tf}`]]);
      if (row[`zone_${tf}`] === 'os') down.push([tf, row[`rsi_${tf}`]]);
    }
    if (up.length) crossings.push({ symbol: row.symbol, direction: 'up', frames: up, price: row.price });
    if (down.length) crossings.push({ symbol: row.symbol, direction: 'down', frames: down, price: row.price });
  }
  return crossings;
}

async function sendTelegram(label: string, crossings: Crossing[]): Promise<string> {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
  const chatId = Deno.env.get('TELEGRAM_CHAT_ID');
  if (!token || !chatId) { console.error('[telegram] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set; alert skipped'); return 'skipped_no_secrets'; }
  const lines = crossings.map(c =>
    `${c.direction === 'up' ? '▲' : '▼'} ${c.symbol} ${c.frames.map(([tf, v]) => `${tf.toUpperCase()} ${v.toFixed(1)}`).join(' · ')} (price ${Number(c.price).toFixed(2)})`);
  const shown = lines.slice(0, MAX_ALERT_LINES);
  if (lines.length > MAX_ALERT_LINES) shown.push(`+${lines.length - MAX_ALERT_LINES} more`);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: `RSI alerts — ${label} ET\n${shown.join('\n')}` }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) { console.error('[telegram] HTTP', res.status); return `failed_http_${res.status}`; }
    return 'sent';
  } catch (e) {
    // The bot token is part of the URL, so scrub it from anything logged.
    console.error('[telegram] send failed:', String(e).split(token).join('***').slice(0, 120));
    return 'failed';
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

  try {
    const body = await req.json().catch(() => ({}));
    const slot = matchedSlot();
    if (!body.force && !slot) return json({ ran: false, skipped: 'outside window' });

    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const symbols = await loadUniverse(supa);
    const previous = await loadPreviousZones(supa);

    const rows: any[] = [];
    const failures: string[] = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < symbols.length) {
        const symbol = symbols[cursor++];
        try {
          rows.push(await computeSymbol(symbol));
        } catch (e) {
          failures.push(symbol);
          console.error('[rsi-scan] skip', symbol, String(e).slice(0, 80));
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    const crossings = findCrossings(rows, previous);

    const computedAt = new Date().toISOString();
    for (let i = 0; i < rows.length; i += 200) {
      const batch = rows.slice(i, i + 200).map(r => ({ ...r, computed_at: computedAt }));
      const { error } = await supa.from('rsi_snapshot').upsert(batch, { onConflict: 'symbol' });
      if (error) throw new Error('rsi_snapshot upsert failed: ' + error.message);
    }

    let telegram = 'none';
    if (crossings.length) {
      const now = etParts(new Date());
      const label = slot || `${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')}`;
      telegram = await sendTelegram(label, crossings);
    }

    return json({ ran: true, symbols: symbols.length, ok: rows.length, failed: failures.length,
      failed_symbols: failures, crossings: crossings.length, telegram });
  } catch (e) {
    console.error('[rsi-scan]', String(e).slice(0, 200));
    return json({ error: String(e) }, 500);
  }
});
