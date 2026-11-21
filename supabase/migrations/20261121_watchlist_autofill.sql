-- One big Watchlist: tickers from Telegram alerts, Single Pattern and the Journal are added to user_watchlist ('Custom') at 9:00, 12:00, 16:30, 20:30 ET.
-- Applied 2026-11-21 via Supabase MCP (migrations watchlist_autofill + watchlist_autofill_builtin_fix). One-time catch-up run: select public.wl_autofill(7); -- added 812
create or replace function public.wl_autofill(p_days int default 2)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  with src as (
    select coalesce(m[1], m[2]) sym from telegram_outbox o,
      regexp_matches(o.text, 'STOP ([A-Z][A-Z0-9.\-]{0,7}) to mute|^\S+ ([A-Z][A-Z0-9.\-]{0,7}) [+-]\d', 'g') m
    where o.status = 'sent' and coalesce(o.sent_at, o.created_at) > now() - make_interval(days => greatest(p_days, 1))
    union select symbol from single_pattern
    union select symbol from jr_trades
    union select symbol from jr_plans
    union select symbol from jr_watch
  ), builtin(sym) as (select unnest(array['CL','COST','KO','MDLZ','MNST','MO','PEP','PG','PM','WMT','AAPL','ADBE','AVGO','CRM','GOOGL','META','MSFT','NVDA','ORCL','PLTR','RIVN','SMCI','TSLA','MRVL','TTD','AMD','INTC','MU','QCOM','AEP','CEG','D','DUK','EXC','NEE','SRE','VST','XEL','AA','APD','CENX','CLF','CRH','CSTM','CTVA','FCX','FLNC','FMC','KALU','LIN','MLM','NEM','NUE','RIO','RS','AXP','BAC','C','JPM','SCHW','V','WFC','A','CELH','CVS','HUM','MRNA','PFE','UNH','BE','CCJ','COP','CVX','ET','FANG','FSLR','KMI','OXY','PSX','RIG','SHEL','SLB','TTE','WMB','XOM','AMZN','BABA','CAR','CMG','LEVI','NFLX','NKE','PTON','PYPL','T','TMUS','VZ','AAL','B','DAL','R','UNF','RR','BTDR','CIFR','CLSK','COIN','CRCL','IBIT','IREN','MARA','MSTR','WULF','GDX','GLD','HL','SLV','APLD','BMNR','FNMA','HOOD','ONDS','PL','QBTS','SOFI','EEM','HYG','IWM','QQQ','SPY','XLE','SOXL'])), ins as (
    insert into user_watchlist (symbol, sector)
    select distinct upper(trim(sym)), 'Custom' from src
    where sym ~ '^[A-Z][A-Z0-9.\-]{0,7}$'
      and upper(trim(sym)) not in (select sym from builtin)
      and not exists (select 1 from user_watchlist w where w.symbol = upper(trim(src.sym)))
    on conflict (symbol) do nothing
    returning 1)
  select count(*) into n from ins;
  return n;
end $$;
revoke all on function public.wl_autofill(int) from public, anon;
-- each time at both UTC offsets so it stays on New York time through daylight saving (extra runs add nothing)
select cron.schedule('wl-autofill-a', '0 13,14,16,17 * * *', $$select public.wl_autofill(2)$$);
select cron.schedule('wl-autofill-b', '30 0,1,20,21 * * *', $$select public.wl_autofill(2)$$);
