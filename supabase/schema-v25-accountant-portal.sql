-- ============================================================
-- v25: Accountant Portal — comments an accountant leaves for the owner
-- against a specific client company. Read/write for the accountant
-- (while their access is accepted), read-only for the owner.
-- ============================================================

create table if not exists public.payroll_accountant_comments (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid references public.payroll_companies(id) on delete cascade not null,
  accountant_id uuid references auth.users(id) not null,
  body          text not null,
  created_at    timestamptz default now()
);

create index if not exists idx_accountant_comments_company on public.payroll_accountant_comments(company_id, created_at);

alter table public.payroll_accountant_comments enable row level security;

drop policy if exists "accountant_comments_owner_read" on public.payroll_accountant_comments;
create policy "accountant_comments_owner_read" on public.payroll_accountant_comments
  for select using (public.user_owns_company(company_id));

drop policy if exists "accountant_comments_accountant_read" on public.payroll_accountant_comments;
create policy "accountant_comments_accountant_read" on public.payroll_accountant_comments
  for select using (public.user_is_accepted_accountant_for(company_id));

drop policy if exists "accountant_comments_accountant_insert" on public.payroll_accountant_comments;
create policy "accountant_comments_accountant_insert" on public.payroll_accountant_comments
  for insert with check (accountant_id = auth.uid() and public.user_is_accepted_accountant_for(company_id));

grant select, insert on public.payroll_accountant_comments to authenticated;
