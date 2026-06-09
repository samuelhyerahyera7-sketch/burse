const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json();
    const { name, company, email, phone, service, volume, message } = body;

    const resendKey = Deno.env.get('RESEND_API_KEY');
    if (!resendKey) return json({ error: 'RESEND_API_KEY not set' }, 500);

    const subject = `New quote request — ${name || 'Unknown'} (${company || 'No company'})`;

    const html = `
      <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f1f3d">
        <div style="background:#0f1f3d;padding:24px 28px;border-radius:12px 12px 0 0;display:flex;align-items:center;gap:10px">
          <span style="font-size:1.5rem;font-weight:900;color:#fff">Shred<span style="color:#f4821f">Guys</span></span>
        </div>
        <div style="background:#f7f9fc;padding:28px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px">
          <p style="font-size:0.8rem;font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:#f4821f;margin:0 0 10px">
            📋 New Quote Request
          </p>
          <h2 style="font-size:1.3rem;font-weight:800;margin:0 0 20px;color:#0f1f3d">${name || '—'}</h2>

          <table style="width:100%;border-collapse:collapse;font-size:0.88rem">
            <tr><td style="padding:8px 0;color:#6b7280;width:40%">Email</td>
                <td style="padding:8px 0;font-weight:600"><a href="mailto:${email}" style="color:#0f1f3d">${email || '—'}</a></td></tr>
            ${phone ? `<tr><td style="padding:8px 0;color:#6b7280">Phone</td>
                <td style="padding:8px 0;font-weight:600">${phone}</td></tr>` : ''}
            ${company ? `<tr><td style="padding:8px 0;color:#6b7280">Company</td>
                <td style="padding:8px 0;font-weight:600">${company}</td></tr>` : ''}
            ${service ? `<tr><td style="padding:8px 0;color:#6b7280">Service</td>
                <td style="padding:8px 0;font-weight:600">${service}</td></tr>` : ''}
            ${volume ? `<tr><td style="padding:8px 0;color:#6b7280">Volume</td>
                <td style="padding:8px 0;font-weight:600">${volume}</td></tr>` : ''}
          </table>

          ${message ? `
          <div style="margin-top:20px;padding:14px 16px;background:#fff;border:1px solid #e5e7eb;border-radius:8px">
            <p style="font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#6b7280;margin:0 0 6px">Message</p>
            <p style="font-size:0.88rem;margin:0;line-height:1.6">${message}</p>
          </div>` : ''}

          <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:0.75rem;color:#9ca3af">
            Submitted via shredguys.co.za · ${new Date().toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' })}
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
        from: 'ShredGuys <noreply@shredguys.co.za>',
        to:   ['admin@shredguys.co.za'],
        subject,
        html,
        reply_to: email,
      }),
    });

    const result = await res.json();
    if (!res.ok) return json({ error: result.message || 'Email failed' }, 500);

    // Send confirmation email to the client
    const confirmHtml = `
      <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f1f3d">
        <div style="background:#0f1f3d;padding:24px 28px;border-radius:12px 12px 0 0">
          <span style="font-size:1.5rem;font-weight:900;color:#fff">Shred<span style="color:#f4821f">Guys</span></span>
        </div>
        <div style="background:#f7f9fc;padding:28px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px">
          <h2 style="font-size:1.2rem;font-weight:800;margin:0 0 16px;color:#0f1f3d">Thanks for reaching out, ${name || 'there'}!</h2>
          <p style="font-size:0.95rem;line-height:1.7;color:#374151;margin:0 0 16px">
            We've received your quote request and someone from our team will be in contact with you shortly.
          </p>
          <p style="font-size:0.95rem;line-height:1.7;color:#374151;margin:0 0 24px">
            In the meantime, if you have any urgent queries you can reach us at
            <a href="tel:+27813756494" style="color:#f4821f;font-weight:600">081 375 6494</a> or reply to this email.
          </p>
          <div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:18px 20px;margin-bottom:24px">
            <p style="font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#6b7280;margin:0 0 10px">Your request summary</p>
            ${service ? `<p style="font-size:0.88rem;margin:0 0 6px;color:#0f1f3d"><strong>Service:</strong> ${service}</p>` : ''}
            ${volume ? `<p style="font-size:0.88rem;margin:0 0 6px;color:#0f1f3d"><strong>Volume:</strong> ${volume}</p>` : ''}
            ${message ? `<p style="font-size:0.88rem;margin:0;color:#0f1f3d"><strong>Message:</strong> ${message}</p>` : ''}
          </div>
          <p style="font-size:0.88rem;color:#6b7280;margin:0">The ShredGuys Team &nbsp;·&nbsp; <a href="mailto:admin@shredguys.co.za" style="color:#f4821f">admin@shredguys.co.za</a></p>
        </div>
      </div>
    `;

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'ShredGuys <noreply@shredguys.co.za>',
        to:   [email],
        subject: 'We received your quote request — ShredGuys',
        html: confirmHtml,
        reply_to: 'admin@shredguys.co.za',
      }),
    });

    return json({ sent: true, id: result.id });

  } catch (err) {
    console.error('shredguys-contact error:', err);
    return json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
