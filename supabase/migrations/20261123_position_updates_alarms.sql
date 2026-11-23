-- STEP 68 (source copy; applied by Claude in chat on 2026-11-23 — migrations position_updates_alarms + position_updates_minus, cron jobs pos-alarm-a/b, wl-alarm-a/b, pos-update-a/b): Telegram position updates, stop / target alarms, Watchlist price alarms.
--  📋 pos_update()      every 15 min, 4:00 AM – 8:00 PM ET weekdays: one message with the admin's open trades (Journal → Today, no exit yet)
--                       and today's plans not taken yet — price, ⬆️ ➡️ ⬇️ since the last update, entry, P&L, distance to the stop.
--                       Options: the underlying stock price (option premiums are not in the free feeds).
--  🚨 / 🎯 pos_alarm_check()  every 5 min: an open penny trade at / below its stop or at / above its target → instant alert (once per trade per day).
--                       Options are skipped (their stop / target are premiums).
--  🔔 alarm_check()     every 5 min: armed Watchlist alarms (public.alarms, above / below a price) → Telegram once, then status 'triggered'.
-- Prices: the freshest of price_live / market_live (pre-market / after-hours price when the market is closed).
create table if not exists public.pos_last (symbol text primary key, px numeric, at timestamptz);
create table if not exists public.pos_alarm_sent (trade_id bigint not null, kind text not null, d date not null, at timestamptz not null default now(), primary key (trade_id, kind, d));
alter table public.pos_last enable row level security;
alter table public.pos_alarm_sent enable row level security;

-- the freshest live price of one ticker (extended-hours price outside the session)
create or replace function public.sp_live(p_sym text) returns table(px numeric, pct numeric, at timestamptz)
language sql stable security definer set search_path = public as $$
  select case when market_state in ('PRE','POST','POSTPOST') and ext_price is not null then ext_price else price end,
         case when market_state in ('PRE','POST','POSTPOST') and ext_change_pct is not null then ext_change_pct else change_pct end, updated_at
  from (select price, change_pct, market_state, ext_price, ext_change_pct, updated_at from price_live where symbol = p_sym
        union all
        select price, change_pct, market_state, ext_price, ext_change_pct, updated_at from market_live where symbol = p_sym) x
  order by updated_at desc limit 1
$$;
revoke all on function public.sp_live(text) from public, anon, authenticated;

create or replace function public.sp_admin_id() returns uuid language sql stable security definer set search_path = public as $$
  select id from sp_profiles where role = 'admin' and status = 'active' order by created_at limit 1
$$;
revoke all on function public.sp_admin_id() from public, anon, authenticated;

-- send whatever is waiting in the outbox
create or replace function public.sp_tg_flush() returns void language plpgsql security definer set search_path = public as $$
declare v_q int; v_key text;
begin
  select count(*) into v_q from telegram_outbox where sent_at is null and status is null;
  if v_q = 0 then return; end if;
  v_key := substring(pg_get_functiondef('public.trigger_price_sync_batch'::regproc) from 'Bearer ([A-Za-z0-9._-]+)');
  for i in 1 .. ceil(v_q / 25.0)::int loop
    perform net.http_post(url := 'https://siwrhqcojoyxxwaxnopc.supabase.co/functions/v1/telegram-outbox',
      headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_key,'apikey',v_key),
      body := '{}'::jsonb, timeout_milliseconds := 30000);
  end loop;
end $$;
revoke all on function public.sp_tg_flush() from public, anon, authenticated;

-- numeric helper (jr_trades columns are numeric already; keeps the query readable)
create or replace function public.jrn(v numeric) returns numeric language sql immutable as $$ select v $$;

create or replace function public.pos_update(p_force boolean default false) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_now timestamp := now() at time zone 'America/New_York';
  v_today date := v_now::date; v_admin uuid := sp_admin_id();
  v_lines text; v_n int; v_t int; v_p int;
