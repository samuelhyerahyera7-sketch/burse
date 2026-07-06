// ============================================================================
// SOUTH AFRICAN PAYROLL TAX ENGINE
// Single source of truth for PAYE, UIF, SDL, ETI and BCEA leave calculations.
// Used server-side only (payroll-engine edge function) so there is exactly
// one place where statutory money math happens.
//
// Tax tables are versioned by tax year (1 Mar – 28/29 Feb) so future years
// can be added by inserting a new TAX_TABLES entry — no code changes needed.
// ============================================================================

export interface TaxBracket {
  /** Lower bound of this bracket (taxable income) */
  from: number;
  /** Cumulative tax already owed at `from` */
  base: number;
  /** Marginal rate applied to the amount above `from` */
  rate: number;
}

export interface EtiBand {
  /** Upper bound (exclusive) of monthly remuneration this band applies to, null = no upper bound */
  upTo: number | null;
  /** 'percent' bands compute rate * remuneration; 'flat' bands return a fixed amount;
   *  'taper' bands compute flat - (rate * (remuneration - taperFrom)) */
  kind: 'percent' | 'flat' | 'taper';
  rate?: number;
  amount?: number;
  taperFrom?: number;
}

export interface TaxTable {
  taxYear: string;              // e.g. "2025/2026"
  validFrom: string;            // ISO date, 1 March
  validTo: string;              // ISO date, 28/29 Feb
  brackets: TaxBracket[];
  rebates: { primary: number; secondary: number; tertiary: number };
  thresholds: { under65: number; from65to74: number; from75: number };
  uifMonthlyCeiling: number;    // remuneration ceiling for UIF contribution purposes
  uifRate: number;              // employee rate (employer matches)
  sdlRate: number;              // % of leviable payroll
  sdlAnnualPayrollExemption: number; // employers under this annual payroll are SDL-exempt
  medicalCreditPrincipal: number;    // monthly tax credit: main member
  medicalCreditDependant: number;    // monthly tax credit: 1st dependant
  medicalCreditAdditional: number;   // monthly tax credit: each further dependant
  etiMinRemuneration: number;   // below this, ETI does not apply (must be >= sectoral/NMW equivalent)
  etiMaxRemuneration: number;   // at/above this, ETI = 0
  etiBands: EtiBand[];
  retirementDeductionCapPercent: number; // 27.5%
  retirementDeductionAnnualCap: number;  // R350,000
  /** true if these figures are provisional (SARS has not yet gazetted final rates for this year) */
  provisional?: boolean;
}

// ── 2025/2026 tax year (1 Mar 2025 – 28 Feb 2026) — confirmed SARS Budget 2025 rates ──
const TAX_2025_2026: TaxTable = {
  taxYear: '2025/2026',
  validFrom: '2025-03-01',
  validTo: '2026-02-28',
  brackets: [
    { from: 0,        base: 0,       rate: 0.18 },
    { from: 237101,   base: 42678,   rate: 0.26 },
    { from: 370501,   base: 77362,   rate: 0.31 },
    { from: 512801,   base: 121475,  rate: 0.36 },
    { from: 673001,   base: 179147,  rate: 0.39 },
    { from: 857901,   base: 251258,  rate: 0.41 },
    { from: 1817001,  base: 644489,  rate: 0.45 },
  ],
  rebates: { primary: 17235, secondary: 9444, tertiary: 3145 },
  thresholds: { under65: 95750, from65to74: 148217, from75: 165689 },
  uifMonthlyCeiling: 17712,
  uifRate: 0.01,
  sdlRate: 0.01,
  sdlAnnualPayrollExemption: 500000,
  medicalCreditPrincipal: 364,
  medicalCreditDependant: 364,
  medicalCreditAdditional: 246,
  // ETI thresholds increased with effect from 1 April 2025 (SARS: "Employment Tax
  // Incentive (ETI) changes with effect from 1 April 2025" — qualifying remuneration
  // ceiling R6,500 -> R7,500; R1,500 flat band widened from R2,000-R4,500 to R2,500-R5,500).
  // Applied for the whole 2025/2026 tax year below since this engine only carries one
  // ETI table per tax year and the new figures cover the vast majority of the year.
  etiMinRemuneration: 0,
  etiMaxRemuneration: 7500,
  etiBands: [
    { upTo: 2500,  kind: 'percent', rate: 0.60 },
    { upTo: 5500,  kind: 'flat',    amount: 1500 },
    { upTo: 7500,  kind: 'taper',   amount: 1500, rate: 0.75, taperFrom: 5500 },
  ],
  retirementDeductionCapPercent: 0.275,
  retirementDeductionAnnualCap: 350000,
};

