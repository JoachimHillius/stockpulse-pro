-- Migration: fix_price_sync_reset_and_stuck_pending
-- Root cause: daily_price_sync_reset() reset ALL last_status='success' rows to
-- 'pending' at 21:15 UTC every weekday. The auto-cron then processed 30 symbols
-- at a time from a 2,448-symbol queue, taking ~4 hours to drain. Watchlist symbols
-- (positions 700-1000 alphabetically) were never reached before the next daily reset,
-- leaving them perpetually 'pending'.
--
-- Additionally, an older edge function version wrote rows_loaded and latest_date but
-- never set last_status='success', leaving 71+ symbols stuck at 'pending' with stale
-- data indefinitely.

-- Fix 1: only reset rows where the data is genuinely stale (latest_date < CURRENT_DATE).
-- Symbols synced with today's close stay 'success' and are not re-queued until tomorrow.
CREATE OR REPLACE FUNCTION daily_price_sync_reset()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE price_sync_status
  SET last_status = 'pending'
  WHERE last_status = 'success'
    AND (latest_date IS NULL OR latest_date < CURRENT_DATE)
    AND (last_synced_at IS NULL OR last_synced_at < now() - interval '20 hours');
END;
$$;

-- Fix 2: one-time repair for symbols stuck at last_status='pending' with old data.
-- These were processed by the old edge function (rows_loaded > 0) but never got
-- their status flipped. Clear last_synced_at so the next sync run treats them as
-- fresh candidates. They need a real re-sync; the data in price_history is stale.
UPDATE price_sync_status
SET last_synced_at = NULL,
    error_message   = 'stuck_pending_reset'
WHERE last_status = 'pending'
  AND rows_loaded > 0
  AND error_message IS NULL;
