-- ============================================================
-- v24: Compliance Centre — a tracked list of recurring statutory
-- obligations (EMP201, EMP501, COID, IRP5) plus periodic POPIA/record-
-- retention self-reviews. Burse computes EMP201 due dates itself (the
-- 7th of the following month is well-established), but deliberately
-- leaves EMP501/COID/IRP5/POPIA due dates for the owner to set from the
-- official SARS/Compensation Fund notice for that year, rather than
-- Burse asserting a specific date it can't guarantee is current.
-- ============================================================

create table if not exists public.payroll_compliance_tasks (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid references public.payroll_companies(id) on delete cascade not null,
  task_type     text not null check (task_type in ('emp201','emp501_interim','emp501_annual','coid_roe','irp5_issuance','popia_review','record_retention_review')),
  period_label  text not null,          -- e.g. "2026-07" for EMP201, "2026" tax year for annual items
  due_date      date,                   -- null until the owner sets it (for items Burse can't safely assert)
  status        text not null default 'pending' check (status in ('pending','done')),
  completed_at  timestamptz,
  completed_by  uuid references auth.users(id),
  created_at    timestamptz default now(),
  unique (company_id, task_type, period_label)
);

create index if not exists idx_compliance_tasks_company on public.payroll_compliance_tasks(company_id, status);

alter table public.payroll_compliance_tasks enable row level security;
drop policy if exists "compliance_tasks_owner_all" on public.payroll_compliance_tasks;
create policy "compliance_tasks_owner_all" on public.payroll_compliance_tasks
  for all using (public.user_owns_company(company_id)) with check (public.user_owns_company(company_id));

drop policy if exists "compliance_tasks_accountant_read" on public.payroll_compliance_tasks;
create policy "compliance_tasks_accountant_read" on public.payroll_compliance_tasks
  for select using (public.user_is_accepted_accountant_for(company_id));

grant select, insert, update on public.payroll_compliance_tasks to authenticated;
