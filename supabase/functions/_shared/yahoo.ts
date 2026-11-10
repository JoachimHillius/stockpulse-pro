// Shared Yahoo helpers. Yahoo's v7 endpoints need a cookie + crumb pair; plain calls return 401 "Invalid Crumb".
// (rsi-scan keeps its own identical copy of the handshake; this module is for newer functions.)
export const YAHOO_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

export interface YahooSession { cookie: string; crumb: string; }

export async function yahooSession(timeoutMs = 10_000): Promise<YahooSession | null> {
  try {
    const home = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': YAHOO_UA }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    const setCookie = home.headers.get('set-cookie') || '';
    const cookie = setCookie.split(',').map(c => c.trim().split(';')[0]).filter(c => c.startsWith('A')).join('; ') || setCookie.split(';')[0];
    const res = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': YAHOO_UA, Cookie: cookie }, signal: AbortSignal.timeout(timeoutMs) });
    const crumb = await res.text();
    // An error body ("Too Many Requests") is not a crumb.
    return res.ok && crumb.length > 0 && crumb.length < 40 && !/\s/.test(crumb) ? { cookie, crumb } : null;
  } catch (_) { return null; }
}
