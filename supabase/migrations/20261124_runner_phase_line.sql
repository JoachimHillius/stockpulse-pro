-- STEP 88 (source copy — already applied live; do not run)
-- 1) sp_phase(): phase + rating line for penny runners (7-step framework, research 11/24/2026 on the Watchlist penny stocks, 12 months).
--    Ignition = close +20% vs the day before, 5x the 20-day volume, 2M+ shares and $1M+ traded.
--    Day 2 new high after Day 1 closed at the high 68% · upper half 32% · faded (lower half) 14%.
--    #4 red day after a +50% run: lower next day 54%, lower 3 days later 60%. #5 first green bounce: takes out its high next day 43%, lower 3 days later 66%.
--    The stock's own past runs (2 years) are blended in when it has 2+; candle strength sets the lean.
--    Rating: High 65%+ · Medium 58-64 · Slight 52-57 · Low below.
-- 2) runner_check(): the 🟩/🟨 runner alert now also fires for Watchlist stocks ("⭐ On your Watchlist", Ignore button only)
--    and carries the sp_phase() line.

CREATE OR REPLACE FUNCTION public.sp_phase(p_sym text, p_px numeric, p_vol numeric)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_today date := (now() at time zone 'America/New_York')::date;
  t record; pc numeric; va numeric; o numeric; hi numeric; lo numeric; rng numeric; cl numeric; body numeric; uw numeric; lw numeric;
  candle text; cw text := ''; ig_d date; ig_base numeric; nday int; runmax numeric; run_hi numeric; p1 numeric; p2 numeric; p3 numeric;
  own_n int := 0; own_up int := 0; base int; p int; lab text; dot text; ign boolean;
