-- STEP 59 part B (source copy; applied by Claude in chat on 2026-11-21 after the STEP 59 deploy).
-- Closes the old open (anon) access to per-user data, switches the old one-row keys to per-user keys,
-- and lets new users straight into the app.
drop policy if exists anon_all_jr_trades on public.jr_trades;
drop policy if exists anon_all_jr_days on public.jr_days;
drop policy if exists anon_all_jr_risk on public.jr_risk;
drop policy if exists anon_all_jr_audit on public.jr_audit;
drop policy if exists anon_all_jr_plans on public.jr_plans;
drop policy if exists anon_all_jr_watch on public.jr_watch;
drop policy if exists anon_all_jc_drawings on public.jc_drawings;
drop policy if exists anon_all_jr_stage on public.jr_stage;
drop policy if exists anon_all_settings on public.user_settings;
drop policy if exists "Allow anon insert user_watchlist" on public.user_watchlist;
drop policy if exists "Allow anon update user_watchlist" on public.user_watchlist;
drop policy if exists "Allow anon delete user_watchlist" on public.user_watchlist;
-- (anon read on user_watchlist stays)

alter table public.jr_days drop constraint jr_days_pkey;
alter table public.jr_days add constraint jr_days_pkey primary key using index jr_days_user_d;
alter table public.jr_audit drop constraint jr_audit_pkey;
alter table public.jr_audit add constraint jr_audit_pkey primary key using index jr_audit_user_week;
alter table public.jc_drawings drop constraint jc_drawings_pkey;
alter table public.jc_drawings add constraint jc_drawings_pkey primary key using index jc_drawings_user_symbol;
alter table public.jr_watch drop constraint jr_watch_d_symbol_key;   -- jr_watch_user_d_symbol (user_id, d, symbol) stays

update public.sp_settings set value = 'true'::jsonb where key = 'users_open';
