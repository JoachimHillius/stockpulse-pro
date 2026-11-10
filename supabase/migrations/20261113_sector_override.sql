-- Manual sector overrides for Watchlist symbols (built-in, user, RSI-only). Precedence: sector_override -> existing logic.
-- Same permissive anon pattern as user_watchlist; upserts need INSERT + UPDATE, so both exist here.
CREATE TABLE IF NOT EXISTS public.sector_override (
  symbol     text PRIMARY KEY,
  sector     text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.sector_override ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow anon read sector_override"   ON public.sector_override;
DROP POLICY IF EXISTS "Allow anon insert sector_override" ON public.sector_override;
DROP POLICY IF EXISTS "Allow anon update sector_override" ON public.sector_override;
DROP POLICY IF EXISTS "Allow anon delete sector_override" ON public.sector_override;

CREATE POLICY "Allow anon read sector_override"   ON public.sector_override FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Allow anon insert sector_override" ON public.sector_override FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Allow anon update sector_override" ON public.sector_override FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow anon delete sector_override" ON public.sector_override FOR DELETE TO anon USING (true);
