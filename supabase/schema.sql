-- ============================================================
-- BURSE DATABASE SCHEMA
-- Run this in Supabase → SQL Editor
-- ============================================================

-- ── User profiles (extends auth.users) ──────────────────────
create table if not exists public.profiles (
  id                uuid primary key references auth.users(id) on delete cascade,
  full_name         text,
  id_number         text,
  phone             text,
  role              text default 'employee',        -- employee | employer | admin
  -- Payroll link (set when employer connects payroll)
  payroll_employee_id text,
  connection_id     uuid,
  gross_salary      numeric(12,2),
  payday_of_month   int default 25,
  pay_frequency     text default 'monthly',
  -- Bank account
  bank_name         text,
  bank_last4        text,
  bank_account_number text,
  bank_branch_code  text,
  account_type      text default 'Savings',
  -- Withdrawal limits
  max_withdrawals_per_cycle int default 3,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

-- ── Payroll provider connections (one per employer) ─────────
create table if not exists public.payroll_connections (
  id                uuid primary key default gen_random_uuid(),
  employer_id       uuid references auth.users(id) on delete cascade,
  company_name      text,
  provider          text not null,   -- sage | payspace | simplepay | csv

  -- Sage Business Cloud Payroll
  sage_client_id       text,
  sage_client_secret   text,
  sage_access_token    text,
  sage_refresh_token   text,
  sage_token_expires   timestamptz,
  sage_company_id      text,

  -- PaySpace
  payspace_client_id     text,
  payspace_client_secret text,
  payspace_base_url      text default 'https://api.payspace.com',
  payspace_company_id    text,
  payspace_access_token  text,
  payspace_token_expires timestamptz,

  -- SimplePay
  simplepay_api_key   text,

  -- Status
  status            text default 'pending',   -- pending | active | error
  last_synced_at    timestamptz,
  last_error        text,
  employee_count    int default 0,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

-- ── Employees synced from payroll providers ──────────────────
create table if not exists public.payroll_employees (
  id              uuid primary key default gen_random_uuid(),
  connection_id   uuid references public.payroll_connections(id) on delete cascade,
  user_id         uuid references auth.users(id),   -- null until employee signs up
  external_id     text not null,
  full_name       text,
  email           text,
  id_number       text,
  phone           text,
  department      text,
  job_title       text,
  gross_salary    numeric(12,2),
  net_salary      numeric(12,2),
  pay_frequency   text default 'monthly',
  payday_of_month int default 25,
  start_date      date,
  active          boolean default true,
  raw_data        jsonb,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now(),
  unique (connection_id, external_id)
);

-- ── Pay cycles (current & historical) ───────────────────────
create table if not exists public.payroll_cycles (
  id              uuid primary key default gen_random_uuid(),
  connection_id   uuid references public.payroll_connections(id) on delete cascade,
  employee_id     uuid references public.payroll_employees(id) on delete cascade,
  period_start    date not null,
  period_end      date not null,
  pay_date        date not null,
  gross_amount    numeric(12,2),
  deductions      numeric(12,2) default 0,
  net_amount      numeric(12,2),
  days_in_cycle   int,
  status          text default 'upcoming',   -- upcoming | processed | paid
  created_at      timestamptz default now()
);

-- ── Transactions ledger ──────────────────────────────────────
create table if not exists public.transactions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete cascade,
  type        text not null,          -- withdrawal | fee | salary | refund
  description text,
  amount      numeric(12,2) not null, -- positive = credit, negative = debit
  reference   text,
  created_at  timestamptz default now()
);

-- ── Withdrawal requests ──────────────────────────────────────
create table if not exists public.withdrawals (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete cascade,
  amount      numeric(12,2) not null,
  fee         numeric(12,2) default 10,
  status      text default 'pending',  -- pending | approved | paid | rejected
  bank_name   text,
  bank_last4  text,
  reference   text,
  requested_at timestamptz default now(),
  processed_at timestamptz
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

alter table public.profiles           enable row level security;
alter table public.payroll_connections enable row level security;
alter table public.payroll_employees   enable row level security;
alter table public.payroll_cycles      enable row level security;
alter table public.transactions        enable row level security;
alter table public.withdrawals         enable row level security;

-- profiles: users read/write own row only
create policy "profiles_own" on public.profiles
  using (auth.uid() = id) with check (auth.uid() = id);

-- payroll_connections: employer reads/writes own connections
create policy "connections_own" on public.payroll_connections
  using (auth.uid() = employer_id) with check (auth.uid() = employer_id);

-- payroll_employees: employer sees their connection's employees; employee sees own row
create policy "employees_employer" on public.payroll_employees
  using (
    connection_id in (
      select id from public.payroll_connections where employer_id = auth.uid()
    )
    or user_id = auth.uid()
  );

-- payroll_cycles: same as employees
create policy "cycles_employer" on public.payroll_cycles
  using (
    connection_id in (
      select id from public.payroll_connections where employer_id = auth.uid()
    )
    or employee_id in (
      select id from public.payroll_employees where user_id = auth.uid()
    )
  );

-- transactions / withdrawals: users see own rows only
create policy "txns_own" on public.transactions
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "withdrawals_own" on public.withdrawals
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================
-- AUTO-CREATE PROFILE ON SIGN UP
-- ============================================================
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data->>'full_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ── Link Burse users to their payroll employee record ────────
-- Called after each payroll sync to auto-match by email
create or replace function public.link_payroll_users_by_email(p_connection_id uuid)
returns void language plpgsql security definer as $$
begin
  update public.payroll_employees pe
  set user_id = u.id
  from auth.users u
  where pe.connection_id = p_connection_id
    and pe.user_id is null
    and lower(pe.email) = lower(u.email);

  -- Also update profiles with salary data from payroll
  update public.profiles p
  set
    payroll_employee_id = pe.external_id,
    connection_id       = pe.connection_id,
    gross_salary        = pe.gross_salary,
    payday_of_month     = pe.payday_of_month,
    pay_frequency       = pe.pay_frequency,
    updated_at          = now()
  from public.payroll_employees pe
  where pe.connection_id = p_connection_id
    and pe.user_id = p.id
    and pe.gross_salary is not null;
end;
$$;
