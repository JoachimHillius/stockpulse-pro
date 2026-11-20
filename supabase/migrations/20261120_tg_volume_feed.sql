-- Telegram News page: today's running volume per ticker (public.vol_accum, written by fast-scan) and how it grew.
-- Applied 2026-11-20 via Supabase MCP (migration tg_volume_feed).
create table if not exists public.vol_accum_hist (
  symbol text not null, d date not null, at timestamptz not null default now(),
  today_vol bigint, pre_vol bigint, reg_vol bigint, post_vol bigint,
  primary key (symbol, d, at));
alter table public.vol_accum_hist enable row level security;   -- read only through tg_vol_hist()

create or replace function public.vol_accum_log() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.today_vol is distinct from old.today_vol or new.d is distinct from old.d then
    insert into vol_accum_hist(symbol, d, at, today_vol, pre_vol, reg_vol, post_vol)
    values (new.symbol, new.d, coalesce(new.updated_at, now()), new.today_vol, new.pre_vol, new.reg_vol, new.post_vol)
    on conflict do nothing;
  end if;
  return new;
end $$;
drop trigger if exists vol_accum_log on public.vol_accum;
create trigger vol_accum_log after insert or update on public.vol_accum for each row execute function public.vol_accum_log();

insert into public.vol_accum_hist(symbol, d, at, today_vol, pre_vol, reg_vol, post_vol)
select symbol, d, coalesce(updated_at, now()), today_vol, pre_vol, reg_vol, post_vol from public.vol_accum on conflict do nothing;

create or replace function public.tg_vol(p_days int default 9)
returns table(symbol text, d date, today_vol bigint, pre_vol bigint, reg_vol bigint, post_vol bigint, prev_vol bigint, updated_at timestamptz,
              first_vol bigint, first_at timestamptz, readings int)
language sql stable security definer set search_path = public as $$
  select v.symbol, v.d, v.today_vol, v.pre_vol, v.reg_vol, v.post_vol, v.prev_vol, v.updated_at,
         h.first_vol, h.first_at, coalesce(h.n, 0)::int
  from vol_accum v
  left join lateral (select (array_agg(x.today_vol order by x.at))[1] first_vol, min(x.at) first_at, count(*) n
                     from vol_accum_hist x where x.symbol = v.symbol and x.d = v.d) h on true
  where v.d >= current_date - least(greatest(coalesce(p_days, 9), 1), 14)
$$;
create or replace function public.tg_vol_hist(p_symbol text)
returns table(at timestamptz, today_vol bigint, pre_vol bigint, reg_vol bigint, post_vol bigint)
language sql stable security definer set search_path = public as $$
  select x.at, x.today_vol, x.pre_vol, x.reg_vol, x.post_vol from vol_accum_hist x
  where x.symbol = upper(p_symbol) and x.d = (select max(d) from vol_accum_hist where symbol = upper(p_symbol))
  order by x.at
$$;
revoke all on function public.tg_vol(int) from public;
revoke all on function public.tg_vol_hist(text) from public;
grant execute on function public.tg_vol(int), public.tg_vol_hist(text) to anon, authenticated;

create or replace function public.vol_accum_hist_trim() returns void language sql security definer set search_path = public as $$
  delete from vol_accum_hist where d < current_date - 14 $$;
select cron.schedule('vol-accum-hist-trim', '40 3 * * *', 'select public.vol_accum_hist_trim()');
