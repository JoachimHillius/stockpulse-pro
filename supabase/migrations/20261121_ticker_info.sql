-- Company info for the ticker pop-up and Telegram News: description (from the ticker-info function, Yahoo / Nasdaq) + latest headlines.
-- Applied 2026-11-21 via Supabase MCP (migrations ticker_info_brief + ticker_info_news).
create table if not exists public.ticker_info (
  symbol text primary key, name text, sector text, industry text, website text, summary text, source text,
  fetched_at timestamptz, tried_at timestamptz, error text, news jsonb, news_at timestamptz);
alter table public.ticker_info enable row level security;
drop policy if exists anon_read_ticker_info on public.ticker_info;
create policy anon_read_ticker_info on public.ticker_info for select to anon using (true);
grant select on public.ticker_info to anon;

create or replace function public.ticker_brief(p_symbol text)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'symbol', s.sym,
    'name', coalesce(ms.name, ti.name),
    'sector', coalesce(nullif(ms.sector, ''), ti.sector),
    'industry', coalesce(nullif(ms.industry, ''), ti.industry),
    'exchange', ms.exchange,
    'summary', ti.summary, 'summary_source', ti.source, 'website', ti.website, 'tried_at', ti.tried_at, 'news_at', ti.news_at,
    'news', coalesce(
      (select json_agg(x order by x.published_at desc) from (
        select n.headline, n.source, n.url, n.published_at from market_news n
        where s.sym = any(n.tickers) and n.published_at > now() - interval '3 days'
        order by n.published_at desc limit 3) x),
      ti.news::json, '[]'::json))
  from (select upper(trim(p_symbol)) sym) s
  left join market_symbols ms on ms.symbol = s.sym
  left join ticker_info ti on ti.symbol = s.sym
$$;
grant execute on function public.ticker_brief(text) to anon;
