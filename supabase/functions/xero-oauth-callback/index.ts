import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ─── Xero OAuth2: step 2 ────────────────────────────────────────────────
// Xero redirects the browser here directly (GET, no Burse auth header) with
// ?code=...&state=.... The state is looked up (and deleted — one-time use)
// to recover the company_id, the code is exchanged for tokens, and Xero's
// /connections endpoint is called to find which Xero organisation (tenant)
// was authorised. Tokens are stored in Vault exactly like the existing
// SimplePay/PaySpace integrations. Always ends by redirecting the browser
// back into the app, success or failure, since a human is sitting here.

const APP_REDIRECT = Deno.env.get('XERO_APP_RETURN_URL') || 'https://burse.co.za/payroll-admin';

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const xeroError = url.searchParams.get('error');

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  function redirectWithMessage(ok: boolean, message: string) {
    const dest = new URL(APP_REDIRECT);
    dest.searchParams.set('xero', ok ? 'connected' : 'error');
    dest.searchParams.set('xero_message', message);
    return Response.redirect(dest.toString(), 302);
  }

  try {
    if (xeroError) return redirectWithMessage(false, `Xero declined the connection: ${xeroError}`);
    if (!code || !state) return redirectWithMessage(false, 'Missing code or state from Xero.');

    const { data: stateRow } = await sb.from('xero_oauth_states').select('company_id').eq('state', state).maybeSingle();
    if (!stateRow) return redirectWithMessage(false, 'This connection link has expired — please try connecting again.');
    await sb.from('xero_oauth_states').delete().eq('state', state);
    const companyId = stateRow.company_id;

    const clientId = Deno.env.get('XERO_CLIENT_ID');
    const clientSecret = Deno.env.get('XERO_CLIENT_SECRET');
    const redirectUri = Deno.env.get('XERO_REDIRECT_URI');
    if (!clientId || !clientSecret || !redirectUri) return redirectWithMessage(false, 'Xero isn\'t configured on this server yet.');

    const tokenRes = await fetch('https://identity.xero.com/connect/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + btoa(`${clientId}:${clientSecret}`),
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
    });
    if (!tokenRes.ok) return redirectWithMessage(false, `Xero rejected the authorisation code (${tokenRes.status}).`);
    const tokenData = await tokenRes.json();
    const { access_token, refresh_token, expires_in } = tokenData;
    if (!access_token || !refresh_token) return redirectWithMessage(false, 'Xero did not return usable tokens.');

    const connRes = await fetch('https://api.xero.com/connections', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (!connRes.ok) return redirectWithMessage(false, `Could not read your Xero organisations (${connRes.status}).`);
    const connections = await connRes.json().catch(() => []);
    const tenant = Array.isArray(connections) && connections.length ? connections[0] : null;
    if (!tenant?.tenantId) return redirectWithMessage(false, 'No Xero organisation was authorised.');

    const expiresAt = new Date(Date.now() + (Number(expires_in) || 1800) * 1000).toISOString();
    const secretPayload = JSON.stringify({ access_token, refresh_token, expires_at: expiresAt, tenant_id: tenant.tenantId });
    const secretName = `payroll_integration_xero_${companyId}`;

    const { data: secretId, error: secretErr } = await sb.rpc('vault_create_secret_for_integration', {
      p_secret: secretPayload, p_name: secretName,
    });
    if (secretErr) return redirectWithMessage(false, 'Could not securely store Xero tokens: ' + secretErr.message);

    const { data: company } = await sb.from('payroll_companies').select('owner_id').eq('id', companyId).maybeSingle();

    const { error: connErr } = await sb.from('payroll_integration_connections').upsert({
      company_id: companyId, provider: 'xero', status: 'connected', secret_id: secretId,
      external_ref: tenant.tenantName || tenant.tenantId, last_error: null, connected_by: company?.owner_id,
    }, { onConflict: 'company_id,provider' });
    if (connErr) return redirectWithMessage(false, connErr.message);

    await sb.from('payroll_audit_log').insert({
      company_id: companyId, actor_id: company?.owner_id, action: 'integration_connected', meta: { provider: 'xero', tenant: tenant.tenantName },
    }).catch(() => {});

    return redirectWithMessage(true, `Connected to ${tenant.tenantName || 'Xero'}.`);
  } catch (err) {
    console.error('xero-oauth-callback error:', err);
    return redirectWithMessage(false, err instanceof Error ? err.message : 'Something went wrong connecting to Xero.');
  }
});
