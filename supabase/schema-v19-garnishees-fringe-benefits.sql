-- Garnishee orders as a tracked, balance-decrementing deduction (distinct
-- from the generic recurring other_deductions_json, which has no concept of
-- a running balance or a case reference) — mirrors payroll_loans/payroll_loan_repayments.
create table if not exists public.payroll_garnishees (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.payroll_staff(id) on delete cascade,
  company_id uuid not null references public.payroll_companies(id) on delete cascade,
  case_reference text,
  court_order_details text,
  monthly_amount numeric(12,2) not null check (monthly_amount > 0),
  total_amount numeric(12,2),           -- null = indefinite (no cap), e.g. ongoing maintenance order
  balance numeric(12,2),                -- null when total_amount is null; otherwise starts equal to total_amount
  status text not null default 'active' check (status in ('active', 'completed', 'cancelled')),
  start_date date not null default current_date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (total_amount is null or balance is not null)
);
alter table public.payroll_garnishees enable row level security;
drop policy if exists "garnishees_owner_all" on public.payroll_garnishees;
create policy "garnishees_owner_all" on public.payroll_garnishees
  for all using (public.user_owns_company(company_id)) with check (public.user_owns_company(company_id));
grant select, insert, update on public.payroll_garnishees to authenticated;

create table if not exists public.payroll_garnishee_repayments (
  id uuid primary key default gen_random_uuid(),
  garnishee_id uuid not null references public.payroll_garnishees(id) on delete cascade,
  run_id uuid not null references public.payroll_runs(id) on delete cascade,
  amount numeric(12,2) not null,
  created_at timestamptz not null default now(),
  unique (garnishee_id, run_id)
);
alter table public.payroll_garnishee_repayments enable row level security;
drop policy if exists "garnishee_repayments_owner_all" on public.payroll_garnishee_repayments;
create policy "garnishee_repayments_owner_all" on public.payroll_garnishee_repayments
  for all using (
    garnishee_id in (select id from public.payroll_garnishees where public.user_owns_company(company_id))
  ) with check (
    garnishee_id in (select id from public.payroll_garnishees where public.user_owns_company(company_id))
  );
grant select, insert on public.payroll_garnishee_repayments to authenticated;

-- Itemised fringe benefits (company car, low-interest loan, free/subsidised
-- accommodation, employer-provided asset use, etc.) — each entry's monthly
-- taxable value is added to gross taxable income. This is a general-purpose
-- itemised approach rather than a per-benefit-type deemed-value formula,
-- since each SARS fringe benefit type has its own valuation rules the
-- employer must apply when entering the monthly value.
alter table public.payroll_staff add column if not exists fringe_benefits_json jsonb not null default '[]';
alter table public.payroll_payslips add column if not exists fringe_benefits_total numeric(12,2) not null default 0;
alter table public.payroll_payslips add column if not exists fringe_benefits_json jsonb not null default '[]';
