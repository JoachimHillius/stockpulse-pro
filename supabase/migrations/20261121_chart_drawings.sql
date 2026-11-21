-- Chart drawings (trend lines, horizontal lines, zones, text, bubbles) saved per ticker.
-- Applied 2026-11-21 via Supabase MCP (migration chart_drawings).
create table if not exists public.jc_drawings (
  symbol text primary key,
  items jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.jc_drawings enable row level security;
drop policy if exists anon_all_jc_drawings on public.jc_drawings;
create policy anon_all_jc_drawings on public.jc_drawings for all to anon using (true) with check (true);
grant select, insert, update, delete on public.jc_drawings to anon;
