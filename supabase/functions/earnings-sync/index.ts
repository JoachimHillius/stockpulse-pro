import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

// Target ET minute-of-day per slot; the job runs within 10 min after each.
const SLOT_TARGET_MIN: Record<string, number> = {
  morning: 7 * 60 + 0,   // 07:00 ET
  pm1: 16 * 60 + 10,     // 16:10 ET
  pm2: 16 * 60 + 40,     // 16:40 ET
  pm3: 17 * 60 + 55,     // 17:55 ET
};
const GATE_WINDOW_MIN = 10;

// Parts of `date` in America/New_York.
function etParts(date = new Date()): { date: string, weekday: string, minuteOfDay: number } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
    }).formatToParts(date).map((x) => [x.type, x.value]),
  );
  const hour = p.hour === '24' ? 0 : Number(p.hour);
  return { date: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday as string, minuteOfDay: hour * 60 + Number(p.minute) };
}

// ET calendar date offset by `days`, as YYYY-MM-DD (Finnhub expects calendar dates).
function etDateOffset(days: number): string {
  const { date } = etParts(new Date(Date.now() + days * 24 * 60 * 60 * 1000));
  return date;
}

function gateOk(slot: string, et: { weekday: string, minuteOfDay: number }): boolean {
  if (slot === 'manual') return true;
  if (['Sat', 'Sun'].includes(et.weekday)) return false;
  const target = SLOT_TARGET_MIN[slot];
  if (target === undefined) return false;
  return et.minuteOfDay >= target && et.minuteOfDay < target + GATE_WINDOW_MIN;
}

async function fetchEarnings(from: string, to: string, token: string): Promise<{ status: number, rows: any[] }> {
  const url = `https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) return { status: res.status, rows: [] };
  const data = await res.json();
  const rows = Array.isArray(data?.earningsCalendar) ? data.earningsCalendar : [];
  return { status: res.status, rows };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

  try {
    let body: any = {};
    try { body = await req.json(); } catch { /* empty body ok */ }
    const slot = String(body?.slot ?? 'manual');
    const probe = body?.probe === true;

    const token = Deno.env.get('FINNHUB_API_KEY');
    if (!token) return json({ error: 'FINNHUB_API_KEY not set' }, 500);

    const et = etParts();

    // Probe (Task 3 step 1): one today->today call, report status/count and 2 raw rows. No writes.
    if (probe) {
      const today = etDateOffset(0);
      const { status, rows } = await fetchEarnings(today, today, token);
      return json({ probe: true, http_status: status, row_count: rows.length, sample: rows.slice(0, 2) });
    }

    // ET gate: weekdays, within 10 min after the slot's target (manual always runs).
    if (!gateOk(slot, et)) {
      return json({ skipped: true, reason: 'et-gate', slot, et_date: et.date, et_weekday: et.weekday, et_minute_of_day: et.minuteOfDay });
    }

    const from = etDateOffset(-1);
    const to = etDateOffset(7);
    const { status, rows } = await fetchEarnings(from, to, token);
    if (status !== 200) return json({ error: 'finnhub earnings HTTP ' + status, slot, from, to }, 502);

    // Map Finnhub fields -> actual earnings_calendar columns (report_hour / fetched_at; no quarter/year).
    const now = new Date().toISOString();
    const seen = new Set<string>();
    const upserts: any[] = [];
    for (const r of rows) {
      if (!r?.symbol || !r?.date) continue;
      const key = `${r.symbol} ${r.date}`;
      if (seen.has(key)) continue; // dedupe on PK within the batch
      seen.add(key);
      upserts.push({
        symbol: String(r.symbol),
        report_date: String(r.date),
        report_hour: r.hour ?? null,
        eps_estimate: r.epsEstimate ?? null,
        eps_actual: r.epsActual ?? null,
        revenue_estimate: r.revenueEstimate ?? null,
        revenue_actual: r.revenueActual ?? null,
        fetched_at: now,
      });
    }

    let upserted = 0;
    for (let b = 0; b < upserts.length; b += 500) {
      const batch = upserts.slice(b, b + 500);
      const { data, error } = await supaClient().from('earnings_calendar')
        .upsert(batch, { onConflict: 'symbol,report_date' }).select('symbol');
      if (error) throw new Error('earnings_calendar upsert failed: ' + error.message);
      upserted += (data || []).length;
    }

    return json({ slot, from, to, fetched: rows.length, upserted, et_date: et.date });
  } catch (e) {
    console.error('[earnings-sync]', String(e).slice(0, 200));
    return json({ error: String(e) }, 500);
  }
});

function supaClient() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
}
