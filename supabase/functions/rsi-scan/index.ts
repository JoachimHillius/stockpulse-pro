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

const CHUNK_SIZE = 150;               // symbols per invocation; keeps each run well under the CPU limit
const FINNHUB_MAX_LOOKUPS = 50;       // sector lookups per run
const FINNHUB_SPACING_MS = 1100;      // <= 1 request/second
const LOOKUP_RETRY_MS = 3 * 86400000;  // re-ask Finnhub about a symbol it couldn't place only every few days
const HANDOFF_WAIT_MS = 2000;
const SCANNER_SECTOR = 'Scanner';
const SYMBOL_RE = /^[A-Z][A-Z.\-]{0,5}$/;

// Sector names the Watchlist page groups by (WATCHLIST keys in index.html) plus the two extra groups this scan can create.
const ALLOWED_SECTORS = new Set([
  'Consumer Staples', 'Technology', 'Semiconductors', 'Utilities', 'Materials', 'Financials', 'Healthcare', 'Energy',
  'Consumer Disc.', 'Telecom', 'Industrials', 'Crypto / Digital Assets', 'Commodities', 'Special Situations',
  'Market References', 'Real Estate', SCANNER_SECTOR,
]);

// Ported from _normalizeSector in index.html (keep in sync), plus labels seen in scanner/swing/symbol_sectors data.
const SECTOR_MAP: Record<string, string> = {
    'technology':'Technology','software':'Technology','it services':'Technology','hardware':'Technology','electronic equipment':'Technology','communications equipment':'Technology',
    'semiconductors':'Semiconductors',
    'banking':'Financials','financial services':'Financials','insurance':'Financials','investment banking & brokerage':'Financials','diversified financial services':'Financials','capital markets':'Financials','consumer finance':'Financials','asset management':'Financials',
    'pharmaceuticals':'Healthcare','biotechnology':'Healthcare','health care':'Healthcare','healthcare':'Healthcare','life sciences tools & services':'Healthcare','medical devices':'Healthcare','health care providers & services':'Healthcare','health care equipment & supplies':'Healthcare','managed health care':'Healthcare',
    'oil & gas':'Energy','energy':'Energy','oil, gas & consumable fuels':'Energy',
    'metals & mining':'Materials','chemicals':'Materials','building materials':'Materials','steel':'Materials','paper & forest products':'Materials','construction materials':'Materials','containers & packaging':'Materials','gold':'Materials',
    'utilities':'Utilities','electric utilities':'Utilities','multi-utilities':'Utilities','water utilities':'Utilities','independent power and renewable electricity producers':'Utilities',
    'beverages':'Consumer Staples','food products':'Consumer Staples','tobacco':'Consumer Staples','consumer products':'Consumer Staples','household products':'Consumer Staples','personal products':'Consumer Staples','food & staples retailing':'Consumer Staples',
    'retail':'Consumer Disc.','apparel':'Consumer Disc.','auto':'Consumer Disc.','automobiles':'Consumer Disc.','hotels, restaurants & leisure':'Consumer Disc.','textiles, apparel & luxury goods':'Consumer Disc.','leisure products':'Consumer Disc.','homebuilding':'Consumer Disc.','homebuilders':'Consumer Disc.','household durables':'Consumer Disc.','specialty retail':'Consumer Disc.','internet & direct marketing retail':'Consumer Disc.','distributors':'Consumer Disc.','multiline retail':'Consumer Disc.','consumer discretionary':'Consumer Disc.',
    'aerospace & defense':'Industrials','machinery':'Industrials','industrial conglomerates':'Industrials','logistics & transportation':'Industrials','road & rail':'Industrials','transportation':'Industrials','construction & engineering':'Industrials','trading companies & distributors':'Industrials','commercial services & supplies':'Industrials','electrical equipment':'Industrials','marine':'Industrials','airlines':'Industrials','air freight & logistics':'Industrials','building products':'Industrials','professional services':'Industrials',
    'telecommunication':'Telecom','communications':'Telecom','media':'Telecom','diversified telecommunication services':'Telecom','wireless telecommunication services':'Telecom','entertainment':'Telecom','interactive media & services':'Telecom',
    'real estate':'Real Estate','reit':'Real Estate','real estate management & development':'Real Estate','equity real estate investment trusts (reits)':'Real Estate',
  'consumer cyclical':'Consumer Disc.','auto components':'Consumer Disc.','diversified consumer services':'Consumer Disc.',
  'consumer defensive':'Consumer Staples',
  'communication services':'Telecom','communication':'Telecom',
  'ai':'Technology','quantum':'Technology',
  'construction':'Industrials','packaging':'Materials',
  'crypto/miners':'Crypto / Digital Assets','crypto':'Crypto / Digital Assets',
  'precious metals':'Commodities',
  'bond etf':'Market References','broad etf':'Market References',
};

