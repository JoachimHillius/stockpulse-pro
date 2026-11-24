-- STEP 74: Plan stop / target in dollars (already applied live — source copy only)
alter table public.jr_plans add column if not exists stop_usd numeric, add column if not exists target_usd numeric;
