// Run with: deno test supabase/functions/_shared/tax-engine.test.ts
// Regression tests for the SA statutory tax engine. These pin down known-correct
// figures for the confirmed 2025/2026 and 2026/2027 tax tables so a bad edit to
// tax-engine.ts (a misplaced bracket, a wrong rebate, an ETI band off by one)
// fails a test instead of silently misdeducting a real payslip.

import { assertEquals, assertAlmostEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  calculatePAYE,
  calculateUIF,
  calculateSDL,
  calculateETI,
  taxYearForDate,
  ageBand,
  annualRebate,
  monthlyAnnualLeaveAccrual,
  bceaLeaveEntitlements,
  getTaxTable,
} from "./tax-engine.ts";

// ── taxYearForDate ───────────────────────────────────────────────────────
Deno.test("taxYearForDate maps calendar dates to the correct SA tax year", () => {
  assertEquals(taxYearForDate(new Date("2025-03-01")), "2025/2026");
  assertEquals(taxYearForDate(new Date("2026-02-28")), "2025/2026");
  assertEquals(taxYearForDate(new Date("2026-03-01")), "2026/2027");
  assertEquals(taxYearForDate(new Date("2026-07-06")), "2026/2027"); // today
  assertEquals(taxYearForDate(new Date("2027-02-28")), "2026/2027");
});

// ── ageBand / rebates ────────────────────────────────────────────────────
Deno.test("ageBand classifies taxpayer age bands correctly", () => {
  assertEquals(ageBand(30), "under65");
  assertEquals(ageBand(65), "65to74");
  assertEquals(ageBand(74), "65to74");
  assertEquals(ageBand(75), "from75");
});

Deno.test("annualRebate stacks primary + secondary + tertiary correctly for 2026/2027", () => {
  const table = getTaxTable("2026/2027");
  assertEquals(annualRebate(30, table), 17820);
  assertEquals(annualRebate(65, table), 17820 + 9765);
  assertEquals(annualRebate(75, table), 17820 + 9765 + 3249);
});

// ── PAYE — 2025/2026 ─────────────────────────────────────────────────────
Deno.test("PAYE: below the tax threshold pays nothing (2025/2026)", () => {
  const r = calculatePAYE({ periodTaxable: 7000, periodsPerYear: 12, age: 30, taxYear: "2025/2026" });
  assertEquals(r.belowThreshold, true);
  assertEquals(r.periodPaye, 0);
});

Deno.test("PAYE: R30,000/month under-65, no medical aid (2025/2026)", () => {
  // Annualised: 360,000. Bracket: 237,101-370,500 @ 26%, base 42,678.
  // Tax before rebate = 42,678 + (360,000-237,100)*0.26 = 42,678 + 31,954 = 74,632
  // After primary rebate 17,235 -> 57,397. /12 = 4,783.083...
  const r = calculatePAYE({ periodTaxable: 30000, periodsPerYear: 12, age: 30, taxYear: "2025/2026" });
  assertEquals(r.annualisedTaxable, 360000);
  assertAlmostEquals(r.annualTaxBeforeRebate, 74632, 1);
  assertAlmostEquals(r.annualTaxAfterRebate, 57397, 1);
  assertAlmostEquals(r.periodPaye, 4783.08, 0.05);
});

Deno.test("PAYE: medical aid tax credit reduces liability (2025/2026)", () => {
  const withoutMA = calculatePAYE({ periodTaxable: 30000, periodsPerYear: 12, age: 30, taxYear: "2025/2026" });
  const withMA = calculatePAYE({ periodTaxable: 30000, periodsPerYear: 12, age: 30, taxYear: "2025/2026", medicalAidDependants: 2 });
  // 2 members (principal + 1 dependant) = (364 + 364) * 12 = 8,736/yr = 728/month credit
  assertAlmostEquals(withoutMA.periodPaye - withMA.periodPaye, 728, 0.05);
});

Deno.test("PAYE: never goes negative even with large medical credit", () => {
  const r = calculatePAYE({ periodTaxable: 8500, periodsPerYear: 12, age: 30, taxYear: "2025/2026", medicalAidDependants: 5 });
  assertEquals(r.periodPaye, 0);
});

// ── PAYE — 2026/2027 (confirmed Budget 2026 figures) ────────────────────
Deno.test("PAYE: tax-free threshold is R99,000/year for under-65 (2026/2027)", () => {
  const table = getTaxTable("2026/2027");
  assertEquals(table.thresholds.under65, 99000);
  const r = calculatePAYE({ periodTaxable: 99000 / 12, periodsPerYear: 12, age: 30, taxYear: "2026/2027" });
  assertEquals(r.belowThreshold, true);
  assertEquals(r.periodPaye, 0);
});

Deno.test("PAYE: R50,000/month under-65, no medical aid (2026/2027)", () => {
  // Annualised: 600,000, falls in bracket 530,201-695,800 @ 36%, base 125,599
  // Tax before rebate = 125,599 + (600,000-530,200)*0.36 = 125,599 + 25,128 = 150,727
  // After primary rebate 17,820 -> 132,907
  const r = calculatePAYE({ periodTaxable: 50000, periodsPerYear: 12, age: 30, taxYear: "2026/2027" });
  assertEquals(r.annualisedTaxable, 600000);
  assertAlmostEquals(r.annualTaxBeforeRebate, 150727, 1);
  assertAlmostEquals(r.annualTaxAfterRebate, 132907, 1);
});

Deno.test("PAYE: top marginal bracket applies above R1,878,600 (2026/2027)", () => {
  const table = getTaxTable("2026/2027");
  const top = table.brackets[table.brackets.length - 1];
  assertEquals(top.from, 1878601);
  assertEquals(top.rate, 0.45);
});

