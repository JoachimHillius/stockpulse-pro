// auth-login: sign in with a username (the personal link name, e.g. "john") or an email + password.
// The username is turned into the email on the server, so emails are never exposed to the browser. Returns the session.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
  try {
    const { login, password } = await req.json().catch(() => ({}));
    const who = String(login || '').trim().toLowerCase(), pw = String(password || '');
    if (!who || !pw || who.length > 200 || pw.length > 200) return json({ error: 'Enter your name (or email) and password.' }, 400);
    let email = who;
    if (!who.includes('@')) {
      if (!/^[a-z]{1,24}[0-9]{0,4}$/.test(who)) return json({ error: 'Name or password is wrong.' }, 401);
      const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
      const { data } = await admin.from('sp_profiles').select('email').eq('username', who).maybeSingle();
      if (!data?.email) return json({ error: 'Name or password is wrong.' }, 401);
      email = data.email;
    }
    const anon = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await anon.auth.signInWithPassword({ email, password: pw });
    if (error) {
      const m = /confirm/i.test(error.message) ? 'Please confirm your email first — check your inbox for the link.' : 'Name or password is wrong.';
      return json({ error: m }, 401);
    }
    return json({ access_token: data.session?.access_token, refresh_token: data.session?.refresh_token });
  } catch (e) {
    return json({ error: 'Sign-in failed — try again.' }, 500);
  }
});
