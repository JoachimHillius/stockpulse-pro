-- STEP 96 (source copy — already applied live; do not run): the daily penny watch list holds 20 (was 10), the same as large caps
create or replace function public.jr_watch_cap() returns trigger language plpgsql as $function$
begin
  if (select count(*) from public.jr_watch where user_id = new.user_id and d = new.d and kind = new.kind) >= 20 then
    raise exception 'Daily watch list is full (% max 20)', new.kind;
  end if;
  return new;
end $function$;