function normalizeSector(raw: unknown): string | null {
  if (!raw) return null;
  const label = String(raw).trim();
  if (ALLOWED_SECTORS.has(label)) return label;
  const mapped = SECTOR_MAP[label.toLowerCase()];
  return mapped && ALLOWED_SECTORS.has(mapped) ? mapped : null;
}

const cleanSymbol = (raw: unknown): string | null => {
  const sym = String(raw ?? '').trim().toUpperCase();
  return SYMBOL_RE.test(sym) ? sym : null;
};

async function pagedRead(supa: any, table: string, columns: string, orderBy: string): Promise<any[]> {
  const PAGE = 1000;
  const out: any[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supa.from(table).select(columns).order(orderBy).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
    from += PAGE; if (from > 100000) break;
  }
  return out;
}

interface ExtraSymbol { sources: Set<string>; swingSector: string | null; scannerSector: string | null; }

// Universe = built-in WATCHLIST + user_watchlist + scanner_watchlist + scanner_alerts + swing_watchlist.
// "extras" are the symbols outside built-in + user; those get a rsi_universe row.
async function buildUniverse(supa: any): Promise<{ symbols: string[], extras: Map<string, ExtraSymbol> }> {
  const base = new Set<string>(BUILT_IN_WATCHLIST);
  for (const r of await pagedRead(supa, 'user_watchlist', 'symbol', 'id')) {
    const sym = cleanSymbol(r.symbol); if (sym) base.add(sym);
  }
  const extras = new Map<string, ExtraSymbol>();
  const touch = (rawSymbol: unknown, source: string, rawSector: unknown) => {
    const sym = cleanSymbol(rawSymbol);
    if (!sym || base.has(sym)) return;
    const entry = extras.get(sym) || { sources: new Set<string>(), swingSector: null, scannerSector: null };
    entry.sources.add(source);
    const sector = normalizeSector(rawSector);
    if (sector && source === 'momentum' && !entry.swingSector) entry.swingSector = sector;
    if (sector && source === 'scanner' && !entry.scannerSector) entry.scannerSector = sector;
    extras.set(sym, entry);
  };
  for (const r of await pagedRead(supa, 'scanner_watchlist', 'symbol, sector', 'id')) touch(r.symbol, 'scanner', r.sector);
  for (const r of await pagedRead(supa, 'scanner_alerts', 'symbol', 'id')) touch(r.symbol, 'alerts', null);
  for (const r of await pagedRead(supa, 'swing_watchlist', 'symbol, sector', 'id')) touch(r.symbol, 'momentum', r.sector);
  return { symbols: [...new Set([...base, ...extras.keys()])].sort(), extras };
}

async function finnhubSector(symbol: string, token: string): Promise<{ sector: string | null, rateLimited: boolean, ok: boolean }> {
  try {
    const res = await fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 429) return { sector: null, rateLimited: true, ok: false };
    if (!res.ok) return { sector: null, rateLimited: false, ok: false };
    const profile = await res.json();
    return { sector: normalizeSector(profile?.finnhubIndustry), rateLimited: false, ok: true };
  } catch (e) {
    // The URL carries the API key, so log the symbol only.
    console.error('[finnhub] profile lookup failed for', symbol);
    return { sector: null, rateLimited: false, ok: false };
  }
}

