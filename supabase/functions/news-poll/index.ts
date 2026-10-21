import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const BREAKING_WINDOW_MS = 30 * 60 * 1000;
const DEDUPE_WINDOW_MS = 12 * 60 * 60 * 1000;
const COMPANY_WINDOW_MS = 24 * 60 * 60 * 1000; // Source C keeps only the last 24h
const COMPANY_PACE_MS = 1100;                  // ~1.1s between Finnhub calls (<60/min)
const PAGE = 1000;                             // Supabase row cap per read

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface NewsItem {
  source: 'stocktwits' | 'finnhub';
  external_id: string;
  headline: string;
  summary: string | null;
  url: string | null;
  tickers: string[];
  published_at: string;
}

// Short tickers/terms get word boundaries so "es futures" or "iwm" don't match inside other words.
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  spx: ['S&P 500', 'S&P', 'SPX', 'SPY', 'ES futures'],
  ndx: ['Nasdaq', 'NDX', 'QQQ', 'NQ futures'],
  rut: ['Russell 2000', 'IWM', 'small caps', 'small-cap'],
  r1000: ['Russell 1000', 'IWB'],
  oil: ['oil', 'crude', 'WTI', 'Brent', 'OPEC', 'USO', 'barrel'],
  energy: ['energy sector', 'XLE', 'XOP', 'natural gas', 'refiners', 'Exxon', 'Chevron'],
  macro: ['Fed', 'FOMC', 'Powell', 'CPI', 'PPI', 'jobs report', 'payrolls', 'GDP', 'yields', 'Treasury', 'tariff', 'sanctions'],
};
const MOVE_WORDS = [
  'plunge', 'plunges', 'surge', 'surges', 'soar', 'soars', 'tumble', 'tumbles', 'sink', 'sinks',
  'jump', 'jumps', 'rise', 'rises', 'fall', 'falls', 'drop', 'drops', 'rally', 'rallies',
  'crash', 'sell-off', 'selloff', 'halt', 'halted', 'record high', 'breaking', 'earnings',
  'beats', 'misses', 'guidance', 'downgrade', 'upgrade', 'offering', 'FDA', 'acquisition',
  'buyout', 'merger', 'lawsuit', 'recall',
];

// watch_hit company-name aliases (symbol -> names), matched as whole words in the headline.
const NAME_MAP: Record<string, string[]> = {
  NVDA: ['Nvidia'], TSLA: ['Tesla'], MSFT: ['Microsoft'], META: ['Meta'], AAPL: ['Apple'],
  GOOGL: ['Alphabet', 'Google'], AMZN: ['Amazon'], MU: ['Micron'], AMD: ['AMD'],
  MSTR: ['Strategy', 'MicroStrategy'], SNDK: ['SanDisk'], AVGO: ['Broadcom'], PLTR: ['Palantir'],
  NFLX: ['Netflix'], COIN: ['Coinbase'], YFOR: ['YYForce'],
};

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRegex = (term: string) => new RegExp(`(?<![A-Za-z0-9])${escapeRegex(term)}(?![A-Za-z0-9])`, 'i');
const dollarRegex = (sym: string) => new RegExp(`\\$${escapeRegex(sym)}(?![A-Za-z0-9])`, 'i');

const CATEGORY_REGEXES = Object.entries(CATEGORY_KEYWORDS).map(
  ([category, terms]) => [category, terms.map(wordRegex)] as [string, RegExp[]]
);
const MOVE_REGEXES = MOVE_WORDS.map(wordRegex);

const unionArr = (a: string[], b: string[]) => [...new Set([...(a || []), ...(b || [])])];

// watch_hit = get_news_tickers() symbols appearing in the item's tickers, in the headline
// as a whole word or $SYM, or by company name.
function computeWatchHit(headline: string, tickers: string[], newsTickers: Set<string>): string[] {
  const hl = headline || '';
  const tset = new Set((tickers || []).map((t) => String(t).toUpperCase()));
  const hit: string[] = [];
  for (const sym of newsTickers) {
    if (tset.has(sym)) { hit.push(sym); continue; }
    if (wordRegex(sym).test(hl)) { hit.push(sym); continue; }
    if (dollarRegex(sym).test(hl)) { hit.push(sym); continue; }
    const names = NAME_MAP[sym];
    if (names && names.some((n) => wordRegex(n).test(hl))) { hit.push(sym); continue; }
  }
  return hit;
}

