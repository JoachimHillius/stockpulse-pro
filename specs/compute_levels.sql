-- Phase 3 Step 2 — SQL functions for level computation
-- Run in this order in Supabase SQL editor:
--   1. compute_levels_for_symbol_date  (this file, first block)
--   2. rebuild_level_history_for_date  (this file, second block)
--   3. update_levels_for_date          (this file, third block)
-- Then run the backfill UPDATE at the bottom.

-- ─────────────────────────────────────────────────────────────────────────────
-- FUNCTION 1: compute_levels_for_symbol_date
-- Returns a levels JSONB for one symbol/date:
--   MAs (20/50/200), 52w H/L, prior day H/L/C, swing pivots (5-bar + 10-bar),
--   round numbers, OI magnets. Levels within 0.8% band are merged into zones.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.compute_levels_for_symbol_date(
  p_symbol text,
  p_date   date
) RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
WITH

-- Up to 252 most recent bars ending on p_date (DESC order for MA calcs).
-- Source: level_history (stock_close/day_high/day_low) — that's where the real
-- daily OHLC lives for the 1,833 symbols in the flow scanner.
ph AS (
  SELECT
    trading_date,
    day_high    AS high,
    day_low     AS low,
    stock_close AS close,
    ROW_NUMBER() OVER (ORDER BY trading_date DESC) AS rn_rev
  FROM public.level_history
  WHERE symbol = p_symbol
    AND trading_date <= p_date
    AND stock_close IS NOT NULL
  ORDER BY trading_date DESC
  LIMIT 252
),

-- Same rows in chronological (ASC) order for window-based pivot detection
ph_fwd AS (
  SELECT
    trading_date, high, low, close,
    ROW_NUMBER() OVER (ORDER BY trading_date ASC) AS rn,
    COUNT(*)     OVER ()                          AS total
  FROM ph
),

-- MAs, current close, prior-day H/L/C
ref AS (
  SELECT
    ROUND(AVG(close) FILTER (WHERE rn_rev <=  20), 2) AS ma20,
    ROUND(AVG(close) FILTER (WHERE rn_rev <=  50), 2) AS ma50,
    ROUND(AVG(close) FILTER (WHERE rn_rev <= 200), 2) AS ma200,
    MAX(close) FILTER (WHERE rn_rev = 1)               AS curr_close,
    MAX(high)  FILTER (WHERE rn_rev = 2)               AS prev_high,
    MAX(low)   FILTER (WHERE rn_rev = 2)               AS prev_low,
    MAX(close) FILTER (WHERE rn_rev = 2)               AS prev_close,
    COUNT(*)                                            AS total_rows
  FROM ph
),

-- 52-week H/L
w52 AS (
  SELECT MAX(high) AS h52, MIN(low) AS l52 FROM ph
),

-- Swing pivot detection via sliding window.
-- 5-bar each side = ~20-day (recent); 10-bar = ~60-day (structural).
-- = MAX/MIN means this bar IS the extremum of that window.
swings_raw AS (
  SELECT
    trading_date, high, low, rn, total,
    high = MAX(high) OVER (ORDER BY rn ROWS BETWEEN  5 PRECEDING AND  5 FOLLOWING) AS is_ph5,
    low  = MIN(low)  OVER (ORDER BY rn ROWS BETWEEN  5 PRECEDING AND  5 FOLLOWING) AS is_pl5,
    high = MAX(high) OVER (ORDER BY rn ROWS BETWEEN 10 PRECEDING AND 10 FOLLOWING) AS is_ph10,
    low  = MIN(low)  OVER (ORDER BY rn ROWS BETWEEN 10 PRECEDING AND 10 FOLLOWING) AS is_pl10
  FROM ph_fwd
),

