import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getXeroConnection, xeroFetch } from '../_shared/xero.ts';
import { getQuickBooksConnection, qboFetch } from '../_shared/quickbooks.ts';
import {
  calculateOnceOffPaye,
  calculateUIF,
  calculateSDL,
  calculateETI,
  deductibleRetirementContribution,
  taxYearForDate,
  bceaLeaveEntitlements,
} from '../_shared/tax-engine.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    // Two ways in: a normal user JWT (the app), or our own cron secret (the
    // auto-schedule-payroll function creating/calculating a due run on a
    // company's behalf). The cron path skips the owner check since there's
    // no user — it's only reachable with the secret, never from the browser.
    const cronSecret = Deno.env.get('CRON_SECRET');
    const isCronCall = !!cronSecret && req.headers.get('x-cron-secret') === cronSecret;

    const authHeader = req.headers.get('Authorization');
    if (!isCronCall && !authHeader) return json({ error: 'Unauthorised' }, 401);

    let uid: string | null = null;
    if (!isCronCall) {
      const sbUser = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_ANON_KEY')!,
        { global: { headers: { Authorization: authHeader! } } },
      );
      const { data: userData } = await sbUser.auth.getUser();
      if (!userData?.user) return json({ error: 'Unauthorised' }, 401);
      uid = userData.user.id;
    }

    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const body = await req.json();
    const { action } = body;

    // Every action operates on a company the caller must own — except a
    // cron call, which is already scoped to a specific company_id by the
    // scheduler and has no user to check ownership against.
    async function requireOwnedCompany(companyId: string) {
      let query = sb.from('payroll_companies').select('*').eq('id', companyId);
      if (!isCronCall) query = query.eq('owner_id', uid);
      const { data, error } = await query.maybeSingle();
      if (error || !data) throw new HttpError('Company not found or not owned by you', 404);
      return data;
    }

    switch (action) {
      case 'create_run': {
        const { company_id, period_start, period_end, pay_date, frequency } = body;
        if (!company_id || !period_start || !period_end || !pay_date) {
          return json({ error: 'company_id, period_start, period_end and pay_date are all required' }, 400);
        }
        if (isNaN(Date.parse(period_start)) || isNaN(Date.parse(period_end)) || isNaN(Date.parse(pay_date))) {
          return json({ error: 'period_start, period_end and pay_date must be valid dates' }, 400);
        }
        if (period_end < period_start) {
          return json({ error: 'period_end cannot be before period_start' }, 400);
        }
        await requireOwnedCompany(company_id);
        const tax_year = taxYearForDate(new Date(pay_date));
        const { data, error } = await sb
          .from('payroll_runs')
          .insert({ company_id, period_start, period_end, pay_date, frequency: frequency ?? 'monthly', tax_year })
          .select()
          .single();
        if (error) throw new HttpError(error.message, 400);
        return json({ run: data });
      }

      case 'calculate': {
        const { run_id } = body;
        const { data: run, error: runErr } = await sb.from('payroll_runs').select('*').eq('id', run_id).single();
        if (runErr || !run) return json({ error: 'Run not found' }, 404);
        await requireOwnedCompany(run.company_id);
        if (run.status !== 'draft') return json({ error: 'Only draft runs can be recalculated' }, 400);

        const company = await requireOwnedCompany(run.company_id);

        const { data: staffList, error: staffErr } = await sb
          .from('payroll_staff')
          .select('*')
          .eq('company_id', run.company_id)
          .eq('active', true)
          .lte('start_date', run.period_end)
          .or(`end_date.is.null,end_date.gte.${run.period_start}`);
        if (staffErr) throw new HttpError(staffErr.message, 400);

        // Estimate annual payroll for SDL exemption test: sum each staff member's
        // basic salary annualised by their own pay frequency.
        const annualPayrollEstimate = (staffList ?? []).reduce(
          (sum, s) => sum + Number(s.basic_salary || 0) * periodsPerYear(s.pay_frequency || run.frequency),
          0,
        );

        // Once-off payments (bonus/commission) added for this run only —
        // never touch the employee's recurring basic_salary/allowances.
        const { data: adjustmentRows } = await sb
          .from('payroll_run_adjustments')
          .select('*')
          .eq('run_id', run.id);
        const adjustmentsByStaff = new Map<string, { taxable: number; nonTaxable: number }>();
        for (const a of adjustmentRows ?? []) {
          const cur = adjustmentsByStaff.get(a.staff_id) ?? { taxable: 0, nonTaxable: 0 };
          if (a.taxable) cur.taxable += Number(a.amount || 0); else cur.nonTaxable += Number(a.amount || 0);
          adjustmentsByStaff.set(a.staff_id, cur);
        }

        // Active loans — this run's installment is PREVIEWED here (shown on the
        // payslip) but the balance itself is only decremented at finalize, so a
        // draft run can be recalculated freely without double-deducting.
        const { data: activeLoans } = await sb
          .from('payroll_loans')
          .select('*')
          .eq('company_id', run.company_id)
          .eq('status', 'active');
        const loanByStaff = new Map<string, { id: string; installment: number }>();
        for (const l of activeLoans ?? []) {
          loanByStaff.set(l.staff_id, { id: l.id, installment: Math.min(Number(l.monthly_installment || 0), Number(l.balance || 0)) });
        }

        // Active garnishees — like loans, this run's instalment is previewed
        // here (folded into other_deductions_json for that staff member) but
        // the balance is only decremented at finalize.
        const { data: activeGarnishees } = await sb
          .from('payroll_garnishees')
          .select('*')
          .eq('company_id', run.company_id)
          .eq('status', 'active');
        const garnisheesByStaff = new Map<string, Array<{ id: string; label: string; amount: number }>>();
        for (const g of activeGarnishees ?? []) {
          const list = garnisheesByStaff.get(g.staff_id) ?? [];
          const amount = Math.min(Number(g.monthly_amount || 0), Number(g.balance ?? Infinity));
          if (amount > 0) list.push({ id: g.id, label: `Garnishee — ${g.case_reference || 'order'}`, amount });
          garnisheesByStaff.set(g.staff_id, list);
        }

        const results = [];
        for (const staff of staffList ?? []) {
          const ytdBefore = await fetchYtdBefore(sb, staff.id, run);
          const adjustment = adjustmentsByStaff.get(staff.id) ?? { taxable: 0, nonTaxable: 0 };
          const loanDeduction = loanByStaff.get(staff.id)?.installment ?? 0;
          const garnisheeItems = garnisheesByStaff.get(staff.id) ?? [];
          const staffWithGarnishees = garnisheeItems.length
            ? { ...staff, other_deductions_json: [...(Array.isArray(staff.other_deductions_json) ? staff.other_deductions_json : []), ...garnisheeItems.map(g => ({ label: g.label, amount: g.amount }))] }
            : staff;
          const payslip = computePayslip(staffWithGarnishees, run, company, annualPayrollEstimate, ytdBefore, adjustment, loanDeduction);
          const { data: saved, error: upErr } = await sb
            .from('payroll_payslips')
            .upsert({ run_id: run.id, staff_id: staff.id, ...payslip }, { onConflict: 'run_id,staff_id' })
            .select()
            .single();
          if (upErr) throw new HttpError(upErr.message, 400);
          results.push(saved);
        }

        return json({ payslips: results });
      }

      case 'finalize': {
        const { run_id } = body;
        const { data: run, error: runErr } = await sb.from('payroll_runs').select('*').eq('id', run_id).single();
        if (runErr || !run) return json({ error: 'Run not found' }, 404);
        await requireOwnedCompany(run.company_id);
        if (run.status === 'finalized') return json({ error: 'Run already finalized' }, 400);

        const { data: payslips } = await sb.from('payroll_payslips').select('*').eq('run_id', run_id);
        if (!payslips || payslips.length === 0) return json({ error: 'Nothing to finalize — run calculate first' }, 400);

        // Loan balances only ever move on finalize (never on a recalculable
        // draft) — each payslip already carries the installment amount it
        // previewed at calculate time, so we just apply that same figure.
        for (const p of payslips) {
          if (!p.loan_repayment || Number(p.loan_repayment) <= 0) continue;
          const { data: loan } = await sb.from('payroll_loans').select('*').eq('staff_id', p.staff_id).eq('status', 'active').maybeSingle();
          if (!loan) continue;
          const { error: repayErr } = await sb.from('payroll_loan_repayments').insert({ loan_id: loan.id, run_id, amount: p.loan_repayment });
          if (repayErr) continue; // unique (loan_id, run_id) — already applied, e.g. a retried request
          const newBalance = round2(Math.max(0, Number(loan.balance) - Number(p.loan_repayment)));
          await sb.from('payroll_loans').update({
            balance: newBalance,
            status: newBalance <= 0 ? 'paid_off' : 'active',
            updated_at: new Date().toISOString(),
          }).eq('id', loan.id);
        }

        // Garnishee balances, same idea as loans: the payslip's
        // other_deductions_json entries tagged "Garnishee — <case>" were
        // computed from the active garnishee at calculate time, and its
        // balance hasn't moved since, so we recompute the same instalment
        // deterministically and apply it now.
        const { data: activeGarnisheesAtFinalize } = await sb
          .from('payroll_garnishees')
          .select('*')
          .eq('company_id', run.company_id)
          .eq('status', 'active');
        for (const p of payslips) {
          const staffGarnishees = (activeGarnisheesAtFinalize ?? []).filter((g: any) => g.staff_id === p.staff_id);
          for (const g of staffGarnishees) {
            const instalment = round2(Math.min(Number(g.monthly_amount || 0), Number(g.balance ?? Infinity)));
            if (instalment <= 0) continue;
            const { error: repayErr } = await sb.from('payroll_garnishee_repayments').insert({ garnishee_id: g.id, run_id, amount: instalment });
            if (repayErr) continue; // unique (garnishee_id, run_id) — already applied
            const newBalance = g.total_amount == null ? null : round2(Math.max(0, Number(g.balance) - instalment));
            await sb.from('payroll_garnishees').update({
              balance: newBalance,
              status: (newBalance !== null && newBalance <= 0) ? 'completed' : 'active',
              updated_at: new Date().toISOString(),
            }).eq('id', g.id);
          }
        }

        const { error: updErr } = await sb
          .from('payroll_runs')
          .update({ status: 'finalized', finalized_at: new Date().toISOString() })
          .eq('id', run_id);
        if (updErr) throw new HttpError(updErr.message, 400);

        await sb.from('payroll_audit_log').insert({
          company_id: run.company_id,
          actor_id: uid,
          action: 'payroll_approved',
          meta: { run_id, period_start: run.period_start, period_end: run.period_end, payslip_count: payslips.length },
        });

        // Best-effort — a business that hasn't opened Bookkeeping yet has no
        // chart of accounts, and that's fine; payroll finalization must never
        // fail because the sibling product hasn't been set up.
        await postPayrollJournalEntry(sb, run, payslips).catch((e) => console.error('bookkeeping auto-post skipped:', e));
        await pushXeroJournalForRun(sb, run, payslips).catch((e) => console.error('Xero auto-push skipped:', e));
        await pushQuickBooksJournalForRun(sb, run, payslips).catch((e) => console.error('QuickBooks auto-push skipped:', e));

        return json({ ok: true, payslip_count: payslips.length });
      }

      case 'push_xero_journal': {
        // Manual retry — e.g. after fixing the account map or reconnecting
        // Xero following a token error.
        const { run_id } = body;
        const { data: run, error: runErr } = await sb.from('payroll_runs').select('*').eq('id', run_id).single();
        if (runErr || !run) return json({ error: 'Run not found' }, 404);
        await requireOwnedCompany(run.company_id);
        const { data: payslips } = await sb.from('payroll_payslips').select('*').eq('run_id', run_id);
        const result = await pushXeroJournalForRun(sb, run, payslips ?? [], { force: true });
        return json(result);
      }

      case 'push_quickbooks_journal': {
        const { run_id } = body;
        const { data: run, error: runErr } = await sb.from('payroll_runs').select('*').eq('id', run_id).single();
        if (runErr || !run) return json({ error: 'Run not found' }, 404);
        await requireOwnedCompany(run.company_id);
        const { data: payslips } = await sb.from('payroll_payslips').select('*').eq('run_id', run_id);
        const result = await pushQuickBooksJournalForRun(sb, run, payslips ?? [], { force: true });
        return json(result);
      }

      case 'emp201_summary': {
        const { run_id } = body;
        const { data: run, error: runErr } = await sb.from('payroll_runs').select('*').eq('id', run_id).single();
        if (runErr || !run) return json({ error: 'Run not found' }, 404);
        const company = await requireOwnedCompany(run.company_id);

        const { data: payslips } = await sb.from('payroll_payslips').select('*').eq('run_id', run_id);
        const totals = (payslips ?? []).reduce((acc, p) => ({
          gross_remuneration: acc.gross_remuneration + Number(p.gross_pay),
          paye:               acc.paye + Number(p.paye),
          uif_employee:       acc.uif_employee + Number(p.uif_employee),
          uif_employer:       acc.uif_employer + Number(p.uif_employer),
          sdl:                acc.sdl + Number(p.sdl_employer),
          eti:                acc.eti + Number(p.eti_employer),
        }), { gross_remuneration: 0, paye: 0, uif_employee: 0, uif_employer: 0, sdl: 0, eti: 0 });

        const paye_payable = Math.max(0, totals.paye - totals.eti);
        const uif_payable = totals.uif_employee + totals.uif_employer;

        return json({
          company: company.trading_name,
          paye_reference: company.paye_reference,
          uif_reference: company.uif_reference,
          sdl_reference: company.sdl_reference,
          period_start: run.period_start,
          period_end: run.period_end,
          pay_date: run.pay_date,
          tax_year: run.tax_year,
          employee_count: (payslips ?? []).length,
          totals,
          emp201: {
            paye_payable: round2(paye_payable),
            uif_payable: round2(uif_payable),
            sdl_payable: round2(totals.sdl),
            eti_used: round2(totals.eti),
            total_payable: round2(paye_payable + uif_payable + totals.sdl),
          },
        });
      }

      case 'coid_roe': {
        // COID Return of Earnings: annual earnings per employee for the
        // Compensation Fund submission. Burse totals actual gross earnings
        // paid — it deliberately does NOT apply the annual earnings ceiling
        // published each year by the Compensation Fund, since that figure
        // changes annually and hard-coding a possibly-stale cap would be
        // worse than making the employer apply the current one themselves.
        const { company_id, tax_year } = body;
        const company = await requireOwnedCompany(company_id);
        if (!tax_year) return json({ error: 'tax_year is required' }, 400);

        const { data: runs } = await sb.from('payroll_runs').select('id').eq('company_id', company_id).eq('tax_year', tax_year).in('status', ['finalized', 'paid']);
        const runIds = (runs ?? []).map((r: any) => r.id);
        const { data: payslips } = runIds.length
          ? await sb.from('payroll_payslips').select('staff_id, gross_pay, payroll_staff(full_name, id_number)').in('run_id', runIds)
          : { data: [] as any[] };

        const byStaff = new Map<string, { name: string; id_number: string | null; gross: number }>();
        (payslips ?? []).forEach((p: any) => {
          const cur = byStaff.get(p.staff_id) || { name: p.payroll_staff?.full_name || '—', id_number: p.payroll_staff?.id_number || null, gross: 0 };
          cur.gross += Number(p.gross_pay);
          byStaff.set(p.staff_id, cur);
        });

        const employees = Array.from(byStaff.values()).map(e => ({ ...e, gross: round2(e.gross) }));
        const totalEarnings = round2(employees.reduce((s, e) => s + e.gross, 0));
        const rate = company.coid_rate_per_100 != null ? Number(company.coid_rate_per_100) : null;
        const estimatedAssessment = rate != null ? round2(totalEarnings * (rate / 100)) : null;

        return json({
          company: company.trading_name,
          coid_reference: company.coid_reference,
          tax_year,
          employees,
          total_earnings: totalEarnings,
          assessment_rate_per_100: rate,
          estimated_assessment: estimatedAssessment,
        });
      }

      case 'emp501_summary': {
        // Annual reconciliation: EMP501 checks the sum of your monthly
        // EMP201 declarations against your actual annual liability and the
        // IRP5/IT3(a) certificates issued for the tax year.
        const { company_id, tax_year } = body;
        const company = await requireOwnedCompany(company_id);
        if (!tax_year) return json({ error: 'tax_year is required' }, 400);

        const { data: runs } = await sb.from('payroll_runs').select('*').eq('company_id', company_id).eq('tax_year', tax_year).in('status', ['finalized', 'paid']).order('period_start');
        const runIds = (runs ?? []).map((r: any) => r.id);
        const { data: payslips } = runIds.length
          ? await sb.from('payroll_payslips').select('*').in('run_id', runIds)
          : { data: [] as any[] };

        const byRun = new Map<string, any>();
        (payslips ?? []).forEach((p: any) => {
          const acc = byRun.get(p.run_id) || { gross_remuneration: 0, paye: 0, uif_employee: 0, uif_employer: 0, sdl: 0, eti: 0, headcount: new Set() };
          acc.gross_remuneration += Number(p.gross_pay);
          acc.paye += Number(p.paye);
          acc.uif_employee += Number(p.uif_employee);
          acc.uif_employer += Number(p.uif_employer);
          acc.sdl += Number(p.sdl_employer);
          acc.eti += Number(p.eti_employer);
          acc.headcount.add(p.staff_id);
          byRun.set(p.run_id, acc);
        });

        const monthly = (runs ?? []).map((r: any) => {
          const t = byRun.get(r.id) || { gross_remuneration: 0, paye: 0, uif_employee: 0, uif_employer: 0, sdl: 0, eti: 0, headcount: new Set() };
          const paye_payable = Math.max(0, t.paye - t.eti);
          const uif_payable = t.uif_employee + t.uif_employer;
          return {
            period_start: r.period_start, period_end: r.period_end, pay_date: r.pay_date,
            employee_count: t.headcount.size,
            gross_remuneration: round2(t.gross_remuneration),
            paye_payable: round2(paye_payable), uif_payable: round2(uif_payable), sdl_payable: round2(t.sdl),
            total_payable: round2(paye_payable + uif_payable + t.sdl),
          };
        });

        const annual = monthly.reduce((acc: any, m: any) => ({
          gross_remuneration: acc.gross_remuneration + m.gross_remuneration,
          paye_payable: acc.paye_payable + m.paye_payable,
          uif_payable: acc.uif_payable + m.uif_payable,
          sdl_payable: acc.sdl_payable + m.sdl_payable,
          total_payable: acc.total_payable + m.total_payable,
        }), { gross_remuneration: 0, paye_payable: 0, uif_payable: 0, sdl_payable: 0, total_payable: 0 });

        const distinctStaff = new Set((payslips ?? []).map((p: any) => p.staff_id));

        return json({
          company: company.trading_name,
          paye_reference: company.paye_reference,
          uif_reference: company.uif_reference,
          sdl_reference: company.sdl_reference,
          tax_year,
          irp5_certificates_issuable: distinctStaff.size,
          monthly,
          annual: {
            gross_remuneration: round2(annual.gross_remuneration),
            paye_payable: round2(annual.paye_payable),
            uif_payable: round2(annual.uif_payable),
            sdl_payable: round2(annual.sdl_payable),
            total_payable: round2(annual.total_payable),
          },
        });
      }

      case 'leave_accrue': {
        const { company_id } = body;
        await requireOwnedCompany(company_id);

        const { data: staffList } = await sb
          .from('payroll_staff')
          .select('*')
          .eq('company_id', company_id)
          .eq('active', true);

        const company = await requireOwnedCompany(company_id);
        const bceaEntitlements = bceaLeaveEntitlements(company.work_days_per_week === 6 ? 6 : 5);
        // A company may offer MORE than the BCEA minimum via annual_leave_days_override /
        // sick_leave_days_override, but never less — the floor is enforced here too, not
        // just in the admin UI, in case a row was edited directly.
        const entitlements = {
          ...bceaEntitlements,
          annualDaysPerCycle: Math.max(bceaEntitlements.annualDaysPerCycle, Number(company.annual_leave_days_override) || 0),
          sickDaysPerCycle: Math.max(bceaEntitlements.sickDaysPerCycle, Number(company.sick_leave_days_override) || 0),
        };
        const monthlyAnnualAccrual = round2(entitlements.annualDaysPerCycle / 12);
        const today = new Date();

        const updates = [];
        for (const s of staffList ?? []) {
          const start = new Date(s.start_date);
          const monthsEmployed = monthDiff(start, today);

          // Annual leave: cycle resets every 12 months from start_date
          const annualCycleStart = cycleStart(start, today, 12);
          const monthsIntoAnnualCycle = monthDiff(annualCycleStart, today) + 1;
          const annualEntitled = Math.min(entitlements.annualDaysPerCycle, round2(monthlyAnnualAccrual * monthsIntoAnnualCycle));
          updates.push(upsertLeaveBalance(sb, s.id, 'annual', annualCycleStart, annualEntitled));

          // Sick leave: full entitlement per 36-month cycle, but only 1 day per 26 worked
          // days during the employee's first 6 months of employment.
          const sickCycleStart = cycleStart(start, today, entitlements.sickCycleMonths);
          let sickEntitled: number;
          if (monthsEmployed < 6) {
            const daysWorked = Math.floor((today.getTime() - start.getTime()) / 86400000);
            sickEntitled = round2(daysWorked / 26);
          } else {
            sickEntitled = entitlements.sickDaysPerCycle;
          }
          updates.push(upsertLeaveBalance(sb, s.id, 'sick', sickCycleStart, sickEntitled));

          // Family responsibility leave: full entitlement per 12-month cycle, only after 4 months' service
          if (monthsEmployed >= 4) {
            const frCycleStart = cycleStart(start, today, 12);
            updates.push(upsertLeaveBalance(sb, s.id, 'family_responsibility', frCycleStart, entitlements.familyResponsibilityDaysPerCycle));
          }
        }
        await Promise.all(updates);
        return json({ ok: true, staff_processed: (staffList ?? []).length });
      }

      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error('payroll-engine error:', err);
    return json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});

