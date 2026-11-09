-- RSI snapshot table + rsi-scan cron schedule.
-- Writes happen only through the rsi-scan edge function (service role); anon can read.
-- pg_cron runs in UTC and ET shifts in November/March, so every slot is scheduled for BOTH UTC
-- variants; the function's America/New_York gate skips whichever one is outside its window.

CREATE TABLE IF NOT EXISTS public.rsi_snapshot (
  symbol      text PRIMARY KEY,
  price       numeric,
  rsi_1h      numeric,
  rsi_4h      numeric,
  rsi_1d      numeric,
  rsi_1w      numeric,
  zone_1h     text,   -- 'ob' (>=70) | 'os' (<30) | 'mid'
  zone_4h     text,
  zone_1d     text,
  zone_1w     text,
  computed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.rsi_snapshot ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rsi_snapshot_anon_select ON public.rsi_snapshot;
CREATE POLICY rsi_snapshot_anon_select ON public.rsi_snapshot
  FOR SELECT TO anon, authenticated USING (true);

SELECT cron.schedule(
  'rsi-scan-0700-a',
  '0 11 * * 1-5',
  $cmd$
  SELECT net.http_post(
    url     := 'https://siwrhqcojoyxxwaxnopc.supabase.co/functions/v1/rsi-scan',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd3JocWNvam95eHh3YXhub3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MjEwMDUsImV4cCI6MjA5NDE5NzAwNX0._Dp0woo3iIcCCN5yQGgIGbBHZW8evf5MLUqIaudVlaU',
      'apikey',        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd3JocWNvam95eHh3YXhub3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MjEwMDUsImV4cCI6MjA5NDE5NzAwNX0._Dp0woo3iIcCCN5yQGgIGbBHZW8evf5MLUqIaudVlaU'
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $cmd$
);

SELECT cron.schedule(
  'rsi-scan-0700-b',
  '0 12 * * 1-5',
  $cmd$
  SELECT net.http_post(
    url     := 'https://siwrhqcojoyxxwaxnopc.supabase.co/functions/v1/rsi-scan',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd3JocWNvam95eHh3YXhub3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MjEwMDUsImV4cCI6MjA5NDE5NzAwNX0._Dp0woo3iIcCCN5yQGgIGbBHZW8evf5MLUqIaudVlaU',
      'apikey',        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd3JocWNvam95eHh3YXhub3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MjEwMDUsImV4cCI6MjA5NDE5NzAwNX0._Dp0woo3iIcCCN5yQGgIGbBHZW8evf5MLUqIaudVlaU'
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $cmd$
);

SELECT cron.schedule(
  'rsi-scan-0900-a',
  '0 13 * * 1-5',
  $cmd$
  SELECT net.http_post(
    url     := 'https://siwrhqcojoyxxwaxnopc.supabase.co/functions/v1/rsi-scan',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd3JocWNvam95eHh3YXhub3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MjEwMDUsImV4cCI6MjA5NDE5NzAwNX0._Dp0woo3iIcCCN5yQGgIGbBHZW8evf5MLUqIaudVlaU',
      'apikey',        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd3JocWNvam95eHh3YXhub3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MjEwMDUsImV4cCI6MjA5NDE5NzAwNX0._Dp0woo3iIcCCN5yQGgIGbBHZW8evf5MLUqIaudVlaU'
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $cmd$
);

SELECT cron.schedule(
  'rsi-scan-0900-b',
  '0 14 * * 1-5',
  $cmd$
  SELECT net.http_post(
    url     := 'https://siwrhqcojoyxxwaxnopc.supabase.co/functions/v1/rsi-scan',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd3JocWNvam95eHh3YXhub3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MjEwMDUsImV4cCI6MjA5NDE5NzAwNX0._Dp0woo3iIcCCN5yQGgIGbBHZW8evf5MLUqIaudVlaU',
      'apikey',        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd3JocWNvam95eHh3YXhub3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MjEwMDUsImV4cCI6MjA5NDE5NzAwNX0._Dp0woo3iIcCCN5yQGgIGbBHZW8evf5MLUqIaudVlaU'
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $cmd$
);

SELECT cron.schedule(
  'rsi-scan-1100-a',
  '0 15 * * 1-5',
  $cmd$
  SELECT net.http_post(
    url     := 'https://siwrhqcojoyxxwaxnopc.supabase.co/functions/v1/rsi-scan',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd3JocWNvam95eHh3YXhub3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MjEwMDUsImV4cCI6MjA5NDE5NzAwNX0._Dp0woo3iIcCCN5yQGgIGbBHZW8evf5MLUqIaudVlaU',
      'apikey',        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd3JocWNvam95eHh3YXhub3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MjEwMDUsImV4cCI6MjA5NDE5NzAwNX0._Dp0woo3iIcCCN5yQGgIGbBHZW8evf5MLUqIaudVlaU'
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $cmd$
);

SELECT cron.schedule(
  'rsi-scan-1100-b',
  '0 16 * * 1-5',
  $cmd$
  SELECT net.http_post(
    url     := 'https://siwrhqcojoyxxwaxnopc.supabase.co/functions/v1/rsi-scan',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd3JocWNvam95eHh3YXhub3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MjEwMDUsImV4cCI6MjA5NDE5NzAwNX0._Dp0woo3iIcCCN5yQGgIGbBHZW8evf5MLUqIaudVlaU',
      'apikey',        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd3JocWNvam95eHh3YXhub3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MjEwMDUsImV4cCI6MjA5NDE5NzAwNX0._Dp0woo3iIcCCN5yQGgIGbBHZW8evf5MLUqIaudVlaU'
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $cmd$
);

SELECT cron.schedule(
  'rsi-scan-1300-a',
  '0 17 * * 1-5',
  $cmd$
  SELECT net.http_post(
    url     := 'https://siwrhqcojoyxxwaxnopc.supabase.co/functions/v1/rsi-scan',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd3JocWNvam95eHh3YXhub3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MjEwMDUsImV4cCI6MjA5NDE5NzAwNX0._Dp0woo3iIcCCN5yQGgIGbBHZW8evf5MLUqIaudVlaU',
      'apikey',        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd3JocWNvam95eHh3YXhub3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MjEwMDUsImV4cCI6MjA5NDE5NzAwNX0._Dp0woo3iIcCCN5yQGgIGbBHZW8evf5MLUqIaudVlaU'
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $cmd$
);

SELECT cron.schedule(
  'rsi-scan-1300-b',
  '0 18 * * 1-5',
  $cmd$
  SELECT net.http_post(
    url     := 'https://siwrhqcojoyxxwaxnopc.supabase.co/functions/v1/rsi-scan',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd3JocWNvam95eHh3YXhub3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MjEwMDUsImV4cCI6MjA5NDE5NzAwNX0._Dp0woo3iIcCCN5yQGgIGbBHZW8evf5MLUqIaudVlaU',
      'apikey',        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd3JocWNvam95eHh3YXhub3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MjEwMDUsImV4cCI6MjA5NDE5NzAwNX0._Dp0woo3iIcCCN5yQGgIGbBHZW8evf5MLUqIaudVlaU'
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $cmd$
);

SELECT cron.schedule(
  'rsi-scan-1500-a',
  '0 19 * * 1-5',
  $cmd$
  SELECT net.http_post(
    url     := 'https://siwrhqcojoyxxwaxnopc.supabase.co/functions/v1/rsi-scan',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd3JocWNvam95eHh3YXhub3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MjEwMDUsImV4cCI6MjA5NDE5NzAwNX0._Dp0woo3iIcCCN5yQGgIGbBHZW8evf5MLUqIaudVlaU',
      'apikey',        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd3JocWNvam95eHh3YXhub3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MjEwMDUsImV4cCI6MjA5NDE5NzAwNX0._Dp0woo3iIcCCN5yQGgIGbBHZW8evf5MLUqIaudVlaU'
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $cmd$
);

SELECT cron.schedule(
  'rsi-scan-1500-b',
  '0 20 * * 1-5',
  $cmd$
  SELECT net.http_post(
    url     := 'https://siwrhqcojoyxxwaxnopc.supabase.co/functions/v1/rsi-scan',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd3JocWNvam95eHh3YXhub3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MjEwMDUsImV4cCI6MjA5NDE5NzAwNX0._Dp0woo3iIcCCN5yQGgIGbBHZW8evf5MLUqIaudVlaU',
      'apikey',        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd3JocWNvam95eHh3YXhub3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MjEwMDUsImV4cCI6MjA5NDE5NzAwNX0._Dp0woo3iIcCCN5yQGgIGbBHZW8evf5MLUqIaudVlaU'
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $cmd$
);

SELECT cron.schedule(
  'rsi-scan-1615-a',
  '15 20 * * 1-5',
  $cmd$
  SELECT net.http_post(
    url     := 'https://siwrhqcojoyxxwaxnopc.supabase.co/functions/v1/rsi-scan',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd3JocWNvam95eHh3YXhub3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MjEwMDUsImV4cCI6MjA5NDE5NzAwNX0._Dp0woo3iIcCCN5yQGgIGbBHZW8evf5MLUqIaudVlaU',
      'apikey',        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd3JocWNvam95eHh3YXhub3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MjEwMDUsImV4cCI6MjA5NDE5NzAwNX0._Dp0woo3iIcCCN5yQGgIGbBHZW8evf5MLUqIaudVlaU'
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $cmd$
);

SELECT cron.schedule(
  'rsi-scan-1615-b',
  '15 21 * * 1-5',
  $cmd$
  SELECT net.http_post(
    url     := 'https://siwrhqcojoyxxwaxnopc.supabase.co/functions/v1/rsi-scan',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd3JocWNvam95eHh3YXhub3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MjEwMDUsImV4cCI6MjA5NDE5NzAwNX0._Dp0woo3iIcCCN5yQGgIGbBHZW8evf5MLUqIaudVlaU',
      'apikey',        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd3JocWNvam95eHh3YXhub3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MjEwMDUsImV4cCI6MjA5NDE5NzAwNX0._Dp0woo3iIcCCN5yQGgIGbBHZW8evf5MLUqIaudVlaU'
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $cmd$
);