-- Only keep confirmed pivots: full N-bar window must exist on both sides.
-- Rows within N bars of the start or end of the series are unconfirmed.
swings AS (
  SELECT trading_date, high, low, is_ph5, is_pl5, is_ph10, is_pl10
  FROM swings_raw
  WHERE (is_ph5  AND rn >  5 AND rn <= total -  5)
     OR (is_pl5  AND rn >  5 AND rn <= total -  5)
     OR (is_ph10 AND rn > 10 AND rn <= total - 10)
     OR (is_pl10 AND rn > 10 AND rn <= total - 10)
  ORDER BY rn DESC
  LIMIT 20
),

-- Round numbers bracketing current price (± ~7%).
-- Step size scales with price: <$50 → $1, $50-$200 → $5, >$200 → $10.
rounds AS (
  SELECT gs::numeric AS price
  FROM ref,
  LATERAL (
    SELECT CASE
      WHEN ref.curr_close <  50 THEN  1.0
      WHEN ref.curr_close < 200 THEN  5.0
      ELSE                           10.0
    END AS step
  ) s,
  LATERAL (
    SELECT GENERATE_SERIES(
      FLOOR(ref.curr_close * 0.93 / s.step) * s.step,
      CEIL( ref.curr_close * 1.07 / s.step) * s.step,
      s.step
    )::numeric AS gs
  ) g
  WHERE ref.curr_close IS NOT NULL
    AND gs != ref.curr_close
),

-- OI magnets: top strikes by open interest from oi_accumulation JSONB.
-- Weight by days-to-expiry: dte=0 → weight 1.0; dte=60 → weight 0.1 floor.
oi_raw AS (
  SELECT
    (elem ->> 'strike')::numeric AS strike,
    (elem ->> 'oi'    )::bigint  AS oi,
    CASE
      WHEN (elem ->> 'expiry') ~ '^\d{1,2}/\d{1,2}/\d{4}$'
        THEN GREATEST(0, to_date(elem ->> 'expiry', 'MM/DD/YYYY') - p_date)
      ELSE 30
    END AS dte
  FROM public.level_history,
       jsonb_array_elements(oi_accumulation) AS elem
  WHERE symbol = p_symbol
    AND trading_date = p_date
    AND oi_accumulation IS NOT NULL
),
oi_magnets AS (
  SELECT
    strike,
    SUM(oi::numeric * GREATEST(0.1, 1.0 - dte::numeric / 60.0)) AS weighted_oi
  FROM oi_raw
  WHERE oi IS NOT NULL AND strike IS NOT NULL
  GROUP BY strike
  ORDER BY weighted_oi DESC
  LIMIT 15
),

-- Union all raw level sources into one table
all_levels AS (
  SELECT ma20,       'ma20',       1 AS strength FROM ref WHERE ma20       IS NOT NULL UNION ALL
  SELECT ma50,       'ma50',       1              FROM ref WHERE ma50       IS NOT NULL UNION ALL
  -- ma200 and 52w labeled _partial when history < threshold (34 days of data now)
  SELECT ma200,
    CASE WHEN (SELECT total_rows FROM ref) >= 150 THEN 'ma200' ELSE 'ma200_partial' END,
    1
  FROM ref WHERE ma200 IS NOT NULL UNION ALL
  SELECT prev_high,  'prev_high',  1              FROM ref WHERE prev_high  IS NOT NULL UNION ALL
  SELECT prev_low,   'prev_low',   1              FROM ref WHERE prev_low   IS NOT NULL UNION ALL
  SELECT prev_close, 'prev_close', 1              FROM ref WHERE prev_close IS NOT NULL UNION ALL
  SELECT h52,
    CASE WHEN (SELECT total_rows FROM ref) >= 200 THEN '52w_high' ELSE '52w_high_partial' END,
    2
  FROM w52 WHERE h52 IS NOT NULL UNION ALL
  SELECT l52,
    CASE WHEN (SELECT total_rows FROM ref) >= 200 THEN '52w_low' ELSE '52w_low_partial' END,
    2
  FROM w52 WHERE l52 IS NOT NULL UNION ALL
  SELECT high,
    CASE WHEN is_ph10 THEN 'swing_high_60d' ELSE 'swing_high_20d' END,
    CASE WHEN is_ph5 AND is_ph10 THEN 2 ELSE 1 END
  FROM swings WHERE is_ph5 OR is_ph10 UNION ALL
  SELECT low,
    CASE WHEN is_pl10 THEN 'swing_low_60d' ELSE 'swing_low_20d' END,
    CASE WHEN is_pl5 AND is_pl10 THEN 2 ELSE 1 END
  FROM swings WHERE is_pl5 OR is_pl10 UNION ALL
  SELECT price, 'round', 1 FROM rounds UNION ALL
  SELECT strike::numeric, 'oi_magnet',
    CASE WHEN weighted_oi > (SELECT AVG(weighted_oi) * 1.5 FROM oi_magnets) THEN 2 ELSE 1 END
  FROM oi_magnets
),