// ─── Payslip calculation ──────────────────────────────────────────────────

interface YtdBefore {
  gross: number;
  taxable: number;
  paye: number;
  uifEmployee: number;
  retirementDeductible: number;
}

/**
 * Sums this staff member's payslips from earlier pay dates within the same
 * tax year, so PAYE annualisation, the retirement fund annual cap, and the
 * payslip's displayed YTD figures are all consistent across periods. Runs
 * are keyed by pay_date (not period dates) since that's what determines
 * which tax year a payment falls in.
 */
// deno-lint-ignore no-explicit-any
async function fetchYtdBefore(sb: any, staffId: string, run: any): Promise<YtdBefore> {
  const { data } = await sb
    .from('payroll_payslips')
    .select('gross_pay, taxable_income, paye, uif_employee, retirement_deductible, payroll_runs!inner(pay_date, tax_year)')
    .eq('staff_id', staffId)
    .eq('payroll_runs.tax_year', run.tax_year)
    .lt('payroll_runs.pay_date', run.pay_date);

  // deno-lint-ignore no-explicit-any
  return (data ?? []).reduce((acc: YtdBefore, p: any) => ({
    gross: acc.gross + Number(p.gross_pay || 0),
    taxable: acc.taxable + Number(p.taxable_income || 0),
    paye: acc.paye + Number(p.paye || 0),
    uifEmployee: acc.uifEmployee + Number(p.uif_employee || 0),
    retirementDeductible: acc.retirementDeductible + Number(p.retirement_deductible || 0),
  }), { gross: 0, taxable: 0, paye: 0, uifEmployee: 0, retirementDeductible: 0 });
}

