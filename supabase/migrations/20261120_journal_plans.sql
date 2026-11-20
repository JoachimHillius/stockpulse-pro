-- Journal "Plan" tab: planned penny / options trades for a day (sizing only, not trades).
-- Applied 2026-11-20 via Supabase MCP (migration journal_plans).
create table if not exists public.jr_plans (
  id bigserial primary key, d date not null, kind text not null check (kind in ('penny','option')),
  symbol text, price numeric, stop_pct numeric, qty numeric, notes text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create index if not exists jr_plans_d on public.jr_plans(d);
alter table public.jr_plans enable row level security;
drop policy if exists anon_all_jr_plans on public.jr_plans;
create policy anon_all_jr_plans on public.jr_plans for all to anon using (true) with check (true);
grant all on public.jr_plans to anon; grant usage, select on sequence public.jr_plans_id_seq to anon;
