// Burse Payroll Sync — Supabase Edge Function
// Deploy: supabase functions deploy payroll-sync
// Supports: Sage Business Cloud, PaySpace, SimplePay, CSV

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface PayrollEmployee {
  id: string
  name: string
  email: string
  id_number?: string
  phone?: string
  department?: string
  job_title?: string
  gross_salary: number
  net_salary?: number
  payday_of_month?: number
  start_date?: string
  active?: boolean
}

// ── Main handler ─────────────────────────────────────────────
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const { connection_id, csv_data } = await req.json()

  const { data: conn, error: connErr } = await sb
    .from('payroll_connections')
    .select('*')
    .eq('id', connection_id)
    .single()

  if (connErr || !conn) {
    return json({ error: 'Connection not found' }, 404)
  }

  let employees: PayrollEmployee[] = []
  let syncError: string | null = null

  try {
    switch (conn.provider) {
      case 'sage':      employees = await syncSage(conn, sb);       break
      case 'payspace':  employees = await syncPaySpace(conn, sb);   break
      case 'simplepay': employees = await syncSimplePay(conn);      break
      case 'csv':       employees = parseCsv(csv_data);             break
      default: return json({ error: 'Unknown provider: ' + conn.provider }, 400)
    }
  } catch (e) {
    syncError = e instanceof Error ? e.message : String(e)
    await sb.from('payroll_connections')
      .update({ status: 'error', last_error: syncError })
      .eq('id', connection_id)
    return json({ error: syncError }, 500)
  }

  // Upsert all employees into payroll_employees
  let upserted = 0
  for (const emp of employees) {
    const { error } = await sb.from('payroll_employees').upsert({
      connection_id: conn.id,
      external_id:   emp.id,
      full_name:     emp.name,
      email:         emp.email?.toLowerCase(),
      id_number:     emp.id_number,
      phone:         emp.phone,
      department:    emp.department,
      job_title:     emp.job_title,
      gross_salary:  emp.gross_salary,
      net_salary:    emp.net_salary,
      payday_of_month: emp.payday_of_month ?? 25,
      start_date:    emp.start_date,
      active:        emp.active ?? true,
      updated_at:    new Date().toISOString(),
    }, { onConflict: 'connection_id,external_id' })
    if (!error) upserted++
  }

  // Link any existing Burse users to their payroll employee record by email
  await sb.rpc('link_payroll_users_by_email', { p_connection_id: connection_id })

  await sb.from('payroll_connections').update({
    status: 'active',
    last_synced_at: new Date().toISOString(),
    last_error: null,
    employee_count: upserted,
  }).eq('id', connection_id)

  return json({ synced: upserted, total: employees.length })
})

// ── Sage Business Cloud Payroll ──────────────────────────────
async function syncSage(conn: any, sb: any): Promise<PayrollEmployee[]> {
  // Refresh OAuth token if expiring within 5 minutes
  let token = conn.sage_access_token
  const expiry = conn.sage_token_expires ? new Date(conn.sage_token_expires) : new Date(0)
  if (expiry.getTime() - Date.now() < 5 * 60 * 1000) {
    const res = await fetch('https://accounts.sageone.co.za/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: conn.sage_refresh_token,
        client_id:     conn.sage_client_id,
        client_secret: conn.sage_client_secret,
      }),
    })
    if (!res.ok) throw new Error(`Sage token refresh failed: ${res.status}`)
    const t = await res.json()
    token = t.access_token
    await sb.from('payroll_connections').update({
      sage_access_token:  t.access_token,
      sage_refresh_token: t.refresh_token ?? conn.sage_refresh_token,
      sage_token_expires: new Date(Date.now() + t.expires_in * 1000).toISOString(),
    }).eq('id', conn.id)
  }

  // Fetch employees — paginate through all pages
  const employees: PayrollEmployee[] = []
  let page = 1
  while (true) {
    const res = await fetch(
      `https://za.sageone.com/api/1.0.0/employees?companyId=${conn.sage_company_id}&page=${page}&pageSize=200`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
    )
    if (!res.ok) throw new Error(`Sage employees fetch failed: ${res.status}`)
    const data = await res.json()
    const items = data.items ?? data.Results ?? []
    if (items.length === 0) break

    for (const e of items) {
      const salary = e.salary?.regularPayAmount ?? e.remuneration?.regularPayAmount ?? 0
      employees.push({
        id:             String(e.id),
        name:           `${e.firstName ?? ''} ${e.lastName ?? ''}`.trim(),
        email:          e.emailAddress ?? e.privateEmailAddress ?? '',
        id_number:      e.idNumber,
        phone:          e.cellphoneNumber ?? e.telephoneNumber,
        department:     e.department?.description,
        job_title:      e.jobTitle?.description,
        gross_salary:   Number(salary),
        payday_of_month: 25,
        start_date:     e.startDate?.split('T')[0],
        active:         e.isActive ?? true,
      })
    }

    if (items.length < 200) break
    page++
  }

  return employees
}