// deno-lint-ignore no-explicit-any
function computePayslip(
  staff: any, run: any, company: any, annualPayrollEstimate: number, ytdBefore: YtdBefore,
  adjustment: { taxable: number; nonTaxable: number } = { taxable: 0, nonTaxable: 0 },
  loanDeduction = 0,
) {
  const freq = staff.pay_frequency || run.frequency || 'monthly';
  const periods = periodsPerYear(freq);

  const basic = Number(staff.basic_salary || 0);
  const travelTaxablePct = Number(staff.travel_allowance_taxable_pct ?? 80) / 100;
  const travelAllowance = Number(staff.travel_allowance || 0);
  const travelTaxable = travelAllowance * travelTaxablePct;
  const otherTaxableAllowance = Number(staff.other_taxable_allowance || 0);
  const otherNonTaxableAllowance = Number(staff.other_nontaxable_allowance || 0);
  const onceOffTaxable = round2(adjustment.taxable);
  const onceOffNonTaxable = round2(adjustment.nonTaxable);

  const grossPay = round2(basic + travelAllowance + otherTaxableAllowance + otherNonTaxableAllowance + onceOffTaxable + onceOffNonTaxable);
  const remunerationForRetirementCap = grossPay; // greater of remuneration or taxable income; simplified to gross

  const retirementContribution = Number(staff.retirement_contribution || 0);
  const retirementDeductible = deductibleRetirementContribution(
    retirementContribution,
    remunerationForRetirementCap,
    ytdBefore.retirementDeductible,
    periods,
    run.tax_year,
  );

  // Fringe benefits (company car, low-interest loan, subsidised
  // accommodation, etc.) are itemised with an employer-entered monthly
  // taxable value — added to taxable income for PAYE, same as any other
  // taxable benefit. Non-cash, so deliberately excluded from gross_pay/
  // net_pay and from the UIF/SDL remuneration base below.
  const fringeBenefitsList: Array<{ label: string; amount: number }> = Array.isArray(staff.fringe_benefits_json)
    ? staff.fringe_benefits_json
    : [];
  const fringeBenefitsTotal = round2(fringeBenefitsList.reduce((s, f) => s + Number(f.amount || 0), 0));

  // Recurring taxable income EXCLUDES the once-off amount — it's taxed
  // separately below via the correct (non-annualising) once-off method.
  const taxableIncome = round2(basic + travelTaxable + otherTaxableAllowance + fringeBenefitsTotal - retirementDeductible);

  const age = ageFromStaff(staff);
  const onceOffPaye = calculateOnceOffPaye({
    periodTaxable: taxableIncome,
    periodsPerYear: periods as 12 | 26 | 52,
    age,
    taxYear: run.tax_year,
    medicalAidDependants: staff.medical_aid_dependants ?? 0,
    onceOffTaxable,
  });

  const remunerationForUifSdl = grossPay;
  const uif = calculateUIF(remunerationForUifSdl, run.tax_year);
  const sdl = calculateSDL(remunerationForUifSdl, annualPayrollEstimate, run.tax_year, company.sdl_exempt);

  const monthsEmployed = monthDiff(new Date(staff.start_date), new Date(run.period_end)) + 1;
  const eti = staff.is_eti_eligible
    ? calculateETI({
        monthlyRemuneration: remunerationForUifSdl,
        age,
        monthsEmployed,
        taxYear: run.tax_year,
      })
    : 0;

  const otherDeductionsList: Array<{ label: string; amount: number }> = Array.isArray(staff.other_deductions_json)
    ? staff.other_deductions_json
    : [];
  const otherDeductionsTotal = round2(otherDeductionsList.reduce((s, d) => s + Number(d.amount || 0), 0));

  const totalDeductions = round2(onceOffPaye.totalPeriodPaye + uif.employee + retirementContribution + otherDeductionsTotal + loanDeduction);
  const netPay = round2(grossPay - totalDeductions);

  return {
    basic_salary: basic,
    travel_allowance: travelAllowance,
    other_taxable_allowance: otherTaxableAllowance,
    other_nontaxable_allowance: otherNonTaxableAllowance,
    once_off_taxable: onceOffTaxable,
    once_off_nontaxable: onceOffNonTaxable,
    once_off_tax: onceOffPaye.incrementalTax,
    gross_pay: grossPay,
    retirement_contribution: retirementContribution,
    retirement_deductible: retirementDeductible,
    taxable_income: taxableIncome,
    paye: onceOffPaye.totalPeriodPaye,
    medical_credit: onceOffPaye.recurring.medicalCredit,
    uif_employee: uif.employee,
    uif_employer: uif.employer,
    sdl_employer: sdl,
    eti_employer: eti,
    other_deductions: otherDeductionsTotal,
    other_deductions_json: otherDeductionsList,
    fringe_benefits_total: fringeBenefitsTotal,
    fringe_benefits_json: fringeBenefitsList,
    loan_repayment: round2(loanDeduction),
    total_deductions: totalDeductions,
    net_pay: netPay,
    ytd_gross: round2(ytdBefore.gross + grossPay),
    ytd_taxable: round2(ytdBefore.taxable + taxableIncome),
    ytd_paye: round2(ytdBefore.paye + onceOffPaye.totalPeriodPaye),
    ytd_uif_employee: round2(ytdBefore.uifEmployee + uif.employee),
    ytd_retirement: round2(ytdBefore.retirementDeductible + retirementDeductible),
  };
}

