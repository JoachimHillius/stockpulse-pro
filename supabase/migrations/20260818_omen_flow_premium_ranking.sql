-- Migration: omen_flow_premium_ranking
-- Adds dollar-premium parsing and ranking to Options Flow RPCs.
-- Premium text ('$222k', '$1.25M') is parsed inline in SQL.
-- Dominance test and sort order are controlled by p_rank_by:
--   'premium'   (default) — use call_premium vs put_premium
--   'contracts' — use call_contracts vs put_contracts
--   'entries'   — use call_count vs put_count
-- Return type changes require DROP before CREATE.

DROP FUNCTION IF EXISTS get_omen_coverage(date);
DROP FUNCTION IF EXISTS get_omen_top_calls(date, int, text);
DROP FUNCTION IF EXISTS get_omen_top_puts(date, int, text);

-- ---------------------------------------------------------------------------
-- Coverage: symbol count, entry counts, contract totals, premium totals
-- ---------------------------------------------------------------------------
CREATE FUNCTION get_omen_coverage(p_date date)
RETURNS TABLE(
  symbol_count    bigint,
  total_count     bigint,
  call_count      bigint,
  put_count       bigint,
  call_contracts  bigint,
  put_contracts   bigint,
  total_contracts bigint,
  call_premium    numeric,
  put_premium     numeric
)
LANGUAGE sql STABLE AS $$
  WITH prem AS (
    SELECT
      symbol,
      cp,
      COALESCE(
        NULLIF(regexp_replace(COALESCE(size,''), '[^0-9]', '', 'g'), '')::bigint,
        0
      ) AS contracts,
      CASE
        WHEN premium ILIKE '%M'
          THEN COALESCE(NULLIF(regexp_replace(COALESCE(premium,''),'[^0-9.]','','g'),''),'0')::numeric * 1000000
        WHEN premium ILIKE '%k'
          THEN COALESCE(NULLIF(regexp_replace(COALESCE(premium,''),'[^0-9.]','','g'),''),'0')::numeric * 1000
        ELSE
          COALESCE(NULLIF(regexp_replace(COALESCE(premium,''),'[^0-9.]','','g'),''),'0')::numeric
      END AS prem_val
    FROM omen_flow
    WHERE trading_date = p_date
  )
  SELECT
    COUNT(DISTINCT symbol)                                AS symbol_count,
    COUNT(*)                                              AS total_count,
    COUNT(*) FILTER (WHERE cp ILIKE 'Call')               AS call_count,
    COUNT(*) FILTER (WHERE cp ILIKE 'Put')                AS put_count,
    COALESCE(SUM(contracts) FILTER (WHERE cp ILIKE 'Call'), 0) AS call_contracts,
    COALESCE(SUM(contracts) FILTER (WHERE cp ILIKE 'Put'),  0) AS put_contracts,
    COALESCE(SUM(contracts), 0)                           AS total_contracts,
    COALESCE(SUM(prem_val)  FILTER (WHERE cp ILIKE 'Call'), 0) AS call_premium,
    COALESCE(SUM(prem_val)  FILTER (WHERE cp ILIKE 'Put'),  0) AS put_premium
  FROM prem;
$$;

-- ---------------------------------------------------------------------------
-- Top Calls: only symbols where call side is dominant under p_rank_by
-- ---------------------------------------------------------------------------
CREATE FUNCTION get_omen_top_calls(
  p_date    date,
  p_limit   int  DEFAULT 10,
  p_rank_by text DEFAULT 'premium'
)
RETURNS TABLE(
  symbol        text,
  total_entries bigint,
  call_count    bigint,
  put_count     bigint,
  call_contracts bigint,
  put_contracts  bigint,
  call_premium  numeric,
  put_premium   numeric,
  ratio         numeric
)
LANGUAGE sql STABLE AS $$
  WITH parsed AS (
    SELECT
      symbol,
      cp,
      COALESCE(
        NULLIF(regexp_replace(COALESCE(size,''),'[^0-9]','','g'),'')::bigint,
        0
      ) AS contracts,
      CASE
        WHEN premium ILIKE '%M'
          THEN COALESCE(NULLIF(regexp_replace(COALESCE(premium,''),'[^0-9.]','','g'),''),'0')::numeric * 1000000
        WHEN premium ILIKE '%k'
          THEN COALESCE(NULLIF(regexp_replace(COALESCE(premium,''),'[^0-9.]','','g'),''),'0')::numeric * 1000
        ELSE
          COALESCE(NULLIF(regexp_replace(COALESCE(premium,''),'[^0-9.]','','g'),''),'0')::numeric
      END AS prem_val
    FROM omen_flow
    WHERE trading_date = p_date
  ),
  agg AS (
    SELECT
      symbol,
      COUNT(*)                                                         AS total_entries,
      COUNT(*) FILTER (WHERE cp ILIKE 'Call')                          AS call_count,
      COUNT(*) FILTER (WHERE cp ILIKE 'Put')                           AS put_count,
      COALESCE(SUM(contracts) FILTER (WHERE cp ILIKE 'Call'), 0)       AS call_contracts,
      COALESCE(SUM(contracts) FILTER (WHERE cp ILIKE 'Put'),  0)       AS put_contracts,
      COALESCE(SUM(prem_val)  FILTER (WHERE cp ILIKE 'Call'), 0)       AS call_premium,
      COALESCE(SUM(prem_val)  FILTER (WHERE cp ILIKE 'Put'),  0)       AS put_premium
    FROM parsed
    GROUP BY symbol
  ),
  filtered AS (
    SELECT * FROM agg
    WHERE CASE p_rank_by
      WHEN 'contracts' THEN call_contracts > put_contracts
      WHEN 'entries'   THEN call_count     > put_count
      ELSE                  call_premium   > put_premium   -- 'premium'
    END
  )
  SELECT
    symbol,
    total_entries,
    call_count,
    put_count,
    call_contracts,
    put_contracts,
    call_premium,
    put_premium,
    CASE p_rank_by
      WHEN 'contracts' THEN ROUND(call_contracts::numeric / NULLIF(put_contracts::numeric, 0), 2)
      WHEN 'entries'   THEN ROUND(call_count::numeric     / NULLIF(put_count::numeric,     0), 2)
      ELSE                  ROUND(call_premium            / NULLIF(put_premium,             0), 2)
    END AS ratio
  FROM filtered
  ORDER BY CASE p_rank_by
    WHEN 'contracts' THEN call_contracts::numeric
    WHEN 'entries'   THEN call_count::numeric
    ELSE                  call_premium
  END DESC NULLS LAST
  LIMIT p_limit;
