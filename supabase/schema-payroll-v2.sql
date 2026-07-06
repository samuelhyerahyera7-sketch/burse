-- ============================================================
-- BURSE PAYROLL — v2 additions
-- Accountant (view-only) access, audit log, bank payment file support.
-- Run this in Supabase → SQL Editor AFTER schema-payroll.sql.
-- ============================================================

-- ── Accountants invited by a company owner ───────────────────
create table if not exists public.payroll_accountants (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid references public.payroll_companies(id) on delete cascade not null,
  email         text not null,
  user_id       uuid references auth.users(id),   -- set once the accountant signs up / logs in and claims the invite
  status        text default 'pending',            -- pending | accepted | revoked
  invited_at    timestamptz default now(),
  accepted_at   timestamptz,
  unique (company_id, email)
);

alter table public.payroll_accountants enable row level security;

-- Owner manages invites for their own companies
create policy "accountants_owner_manage" on public.payroll_accountants
  using (company_id in (select id from public.payroll_companies where owner_id = auth.uid()))
  with check (company_id in (select id from public.payroll_companies where owner_id = auth.uid()));

-- An invited accountant can see their own invite row (to claim it)
create policy "accountants_self_read" on public.payroll_accountants
  using (user_id = auth.uid());

-- ── Audit log ──────────────────────────────────────────────────
create table if not exists public.payroll_audit_log (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid references public.payroll_companies(id) on delete cascade not null,
  actor_id      uuid references auth.users(id),
  action        text not null,     -- payroll_approved | bank_file_downloaded | accountant_invited | accountant_revoked
  meta          jsonb default '{}',
  created_at    timestamptz default now()
);

alter table public.payroll_audit_log enable row level security;

create policy "audit_log_owner_read" on public.payroll_audit_log
  using (company_id in (select id from public.payroll_companies where owner_id = auth.uid()));

create policy "audit_log_accountant_read" on public.payroll_audit_log
  using (company_id in (
    select company_id from public.payroll_accountants where user_id = auth.uid() and status = 'accepted'
  ));

create policy "audit_log_insert" on public.payroll_audit_log
  for insert
  with check (
    company_id in (select id from public.payroll_companies where owner_id = auth.uid())
    or company_id in (select company_id from public.payroll_accountants where user_id = auth.uid() and status = 'accepted')
  );

-- ── Accountant read-only access to payroll data ───────────────
-- These ADD to the existing owner/self policies on each table (Postgres
-- evaluates multiple permissive policies for the same command with OR),
-- so accountants get read access without touching the owner policies.

create policy "runs_accountant_read" on public.payroll_runs
  for select
  using (company_id in (
    select company_id from public.payroll_accountants where user_id = auth.uid() and status = 'accepted'
  ));

create policy "payslips_accountant_read" on public.payroll_payslips
  for select
  using (run_id in (
    select r.id from public.payroll_runs r
    where r.company_id in (
      select company_id from public.payroll_accountants where user_id = auth.uid() and status = 'accepted'
    )
  ));

create policy "staff_accountant_read" on public.payroll_staff
  for select
  using (company_id in (
    select company_id from public.payroll_accountants where user_id = auth.uid() and status = 'accepted'
  ));

create policy "leave_balances_accountant_read" on public.payroll_leave_balances
  for select
  using (staff_id in (
    select s.id from public.payroll_staff s
    where s.company_id in (
      select company_id from public.payroll_accountants where user_id = auth.uid() and status = 'accepted'
    )
  ));

-- ── Reconciliation notes (owner-editable, accountant-readable) ─
alter table public.payroll_companies add column if not exists reconciliation_notes text;

create policy "companies_accountant_read" on public.payroll_companies
  for select
  using (id in (
    select company_id from public.payroll_accountants where user_id = auth.uid() and status = 'accepted'
  ));

-- ── Claim a pending accountant invite by email on login ───────
create or replace function public.claim_accountant_invites()
returns void language plpgsql security definer as $$
begin
  update public.payroll_accountants a
  set user_id = auth.uid(), status = 'accepted', accepted_at = now()
  from auth.users u
  where u.id = auth.uid()
    and a.user_id is null
    and lower(a.email) = lower(u.email);
end;
$$;
