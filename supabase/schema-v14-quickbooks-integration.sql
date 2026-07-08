-- QuickBooks Online push integration — mirrors schema-v13-xero-integration.sql.
-- Kept as separate, provider-specific tables (rather than adding a provider
-- column to the Xero tables) to match how payroll_integration_account_map
-- already keys everything off connection_id, and to avoid touching the
-- already-shipped, already-tested Xero tables.

create table if not exists public.quickbooks_oauth_states (
  state uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.payroll_companies(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.quickbooks_oauth_states enable row level security;
-- Service-role only — never exposed to anon/authenticated.

create table if not exists public.payroll_quickbooks_journal_pushes (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.payroll_runs(id) on delete cascade,
  connection_id uuid not null references public.payroll_integration_connections(id) on delete cascade,
  qbo_journal_entry_id text,
  pushed_at timestamptz not null default now(),
  unique (run_id, connection_id)
);
alter table public.payroll_quickbooks_journal_pushes enable row level security;
drop policy if exists "owners can view their quickbooks pushes" on public.payroll_quickbooks_journal_pushes;
create policy "owners can view their quickbooks pushes" on public.payroll_quickbooks_journal_pushes
  for select using (
    connection_id in (
      select c.id from public.payroll_integration_connections c
      where public.user_owns_company(c.company_id)
    )
  );
grant select on public.payroll_quickbooks_journal_pushes to authenticated;
