-- ============================================================
-- v26: ETI (Employment Tax Incentive) carry-forward ledger.
--
-- SARS rule: ETI reduces the employer's PAYE liability for a period, but
-- can never make that liability negative. If calculated ETI exceeds the
-- PAYE liability for the period, the excess must be carried forward and
-- offset against a future period's PAYE liability — it is not lost.
-- Burse previously discarded any excess ETI. This table persists one row
-- per finalized run, in strict chronological order, so each run's
-- brought-forward figure is the prior finalized run's carried-forward
-- figure.
-- ============================================================

create table if not exists public.payroll_eti_ledger (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid references public.payroll_companies(id) on delete cascade not null,
  run_id            uuid references public.payroll_runs(id) on delete cascade not null unique,
  period_end        date not null,
  brought_forward   numeric(14,2) not null default 0,
  calculated        numeric(14,2) not null default 0,
  paye_liability    numeric(14,2) not null default 0,
  utilised          numeric(14,2) not null default 0,
  carried_forward   numeric(14,2) not null default 0,
  created_at        timestamptz default now()
);

create index if not exists idx_eti_ledger_company_period on public.payroll_eti_ledger(company_id, period_end);

alter table public.payroll_eti_ledger enable row level security;
drop policy if exists "eti_ledger_owner_all" on public.payroll_eti_ledger;
create policy "eti_ledger_owner_all" on public.payroll_eti_ledger
  for all using (public.user_owns_company(company_id)) with check (public.user_owns_company(company_id));

drop policy if exists "eti_ledger_accountant_read" on public.payroll_eti_ledger;
create policy "eti_ledger_accountant_read" on public.payroll_eti_ledger
  for select using (public.user_is_accepted_accountant_for(company_id));

grant select, insert, update on public.payroll_eti_ledger to authenticated;
