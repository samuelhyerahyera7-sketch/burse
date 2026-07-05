-- ============================================================
-- BURSE PAYROLL MODULE SCHEMA
-- In-house payroll engine (separate from the Sage/PaySpace/SimplePay
-- sync feature in schema.sql). Run this in Supabase → SQL Editor
-- AFTER schema.sql.
-- ============================================================

-- ── Employer companies running payroll through Burse ────────
create table if not exists public.payroll_companies (
  id                  uuid primary key default gen_random_uuid(),
  owner_id            uuid references auth.users(id) on delete cascade not null,
  trading_name        text not null,
  registered_name     text,
  company_reg_number  text,             -- CIPC registration number
  paye_reference      text,             -- SARS PAYE reference (e.g. 7XXXXXXXXX)
  uif_reference       text,             -- Dept of Labour UIF reference
  sdl_reference       text,             -- SARS SDL reference
  sdl_exempt          boolean default false, -- annual payroll <= R500,000, or otherwise exempt
  work_days_per_week  smallint default 5 check (work_days_per_week in (5,6)),
  address             text,
  industry            text,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

-- ── Staff employed by a payroll company (in-house, statutory record) ──
create table if not exists public.payroll_staff (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid references public.payroll_companies(id) on delete cascade not null,
  user_id               uuid references auth.users(id),   -- linked once the employee signs up / is invited
  employee_number       text,
  full_name             text not null,
  id_number             text,           -- SA ID number (used to derive date of birth / age)
  date_of_birth         date,
  tax_number            text,           -- SARS income tax reference number
  email                 text,
  phone                 text,
  job_title             text,
  department            text,
  employment_type       text default 'permanent',   -- permanent | fixed_term | part_time
  start_date            date not null,
  end_date              date,
  active                boolean default true,

  pay_frequency         text default 'monthly',     -- monthly | fortnightly | weekly
  basic_salary          numeric(12,2) not null default 0,   -- per pay period
  travel_allowance      numeric(12,2) default 0,            -- taxable at 80% (or 20% if <80% business use logged)
  travel_allowance_taxable_pct numeric(5,2) default 80,
  other_taxable_allowance numeric(12,2) default 0,
  other_nontaxable_allowance numeric(12,2) default 0,

  retirement_fund_type     text,                 -- pension | provident | ra | none
  retirement_contribution  numeric(12,2) default 0,  -- employee's own contribution per period

  medical_aid_dependants  int default 0,         -- 0 = none, 1 = member only, 2 = +1 dependant, etc.

  other_deductions_json   jsonb default '[]',     -- [{label, amount}] e.g. loan repayment, garnishee, union fee

  bank_name             text,
  bank_account_number   text,
  bank_branch_code      text,
  account_type          text default 'Savings',

  is_eti_eligible        boolean default true,   -- employer can opt an employee out (e.g. connected persons, domestic workers)

  created_at            timestamptz default now(),
  updated_at            timestamptz default now(),
  unique (company_id, employee_number)
);

-- ── Pay runs (one per company per period) ────────────────────
create table if not exists public.payroll_runs (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid references public.payroll_companies(id) on delete cascade not null,
  tax_year        text not null,             -- e.g. '2026/2027'
  period_start    date not null,
  period_end      date not null,
  pay_date        date not null,
  frequency       text default 'monthly',
  status          text default 'draft',      -- draft | finalized | paid
  finalized_at    timestamptz,
  created_at      timestamptz default now(),
  unique (company_id, period_start, period_end)
);

-- ── Payslips (one per staff member per pay run) ──────────────
create table if not exists public.payroll_payslips (
  id                    uuid primary key default gen_random_uuid(),
  run_id                uuid references public.payroll_runs(id) on delete cascade not null,
  staff_id              uuid references public.payroll_staff(id) on delete cascade not null,

  basic_salary          numeric(12,2) default 0,
  travel_allowance       numeric(12,2) default 0,
  other_taxable_allowance numeric(12,2) default 0,
  other_nontaxable_allowance numeric(12,2) default 0,
  gross_pay             numeric(12,2) default 0,   -- basic + all allowances

  retirement_contribution numeric(12,2) default 0,
  retirement_deductible    numeric(12,2) default 0, -- portion deductible for PAYE purposes this period

  taxable_income        numeric(12,2) default 0,   -- gross - non-taxable allowance - retirement_deductible
  paye                  numeric(12,2) default 0,
  medical_credit         numeric(12,2) default 0,
  uif_employee          numeric(12,2) default 0,
  uif_employer          numeric(12,2) default 0,
  sdl_employer          numeric(12,2) default 0,
  eti_employer          numeric(12,2) default 0,   -- reduces employer's PAYE liability, not employee's payslip

  other_deductions       numeric(12,2) default 0,
  other_deductions_json  jsonb default '[]',

  total_deductions       numeric(12,2) default 0,   -- paye + uif_employee + retirement_contribution + other_deductions
  net_pay                numeric(12,2) default 0,

  ytd_gross             numeric(12,2) default 0,
  ytd_taxable           numeric(12,2) default 0,
  ytd_paye              numeric(12,2) default 0,
  ytd_uif_employee       numeric(12,2) default 0,
  ytd_retirement         numeric(12,2) default 0,

  created_at            timestamptz default now(),
  unique (run_id, staff_id)
);

-- ── Leave balances (one row per staff per leave type) ────────
create table if not exists public.payroll_leave_balances (
  id              uuid primary key default gen_random_uuid(),
  staff_id        uuid references public.payroll_staff(id) on delete cascade not null,
  leave_type      text not null,     -- annual | sick | family_responsibility | maternity | parental | unpaid
  cycle_start     date not null,
  entitled_days   numeric(6,2) default 0,
  taken_days      numeric(6,2) default 0,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now(),
  unique (staff_id, leave_type, cycle_start)
);

-- ── Leave requests ────────────────────────────────────────────
create table if not exists public.payroll_leave_requests (
  id            uuid primary key default gen_random_uuid(),
  staff_id      uuid references public.payroll_staff(id) on delete cascade not null,
  leave_type    text not null,
  start_date    date not null,
  end_date      date not null,
  days          numeric(6,2) not null,
  reason        text,
  status        text default 'pending',   -- pending | approved | rejected | cancelled
  requested_at  timestamptz default now(),
  decided_at    timestamptz,
  decided_by    uuid references auth.users(id)
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

alter table public.payroll_companies       enable row level security;
alter table public.payroll_staff           enable row level security;
alter table public.payroll_runs            enable row level security;
alter table public.payroll_payslips        enable row level security;
alter table public.payroll_leave_balances  enable row level security;
alter table public.payroll_leave_requests  enable row level security;

-- companies: owner only
create policy "companies_owner" on public.payroll_companies
  using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

-- staff: company owner sees all; the linked employee sees their own row
create policy "staff_owner_or_self" on public.payroll_staff
  using (
    user_id = auth.uid()
    or company_id in (select id from public.payroll_companies where owner_id = auth.uid())
  )
  with check (
    company_id in (select id from public.payroll_companies where owner_id = auth.uid())
  );

-- pay runs: company owner only
create policy "runs_owner" on public.payroll_runs
  using (company_id in (select id from public.payroll_companies where owner_id = auth.uid()))
  with check (company_id in (select id from public.payroll_companies where owner_id = auth.uid()));

-- payslips: company owner sees all in their runs; employee sees their own
create policy "payslips_owner_or_self" on public.payroll_payslips
  using (
    staff_id in (select id from public.payroll_staff where user_id = auth.uid())
    or run_id in (
      select r.id from public.payroll_runs r
      join public.payroll_companies c on c.id = r.company_id
      where c.owner_id = auth.uid()
    )
  );

-- leave balances / requests: staff see own, company owner sees all their staff's
create policy "leave_balances_owner_or_self" on public.payroll_leave_balances
  using (
    staff_id in (select id from public.payroll_staff where user_id = auth.uid())
    or staff_id in (
      select s.id from public.payroll_staff s
      join public.payroll_companies c on c.id = s.company_id
      where c.owner_id = auth.uid()
    )
  );

create policy "leave_requests_owner_or_self" on public.payroll_leave_requests
  using (
    staff_id in (select id from public.payroll_staff where user_id = auth.uid())
    or staff_id in (
      select s.id from public.payroll_staff s
      join public.payroll_companies c on c.id = s.company_id
      where c.owner_id = auth.uid()
    )
  )
  with check (
    staff_id in (select id from public.payroll_staff where user_id = auth.uid())
    or staff_id in (
      select s.id from public.payroll_staff s
      join public.payroll_companies c on c.id = s.company_id
      where c.owner_id = auth.uid()
    )
  );

-- ── Auto-link staff to a Burse user account by email ─────────
create or replace function public.link_payroll_staff_by_email(p_company_id uuid)
returns void language plpgsql security definer as $$
begin
  update public.payroll_staff s
  set user_id = u.id, updated_at = now()
  from auth.users u
  where s.company_id = p_company_id
    and s.user_id is null
    and s.email is not null
    and lower(s.email) = lower(u.email);
end;
$$;
