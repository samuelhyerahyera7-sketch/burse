const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json();
    const {
      type, first_name, last_name, email,
      phone, company_name, employee_count, message,
    } = body;

    const resendKey = Deno.env.get('RESEND_API_KEY');
    if (!resendKey) return json({ error: 'RESEND_API_KEY not set' }, 500);

    const isDemo = type === 'demo';
    const subject = isDemo
      ? `New demo request — ${first_name} ${last_name} (${company_name || 'Unknown company'})`
      : `New contact message — ${first_name} ${last_name}`;

    const html = `
      <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0e1c40">
        <div style="background:#1e2a6e;padding:24px 28px;border-radius:12px 12px 0 0">
          <span style="font-size:1.5rem;font-weight:900;letter-spacing:-0.03em">
            <span style="color:#2ab3b3">B</span><span style="color:#fff">urse</span>
          </span>
        </div>
        <div style="background:#f8f9fb;padding:28px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px">
          <p style="font-size:0.8rem;font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:#2ab3b3;margin:0 0 10px">
            ${isDemo ? '📅 New Demo Request' : '💬 New Contact Message'}
          </p>
          <h2 style="font-size:1.3rem;font-weight:800;margin:0 0 20px">${first_name} ${last_name}</h2>

          <table style="width:100%;border-collapse:collapse;font-size:0.88rem">
            <tr><td style="padding:8px 0;color:#7a8fb0;width:40%">Email</td>
                <td style="padding:8px 0;font-weight:600"><a href="mailto:${email}" style="color:#1e2a6e">${email}</a></td></tr>
            ${phone ? `<tr><td style="padding:8px 0;color:#7a8fb0">Phone</td>
                <td style="padding:8px 0;font-weight:600">${phone}</td></tr>` : ''}
            ${company_name ? `<tr><td style="padding:8px 0;color:#7a8fb0">Company</td>
                <td style="padding:8px 0;font-weight:600">${company_name}</td></tr>` : ''}
            ${employee_count ? `<tr><td style="padding:8px 0;color:#7a8fb0">Employees</td>
                <td style="padding:8px 0;font-weight:600">${employee_count}</td></tr>` : ''}
          </table>

          ${message ? `
          <div style="margin-top:20px;padding:14px 16px;background:#fff;border:1px solid #e2e8f0;border-radius:8px">
            <p style="font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#7a8fb0;margin:0 0 6px">Message</p>
            <p style="font-size:0.88rem;margin:0;line-height:1.6">${message}</p>
          </div>` : ''}

          <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e2e8f0;font-size:0.75rem;color:#b0bec5">
            Submitted via burse.co.za/employers · ${new Date().toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' })}
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
        from: 'Burse <noreply@burse.co.za>',
        to:   ['admin@burse.co.za'],
        subject,
        html,
        reply_to: email,
      }),
    });

    const result = await res.json();
    if (!res.ok) return json({ error: result.message || 'Email failed' }, 500);

    return json({ sent: true, id: result.id });

  } catch (err) {
    console.error('notify-demo error:', err);
    return json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