// Resolution order: sector_override (user's manual choice, never second-guessed or written here) -> swing sector -> scanner sector
// -> symbol_sectors (incl. cached Finnhub results) -> Finnhub lookup -> 'Scanner'.
async function syncRsiUniverse(supa: any, extras: Map<string, ExtraSymbol>): Promise<{ total: number, scannerFallback: number, lookups: number }> {
  // Manual overrides win over everything and are read-only for this function. They are not normalized: any name the user chose stands.
  const overrides = new Map<string, string>();
  for (const r of await pagedRead(supa, 'sector_override', 'symbol, sector', 'symbol')) {
    const sym = cleanSymbol(r.symbol); const sector = String(r.sector ?? '').trim();
    if (sym && sector) overrides.set(sym, sector);
  }
  const symbolSectors = new Map<string, string>();
  for (const r of await pagedRead(supa, 'symbol_sectors', 'symbol, sector', 'symbol')) {
    const sector = normalizeSector(r.sector); const sym = cleanSymbol(r.symbol);
    if (sym && sector) symbolSectors.set(sym, sector);
  }
  // updated_at doubles as "last lookup attempt" for unplaced rows: it is only bumped when a Finnhub lookup is tried or the
  // sector changes, and a row whose updated_at still equals first_seen has never been tried.
  const existing = new Map<string, { sector: string | null, updatedAt: number, updatedAtIso: string, neverTried: boolean }>();
  for (const r of await pagedRead(supa, 'rsi_universe', 'symbol, sector, first_seen, updated_at', 'symbol')) {
    const updatedAt = new Date(r.updated_at).getTime();
    existing.set(r.symbol, { sector: r.sector, updatedAt, updatedAtIso: r.updated_at,
      neverTried: Math.abs(updatedAt - new Date(r.first_seen).getTime()) < 2000 });
  }

  const resolved = new Map<string, string>();
  const needsLookup: Array<{ sym: string, neverTried: boolean, updatedAt: number }> = [];
  for (const [sym, info] of extras) {
    const prior = existing.get(sym);
    const forced = overrides.get(sym);
    if (forced) { resolved.set(sym, forced); continue; } // no Finnhub lookup either
    // (No "previous rsi_universe value" fallback: after an override is reset it would otherwise keep the old override.
    // Finnhub results are cached in symbol_sectors, so nothing is lost.)
    const sector = info.swingSector || info.scannerSector || symbolSectors.get(sym);
    if (sector) { resolved.set(sym, sector); continue; }
    const retryDue = !prior || prior.neverTried || Date.now() - prior.updatedAt >= LOOKUP_RETRY_MS;
    if (retryDue) needsLookup.push({ sym, neverTried: !prior || prior.neverTried, updatedAt: prior?.updatedAt ?? 0 });
  }

  // Never-tried symbols first, then the longest-waiting, so the per-run cap rotates through everything.
  needsLookup.sort((a, b) => Number(b.neverTried) - Number(a.neverTried) || a.updatedAt - b.updatedAt || a.sym.localeCompare(b.sym));
  const attempted = new Set<string>();
  let lookups = 0;
  const finnhubKey = Deno.env.get('FINNHUB_API_KEY');
  if (finnhubKey) {
    const cacheRows: any[] = [];
    for (const { sym } of needsLookup.slice(0, FINNHUB_MAX_LOOKUPS)) {
      if (lookups > 0) await new Promise(r => setTimeout(r, FINNHUB_SPACING_MS));
      lookups++;
      const { sector, rateLimited, ok } = await finnhubSector(sym, finnhubKey);
      if (rateLimited) { console.error('[finnhub] rate limited; stopping lookups'); break; }
      if (ok) attempted.add(sym);
      if (sector && sector !== SCANNER_SECTOR) {
        resolved.set(sym, sector);
        cacheRows.push({ symbol: sym, sector, updated_at: new Date().toISOString() });
      }
    }
    if (cacheRows.length) {
      const { error } = await supa.from('symbol_sectors').upsert(cacheRows, { onConflict: 'symbol' });
      if (error) console.error('[symbol_sectors cache]', error.message);
    }
  } else if (needsLookup.length) {
    console.error('[rsi-scan] FINNHUB_API_KEY not set; sector lookups skipped');
  }

  const nowIso = new Date().toISOString();
  const allRows = [...extras.entries()].map(([sym, info]) => {
    const sector = resolved.get(sym) || SCANNER_SECTOR;
    const prior = existing.get(sym);
    // New rows omit updated_at so it equals first_seen (= never tried); unchanged rows keep their last-attempt time.
    const touched = attempted.has(sym) || (prior && prior.sector !== sector);
    return { sym, isNew: !prior, row: { symbol: sym, sector, sources: [...info.sources].sort(),
      ...(prior ? { updated_at: touched ? nowIso : prior.updatedAtIso } : {}) } };
  });
  for (const isNew of [true, false]) {
    const batchRows = allRows.filter(r => r.isNew === isNew).map(r => r.row);
    for (let i = 0; i < batchRows.length; i += 200) {
      const { error } = await supa.from('rsi_universe').upsert(batchRows.slice(i, i + 200), { onConflict: 'symbol' });
      if (error) throw new Error('rsi_universe upsert failed: ' + error.message);
    }
  }
  const rows = allRows.map(r => r.row);
  // Drop rows for symbols that left every source (or moved into the built-in / user lists).
  const stale = [...existing.keys()].filter(sym => !extras.has(sym));
  for (let i = 0; i < stale.length; i += 100) {
    const { error } = await supa.from('rsi_universe').delete().in('symbol', stale.slice(i, i + 100));
    if (error) console.error('[rsi_universe cleanup]', error.message);
  }
  return { total: rows.length, scannerFallback: rows.filter(r => r.sector === SCANNER_SECTOR).length, lookups };
}

