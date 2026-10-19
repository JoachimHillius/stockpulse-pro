-- Tracks whether a symbol has had its full 10y backfill, so the daily sync
-- can switch to a cheap 1mo incremental fetch afterwards.
ALTER TABLE public.price_sync_status
  ADD COLUMN IF NOT EXISTS full_history_loaded boolean NOT NULL DEFAULT false;