-- Tag each level as support or resistance relative to current close
tagged AS (
  SELECT
    ROUND(price::numeric, 2) AS price,
    type,
    strength,
    CASE WHEN price < (SELECT curr_close FROM ref) THEN 'support' ELSE 'resistance' END AS side
  FROM all_levels
  WHERE price IS NOT NULL AND price > 0
),

-- Sort by price for zone-merge pass
sorted AS (
  SELECT price, type, strength, side,
         ROW_NUMBER() OVER (ORDER BY price) AS rn
  FROM tagged
),

-- Mark the start of each new zone: new zone begins when gap > 0.8% of lower price
boundaries AS (
  SELECT
    curr.price, curr.type, curr.strength, curr.side, curr.rn,
    CASE
      WHEN prev.price IS NULL
        OR (curr.price - prev.price) / NULLIF(prev.price, 0) > 0.008
      THEN curr.rn
      ELSE NULL
    END AS zone_id
  FROM sorted curr
  LEFT JOIN sorted prev ON prev.rn = curr.rn - 1
),

-- Propagate zone IDs forward (gaps-and-islands: MAX of last non-NULL)
zone_ids AS (
  SELECT price, type, strength, side,
         MAX(zone_id) OVER (ORDER BY rn ROWS UNBOUNDED PRECEDING) AS zone
  FROM boundaries
),

-- Aggregate each zone: average price, all contributing types, summed strength
zones AS (
  SELECT
    ROUND(AVG(price), 2)                      AS price,
    to_jsonb(array_agg(type ORDER BY type))   AS types,
    SUM(strength)                             AS strength,
    MODE() WITHIN GROUP (ORDER BY side)       AS side
  FROM zone_ids
  GROUP BY zone
)

