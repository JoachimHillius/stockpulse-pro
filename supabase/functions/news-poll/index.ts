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
const MOVE_WORDS = ['plunge', 'plunges', 'surge', 'surges', 'soar', 'tumble', 'sinks', 'rallies', 'crash', 'sell-off', 'selloff', 'halt', 'record high', 'breaking'];

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRegex = (term: string) => new RegExp(`(?<![A-Za-z0-9])${escapeRegex(term)}(?![A-Za-z0-9])`, 'i');

const CATEGORY_REGEXES = Object.entries(CATEGORY_KEYWORDS).map(
  ([category, terms]) => [category, terms.map(wordRegex)] as [string, RegExp[]]
);
const MOVE_REGEXES = MOVE_WORDS.map(wordRegex);

function classify(item: NewsItem): { categories: string[], relevance: number, is_breaking: boolean } {
  const text = `${item.headline} ${item.summary || ''} ${item.tickers.join(' ')}`;
  const categories = CATEGORY_REGEXES.filter(([, regexes]) => regexes.some(re => re.test(text))).map(([c]) => c);
  const hasMoveWord = MOVE_REGEXES.some(re => re.test(item.headline));
  const relevance = categories.length + (hasMoveWord ? 2 : 0);
  const ageMs = Date.now() - new Date(item.published_at).getTime();
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

async function loadRecentHeadlineNorms(supa: any): Promise<Set<string>> {
  const PAGE = 1000;
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

async function insertNew(supa: any, items: NewsItem[], seenNorms: Set<string>): Promise<{ inserted: number, breaking: number }> {
  const rows: any[] = [];
  for (const item of items) {
    const norm = normalizeHeadline(item.headline);
    if (!norm || seenNorms.has(norm)) continue;
    seenNorms.add(norm); // also dedupes within this run and across the two sources
    rows.push({ ...item, ...classify(item) });
  }
  if (!rows.length) return { inserted: 0, breaking: 0 };
  const { data, error } = await supa.from('market_news')
    .upsert(rows, { onConflict: 'source,external_id', ignoreDuplicates: true })
    .select('is_breaking');
  if (error) throw new Error('market_news insert failed: ' + error.message);
  const inserted = data?.length || 0;
  return { inserted, breaking: (data || []).filter((r: any) => r.is_breaking).length };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

  try {
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const [stocktwits, finnhubItems, seenNorms] = await Promise.all([
      fetchStocktwits(), fetchFinnhub(), loadRecentHeadlineNorms(supa),
    ]);

    const st = await insertNew(supa, stocktwits.items, seenNorms);
    const fh = await insertNew(supa, finnhubItems, seenNorms);

    return json({
      stocktwits_new: st.inserted,
      finnhub_new: fh.inserted,
      breaking_new: st.breaking + fh.breaking,
      stocktwits_parse_ok: stocktwits.parseOk,
      stocktwits_fetched: stocktwits.items.length,
      finnhub_fetched: finnhubItems.length,
    });
  } catch (e) {
    console.error('[news-poll]', String(e).slice(0, 200));
    return json({ error: String(e) }, 500);
  }
});
