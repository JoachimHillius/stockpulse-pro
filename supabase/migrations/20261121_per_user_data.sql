-- Per-user data (part A, applied 2026-11-21 via Supabase MCP: per_user_data_a + per_user_data_autofill_admin_only).
-- Part B (closing the old open access once the new app is live) is applied separately after the deploy.
create or replace function public.sp_owner() returns uuid language sql stable security definer set search_path = public as $$
  select coalesce(auth.uid(), (select id from sp_profiles where role = 'admin' order by created_at limit 1)) $$;
grant execute on function public.sp_owner() to anon, authenticated;
-- own tables: user_id (existing rows = admin), own-row policies
--   jr_trades, jr_days, jr_risk, jr_audit, jr_plans, jr_watch, jc_drawings:
--   add column user_id uuid not null default public.sp_owner(); policy own_rows (user_id = auth.uid()) for authenticated
create unique index if not exists jr_days_user_d on public.jr_days (user_id, d);
create unique index if not exists jr_audit_user_week on public.jr_audit (user_id, week_start);
create unique index if not exists jc_drawings_user_symbol on public.jc_drawings (user_id, symbol);
create unique index if not exists jr_watch_user_d_symbol on public.jr_watch (user_id, d, symbol);
-- jr_watch_cap counts per user; sp_user_watchlist = each user's own main Watchlist (admin keeps user_watchlist)
create table if not exists public.sp_user_watchlist (
  id bigserial primary key, user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  symbol text not null, sector text default 'Custom', added_at timestamptz not null default now(), unique (user_id, symbol));
-- shared market tables: auth_read (select, everyone signed in) + admin_write (all, admin only);
-- jr_symbols: auth_all; user_settings, jr_stage, user_watchlist: admin only for signed-in users
-- get_sync_universe also reads sp_user_watchlist; wl_autofill reads only the admin's jr_trades / jr_plans / jr_watch
