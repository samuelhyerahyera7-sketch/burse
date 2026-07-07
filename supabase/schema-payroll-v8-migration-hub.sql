-- ============================================================
-- BURSE PAYROLL — v8: Migration & Integration Hub
-- Adds tables to support the CSV/Excel migration wizard: one row
-- per import job, one row per imported employee record (for
-- validation/preview/audit before committing into payroll_staff).
-- Run this in Supabase → SQL Editor AFTER schema-payroll-v7-fix-runs-payslips-recursion.sql.
-- ============================================================

create table if not exists public.payroll_migration_jobs (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid references public.payroll_companies(id) on delete cascade not null,
  provider        text not null,              -- simplepay | sage_payroll | sage_vip | payspace | pastel | paymaster | xero | quickbooks | other
  mode            text not null default 'full_migration', -- full_migration | integrate
  source_type     text not null default 'csv',            -- csv | excel
  file_name       text,
  status          text not null default 'mapping',        -- mapping | validating | ready | importing | completed | failed
  field_map       jsonb default '{}',          -- { burseField: sourceHeader }
  row_count       int default 0,
  valid_count     int default 0,
  error_count     int default 0,
  imported_count  int default 0,
  last_synced_at  timestamptz,
  created_by      uuid references auth.users(id),
  created_at      timestamptz default now(),
  completed_at    timestamptz
);

create table if not exists public.payroll_migration_rows (
  id              uuid primary key default gen_random_uuid(),
  job_id          uuid references public.payroll_migration_jobs(id) on delete cascade not null,
  row_index       int not null,
  raw             jsonb not null default '{}',   -- original source row, keyed by source header
  mapped          jsonb not null default '{}',   -- mapped onto Burse field names
  errors          jsonb not null default '[]',   -- [{field, message}]
  status          text not null default 'pending', -- pending | valid | error | imported | skipped
  staff_id        uuid references public.payroll_staff(id) on delete set null,
  created_at      timestamptz default now()
);

create index if not exists idx_migration_rows_job on public.payroll_migration_rows(job_id);

alter table public.payroll_migration_jobs enable row level security;
alter table public.payroll_migration_rows enable row level security;

create policy "migration_jobs_owner_all" on public.payroll_migration_jobs
  for all
  using (public.user_owns_company(company_id))
  with check (public.user_owns_company(company_id));

create policy "migration_rows_owner_all" on public.payroll_migration_rows
  for all
  using (job_id in (select id from public.payroll_migration_jobs where public.user_owns_company(company_id)))
  with check (job_id in (select id from public.payroll_migration_jobs where public.user_owns_company(company_id)));
