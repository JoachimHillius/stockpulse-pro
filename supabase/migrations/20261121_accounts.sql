-- Accounts for StockPulse Pro: profiles (personal link from the first name), referrals, admin, BizScan on email verification.
-- Applied 2026-11-21 via Supabase MCP (migrations accounts_profiles_admin + accounts_lock_secrets).
-- The BizScan webhook URL lives in public.sp_secrets (key 'bizscan_webhook'), set directly in the database — not in this file.
create table if not exists public.sp_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null, first_name text, last_name text, phone text,
  username text unique not null,
  referred_by uuid references public.sp_profiles(id) on delete set null, referred_handle text,
  role text not null default 'user' check (role in ('user','admin')),
  status text not null default 'active' check (status in ('active','blocked')),
  features jsonb not null default '{"watchlist": true, "journal": true}'::jsonb,
  email_verified_at timestamptz, last_seen_at timestamptz, created_at timestamptz not null default now());
alter table public.sp_profiles enable row level security;
create table if not exists public.sp_settings (key text primary key, value jsonb);
create table if not exists public.sp_secrets (key text primary key, value text not null);
alter table public.sp_settings enable row level security;
alter table public.sp_secrets enable row level security;
insert into public.sp_settings (key, value) values ('users_open', 'false'::jsonb) on conflict (key) do nothing;
create policy read_sp_settings on public.sp_settings for select to anon, authenticated using (true);
create table if not exists public.sp_events (id bigserial primary key, user_id uuid, kind text, payload jsonb, request_id bigint, created_at timestamptz default now());
alter table public.sp_events enable row level security;

create or replace function public.sp_is_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from sp_profiles where id = auth.uid() and role = 'admin' and status = 'active') $$;
create policy own_or_admin_read on public.sp_profiles for select to authenticated using (id = auth.uid() or public.sp_is_admin());
create policy admin_read_events on public.sp_events for select to authenticated using (public.sp_is_admin());

create or replace function public.sp_make_username(p_first text) returns text language plpgsql security definer set search_path = public as $$
declare base text := lower(regexp_replace(coalesce(p_first, ''), '[^A-Za-z]', '', 'g')); cand text; i int := 1;
  reserved text[] := array['admin','api','login','logout','signin','signup','register','settings','account','journal','watchlist','auth','confirm','reset','help','support','about','index','app','www','stockpulse','propsst'];
begin
  if base = '' then base := 'user'; end if; base := left(base, 24);
  loop cand := case when i = 1 then base else base || i end;
    exit when not (cand = any(reserved)) and not exists (select 1 from sp_profiles where username = cand); i := i + 1; end loop;
  return cand;
end $$;

create or replace function public.sp_handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
declare m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb); ref_id uuid; ref_h text;
begin
  if coalesce(m->>'app', '') <> 'stockpulse' then return new; end if;
  ref_h := lower(nullif(trim(m->>'ref'), ''));
  if ref_h is not null then select id into ref_id from sp_profiles where username = ref_h; if ref_id is null then ref_h := null; end if; end if;
  insert into sp_profiles (id, email, first_name, last_name, phone, username, referred_by, referred_handle, role, features)
  values (new.id, lower(new.email), nullif(trim(m->>'first_name'), ''), nullif(trim(m->>'last_name'), ''), nullif(trim(m->>'phone'), ''),
          sp_make_username(m->>'first_name'), ref_id, ref_h,
          case when lower(new.email) = 'joachim@evolutionx4u.com' then 'admin' else 'user' end,
          case when lower(new.email) = 'joachim@evolutionx4u.com' then '{"all": true}'::jsonb else '{"watchlist": true, "journal": true}'::jsonb end)
  on conflict (id) do nothing;
  return new;
end $$;
create trigger sp_on_auth_user_created after insert on auth.users for each row execute function public.sp_handle_new_user();

