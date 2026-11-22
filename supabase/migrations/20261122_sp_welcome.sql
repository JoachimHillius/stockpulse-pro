-- STEP 61 (source copy; applied by Claude in chat): one-time welcome card for new users.
alter table public.sp_profiles add column if not exists welcomed_at timestamptz;
create or replace function public.sp_me()
 returns json language sql stable security definer set search_path to 'public' as $function$
  select case when p.id is null then null else json_build_object('id', p.id, 'email', p.email, 'first_name', p.first_name, 'last_name', p.last_name, 'phone', p.phone,
    'username', p.username, 'role', p.role, 'status', p.status, 'features', p.features, 'created_at', p.created_at, 'welcomed_at', p.welcomed_at,
    'referrals', (select count(*) from sp_profiles r where r.referred_by = p.id),
    'users_open', coalesce((select value from sp_settings where key = 'users_open'), 'false'::jsonb)) end
  from (select auth.uid() uid) u left join sp_profiles p on p.id = u.uid
$function$;
create or replace function public.sp_welcomed() returns void
 language sql security definer set search_path to 'public' as $$
  update sp_profiles set welcomed_at = coalesce(welcomed_at, now()) where id = auth.uid()
$$;
revoke all on function public.sp_welcomed() from public, anon;
grant execute on function public.sp_welcomed() to authenticated;
update public.sp_profiles set welcomed_at = now() where role = 'admin';
