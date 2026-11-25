-- STEP 91 (source copy — already applied live; do not run)
-- jr_eod_scan(p_kind, p_n): end-of-day scan for tomorrow's watch list (Journal → Watchlist → 🔎 Tomorrow's scan).
-- 'penny' = $0.10–$20 with $1M+ traded · 'large' = $10+ with $50M+ traded. Top p_n (max 50) by score.
-- Score = today's gain + relative volume + where it closed + runner alerts + spike alerts + multi-day runner
--         + float rotation + after-hours move; large caps: the move counts both ways and volume weighs more.
-- Reverse split: when the daily % is 50+ points off the live quote's % for the same day, the live % is used and the row is flagged.
create or replace function public.jr_eod_scan(p_kind text default 'penny', p_n int default 20)
returns table(symbol text, close numeric, chg numeric, split boolean, vol numeric, rv numeric, dollars numeric, cl numeric,
              runner int, spikes int, ig_d date, rot numeric, ah numeric, phase text, score numeric, d date)
language sql stable security definer set search_path to 'public' as $$
  with t as (select max(trading_date) d from price_history where trading_date <= (now() at time zone 'America/New_York')::date),
  ph as (
    select p.symbol, p.high, p.low, p.close, p.volume::numeric volume, t.d,
      (select q.close from price_history q where q.symbol = p.symbol and q.trading_date < t.d order by q.trading_date desc limit 1) pc,
      (select avg(z.volume) from (select q.volume from price_history q where q.symbol = p.symbol and q.trading_date < t.d order by q.trading_date desc limit 20) z) av
    from price_history p cross join t
    where p.trading_date = t.d and p.close >= 0.10
      and case when p_kind = 'large' then p.close >= 10 and p.volume * p.close >= 5e7 else p.close < 20 and p.volume * p.close >= 1e6 end),
  live as (
    select distinct on (l.symbol) l.symbol, l.change_pct, l.ext_change_pct, l.market_state, l.updated_at
    from (select symbol, change_pct, ext_change_pct, market_state, updated_at from price_live
          union all select symbol, change_pct, ext_change_pct, market_state, updated_at from market_live) l
    where l.symbol in (select ph.symbol from ph) order by l.symbol, l.updated_at desc),
  x as (
    select ph.*, lv.change_pct lchg, lv.ext_change_pct, lv.market_state, lv.updated_at lat,
      (ph.close / nullif(ph.pc, 0) - 1) * 100 dchg,
      ph.volume / nullif(ph.av, 0) rv0,
      (ph.close - ph.low) / nullif(ph.high - ph.low, 0) cl0,
      (select count(*)::int from runner_alerts a where a.symbol = ph.symbol and a.d = ph.d) ra,
      (select count(*)::int from fast_alerts f where f.symbol = ph.symbol and f.at >= ph.d::timestamp at time zone 'America/New_York'
         and f.at < (ph.d + 1)::timestamp at time zone 'America/New_York' and f.kind in ('1m', '5m', 'hi')) ups,
      (select r.ig_d from phase_runners r where r.symbol = ph.symbol) igd,
      (select ph.volume / greatest(coalesce(s.float_shares, 0), coalesce(s.shares_out, 0)) from symbol_float s
         where s.symbol = ph.symbol and greatest(coalesce(s.float_shares, 0), coalesce(s.shares_out, 0)) > 0) rot0,
      (select c.line from phase_cache c where c.symbol = ph.symbol) pl
    from ph left join live lv on lv.symbol = ph.symbol),
  y as (
    select x.*,
      (x.lchg is not null and (x.lat at time zone 'America/New_York')::date = x.d and abs(coalesce(x.dchg, 0) - x.lchg) > 50) spl,
      case when x.market_state in ('POST', 'POSTPOST', 'CLOSED', 'PREPRE', 'PRE') and (x.lat at time zone 'America/New_York')::date >= x.d then x.ext_change_pct end ah0
    from x),
  z as (
    select y.*, case when y.spl then y.lchg else y.dchg end c, case when y.spl then null else y.rv0 end rvv from y)
  select z.symbol, z.close, round(z.c, 1), z.spl, z.volume, round(z.rvv, 1), round(z.close * z.volume), round(z.cl0, 2),
    z.ra, z.ups, z.igd, round(z.rot0, 1), round(z.ah0, 1), z.pl,
    round(case when p_kind = 'large' then
        least(abs(coalesce(z.c, 0)), 15) * 3 + least(coalesce(z.rvv, 0), 10) * 4
      + case when z.cl0 >= 0.8 or z.cl0 <= 0.2 then 10 else 0 end + least(z.ups, 10) * 2 + least(greatest(abs(coalesce(z.ah0, 0)), 0), 10) * 2
      else
        least(greatest(coalesce(z.c, 0), 0), 100) * 0.4 + least(coalesce(z.rvv, 0), 20) * 2
      + case when z.cl0 >= 0.8 then 15 when z.cl0 <= 0.2 then -10 else 0 end
      + least(z.ra, 3) * 8 + least(z.ups, 10) + case when z.igd is not null then 10 else 0 end
      + least(coalesce(z.rot0, 0), 10) * 2 + least(greatest(coalesce(z.ah0, 0), -20), 30) * 0.5 end, 1) sc,
    z.d
  from z order by sc desc nulls last limit greatest(1, least(p_n, 50))
