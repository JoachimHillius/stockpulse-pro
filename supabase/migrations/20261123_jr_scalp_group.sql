-- STEP 72: options scalping rounds share a group id (already applied live — source copy only)
alter table public.jr_trades add column if not exists scalp_group text;
create index if not exists jr_trades_scalp_group_idx on public.jr_trades (scalp_group) where scalp_group is not null;
