-- Journal watch list: last 5 daily candles per ticker (close, % change vs the day before, volume).
-- Applied 2026-11-21 via Supabase MCP (migration journal_watch_last5).
create or replace function public.jr_last5(p_syms text[])
returns table(symbol text, d date, close numeric, chg_pct numeric, volume numeric, n int)
language sql stable as $$
  select s.sym, x.trading_date, x.close,
         case when x.prev > 0 then round((x.close / x.prev - 1) * 100, 2) end, x.volume, x.rn::int
  from unnest(p_syms) as s(sym)
  cross join lateral (
    select h.trading_date, h.close, h.volume, lag(h.close) over (order by h.trading_date) prev,
           row_number() over (order by h.trading_date desc) rn
    from (select trading_date, close, volume from public.price_history where symbol = s.sym order by trading_date desc limit 6) h
  ) x
  where x.rn <= 5
$$;
grant execute on function public.jr_last5(text[]) to anon;
