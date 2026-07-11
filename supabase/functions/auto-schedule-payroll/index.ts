import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Daily cron: for every company with auto_run_payroll enabled, works out
// the next pay period from its last run's cadence, and — once within
// auto_run_days_before of that pay date — creates and calculates a draft
// run automatically (mirroring QuickBooks "Auto Payroll"). It never
// auto-finalizes: the owner always reviews and approves a real payroll
// run themselves, this just saves them the "create run" click.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

function esc(s: unknown) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c as string]!)); }
function toISODate(d: Date) { return d.toISOString().slice(0, 10); }
function endOfMonthUTC(d: Date) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)); }

function computeNextPeriod(lastRun: { period_end: string; pay_date: string; frequency: string }) {
  const offsetDays = Math.round((new Date(lastRun.pay_date + 'T00:00:00Z').getTime() - new Date(lastRun.period_end + 'T00:00:00Z').getTime()) / 86400000);
  const lastEnd = new Date(lastRun.period_end + 'T00:00:00Z');

  if (lastRun.frequency === 'monthly') {
    const nextStart = new Date(Date.UTC(lastEnd.getUTCFullYear(), lastEnd.getUTCMonth() + 1, 1));
    const nextEnd = endOfMonthUTC(nextStart);
    const payDate = new Date(nextEnd.getTime() + offsetDays * 86400000);
    return { period_start: toISODate(nextStart), period_end: toISODate(nextEnd), pay_date: toISODate(payDate) };
  }
  const periodDays = lastRun.frequency === 'fortnightly' ? 14 : 7;
  const nextStart = new Date(lastEnd.getTime() + 86400000);
  const nextEnd = new Date(nextStart.getTime() + (periodDays - 1) * 86400000);
  const payDate = new Date(nextEnd.getTime() + offsetDays * 86400000);
  return { period_start: toISODate(nextStart), period_end: toISODate(nextEnd), pay_date: toISODate(payDate) };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const cronSecret = Deno.env.get('CRON_SECRET');
    if (cronSecret && req.headers.get('x-cron-secret') !== cronSecret) return json({ error: 'Unauthorised' }, 401);

    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const resendKey = Deno.env.get('RESEND_API_KEY');
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;

    const today = toISODate(new Date());
    const { data: companies } = await sb.from('payroll_companies').select('id, trading_name, owner_id, auto_run_days_before').eq('auto_run_payroll', true);

    let created = 0;
    for (const company of companies ?? []) {
      const { data: lastRun } = await sb.from('payroll_runs').select('*').eq('company_id', company.id).order('period_end', { ascending: false }).limit(1).maybeSingle();
      if (!lastRun) continue; // needs at least one manual run to learn the cadence

      const next = computeNextPeriod(lastRun as any);
      const daysUntilPay = Math.round((new Date(next.pay_date + 'T00:00:00Z').getTime() - new Date(today + 'T00:00:00Z').getTime()) / 86400000);
      if (daysUntilPay > (company.auto_run_days_before ?? 5)) continue;
      if (daysUntilPay < 0) continue; // pay date already passed and nobody ran it manually — don't silently backfill

      const { data: existing } = await sb.from('payroll_runs').select('id').eq('company_id', company.id).eq('period_start', next.period_start).eq('period_end', next.period_end).maybeSingle();
      if (existing) continue;

      const createRes = await fetch(`${supabaseUrl}/functions/v1/payroll-engine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-cron-secret': cronSecret ?? '' },
        body: JSON.stringify({ action: 'create_run', company_id: company.id, ...next, frequency: lastRun.frequency }),
      });
      const createData = await createRes.json();
      if (!createRes.ok) { console.error('auto create_run failed for', company.id, createData); continue; }
      const runId = createData.run.id;

      const calcRes = await fetch(`${supabaseUrl}/functions/v1/payroll-engine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-cron-secret': cronSecret ?? '' },
        body: JSON.stringify({ action: 'calculate', run_id: runId }),
      });
      if (!calcRes.ok) { console.error('auto calculate failed for', company.id, await calcRes.text()); continue; }

      await sb.from('payroll_audit_log').insert({ company_id: company.id, actor_id: null, action: 'payroll_auto_created', meta: { run_id: runId, period_start: next.period_start, period_end: next.period_end } });
      created++;

      if (resendKey) {
        const { data: owner } = await sb.auth.admin.getUserById(company.owner_id);
        const ownerEmail = owner?.user?.email;
        if (ownerEmail) {
          const html = `
            <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0e1c40">
              <div style="background:#0e1c40;padding:24px 28px;border-radius:12px 12px 0 0">
                <span style="font-size:1.5rem;font-weight:900;letter-spacing:-0.03em"><span style="color:#2ab3b3">B</span><span style="color:#fff">urse</span></span>
              </div>
              <div style="background:#f8f9fb;padding:28px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px">
                <h2 style="font-size:1.15rem;font-weight:800;margin:0 0 14px">Your pay run is ready to review</h2>
                <p style="font-size:0.9rem;line-height:1.6">A draft pay run for <strong>${esc(next.period_start)} – ${esc(next.period_end)}</strong> (pay date ${esc(next.pay_date)}) was automatically created and calculated for ${esc(company.trading_name)}. Nothing has been paid — review the figures and approve it when you're ready.</p>
                <a href="https://burse.co.za/payroll-admin" style="display:inline-block;margin-top:16px;background:#0e1c40;color:#fff;padding:11px 22px;border-radius:8px;font-weight:700;text-decoration:none;font-size:0.85rem">Review Pay Run</a>
              </div>
            </div>`;
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: 'Burse Payroll <notifications@burse.co.za>', to: [ownerEmail], subject: `Pay run ready to review — ${company.trading_name}`, html }),
          }).catch(() => {});
        }
      }
    }

    return json({ ok: true, runs_created: created });
  } catch (err) {
    console.error('auto-schedule-payroll error:', err);
    return json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
