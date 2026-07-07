-- Migration: create_price_sync_auto_trigger
-- Root cause: the sync-price-history edge function was only called manually from
-- the UI. No cron job existed to call it automatically. The only pg_cron job
-- (parse_pending_yahoo_prices, every minute) is passive — it only parses Yahoo
-- HTTP responses already queued in net._http_response; it cannot fetch new data.
--
-- Fix: create two scheduled jobs:
--   1. sync-price-history-auto (*/3 * * * *): fires one batch of the edge function
--      every 3 minutes while pending symbols exist. Handles backfill and ongoing sync.
--   2. daily-price-sync-reset (15 21 * * 1-5): resets all success rows to pending
--      at 4:15 PM ET (45 min after NYSE close) so the every-3-min job syncs fresh
--      closes overnight, completing before market open the next day.

-- Function: fire one 30-symbol batch of sync-price-history if pending work exists.
-- Uses net.http_post (pg_net) so the HTTP call is async and doesn't block pg_cron.
CREATE OR REPLACE FUNCTION trigger_price_sync_batch()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_pending int;
BEGIN
  SELECT COUNT(*) INTO v_pending
  FROM price_sync_status
  WHERE last_status = 'pending';

  IF v_pending > 0 THEN
    PERFORM net.http_post(
      url     := 'https://siwrhqcojoyxxwaxnopc.supabase.co/functions/v1/sync-price-history',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd3JocWNvam95eHh3YXhub3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MjEwMDUsImV4cCI6MjA5NDE5NzAwNX0._Dp0woo3iIcCCN5yQGgIGbBHZW8evf5MLUqIaudVlaU',
        'apikey',        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd3JocWNvam95eHh3YXhub3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MjEwMDUsImV4cCI6MjA5NDE5NzAwNX0._Dp0woo3iIcCCN5yQGgIGbBHZW8evf5MLUqIaudVlaU'
      ),
      body    := '{"max_batch":30,"force_refresh":false}'::jsonb,
      timeout_milliseconds := 30000
    );
  END IF;
END;
$$;

-- Function: mark all successfully-synced symbols as pending again once per day,
-- so they get re-fetched with the latest close after each trading session.
-- Only resets rows last synced more than 20 hours ago to avoid mid-day thrash.
CREATE OR REPLACE FUNCTION daily_price_sync_reset()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE price_sync_status
  SET last_status = 'pending'
  WHERE last_status = 'success'
    AND (last_synced_at IS NULL OR last_synced_at < now() - interval '20 hours');
END;
$$;

-- Cron job 1: trigger a sync batch every 3 minutes while pending symbols exist.
-- At ~30 symbols per batch: 1,880 symbols = ~63 batches = ~3 hours to fully sync.
-- Once all symbols are 'success' this is a fast no-op (just a COUNT query).
SELECT cron.schedule(
  'sync-price-history-auto',
  '*/3 * * * *',
  'SELECT trigger_price_sync_batch();'
);

-- Cron job 2: reset success rows to pending at 21:15 UTC (4:15 PM ET) on weekdays.
-- The every-3-min job then processes them overnight, finishing well before market open.
SELECT cron.schedule(
  'daily-price-sync-reset',
  '15 21 * * 1-5',
  'SELECT daily_price_sync_reset();'
);
