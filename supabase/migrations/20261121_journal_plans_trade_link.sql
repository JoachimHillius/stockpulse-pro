-- Journal Plan → Today: the trade a plan created once it had an exit (kept in step with the plan).
-- Applied 2026-11-21 via Supabase MCP (migration journal_plans_trade_link).
alter table public.jr_plans add column if not exists trade_id bigint references public.jr_trades(id) on delete set null;