async function loadPreviousZones(supa: any, symbols: string[]): Promise<Map<string, any>> {
  const previous = new Map<string, any>();
  const { data, error } = await supa.from('rsi_snapshot')
    .select('symbol, zone_1h, zone_4h, zone_1d, zone_1w, has_options, options_checked_at').in('symbol', symbols);
  if (error) throw new Error('rsi_snapshot read failed: ' + error.message);
  (data || []).forEach((r: any) => previous.set(r.symbol, r));
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

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---- Listed-options check (Yahoo needs a cookie + crumb; plain calls return 401) ----------------------------------
const OPTIONS_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const OPTIONS_CALL_SPACING_MS = 80;
interface YahooSession { cookie: string; crumb: string; }

async function yahooSession(): Promise<YahooSession | null> {
  try {
    const home = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': OPTIONS_UA }, redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const setCookie = home.headers.get('set-cookie') || '';
    const cookie = setCookie.split(',').map(c => c.trim().split(';')[0]).filter(c => c.startsWith('A')).join('; ') || setCookie.split(';')[0];
    const res = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': OPTIONS_UA, Cookie: cookie }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const crumb = await res.text();
    // An error body ("Too Many Requests") is not a crumb.
    return res.ok && crumb.length > 0 && crumb.length < 40 && !/\s/.test(crumb) ? { cookie, crumb } : null;
  } catch (_) { return null; }
}

// Reads only the first ~1.5KB (expirationDates is at the top of the payload) and drops the rest: full chains are large.
async function readHead(res: Response, maxChars = 1500): Promise<string> {
  const reader = res.body!.getReader(); const decoder = new TextDecoder(); let text = '';
  while (text.length < maxChars) { const { done, value } = await reader.read(); if (done) break; text += decoder.decode(value, { stream: true }); }
  try { await reader.cancel(); } catch (_) { /* stream already closed */ }
  return text;
}

// true = has listed options, false = confirmed none, null = could not tell (caller keeps the previous value).
async function hasListedOptions(symbol: string, session: { current: YahooSession | null }): Promise<boolean | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!session.current) return null;
    try {
      const res = await fetch(`https://query1.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol.replace('.', '-'))}?crumb=${encodeURIComponent(session.current.crumb)}`, {
        headers: { 'User-Agent': OPTIONS_UA, Cookie: session.current.cookie }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status === 401 && attempt === 0) { try { await res.body?.cancel(); } catch (_) { /* ignore */ } session.current = await yahooSession(); continue; }
      if (!res.ok) { try { await res.body?.cancel(); } catch (_) { /* ignore */ } return null; }
      const head = await readHead(res);
      const m = head.match(/"expirationDates":\[([^\]]*)\]/);
      if (m) return m[1].trim().length > 0;
      if (head.includes('"result":[]') || head.includes('"result":null')) return false;
      return null;
    } catch (_) { return null; }
  }
  return null;
}

