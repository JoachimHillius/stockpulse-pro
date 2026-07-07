-- Migration: enroll_missing_symbols_and_reset_pending
-- Problem: 63 symbols (SPY, QQQ, IWM, VIX, etc.) existed in price_history but were
-- never enrolled in price_sync_status, so the edge function never synced them.
-- Additionally, 1,817 symbols were last synced 2026-06-26 and needed a re-sync.
-- This migration enrolls all missing symbols and resets the sync queue.

-- Enroll every price_history symbol not yet in price_sync_status
INSERT INTO price_sync_status (symbol, last_status)
SELECT DISTINCT ph.symbol, 'pending'
FROM price_history ph
LEFT JOIN price_sync_status pss ON ph.symbol = pss.symbol
WHERE pss.symbol IS NULL
ON CONFLICT (symbol) DO NOTHING;

-- Reset all non-error symbols to pending for immediate re-sync.
-- Error symbols (BFB, DJX, RUT, RUTW, etc.) are index derivatives Yahoo Finance
-- cannot serve — leave them as 'error' so they don't waste batch slots.
UPDATE price_sync_status
SET last_status = 'pending', last_synced_at = NULL
WHERE last_status IN ('success', 'pending');
