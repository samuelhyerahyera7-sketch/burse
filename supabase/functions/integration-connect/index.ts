import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { company_id, provider, credentials } = await req.json();
    if (!company_id || !provider || !credentials) return json({ error: 'company_id, provider and credentials are required' }, 400);

    const { data: company } = await sb.from('payroll_companies').select('id, owner_id').eq('id', company_id).maybeSingle();
    if (!company || company.owner_id !== uid) return json({ error: 'Not authorised for this company' }, 404);

    if (!['simplepay', 'payspace', 'sage_payroll'].includes(provider)) return json({ error: 'Unsupported provider' }, 400);

    // ── Validate the credentials against the real provider before storing anything ──
    let externalRef: string | null = null;
    if (provider === 'simplepay') {
      const apiKey = String(credentials.api_key || '').trim();
      if (!apiKey) return json({ error: 'SimplePay API key is required' }, 400);

      const res = await fetch('https://api.payroll.simplepay.cloud/v1/clients/', {
        headers: { 'Authorization': apiKey },
      });
      if (!res.ok) {
        return json({ error: res.status === 401 || res.status === 403
          ? 'SimplePay rejected that API key. Generate a fresh one at payroll.simplepay.cloud → Settings → External Users.'
          : `SimplePay returned an unexpected error (${res.status}).` }, 400);
      }
      const clients = await res.json().catch(() => []);
      externalRef = Array.isArray(clients) && clients.length ? String(clients[0].id ?? '') : null;
    } else if (provider === 'payspace') {
      const { client_id, client_secret, scope, company_id: pspCompanyId, environment } = credentials;
      if (!client_id || !client_secret || !scope || !pspCompanyId) {
        return json({ error: 'Client ID, Client Secret, Scope and PaySpace Company ID are all required.' }, 400);
      }
      const env = environment === 'apistaging' ? 'apistaging' : 'api';

      const tokenRes = await fetch('https://identity.yourhcm.com/connect/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id, client_secret, scope }),
      });
      if (!tokenRes.ok) {
        return json({ error: 'PaySpace/Deel Local Payroll rejected those credentials. Double-check the Client ID, Client Secret and Scope you were given at registration.' }, 400);
      }
      const tokenData = await tokenRes.json().catch(() => ({}));
      const accessToken = tokenData.access_token;
      if (!accessToken) return json({ error: 'PaySpace did not return an access token.' }, 400);

      const empRes = await fetch(`https://api.payspace.com/odata/v1.1/${encodeURIComponent(pspCompanyId)}/Employee`, {
        headers: { 'CustomAuthHeader': accessToken, 'CustomEnvironmentHeader': env },
      });
      if (!empRes.ok) {
        return json({ error: empRes.status === 404
          ? 'That PaySpace Company ID could not be found. Check it against your PaySpace account.'
          : `PaySpace returned an unexpected error (${empRes.status}).` }, 400);
      }
      externalRef = String(pspCompanyId);
    } else if (provider === 'sage_payroll') {
      // Sage Business Cloud Payroll does have a real OAuth2 API, but the API
      // host is region/edition-specific and contradictory across what's publicly
      // documented (api.columbus.sage.com for Spain, lohnabrechnung.sage.com for
      // Germany, no confirmed South African host found) — and registering an
      // OAuth app requires a Sage developer account tied to a real business,
      // which isn't something this service can do on a customer's behalf.
      // Shipping a guessed host here would silently point at the wrong region's
      // API rather than just being unavailable, so this stays off until a real
      // Sage-confirmed endpoint is available.
      return json({ error: 'Sage Payroll isn\'t connected yet — Sage\'s API endpoint is region-specific and needs confirming with your Sage account manager or developer.sage.com before this can go live. Your details have not been saved.' }, 501);
    }

    const secretName = `payroll_integration_${provider}_${company_id}`;
    const { data: secretId, error: secretErr } = await sb.rpc('vault_create_secret_for_integration', {
      p_secret: JSON.stringify(credentials), p_name: secretName,
    });
    if (secretErr) return json({ error: 'Could not securely store credentials: ' + secretErr.message }, 500);

    const { data: conn, error: connErr } = await sb.from('payroll_integration_connections').upsert({
      company_id, provider, status: 'connected', secret_id: secretId, external_ref: externalRef,
      last_error: null, connected_by: uid,
    }, { onConflict: 'company_id,provider' }).select().single();
    if (connErr) return json({ error: connErr.message }, 500);

    await sb.from('payroll_audit_log').insert({
      company_id, actor_id: uid, action: 'integration_connected', meta: { provider },
    }).catch(() => {});

    return json({ connected: true, connection: conn });

  } catch (err) {
    console.error('integration-connect error:', err);
    return json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
