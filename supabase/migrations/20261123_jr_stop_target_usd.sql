-- STEP 69: stop / target as a dollar amount (already applied live — source copy only)
alter table public.jr_trades add column if not exists plan_stop_usd numeric, add column if not exists plan_target_usd numeric;
