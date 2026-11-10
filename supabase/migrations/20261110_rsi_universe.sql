-- Symbols the rsi-scan function tracks beyond the built-in WATCHLIST and user_watchlist
-- (scanner_watchlist, scanner_alerts, swing_watchlist). Written by rsi-scan (service role) only.
CREATE TABLE IF NOT EXISTS public.rsi_universe (
  symbol     text PRIMARY KEY,
  sector     text,
  sources    text[] NOT NULL DEFAULT '{}',
  first_seen timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.rsi_universe ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rsi_universe_anon_select ON public.rsi_universe;
CREATE POLICY rsi_universe_anon_select ON public.rsi_universe
  FOR SELECT TO anon, authenticated USING (true);