$$;

-- ---------------------------------------------------------------------------
-- Top Puts: only symbols where put side is dominant under p_rank_by
-- ---------------------------------------------------------------------------
CREATE FUNCTION get_omen_top_puts(
  p_date    date,
  p_limit   int  DEFAULT 10,
  p_rank_by text DEFAULT 'premium'
)
RETURNS TABLE(
  symbol        text,
  total_entries bigint,
  call_count    bigint,
  put_count     bigint,
  call_contracts bigint,
  put_contracts  bigint,
  call_premium  numeric,
  put_premium   numeric,
  ratio         numeric
)
LANGUAGE sql STABLE AS $$
  WITH parsed AS (
    SELECT
      symbol,
      cp,
      COALESCE(
        NULLIF(regexp_replace(COALESCE(size,''),'[^0-9]','','g'),'')::bigint,
        0
      ) AS contracts,
      CASE
        WHEN premium ILIKE '%M'
          THEN COALESCE(NULLIF(regexp_replace(COALESCE(premium,''),'[^0-9.]','','g'),''),'0')::numeric * 1000000
        WHEN premium ILIKE '%k'
          THEN COALESCE(NULLIF(regexp_replace(COALESCE(premium,''),'[^0-9.]','','g'),''),'0')::numeric * 1000
        ELSE
          COALESCE(NULLIF(regexp_replace(COALESCE(premium,''),'[^0-9.]','','g'),''),'0')::numeric
      END AS prem_val
    FROM omen_flow
    WHERE trading_date = p_date
  ),
  agg AS (
    SELECT
      symbol,
      COUNT(*)                                                         AS total_entries,
      COUNT(*) FILTER (WHERE cp ILIKE 'Call')                          AS call_count,
      COUNT(*) FILTER (WHERE cp ILIKE 'Put')                           AS put_count,
      COALESCE(SUM(contracts) FILTER (WHERE cp ILIKE 'Call'), 0)       AS call_contracts,
      COALESCE(SUM(contracts) FILTER (WHERE cp ILIKE 'Put'),  0)       AS put_contracts,
      COALESCE(SUM(prem_val)  FILTER (WHERE cp ILIKE 'Call'), 0)       AS call_premium,
      COALESCE(SUM(prem_val)  FILTER (WHERE cp ILIKE 'Put'),  0)       AS put_premium
    FROM parsed
    GROUP BY symbol
  ),
  filtered AS (
    SELECT * FROM agg
    WHERE CASE p_rank_by
      WHEN 'contracts' THEN put_contracts > call_contracts
      WHEN 'entries'   THEN put_count     > call_count
      ELSE                  put_premium   > call_premium   -- 'premium'
    END
  )
  SELECT
    symbol,
    total_entries,
    call_count,
    put_count,
    call_contracts,
    put_contracts,
    call_premium,
    put_premium,
    CASE p_rank_by
      WHEN 'contracts' THEN ROUND(put_contracts::numeric / NULLIF(call_contracts::numeric, 0), 2)
      WHEN 'entries'   THEN ROUND(put_count::numeric     / NULLIF(call_count::numeric,     0), 2)
      ELSE                  ROUND(put_premium            / NULLIF(call_premium,             0), 2)
    END AS ratio
  FROM filtered
  ORDER BY CASE p_rank_by
    WHEN 'contracts' THEN put_contracts::numeric
    WHEN 'entries'   THEN put_count::numeric
    ELSE                  put_premium
  END DESC NULLS LAST
  LIMIT p_limit;
$$;