// Fill has_options / options_checked_at / flow stats on freshly computed rows.
// Rules: flow history proves the symbol trades options (override); otherwise Yahoo is asked at most once per ET day.
async function attachOptionsData(supa: any, rows: any[], previous: Map<string, any>): Promise<{ checked: number, unknown: number }> {
  const symbols = rows.map(r => r.symbol);
  const { data: flowRows, error: flowError } = await supa.rpc('get_options_flow_stats', { p_symbols: symbols });
  if (flowError) console.error('[get_options_flow_stats]', flowError.message);
  const flow = new Map<string, any>((flowRows || []).map((f: any) => [f.symbol, f]));

  const todayEt = etParts(new Date()).date;
  const nowIso = new Date().toISOString();
  const needsCheck: any[] = [];
  for (const row of rows) {
    const before = previous.get(row.symbol);
    const flowStats = flow.get(row.symbol);
    // If the flow query failed, leave the stored flow columns untouched (undefined keys are omitted from the upsert).
    if (!flowError) {
      row.flow_ever = !!flowStats;
      row.flow_days_30d = flowStats?.flow_days_30d ?? 0;
      row.last_flow_date = flowStats?.last_flow_date ?? null;
    }
    row.has_options = before?.has_options ?? null;
    row.options_checked_at = before?.options_checked_at ?? null;
    if (flowStats) {
      row.has_options = true;
      if (!before?.has_options) row.options_checked_at = nowIso;
    } else if (!before?.options_checked_at || etParts(new Date(before.options_checked_at)).date !== todayEt) {
      needsCheck.push(row);
    }
  }

  let unknown = 0;
  if (needsCheck.length) {
    const session = { current: await yahooSession() };
    let cursor = 0;
    const worker = async () => {
      while (cursor < needsCheck.length) {
        const row = needsCheck[cursor++];
        const result = await hasListedOptions(row.symbol, session);
        if (result === null) unknown++; // keep the previous value and retry on the next run
        else { row.has_options = result; row.options_checked_at = nowIso; }
        await sleep(OPTIONS_CALL_SPACING_MS);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }
  return { checked: needsCheck.length, unknown };
}

// Fire-and-forget: abort once the request is on the wire so we don't wait for the next chunk to finish.
async function handOff(payload: unknown): Promise<void> {
  const controller = new AbortController();
  const request = fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/rsi-scan`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), signal: controller.signal,
  }).catch((e) => { if (e?.name !== 'AbortError') console.error('[rsi-scan] handoff failed', String(e).slice(0, 80)); });
  await Promise.race([request, sleep(HANDOFF_WAIT_MS)]);
  controller.abort();
}

// Continuation bodies come over the public URL, so re-validate everything we carry between chunks.
function sanitizeCrossings(raw: unknown): Crossing[] {
  if (!Array.isArray(raw)) return [];
  const out: Crossing[] = [];
  for (const c of raw.slice(0, 500)) {
    const symbol = cleanSymbol(c?.symbol);
    const direction = c?.direction === 'up' || c?.direction === 'down' ? c.direction : null;
    const frames = Array.isArray(c?.frames)
      ? c.frames.filter((f: any) => Array.isArray(f) && (TIMEFRAMES as readonly string[]).includes(f[0]) && Number.isFinite(Number(f[1])))
          .map((f: any) => [f[0], Number(f[1])] as [Timeframe, number])
      : [];
    if (symbol && direction && frames.length && Number.isFinite(Number(c?.price))) out.push({ symbol, direction, frames, price: Number(c.price) });
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

  try {
    const body = await req.json().catch(() => ({}));
    const force = !!body.force;
    const chunk = Number.isInteger(body.chunk) && body.chunk > 0 ? body.chunk : 0;
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    let symbols: string[]; let label: string; let runId: string; let runStartedAt: number;
    let totals = { ok: 0, failed: 0, optionsChecked: 0, optionsUnknown: 0, failedSymbols: [] as string[], crossings: [] as Crossing[] };
    let universeInfo: any = null;

    if (chunk === 0) {
      // The ET window gate only applies to the first invocation; continuations belong to an admitted run.
      const slot = matchedSlot();
      if (!force && !slot) return json({ ran: false, skipped: 'outside window' });
      const universe = await buildUniverse(supa);
      universeInfo = await syncRsiUniverse(supa, universe.extras);
      symbols = universe.symbols;
      const now = etParts(new Date());
      label = slot || `${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')}`;
      runId = crypto.randomUUID();
      runStartedAt = Date.now();
    } else {
      symbols = [...new Set((Array.isArray(body.symbols) ? body.symbols : []).map(cleanSymbol).filter(Boolean) as string[])].slice(0, 3000);
      label = String(body.label || '').replace(/[^0-9:]/g, '').slice(0, 5);
      runId = String(body.runId || '').replace(/[^0-9a-f-]/gi, '').slice(0, 40);
      runStartedAt = Number(body.runStartedAt) || Date.now();
      totals = {
        ok: Math.max(0, Number(body.ok) || 0), failed: Math.max(0, Number(body.failed) || 0),
        optionsChecked: Math.max(0, Number(body.optionsChecked) || 0), optionsUnknown: Math.max(0, Number(body.optionsUnknown) || 0),
        failedSymbols: (Array.isArray(body.failedSymbols) ? body.failedSymbols : []).map(cleanSymbol).filter(Boolean).slice(0, 100) as string[],
        crossings: sanitizeCrossings(body.crossings),
      };
    }

    const slice = symbols.slice(chunk * CHUNK_SIZE, (chunk + 1) * CHUNK_SIZE);
    const previous = await loadPreviousZones(supa, slice);

    const rows: any[] = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < slice.length) {
        const symbol = slice[cursor++];
        try {
          rows.push(await computeSymbol(symbol));
        } catch (e) {
          totals.failed++;
          if (totals.failedSymbols.length < 100) totals.failedSymbols.push(symbol);
          console.error('[rsi-scan] skip', symbol, String(e).slice(0, 80));
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    totals.ok += rows.length;
    const options = await attachOptionsData(supa, rows, previous);
    totals.optionsChecked += options.checked; totals.optionsUnknown += options.unknown;
    totals.crossings.push(...findCrossings(rows, previous));

    const computedAt = new Date().toISOString();
    for (let i = 0; i < rows.length; i += 200) {
      const batch = rows.slice(i, i + 200).map(r => ({ ...r, computed_at: computedAt }));
      const { error } = await supa.from('rsi_snapshot').upsert(batch, { onConflict: 'symbol' });
      if (error) throw new Error('rsi_snapshot upsert failed: ' + error.message);
    }

    const totalChunks = Math.ceil(symbols.length / CHUNK_SIZE);
    if (chunk + 1 < totalChunks) {
      await handOff({ force, chunk: chunk + 1, runId, label, runStartedAt, symbols, ...totals });
      return json({ ran: true, chunk, total_chunks: totalChunks, handed_off: true, symbols: symbols.length,
        ok: totals.ok, failed: totals.failed, universe: universeInfo });
    }

    // Final chunk: one combined Telegram message for the whole run.
    let telegram = 'none';
    if (totals.crossings.length) telegram = await sendTelegram(label, totals.crossings);
    const elapsedMs = Date.now() - runStartedAt;
    console.log(`[rsi-scan] run ${runId} done: chunks=${totalChunks} symbols=${symbols.length} ok=${totals.ok} failed=${totals.failed} options_checked=${totals.optionsChecked} options_unknown=${totals.optionsUnknown} crossings=${totals.crossings.length} telegram=${telegram} ms=${elapsedMs}`);
    return json({ ran: true, done: true, chunk, total_chunks: totalChunks, symbols: symbols.length, ok: totals.ok,
      failed: totals.failed, options_checked: totals.optionsChecked, options_unknown: totals.optionsUnknown, failed_symbols: totals.failedSymbols, crossings: totals.crossings.length, telegram, elapsed_ms: elapsedMs });
  } catch (e) {
    console.error('[rsi-scan]', String(e).slice(0, 200));
    return json({ error: String(e) }, 500);
  }
});