function classify(
  headline: string, summary: string | null, tickers: string[], watch_hit: string[], published_at: string,
): { categories: string[], relevance: number, is_breaking: boolean } {
  const text = `${headline} ${summary || ''} ${(tickers || []).join(' ')}`;
  const categories = CATEGORY_REGEXES.filter(([, rx]) => rx.some((re) => re.test(text))).map(([c]) => c);
  if (watch_hit.length) categories.push('stock');
  const hasMoveWord = MOVE_REGEXES.some((re) => re.test(headline));
  const relevance = categories.length + (watch_hit.length ? 2 : 0) + (hasMoveWord ? 2 : 0);
  const ageMs = Date.now() - new Date(published_at).getTime();
  const is_breaking = categories.length > 0 && relevance >= 2 && ageMs >= 0 && ageMs <= BREAKING_WINDOW_MS;
  return { categories, relevance, is_breaking };
}

// Must mirror market_news.headline_norm: lower(regexp_replace(headline, '[^a-zA-Z0-9 ]', '', 'g'))
const normalizeHeadline = (headline: string) => headline.replace(/[^a-zA-Z0-9 ]/g, '').toLowerCase();

// Source A: the page is a Next.js pages-router app; articles live in __NEXT_DATA__ at props.pageProps.articles.
async function fetchStocktwits(): Promise<{ items: NewsItem[], parseOk: boolean }> {
  try {
    const res = await fetch('https://stocktwits.com/news-articles', {
      headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/html' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) { console.error('[stocktwits] HTTP', res.status); return { items: [], parseOk: false }; }
    const html = await res.text();
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
    if (!match) { console.error('[stocktwits] __NEXT_DATA__ not found'); return { items: [], parseOk: false }; }
    const articles = JSON.parse(match[1])?.props?.pageProps?.articles;
    if (!Array.isArray(articles)) { console.error('[stocktwits] pageProps.articles missing'); return { items: [], parseOk: false }; }

    const items: NewsItem[] = [];
    for (const a of articles) {
      if (!a?.headline || !a?.url_slug || !a?.created_at) continue;
      const category = String(a.category?.name || 'markets').toLowerCase();
      const subcategory = String(a.subcategory?.name || '').toLowerCase();
      const path = [category, subcategory, a.url_slug, a.sid].filter(Boolean).join('/');
      const tickers = Array.isArray(a.symbol_codes) ? a.symbol_codes.filter((t: unknown) => typeof t === 'string') : [];
      items.push({
        source: 'stocktwits',
        external_id: String(a.url_slug),
        headline: String(a.headline).trim(),
        summary: a.summary ? String(a.summary).trim() : null,
        url: `https://stocktwits.com/news-articles/${path}`,
        tickers,
        published_at: new Date(a.created_at).toISOString(),
      });
    }
    return { items, parseOk: true };
  } catch (e) {
    console.error('[stocktwits] parse failed:', String(e).slice(0, 120));
    return { items: [], parseOk: false };
  }
}

// Source B: Finnhub general market news.
async function fetchFinnhub(): Promise<NewsItem[]> {
  const token = Deno.env.get('FINNHUB_API_KEY');
  if (!token) { console.error('[finnhub] FINNHUB_API_KEY not set'); return []; }
  try {
    const res = await fetch(`https://finnhub.io/api/v1/news?category=general&token=${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(15000),
    });
    // Status only: the URL carries the token, so never log it.
    if (!res.ok) { console.error('[finnhub] HTTP', res.status); return []; }
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    const items: NewsItem[] = [];
    for (const n of data) {
      if (!n?.headline || n.id == null || !n.datetime) continue;
      items.push({
        source: 'finnhub',
        external_id: String(n.id),
        headline: String(n.headline).trim(),
        summary: n.summary ? String(n.summary).trim() : null,
        url: n.url || null,
        tickers: n.related ? String(n.related).split(',').map((t: string) => t.trim()).filter(Boolean) : [],
        published_at: new Date(Number(n.datetime) * 1000).toISOString(),
      });
    }
    return items;
  } catch (e) {
    console.error('[finnhub] fetch failed:', String(e).replace(token, '***').slice(0, 120));
    return [];
  }
}

// get_news_tickers() -> TABLE(symbol text). Paged read per the 1000-row cap.
async function loadNewsTickers(supa: any): Promise<string[]> {
  const out: string[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supa.rpc('get_news_tickers').range(from, from + PAGE - 1);
    if (error) throw new Error('get_news_tickers failed: ' + error.message);
    for (const r of (data || [])) if (r?.symbol) out.push(String(r.symbol).toUpperCase());
    if (!data || data.length < PAGE) break;
    from += PAGE; if (from > 100000) break;
  }
  return [...new Set(out)];
}

// One company-news GET with the 429 retry-once-then-skip policy. Returns null to skip the symbol.
async function getCompanyNews(sym: string, from: string, to: string, token: string): Promise<any[] | null> {
  const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(sym)}&from=${from}&to=${to}&token=${encodeURIComponent(token)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (res.status === 429) {
        if (attempt === 0) { await sleep(5000); continue; }
        console.error('[finnhub-company] 429 skip', sym);
        return null;
      }
      if (!res.ok) { console.error('[finnhub-company] HTTP', res.status, sym); return null; }
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    } catch (e) {
      console.error('[finnhub-company] fetch failed', sym, String(e).replace(token, '***').slice(0, 80));
      return null;
    }
  }
  return null;
}

// Source C: Finnhub company news for each watchlist/mover symbol, last 24h only.
async function fetchFinnhubCompany(symbols: string[]): Promise<{ items: NewsItem[], companyIds: Set<string>, fetched: number }> {
  const token = Deno.env.get('FINNHUB_API_KEY');
  if (!token) { console.error('[finnhub-company] FINNHUB_API_KEY not set'); return { items: [], companyIds: new Set(), fetched: 0 }; }
  const now = Date.now();
  const to = new Date(now).toISOString().slice(0, 10);
  const from = new Date(now - COMPANY_WINDOW_MS).toISOString().slice(0, 10);
  const cutoff = now - COMPANY_WINDOW_MS;
  const items: NewsItem[] = [];
  const companyIds = new Set<string>();
  let fetched = 0;
  for (let i = 0; i < symbols.length; i++) {
    if (i > 0) await sleep(COMPANY_PACE_MS); // pace to stay under 60/min
    const sym = symbols[i];
    const data = await getCompanyNews(sym, from, to, token);
    if (!data) continue;
    for (const n of data) {
      if (!n?.headline || n.id == null || !n.datetime) continue;
      const pubMs = Number(n.datetime) * 1000;
      if (!(pubMs >= cutoff)) continue; // keep only the last 24h
      const related = n.related ? String(n.related).split(',').map((t: string) => t.trim()).filter(Boolean) : [];
      const extId = String(n.id);
      companyIds.add(extId);
      items.push({
        source: 'finnhub',
        external_id: extId,
        headline: String(n.headline).trim(),
        summary: n.summary ? String(n.summary).trim() : null,
        url: n.url || null,
        tickers: unionArr(related, [sym]),
        published_at: new Date(pubMs).toISOString(),
      });
      fetched++;
    }
  }
  return { items, companyIds, fetched };
}

interface Consolidated {
  source: string; external_id: string; headline: string; summary: string | null;
  url: string | null; published_at: string; tickers: string[]; watch_hit: string[];
}

// Insert brand-new (source, external_id) rows (12h headline dedupe) and, for rows that
// already exist and are still unsent, merge tickers + watch_hit (array union) and recompute
// relevance/categories/is_breaking. Rows already sent to Telegram are left untouched.
async function processItems(
  supa: any, items: NewsItem[], newsTickers: Set<string>, seenNorms: Set<string>, companyIds: Set<string>,
): Promise<{ inserted: any[], updated: number }> {
  // 1. Consolidate within this run by (source, external_id), unioning tickers + watch_hit.
  const map = new Map<string, Consolidated>();
  for (const it of items) {
    if (!it.external_id || !it.headline) continue;
    const wh = computeWatchHit(it.headline, it.tickers, newsTickers);
    const key = `${it.source}|${it.external_id}`;
    const cur = map.get(key);
    if (cur) {
      cur.tickers = unionArr(cur.tickers, it.tickers);
      cur.watch_hit = unionArr(cur.watch_hit, wh);
    } else {
      map.set(key, {
        source: it.source, external_id: it.external_id, headline: it.headline, summary: it.summary,
        url: it.url, published_at: it.published_at, tickers: [...new Set(it.tickers || [])], watch_hit: wh,
      });
    }
  }

  // 2. Load existing rows for these keys (paged, chunked by source).
  const existing = new Map<string, { tickers: string[], watch_hit: string[], sent_to_telegram_at: string | null }>();
  const bySource = new Map<string, string[]>();
  for (const r of map.values()) {
    if (!bySource.has(r.source)) bySource.set(r.source, []);
    bySource.get(r.source)!.push(r.external_id);
  }
  for (const [src, ids] of bySource) {
    for (let c = 0; c < ids.length; c += 200) {
      const chunk = ids.slice(c, c + 200);
      let from = 0;
      while (true) {
        const { data, error } = await supa.from('market_news')
          .select('source,external_id,tickers,watch_hit,sent_to_telegram_at')
          .eq('source', src).in('external_id', chunk).order('id').range(from, from + PAGE - 1);
        if (error) throw new Error('existing lookup failed: ' + error.message);
        for (const row of (data || [])) existing.set(`${row.source}|${row.external_id}`, row);
        if (!data || data.length < PAGE) break;
        from += PAGE; if (from > 100000) break;
      }
    }
  }

  // 3. Partition into inserts (new + headline-deduped) and merge-updates (existing + unsent).
  const toInsert: any[] = [];
  const toUpdate: any[] = [];
  for (const r of map.values()) {
    const ex = existing.get(`${r.source}|${r.external_id}`);
    if (!ex) {
      const norm = normalizeHeadline(r.headline);
      if (!norm || seenNorms.has(norm)) continue; // 12h cross-source headline dedupe (new rows only)
      seenNorms.add(norm);
      toInsert.push({
        source: r.source, external_id: r.external_id, headline: r.headline, summary: r.summary,
        url: r.url, tickers: r.tickers, published_at: r.published_at, watch_hit: r.watch_hit,
        ...classify(r.headline, r.summary, r.tickers, r.watch_hit, r.published_at),
      });
    } else if (!ex.sent_to_telegram_at) {
      const tickers = unionArr(ex.tickers, r.tickers);
      const watch_hit = unionArr(ex.watch_hit, r.watch_hit);
      toUpdate.push({
        source: r.source, external_id: r.external_id, tickers, watch_hit,
        ...classify(r.headline, r.summary, tickers, watch_hit, r.published_at),
      });
    }
  }

  // 4. Insert new rows (ignoreDuplicates guards against a race with a concurrent run).
  const inserted: any[] = [];
  for (let b = 0; b < toInsert.length; b += 500) {
    const batch = toInsert.slice(b, b + 500);
    const { data, error } = await supa.from('market_news')
      .upsert(batch, { onConflict: 'source,external_id', ignoreDuplicates: true })
      .select('source,external_id,is_breaking');
    if (error) throw new Error('market_news insert failed: ' + error.message);
    inserted.push(...(data || []));
  }

  // 5. Merge-update conflicts, guarded to unsent rows only.
  let updated = 0;
  for (const u of toUpdate) {
    const { data, error } = await supa.from('market_news')
      .update({ tickers: u.tickers, watch_hit: u.watch_hit, categories: u.categories, relevance: u.relevance, is_breaking: u.is_breaking })
      .eq('source', u.source).eq('external_id', u.external_id).is('sent_to_telegram_at', null)
      .select('external_id');
    if (error) throw new Error('market_news merge failed: ' + error.message);
    updated += (data || []).length;
  }

  return { inserted, updated };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

  try {
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // Sources A + B and supporting reads in parallel.
    const [stocktwits, finnhubItems, newsTickers, seenNorms] = await Promise.all([
      fetchStocktwits(), fetchFinnhub(), loadNewsTickers(supa), loadRecentHeadlineNorms(supa),
    ]);
    // Source C runs after A + B so pacing keeps total Finnhub calls under 60/min.
    const company = await fetchFinnhubCompany(newsTickers);

    const newsTickerSet = new Set(newsTickers);
    const allItems = [...stocktwits.items, ...finnhubItems, ...company.items];
    const { inserted, updated } = await processItems(supa, allItems, newsTickerSet, seenNorms, company.companyIds);

    const isFinnhub = (r: any) => r.source === 'finnhub';
    const stocktwits_new = inserted.filter((r) => r.source === 'stocktwits').length;
    const finnhub_company_new = inserted.filter((r) => isFinnhub(r) && company.companyIds.has(r.external_id)).length;
    const finnhub_new = inserted.filter((r) => isFinnhub(r) && !company.companyIds.has(r.external_id)).length;

    return json({
      stocktwits_new,
      finnhub_new,
      finnhub_company_new,
      merged: updated,
      breaking_new: inserted.filter((r) => r.is_breaking).length,
      stocktwits_parse_ok: stocktwits.parseOk,
      stocktwits_fetched: stocktwits.items.length,
      finnhub_fetched: finnhubItems.length,
      finnhub_company_fetched: company.fetched,
      news_tickers: newsTickers.length,
    });
  } catch (e) {
    console.error('[news-poll]', String(e).slice(0, 200));
    return json({ error: String(e) }, 500);
  }
});

async function loadRecentHeadlineNorms(supa: any): Promise<Set<string>> {
  const since = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();
  const norms = new Set<string>();
  let from = 0;
  while (true) {
    const { data, error } = await supa.from('market_news').select('headline_norm')
      .gte('fetched_at', since).order('id').range(from, from + PAGE - 1);
    if (error) throw new Error('recent headlines read failed: ' + error.message);
    (data || []).forEach((r: any) => norms.add(r.headline_norm));
    if (!data || data.length < PAGE) break;
    from += PAGE; if (from > 100000) break;
  }
  return norms;
}
