-- Journal trade card v2: planned-entry tolerance (±$), stop and target as % of the entry (the $ levels stay in plan_stop / plan_target).
-- Applied 2026-11-20 via Supabase MCP (migration journal_plan_pct).
alter table public.jr_trades add column if not exists plan_tol numeric;
alter table public.jr_trades add column if not exists plan_stop_pct numeric;
alter table public.jr_trades add column if not exists plan_target_pct numeric;
alter table public.jr_trades add column if not exists target_run boolean not null default false;
