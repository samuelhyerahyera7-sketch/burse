import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Daily cron: for every active bk_recurring_invoices template whose
// next_run_date has arrived, creates a draft invoice from the template
// lines, issues it (posts to the journal via the issue_invoice RPC), and
// advances next_run_date by the template's frequency. Mirrors
// auto-schedule-payroll's shape and cron-secret auth pattern.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

function toISODate(d: Date) { return d.toISOString().slice(0, 10); }

function computeNextRunDate(current: string, frequency: string) {
  const d = new Date(current + 'T00:00:00Z');
  if (frequency === 'weekly') return toISODate(new Date(d.getTime() + 7 * 86400000));
  return toISODate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const cronSecret = Deno.env.get('CRON_SECRET');
    if (cronSecret && req.headers.get('x-cron-secret') !== cronSecret) return json({ error: 'Unauthorised' }, 401);

    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const today = toISODate(new Date());

    const { data: templates } = await sb.from('bk_recurring_invoices').select('*').eq('active', true).lte('next_run_date', today);

    let created = 0;
    for (const tpl of templates ?? []) {
      const lines: Array<{ description: string; quantity: number; unit_price: number; vat_rate: number }> = tpl.lines ?? [];
      let subtotal = 0, vat = 0;
      const lineRows = lines.map((l) => {
        const lineSub = Number(l.quantity) * Number(l.unit_price);
        const lineVat = lineSub * (Number(l.vat_rate) / 100);
        subtotal += lineSub; vat += lineVat;
        return { description: l.description, quantity: l.quantity, unit_price: l.unit_price, vat_rate: l.vat_rate, line_total: lineSub + lineVat };
      });
      const total = subtotal + vat;

      const { data: inv, error: invErr } = await sb.from('bk_invoices').insert({
        company_id: tpl.company_id, customer_id: tpl.customer_id, invoice_number: `REC-${Date.now().toString().slice(-8)}`,
        customer_name: tpl.customer_name, customer_email: tpl.customer_email, issue_date: today, due_date: null,
        subtotal, vat_amount: vat, total,
      }).select().single();
      if (invErr || !inv) { console.error('recurring invoice create failed for template', tpl.id, invErr); continue; }

      await sb.from('bk_invoice_lines').insert(lineRows.map((l) => ({ ...l, invoice_id: inv.id })));

      const { error: issueErr } = await sb.rpc('issue_invoice', { p_invoice_id: inv.id });
      if (issueErr) console.error('recurring invoice issue failed for', inv.id, issueErr);

      await sb.from('bk_recurring_invoices').update({
        next_run_date: computeNextRunDate(tpl.next_run_date, tpl.frequency),
        last_generated_invoice_id: inv.id,
      }).eq('id', tpl.id);
      created++;
    }

    return json({ ok: true, invoices_created: created });
  } catch (err) {
    console.error('recurring-invoice-generator error:', err);
    return json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
