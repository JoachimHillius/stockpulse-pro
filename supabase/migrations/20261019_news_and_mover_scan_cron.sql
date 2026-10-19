-- News poll (every 5 min) and mover-scan slots.
-- pg_cron runs in UTC and ET shifts on Nov 1, so each mover-scan slot is scheduled for BOTH
-- UTC variants; the function's America/New_York gate skips whichever one is outside its window.
-- cron.schedule() with an existing jobname updates it, so this file is safe to re-run.

SELECT cron.schedule(
  'news-poll-5min',
  '*/5 * * * *',
  $cmd$
  SELECT net.http_post(
    url     := 'https://siwrhqcojoyxxwaxnopc.supabase.co/functions/v1/news-poll',
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
  'mover-scan-open-a',
  '35 13 * * 1-5',
  $cmd$
  SELECT net.http_post(
    url     := 'https://siwrhqcojoyxxwaxnopc.supabase.co/functions/v1/mover-scan',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd3JocWNvam95eHh3YXhub3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MjEwMDUsImV4cCI6MjA5NDE5NzAwNX0._Dp0woo3iIcCCN5yQGgIGbBHZW8evf5MLUqIaudVlaU',
      'apikey',        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd3JocWNvam95eHh3YXhub3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MjEwMDUsImV4cCI6MjA5NDE5NzAwNX0._Dp0woo3iIcCCN5yQGgIGbBHZW8evf5MLUqIaudVlaU'
    ),
    body    := '{"slot":"open"}'::jsonb,
    timeout_milliseconds := 30000
  );
  $cmd$
);

SELECT cron.schedule(
  'mover-scan-open-b',
  '35 14 * * 1-5',
  $cmd$
  SELECT net.http_post(
    url     := 'https://siwrhqcojoyxxwaxnopc.supabase.co/functions/v1/mover-scan',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd3JocWNvam95eHh3YXhub3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MjEwMDUsImV4cCI6MjA5NDE5NzAwNX0._Dp0woo3iIcCCN5yQGgIGbBHZW8evf5MLUqIaudVlaU',
      'apikey',        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd3JocWNvam95eHh3YXhub3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MjEwMDUsImV4cCI6MjA5NDE5NzAwNX0._Dp0woo3iIcCCN5yQGgIGbBHZW8evf5MLUqIaudVlaU'
    ),
    body    := '{"slot":"open"}'::jsonb,
    timeout_milliseconds := 30000
  );
  $cmd$
);

SELECT cron.schedule(
  'mover-scan-midday-a',
  '30 16 * * 1-5',
  $cmd$
  SELECT net.http_post(
    url     := 'https://siwrhqcojoyxxwaxnopc.supabase.co/functions/v1/mover-scan',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd3JocWNvam95eHh3YXhub3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MjEwMDUsImV4cCI6MjA5NDE5NzAwNX0._Dp0woo3iIcCCN5yQGgIGbBHZW8evf5MLUqIaudVlaU',
      'apikey',        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd3JocWNvam95eHh3YXhub3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MjEwMDUsImV4cCI6MjA5NDE5NzAwNX0._Dp0woo3iIcCCN5yQGgIGbBHZW8evf5MLUqIaudVlaU'
    ),
    body    := '{"slot":"midday"}'::jsonb,
    timeout_milliseconds := 30000
  );
  $cmd$
);

SELECT cron.schedule(
  'mover-scan-midday-b',
  '30 17 * * 1-5',
  $cmd$
  SELECT net.http_post(
    url     := 'https://siwrhqcojoyxxwaxnopc.supabase.co/functions/v1/mover-scan',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd3JocWNvam95eHh3YXhub3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MjEwMDUsImV4cCI6MjA5NDE5NzAwNX0._Dp0woo3iIcCCN5yQGgIGbBHZW8evf5MLUqIaudVlaU',
      'apikey',        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd3JocWNvam95eHh3YXhub3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MjEwMDUsImV4cCI6MjA5NDE5NzAwNX0._Dp0woo3iIcCCN5yQGgIGbBHZW8evf5MLUqIaudVlaU'
    ),
    body    := '{"slot":"midday"}'::jsonb,
    timeout_milliseconds := 30000
  );
  $cmd$
);

SELECT cron.schedule(
  'mover-scan-close-a',
  '30 19 * * 1-5',
  $cmd$
  SELECT net.http_post(
    url     := 'https://siwrhqcojoyxxwaxnopc.supabase.co/functions/v1/mover-scan',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd3JocWNvam95eHh3YXhub3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MjEwMDUsImV4cCI6MjA5NDE5NzAwNX0._Dp0woo3iIcCCN5yQGgIGbBHZW8evf5MLUqIaudVlaU',
      'apikey',        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd3JocWNvam95eHh3YXhub3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MjEwMDUsImV4cCI6MjA5NDE5NzAwNX0._Dp0woo3iIcCCN5yQGgIGbBHZW8evf5MLUqIaudVlaU'
    ),
    body    := '{"slot":"close"}'::jsonb,
    timeout_milliseconds := 30000
  );
  $cmd$
);

SELECT cron.schedule(
  'mover-scan-close-b',
  '30 20 * * 1-5',
  $cmd$
  SELECT net.http_post(
    url     := 'https://siwrhqcojoyxxwaxnopc.supabase.co/functions/v1/mover-scan',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd3JocWNvam95eHh3YXhub3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MjEwMDUsImV4cCI6MjA5NDE5NzAwNX0._Dp0woo3iIcCCN5yQGgIGbBHZW8evf5MLUqIaudVlaU',
      'apikey',        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd3JocWNvam95eHh3YXhub3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MjEwMDUsImV4cCI6MjA5NDE5NzAwNX0._Dp0woo3iIcCCN5yQGgIGbBHZW8evf5MLUqIaudVlaU'
    ),
    body    := '{"slot":"close"}'::jsonb,
    timeout_milliseconds := 30000
  );
  $cmd$
);
