-- Migration: symbol_sectors_anon_write_policy
-- Problem: symbol_sectors had only a SELECT policy for the anon role.
-- addUserTicker and updateUserTickerSector both upsert to symbol_sectors
-- from the browser using the anon key — those writes were silently rejected,
-- so sector data for user-added symbols was never persisted.
--
-- Fix: add an ALL policy for anon so inserts and updates go through.
-- The table contains only {symbol, sector} pairs — no PII, no sensitive data.
-- Service-role writes from the edge function are unaffected.

CREATE POLICY "anon write symbol_sectors"
  ON symbol_sectors
  FOR ALL
  TO anon
  USING (true)
  WITH CHECK (true);