// ── PaySpace ─────────────────────────────────────────────────
async function syncPaySpace(conn: any, sb: any): Promise<PayrollEmployee[]> {
  const base = (conn.payspace_base_url ?? 'https://api.payspace.com').replace(/\/$/, '')

  // Get / refresh OAuth2 token
  let token = conn.payspace_access_token
  const expiry = conn.payspace_token_expires ? new Date(conn.payspace_token_expires) : new Date(0)
  if (!token || expiry.getTime() - Date.now() < 5 * 60 * 1000) {
    const res = await fetch(`${base}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     conn.payspace_client_id,
        client_secret: conn.payspace_client_secret,
        scope:         'api',
      }),
    })
    if (!res.ok) throw new Error(`PaySpace token failed: ${res.status}`)
    const t = await res.json()
    token = t.access_token
    await sb.from('payroll_connections').update({
      payspace_access_token:  t.access_token,
      payspace_token_expires: new Date(Date.now() + (t.expires_in ?? 3600) * 1000).toISOString(),
    }).eq('id', conn.id)
  }

  // Fetch employees
  const res = await fetch(`${base}/api/${conn.payspace_company_id}/employees?Status=Active`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`PaySpace employees failed: ${res.status}`)
  const employees = await res.json()

  return (Array.isArray(employees) ? employees : employees.Data ?? []).map((e: any) => ({
    id:             String(e.EmployeeNumber ?? e.Id),
    name:           `${e.Firstname ?? e.FirstName ?? ''} ${e.Surname ?? e.LastName ?? ''}`.trim(),
    email:          e.EmailAddress ?? e.Email ?? '',
    id_number:      e.IDNumber,
    phone:          e.CellNumber ?? e.Phone,
    department:     e.Department?.Description ?? e.DepartmentDescription,
    job_title:      e.Position?.Description ?? e.PositionDescription,
    gross_salary:   Number(e.Remuneration?.Amount ?? e.BasicSalary ?? 0),
    payday_of_month: Number(e.PayFrequency?.PayDay ?? 25),
    start_date:     e.EmploymentDate?.split('T')[0],
    active:         (e.Status ?? 'Active') === 'Active',
  }))
}

// ── SimplePay ────────────────────────────────────────────────
async function syncSimplePay(conn: any): Promise<PayrollEmployee[]> {
  const res = await fetch('https://www.simplepay.co.za/api/v1/employees', {
    headers: {
      Authorization: `Token ${conn.simplepay_api_key}`,
      Accept: 'application/json',
    },
  })
  if (!res.ok) throw new Error(`SimplePay employees failed: ${res.status}`)
  const employees = await res.json()

  return (Array.isArray(employees) ? employees : []).map((e: any) => ({
    id:             String(e.id),
    name:           e.name ?? `${e.first_name ?? ''} ${e.last_name ?? ''}`.trim(),
    email:          e.email ?? '',
    id_number:      e.id_number,
    phone:          e.mobile,
    department:     e.department,
    job_title:      e.job_title,
    gross_salary:   Number(e.basic_salary ?? e.gross_salary ?? 0),
    payday_of_month: 25,
    start_date:     e.start_date,
    active:         e.active ?? e.status === 'active',
  }))
}

// ── CSV Parser ───────────────────────────────────────────────
// Expected columns (case-insensitive, any order):
// id/employee_number, name/full_name, email, gross_salary, net_salary,
// department, job_title, id_number, phone, payday, start_date
function parseCsv(raw: string): PayrollEmployee[] {
  const lines = raw.trim().split(/\r?\n/)
  if (lines.length < 2) throw new Error('CSV must have a header row and at least one data row')

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/\s+/g, '_'))
  const col = (aliases: string[]) => aliases.map(a => headers.indexOf(a)).find(i => i >= 0) ?? -1

  const idCol      = col(['id','employee_number','emp_no','employee_id'])
  const nameCol    = col(['name','full_name','employee_name'])
  const emailCol   = col(['email','email_address'])
  const salaryCol  = col(['gross_salary','salary','ctc','gross'])
  const netCol     = col(['net_salary','net','take_home'])
  const deptCol    = col(['department','dept'])
  const titleCol   = col(['job_title','title','position'])
  const idNumCol   = col(['id_number','id_no','sa_id'])
  const phoneCol   = col(['phone','mobile','cell'])
  const paydayCol  = col(['payday','pay_day','payday_of_month'])
  const startCol   = col(['start_date','employment_date'])

  if (nameCol === -1 || salaryCol === -1) {
    throw new Error('CSV must include columns for name/full_name and gross_salary')
  }

  return lines.slice(1).filter(l => l.trim()).map((line, i) => {
    const cols = line.split(',').map(c => c.trim().replace(/^"|"$/g, ''))
    return {
      id:             idCol >= 0 ? cols[idCol] : `csv-row-${i + 2}`,
      name:           cols[nameCol],
      email:          emailCol >= 0 ? cols[emailCol] : '',
      id_number:      idNumCol >= 0 ? cols[idNumCol] : undefined,
      phone:          phoneCol >= 0 ? cols[phoneCol] : undefined,
      department:     deptCol >= 0 ? cols[deptCol] : undefined,
      job_title:      titleCol >= 0 ? cols[titleCol] : undefined,
      gross_salary:   parseFloat(cols[salaryCol].replace(/[^0-9.]/g, '')) || 0,
      net_salary:     netCol >= 0 ? parseFloat(cols[netCol].replace(/[^0-9.]/g, '')) || 0 : undefined,
      payday_of_month: paydayCol >= 0 ? parseInt(cols[paydayCol]) || 25 : 25,
      start_date:     startCol >= 0 ? cols[startCol] : undefined,
      active:         true,
    }
  })
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}
