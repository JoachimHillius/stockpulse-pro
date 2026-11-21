-- Journal Plan: the trading rules ticked while planning (penny or options), saved per plan.
-- Applied 2026-11-21 via Supabase MCP (migration journal_plans_rules).
alter table public.jr_plans add column if not exists rules jsonb not null default '{}'::jsonb;
