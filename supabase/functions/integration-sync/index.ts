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

    const { connection_id } = await req.json();
    if (!connection_id) return json({ error: 'connection_id is required' }, 400);

    const { data: conn } = await sb.from('payroll_integration_connections').select('*, payroll_companies(*)').eq('id', connection_id).maybeSingle();
    if (!conn || conn.payroll_companies?.owner_id !== uid) return json({ error: 'Connection not found' }, 404);
    if (conn.status === 'disconnected') return json({ error: 'This connection has been disconnected. Reconnect it first.' }, 400);

    if (conn.provider !== 'simplepay') {
      return json({ error: `${conn.provider} syncing isn't wired up yet.` }, 501);
    }

    const { data: secretJson } = await sb.rpc('vault_read_secret_for_integration', { p_secret_id: conn.secret_id });
    if (!secretJson) return json({ error: 'Could not retrieve stored credentials.' }, 500);
    const credentials = JSON.parse(secretJson);
    const apiKey = credentials.api_key;

    const empRes = await fetch(`https://api.payroll.simplepay.cloud/v1/clients/${conn.external_ref}/employees`, {
      headers: { 'Authorization': apiKey },
    });
    if (!empRes.ok) {
      await sb.from('payroll_integration_connections').update({ status: 'error', last_error: `SimplePay returned ${empRes.status}` }).eq('id', connection_id);
      return json({ error: `SimplePay returned an error (${empRes.status}). The API key may have been revoked.` }, 400);
    }
    const employees: any[] = await empRes.json().catch(() => []);

    const { data: job } = await sb.from('payroll_migration_jobs').insert({
      company_id: conn.company_id, provider: 'simplepay', mode: 'integrate', source_type: 'api',
      status: 'importing', row_count: employees.length, valid_count: employees.length, created_by: uid,
    }).select().single();

    let imported = 0, failed = 0;
    const today = new Date().toISOString().slice(0, 10);
    for (let i = 0; i < employees.length; i++) {
      const e = (employees[i] as any).employee ?? employees[i];
      const fullName = [e.first_name, e.last_name].filter(Boolean).join(' ').trim();
      if (!fullName) { failed++; continue; }
      const payload = {
        company_id: conn.company_id,
        employee_number: e.number || null,
        full_name: fullName,
        id_number: e.identification_type === 'rsa_id' ? (e.id_number || null) : null,
        tax_number: e.income_tax_number || null,
        email: e.email || null,
        job_title: e.job_title || null,
        start_date: e.appointment_date || today,
        bank_account_number: e.bank_account?.account_number || null,
        bank_branch_code: e.bank_account?.branch_code || null,
      };
      try {
        let staffId: string | undefined;
        if (payload.employee_number) {
          const { data: existing } = await sb.from('payroll_staff').select('id').eq('company_id', conn.company_id).eq('employee_number', payload.employee_number).maybeSingle();
          if (existing) {
            const { data: upd, error } = await sb.from('payroll_staff').update(payload).eq('id', existing.id).select().single();
            if (error) throw error;
            staffId = upd.id;
          }
        }
        if (!staffId) {
          const { data: ins, error } = await sb.from('payroll_staff').insert({ ...payload, basic_salary: 0 }).select().single();
          if (error) throw error;
          staffId = ins.id;
        }
        if (job?.id) await sb.from('payroll_migration_rows').insert({ job_id: job.id, row_index: i, raw: e, mapped: payload, status: 'imported', staff_id: staffId });
        imported++;
      } catch (err) {
        failed++;
        if (job?.id) await sb.from('payroll_migration_rows').insert({ job_id: job.id, row_index: i, raw: e, mapped: payload, errors: [{ message: err instanceof Error ? err.message : 'Unknown error' }], status: 'error' });
      }
    }

    const now = new Date().toISOString();
    if (job?.id) {
      await sb.from('payroll_migration_jobs').update({
        status: 'completed', imported_count: imported, error_count: failed, completed_at: now, last_synced_at: now,
      }).eq('id', job.id);
    }
    await sb.from('payroll_integration_connections').update({ status: 'connected', last_error: null, last_sync_at: now }).eq('id', connection_id);
    await sb.from('payroll_audit_log').insert({
      company_id: conn.company_id, actor_id: uid, action: 'integration_synced', meta: { provider: 'simplepay', imported, failed },
    }).catch(() => {});

    return json({
      synced: true, imported, failed, total: employees.length,
      note: 'Salaries and leave balances are not synced yet — SimplePay exposes these via separate rate/leave-type endpoints not yet mapped. Update pay rates manually for now.',
    });

  } catch (err) {
    console.error('integration-sync error:', err);
    return json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
