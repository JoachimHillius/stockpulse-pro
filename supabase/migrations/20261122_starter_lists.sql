-- STEP 60: starter lists for users' main Watchlist (source copy; applied by Claude in chat).
--   penny = the admin's penny stocks: on the admin's main Watchlist and traded under $10 at any time in the
--           last 12 months, or used as a penny stock in the admin's Journal (trades, plans, daily watch list).
--           Sticky: once on the list a ticker stays, even above $10; it only leaves when it leaves the admin's Watchlist.
--   ndx   = Nasdaq-100, spx = S&P 500 (filled weekly by the starter-lists edge function).
create table if not exists public.sp_starter (
  list text not null check (list in ('penny','ndx','spx')),
  symbol text not null,
  name text,
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (list, symbol)
);
alter table public.sp_starter enable row level security;
drop policy if exists auth_read on public.sp_starter;
create policy auth_read on public.sp_starter for select to authenticated using (true);

create or replace function public.sp_starter_penny_refresh() returns int
language plpgsql security definer set search_path = public set statement_timeout = '120s' as $$
declare n int;
begin
  insert into sp_starter(list, symbol)
  select 'penny', w.symbol from (select distinct symbol from user_watchlist) w
   where exists (select 1 from price_history p where p.symbol = w.symbol and p.trading_date > current_date - 365 and p.low < 10)
      or exists (select 1 from jr_trades j where j.symbol = w.symbol and j.kind = 'penny')
      or exists (select 1 from jr_plans j where j.symbol = w.symbol and j.kind = 'penny')
      or exists (select 1 from jr_watch j where j.symbol = w.symbol and j.kind = 'penny')
  on conflict (list, symbol) do update set updated_at = now();
  delete from sp_starter where list = 'penny' and symbol not in (select symbol from user_watchlist);
  select count(*) into n from sp_starter where list = 'penny';
  return n;
end $$;
revoke all on function public.sp_starter_penny_refresh() from public, anon, authenticated;
grant execute on function public.sp_starter_penny_refresh() to service_role;

-- one list for the app: symbol, company name, last close
create or replace function public.sp_starter_get(p_list text)
returns table(symbol text, name text, close numeric)
language sql stable security definer set search_path = public as $$
  select s.symbol, coalesce(s.name, ti.name), lp.close
    from sp_starter s
    left join ticker_info ti on ti.symbol = s.symbol
    left join lateral (select close from price_history p where p.symbol = s.symbol order by trading_date desc limit 1) lp on true
   where s.list = p_list and auth.uid() is not null
   order by s.symbol;
$$;
revoke all on function public.sp_starter_get(text) from public, anon;
grant execute on function public.sp_starter_get(text) to authenticated;

-- Weekly refresh (Sunday 09:17 UTC): cron job 'starter-lists-weekly' posts to the starter-lists function
-- with the same headers as news-poll-5min; the function also runs sp_starter_penny_refresh().
