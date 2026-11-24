-- STEP 85: volume for the stock lists — TODAY's running volume (bold) + YESTERDAY's full-day volume (gray).
-- Already applied live — source copy only.
--  today  = the larger of fast-scan's running volume (vol_accum, incl. pre-market / after-hours) and the live feed's
--           volume — the live feed only counts once the regular session has started (before the open it is still yesterday's).
--  prev   = yesterday's full-day volume (vol_accum.prev_vol, else the last daily bar before today).
drop function if exists public.sp_vol_chg(text[]);
create function public.sp_vol_chg(p_syms text[])
returns table(symbol text, volume numeric, chg_pct numeric, prev_vol numeric, at timestamptz)
language sql stable security definer set search_path to 'public' as $$
  with t as (select (now() at time zone 'America/New_York')::date d),
  live as (
    select distinct on (x.symbol) x.symbol, x.volume, x.chg, x.market_state, x.updated_at
    from (
      select symbol, volume::numeric volume, case when market_state in ('PRE','POST','POSTPOST') and ext_change_pct is not null then ext_change_pct else change_pct end chg, market_state, updated_at
      from price_live where symbol = any(p_syms)
      union all
      select symbol, volume::numeric, case when market_state in ('PRE','POST','POSTPOST') and ext_change_pct is not null then ext_change_pct else change_pct end, market_state, updated_at
      from market_live where symbol = any(p_syms)
    ) x order by x.symbol, x.updated_at desc)
  select s.sym,
         nullif(greatest(coalesce(va.today_vol, 0),
                         case when l.market_state in ('REGULAR','POST','POSTPOST') and (l.updated_at at time zone 'America/New_York')::date = t.d then coalesce(l.volume, 0) else 0 end), 0)::numeric,
         l.chg,
         coalesce(va.prev_vol, ph.volume)::numeric,
         greatest(va.updated_at, l.updated_at)
  from unnest(p_syms) s(sym) cross join t
  left join live l on l.symbol = s.sym
  left join vol_accum va on va.symbol = s.sym and va.d = t.d
  left join lateral (select volume from price_history p where p.symbol = s.sym and p.trading_date < t.d order by p.trading_date desc limit 1) ph on true
$$;
revoke all on function public.sp_vol_chg(text[]) from public, anon;
grant execute on function public.sp_vol_chg(text[]) to authenticated;
