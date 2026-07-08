-- Xero push integration: OAuth2 state tracking (CSRF-safe redirect handoff)
-- and the per-company mapping from Burse's internal chart-of-accounts codes
-- to the customer's actual Xero account IDs.

-- Short-lived, one-time-use rows created right before redirecting a browser
-- to Xero's consent screen. The callback looks the state up to recover which
-- company initiated the connection (never trusts a client-supplied company_id
-- on the callback itself, since that leg has no Burse auth header to check).
create table if not exists public.xero_oauth_states (
  state uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.payroll_companies(id) on delete cascade,
  created_at timestamptz not null default now()
);
-- Service-role only — never exposed to anon/authenticated.
alter table public.xero_oauth_states enable row level security;

create table if not exists public.payroll_integration_account_map (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.payroll_integration_connections(id) on delete cascade,
  company_id uuid not null references public.payroll_companies(id) on delete cascade,
  bk_account_code text not null,
  external_account_id text not null,
  external_account_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, bk_account_code)
);

alter table public.payroll_integration_account_map enable row level security;

drop policy if exists "owners manage their account map" on public.payroll_integration_account_map;
create policy "owners manage their account map" on public.payroll_integration_account_map
  for all using (public.user_owns_company(company_id)) with check (public.user_owns_company(company_id));

grant select, insert, update, delete on public.payroll_integration_account_map to authenticated;

-- Tracks which pay runs have already been pushed to which Xero connection,
-- so a retried finalize (or the manual "push again" action) never double-
-- posts the same run's journal into the customer's Xero organisation.
create table if not exists public.payroll_xero_journal_pushes (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.payroll_runs(id) on delete cascade,
  connection_id uuid not null references public.payroll_integration_connections(id) on delete cascade,
  xero_manual_journal_id text,
  pushed_at timestamptz not null default now(),
  unique (run_id, connection_id)
);
alter table public.payroll_xero_journal_pushes enable row level security;
-- Service-role only (written exclusively by payroll-engine); owners can read
-- their own via the join for visibility if a future UI needs it.
drop policy if exists "owners can view their xero pushes" on public.payroll_xero_journal_pushes;
create policy "owners can view their xero pushes" on public.payroll_xero_journal_pushes
  for select using (
    connection_id in (
      select c.id from public.payroll_integration_connections c
      where public.user_owns_company(c.company_id)
    )
  );
grant select on public.payroll_xero_journal_pushes to authenticated;
