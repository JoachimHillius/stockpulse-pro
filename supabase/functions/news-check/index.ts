// news-check — news verdict for every Single Pattern stock (scan results + the Penny / Large / MAG 7 + added lists).
// Source: Yahoo Finance search news (free, no Finnhub quota used). Window: the last 5 days.
// Each headline is tagged by keyword rules: good / bad / neutral. Verdict per stock:
//   none  = no articles in the window
//   good  = at least one good headline and no bad ones
//   bad   = at least one bad headline and no good ones
//   check = articles exist but they are mixed (good + bad) or not clearly either way
// Writes public.sp_news. Each run handles the stocks checked longest ago (up to MAX_PER_RUN).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const WINDOW_MS = 5 * 86400_000;
const MAX_PER_RUN = 80;
const CONCURRENCY = 4;

const BAD = [
  /\bpublic offering\b/, /\b(registered|direct|secondary|stock) offering\b/, /\bprices? .{0,30}offering\b/, /\bdilut/, /\breverse (stock )?split\b/,
  /\bdelist/, /\bdeficiency\b/, /\bnon-?compliance\b/, /\bbankrupt/, /\bchapter 11\b/, /\bgoing concern\b/, /\blawsuit\b/, /\bclass action\b/,
  /\binvestigation\b/, /\bsubpoena\b/, /\bsec charges?\b/, /\bfraud\b/, /\bshort seller\b/, /\bdowngrade/, /\bcuts? .{0,20}(price target|guidance|outlook|forecast)\b/,
  /\b(price target|guidance|outlook|forecast) cut\b/, /\blowers? .{0,15}(guidance|outlook|forecast)\b/, /\bmiss(es|ed)?\b.{0,25}\b(estimates?|expectations|revenue|earnings)\b/,
  /\bbelow (estimates|expectations)\b/, /\bwarns?\b/, /\brecall/, /\bhalt(s|ed)?\b/, /\bcomplete response letter\b/, /\bcrl\b/, /\brejects?\b/,
  /\bfail(s|ed)?\b/, /\bterminat/, /\bresign/, /\blayoffs?\b/, /\bdefault/, /\bplunge/, /\bsinks?\b/, /\btumbles?\b/, /\bcrash/, /\bslump/,
  /\bfalls?\b/, /\bdrops?\b/, /\bslides?\b/, /\bslips?\b/, /\bdeclines?\b/, /\bshares (are )?down\b/, /\bloss widens\b/, /\b(cuts|decreases|suspends) .{0,10}dividend\b/, /\bdividend cut\b/,
];
const GOOD = [
  /\bfda (approval|approves|clears|clearance)\b/, /\bapprov(al|es|ed)\b/, /\bclearance\b/, /\bcontract\b/, /\bawarded?\b/, /\bpartnership\b/,
  /\bcollaborat/, /\bagreement\b/, /\bto be acquired\b/, /\bacquisition by\b/, /\bbuyout\b/, /\bbuyback\b/, /\brepurchase\b/, /\bupgrade/,
  /\braises? .{0,20}(guidance|outlook|forecast|price target)\b/, /\bbeats?\b/, /\btops? .{0,15}(estimates|expectations)\b/, /\brecord (revenue|quarter|sales|results)\b/,
  /\bsurge/, /\bsoar/, /\bjumps?\b/, /\brall(y|ies)\b/, /\bbreakthrough\b/, /\bpositive .{0,20}(results|data|topline)\b/, /\bmeets? .{0,15}endpoint\b/,
  /\blaunch(es|ed)?\b/, /\bwins?\b/, /\buplist/, /\bdividend (increase|hike)\b/, /\bstrong (buy|demand|results)\b/,
  /\bsecures?\b/, /\b(largest|new|major) order\b/, /\brevenue (increases?|rises|grows|up)\b/,
];

function tag(headline: string): 'good' | 'bad' | 'neutral' {
  const h = headline.toLowerCase();
  const bad = BAD.some(r => r.test(h));
  const good = GOOD.some(r => r.test(h));
  if (bad && !good) return 'bad';
  if (good && !bad) return 'good';
  return 'neutral';
}

