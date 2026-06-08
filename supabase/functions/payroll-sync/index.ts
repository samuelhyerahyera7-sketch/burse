import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorised' }, 401);

    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { connection_id, csv_data } = await req.json();
    if (!connection_id) return json({ error: 'connection_id required' }, 400);

    const { data: conn, error: connErr } = await sb
      .from('payroll_connections')
      .select('*')
      .eq('id', connection_id)
      .single();

    if (connErr || !conn) return json({ error: 'Connection not found' }, 404);

    let employees: Employee[] = [];

    switch (conn.provider) {
      case 'csv':
        if (!csv_data) return json({ error: 'csv_data required for CSV provider' }, 400);
        employees = parseCSV(csv_data);
        break;
      case 'sage':
        employees = await syncSage(conn);
        break;
      case 'payspace':
        employees = await syncPaySpace(conn);
        break;
      case 'simplepay':
        employees = await syncSimplePay(conn);
        break;
      default:
        return json({ error: `Unknown provider: ${conn.provider}` }, 400);
    }

    if (employees.length === 0) {
      return json({ error: 'No employee records found. Check your credentials or file format.' }, 422);
    }

    let synced = 0;
    let skipped = 0;

    for (const emp of employees) {
      if (!emp.email || !emp.full_name) { skipped++; continue; }

      const { data: existing } = await sb
        .from('profiles')
        .select('id')
        .eq('email', emp.email.toLowerCase().trim())
        .maybeSingle();

      const profileData: Record<string, unknown> = {
        full_name:             emp.full_name,
        email:                 emp.email.toLowerCase().trim(),
        gross_salary:          emp.gross_salary ?? null,
        net_salary:            emp.net_salary ?? null,
        department:            emp.department ?? null,
        job_title:             emp.job_title ?? null,
        employee_number:       emp.employee_number ?? null,
        phone:                 emp.phone ?? null,
        payday_of_month:       emp.payday ?? 25,
        employer_id:           conn.employer_id,
        payroll_provider:      conn.provider,
        payroll_connection_id: conn.id,
        updated_at:            new Date().toISOString(),
      };

      if (existing?.id) {
        await sb.from('profiles').update(profileData).eq('id', existing.id);
      } else {
        const { data: newUser, error: userErr } = await sb.auth.admin.inviteUserByEmail(
          emp.email.toLowerCase().trim(),
          { data: { full_name: emp.full_name } },
        );
        if (userErr || !newUser?.user) { skipped++; continue; }
        await sb.from('profiles').upsert({ id: newUser.user.id, ...profileData }, { onConflict: 'id' });
      }

      synced++;
    }

    await sb.from('payroll_connections').update({
      last_synced_at: new Date().toISOString(),
      employee_count: synced,
      status: 'active',
    }).eq('id', connection_id);

    return json({ synced, skipped, total: employees.length });

  } catch (err) {
    console.error('payroll-sync error:', err);
    return json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});

// ─── Types ────────────────────────────────────────────────────────────────────

interface Employee {
  email: string;
  full_name: string;
  gross_salary?: number;
  net_salary?: number;
  department?: string;
  job_title?: string;
  employee_number?: string;
  phone?: string;
  payday?: number;
}

// ─── CSV Parser ───────────────────────────────────────────────────────────────

function parseCSV(raw: string): Employee[] {
  const lines = raw.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const results: Employee[] = [];

  for (let i = 1; i < lines.length; i++) {
    const vals = splitCSVLine(lines[i]);
    if (vals.length < 2) continue;

    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = (vals[idx] ?? '').trim(); });

    const email = row['email'] || row['email_address'] || row['work_email'];
    const full_name = row['full_name'] || row['name'] ||
      `${row['first_name'] ?? ''} ${row['last_name'] ?? ''}`.trim();
    const gross = parseFloat(row['gross_salary'] || row['gross'] || row['salary'] || '0');

    if (!email || !full_name) continue;

    results.push({
      email,
      full_name,
      gross_salary:    gross > 0 ? gross : undefined,
      net_salary:      parseFloat(row['net_salary'] || row['net'] || '0') || undefined,
      department:      row['department'] || undefined,
      job_title:       row['job_title'] || row['position'] || row['role'] || undefined,
      employee_number: row['employee_number'] || row['emp_number'] || row['employee_no'] || undefined,
      phone:           row['phone'] || row['mobile'] || row['cell'] || undefined,
      payday:          parseInt(row['payday'] || row['pay_day'] || '25') || 25,
    });
  }

  return results;
}

function splitCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { result.push(current); current = ''; }
    else { current += ch; }
  }
  result.push(current);
  return result;
}

// ─── Sage Business Cloud ──────────────────────────────────────────────────────

async function syncSage(conn: Record<string, string>): Promise<Employee[]> {
  const tokenRes = await fetch('https://oauth.accounting.sage.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: conn.sage_refresh_token,
      client_id:     conn.sage_client_id,
      client_secret: conn.sage_client_secret,
    }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error('Sage auth failed: ' + (tokenData.error_description || tokenData.error || 'invalid credentials'));
  }

  const headers = { Authorization: `Bearer ${tokenData.access_token}` };
  const base = 'https://api.accounting.sage.com/v3.1';
  const companyId = conn.sage_company_id;

  const empRes = await fetch(`${base}/employees?company_id=${companyId}&items_per_page=200`, { headers });
  const empData = await empRes.json();
  const items: Record<string, unknown>[] = empData.$items ?? empData.data ?? [];

  return items.map((e: Record<string, unknown>) => ({
    email:           String(e.email || ''),
    full_name:       String(e.display_name || `${e.first_name ?? ''} ${e.last_name ?? ''}`.trim()),
    job_title:       String(e.job_title || ''),
    employee_number: String(e.reference || e.payroll_employee_number || ''),
  })).filter((e) => e.email && e.full_name);
}

// ─── PaySpace ─────────────────────────────────────────────────────────────────

async function syncPaySpace(conn: Record<string, string>): Promise<Employee[]> {
  const base = conn.payspace_base_url || 'https://api.payspace.com';

  const tokenRes = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     conn.payspace_client_id,
      client_secret: conn.payspace_client_secret,
      scope:         'api',
    }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error('PaySpace auth failed: ' + (tokenData.error_description || tokenData.error || 'invalid credentials'));
  }

  const headers = {
    Authorization:  `Bearer ${tokenData.access_token}`,
    'Content-Type': 'application/json',
  };
  const companyId = conn.payspace_company_id;

  const empRes = await fetch(`${base}/v1/${companyId}/employees?$top=500`, { headers });
  const empData = await empRes.json();
  const items: Record<string, unknown>[] = empData.value ?? empData.employees ?? empData ?? [];

  return items.map((e: Record<string, unknown>) => ({
    email:           String(e.EmailAddress || e.email || ''),
    full_name:       String(e.FullName || `${e.FirstName ?? ''} ${e.LastName ?? ''}`.trim()),
    department:      String(e.Department || ''),
    job_title:       String(e.JobTitle || e.Designation || ''),
    employee_number: String(e.EmployeeNumber || e.EmployeeCode || ''),
    gross_salary:    parseFloat(String(e.BasicSalary || e.GrossRemuneration || '0')) || undefined,
  })).filter((e) => e.email && e.full_name);
}

// ─── SimplePay ────────────────────────────────────────────────────────────────

async function syncSimplePay(conn: Record<string, string>): Promise<Employee[]> {
  const apiKey = conn.simplepay_api_key;
  const encoded = btoa(`${apiKey}:${apiKey}`);

  const empRes = await fetch('https://api.simplepay.co.za/api/v1/employees', {
    headers: {
      Authorization: `Basic ${encoded}`,
      Accept:        'application/json',
    },
  });

  if (!empRes.ok) {
    throw new Error(`SimplePay error ${empRes.status}: check your API key`);
  }

  const items: Record<string, unknown>[] = await empRes.json();

  return items.map((e: Record<string, unknown>) => ({
    email:           String(e.email || ''),
    full_name:       String(e.full_name || `${e.first_name ?? ''} ${e.last_name ?? ''}`.trim()),
    gross_salary:    parseFloat(String(e.gross_remuneration || e.gross_salary || '0')) || undefined,
    department:      String(e.department || ''),
    job_title:       String(e.job_title || ''),
    employee_number: String(e.employee_number || ''),
    payday:          parseInt(String(e.pay_day || '25')) || 25,
  })).filter((e) => e.email && e.full_name);
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
