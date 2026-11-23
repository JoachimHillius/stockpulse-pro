-- STEP 65 (source copy; applied by Claude in chat): add-on buys per plan, [{ "qty": n, "price": n }, …]
alter table public.jr_plans add column if not exists adds jsonb not null default '[]'::jsonb;