function periodsPerYear(freq: string): number {
  if (freq === 'weekly') return 52;
  if (freq === 'fortnightly') return 26;
  return 12;
}

// deno-lint-ignore no-explicit-any
function ageFromStaff(staff: any): number {
  let dob: Date | null = staff.date_of_birth ? new Date(staff.date_of_birth) : null;
  if (!dob && staff.id_number && /^\d{6}/.test(staff.id_number)) {
    dob = dobFromSaIdNumber(staff.id_number);
  }
  if (!dob) return 30; // conservative default: no ETI/rebate edge cases assumed
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const hasHadBirthdayThisYear = (today.getMonth() > dob.getMonth())
    || (today.getMonth() === dob.getMonth() && today.getDate() >= dob.getDate());
  if (!hasHadBirthdayThisYear) age--;
  return age;
}

/** SA ID number: YYMMDD SSSS C A Z — first 6 digits are the date of birth. */
function dobFromSaIdNumber(idNumber: string): Date | null {
  const digits = idNumber.replace(/\D/g, '');
  if (digits.length < 6) return null;
  const yy = parseInt(digits.slice(0, 2), 10);
  const mm = parseInt(digits.slice(2, 4), 10);
  const dd = parseInt(digits.slice(4, 6), 10);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const currentYY = new Date().getFullYear() % 100;
  const century = yy > currentYY ? 1900 : 2000;
  return new Date(Date.UTC(century + yy, mm - 1, dd));
}