// A headline counts only if it names the stock: the ticker, or the company's short name
// (e.g. "Abeona", "Arrowhead", "Meta"). General market stories ("Nasdaq falls…") are dropped.
const SKIP = new Set(['the', 'a', 'an', 'first', 'american', 'united', 'global', 'international', 'new']);
function shortName(name?: string): string | null {
  if (!name) return null;
  const words = name.split(/\s+-\s+/)[0].replace(/[.,]/g, ' ').split(/\s+/).filter(Boolean);
  let i = 0; while (i < words.length - 1 && SKIP.has(words[i].toLowerCase())) i++;
  const w = words.slice(0, i + 1).join(' ');
  return w.replace(/[^a-z0-9 ]/gi, '').length >= 3 ? w : null;
}
// Names the press uses that differ from the listed company name.
const ALIAS: Record<string, string[]> = { GOOG: ['Google', 'Alphabet'], GOOGL: ['Google', 'Alphabet'], META: ['Facebook', 'Instagram'], SPCX: ['SpaceX'] };
function aboutStock(title: string, sym: string, name?: string): boolean {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`(^|[^A-Za-z])\\$?${esc(sym)}([^A-Za-z]|$)`).test(title)) return true;
  const sn = shortName(name);
  if (sn && new RegExp(`\\b${esc(sn)}`, 'i').test(title)) return true;
  return (ALIAS[sym] || []).some(a => new RegExp(`\\b${esc(a)}\\b`, 'i').test(title));
}

async function yahooNews(sym: string): Promise<any[] | null> {
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(sym)}&quotesCount=1&newsCount=12&enableFuzzyQuery=false`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) { try { await r.body?.cancel(); } catch (_) { /**/ } return null; }
    const j = await r.json();
    return Array.isArray(j?.news) ? j.news : [];
  } catch (_) { return null; }
}

Deno.serve(async (req: Request) => {
  const started = Date.now();
  try {
    const body = await req.json().catch(() => ({}));
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    let symbols: string[] = Array.isArray(body.symbols) ? body.symbols.map((s: unknown) => String(s).toUpperCase()).slice(0, MAX_PER_RUN) : [];
    const names: Record<string, string> = {};
    if (!symbols.length) {
      const { data, error } = await supa.rpc('sp_news_queue', { p_limit: MAX_PER_RUN });
      if (error) throw new Error('queue: ' + error.message);
      symbols = (data || []).map((r: any) => { if (r.name) names[r.symbol] = r.name; return r.symbol; });
    }
    const cutoff = Date.now() - WINDOW_MS;
    const rows: any[] = []; let failed = 0; let cursor = 0;
    const worker = async () => {
      while (cursor < symbols.length) {
        const sym = symbols[cursor++];
        const news = await yahooNews(sym);
        if (news === null) { failed++; continue; }
        const items = news
          .filter(n => n?.title && Number(n.providerPublishTime) * 1000 >= cutoff)
          .filter(n => aboutStock(String(n.title), sym, names[sym]))
          .map(n => ({ h: String(n.title).slice(0, 240), url: n.link || null, src: n.publisher || null,
                       t: new Date(Number(n.providerPublishTime) * 1000).toISOString(), tag: tag(String(n.title)) }))
          .sort((a, b) => b.t.localeCompare(a.t)).slice(0, 8);
        const g = items.filter(i => i.tag === 'good').length, b = items.filter(i => i.tag === 'bad').length;
        const verdict = !items.length ? 'none' : (g && !b) ? 'good' : (b && !g) ? 'bad' : 'check';
        rows.push({ symbol: sym, verdict, n_articles: items.length, n_good: g, n_bad: b, items, checked_at: new Date().toISOString() });
        await new Promise(r => setTimeout(r, 250));
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (rows.length) {
      const { error } = await supa.from('sp_news').upsert(rows, { onConflict: 'symbol' });
      if (error) throw new Error('upsert: ' + error.message);
    }
    const counts = rows.reduce((m: Record<string, number>, r) => (m[r.verdict] = (m[r.verdict] || 0) + 1, m), {});
    return Response.json({ checked: rows.length, failed, counts, ms: Date.now() - started });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
});
