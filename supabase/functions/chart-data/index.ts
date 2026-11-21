// chart-data: intraday candles for the StockPulse chart (1-min to 1-hour), from Yahoo Finance, incl. pre-market and after-hours.
// Daily / weekly / monthly charts read public.price_history directly; this function only serves the short timeframes.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
// interval → [Yahoo interval, range]. Yahoo keeps 1-min for ~7 days, 5/15/30-min for ~60 days, 1-hour for ~2 years.
const IV: Record<string, [string, string]> = { '1m': ['1m', '7d'], '5m': ['5m', '60d'], '15m': ['15m', '60d'], '30m': ['30m', '60d'], '1h': ['60m', '730d'] };
const SYM = /^[A-Z^][A-Z0-9.\-]{0,9}$/;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
  try {
    const body = await req.json().catch(() => ({}));
    const symbol = String(body.symbol || '').trim().toUpperCase();
    const iv = IV[String(body.interval || '')];
    if (!SYM.test(symbol) || !iv) return json({ error: 'bad symbol or interval' }, 400);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol.replace('.', '-'))}?interval=${iv[0]}&range=${iv[1]}&includePrePost=true`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StockPulseChart/1.0)' }, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return json({ error: `source HTTP ${res.status}`, candles: [] }, 502);
    const r = (await res.json())?.chart?.result?.[0];
    const ts: number[] = r?.timestamp || [], q = r?.indicators?.quote?.[0] || {};
    const candles = [];
    for (let i = 0; i < ts.length; i++) {
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
      if (o == null || h == null || l == null || c == null) continue;
      candles.push({ t: ts[i], o: +o.toFixed(4), h: +h.toFixed(4), l: +l.toFixed(4), c: +c.toFixed(4), v: q.volume?.[i] ?? 0 });
    }
    return json({ symbol, interval: body.interval, candles, tz: r?.meta?.exchangeTimezoneName || 'America/New_York' });
  } catch (e) {
    return json({ error: String(e).slice(0, 160), candles: [] }, 500);
  }
});
