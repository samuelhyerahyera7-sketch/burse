import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ─── Public REST API v1 ─────────────────────────────────────────────────
// For third-party integrations (EWA providers, accounting sync, custom
// dashboards) — authenticated with a Burse API key, not a user session.
// Path-based routing (unlike payroll-engine's action-in-body convention)
// since this is a real external-facing REST surface, not an internal RPC.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    const authHeader = req.headers.get('Authorization') || '';
    const rawKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!rawKey) return json({ error: 'Missing API key. Pass it as: Authorization: Bearer <key>' }, 401);

    const { data: auth, error: authErr } = await sb.rpc('validate_api_key', { p_raw_key: rawKey });
    if (authErr) {
      const status = authErr.message.includes('Rate limit') ? 429 : 401;
      return json({ error: authErr.message }, status);
    }
    const { company_id: companyId, scopes } = auth[0] as { company_id: string; scopes: string[] };

    function requireScope(scope: string) {
      if (!scopes.includes(scope)) throw new HttpError(`This key does not have the "${scope}" scope`, 403);
    }

    const url = new URL(req.url);
    // Strip the function name segment so routing works whether invoked as
    // /functions/v1/api-v1/employees or with the function mounted at the root.
    const path = url.pathname.replace(/^\/functions\/v1\/api-v1/, '').replace(/^\/api-v1/, '') || '/';
    const segments = path.split('/').filter(Boolean);

    // GET /employees
    if (req.method === 'GET' && segments.length === 1 && segments[0] === 'employees') {
      requireScope('read');
      const { data, error } = await sb
        .from('payroll_staff')
        .select('id, employee_number, full_name, job_title, department, employment_type, pay_frequency, active, start_date, end_date')
        .eq('company_id', companyId)
        .order('full_name');
      if (error) throw new HttpError(error.message, 400);
      return json({ employees: data });
    }

    // GET /payroll-runs
    if (req.method === 'GET' && segments.length === 1 && segments[0] === 'payroll-runs') {
      requireScope('read');
      const { data, error } = await sb
        .from('payroll_runs')
        .select('id, period_start, period_end, pay_date, frequency, status, tax_year, finalized_at')
        .eq('company_id', companyId)
        .order('period_start', { ascending: false })
        .limit(50);
      if (error) throw new HttpError(error.message, 400);
      return json({ payroll_runs: data });
    }

    // GET /payslips?run_id=X | ?employee_id=X
    if (req.method === 'GET' && segments.length === 1 && segments[0] === 'payslips') {
      requireScope('read');
      const runId = url.searchParams.get('run_id');
      const employeeId = url.searchParams.get('employee_id');
      if (!runId && !employeeId) throw new HttpError('Pass either ?run_id= or ?employee_id=', 400);

      let query = sb
        .from('payroll_payslips')
        .select('id, run_id, staff_id, gross_pay, paye, uif_employee, uif_employer, sdl_employer, eti_employer, other_deductions, loan_repayment, total_deductions, net_pay, payroll_runs!inner(company_id, period_start, period_end, pay_date)')
        .eq('payroll_runs.company_id', companyId);
      if (runId) query = query.eq('run_id', runId);
      if (employeeId) query = query.eq('staff_id', employeeId).order('created_at', { ascending: false }).limit(24);
      const { data, error } = await query;
      if (error) throw new HttpError(error.message, 400);
      return json({ payslips: data });
    }

    // GET /earnings/current?employee_id=X — earned-to-date this pay period, for EWA
    if (req.method === 'GET' && segments.length === 2 && segments[0] === 'earnings' && segments[1] === 'current') {
      requireScope('read');
      const employeeId = url.searchParams.get('employee_id');
      if (!employeeId) throw new HttpError('employee_id is required', 400);

      const { data: staff, error: staffErr } = await sb
        .from('payroll_staff')
        .select('id, full_name, basic_salary, active')
        .eq('id', employeeId).eq('company_id', companyId).maybeSingle();
      if (staffErr) throw new HttpError(staffErr.message, 400);
      if (!staff) throw new HttpError('Employee not found', 404);

      const today = new Date().toISOString().slice(0, 10);
      const { data: run } = await sb
        .from('payroll_runs')
        .select('id, period_start, period_end, status')
        .eq('company_id', companyId)
        .neq('status', 'finalized')
        .lte('period_start', today)
        .gte('period_end', today)
        .order('period_start', { ascending: false })
        .maybeSingle();

      if (!run) {
        return json({
          employee_id: staff.id, full_name: staff.full_name, has_open_period: false,
          message: 'No open pay period covers today — a pay run for the current period has not been created yet.',
        });
      }

      const periodStart = new Date(run.period_start);
      const periodEnd = new Date(run.period_end);
      const now = new Date(today);
      const totalDays = Math.max(1, Math.round((periodEnd.getTime() - periodStart.getTime()) / 86400000) + 1);
      const daysElapsed = Math.min(totalDays, Math.max(0, Math.round((now.getTime() - periodStart.getTime()) / 86400000) + 1));
      const earnedToDate = round2(Number(staff.basic_salary) * (daysElapsed / totalDays));

      const { data: loan } = await sb
        .from('payroll_loans')
        .select('label, principal, balance')
        .eq('staff_id', staff.id).eq('status', 'active').maybeSingle();

      const alreadyAdvanced = loan ? Number(loan.principal) : 0;
      const availableToAdvance = Math.max(0, round2(earnedToDate - alreadyAdvanced));

      return json({
        employee_id: staff.id, full_name: staff.full_name, has_open_period: true,
        run_id: run.id, period_start: run.period_start, period_end: run.period_end,
        days_elapsed: daysElapsed, total_days: totalDays,
        basic_salary: Number(staff.basic_salary), earned_to_date: earnedToDate,
        already_advanced_this_cycle: alreadyAdvanced,
        available_to_advance: availableToAdvance,
        note: 'earned_to_date is pro-rated on basic_salary only (calendar days), and does not include allowances, bonuses or statutory deductions. available_to_advance is advisory — you decide the actual cap.',
      });
    }

    // POST /advances
    if (req.method === 'POST' && segments.length === 1 && segments[0] === 'advances') {
      requireScope('advances:write');
      const body = await req.json().catch(() => ({}));
      const { employee_id, amount, label } = body;
      if (!employee_id) throw new HttpError('employee_id is required', 400);
      if (typeof amount !== 'number' || amount <= 0) throw new HttpError('amount must be a positive number', 400);

      const { data, error } = await sb.rpc('record_salary_advance', {
        p_company_id: companyId, p_staff_id: employee_id, p_amount: amount, p_label: label || 'Salary Advance',
      });
      if (error) throw new HttpError(error.message, error.code === 'P0002' ? 404 : 400);
      return json({ advance: data }, 201);
    }

    // GET /bookkeeping/accounts
    if (req.method === 'GET' && segments.length === 2 && segments[0] === 'bookkeeping' && segments[1] === 'accounts') {
      requireScope('bookkeeping:read');
      const { data, error } = await sb
        .from('bk_accounts')
        .select('id, code, name, type, is_system, archived')
        .eq('company_id', companyId).eq('archived', false).order('code');
      if (error) throw new HttpError(error.message, 400);
      return json({ accounts: data });
    }

    // GET /bookkeeping/journal
    if (req.method === 'GET' && segments.length === 2 && segments[0] === 'bookkeeping' && segments[1] === 'journal') {
      requireScope('bookkeeping:read');
      const { data, error } = await sb
        .from('bk_journal_entries')
        .select('id, entry_date, description, source, source_id, bk_journal_lines(account_id, debit, credit, description)')
        .eq('company_id', companyId).order('entry_date', { ascending: false }).limit(100);
      if (error) throw new HttpError(error.message, 400);
      return json({ journal_entries: data });
    }

    // POST /bookkeeping/journal-entries
    if (req.method === 'POST' && segments.length === 2 && segments[0] === 'bookkeeping' && segments[1] === 'journal-entries') {
      requireScope('bookkeeping:write');
      const body = await req.json().catch(() => ({}));
      const { entry_date, description, lines } = body;
      if (!entry_date || !description || !Array.isArray(lines) || lines.length < 2) {
        throw new HttpError('entry_date, description and at least two lines are required', 400);
      }
      const { data, error } = await sb.rpc('post_journal_entry', {
        p_company_id: companyId, p_entry_date: entry_date, p_description: description,
        p_source: 'api', p_source_id: null, p_lines: lines,
      });
      if (error) throw new HttpError(error.message, 400);
      return json({ journal_entry_id: data }, 201);
    }

    // POST /bookkeeping/expenses
    if (req.method === 'POST' && segments.length === 2 && segments[0] === 'bookkeeping' && segments[1] === 'expenses') {
      requireScope('bookkeeping:write');
      const body = await req.json().catch(() => ({}));
      const { expense_date, vendor, account_id, amount, vat_amount, description } = body;
      if (!expense_date || !vendor || !account_id || typeof amount !== 'number') {
        throw new HttpError('expense_date, vendor, account_id and amount are required', 400);
      }
      const { data, error } = await sb.rpc('record_expense', {
        p_company_id: companyId, p_expense_date: expense_date, p_vendor: vendor,
        p_account_id: account_id, p_amount: amount, p_vat_amount: vat_amount || 0, p_description: description || null,
      });
      if (error) throw new HttpError(error.message, 400);
      return json({ expense_journal_entry_id: data }, 201);
    }

    return json({ error: `No such endpoint: ${req.method} ${path}` }, 404);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error('api-v1 error:', err);
    return json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});
