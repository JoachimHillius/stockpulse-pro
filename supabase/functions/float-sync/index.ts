// float-sync (STEP 90) — the float (shares that trade freely) for runners and movers, from Yahoo (defaultKeyStatistics.floatShares).
//  Picks up to 60 symbols per run from float_sync_list(): today's runner alerts first, then the phase list (recent runners +
//  today's 10%+ movers), then the fast list. A known float is refreshed weekly, a missing one daily. Stored in public.symbol_float;
//  sp_float_line() turns it into "🔄 Float 2.35M · traded 34× its float 🔥" for the runner alerts and the app.
//  Started every 5 minutes by float_sync_kick() (pg_cron); does nothing when every float is fresh.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function yahooSession(): Promise<{ cookie: string; crumb: string } | null> {
  try {
    const r1 = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(8000) });
    const cookie = (typeof (r1.headers as any).getSetCookie === 'function' ? (r1.headers as any).getSetCookie() : [r1.headers.get('set-cookie') || ''])
      .map((c: string) => c.split(';')[0].trim()).filter(Boolean).join('; ');
    try { await r1.body?.cancel(); } catch (_) { /**/ }
    const r2 = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, cookie }, signal: AbortSignal.timeout(8000) });
    const crumb = (await r2.text()).trim();
    return r2.ok && crumb && crumb.length < 40 && !/\s/.test(crumb) ? { cookie, crumb } : null;
  } catch (_) { return null; }
}

Deno.serve(async (_req: Request) => {
  try {
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: list, error } = await supa.rpc('float_sync_list', { p_n: 60 });
    if (error) throw new Error(error.message);
    const syms: string[] = (list || []).map((r: any) => r.symbol);
    if (!syms.length) return Response.json({ ok: true, synced: 0 });
    const ys = await yahooSession();
    if (!ys) throw new Error('Yahoo session failed');
    const rows: any[] = [];
    let i = 0;
    await Promise.all(Array.from({ length: 6 }, async () => { while (i < syms.length) { const s = syms[i++];
      const now = new Date().toISOString();
      try {
        const r = await fetch(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(s.replace('.', '-'))}?modules=defaultKeyStatistics&crumb=${encodeURIComponent(ys.crumb)}`,
          { headers: { 'User-Agent': UA, cookie: ys.cookie }, signal: AbortSignal.timeout(10000) });
        if (!r.ok) { try { await r.body?.cancel(); } catch (_) { /**/ } rows.push({ symbol: s, float_shares: null, shares_out: null, updated_at: now, error: 'HTTP ' + r.status }); continue; }
        const ks = (await r.json())?.quoteSummary?.result?.[0]?.defaultKeyStatistics || {};
        const fl = Number(ks.floatShares?.raw), so = Number(ks.sharesOutstanding?.raw ?? ks.impliedSharesOutstanding?.raw);
        rows.push({ symbol: s, float_shares: fl > 0 ? fl : null, shares_out: so > 0 ? so : null, updated_at: now, error: fl > 0 ? null : 'no float' });
      } catch (e) { rows.push({ symbol: s, float_shares: null, shares_out: null, updated_at: now, error: String(e).slice(0, 80) }); }
    } }));
    // a failed lookup never wipes a known float
    const good = rows.filter(r => r.float_shares), bad = rows.filter(r => !r.float_shares);
    if (good.length) await supa.from('symbol_float').upsert(good, { onConflict: 'symbol' });
    if (bad.length) {
      const { data: known } = await supa.from('symbol_float').select('symbol').in('symbol', bad.map(r => r.symbol)).not('float_shares', 'is', null);
      const k = new Set((known || []).map((r: any) => r.symbol));
      const fresh = bad.filter(r => !k.has(r.symbol));
      if (fresh.length) await supa.from('symbol_float').upsert(fresh, { onConflict: 'symbol' });
      if (k.size) await supa.from('symbol_float').update({ updated_at: new Date().toISOString() }).in('symbol', [...k]);
    }
    return Response.json({ ok: true, asked: syms.length, synced: good.length, missing: bad.length });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
});
