-- Migration: enroll_omen_flow_symbols
-- Extends enroll_missing_watchlist_symbols() to also cover symbols from omen_flow,
-- so any ticker that appears in an OMEN upload gets price_history built for it.
-- The immediate CSV upload handler also calls _scRegisterSymbols() in-band,
-- but this function is the safety-net that catches any symbol that slipped through.

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
    UNION
    SELECT symbol AS sym FROM omen_flow         WHERE symbol IS NOT NULL
  ) all_syms
  WHERE sym NOT IN (SELECT symbol FROM price_sync_status)
  ON CONFLICT (symbol) DO NOTHING;
END;
$$;

-- Run immediately to enroll any omen_flow symbols not yet in price_sync_status
SELECT enroll_missing_watchlist_symbols();