// ── 2026/2027 tax year (1 Mar 2026 – 28 Feb 2027) — confirmed Budget 2026 rates ──
// Source: 2026 Budget Speech (25 Feb 2026) — 3.4% inflationary bracket/rebate
// adjustment, and the SARS Budget 2026 tax guide. UIF ceiling, SDL threshold and
// ETI parameters carried forward unchanged (no change announced for 2026/2027).
const TAX_2026_2027: TaxTable = {
  taxYear: '2026/2027',
  validFrom: '2026-03-01',
  validTo: '2027-02-28',
  brackets: [
    { from: 0,        base: 0,       rate: 0.18 },
    { from: 245101,   base: 44118,   rate: 0.26 },
    { from: 383101,   base: 79998,   rate: 0.31 },
    { from: 530201,   base: 125599,  rate: 0.36 },
    { from: 695801,   base: 185215,  rate: 0.39 },
    { from: 887001,   base: 239783,  rate: 0.41 },
    { from: 1878601,  base: 646339,  rate: 0.45 },
  ],
  rebates: { primary: 17820, secondary: 9765, tertiary: 3249 },
  thresholds: { under65: 99000, from65to74: 153250, from75: 171300 },
  uifMonthlyCeiling: 17712,
  uifRate: 0.01,
  sdlRate: 0.01,
  sdlAnnualPayrollExemption: 500000,
  medicalCreditPrincipal: 376,
  medicalCreditDependant: 376,
  medicalCreditAdditional: 254,
  etiMinRemuneration: 0,
  etiMaxRemuneration: 7500,
  etiBands: [
    { upTo: 2500,  kind: 'percent', rate: 0.60 },
    { upTo: 5500,  kind: 'flat',    amount: 1500 },
    { upTo: 7500,  kind: 'taper',   amount: 1500, rate: 0.75, taperFrom: 5500 },
  ],
  retirementDeductionCapPercent: 0.275,
  retirementDeductionAnnualCap: 350000,
};

export const TAX_TABLES: Record<string, TaxTable> = {
  '2025/2026': TAX_2025_2026,
  '2026/2027': TAX_2026_2027,
};

export function getTaxTable(taxYear: string): TaxTable {
  const table = TAX_TABLES[taxYear];
  if (!table) throw new Error(`No tax table configured for tax year ${taxYear}`);
  return table;
}

/** Which SA tax year a given pay date falls in, e.g. 2026-07-05 -> "2026/2027" */
export function taxYearForDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth(); // 0 = Jan
  // Tax year starts 1 March. Jan/Feb belong to the tax year that started the previous March.
  const startYear = m >= 2 ? y : y - 1;
  return `${startYear}/${startYear + 1}`;
}

export type AgeBand = 'under65' | '65to74' | 'from75';

export function ageBand(age: number): AgeBand {
  if (age >= 75) return 'from75';
  if (age >= 65) return '65to74';
  return 'under65';
}

/** Annual tax payable before rebates, per the bracket table. */
export function annualTaxBeforeRebates(annualTaxable: number, table: TaxTable): number {
  if (annualTaxable <= 0) return 0;
  let bracket = table.brackets[0];
  for (const b of table.brackets) {
    if (annualTaxable >= b.from) bracket = b; else break;
  }
  return bracket.base + (annualTaxable - bracket.from) * bracket.rate;
}

