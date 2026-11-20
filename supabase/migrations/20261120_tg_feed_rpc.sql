-- Telegram News page: read-only feed of alerts that reached Telegram (the outbox itself stays RLS-locked).
-- Applied 2026-11-20 via Supabase MCP (migration tg_feed_rpc).
create or replace function public.tg_feed(p_days int default 9)
returns table(id bigint, at timestamptz, text text)
language sql stable security definer set search_path = public as $$
  select o.id, coalesce(o.sent_at, o.created_at), o.text
  from telegram_outbox o
  where o.status = 'sent'
    and coalesce(o.sent_at, o.created_at) > now() - make_interval(days => least(greatest(coalesce(p_days, 9), 1), 14))
    and o.text not like '🧪%'
  order by o.id
$$;
revoke all on function public.tg_feed(int) from public;
grant execute on function public.tg_feed(int) to anon, authenticated;