function monthDiff(from: Date, to: Date): number {
  return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
}

/** Most recent cycle-start anniversary of `start` on/before `today`, cycles of `cycleMonths` length. */
function cycleStart(start: Date, today: Date, cycleMonths: number): Date {
  const totalMonths = monthDiff(start, today);
  const cyclesElapsed = Math.floor(totalMonths / cycleMonths);
  const d = new Date(start);
  d.setMonth(d.getMonth() + cyclesElapsed * cycleMonths);
  return d;
}

// deno-lint-ignore no-explicit-any
async function upsertLeaveBalance(sb: any, staffId: string, leaveType: string, cycleStartDate: Date, entitled: number) {
  const iso = cycleStartDate.toISOString().slice(0, 10);
  const { data: existing } = await sb
    .from('payroll_leave_balances')
    .select('id, taken_days')
    .eq('staff_id', staffId)
    .eq('leave_type', leaveType)
    .eq('cycle_start', iso)
    .maybeSingle();

  if (existing) {
    return sb.from('payroll_leave_balances')
      .update({ entitled_days: entitled, updated_at: new Date().toISOString() })
      .eq('id', existing.id);
  }
  return sb.from('payroll_leave_balances')
    .insert({ staff_id: staffId, leave_type: leaveType, cycle_start: iso, entitled_days: entitled, taken_days: 0 });
}

