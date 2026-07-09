import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Daily digest email to each company owner: birthdays today, and
// probation/contract/training expiries within the next 7 days. Triggered
// by a pg_cron + pg_net schedule (see schema-v20-hardening.sql), not by a
// logged-in user — protected by a shared secret instead of a user JWT.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

function esc(s: unknown) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c as string]!)); }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const cronSecret = Deno.env.get('CRON_SECRET');
    if (cronSecret && req.headers.get('x-cron-secret') !== cronSecret) {
      return json({ error: 'Unauthorised' }, 401);
    }

    const resendKey = Deno.env.get('RESEND_API_KEY');
    if (!resendKey) return json({ error: 'RESEND_API_KEY not set' }, 500);

    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const today = new Date();
    const in7 = new Date(today.getTime() + 7 * 86400000);
    const todayStr = today.toISOString().slice(0, 10);
    const in7Str = in7.toISOString().slice(0, 10);
    const thisMonthDay = today.getMonth() * 100 + today.getDate();

    const { data: companies } = await sb.from('payroll_companies').select('id, trading_name, owner_id').not('owner_id', 'is', null);
    let emailsSent = 0;

    for (const company of companies ?? []) {
      const { data: owner } = await sb.auth.admin.getUserById(company.owner_id);
      const ownerEmail = owner?.user?.email;
      if (!ownerEmail) continue;

      const { data: staff } = await sb.from('payroll_staff').select('full_name, date_of_birth, probation_end_date, contract_end_date').eq('company_id', company.id).eq('active', true);
      const { data: training } = await sb.from('payroll_training_records').select('course_name, expiry_date, payroll_staff(full_name)').eq('company_id', company.id).not('expiry_date', 'is', null).gte('expiry_date', todayStr).lte('expiry_date', in7Str);

      const birthdays = (staff ?? []).filter((s: any) => {
        if (!s.date_of_birth) return false;
        const d = new Date(s.date_of_birth + 'T00:00:00');
        return (d.getMonth() * 100 + d.getDate()) === thisMonthDay;
      });
      const probations = (staff ?? []).filter((s: any) => s.probation_end_date && s.probation_end_date >= todayStr && s.probation_end_date <= in7Str);
      const contracts = (staff ?? []).filter((s: any) => s.contract_end_date && s.contract_end_date >= todayStr && s.contract_end_date <= in7Str);

      if (birthdays.length === 0 && probations.length === 0 && contracts.length === 0 && (training ?? []).length === 0) continue;

      const section = (title: string, items: string[]) => items.length
        ? `<h3 style="font-size:0.92rem;margin:18px 0 8px">${title}</h3><ul style="margin:0;padding-left:18px;font-size:0.88rem;line-height:1.7">${items.map(i => `<li>${i}</li>`).join('')}</ul>`
        : '';

      const html = `
        <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0e1c40">
          <div style="background:#0e1c40;padding:24px 28px;border-radius:12px 12px 0 0">
            <span style="font-size:1.5rem;font-weight:900;letter-spacing:-0.03em"><span style="color:#2ab3b3">B</span><span style="color:#fff">urse</span></span>
          </div>
          <div style="background:#f8f9fb;padding:28px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px">
            <h2 style="font-size:1.15rem;font-weight:800;margin:0 0 6px">Today's HR reminders</h2>
            <p style="font-size:0.85rem;color:#7a8fb0;margin:0 0 4px">${esc(company.trading_name)}</p>
            ${section('🎂 Birthdays today', birthdays.map((s: any) => esc(s.full_name)))}
            ${section('📋 Probation ending within 7 days', probations.map((s: any) => `${esc(s.full_name)} — ${s.probation_end_date}`))}
            ${section('📄 Contracts ending within 7 days', contracts.map((s: any) => `${esc(s.full_name)} — ${s.contract_end_date}`))}
            ${section('🎓 Training/certificates expiring within 7 days', (training ?? []).map((t: any) => `${esc(t.payroll_staff?.full_name)} — ${esc(t.course_name)} (${t.expiry_date})`))}
            <a href="https://burse.co.za/payroll-admin" style="display:inline-block;margin-top:20px;background:#0e1c40;color:#fff;padding:11px 22px;border-radius:8px;font-weight:700;text-decoration:none;font-size:0.85rem">Open Burse</a>
          </div>
        </div>
      `;

      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'Burse Payroll <notifications@burse.co.za>', to: [ownerEmail], subject: `HR reminders for ${company.trading_name}`, html }),
      });
      if (res.ok) emailsSent++;
    }

    return json({ ok: true, emails_sent: emailsSent });
  } catch (err) {
    console.error('compliance-reminders error:', err);
    return json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