begin
  if p_px is null then return null; end if;
  select close into pc from price_history where symbol = p_sym and trading_date < v_today order by trading_date desc limit 1;
  if pc is null or pc <= 0 then return null; end if;
  select avg(volume) into va from (select volume from price_history where symbol = p_sym and trading_date < v_today order by trading_date desc limit 20) x;
  -- today's candle so far: the daily row, else the scanner's session high / low
  select open, high, low into t from price_history where symbol = p_sym and trading_date = v_today;
  if t.high is null then select null::numeric open, max(fs.hi) high, min(fs.lo) low into t from fast_session fs where fs.symbol = p_sym and fs.d = v_today; end if;
  o := t.open; hi := greatest(coalesce(t.high, p_px), p_px); lo := least(coalesce(t.low, p_px), p_px);
  rng := nullif(hi - lo, 0);
  if rng is not null then
    cl := (p_px - lo) / rng;
    if o is not null then body := abs(p_px - o) / rng; uw := (hi - greatest(o, p_px)) / rng; lw := (least(o, p_px) - lo) / rng; end if;
    candle := case when body >= 0.7 and cl >= 0.8 then 'full candle at the high'
                   when uw >= 0.4 then 'long upper wick — sellers pushing back'
                   when lw >= 0.4 then 'long lower wick — buyers defending'
                   when cl >= 0.8 then 'holding near the high' when cl <= 0.2 then 'sitting near the low' else 'mid-range' end;
  end if;
  cw := coalesce(' · ' || candle, '');
  -- this stock's past runs (2 years): ignition-like days and how often the next day made a new high
  with h as (select trading_date d, high, close, volume,
                    lag(close) over w pcl, avg(volume) over (order by trading_date rows between 20 preceding and 1 preceding) av, lead(high) over w nh
             from price_history where symbol = p_sym and trading_date < v_today and trading_date > v_today - 730 window w as (order by trading_date))
  select count(*) filter (where nh is not null), count(*) filter (where nh > high) into own_n, own_up
  from h where pcl > 0 and close >= pcl * 1.20 and av > 0 and volume >= 5 * av and volume >= 2e6 and volume * close >= 1e6;
  -- the FIRST ignition of the current run (within the last 15 trading days)
  with h as (select trading_date d, close, volume, lag(close) over (order by trading_date) pcl,
                    avg(volume) over (order by trading_date rows between 20 preceding and 1 preceding) av
             from price_history where symbol = p_sym and trading_date < v_today and trading_date > v_today - 60)
  select d, pcl into ig_d, ig_base from h
  where pcl > 0 and close >= pcl * 1.20 and av > 0 and volume >= 5 * av and volume >= 2e6 and volume * close >= 1e6
    and d >= (select min(trading_date) from (select trading_date from price_history where symbol = p_sym and trading_date < v_today order by trading_date desc limit 15) z)
  order by d asc limit 1;
  ign := p_px >= pc * 1.20 and va > 0 and coalesce(p_vol, 0) >= 5 * va and coalesce(p_vol, 0) >= 2e6 and coalesce(p_vol, 0) * p_px >= 1e6;
  if ig_d is not null then
    select count(*) + 1, max(high), max(close) into nday, run_hi, runmax from price_history where symbol = p_sym and trading_date >= ig_d and trading_date < v_today;
  end if;

  -- new high above the current run → breakout / Day 2 continuation
  if ig_d is not null and p_px > run_hi then
    return case when cl >= 0.8 then '🟩' else '🟨' end || ' <b>' || case when nday = 2 then 'Day 2 continuation' else '#3 Breakout · Day ' || nday end
      || '</b> — new high above ' || sp_px(run_hi) || cw
      || case when nday = 2 then case when cl < 0.5 then ' → <b>Slight</b>: fading off the high — Day 2s closed higher only 38%' else ' → <b>Medium</b>: Day 2s pushed ~+14% at their best, but most closed lower — take profit into strength' end
         else case when uw >= 0.4 or cl < 0.5 then ' → <b>Caution</b>: it is not holding the new high — a close back below ' || sp_px(run_hi) || ' = failed breakout'
                   else ' → watch it hold above ' || sp_px(run_hi) || ' (the old high) — a close back below = failed breakout' end end;
  end if;
  -- today is an ignition day (a new run, or a fresh one after an older run)
  if ign then
    base := case when cl is null then 33 when cl >= 0.8 then 68 when cl >= 0.5 then 32 else 14 end;
    p := case when own_n >= 2 then round((base + 100.0 * own_up / own_n) / 2) else base end;
    lab := case when p >= 65 then 'High' when p >= 58 then 'Medium' when p >= 52 then 'Slight' else 'Low' end;
    dot := case when p >= 65 then '🟩' when p >= 52 then '🟨' else '🟧' end;
    return dot || ' <b>#1 Ignition · Day 1</b>' || case when ig_d is not null then ' (new push after the ' || to_char(ig_d, 'MM/DD') || ' run)' else '' end || cw
      || ' → <b>' || lab || '</b>: Day 2 new high ~' || p || '%'
      || case when cl is null then ' (candle not complete yet)' else '' end
      || case when own_n >= 2 then ' · ran like this ' || own_n || '× before: Day 2 new high ' || own_up || ' of ' || own_n
              when own_n = 1 then ' · ran like this once before (Day 2 new high: ' || case when own_up = 1 then 'yes' else 'no' end || ')'
              else ' · first-time runner — no past runs, harder to judge' end;
  end if;
  -- a +20% day inside a run that is still below the run's high → a new push, not a rest
  if ig_d is not null and p_px >= pc * 1.20 then
    return case when cl >= 0.5 then '🟩' else '🟨' end || ' <b>New push · Day ' || nday || '</b> of the run since ' || to_char(ig_d, 'MM/DD')
      || ' · +' || round((p_px / pc - 1) * 100) || '% today' || cw
      || ' → the run high is ' || sp_px(run_hi) || ' — a close above it = #3 breakout'
      || case when cl < 0.5 then '; it is fading off today''s high' else '' end;
  end if;
  if ig_d is not null then
    select close into p1 from price_history where symbol = p_sym and trading_date < v_today order by trading_date desc limit 1;
    select close into p2 from price_history where symbol = p_sym and trading_date < v_today order by trading_date desc offset 1 limit 1;
    select close into p3 from price_history where symbol = p_sym and trading_date < v_today order by trading_date desc offset 2 limit 1;
    if p_px > pc and p1 < p2 and p2 < p3 and p_px <= greatest(runmax, run_hi) * 0.75 then
      return '🟨 <b>#5 First green day bounce · Day ' || nday || '</b>' || cw || ' → <b>Slight</b>: takes out today''s high next day 43%, but 66% were lower 3 days later — a quick trade, not a hold';
    elsif p_px < pc and runmax >= ig_base * 1.5 then
      return '🟧 <b>#4 Red day after the run · Day ' || nday || '</b>' || cw || ' → <b>Slight</b>: lower next day 54%, lower 3 days later 60% — don''t buy the first dip';
    else
      return '🟨 <b>#2 Rest · Day ' || nday || '</b> since the ' || to_char(ig_d, 'MM/DD') || ' ignition' || cw || ' — watch for a close above ' || sp_px(run_hi) || ' (#3 breakout)';
    end if;
  end if;
  if own_n >= 1 then
    return '🟨 Ran like this ' || own_n || '× before: next day new high ' || own_up || ' of ' || own_n || cw;
  end if;
  return '🟨 First-time runner — no past runs on file, harder to judge' || cw;
end $function$;
revoke all on function public.sp_phase(text, numeric, numeric) from public, anon, authenticated;

-- runner_check(): only the changed parts are shown; the full live definition is in the database.
--  _r filter: the line  "and not exists (select 1 from user_watchlist w where w.symbol = l.symbol)"  was removed.
--  message footer: case when exists (select 1 from user_watchlist w where w.symbol = r.symbol) then '⭐ On your Watchlist' else 'Not on your Watchlist' end
--                  || ' · STOP ' || r.symbol || ' to mute', preceded by coalesce(sp_phase(r.symbol, r.px, r.vol) || E'\n', '')
--  buttons: Watchlist stocks get only "✖ Ignore today"; others keep "➕ Add to Watchlist" + "✖ Ignore today".