begin
  if not p_force and (extract(isodow from v_now) > 5 or v_now::time < '04:00' or v_now::time > '20:00') then return 0; end if;
  create temp table _pos on commit drop as
  with tr as (
    select 1 grp, t.id, t.kind, t.symbol, jrn(t.qty) qty, jrn(t.entry) entry, jrn(t.plan_stop) stop, t.opt_type, t.strike, t.expiry, jrn(t.stock_entry) stock_entry, t.d
    from jr_trades t where t.user_id = v_admin and t.exit is null and t.d >= v_today - 30 and t.symbol is not null and t.qty > 0 and t.entry is not null),
  pl as (
    select 2 grp, p.id, p.kind, p.symbol, p.qty, p.price entry, case when p.price is not null and p.stop_pct is not null then round(p.price * (1 - p.stop_pct / 100), 4) end stop,
           p.opt_type, p.strike, p.expiry, p.stock_price stock_entry, p.d
    from jr_plans p where p.user_id = v_admin and p.d = v_today and p.symbol is not null and p.trade_id is null
      and not exists (select 1 from tr where tr.symbol = p.symbol))
  select x.*, lv.px, lv.pct, lv.at, pl0.px last_px
  from (select * from tr union all select * from pl) x
  left join lateral sp_live(x.symbol) lv on true
  left join pos_last pl0 on pl0.symbol = x.symbol;
  select count(*), count(*) filter (where grp = 1), count(*) filter (where grp = 2) into v_n, v_t, v_p from _pos;
  if v_n = 0 then return 0; end if;
  select string_agg(line, E'\n' order by grp, symbol) into v_lines from (
    select grp, symbol,
      case when px is null then '⚪ <b>' || symbol || '</b> no live price'
      else coalesce(nullif(sp_arrow(px, last_px), ''), '•') || ' <b>' || symbol || '</b> ' ||
        case when kind = 'option' then 'stock ' else '' end || sp_px(px) ||
        coalesce(' (' || case when pct >= 0 then '+' else '−' end || abs(round(pct, 1))::text || '% today)', '') ||
        case
          when grp = 1 and kind = 'penny' then
            ' · ' || qty::text || ' sh @ ' || sp_px(entry) || ' · P&amp;L ' || case when px >= entry then '+$' else '−$' end ||
            to_char(abs((px - entry) * qty), 'FM999,990.00') || ' (' || case when px >= entry then '+' else '−' end || round(abs(px / entry - 1) * 100, 1)::text || '%)' ||
            coalesce(' · stop ' || sp_px(stop) || ' (' || case when stop >= px then '+' else '−' end || abs(round((stop / px - 1) * 100, 1))::text || '%)', '')
          when grp = 1 then
            ' · ' || qty::text || ' ' || coalesce(opt_type, 'option') || coalesce(' ' || strike, '') || coalesce(' exp ' || to_char(expiry, 'MM/DD'), '') ||
            ' · in ' || sp_px(entry) || coalesce(' · stock was ' || sp_px(stock_entry) || ' (' || case when px >= stock_entry then '+' else '−' end || round(abs(px / stock_entry - 1) * 100, 1)::text || '%)', '')
          else
            ' · plan ' || case when kind = 'option' then 'option' else 'penny' end || coalesce(' entry ' || sp_px(entry) || ' (' || case when px >= entry then '+' else '−' end || round(abs(px / nullif(entry, 0) - 1) * 100, 1)::text || '%)', '')
        end
      end line
    from _pos) z;
  insert into telegram_outbox(text, parse_mode)
  values ('📋 <b>POSITIONS · ' || to_char(v_now, 'FMHH12:MI AM') || '</b>' ||
          E'\n' || case when v_t > 0 then v_t::text || ' open trade' || case when v_t > 1 then 's' else '' end else 'no open trades' end ||
          case when v_p > 0 then ' · ' || v_p::text || ' plan' || case when v_p > 1 then 's' else '' end || ' not taken yet' else '' end ||
          ' · arrows = since the last update' || E'\n\n' || left(v_lines, 3600), 'HTML');
  insert into pos_last(symbol, px, at) select distinct on (symbol) symbol, px, now() from _pos where px is not null
  on conflict (symbol) do update set px = excluded.px, at = excluded.at;
  perform sp_tg_flush();
  return v_n;
end $$;
revoke all on function public.pos_update(boolean) from public, anon, authenticated;

