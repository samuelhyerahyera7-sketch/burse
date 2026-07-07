-- Captures interest in bank feed connections per bank, per company, so we
-- know which banks to prioritise once a data-aggregator partnership is live.
-- Not a real bank connection — see payroll-admin.html's Bank Feeds section.
create table if not exists public.bank_feed_interest (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.payroll_companies(id) on delete cascade,
  bank_name text not null,
  requested_by uuid not null,
  created_at timestamptz not null default now(),
  unique (company_id, bank_name)
);

alter table public.bank_feed_interest enable row level security;

drop policy if exists "owners can view their bank feed interest" on public.bank_feed_interest;
create policy "owners can view their bank feed interest" on public.bank_feed_interest
  for select using (public.user_owns_company(company_id));

drop policy if exists "owners can register bank feed interest" on public.bank_feed_interest;
create policy "owners can register bank feed interest" on public.bank_feed_interest
  for insert with check (public.user_owns_company(company_id));

grant select, insert on public.bank_feed_interest to authenticated;
