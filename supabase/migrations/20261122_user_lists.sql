-- STEP 62 (source copy; applied by Claude in chat):
--   new users start with the admin's penny list on their Watchlist; the admin can see / add to any user's Watchlist.
create or replace function public.sp_wl_add_penny(p_user uuid) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into sp_user_watchlist(user_id, symbol, sector)
  select p_user, s.symbol, coalesce(ss.sector, 'Custom')
    from sp_starter s left join symbol_sectors ss on ss.symbol = s.symbol
   where s.list = 'penny'
  on conflict (user_id, symbol) do nothing;
  get diagnostics n = row_count; return n;
end $$;
revoke all on function public.sp_wl_add_penny(uuid) from public, anon, authenticated;

create or replace function public.sp_profile_start_list() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.role, 'user') <> 'admin' then perform sp_wl_add_penny(new.id); end if;
  return new;
end $$;
drop trigger if exists sp_profile_start_list on public.sp_profiles;
create trigger sp_profile_start_list after insert on public.sp_profiles for each row execute function public.sp_profile_start_list();

-- admin: one user's Watchlist tickers
create or replace function public.sp_admin_wl(p_user uuid) returns setof text
language sql stable security definer set search_path = public as $$
  select symbol from sp_user_watchlist where user_id = p_user and sp_is_admin() order by symbol
$$;
-- admin: add tickers to one user's Watchlist (returns how many were new)
create or replace function public.sp_admin_wl_add(p_user uuid, p_symbols text[]) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not sp_is_admin() then raise exception 'admin only'; end if;
  insert into sp_user_watchlist(user_id, symbol, sector)
  select p_user, x.sym, coalesce(ss.sector, 'Custom')
    from (select distinct upper(trim(s)) sym from unnest(p_symbols) s) x
    left join symbol_sectors ss on ss.symbol = x.sym
   where x.sym ~ '^[A-Z]{1,6}$'
  on conflict (user_id, symbol) do nothing;
  get diagnostics n = row_count; return n;
end $$;
revoke all on function public.sp_admin_wl(uuid), public.sp_admin_wl_add(uuid, text[]) from public, anon;
grant execute on function public.sp_admin_wl(uuid), public.sp_admin_wl_add(uuid, text[]) to authenticated;

-- existing users who were created before this (jason): give them the penny list now
select public.sp_wl_add_penny(id) from public.sp_profiles where role <> 'admin';
