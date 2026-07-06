const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { to, company_name } = await req.json();
    if (!to || !company_name) return json({ error: 'to and company_name are required' }, 400);

    const resendKey = Deno.env.get('RESEND_API_KEY');
    if (!resendKey) return json({ error: 'RESEND_API_KEY not set' }, 500);

    const html = `
      <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0e1c40">
        <div style="background:#0e1c40;padding:24px 28px;border-radius:12px 12px 0 0">
          <span style="font-size:1.5rem;font-weight:900;letter-spacing:-0.03em">
            <span style="color:#2ab3b3">B</span><span style="color:#fff">urse</span>
          </span>
        </div>
        <div style="background:#f8f9fb;padding:28px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px">
          <h2 style="font-size:1.2rem;font-weight:800;margin:0 0 14px">You've been given accountant access</h2>
          <p style="font-size:0.92rem;line-height:1.6;margin:0 0 20px">
            <strong>${esc(company_name)}</strong> has invited you to view their payroll on Burse — payslips,
            reports and bank payment files, read-only. You won't be able to approve payroll, edit bank details,
            or change salaries.
          </p>
          <p style="font-size:0.92rem;line-height:1.6;margin:0 0 20px">
            Sign up or log in at <a href="https://burse.co.za/login" style="color:#1e2a6e;font-weight:700">burse.co.za/login</a>
            using this email address (${esc(to)}) to claim access.
          </p>
          <a href="https://burse.co.za/login" style="display:inline-block;background:#0e1c40;color:#fff;padding:11px 22px;border-radius:8px;font-weight:700;text-decoration:none;font-size:0.88rem">
            Log in to Burse
          </a>
          <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e2e8f0;font-size:0.75rem;color:#b0bec5">
            If you weren't expecting this, you can ignore this email.
          </div>
        </div>
      </div>
    `;

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Burse <notifications@burse.co.za>',
        to: [to],
        subject: `${company_name} invited you to view their payroll on Burse`,
        html,
      }),
    });

    const result = await res.json();
    if (!res.ok) return json({ error: result.message || 'Email failed' }, 500);

    return json({ sent: true, id: result.id });

  } catch (err) {
    console.error('notify-accountant-invite error:', err);
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
