-- Server-side Yahoo batch quotes for every Watchlist symbol, refreshed every 5 minutes by the price-scan function.
-- Writes: service role only (price-scan). Reads: anyone (the Watchlist page, via the anon key).
CREATE TABLE IF NOT EXISTS public.price_live (
  symbol          text PRIMARY KEY,
  price           numeric,
  change          numeric,
  change_pct      numeric,
  prev_close      numeric,
  volume          bigint,
  market_state    text,          -- PRE | REGULAR | POST | POSTPOST | CLOSED
  ext_price       numeric,       -- pre-market or post-market price when the session is extended
  ext_change      numeric,
  ext_change_pct  numeric,
  quote_time      timestamptz,   -- Yahoo regularMarketTime
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.price_live ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS price_live_anon_select ON public.price_live;
CREATE POLICY price_live_anon_select ON public.price_live
  FOR SELECT TO anon, authenticated USING (true);