create or replace function public.sp_handle_user_verified() returns trigger language plpgsql security definer set search_path = public as $$
declare p sp_profiles; url text; body jsonb; rid bigint;
begin
  if old.email_confirmed_at is not null or new.email_confirmed_at is null then return new; end if;
  update sp_profiles set email_verified_at = new.email_confirmed_at where id = new.id returning * into p;
  if p.id is null or p.email like '%@example.com' then return new; end if;
  select value into url from sp_secrets where key = 'bizscan_webhook';
  body := jsonb_strip_nulls(jsonb_build_object('name', trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), 'email', p.email, 'referred_by', p.referred_handle));
  if url is not null then select net.http_post(url := url, body := body, headers := '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds := 10000) into rid; end if;
  insert into sp_events (user_id, kind, payload, request_id) values (p.id, 'bizscan_signed_up', body, rid);
  return new;
end $$;
create trigger sp_on_auth_user_verified after update of email_confirmed_at on auth.users for each row execute function public.sp_handle_user_verified();

create or replace function public.sp_me() returns json language sql stable security definer set search_path = public as $$
  select case when p.id is null then null else json_build_object('id', p.id, 'email', p.email, 'first_name', p.first_name, 'last_name', p.last_name, 'phone', p.phone,
    'username', p.username, 'role', p.role, 'status', p.status, 'features', p.features, 'created_at', p.created_at,
    'referrals', (select count(*) from sp_profiles r where r.referred_by = p.id),
    'users_open', coalesce((select value from sp_settings where key = 'users_open'), 'false'::jsonb)) end
  from (select auth.uid() uid) u left join sp_profiles p on p.id = u.uid $$;
create or replace function public.sp_update_me(p_first text, p_last text, p_phone text) returns void language sql security definer set search_path = public as $$
  update sp_profiles set first_name = nullif(trim(p_first), ''), last_name = nullif(trim(p_last), ''), phone = nullif(trim(p_phone), '') where id = auth.uid() $$;
create or replace function public.sp_touch() returns void language sql security definer set search_path = public as $$
  update sp_profiles set last_seen_at = now() where id = auth.uid() $$;
create or replace function public.sp_link_name(p_username text) returns text language sql stable security definer set search_path = public as $$
  select first_name from sp_profiles where username = lower(p_username) and status = 'active' $$;
create or replace function public.sp_admin_users() returns table (id uuid, email text, first_name text, last_name text, phone text, username text, referred_handle text,
  role text, status text, features jsonb, email_verified_at timestamptz, last_seen_at timestamptz, created_at timestamptz, referrals bigint)
language sql stable security definer set search_path = public as $$
  select p.id, p.email, p.first_name, p.last_name, p.phone, p.username, p.referred_handle, p.role, p.status, p.features, p.email_verified_at, p.last_seen_at, p.created_at,
         (select count(*) from sp_profiles r where r.referred_by = p.id)
  from sp_profiles p where public.sp_is_admin() order by p.created_at desc $$;
create or replace function public.sp_admin_set(p_id uuid, p_status text, p_features jsonb) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.sp_is_admin() then raise exception 'not allowed'; end if;
  if p_id = auth.uid() and p_status = 'blocked' then raise exception 'you cannot block yourself'; end if;
  update sp_profiles set status = coalesce(p_status, status), features = coalesce(p_features, features) where id = p_id and role <> 'admin';
end $$;

revoke all on function public.sp_make_username(text), public.sp_handle_new_user(), public.sp_handle_user_verified() from public, anon, authenticated;
grant execute on function public.sp_me(), public.sp_update_me(text, text, text), public.sp_touch(), public.sp_admin_users(), public.sp_admin_set(uuid, text, jsonb), public.sp_is_admin() to authenticated;
grant execute on function public.sp_link_name(text) to anon, authenticated;
grant select on public.sp_profiles, public.sp_events to authenticated;
grant select on public.sp_settings to anon, authenticated;
revoke all on public.sp_secrets from anon, authenticated;
revoke insert, update, delete, truncate on public.sp_profiles, public.sp_events, public.sp_settings from anon, authenticated;
revoke all on public.sp_profiles, public.sp_events from anon;
