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

    const { payslip_id } = await req.json();
    if (!payslip_id) return json({ error: 'payslip_id is required' }, 400);

    const { data: payslip, error: payslipErr } = await sb
      .from('payroll_payslips')
      .select('*, payroll_staff(*), payroll_runs(*, payroll_companies(*))')
      .eq('id', payslip_id)
      .maybeSingle();
    if (payslipErr || !payslip) return json({ error: 'Payslip not found' }, 404);

    const run = payslip.payroll_runs;
    const company = run?.payroll_companies;
    if (!company || company.owner_id !== uid) return json({ error: 'Not authorised for this payslip' }, 404);

    const staff = payslip.payroll_staff;
    if (!staff?.email) return json({ error: 'This employee has no email address on file' }, 400);

    const resendKey = Deno.env.get('RESEND_API_KEY');
    if (!resendKey) return json({ error: 'RESEND_API_KEY not set' }, 500);

    const money = (n: number) => 'R ' + Number(n || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2 });

    const html = `
      <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0e1c40">
        <div style="background:#0e1c40;padding:24px 28px;border-radius:12px 12px 0 0">
          <span style="font-size:1.5rem;font-weight:900;letter-spacing:-0.03em">
            <span style="color:#2ab3b3">B</span><span style="color:#fff">urse</span>
          </span>
        </div>
        <div style="background:#f8f9fb;padding:28px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px">
          <h2 style="font-size:1.2rem;font-weight:800;margin:0 0 14px">Your payslip is ready</h2>
          <p style="font-size:0.92rem;line-height:1.6;margin:0 0 18px">
            Hi ${esc(staff.full_name)}, your payslip from <strong>${esc(company.trading_name)}</strong> for
            ${esc(run.period_start)} to ${esc(run.period_end)} (pay date ${esc(run.pay_date)}) is ready.
          </p>
          <table style="width:100%;border-collapse:collapse;font-size:0.88rem;margin-bottom:20px">
            <tr><td style="padding:6px 0;color:#7a8fb0">Gross pay</td><td style="padding:6px 0;text-align:right">${money(payslip.gross_pay)}</td></tr>
            <tr><td style="padding:6px 0;color:#7a8fb0">Total deductions</td><td style="padding:6px 0;text-align:right">${money(payslip.total_deductions)}</td></tr>
            <tr><td style="padding:10px 0;font-weight:800;border-top:1px solid #e2e8f0">Net pay</td><td style="padding:10px 0;text-align:right;font-weight:800;border-top:1px solid #e2e8f0">${money(payslip.net_pay)}</td></tr>
          </table>
          <a href="https://burse.co.za/payslip.html?id=${payslip.id}" style="display:inline-block;background:#0e1c40;color:#fff;padding:11px 22px;border-radius:8px;font-weight:700;text-decoration:none;font-size:0.88rem">
            View full payslip
          </a>
          <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e2e8f0;font-size:0.75rem;color:#b0bec5">
            This payslip is issued in terms of Section 33 of the Basic Conditions of Employment Act, 1997.
          </div>
        </div>
      </div>
    `;

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Burse Payroll <notifications@burse.co.za>',
        to: [staff.email],
        subject: `Your payslip from ${company.trading_name} — ${run.period_start} to ${run.period_end}`,
        html,
      }),
    });
    const result = await res.json();
    if (!res.ok) return json({ error: result.message || 'Email failed' }, 500);

    await sb.from('payroll_payslips').update({ sent_at: new Date().toISOString(), sent_to: staff.email }).eq('id', payslip_id);
    await sb.from('payroll_audit_log').insert({
      company_id: company.id, actor_id: uid, action: 'payslip_emailed',
      meta: { payslip_id, staff_name: staff.full_name, email: staff.email },
    });

    return json({ sent: true, id: result.id });

  } catch (err) {
    console.error('notify-payslip error:', err);
    return json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});

function esc(str: string) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
