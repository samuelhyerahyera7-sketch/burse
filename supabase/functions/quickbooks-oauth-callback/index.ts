import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ─── QuickBooks OAuth2: step 2 ───────────────────────────────────────────
// Mirrors xero-oauth-callback. One QuickBooks-specific difference: Intuit
// includes the company identifier (realmId) as its own query param on this
// redirect, rather than something you look up via a separate "connections"
// call the way Xero's tenantId works.

const APP_REDIRECT = Deno.env.get('QUICKBOOKS_APP_RETURN_URL') || 'https://burse.co.za/payroll-admin';

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const realmId = url.searchParams.get('realmId');
  const qboError = url.searchParams.get('error');

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  function redirectWithMessage(ok: boolean, message: string) {
    const dest = new URL(APP_REDIRECT);
    dest.searchParams.set('quickbooks', ok ? 'connected' : 'error');
    dest.searchParams.set('quickbooks_message', message);
    return Response.redirect(dest.toString(), 302);
  }

  try {
    if (qboError) return redirectWithMessage(false, `QuickBooks declined the connection: ${qboError}`);
    if (!code || !state || !realmId) return redirectWithMessage(false, 'Missing code, state or company (realmId) from QuickBooks.');

    const { data: stateRow } = await sb.from('quickbooks_oauth_states').select('company_id').eq('state', state).maybeSingle();
    if (!stateRow) return redirectWithMessage(false, 'This connection link has expired — please try connecting again.');
    await sb.from('quickbooks_oauth_states').delete().eq('state', state);
    const companyId = stateRow.company_id;

    const clientId = Deno.env.get('QUICKBOOKS_CLIENT_ID');
    const clientSecret = Deno.env.get('QUICKBOOKS_CLIENT_SECRET');
    const redirectUri = Deno.env.get('QUICKBOOKS_REDIRECT_URI');
    if (!clientId || !clientSecret || !redirectUri) return redirectWithMessage(false, 'QuickBooks isn\'t configured on this server yet.');

    const tokenRes = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + btoa(`${clientId}:${clientSecret}`),
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
    });
    if (!tokenRes.ok) return redirectWithMessage(false, `QuickBooks rejected the authorisation code (${tokenRes.status}).`);
    const tokenData = await tokenRes.json();
    const { access_token, refresh_token, expires_in } = tokenData;
    if (!access_token || !refresh_token) return redirectWithMessage(false, 'QuickBooks did not return usable tokens.');

    const expiresAt = new Date(Date.now() + (Number(expires_in) || 3600) * 1000).toISOString();
    const secretPayload = JSON.stringify({ access_token, refresh_token, expires_at: expiresAt, realm_id: realmId });
    const secretName = `payroll_integration_quickbooks_${companyId}`;

    const { data: secretId, error: secretErr } = await sb.rpc('vault_create_secret_for_integration', {
      p_secret: secretPayload, p_name: secretName,
    });
    if (secretErr) return redirectWithMessage(false, 'Could not securely store QuickBooks tokens: ' + secretErr.message);

    const { data: company } = await sb.from('payroll_companies').select('owner_id').eq('id', companyId).maybeSingle();

    const { error: connErr } = await sb.from('payroll_integration_connections').upsert({
      company_id: companyId, provider: 'quickbooks', status: 'connected', secret_id: secretId,
      external_ref: `Company ${realmId}`, last_error: null, connected_by: company?.owner_id,
    }, { onConflict: 'company_id,provider' });
    if (connErr) return redirectWithMessage(false, connErr.message);

    await sb.from('payroll_audit_log').insert({
      company_id: companyId, actor_id: company?.owner_id, action: 'integration_connected', meta: { provider: 'quickbooks', realm_id: realmId },
    }).catch(() => {});

    return redirectWithMessage(true, 'Connected to QuickBooks.');
  } catch (err) {
    console.error('quickbooks-oauth-callback error:', err);
    return redirectWithMessage(false, err instanceof Error ? err.message : 'Something went wrong connecting to QuickBooks.');
  }
});