/** Total annual rebate for the taxpayer's age. */
export function annualRebate(age: number, table: TaxTable): number {
  const band = ageBand(age);
  let rebate = table.rebates.primary;
  if (band === '65to74' || band === 'from75') rebate += table.rebates.secondary;
  if (band === 'from75') rebate += table.rebates.tertiary;
  return rebate;
}

export interface PayeInput {
  /** Taxable remuneration for THIS pay period (after retirement fund deduction, before PAYE) */
  periodTaxable: number;
  /** Number of pay periods per year: 12 monthly, 26 fortnightly, 52 weekly */
  periodsPerYear: 12 | 26 | 52;
  age: number;
  taxYear: string;
  medicalAidDependants?: number; // 0 = no medical aid; 1 = principal member only; 2 = +1 dependant, etc.
}

export interface PayeResult {
  annualisedTaxable: number;
  annualTaxBeforeRebate: number;
  rebate: number;
  annualTaxAfterRebate: number;
  medicalCredit: number;
  periodPaye: number;
  taxThreshold: number;
  belowThreshold: boolean;
}

/**
 * Standard SARS "annualisation" method used by virtually all SA payroll
 * systems for regular period payments: annualise this period's taxable
 * income, tax it on the annual table, subtract rebates and the medical
 * schemes fees tax credit, then divide back down to a period amount.
 */
export function calculatePAYE(input: PayeInput): PayeResult {
  const table = getTaxTable(input.taxYear);
  const annualisedTaxable = Math.max(0, input.periodTaxable) * input.periodsPerYear;
  const threshold = table.thresholds[input.age >= 75 ? 'from75' : input.age >= 65 ? 'from65to74' : 'under65'];

  const annualTaxBeforeRebate = annualTaxBeforeRebates(annualisedTaxable, table);
  const rebate = annualRebate(input.age, table);
  let annualTaxAfterRebate = Math.max(0, annualTaxBeforeRebate - rebate);

  if (annualisedTaxable <= threshold) annualTaxAfterRebate = 0;

  const dependants = input.medicalAidDependants ?? 0;
  let annualMedicalCredit = 0;
  if (dependants >= 1) annualMedicalCredit += table.medicalCreditPrincipal * 12;
  if (dependants >= 2) annualMedicalCredit += table.medicalCreditDependant * 12;
  if (dependants >= 3) annualMedicalCredit += table.medicalCreditAdditional * (dependants - 2) * 12;

  const annualTaxAfterCredit = Math.max(0, annualTaxAfterRebate - annualMedicalCredit);
  const periodPaye = annualTaxAfterCredit / input.periodsPerYear;

  return {
    annualisedTaxable,
    annualTaxBeforeRebate: round2(annualTaxBeforeRebate),
    rebate,
    annualTaxAfterRebate: round2(annualTaxAfterRebate),
    medicalCredit: round2(annualMedicalCredit / input.periodsPerYear),
    periodPaye: round2(periodPaye),
    taxThreshold: threshold,
    belowThreshold: annualisedTaxable <= threshold,
  };
}

export interface UifResult {
  employee: number;
  employer: number;
  cappedRemuneration: number;
}

/** UIF: 1% employee + 1% employer, capped at the monthly remuneration ceiling. */
export function calculateUIF(monthlyRemuneration: number, taxYear: string): UifResult {
  const table = getTaxTable(taxYear);
  const cappedRemuneration = Math.min(Math.max(0, monthlyRemuneration), table.uifMonthlyCeiling);
  const contribution = round2(cappedRemuneration * table.uifRate);
  return { employee: contribution, employer: contribution, cappedRemuneration };
}

