-- STEP 89 (source copy — already applied live; do not run)
-- 1) phase_runners / phase_cache: the runner phase + rating line (sp_phase) for the app, worked out every 5 minutes
--    for recent runners (an ignition in the last 15 trading days) and today's 10%+ movers. The app reads it with sp_phase_get().
-- 2) runner_check(): a runner gets the 🟩/🟨 alert again when it runs 10%+ above its last runner alert, or in a new
--    session (pre-market / regular / after-hours) — e.g. the 4 PM after-hours spike.
-- Cron (UTC): phase-refresh-a '1-59/5 8-23 * * 1-5' · phase-refresh-b '1-59/5 0 * * 2-6' · phase-runners-daily '5 9,13 * * 1-5'

create table if not exists public.phase_runners (symbol text primary key, ig_d date not null, updated_at timestamptz default now());
create table if not exists public.phase_cache (symbol text primary key, line text not null, chg_pct numeric, at timestamptz default now());
alter table public.phase_runners enable row level security;
alter table public.phase_cache enable row level security;

create or replace function public.phase_runners_refresh() returns int
language plpgsql security definer set search_path to 'public' as $$
declare v_today date := (now() at time zone 'America/New_York')::date; v_from date; n int;
begin
  select min(d) into v_from from (select distinct trading_date d from price_history where trading_date < v_today and trading_date > v_today - 40 order by 1 desc limit 15) z;
  delete from phase_runners where true;
  insert into phase_runners(symbol, ig_d)
  select symbol, max(d) from (
    select symbol, trading_date d, close, volume, lag(close) over w pcl,
           avg(volume) over (partition by symbol order by trading_date rows between 20 preceding and 1 preceding) av
    from price_history where trading_date > v_today - 70 and trading_date < v_today
    window w as (partition by symbol order by trading_date)) h
  where d >= v_from and pcl > 0 and close >= pcl * 1.20 and av > 0 and volume >= 5 * av and volume >= 2e6 and volume * close >= 1e6
  group by symbol;
  get diagnostics n = row_count; return n;
end $$;

create or replace function public.phase_refresh() returns int
language plpgsql security definer set search_path to 'public' as $$
declare n int;
begin
  create temp table _ps on commit drop as
  with live as (
    select distinct on (symbol) symbol,
      case when market_state in ('PRE','POST','POSTPOST') and ext_price is not null then ext_price else price end px,
      case when market_state in ('PRE','POST','POSTPOST') and ext_change_pct is not null then ext_change_pct else change_pct end pct, updated_at
    from (select symbol, price, change_pct, market_state, ext_price, ext_change_pct, updated_at from price_live
          union all select symbol, price, change_pct, market_state, ext_price, ext_change_pct, updated_at from market_live) x
    order by symbol, updated_at desc)
  select l.symbol, l.px, l.pct from live l
  where l.px > 0 and l.updated_at > now() - interval '1 day'
    and (abs(l.pct) >= 10 or exists (select 1 from phase_runners r where r.symbol = l.symbol));
  delete from phase_cache c where not exists (select 1 from _ps where _ps.symbol = c.symbol);
  insert into phase_cache(symbol, line, chg_pct, at)
  select p.symbol, x.line, p.pct, now()
  from _ps p cross join lateral (select sp_phase(p.symbol, p.px, (select volume from sp_vol_chg(array[p.symbol]))) line) x
  where x.line is not null
  on conflict (symbol) do update set line = excluded.line, chg_pct = excluded.chg_pct, at = excluded.at;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.sp_phase_get(p_syms text[])
returns table(symbol text, line text, at timestamptz)
language sql stable security definer set search_path to 'public' as $$
  select c.symbol, c.line, c.at from phase_cache c where c.symbol = any(p_syms)
$$;
revoke all on function public.phase_runners_refresh() from public, anon, authenticated;
revoke all on function public.phase_refresh() from public, anon, authenticated;
revoke all on function public.sp_phase_get(text[]) from public, anon;
grant execute on function public.sp_phase_get(text[]) to authenticated;

create or replace function public.sp_sess(t timestamptz) returns text language sql immutable as $$
  select case when (t at time zone 'America/New_York')::time < '09:30' then 'pre' when (t at time zone 'America/New_York')::time < '16:00' then 'reg' else 'post' end $$;

-- runner_check(), changed parts only (full live definition is in the database):
--   dedupe:  delete from _r where tier is null or exists (select 1 from runner_alerts a where a.symbol = _r.symbol and a.d = v_today
--              and (a.tier = _r.tier or a.tier = '15') and _r.px < a.px * 1.10 and sp_sess(a.at) = sp_sess(now()));
--   insert:  ... from _r on conflict (symbol, d, tier) do update set px = excluded.px, pct = excluded.pct, vol = excluded.vol,
--              vol_win = excluded.vol_win, at = now(), hi = greatest(runner_alerts.hi, excluded.px), down_sent = null;

