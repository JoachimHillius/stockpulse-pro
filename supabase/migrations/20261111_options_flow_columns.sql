-- Options availability + Omen flow stats, stored on the existing snapshot row.
ALTER TABLE public.rsi_snapshot
  ADD COLUMN IF NOT EXISTS has_options        boolean,
  ADD COLUMN IF NOT EXISTS options_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS flow_ever          boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS flow_days_30d      integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_flow_date     date;

-- One aggregate per call: filter symbols first, then aggregate (no client paging).
-- rsi-scan calls it once per 150-symbol chunk, so results stay far below the 1,000-row cap.
CREATE OR REPLACE FUNCTION public.get_options_flow_stats(p_symbols text[])
RETURNS TABLE (symbol text, flow_days_30d integer, last_flow_date date, flow_ever boolean)
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT f.symbol,
         (count(DISTINCT f.trading_date) FILTER (WHERE f.trading_date >= current_date - 30))::integer,
         max(f.trading_date),
         true
  FROM public.omen_flow f
  WHERE f.symbol = ANY (p_symbols)
  GROUP BY f.symbol
$$;

REVOKE ALL ON FUNCTION public.get_options_flow_stats(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_options_flow_stats(text[]) TO service_role;
