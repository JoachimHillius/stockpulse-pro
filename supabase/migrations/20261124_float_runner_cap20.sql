-- STEP 90 (source copy — already applied live; do not run)
-- 1) symbol_float + float-sync function: the float for runners and movers (Yahoo floatShares / sharesOutstanding).
-- 2) sp_float_line(): "🔄 Float 710K (2.4M shares out) · traded 33× 🔥" — rotation counted on the larger of float and
--    shares outstanding (Yahoo's small-cap float often runs low after offerings / splits).
-- 3) runner_check(): price range $0.10–$20 (was $10) · "big mover" = +30% today with $1M+ traded gets the green 🔥🔥 alert
--    even without 1M shares in the last 15 min · the float line under the phase line.
-- 4) phase_refresh(): the app's phase line ends with the float line.
-- Cron (UTC): float-sync-a '*/3 8-23 * * 1-5' · float-sync-b '*/3 0 * * 2-6' → select public.float_sync_kick()

create table if not exists public.symbol_float (symbol text primary key, float_shares numeric, shares_out numeric, updated_at timestamptz default now(), error text);
alter table public.symbol_float enable row level security;

create or replace function public.sp_float_line(p_sym text, p_vol numeric)
returns text language sql stable security definer set search_path to 'public' as $$
  select case when coalesce(f.float_shares, f.shares_out) > 0 then
    '🔄 Float ' || sp_fvol(coalesce(f.float_shares, f.shares_out)) ||
    case when f.float_shares > 0 and f.shares_out > f.float_shares * 1.3 then ' (' || sp_fvol(f.shares_out) || ' shares out)' else '' end ||
    case when coalesce(p_vol, 0) > 0 then ' · traded ' ||
      case when p_vol / b.base >= 10 then round(p_vol / b.base)::text else trim(to_char(p_vol / b.base, 'FM990.0')) end || '×' ||
      case when p_vol / b.base >= 1 then ' 🔥' else '' end else '' end end
  from symbol_float f cross join lateral (select greatest(coalesce(f.float_shares, 0), coalesce(f.shares_out, 0)) base) b
  where f.symbol = p_sym and b.base > 0 $$;
revoke all on function public.sp_float_line(text, numeric) from public, anon, authenticated;

create or replace function public.float_sync_list(p_n int default 60) returns table(symbol text)
language sql stable security definer set search_path to 'public' as $$
  select s from (
    select symbol s, 1 pri from runner_alerts where d = (now() at time zone 'America/New_York')::date
    union all select symbol, 2 from phase_cache
    union all select symbol, 3 from fast_watch) x
  where not exists (select 1 from symbol_float f where f.symbol = x.s and f.updated_at > now() - case when f.float_shares is null then interval '1 day' else interval '7 days' end)
  group by s order by min(pri), s limit p_n $$;
revoke all on function public.float_sync_list(int) from public, anon, authenticated;
grant execute on function public.float_sync_list(int) to service_role;

create or replace function public.float_sync_kick() returns void
language plpgsql security definer set search_path to 'public' as $$
declare v_key text;
begin
  if not exists (select 1 from float_sync_list(1)) then return; end if;
  v_key := substring(pg_get_functiondef('public.trigger_price_sync_batch'::regproc) from 'Bearer ([A-Za-z0-9._-]+)');
  perform net.http_post(url := 'https://siwrhqcojoyxxwaxnopc.supabase.co/functions/v1/float-sync',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_key,'apikey',v_key),
    body := '{}'::jsonb, timeout_milliseconds := 60000);
end $$;
revoke all on function public.float_sync_kick() from public, anon, authenticated;

-- runner_check(), changed parts only (full live definition is in the database):
--   runner_ticks insert:  where px between 0.10 and 20 and vol is not null
--   tier:                 case when l.vol - a15.vol15 >= 1000000 or (l.pct >= 30 and l.vol * l.px >= 1000000) then '15' ...
--   message:              ... || coalesce(sp_phase(r.symbol, r.px, r.vol) || E'\n', '') || coalesce(sp_float_line(r.symbol, r.vol) || E'\n', '') || ...
-- phase_refresh(), changed part:
--   select sp_phase(p.symbol, p.px, v.volume) || coalesce(' · ' || sp_float_line(p.symbol, v.volume), '') line
--   from (select volume from sp_vol_chg(array[p.symbol])) v
