-- STEP 67 (source copy; applied by Claude in chat on 2026-11-23 — migrations runner_alerts + runner_alerts_look, cron jobs runner-check-a / -b): 🔥 RUNNER alerts on Telegram with ➕ Add to Watchlist / ✖ Ignore today buttons.
-- Every 5 minutes (3 min after the price scans) runner_check() snapshots every $0.10–$10 stock (whole market + Watchlist)
-- and alerts a stock that is NOT on the main Watchlist when:
--   🔥🔥  1M+ shares traded in the last 15 minutes   ·   🔥  1M+ shares traded in the last 30 minutes
--   and it keeps going up: +10% or more today, price above where it was 15 and 30 minutes ago, volume still rising since the last scan.
-- One alert per tier per stock per day (🔥🔥 can still follow a 🔥). STOP XYZ mutes it; ✖ Ignore today skips it until tomorrow.
-- Look: 🟩 + 🔥🔥 (15 min) · 🟨 + 🔥 (30 min) · 🟧 + ⬇️ when a runner of today drops 10%+ below its high since the alert (once).
-- Arrows vs 15 / 30 min ago: ⬆️ > +1% · ➡️ within ±1% · ⬇️ < −1%. Bold title + quote box (Telegram HTML).
-- Volume: regular session from the quote; pre-market / after-hours only where today's extended volume is known (vol_accum).
alter table public.telegram_outbox add column if not exists reply_markup jsonb;
alter table public.telegram_outbox add column if not exists parse_mode text;

create table if not exists public.runner_ticks (symbol text not null, at timestamptz not null, px numeric, pct numeric, vol bigint, primary key (symbol, at));
create table if not exists public.runner_alerts (symbol text not null, d date not null, tier text not null, at timestamptz not null default now(),
  px numeric, pct numeric, vol bigint, vol_win bigint, hi numeric, down_sent timestamptz, primary key (symbol, d, tier));
create table if not exists public.runner_ignore (symbol text not null, d date not null, at timestamptz not null default now(), primary key (symbol, d));
alter table public.runner_ticks enable row level security;
alter table public.runner_alerts add column if not exists hi numeric, add column if not exists down_sent timestamptz;
alter table public.runner_alerts enable row level security;
alter table public.runner_ignore enable row level security;

create or replace function public.sp_fvol(v numeric) returns text language sql immutable as $$
  select case when v is null then '—' when v >= 1e9 then round(v / 1e9, 1)::text || 'B' when v >= 1e6 then round(v / 1e6, 1)::text || 'M'
              when v >= 1e3 then round(v / 1e3)::text || 'K' else round(v)::text end
$$;

create or replace function public.sp_arrow(now_px numeric, then_px numeric) returns text language sql immutable as $$
  select case when then_px is null or then_px = 0 then '' when now_px > then_px * 1.01 then '⬆️' when now_px < then_px * 0.99 then '⬇️' else '➡️' end
$$;
create or replace function public.sp_px(v numeric) returns text language sql immutable as $$
  select case when v is null then '—' else '$' || round(v, case when v < 1 then 4 else 2 end)::text end
$$;

create or replace function public.runner_check() returns int
language plpgsql security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'America/New_York')::date;
  v_n int := 0; v_q int; v_key text;