SELECT jsonb_build_object(
  'levels', COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'price',    price,
        'types',    types,
        'strength', strength,
        'side',     side
      )
      ORDER BY price
    ),
    '[]'::jsonb
  ),
  'current_close', (SELECT curr_close FROM ref),
  'computed_at',   p_date::text
)
FROM zones;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- FUNCTION 2: rebuild_level_history_for_date
-- Upserts one level_history row per active symbol for p_date.
-- Call from JS after each EOD upload (same pattern as rebuild_daily_summary_for_date).
-- Sets levels = NULL so update_levels_for_date re-fills it fresh.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rebuild_level_history_for_date(p_date date)
RETURNS void
LANGUAGE sql
AS $$
  INSERT INTO public.level_history (
    symbol, trading_date, stock_close, day_high, day_low,
    oi_accumulation, near_earnings, days_to_earnings
  )
  WITH flow AS (
    SELECT
      symbol,
      trading_date,
      to_timestamp(
        trading_date::text || ' ' || time,
        'YYYY-MM-DD HH12:MI:SS AM'
      )                                                       AS trade_ts,
      regexp_replace(stocklast, '[$,]', '', 'g')::numeric    AS price,
      strike,
      oi,
      parse_premium(premium)                                  AS premium_usd,
      replace(COALESCE(size, '0'), ',', '')::bigint           AS size_n,
      cp,
      expiry,
      earnings_context,
      earnings_date_raw
    FROM public.omen_flow
    WHERE trading_date = p_date
      AND stocklast IS NOT NULL
      AND stocklast ~ '\d'
  ),
  daily_range AS (
    SELECT symbol, trading_date,
           MAX(price) AS day_high, MIN(price) AS day_low
    FROM flow GROUP BY symbol, trading_date
  ),
  daily_close AS (
    SELECT DISTINCT ON (symbol, trading_date)
      symbol, trading_date, price AS stock_close
    FROM flow
    ORDER BY symbol, trading_date, trade_ts DESC
  ),
  oi_per_contract AS (
    SELECT symbol, trading_date, expiry, strike, cp,
           MAX(oi) AS oi, SUM(premium_usd) AS total_premium, SUM(size_n) AS total_size
    FROM flow WHERE strike IS NOT NULL
    GROUP BY symbol, trading_date, expiry, strike, cp
  ),
  oi_agg AS (
    SELECT symbol, trading_date,
      jsonb_agg(
        jsonb_build_object(
          'expiry', expiry, 'strike', strike, 'cp', cp,
          'oi', oi, 'total_premium', total_premium, 'total_size', total_size
        ) ORDER BY oi DESC NULLS LAST
      ) AS oi_accumulation
    FROM oi_per_contract GROUP BY symbol, trading_date
  ),
  earnings_ctx AS (
    SELECT DISTINCT ON (symbol, trading_date)
      symbol, trading_date, earnings_context,
      CASE
        WHEN earnings_date_raw ~ '^\d{1,2}/\d{1,2}/\d{4}$'
          THEN to_date(earnings_date_raw, 'MM/DD/YYYY')
        WHEN earnings_date_raw ~ '^\d{4}-\d{2}-\d{2}$'
          THEN earnings_date_raw::date
        ELSE NULL
      END AS earnings_date
    FROM flow WHERE earnings_context IN ('Approaching', 'Today')
    ORDER BY symbol, trading_date
  )
  SELECT
    dc.symbol, dc.trading_date, dc.stock_close,
    dr.day_high, dr.day_low,
    oi.oi_accumulation,
    (ec.earnings_context IS NOT NULL
      AND ec.earnings_context IN ('Approaching', 'Today'))  AS near_earnings,
    (ec.earnings_date - dc.trading_date)                    AS days_to_earnings
  FROM      daily_close  dc
  JOIN      daily_range  dr ON dr.symbol = dc.symbol AND dr.trading_date = dc.trading_date
  LEFT JOIN oi_agg       oi ON oi.symbol = dc.symbol AND oi.trading_date = dc.trading_date
  LEFT JOIN earnings_ctx ec ON ec.symbol = dc.symbol AND ec.trading_date = dc.trading_date
  ON CONFLICT (symbol, trading_date) DO UPDATE SET
    stock_close      = EXCLUDED.stock_close,
    day_high         = EXCLUDED.day_high,
    day_low          = EXCLUDED.day_low,
    oi_accumulation  = EXCLUDED.oi_accumulation,
    near_earnings    = EXCLUDED.near_earnings,
    days_to_earnings = EXCLUDED.days_to_earnings,
    levels           = NULL;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- FUNCTION 3: update_levels_for_date
-- Fills the levels column for every symbol on p_date by calling
-- compute_levels_for_symbol_date. Run this after rebuild_level_history_for_date.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_levels_for_date(p_date date)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE public.level_history
  SET levels = public.compute_levels_for_symbol_date(symbol, p_date)
  WHERE trading_date = p_date;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- BACKFILL: fill levels for all existing rows (run once after the 3 functions exist)
-- Expect ~1-3 minutes for 15,806 rows.
-- ─────────────────────────────────────────────────────────────────────────────
-- UPDATE public.level_history
-- SET levels = public.compute_levels_for_symbol_date(symbol, trading_date)
-- WHERE levels IS NULL;

-- Spot-check after backfill:
-- SELECT symbol, trading_date,
--        jsonb_array_length(levels -> 'levels') AS zone_count,
--        levels -> 'current_close'              AS close
-- FROM public.level_history
-- WHERE symbol = 'AAPL'
-- ORDER BY trading_date DESC
-- LIMIT 5;
