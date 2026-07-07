-- ============================================================
-- BURSE PAYROLL — v11: once-off payments, staff loans, custom leave policy
-- Closes three real gaps: (1) there was no way to pay a bonus/commission
-- without it corrupting the recurring salary or being wildly over-taxed by
-- naive annualisation; (2) no loan/salary-advance tracking with a running
-- balance; (3) leave entitlements were hardcoded to BCEA minimums with no
-- per-company override. Run this in Supabase → SQL Editor AFTER
-- schema-payroll-v10-self-service-details.sql.
-- ============================================================

-- ── Once-off payments (bonus, commission, etc.) — scoped to ONE pay run,
-- never touches the employee's recurring basic_salary/allowances ─────────
create table if not exists public.payroll_run_adjustments (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid references public.payroll_runs(id) on delete cascade not null,
  staff_id      uuid references public.payroll_staff(id) on delete cascade not null,
  company_id    uuid references public.payroll_companies(id) on delete cascade not null,
  label         text not null default 'Bonus',
  amount        numeric(12,2) not null default 0,
  taxable       boolean not null default true,
  created_by    uuid references auth.users(id),
  created_at    timestamptz default now()
);
create index if not exists idx_run_adjustments_run on public.payroll_run_adjustments(run_id, staff_id);

alter table public.payroll_run_adjustments enable row level security;
create policy "run_adjustments_owner_all" on public.payroll_run_adjustments
  for all
  using (public.user_owns_company(company_id))
  with check (public.user_owns_company(company_id));

-- ── Staff loans / salary advances with a running balance ────────────────
create table if not exists public.payroll_loans (
  id                  uuid primary key default gen_random_uuid(),
  staff_id            uuid references public.payroll_staff(id) on delete cascade not null,
  company_id          uuid references public.payroll_companies(id) on delete cascade not null,
  label               text not null default 'Staff loan',
  principal           numeric(12,2) not null default 0,
  balance             numeric(12,2) not null default 0,
  monthly_installment numeric(12,2) not null default 0,
  status              text not null default 'active',   -- active | paid_off | cancelled
  created_by          uuid references auth.users(id),
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);
-- At most one active loan per employee at a time — keeps deduction logic in
-- the payroll engine unambiguous. Pay off or cancel the existing one first.
create unique index if not exists idx_loans_one_active_per_staff on public.payroll_loans(staff_id) where status = 'active';

alter table public.payroll_loans enable row level security;
create policy "loans_owner_all" on public.payroll_loans
  for all
  using (public.user_owns_company(company_id))
  with check (public.user_owns_company(company_id));

-- Ledger of each deduction taken off a loan, so the balance is always
-- reconstructable and auditable rather than just a mutated counter.
create table if not exists public.payroll_loan_repayments (
  id          uuid primary key default gen_random_uuid(),
  loan_id     uuid references public.payroll_loans(id) on delete cascade not null,
  run_id      uuid references public.payroll_runs(id) on delete cascade not null,
  amount      numeric(12,2) not null default 0,
  created_at  timestamptz default now(),
  unique (loan_id, run_id)
);

alter table public.payroll_loan_repayments enable row level security;
create policy "loan_repayments_owner_read" on public.payroll_loan_repayments
  for select
  using (loan_id in (select id from public.payroll_loans where public.user_owns_company(company_id)));

-- ── Custom leave policy per company (overrides BCEA-minimum defaults) ───
alter table public.payroll_companies add column if not exists annual_leave_days_override numeric(6,2);
alter table public.payroll_companies add column if not exists sick_leave_days_override numeric(6,2);

comment on column public.payroll_companies.annual_leave_days_override is
  'Annual leave days per cycle, if the company offers more than the BCEA minimum. Null = use BCEA default (15 for a 5-day week, 18 for 6-day).';
comment on column public.payroll_companies.sick_leave_days_override is
  'Sick leave days per 36-month cycle, if the company offers more than the BCEA minimum. Null = use BCEA default (30 for a 5-day week, 36 for 6-day).';

-- ── Payslip columns for the two new deduction types ──────────────────────
alter table public.payroll_payslips add column if not exists once_off_taxable numeric(12,2) not null default 0;
alter table public.payroll_payslips add column if not exists once_off_nontaxable numeric(12,2) not null default 0;
alter table public.payroll_payslips add column if not exists once_off_tax numeric(12,2) not null default 0;
alter table public.payroll_payslips add column if not exists loan_repayment numeric(12,2) not null default 0;

