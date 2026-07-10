-- Migration: auto_enroll_watchlist_symbols
-- Problem: symbols added to swing_watchlist or scanner_watchlist via the UI
-- or Pipedream pipelines were never guaranteed to land in price_sync_status,
-- so the sync cron skipped them and they showed stale or missing prices.
--
-- Fix: a pg_cron job runs every 10 minutes and enrolls any swing_watchlist
-- or scanner_watchlist symbol that is absent from price_sync_status.
-- ignoreDuplicates means already-enrolled symbols (success/error/pending) are
-- untouched — this only adds genuinely missing ones.

CREATE OR REPLACE FUNCTION enroll_missing_watchlist_symbols()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO price_sync_status (symbol, last_status)
  SELECT DISTINCT sym, 'pending'
  FROM (
    SELECT symbol AS sym FROM swing_watchlist   WHERE symbol IS NOT NULL
    UNION
    SELECT symbol AS sym FROM scanner_watchlist WHERE symbol IS NOT NULL
  ) all_syms
  WHERE sym NOT IN (SELECT symbol FROM price_sync_status)
  ON CONFLICT (symbol) DO NOTHING;
END;
$$;

-- Run immediately to enroll any symbols already missing
SELECT enroll_missing_watchlist_symbols();

-- Schedule: every 10 minutes — self-heals any gap within one cycle.
-- Fast no-op when no symbols are missing (just a COUNT).
SELECT cron.schedule(
  'enroll-missing-watchlist-symbols',
  '*/10 * * * *',
  'SELECT enroll_missing_watchlist_symbols();'
);