// ── UIF ──────────────────────────────────────────────────────────────────
Deno.test("UIF: 1%/1% below the ceiling", () => {
  const r = calculateUIF(10000, "2025/2026");
  assertEquals(r.employee, 100);
  assertEquals(r.employer, 100);
  assertEquals(r.cappedRemuneration, 10000);
});

Deno.test("UIF: contribution caps at the R17,712 monthly ceiling", () => {
  const r = calculateUIF(50000, "2026/2027");
  assertEquals(r.cappedRemuneration, 17712);
  assertEquals(r.employee, 177.12);
  assertEquals(r.employer, 177.12);
});

Deno.test("UIF: negative/zero remuneration contributes nothing", () => {
  const r = calculateUIF(-500, "2025/2026");
  assertEquals(r.employee, 0);
  assertEquals(r.cappedRemuneration, 0);
});

// ── SDL ──────────────────────────────────────────────────────────────────
Deno.test("SDL: exempt when annual payroll is at/below R500,000", () => {
  assertEquals(calculateSDL(20000, 400000, "2025/2026"), 0);
  assertEquals(calculateSDL(20000, 500000, "2025/2026"), 0);
});

Deno.test("SDL: 1% of monthly remuneration once payroll exceeds R500,000", () => {
  assertEquals(calculateSDL(20000, 600000, "2025/2026"), 200);
});

Deno.test("SDL: explicit exempt flag overrides payroll size", () => {
  assertEquals(calculateSDL(20000, 5000000, "2025/2026", true), 0);
});

// ── ETI (post 1 April 2025 thresholds, carried into 2026/2027) ───────────
Deno.test("ETI: nil outside the 18-29 age band", () => {
  assertEquals(calculateETI({ monthlyRemuneration: 4000, age: 17, monthsEmployed: 1, taxYear: "2026/2027" }), 0);
  assertEquals(calculateETI({ monthlyRemuneration: 4000, age: 30, monthsEmployed: 1, taxYear: "2026/2027" }), 0);
});

Deno.test("ETI: nil at/above the R7,500 qualifying remuneration ceiling", () => {
  assertEquals(calculateETI({ monthlyRemuneration: 7500, age: 25, monthsEmployed: 1, taxYear: "2026/2027" }), 0);
  assertEquals(calculateETI({ monthlyRemuneration: 9000, age: 25, monthsEmployed: 1, taxYear: "2026/2027" }), 0);
});

Deno.test("ETI: 60% of remuneration below R2,500 in month 1", () => {
  const r = calculateETI({ monthlyRemuneration: 2000, age: 25, monthsEmployed: 1, taxYear: "2026/2027" });
  assertEquals(r, 1200); // 2000 * 0.60
});

Deno.test("ETI: flat R1,500 max between R2,500 and R5,500 in months 1-12", () => {
  assertEquals(calculateETI({ monthlyRemuneration: 3000, age: 25, monthsEmployed: 1, taxYear: "2026/2027" }), 1500);
  assertEquals(calculateETI({ monthlyRemuneration: 5500, age: 25, monthsEmployed: 12, taxYear: "2026/2027" }), 1500);
});

Deno.test("ETI: tapers to zero between R5,500 and R7,500 in months 1-12", () => {
  const r = calculateETI({ monthlyRemuneration: 6500, age: 25, monthsEmployed: 6, taxYear: "2026/2027" });
  // 1500 - 0.75*(6500-5500) = 1500 - 750 = 750
  assertEquals(r, 750);
});

Deno.test("ETI: halves in months 13-24", () => {
  const firstYear = calculateETI({ monthlyRemuneration: 3000, age: 25, monthsEmployed: 6, taxYear: "2026/2027" });
  const secondYear = calculateETI({ monthlyRemuneration: 3000, age: 25, monthsEmployed: 18, taxYear: "2026/2027" });
  assertEquals(secondYear, firstYear / 2);
});

Deno.test("ETI: nil after 24 months employed", () => {
  assertEquals(calculateETI({ monthlyRemuneration: 3000, age: 25, monthsEmployed: 25, taxYear: "2026/2027" }), 0);
});

Deno.test("ETI: pro-rates for partial days worked", () => {
  const full = calculateETI({ monthlyRemuneration: 3000, age: 25, monthsEmployed: 1, taxYear: "2026/2027" });
  const half = calculateETI({ monthlyRemuneration: 3000, age: 25, monthsEmployed: 1, taxYear: "2026/2027", daysWorkedRatio: 0.5 });
  assertEquals(half, round2(full * 0.5));
});

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ── BCEA leave ───────────────────────────────────────────────────────────
Deno.test("BCEA: 5-day week gets 15 annual leave days, 6-day week gets 18", () => {
  assertEquals(bceaLeaveEntitlements(5).annualDaysPerCycle, 15);
  assertEquals(bceaLeaveEntitlements(6).annualDaysPerCycle, 18);
});

Deno.test("BCEA: sick leave is 30 days per 36-month cycle for a 5-day week", () => {
  const e = bceaLeaveEntitlements(5);
  assertEquals(e.sickDaysPerCycle, 30);
  assertEquals(e.sickCycleMonths, 36);
});

Deno.test("BCEA: monthly annual leave accrual is entitlement/12", () => {
  assertAlmostEquals(monthlyAnnualLeaveAccrual(5), 15 / 12, 0.001);
  assertAlmostEquals(monthlyAnnualLeaveAccrual(6), 18 / 12, 0.001);
});
