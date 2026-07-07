-- ============================================================
-- BURSE BOOKKEEPING — v1: chart of accounts + double-entry journal
-- New product sharing the same company identity as Burse Payroll
-- (payroll_companies is reused as "the company" for both products —
-- a business is one business, whether you're running payroll or
-- books for it). Prefixed bk_ throughout. Run this in Supabase → SQL
-- Editor AFTER schema-payroll-v11-adjustments-loans-leave-policy.sql.
-- ============================================================

create table if not exists public.bk_accounts (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid references public.payroll_companies(id) on delete cascade not null,
  code          text not null,
  name          text not null,
  type          text not null check (type in ('asset','liability','equity','income','expense')),
  is_system     boolean not null default false,   -- protects auto-provisioned accounts (e.g. PAYE Payable) from deletion
  archived      boolean not null default false,
  created_at    timestamptz default now(),
  unique (company_id, code)
);

create table if not exists public.bk_journal_entries (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid references public.payroll_companies(id) on delete cascade not null,
  entry_date    date not null default current_date,
  description   text not null default '',
  source        text not null default 'manual',   -- manual | payroll | invoice | expense
  source_id     uuid,                              -- e.g. the payroll_runs.id / bk_invoices.id this entry came from
  created_by    uuid references auth.users(id),
  created_at    timestamptz default now(),
  unique (company_id, source, source_id)            -- one journal entry per source event — re-finalizing can't double-post
);

create table if not exists public.bk_journal_lines (
  id            uuid primary key default gen_random_uuid(),
  entry_id      uuid references public.bk_journal_entries(id) on delete cascade not null,
  account_id    uuid references public.bk_accounts(id) not null,
  debit         numeric(12,2) not null default 0 check (debit >= 0),
  credit        numeric(12,2) not null default 0 check (credit >= 0),
  description   text
);

create index if not exists idx_bk_journal_lines_entry on public.bk_journal_lines(entry_id);
create index if not exists idx_bk_journal_lines_account on public.bk_journal_lines(account_id);
create index if not exists idx_bk_accounts_company on public.bk_accounts(company_id);
create index if not exists idx_bk_journal_entries_company on public.bk_journal_entries(company_id, entry_date);

alter table public.bk_accounts enable row level security;
alter table public.bk_journal_entries enable row level security;
alter table public.bk_journal_lines enable row level security;

create policy "bk_accounts_owner_all" on public.bk_accounts
  for all using (public.user_owns_company(company_id)) with check (public.user_owns_company(company_id));

create policy "bk_journal_entries_owner_all" on public.bk_journal_entries
  for all using (public.user_owns_company(company_id)) with check (public.user_owns_company(company_id));

-- journal_lines has no company_id of its own — scope through the parent entry
create policy "bk_journal_lines_owner_all" on public.bk_journal_lines
  for all
  using (entry_id in (select id from public.bk_journal_entries where public.user_owns_company(company_id)))
  with check (entry_id in (select id from public.bk_journal_entries where public.user_owns_company(company_id)));

-- ── Standard SA chart of accounts, auto-provisioned once per company ────
-- SECURITY DEFINER so it can be called the moment a company first opens
-- Bookkeeping, without needing a separate onboarding step. Idempotent —
-- safe to call every time the bookkeeping app loads.
create or replace function public.ensure_default_chart_of_accounts(p_company_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.user_owns_company(p_company_id) then
    raise exception 'Not authorised for this company';
  end if;

  insert into public.bk_accounts (company_id, code, name, type, is_system)
  values
    (p_company_id, '1000', 'Bank Account', 'asset', true),
    (p_company_id, '1100', 'Accounts Receivable', 'asset', true),
    (p_company_id, '2000', 'Accounts Payable', 'liability', true),
    (p_company_id, '2100', 'PAYE Payable', 'liability', true),
    (p_company_id, '2200', 'UIF Payable', 'liability', true),
    (p_company_id, '2300', 'SDL Payable', 'liability', true),
    (p_company_id, '2400', 'VAT Payable', 'liability', true),
    (p_company_id, '2500', 'Net Pay Payable', 'liability', true),
    (p_company_id, '3000', 'Owner''s Equity / Retained Earnings', 'equity', true),
    (p_company_id, '4000', 'Sales Revenue', 'income', true),
    (p_company_id, '5000', 'Salaries & Wages Expense', 'expense', true),
    (p_company_id, '5100', 'Employer UIF Expense', 'expense', true),
    (p_company_id, '5200', 'Employer SDL Expense', 'expense', true),
    (p_company_id, '5300', 'Bank Charges', 'expense', true),
    (p_company_id, '5900', 'General Expenses', 'expense', true)
  on conflict (company_id, code) do nothing;
end;
$$;

revoke all on function public.ensure_default_chart_of_accounts(uuid) from public, anon;
grant execute on function public.ensure_default_chart_of_accounts(uuid) to authenticated;

-- ── Post a balanced journal entry atomically, validated server-side ─────
-- Client-side balance checks are a UX nicety, not a guarantee — this is
-- the actual enforcement point. p_lines is a jsonb array of
-- {account_id, debit, credit, description}.
create or replace function public.post_journal_entry(
  p_company_id uuid,
  p_entry_date date,
  p_description text,
  p_source text,
  p_source_id uuid,
  p_lines jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry_id uuid;
  v_total_debit numeric(14,2) := 0;
  v_total_credit numeric(14,2) := 0;
  v_line jsonb;
begin
  if not public.user_owns_company(p_company_id) then
    raise exception 'Not authorised for this company';
  end if;
  if jsonb_array_length(p_lines) < 2 then
    raise exception 'A journal entry needs at least two lines';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_total_debit := v_total_debit + coalesce((v_line->>'debit')::numeric, 0);
    v_total_credit := v_total_credit + coalesce((v_line->>'credit')::numeric, 0);
  end loop;

  if round(v_total_debit, 2) != round(v_total_credit, 2) then
    raise exception 'Journal entry does not balance: debits %, credits %', v_total_debit, v_total_credit;
  end if;

  insert into public.bk_journal_entries (company_id, entry_date, description, source, source_id, created_by)
  values (p_company_id, coalesce(p_entry_date, current_date), coalesce(p_description, ''), coalesce(p_source, 'manual'), p_source_id, auth.uid())
  returning id into v_entry_id;

  insert into public.bk_journal_lines (entry_id, account_id, debit, credit, description)
  select
    v_entry_id,
    (elem->>'account_id')::uuid,
    coalesce((elem->>'debit')::numeric, 0),
    coalesce((elem->>'credit')::numeric, 0),
    elem->>'description'
  from jsonb_array_elements(p_lines) as elem;

  return v_entry_id;
end;
$$;

revoke all on function public.post_journal_entry(uuid, date, text, text, uuid, jsonb) from public, anon;
grant execute on function public.post_journal_entry(uuid, date, text, text, uuid, jsonb) to authenticated;
