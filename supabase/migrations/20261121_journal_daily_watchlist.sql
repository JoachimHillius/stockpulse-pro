-- Journal → Watchlist: a short daily watch list (max 20 large caps, 10 penny stocks per day), recycled after 30 days.
-- Applied 2026-11-21 via Supabase MCP (migration journal_daily_watchlist).
create table if not exists public.jr_watch (
  id bigserial primary key,
  d date not null,
  kind text not null check (kind in ('penny','large')),
  symbol text not null,
  note text,
  created_at timestamptz not null default now(),
  unique (d, symbol)
);
alter table public.jr_watch enable row level security;
drop policy if exists anon_all_jr_watch on public.jr_watch;
create policy anon_all_jr_watch on public.jr_watch for all to anon using (true) with check (true);
grant select, insert, update, delete on public.jr_watch to anon;
grant usage, select on sequence public.jr_watch_id_seq to anon;

create or replace function public.jr_watch_cap() returns trigger language plpgsql as $$
begin
  if (select count(*) from public.jr_watch where d = new.d and kind = new.kind) >= (case when new.kind = 'large' then 20 else 10 end) then
    raise exception 'Daily watch list is full (% max %)', new.kind, case when new.kind = 'large' then 20 else 10 end;
  end if;
  return new;
end $$;
drop trigger if exists jr_watch_cap on public.jr_watch;
create trigger jr_watch_cap before insert on public.jr_watch for each row execute function public.jr_watch_cap();

create or replace function public.jr_quotes(p_syms text[])
returns table(symbol text, d date, close numeric, prev_close numeric, chg_pct numeric, volume numeric)
language sql stable as $$
  select s.sym, l.trading_date, l.close, p.close,
         case when p.close > 0 then round((l.close / p.close - 1) * 100, 2) end, l.volume
  from unnest(p_syms) as s(sym)
  cross join lateral (select trading_date, close, volume from public.price_history h where h.symbol = s.sym order by trading_date desc limit 1) l
  left join lateral (select close from public.price_history h where h.symbol = s.sym and h.trading_date < l.trading_date order by trading_date desc limit 1) p on true
$$;
grant execute on function public.jr_quotes(text[]) to anon;

select cron.schedule('jr-watch-trim', '50 3 * * *', $$delete from public.jr_watch where d < current_date - 30$$);
