-- STEP 66 (source copy; applied by Claude in chat): the buys of a Today trade, [{ "qty": n, "price": n }, …]
-- (qty / entry stay the total and the average price, so P&L and the stats are unchanged)
alter table public.jr_trades add column if not exists buys jsonb;
