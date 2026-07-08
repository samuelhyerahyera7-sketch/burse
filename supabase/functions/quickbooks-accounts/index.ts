import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getQuickBooksConnection, qboFetch } from '../_shared/quickbooks.ts';

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
      Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
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

    const qbo = await getQuickBooksConnection(sb, company_id);
    if (!qbo) return json({ error: 'QuickBooks isn\'t connected for this company — connect it first.' }, 400);

    const res = await qboFetch(qbo.accessToken, qbo.realmId, `/query?query=${encodeURIComponent("SELECT * FROM Account WHERE Active = true")}`);
    if (!res.ok) return json({ error: `QuickBooks returned an error listing accounts (${res.status}).` }, 502);
    const data = await res.json();
    const accounts = (data.QueryResponse?.Account || []).map((a: any) => ({
      id: a.Id, name: a.AcctNum ? `${a.AcctNum} — ${a.Name}` : a.Name, type: a.AccountType,
    }));

    return json({ accounts });
  } catch (err) {
    console.error('quickbooks-accounts error:', err);
    return json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
