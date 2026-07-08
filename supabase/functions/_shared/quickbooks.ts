import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

type SB = ReturnType<typeof createClient>;

interface QboTokenPayload {
  access_token: string;
  refresh_token: string;
  expires_at: string;
  realm_id: string;
}

// QuickBooks access tokens last ~1 hour; refresh tokens are rotated on every
// use (and expire after 100 days of inactivity) and stored back, same
// pattern as the Xero helper.
export async function getQuickBooksConnection(sb: SB, companyId: string): Promise<{ accessToken: string; realmId: string; connectionId: string } | null> {
  const { data: conn } = await sb
    .from('payroll_integration_connections')
    .select('id, secret_id, status')
    .eq('company_id', companyId).eq('provider', 'quickbooks').maybeSingle();
  if (!conn || conn.status !== 'connected') return null;

  const { data: raw, error: readErr } = await sb.rpc('vault_read_secret_for_integration', { p_secret_id: conn.secret_id });
  if (readErr || !raw) return null;
  let payload: QboTokenPayload;
  try { payload = JSON.parse(raw); } catch { return null; }

  const expiresAt = new Date(payload.expires_at).getTime();
  if (Date.now() < expiresAt - 2 * 60 * 1000) {
    return { accessToken: payload.access_token, realmId: payload.realm_id, connectionId: conn.id };
  }

  const clientId = Deno.env.get('QUICKBOOKS_CLIENT_ID');
  const clientSecret = Deno.env.get('QUICKBOOKS_CLIENT_SECRET');
  if (!clientId || !clientSecret) return null;

  const tokenRes = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Basic ' + btoa(`${clientId}:${clientSecret}`) },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: payload.refresh_token }),
  });
  if (!tokenRes.ok) {
    await sb.from('payroll_integration_connections').update({ status: 'error', last_error: 'QuickBooks token refresh failed — reconnect required.' }).eq('id', conn.id);
    return null;
  }
  const fresh = await tokenRes.json();
  const newPayload: QboTokenPayload = {
    access_token: fresh.access_token, refresh_token: fresh.refresh_token,
    expires_at: new Date(Date.now() + (Number(fresh.expires_in) || 3600) * 1000).toISOString(),
    realm_id: payload.realm_id,
  };
  const { data: newSecretId } = await sb.rpc('vault_create_secret_for_integration', {
    p_secret: JSON.stringify(newPayload), p_name: `payroll_integration_quickbooks_${companyId}_${Date.now()}`,
  });
  if (newSecretId) await sb.from('payroll_integration_connections').update({ secret_id: newSecretId }).eq('id', conn.id);

  return { accessToken: newPayload.access_token, realmId: newPayload.realm_id, connectionId: conn.id };
}

// Intuit requires apps to go through a sandbox company before their OAuth
// keys are approved for production use — QUICKBOOKS_API_ENV switches the
// host accordingly. Defaults to sandbox so nothing accidentally posts to a
// real customer's books before that review is done.
function qboApiBase(): string {
  const env = Deno.env.get('QUICKBOOKS_API_ENV') === 'production' ? 'quickbooks' : 'sandbox-quickbooks';
  return `https://${env}.api.intuit.com`;
}

export async function qboFetch(accessToken: string, realmId: string, path: string, init: RequestInit = {}) {
  return fetch(`${qboApiBase()}/v3/company/${realmId}${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
}