create or replace function public.pos_alarm_check() returns int
language plpgsql security definer set search_path = public as $$
declare v_today date := (now() at time zone 'America/New_York')::date; v_admin uuid := sp_admin_id(); v_n int;
begin
  create temp table _pa on commit drop as
  select t.id, t.symbol, t.qty, t.entry, t.plan_stop stop, t.plan_target target, lv.px,
         case when t.plan_stop is not null and lv.px <= t.plan_stop then 'stop' when t.plan_target is not null and lv.px >= t.plan_target then 'target' end kind
  from jr_trades t cross join lateral sp_live(t.symbol) lv
  where t.user_id = v_admin and t.kind = 'penny' and t.exit is null and t.d >= v_today - 30 and t.qty > 0 and t.entry is not null
    and lv.at > now() - interval '15 minutes';
  delete from _pa where kind is null or exists (select 1 from pos_alarm_sent s where s.trade_id = _pa.id and s.kind = _pa.kind and s.d = v_today);
  select count(*) into v_n from _pa;
  if v_n = 0 then return 0; end if;
  insert into pos_alarm_sent(trade_id, kind, d) select id, kind, v_today from _pa on conflict do nothing;
  insert into telegram_outbox(text, parse_mode)
  select case when kind = 'stop' then '🚨 <b>' || symbol || ' hit your STOP ' || sp_px(stop) || '</b>'
              else '🎯 <b>' || symbol || ' hit your TARGET ' || sp_px(target) || '</b>' end ||
         E'\nnow ' || sp_px(px) || ' · ' || qty::text || ' sh @ ' || sp_px(entry) || ' → P&amp;L ' || case when px >= entry then '+$' else '−$' end ||
         to_char(abs((px - entry) * qty), 'FM999,990.00') || ' (' || case when px >= entry then '+' else '−' end || round(abs(px / entry - 1) * 100, 1)::text || '%)', 'HTML'
  from _pa;
  perform sp_tg_flush();
  return v_n;
end $$;
revoke all on function public.pos_alarm_check() from public, anon, authenticated;

create or replace function public.alarm_check() returns int
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  create temp table _al on commit drop as
  select a.id, a.symbol, a.level, a.direction, a.note, lv.px, lv.pct
  from alarms a cross join lateral sp_live(a.symbol) lv
  where a.status = 'armed' and lv.at > now() - interval '15 minutes'
    and ((a.direction = 'above' and lv.px >= a.level) or (a.direction = 'below' and lv.px <= a.level));
  select count(*) into v_n from _al;
  if v_n = 0 then return 0; end if;
  update alarms a set status = 'triggered', triggered_at = now() from _al where a.id = _al.id;
  insert into telegram_outbox(text, parse_mode)
  select '🔔 <b>ALARM ' || symbol || ' ' || sp_px(px) || '</b>' || E'\n' || case when direction = 'above' then '⬆️ crossed above ' else '⬇️ crossed below ' end || sp_px(level) ||
         coalesce(' · ' || case when pct >= 0 then '+' else '−' end || abs(round(pct, 1))::text || '% today', '') ||
         coalesce(E'\n📝 ' || replace(replace(replace(note, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), ''), 'HTML'
  from _al;
  perform sp_tg_flush();
  return v_n;
end $$;
revoke all on function public.alarm_check() from public, anon, authenticated;

-- schedules (each check its own job, so one can't stop another): 5-minute checks 3 min after the price scans;
-- position updates every 15 minutes (the function itself keeps 4 AM – 8 PM ET, weekdays)
select cron.schedule('pos-alarm-a', '3-59/5 8-23 * * 1-5', 'select public.pos_alarm_check()');
select cron.schedule('pos-alarm-b', '3-59/5 0 * * 2-6', 'select public.pos_alarm_check()');
select cron.schedule('wl-alarm-a', '3-59/5 8-23 * * 1-5', 'select public.alarm_check()');
select cron.schedule('wl-alarm-b', '3-59/5 0 * * 2-6', 'select public.alarm_check()');
select cron.schedule('pos-update-a', '4-59/15 8-23 * * 1-5', 'select public.pos_update()');
select cron.schedule('pos-update-b', '4-59/15 0-1 * * 2-6', 'select public.pos_update()');
