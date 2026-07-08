import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ─── Xero OAuth2: step 1 ────────────────────────────────────────────────
// Called by the browser (authenticated) to get the Xero consent URL to
// redirect to. Creates a one-time `state` row so the callback (which has no
// Burse auth header — Xero redirects the browser there directly) can safely
// recover which company initiated the connection without trusting a
// client-supplied company_id at that point.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorised' }, 401);

    const sbUser = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData } = await sbUser.auth.getUser();
    if (!userData?.user) return json({ error: 'Unauthorised' }, 401);
    const uid = userData.user.id;

    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { company_id } = await req.json();
    if (!company_id) return json({ error: 'company_id is required' }, 400);

    const { data: company } = await sb.from('payroll_companies').select('id, owner_id').eq('id', company_id).maybeSingle();
    if (!company || company.owner_id !== uid) return json({ error: 'Not authorised for this company' }, 404);

    const clientId = Deno.env.get('XERO_CLIENT_ID');
    const redirectUri = Deno.env.get('XERO_REDIRECT_URI');
    if (!clientId || !redirectUri) {
      return json({ error: 'Xero isn\'t configured on this server yet — XERO_CLIENT_ID and XERO_REDIRECT_URI need to be set.' }, 501);
    }

    // Clean up stale states for this company before issuing a new one.
    await sb.from('xero_oauth_states').delete().eq('company_id', company_id);
    const { data: stateRow, error: stateErr } = await sb.from('xero_oauth_states').insert({ company_id }).select('state').single();
    if (stateErr) return json({ error: stateErr.message }, 500);

    const authorizeUrl = new URL('https://login.xero.com/identity/connect/authorize');
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('scope', 'openid profile email accounting.transactions accounting.settings offline_access');
    authorizeUrl.searchParams.set('state', stateRow.state);

    return json({ url: authorizeUrl.toString() });
  } catch (err) {
    console.error('xero-oauth-start error:', err);
    return json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
