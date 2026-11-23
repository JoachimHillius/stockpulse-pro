-- STEP 70: broker on journal trades + ⏰ open-position reminder (already applied live — source copy only)
alter table public.jr_trades add column if not exists broker text;

create table if not exists public.pos_check_sent (slot text primary key, at timestamptz default now());
alter table public.pos_check_sent enable row level security;

-- Weekdays at 12:00 PM and 3:50 PM New York time (cron fires at both UTC offsets; this keeps the right one).
create or replace function public.pos_check(p_force boolean default false)
returns integer language plpgsql security definer set search_path to 'public' as $$
declare
  v_now timestamp := now() at time zone 'America/New_York';
  v_admin uuid := sp_admin_id(); v_slot text; v_lines text; v_n int;
begin
  if not p_force then
    if extract(isodow from v_now) > 5 then return 0; end if;
    if v_now::time between '11:57' and '12:08' then v_slot := v_now::date || ' noon';
    elsif v_now::time between '15:47' and '15:58' then v_slot := v_now::date || ' 350';
    else return 0; end if;
    insert into pos_check_sent(slot) values (v_slot) on conflict do nothing;
    if not found then return 0; end if;
  end if;
  select count(*), string_agg(line, E'\n' order by d, symbol) into v_n, v_lines from (
    select t.d, t.symbol,
      '• <b>' || t.symbol || '</b>' || coalesce(' · ' || t.broker, '') || ' · ' ||
      case when t.kind = 'penny' then
        t.qty::text || ' sh @ ' || sp_px(t.entry) ||
        case when lv.px is null then ' · no live price' else
          ' · now ' || sp_px(lv.px) || ' · P&amp;L ' || case when lv.px >= t.entry then '+$' else '−$' end ||
          to_char(abs((lv.px - t.entry) * t.qty), 'FM999,990.00') || ' (' || case when lv.px >= t.entry then '+' else '−' end ||
          round(abs(lv.px / nullif(t.entry, 0) - 1) * 100, 1)::text || '%)' end
      else
        t.qty::text || ' ' || coalesce(t.opt_type, 'option') || coalesce(' ' || t.strike, '') || coalesce(' exp ' || to_char(t.expiry, 'MM/DD'), '') ||
        ' · in ' || sp_px(t.entry) || coalesce(' · stock now ' || sp_px(lv.px), '')
      end ||
      case when t.d < v_now::date then ' · open since ' || to_char(t.d, 'MM/DD') else '' end line
    from jr_trades t left join lateral sp_live(t.symbol) lv on true
    where t.user_id = v_admin and t.exit is null and t.symbol is not null and t.qty > 0 and t.entry is not null) z;
  if coalesce(v_n, 0) = 0 then return 0; end if;
  insert into telegram_outbox(text, parse_mode)
  values ('⏰ <b>CHECK YOUR OPEN POSITIONS · ' || to_char(v_now, 'FMHH12:MI AM') || '</b>' || E'\n' ||
          'Trade journal: ' || v_n::text || ' open trade' || case when v_n > 1 then 's' else '' end || E'\n\n' || left(v_lines, 3600), 'HTML');
  perform sp_tg_flush();
  return v_n;
end $$;
revoke all on function public.pos_check(boolean) from public, anon, authenticated;

select cron.schedule('pos-check-noon', '0 16,17 * * 1-5', 'select public.pos_check()');
select cron.schedule('pos-check-350', '50 19,20 * * 1-5', 'select public.pos_check()');
