import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

type SB = ReturnType<typeof createClient>;

interface XeroTokenPayload {
  access_token: string;
  refresh_token: string;
  expires_at: string;
  tenant_id: string;
}

// Reads the stored Xero tokens for a company, refreshing them first if
// they're within 2 minutes of expiring (Xero access tokens last 30 min;
// refresh tokens are rotated on every use and stored back). Returns null if
// there's no connected Xero integration for this company.
export async function getXeroConnection(sb: SB, companyId: string): Promise<{ accessToken: string; tenantId: string; connectionId: string } | null> {
  const { data: conn } = await sb
    .from('payroll_integration_connections')
    .select('id, secret_id, status')
    .eq('company_id', companyId).eq('provider', 'xero').maybeSingle();
  if (!conn || conn.status !== 'connected') return null;

  const { data: raw, error: readErr } = await sb.rpc('vault_read_secret_for_integration', { p_secret_id: conn.secret_id });
  if (readErr || !raw) return null;
  let payload: XeroTokenPayload;
  try { payload = JSON.parse(raw); } catch { return null; }

  const expiresAt = new Date(payload.expires_at).getTime();
  if (Date.now() < expiresAt - 2 * 60 * 1000) {
    return { accessToken: payload.access_token, tenantId: payload.tenant_id, connectionId: conn.id };
  }

  const clientId = Deno.env.get('XERO_CLIENT_ID');
  const clientSecret = Deno.env.get('XERO_CLIENT_SECRET');
  if (!clientId || !clientSecret) return null;

  const tokenRes = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Basic ' + btoa(`${clientId}:${clientSecret}`) },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: payload.refresh_token }),
  });
  if (!tokenRes.ok) {
    await sb.from('payroll_integration_connections').update({ status: 'error', last_error: 'Xero token refresh failed — reconnect required.' }).eq('id', conn.id);
    return null;
  }
  const fresh = await tokenRes.json();
  const newPayload: XeroTokenPayload = {
    access_token: fresh.access_token, refresh_token: fresh.refresh_token,
    expires_at: new Date(Date.now() + (Number(fresh.expires_in) || 1800) * 1000).toISOString(),
    tenant_id: payload.tenant_id,
  };
  const { data: newSecretId } = await sb.rpc('vault_create_secret_for_integration', {
    p_secret: JSON.stringify(newPayload), p_name: `payroll_integration_xero_${companyId}_${Date.now()}`,
  });
  if (newSecretId) await sb.from('payroll_integration_connections').update({ secret_id: newSecretId }).eq('id', conn.id);

  return { accessToken: newPayload.access_token, tenantId: newPayload.tenant_id, connectionId: conn.id };
}

export async function xeroFetch(accessToken: string, tenantId: string, path: string, init: RequestInit = {}) {
  return fetch(`https://api.xero.com/api.xro/2.0${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${accessToken}`,
      'Xero-tenant-id': tenantId,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
}