/** SDL: 1% of leviable payroll, only if employer's annual payroll exceeds the exemption threshold. */
export function calculateSDL(monthlyRemuneration: number, annualPayrollEstimate: number, taxYear: string, exempt = false): number {
  if (exempt) return 0;
  const table = getTaxTable(taxYear);
  if (annualPayrollEstimate <= table.sdlAnnualPayrollExemption) return 0;
  return round2(Math.max(0, monthlyRemuneration) * table.sdlRate);
}

export interface EtiInput {
  monthlyRemuneration: number;
  age: number;
  /** Number of months (1-based) this employee has been employed by this employer, cumulative */
  monthsEmployed: number;
  /** Actual days worked this month, for pro-rating when employed less than a full month */
  daysWorkedRatio?: number; // 0-1, defaults to 1
  isSpecialEconomicZone?: boolean;
  taxYear: string;
}

/** Employment Tax Incentive — reduces the employer's PAYE liability, does not change the employee's payslip. */
export function calculateETI(input: EtiInput): number {
  const table = getTaxTable(input.taxYear);
  const { monthlyRemuneration, age, monthsEmployed } = input;

  if (!input.isSpecialEconomicZone && (age < 18 || age > 29)) return 0;
  if (monthsEmployed > 24) return 0;
  if (monthlyRemuneration < table.etiMinRemuneration || monthlyRemuneration >= table.etiMaxRemuneration) return 0;
  if (monthlyRemuneration <= 0) return 0;

  const isFirstYear = monthsEmployed <= 12;
  let value = 0;
  for (const band of table.etiBands) {
    if (band.upTo === null || monthlyRemuneration <= band.upTo) {
      if (band.kind === 'percent') value = monthlyRemuneration * (band.rate ?? 0);
      else if (band.kind === 'flat') value = band.amount ?? 0;
      else if (band.kind === 'taper') value = (band.amount ?? 0) - (band.rate ?? 0) * (monthlyRemuneration - (band.taperFrom ?? 0));
      break;
    }
  }
  if (!isFirstYear) value = value / 2; // second 12 months = half the first-year value

  const ratio = input.daysWorkedRatio ?? 1;
  return round2(Math.max(0, value) * ratio);
}

/** Retirement fund contribution deductible for PAYE purposes, capped at 27.5% of remuneration and R350,000/year. */
export function deductibleRetirementContribution(
  periodContribution: number,
  periodRemuneration: number,
  ytdDeductedBeforeThisPeriod: number,
  periodsPerYear: number,
  taxYear: string,
): number {
  const table = getTaxTable(taxYear);
  const percentCap = periodRemuneration * table.retirementDeductionCapPercent;
  const remainingAnnualCap = Math.max(0, table.retirementDeductionAnnualCap - ytdDeductedBeforeThisPeriod);
  const periodAnnualCapShare = remainingAnnualCap; // apply remaining cap immediately, don't spread
  return round2(Math.max(0, Math.min(periodContribution, percentCap, periodAnnualCapShare)));
}

// ── BCEA leave ───────────────────────────────────────────────────────────

export interface LeaveEntitlements {
  annualDaysPerCycle: number;
  sickDaysPerCycle: number;   // per 36-month cycle
  sickCycleMonths: number;
  familyResponsibilityDaysPerCycle: number; // per 12-month cycle, after 4 months' service
}

/** BCEA minimums. `workDaysPerWeek` is typically 5 or 6. */
export function bceaLeaveEntitlements(workDaysPerWeek: 5 | 6): LeaveEntitlements {
  return {
    annualDaysPerCycle: workDaysPerWeek === 6 ? 18 : 15, // 21 consecutive days converted to working days
    sickDaysPerCycle: workDaysPerWeek === 6 ? 36 : 30,
    sickCycleMonths: 36,
    familyResponsibilityDaysPerCycle: 3,
  };
}

/** Annual leave accrues at entitlement/12 per completed month of service. */
export function monthlyAnnualLeaveAccrual(workDaysPerWeek: 5 | 6): number {
  return round2(bceaLeaveEntitlements(workDaysPerWeek).annualDaysPerCycle / 12);
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
