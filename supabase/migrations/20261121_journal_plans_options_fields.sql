-- Journal Plan: options plan fields that mirror the V2-Active Postions sheet (filled from the plan templates / uploads)
-- Applied 2026-11-21 via Supabase MCP (migration journal_plans_options_fields).
alter table public.jr_plans add column if not exists status text;            -- Open / Closed / Watch
alter table public.jr_plans add column if not exists delta numeric;
alter table public.jr_plans add column if not exists theta numeric;
alter table public.jr_plans add column if not exists expiry date;
alter table public.jr_plans add column if not exists strike text;            -- e.g. 400
alter table public.jr_plans add column if not exists opt_type text;          -- call / put
alter table public.jr_plans add column if not exists entry_trigger text;     -- the sheet's "Entry", e.g. > 81.00
alter table public.jr_plans add column if not exists stock_price numeric;    -- Stock entered (position 1)
alter table public.jr_plans add column if not exists exit_price numeric;     -- $Strike exit (position 1)
alter table public.jr_plans add column if not exists pos2 jsonb;             -- position 2: {qty, stock, premium_in, premium_out}
alter table public.jr_plans add column if not exists session text;           -- penny: pre / reg / post
alter table public.jr_plans add column if not exists plan_tol numeric;
alter table public.jr_plans add column if not exists target text;            -- penny target $ or options target %
