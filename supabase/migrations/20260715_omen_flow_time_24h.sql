-- Migration: omen_flow_time_24h
-- Problem: time column is TEXT in 12-hour format ("04:07:05 PM").
-- String sorting is wrong — "10:00:00 AM" sorts after "01:00:00 PM" alphabetically.
--
-- Fix: add a GENERATED ALWAYS AS STORED column time_sort_key (INTEGER, seconds since midnight).
--
-- Why INTEGER not TIME:
--   CAST(text AS time) calls time_in() which is STABLE (depends on DateStyle GUC).
--   GENERATED ALWAYS AS requires IMMUTABLE. Integer arithmetic from split_part/::int is IMMUTABLE.
--
-- Why ascii() for PM/AM detection instead of LIKE:
--   In non-C locales, text LIKE/= may use collation-sensitive code paths.
--   ascii(right(trim(time),2)) extracts the first char of "PM"/"AM" as an integer comparison — always IMMUTABLE.
--     ascii('PM') = 80  (P)
--     ascii('AM') = 65  (A)
--
-- Conversion logic:
--   PM and hour ≠ 12  →  add 12 hours  ("04:07:05 PM" → 57,625 s)
--   AM and hour = 12  →  midnight       ("12:05:00 AM" →    300 s)
--   all other cases   →  literal hours  ("09:30:00 AM" → 34,200 s, "12:00:00 PM" → 43,200 s)

ALTER TABLE omen_flow
  ADD COLUMN IF NOT EXISTS time_sort_key INTEGER
  GENERATED ALWAYS AS (
    CASE
      WHEN time IS NULL OR length(trim(time)) = 0 THEN NULL
      -- ascii(right(trim(time),2)) = 80 → first char 'P' → 'PM'
      -- PM, hour ≠ 12: add 12 to convert hour
      WHEN ascii(right(trim(time), 2)) = 80
        AND split_part(trim(time), ':', 1)::int <> 12
      THEN (split_part(trim(time), ':', 1)::int + 12) * 3600
           + split_part(trim(time), ':', 2)::int * 60
           + split_part(split_part(trim(time), ':', 3), ' ', 1)::int
      -- ascii = 65 → first char 'A' → 'AM', hour = 12 → midnight (00:xx:xx)
      WHEN ascii(right(trim(time), 2)) = 65
        AND split_part(trim(time), ':', 1)::int = 12
      THEN 0
           + split_part(trim(time), ':', 2)::int * 60
           + split_part(split_part(trim(time), ':', 3), ' ', 1)::int
      -- All other cases (AM/hour≠12 and PM/hour=12): use hour as-is
      ELSE split_part(trim(time), ':', 1)::int * 3600
           + split_part(trim(time), ':', 2)::int * 60
           + split_part(split_part(trim(time), ':', 3), ' ', 1)::int
    END
  ) STORED;

-- Composite index for the main query: ORDER BY trading_date DESC, time_sort_key DESC
CREATE INDEX IF NOT EXISTS omen_flow_date_time_idx
  ON omen_flow (trading_date DESC, time_sort_key DESC NULLS LAST);
