-- price-scan schedule: every 5 minutes on ET weekdays, 04:00-20:05 ET.
-- pg_cron is UTC and ET shifts with DST, so the cron fires on a superset of UTC times and the function's
-- America/New_York gate (weekday, 04:00-20:05 ET) decides. A Friday-evening ET run lands on Saturday UTC, hence 2-6 below.
SELECT cron.schedule(
  'price-scan-a',
  '*/5 8-23 * * 1-5',
  $cmd$
  SELECT net.http_post(
    url     := 'https://siwrhqcojoyxxwaxnopc.supabase.co/functions/v1/price-scan',
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
  'price-scan-b',
  '*/5 0 * * 2-6',
  $cmd$
  SELECT net.http_post(
    url     := 'https://siwrhqcojoyxxwaxnopc.supabase.co/functions/v1/price-scan',
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
  'price-scan-c',
  '0,5 1 * * 2-6',
  $cmd$
  SELECT net.http_post(
    url     := 'https://siwrhqcojoyxxwaxnopc.supabase.co/functions/v1/price-scan',
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
