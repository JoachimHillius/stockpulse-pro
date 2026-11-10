-- user_watchlist had anon SELECT / INSERT / DELETE policies but no UPDATE, so the inline sector select
-- (UPDATE user_watchlist SET sector ...) silently changed 0 rows under RLS.
DROP POLICY IF EXISTS "Allow anon update user_watchlist" ON public.user_watchlist;
CREATE POLICY "Allow anon update user_watchlist" ON public.user_watchlist FOR UPDATE TO anon USING (true) WITH CHECK (true);
