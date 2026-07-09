import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Employee-facing AI assistant. Answers questions like "why was my PAYE
// higher this month" or "how many leave days do I have left" using only
// the asking employee's own recent payroll data — never another employee's,
// and never anything outside their own company. Requires ANTHROPIC_API_KEY;
// degrades to a clear "not configured" message if it's unset, same pattern
// as the Sage Payroll connector before real credentials existed.

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

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) {
      return json({ error: "The AI assistant isn't set up yet — ask your Burse administrator to configure it." }, 400);
    }

    const { question, company_id } = await req.json();
    if (!question || typeof question !== 'string' || !question.trim()) return json({ error: 'Ask a question first.' }, 400);
    if (question.length > 500) return json({ error: 'Keep your question under 500 characters.' }, 400);

    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // Owner asking about the whole company (e.g. "who has birthdays this
    // month", "who has overtime pending") gets a company-wide HR context
    // instead of the personal payslip context below.
    if (company_id) {
      const { data: company } = await sb.from('payroll_companies').select('id, name, owner_id').eq('id', company_id).maybeSingle();
      if (!company || company.owner_id !== uid) return json({ error: 'Not authorised for this company.' }, 403);

      const [{ data: staff }, { data: pendingOvertime }, { data: pendingLeave }, { data: pendingExpenses }, { data: pendingAdvances }] = await Promise.all([
        sb.from('payroll_staff').select('full_name, job_title, date_of_birth, probation_end_date, contract_end_date, active').eq('company_id', company_id).eq('active', true),
        sb.from('payroll_overtime_requests').select('staff_id, work_date, hours, payroll_staff(full_name)').eq('company_id', company_id).eq('status', 'pending'),
        sb.from('payroll_leave_requests').select('staff_id, leave_type, start_date, end_date, payroll_staff(full_name)').in('staff_id', (staff || []).map((s: any) => s.id)).eq('status', 'pending'),
        sb.from('payroll_expense_claims').select('staff_id, claim_type, amount, payroll_staff(full_name)').eq('company_id', company_id).eq('status', 'pending'),
        sb.from('payroll_advance_requests').select('staff_id, amount, payroll_staff(full_name)').eq('company_id', company_id).eq('status', 'pending'),
      ]);

      const context = {
        company_name: company.name,
        active_employees: staff || [],
        pending_overtime_requests: pendingOvertime || [],
        pending_leave_requests: pendingLeave || [],
        pending_expense_claims: pendingExpenses || [],
        pending_advance_requests: pendingAdvances || [],
        today: new Date().toISOString().slice(0, 10),
      };
      const system = `You are Burse's HR/payroll assistant, helping the owner/manager of a South African company answer questions about their team.
Rules:
- Only use the JSON data provided below — never invent names or figures.
- For birthday/probation/contract questions, compare dates against "today".
- Keep answers short and to the point, formatted as a brief list when there are multiple results.
- If the data doesn't answer the question, say so and suggest where in Burse they'd find it.

Company data:
${JSON.stringify(context)}`;

      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 500, system, messages: [{ role: 'user', content: question.trim() }] }),
      });
      if (!aiRes.ok) {
        console.error('Anthropic API error:', aiRes.status, await aiRes.text().catch(() => ''));
        return json({ error: 'The assistant is temporarily unavailable — try again shortly.' }, 502);
      }
      const aiData = await aiRes.json();
      return json({ answer: aiData.content?.[0]?.text || "I couldn't work out an answer to that — try rephrasing." });
    }

    const { data: staffRow } = await sb.from('payroll_staff').select('*').eq('user_id', uid).maybeSingle();
    if (!staffRow) return json({ error: "You're not linked to a Burse Payroll profile yet." }, 404);

    const [{ data: payslips }, { data: balances }, { data: leaveReqs }, { data: advanceReqs }] = await Promise.all([
      sb.from('payroll_payslips').select('basic_salary, travel_allowance, other_taxable_allowance, gross_pay, retirement_contribution, taxable_income, paye, medical_credit, uif_employee, other_deductions, total_deductions, net_pay, ytd_gross, ytd_paye, created_at, payroll_runs(period_start, period_end, pay_date, tax_year)')
        .eq('staff_id', staffRow.id).order('created_at', { ascending: false }).limit(3),
      sb.from('payroll_leave_balances').select('leave_type, cycle_start, entitled_days, taken_days').eq('staff_id', staffRow.id).order('cycle_start', { ascending: false }),
      sb.from('payroll_leave_requests').select('leave_type, start_date, end_date, days, status').eq('staff_id', staffRow.id).order('requested_at', { ascending: false }).limit(5),
      sb.from('payroll_advance_requests').select('amount, status, requested_at').eq('staff_id', staffRow.id).order('requested_at', { ascending: false }).limit(5),
    ]);

    const context = {
      employee_name: staffRow.full_name,
      basic_salary_per_period: staffRow.basic_salary,
      pay_frequency: staffRow.pay_frequency,
      recent_payslips: payslips || [],
      current_leave_balances: balances || [],
      recent_leave_requests: leaveReqs || [],
      recent_advance_requests: advanceReqs || [],
    };

    const system = `You are Burse's payroll assistant, answering one South African employee's questions about their own pay, tax and leave.
Rules:
- Only use the JSON data provided below — never invent figures.
- If the data doesn't answer the question, say so plainly and suggest they ask their payroll administrator.
- Explain PAYE/UIF changes by comparing the numbers across the recent_payslips array (e.g. bonus pushed taxable income into a higher bracket, or a change in retirement contribution).
- Keep answers short (2-4 sentences), plain-language, and in Rand (R).
- You are not a tax practitioner — for anything beyond explaining these payslip figures, tell them to consult SARS or a tax professional.

Employee data:
${JSON.stringify(context)}`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system,
        messages: [{ role: 'user', content: question.trim() }],
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text().catch(() => '');
      console.error('Anthropic API error:', aiRes.status, errText);
      return json({ error: 'The assistant is temporarily unavailable — try again shortly.' }, 502);
    }
    const aiData = await aiRes.json();
    const answer = aiData.content?.[0]?.text || "I couldn't work out an answer to that — try rephrasing.";

    return json({ answer });
  } catch (err) {
    console.error('ai-payroll-assistant error:', err);
    return json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
