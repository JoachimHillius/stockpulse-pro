-- STEP 79: list filters (Volume High → Low, min volume, % CHG) — latest volume and % change for the tickers on screen.
-- Already applied live — source copy only.
create or replace function public.sp_vol_chg(p_syms text[])
returns table(symbol text, volume numeric, chg_pct numeric, at timestamptz)
language sql stable security definer set search_path to 'public' as $$
  select distinct on (x.symbol) x.symbol, x.volume, x.chg, x.updated_at
  from (
    select symbol, volume::numeric, case when market_state in ('PRE','POST','POSTPOST') and ext_change_pct is not null then ext_change_pct else change_pct end chg, updated_at
    from price_live where symbol = any(p_syms)
    union all
    select symbol, volume::numeric, case when market_state in ('PRE','POST','POSTPOST') and ext_change_pct is not null then ext_change_pct else change_pct end, updated_at
    from market_live where symbol = any(p_syms)
  ) x
  order by x.symbol, (x.volume is null), x.updated_at desc
$$;
revoke all on function public.sp_vol_chg(text[]) from public, anon;
grant execute on function public.sp_vol_chg(text[]) to authenticated;