$$;
revoke all on function public.jr_eod_scan(text, int) from public, anon;
grant execute on function public.jr_eod_scan(text, int) to authenticated;

-- eod_scan_tg(p_force): the scan to Telegram at 8:00 PM ET on trading days — top 10 penny + top 5 large caps.
-- Cron (UTC): eod-scan-8pm '0 0,1 * * 2-6' → select public.eod_scan_tg()  (only the run at 8 PM New York time sends; EDT / EST)
create or replace function public.eod_scan_tg(p_force boolean default false) returns int
language plpgsql security definer set search_path to 'public' as $$
declare v_txt text; v_d date; v_key text; v_q int;
begin
  if not p_force and extract(hour from now() at time zone 'America/New_York') <> 20 then return 0; end if;
  select max(s.d) into v_d from jr_eod_scan('penny', 1) s;
  if v_d is null or (not p_force and v_d <> (now() at time zone 'America/New_York')::date) then return 0; end if;   -- no trading today
  with r as (
    select 'penny' k, s.* from jr_eod_scan('penny', 10) with ordinality
      s(symbol, close, chg, split, vol, rv, dollars, cl, runner, spikes, ig_d, rot, ah, phase, score, d, n)
    union all
    select 'large', s.* from jr_eod_scan('large', 5) with ordinality
      s(symbol, close, chg, split, vol, rv, dollars, cl, runner, spikes, ig_d, rot, ah, phase, score, d, n)),
  l as (
    select k, n, n || '. <b>' || symbol || '</b> ' || sp_px(close) || ' · ' || case when chg >= 0 then '+' else '' end || round(chg) || '%'
      || coalesce(' · ' || round(rv) || '× vol', '')
      || case when runner > 0 then ' · 🟩 runner' else '' end
      || case when phase ~ 'Day [0-9]+' and phase !~ 'Day 1\M' then ' · Day ' || substring(phase from 'Day ([0-9]+)') when ig_d is not null then ' · multi-day' else '' end
      || case when cl >= 0.8 then ' · closed at high' when cl <= 0.2 then ' · closed at low' else '' end
      || case when rot >= 1 then ' · ' || case when rot >= 10 then round(rot)::text else rot::text end || '× float' else '' end
      || case when abs(coalesce(ah, 0)) >= 5 then ' · ' || case when ah > 0 then '+' else '' end || ah || '% AH' else '' end
      || case when split then ' · split?' else '' end line
    from r)
  select '🔎 <b>TOMORROW''S SCAN</b> · close of ' || to_char(v_d, 'FMMM/FMDD') || E'\n\n<b>🟩 Penny ($0.10–$20)</b>\n'
      || coalesce((select string_agg(line, E'\n' order by n) from l where k = 'penny'), '—')
      || E'\n\n<b>🔷 Large caps ($10+)</b>\n'
      || coalesce((select string_agg(line, E'\n' order by n) from l where k = 'large'), '—')
      || E'\n\nAdd them: Journal → Watchlist → 🔎 Tomorrow''s scan (📈 chart on every row)'
    into v_txt;
  insert into telegram_outbox(text, parse_mode) values (v_txt, 'HTML');
  select count(*) into v_q from telegram_outbox where sent_at is null and status is null;
  v_key := substring(pg_get_functiondef('public.trigger_price_sync_batch'::regproc) from 'Bearer ([A-Za-z0-9._-]+)');
  for i in 1 .. greatest(1, ceil(v_q / 25.0)::int) loop
    perform net.http_post(url := 'https://siwrhqcojoyxxwaxnopc.supabase.co/functions/v1/telegram-outbox',
      headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_key,'apikey',v_key),
      body := '{}'::jsonb, timeout_milliseconds := 30000);
  end loop;
  return 1;
end $$;
revoke all on function public.eod_scan_tg(boolean) from public, anon, authenticated;
