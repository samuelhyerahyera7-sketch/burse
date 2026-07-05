import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  calculatePAYE,
  calculateUIF,
  calculateSDL,
  calculateETI,
  deductibleRetirementContribution,
  taxYearForDate,
  bceaLeaveEntitlements,
  monthlyAnnualLeaveAccrual,
} from '../_shared/tax-engine.ts';

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

    const body = await req.json();
    const { action } = body;

    // Every action operates on a company the caller must own.
    async function requireOwnedCompany(companyId: string) {
      const { data, error } = await sb
        .from('payroll_companies')
        .select('*')
        .eq('id', companyId)
        .eq('owner_id', uid)
        .maybeSingle();
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

        const results = [];
        for (const staff of staffList ?? []) {
          const ytdBefore = await fetchYtdBefore(sb, staff.id, run);
          const payslip = computePayslip(staff, run, company, annualPayrollEstimate, ytdBefore);
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

        const { error: updErr } = await sb
          .from('payroll_runs')
          .update({ status: 'finalized', finalized_at: new Date().toISOString() })
          .eq('id', run_id);
        if (updErr) throw new HttpError(updErr.message, 400);

        return json({ ok: true, payslip_count: payslips.length });
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

      case 'leave_accrue': {
        const { company_id } = body;
        await requireOwnedCompany(company_id);

        const { data: staffList } = await sb
          .from('payroll_staff')
          .select('*')
          .eq('company_id', company_id)
          .eq('active', true);

        const company = await requireOwnedCompany(company_id);
        const entitlements = bceaLeaveEntitlements(company.work_days_per_week === 6 ? 6 : 5);
        const monthlyAnnualAccrual = monthlyAnnualLeaveAccrual(company.work_days_per_week === 6 ? 6 : 5);
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
function computePayslip(staff: any, run: any, company: any, annualPayrollEstimate: number, ytdBefore: YtdBefore) {
  const freq = staff.pay_frequency || run.frequency || 'monthly';
  const periods = periodsPerYear(freq);

  const basic = Number(staff.basic_salary || 0);
  const travelTaxablePct = Number(staff.travel_allowance_taxable_pct ?? 80) / 100;
  const travelAllowance = Number(staff.travel_allowance || 0);
  const travelTaxable = travelAllowance * travelTaxablePct;
  const otherTaxableAllowance = Number(staff.other_taxable_allowance || 0);
  const otherNonTaxableAllowance = Number(staff.other_nontaxable_allowance || 0);

  const grossPay = round2(basic + travelAllowance + otherTaxableAllowance + otherNonTaxableAllowance);
  const remunerationForRetirementCap = grossPay; // greater of remuneration or taxable income; simplified to gross

  const retirementContribution = Number(staff.retirement_contribution || 0);
  const retirementDeductible = deductibleRetirementContribution(
    retirementContribution,
    remunerationForRetirementCap,
    ytdBefore.retirementDeductible,
    periods,
    run.tax_year,
  );

  const taxableIncome = round2(basic + travelTaxable + otherTaxableAllowance - retirementDeductible);

  const age = ageFromStaff(staff);
  const paye = calculatePAYE({
    periodTaxable: taxableIncome,
    periodsPerYear: periods as 12 | 26 | 52,
    age,
    taxYear: run.tax_year,
    medicalAidDependants: staff.medical_aid_dependants ?? 0,
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

  const totalDeductions = round2(paye.periodPaye + uif.employee + retirementContribution + otherDeductionsTotal);
  const netPay = round2(grossPay - totalDeductions);

  return {
    basic_salary: basic,
    travel_allowance: travelAllowance,
    other_taxable_allowance: otherTaxableAllowance,
    other_nontaxable_allowance: otherNonTaxableAllowance,
    gross_pay: grossPay,
    retirement_contribution: retirementContribution,
    retirement_deductible: retirementDeductible,
    taxable_income: taxableIncome,
    paye: paye.periodPaye,
    medical_credit: paye.medicalCredit,
    uif_employee: uif.employee,
    uif_employer: uif.employer,
    sdl_employer: sdl,
    eti_employer: eti,
    other_deductions: otherDeductionsTotal,
    other_deductions_json: otherDeductionsList,
    total_deductions: totalDeductions,
    net_pay: netPay,
    ytd_gross: round2(ytdBefore.gross + grossPay),
    ytd_taxable: round2(ytdBefore.taxable + taxableIncome),
    ytd_paye: round2(ytdBefore.paye + paye.periodPaye),
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

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
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