begin
  -- 1) snapshot this scan (only new quotes)
  insert into runner_ticks(symbol, at, px, pct, vol)
  select symbol, updated_at, px, pct, vol from (
    select l.symbol, l.updated_at,
      case when l.market_state in ('PRE','POST','POSTPOST') and l.ext_price is not null then l.ext_price else l.price end px,
      case when l.market_state in ('PRE','POST','POSTPOST') and l.ext_change_pct is not null then l.ext_change_pct else l.change_pct end pct,
      case when l.market_state = 'REGULAR' then l.volume
           else (select va.today_vol from vol_accum va where va.symbol = l.symbol and va.d = v_today and va.updated_at > now() - interval '10 minutes') end vol
    from (select symbol, price, change_pct, volume, market_state, ext_price, ext_change_pct, updated_at from market_live
          union all
          select symbol, price, change_pct, volume, market_state, ext_price, ext_change_pct, updated_at from price_live) l
    where l.updated_at > now() - interval '10 minutes') x
  where px between 0.10 and 10 and vol is not null
  on conflict do nothing;
  delete from runner_ticks where at < now() - interval '50 minutes';

  -- 2) runners
  create temp table _r on commit drop as
  with last as (select distinct on (symbol) symbol, at, px, pct, vol from runner_ticks order by symbol, at desc),
  prev as (select distinct on (t.symbol) t.symbol, t.vol pvol from runner_ticks t join last l using (symbol) where t.at < l.at order by t.symbol, t.at desc),
  a15 as (select distinct on (t.symbol) t.symbol, t.px px15, t.vol vol15 from runner_ticks t join last l using (symbol)
          where t.at <= l.at - interval '14 minutes' order by t.symbol, t.at desc),
  a30 as (select distinct on (t.symbol) t.symbol, t.px px30, t.vol vol30 from runner_ticks t join last l using (symbol)
          where t.at <= l.at - interval '29 minutes' order by t.symbol, t.at desc)
  select l.*, p.pvol, a15.px15, a15.vol15, a30.px30, a30.vol30,
    case when l.vol - a15.vol15 >= 1000000 then '15' when a30.vol30 is not null and l.vol - a30.vol30 >= 1000000 then '30' end tier
  from last l join prev p using (symbol) join a15 using (symbol) left join a30 using (symbol)
  where l.at > now() - interval '8 minutes'
    and l.pct >= 10 and l.vol > p.pvol and l.px > a15.px15 and (a30.px30 is null or l.px > a30.px30)
    and not exists (select 1 from user_watchlist w where w.symbol = l.symbol)
    and not exists (select 1 from tg_mute m where m.symbol = l.symbol)
    and not exists (select 1 from runner_ignore i where i.symbol = l.symbol and i.d = v_today);
  delete from _r where tier is null
    or exists (select 1 from runner_alerts a where a.symbol = _r.symbol and a.d = v_today and (a.tier = _r.tier or a.tier = '15'));
  select count(*) into v_n from _r;
  if v_n > 0 then
    insert into runner_alerts(symbol, d, tier, px, pct, vol, vol_win, hi)
    select symbol, v_today, tier, px, pct, vol, vol - case when tier = '15' then vol15 else vol30 end, px from _r on conflict do nothing;
    insert into telegram_outbox(text, reply_markup, parse_mode)
    select case when tier = '15' then E'🟩🟩🟩🟩🟩\n<b>🔥🔥 RUNNER ' else E'🟨🟨🟨🟨🟨\n<b>🔥 RUNNER ' end || r.symbol || ' · ' || sp_px(r.px) || ' · +' || round(r.pct)::text || '% today</b>'
           || E'\n<blockquote>📊 ' || sp_fvol(r.vol - case when tier = '15' then r.vol15 else r.vol30 end) || ' shares in the last ' || case when tier = '15' then '15' else '30' end || ' min · '
           || sp_fvol(r.vol) || ' today' || coalesce(' (10-day avg ' || sp_fvol(ml.avg_vol10) || ')', '')
           || E'\n' || sp_arrow(r.px, r.px15) || ' ' || sp_px(r.px15) || ' 15 min ago'
           || coalesce(' · ' || sp_arrow(r.px, r.px30) || ' ' || sp_px(r.px30) || ' 30 min ago', '')
           || E'</blockquote>Not on your Watchlist · STOP ' || r.symbol || ' to mute',
           jsonb_build_object('inline_keyboard', jsonb_build_array(jsonb_build_array(
             jsonb_build_object('text', '➕ Add to Watchlist', 'callback_data', 'rw:add:' || r.symbol),
             jsonb_build_object('text', '✖ Ignore today', 'callback_data', 'rw:ign:' || r.symbol)))), 'HTML'
    from _r r left join market_live ml using (symbol)
    order by r.tier, r.pct desc;
  end if;

  -- 3) 🟧 ⬇️ a runner of today turns down: 10%+ below its high since the alert (once per stock per day; not for muted stocks)
  update runner_alerts a set hi = greatest(coalesce(a.hi, a.px), t.px)
  from (select distinct on (symbol) symbol, px from runner_ticks where at > now() - interval '8 minutes' order by symbol, at desc) t
  where a.symbol = t.symbol and a.d = v_today;
  create temp table _dn on commit drop as
  with ra as (select symbol, max(hi) hi, min(at) first_at, bool_or(down_sent is not null) sent,
                     case when bool_or(tier = '15') then '🔥🔥' else '🔥' end lvl
              from runner_alerts where d = v_today group by symbol),
  last as (select distinct on (symbol) symbol, at, px, pct from runner_ticks where at > now() - interval '8 minutes' order by symbol, at desc),
  a15 as (select distinct on (t.symbol) t.symbol, t.px px15 from runner_ticks t join last l using (symbol) where t.at <= l.at - interval '14 minutes' order by t.symbol, t.at desc)
  select ra.*, l.px, l.pct, a15.px15 from ra join last l using (symbol) left join a15 using (symbol)
  where not ra.sent and ra.hi > 0 and l.px <= ra.hi * 0.90
    and not exists (select 1 from tg_mute m where m.symbol = ra.symbol);
  if exists (select 1 from _dn) then
    update runner_alerts a set down_sent = now() from _dn where a.symbol = _dn.symbol and a.d = v_today;
    insert into telegram_outbox(text, parse_mode)
    select E'🟧🟧🟧🟧🟧\n<b>⬇️ ' || symbol || ' FALLING · ' || sp_px(px) || ' · −' || round((1 - px / hi) * 100)::text || '% from its high ' || sp_px(hi) || '</b>'
           || E'\n<blockquote>' || lvl || ' runner at ' || to_char(first_at at time zone 'America/New_York', 'FMHH12:MI AM') || ' · now '
           || case when pct >= 0 then '+' else '' end || round(pct)::text || '% today'
           || coalesce(E'\n' || sp_arrow(px, px15) || ' ' || sp_px(px15) || ' 15 min ago', '') || '</blockquote>STOP ' || symbol || ' to mute', 'HTML'
    from _dn;
    v_n := v_n + (select count(*) from _dn);
  end if;

  select count(*) into v_q from telegram_outbox where sent_at is null and status is null;
  if v_q > 0 then
    v_key := substring(pg_get_functiondef('public.trigger_price_sync_batch'::regproc) from 'Bearer ([A-Za-z0-9._-]+)');
    for i in 1 .. ceil(v_q / 25.0)::int loop
      perform net.http_post(url := 'https://siwrhqcojoyxxwaxnopc.supabase.co/functions/v1/telegram-outbox',
        headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_key,'apikey',v_key),
        body := '{}'::jsonb, timeout_milliseconds := 30000);
    end loop;
  end if;
  return v_n;
end $$;
revoke all on function public.runner_check() from public, anon, authenticated;

-- every 5 minutes, 3 minutes after the price scans (same hours as the spike alerts)
select cron.schedule('runner-check-a', '3-59/5 8-23 * * 1-5', 'select public.runner_check()');
select cron.schedule('runner-check-b', '3-59/5 0 * * 2-6', 'select public.runner_check()');