// deno-lint-ignore no-explicit-any
async function postPayrollJournalEntry(sb: any, run: any, payslips: any[]) {
  const { data: accounts } = await sb.from('bk_accounts').select('id, code').eq('company_id', run.company_id);
  if (!accounts || accounts.length === 0) return; // Bookkeeping not set up for this company yet
  const acct = (code: string) => accounts.find((a: { code: string }) => a.code === code)?.id;

  const sum = (key: string) => round2(payslips.reduce((s, p) => s + Number(p[key] || 0), 0));
  const grossPay = sum('gross_pay');
  const uifEmployer = sum('uif_employer');
  const uifEmployee = sum('uif_employee');
  const sdlEmployer = sum('sdl_employer');
  const paye = sum('paye');
  const eti = sum('eti_employer');
  const retirement = sum('retirement_contribution');
  const otherDeductions = sum('other_deductions');
  const loanRepayment = sum('loan_repayment');
  const netPay = sum('net_pay');

  // ETI reduces what's actually owed to SARS, so it comes off both the
  // expense side and the PAYE liability side — see schema-bookkeeping-v3
  // comments for the full derivation of why this balances.
  const lines: Array<{ account_id: string; debit: number; credit: number; description: string }> = [];
  const push = (code: string, debit: number, credit: number, description: string) => {
    const id = acct(code);
    if (!id || round2(debit) === 0 && round2(credit) === 0) return;
    lines.push({ account_id: id, debit: round2(debit), credit: round2(credit), description });
  };

  push('5000', round2(grossPay - eti), 0, 'Salaries & wages');
  push('5100', uifEmployer, 0, 'Employer UIF contribution');
  push('5200', sdlEmployer, 0, 'Employer SDL contribution');
  push('2100', 0, round2(paye - eti), 'PAYE payable (net of ETI)');
  push('2200', 0, round2(uifEmployee + uifEmployer), 'UIF payable');
  push('2300', 0, sdlEmployer, 'SDL payable');
  push('2600', 0, retirement, 'Retirement fund payable');
  push('2700', 0, otherDeductions, 'Other payroll deductions payable');
  push('1200', 0, loanRepayment, 'Staff loan repayments');
  push('2500', 0, netPay, 'Net pay payable');

  if (lines.length < 2) return;
  const totalDebit = round2(lines.reduce((s, l) => s + l.debit, 0));
  const totalCredit = round2(lines.reduce((s, l) => s + l.credit, 0));
  if (totalDebit !== totalCredit) {
    console.error(`Payroll journal entry for run ${run.id} does not balance: debit ${totalDebit}, credit ${totalCredit} — skipped`);
    return;
  }

  const { data: entry, error: entryErr } = await sb.from('bk_journal_entries').insert({
    company_id: run.company_id,
    entry_date: run.pay_date,
    description: `Payroll — ${run.period_start} to ${run.period_end}`,
    source: 'payroll',
    source_id: run.id,
  }).select().single();
  if (entryErr || !entry) {
    // unique (company_id, source, source_id) — already posted, e.g. a retried finalize
    if (entryErr?.code !== '23505') console.error('Failed to post payroll journal entry:', entryErr);
    return;
  }

  const { error: lineErr } = await sb.from('bk_journal_lines').insert(lines.map(l => ({ ...l, entry_id: entry.id })));
  if (lineErr) console.error('Failed to post payroll journal lines:', lineErr);
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Pushes the same debit/credit derivation as postPayrollJournalEntry into
// the customer's own Xero organisation as a Manual Journal, instead of (in
// addition to) Burse's internal bk_journal_entries. Silently no-ops if Xero
// isn't connected for this company — payroll finalization must never fail
// because a sibling integration isn't set up. Pass { force: true } from the
// manual retry action to get a real error back instead of a silent skip.
async function pushXeroJournalForRun(sb: any, run: any, payslips: any[], opts: { force?: boolean } = {}) {
  const xero = await getXeroConnection(sb, run.company_id);
  if (!xero) {
    if (opts.force) return { pushed: false, error: 'Xero is not connected for this company.' };
    return;
  }

  const { data: existing } = await sb.from('payroll_xero_journal_pushes').select('id').eq('run_id', run.id).eq('connection_id', xero.connectionId).maybeSingle();
  if (existing) return opts.force ? { pushed: false, error: 'This run has already been pushed to Xero.' } : undefined;

  const { data: map } = await sb.from('payroll_integration_account_map').select('bk_account_code, external_account_id').eq('connection_id', xero.connectionId);
  const xeroCode = (bkCode: string) => map?.find((m: { bk_account_code: string }) => m.bk_account_code === bkCode)?.external_account_id;

  const sum = (key: string) => round2(payslips.reduce((s, p) => s + Number(p[key] || 0), 0));
  const grossPay = sum('gross_pay');
  const uifEmployer = sum('uif_employer');
  const uifEmployee = sum('uif_employee');
  const sdlEmployer = sum('sdl_employer');
  const paye = sum('paye');
  const eti = sum('eti_employer');
  const retirement = sum('retirement_contribution');
  const otherDeductions = sum('other_deductions');
  const loanRepayment = sum('loan_repayment');
  const netPay = sum('net_pay');

  // Xero ManualJournals use a single signed LineAmount per line — positive
  // for a debit, negative for a credit — rather than separate columns.
  const lines: Array<{ AccountCode: string; LineAmount: number; Description: string }> = [];
  const unmapped = new Set<string>();
  const push = (code: string, amount: number, description: string) => {
    if (round2(amount) === 0) return;
    const acctCode = xeroCode(code);
    if (!acctCode) { unmapped.add(code); return; }
    lines.push({ AccountCode: acctCode, LineAmount: round2(amount), Description: description });
  };

  push('5000', grossPay - eti, 'Salaries & wages');
  push('5100', uifEmployer, 'Employer UIF contribution');
  push('5200', sdlEmployer, 'Employer SDL contribution');
  push('2100', -round2(paye - eti), 'PAYE payable (net of ETI)');
  push('2200', -round2(uifEmployee + uifEmployer), 'UIF payable');
  push('2300', -sdlEmployer, 'SDL payable');
  push('2600', -retirement, 'Retirement fund payable');
  push('2700', -otherDeductions, 'Other payroll deductions payable');
  push('1200', -loanRepayment, 'Staff loan repayments');
  push('2500', -netPay, 'Net pay payable');

  if (unmapped.size > 0) {
    const msg = `Xero push skipped for run ${run.id} — no account mapping for: ${[...unmapped].join(', ')}. Map these in Integrations → Xero.`;
    await sb.from('payroll_integration_connections').update({ last_error: msg }).eq('id', xero.connectionId);
    return opts.force ? { pushed: false, error: msg } : undefined;
  }
  if (lines.length < 2) return opts.force ? { pushed: false, error: 'Nothing to push for this run.' } : undefined;

  const res = await xeroFetch(xero.accessToken, xero.tenantId, '/ManualJournals', {
    method: 'POST',
    body: JSON.stringify({
      ManualJournals: [{
        Narration: `Payroll — ${run.period_start} to ${run.period_end}`,
        Date: run.pay_date,
        Status: 'POSTED',
        JournalLines: lines,
      }],
    }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    const msg = `Xero rejected the journal push (${res.status}): ${errBody.slice(0, 300)}`;
    await sb.from('payroll_integration_connections').update({ status: 'error', last_error: msg }).eq('id', xero.connectionId);
    if (opts.force) return { pushed: false, error: msg };
    console.error(msg);
    return;
  }
  const data = await res.json().catch(() => ({}));
  const journalId = data?.ManualJournals?.[0]?.ManualJournalID ?? null;

  await sb.from('payroll_xero_journal_pushes').insert({ run_id: run.id, connection_id: xero.connectionId, xero_manual_journal_id: journalId });
  await sb.from('payroll_integration_connections').update({ status: 'connected', last_error: null, last_sync_at: new Date().toISOString() }).eq('id', xero.connectionId);

  return { pushed: true, xero_manual_journal_id: journalId };
}

// Same derivation as pushXeroJournalForRun, retargeted to QuickBooks Online's
// JournalEntry shape: each line needs an explicit PostingType ("Debit" or
// "Credit") and an unsigned Amount, and AccountRef.value is QuickBooks'
// internal Account.Id (not an account code/number the way Xero uses).
async function pushQuickBooksJournalForRun(sb: any, run: any, payslips: any[], opts: { force?: boolean } = {}) {
  const qbo = await getQuickBooksConnection(sb, run.company_id);
  if (!qbo) {
    if (opts.force) return { pushed: false, error: 'QuickBooks is not connected for this company.' };
    return;
  }

  const { data: existing } = await sb.from('payroll_quickbooks_journal_pushes').select('id').eq('run_id', run.id).eq('connection_id', qbo.connectionId).maybeSingle();
  if (existing) return opts.force ? { pushed: false, error: 'This run has already been pushed to QuickBooks.' } : undefined;

  const { data: map } = await sb.from('payroll_integration_account_map').select('bk_account_code, external_account_id').eq('connection_id', qbo.connectionId);
  const qboAccountId = (bkCode: string) => map?.find((m: { bk_account_code: string }) => m.bk_account_code === bkCode)?.external_account_id;

  const sum = (key: string) => round2(payslips.reduce((s, p) => s + Number(p[key] || 0), 0));
  const grossPay = sum('gross_pay');
  const uifEmployer = sum('uif_employer');
  const uifEmployee = sum('uif_employee');
  const sdlEmployer = sum('sdl_employer');
  const paye = sum('paye');
  const eti = sum('eti_employer');
  const retirement = sum('retirement_contribution');
  const otherDeductions = sum('other_deductions');
  const loanRepayment = sum('loan_repayment');
  const netPay = sum('net_pay');

  const lines: Array<{ Amount: number; DetailType: string; JournalEntryLineDetail: { PostingType: string; AccountRef: { value: string } }; Description: string }> = [];
  const unmapped = new Set<string>();
  const push = (code: string, amount: number, description: string) => {
    if (round2(amount) === 0) return;
    const acctId = qboAccountId(code);
    if (!acctId) { unmapped.add(code); return; }
    lines.push({
      Amount: Math.abs(round2(amount)), DetailType: 'JournalEntryLineDetail',
      JournalEntryLineDetail: { PostingType: amount > 0 ? 'Debit' : 'Credit', AccountRef: { value: acctId } },
      Description: description,
    });
  };

  push('5000', grossPay - eti, 'Salaries & wages');
  push('5100', uifEmployer, 'Employer UIF contribution');
  push('5200', sdlEmployer, 'Employer SDL contribution');
  push('2100', -round2(paye - eti), 'PAYE payable (net of ETI)');
  push('2200', -round2(uifEmployee + uifEmployer), 'UIF payable');
  push('2300', -sdlEmployer, 'SDL payable');
  push('2600', -retirement, 'Retirement fund payable');
  push('2700', -otherDeductions, 'Other payroll deductions payable');
  push('1200', -loanRepayment, 'Staff loan repayments');
  push('2500', -netPay, 'Net pay payable');

  if (unmapped.size > 0) {
    const msg = `QuickBooks push skipped for run ${run.id} — no account mapping for: ${[...unmapped].join(', ')}. Map these in Integrations → QuickBooks.`;
    await sb.from('payroll_integration_connections').update({ last_error: msg }).eq('id', qbo.connectionId);
    return opts.force ? { pushed: false, error: msg } : undefined;
  }
  if (lines.length < 2) return opts.force ? { pushed: false, error: 'Nothing to push for this run.' } : undefined;

  const res = await qboFetch(qbo.accessToken, qbo.realmId, '/journalentry', {
    method: 'POST',
    body: JSON.stringify({ TxnDate: run.pay_date, PrivateNote: `Payroll — ${run.period_start} to ${run.period_end}`, Line: lines }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    const msg = `QuickBooks rejected the journal push (${res.status}): ${errBody.slice(0, 300)}`;
    await sb.from('payroll_integration_connections').update({ status: 'error', last_error: msg }).eq('id', qbo.connectionId);
    if (opts.force) return { pushed: false, error: msg };
    console.error(msg);
    return;
  }
  const data = await res.json().catch(() => ({}));
  const journalId = data?.JournalEntry?.Id ?? null;

  await sb.from('payroll_quickbooks_journal_pushes').insert({ run_id: run.id, connection_id: qbo.connectionId, qbo_journal_entry_id: journalId });
  await sb.from('payroll_integration_connections').update({ status: 'connected', last_error: null, last_sync_at: new Date().toISOString() }).eq('id', qbo.connectionId);

  return { pushed: true, qbo_journal_entry_id: journalId };
}

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
