-- ============================================================
-- BURSE BOOKKEEPING — v4: customers + vendors as first-class records
-- Until now invoices/expenses just carried a free-text name. This adds
-- real customer/vendor records so we can show a Customer Hub / Vendor
-- Hub (per-contact history, balances) the way Xero/QuickBooks do.
-- Existing invoices/expenses keep their free-text columns for back-compat
-- and gain an optional FK — old rows stay valid with customer_id null.
-- Run AFTER schema-bookkeeping-v3-payroll-accounts.sql.
-- ============================================================

create table if not exists public.bk_customers (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid references public.payroll_companies(id) on delete cascade not null,
  name          text not null,
  email         text,
  phone         text,
  vat_number    text,
  address       text,
  archived      boolean not null default false,
  created_at    timestamptz default now()
);

create table if not exists public.bk_vendors (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid references public.payroll_companies(id) on delete cascade not null,
  name          text not null,
  email         text,
  phone         text,
  vat_number    text,
  address       text,
  archived      boolean not null default false,
  created_at    timestamptz default now()
);

alter table public.bk_invoices add column if not exists customer_id uuid references public.bk_customers(id) on delete set null;
alter table public.bk_expenses add column if not exists vendor_id uuid references public.bk_vendors(id) on delete set null;

create index if not exists idx_bk_customers_company on public.bk_customers(company_id);
create index if not exists idx_bk_vendors_company on public.bk_vendors(company_id);
create index if not exists idx_bk_invoices_customer on public.bk_invoices(customer_id);
create index if not exists idx_bk_expenses_vendor on public.bk_expenses(vendor_id);

alter table public.bk_customers enable row level security;
alter table public.bk_vendors enable row level security;

drop policy if exists "bk_customers_owner_all" on public.bk_customers;
create policy "bk_customers_owner_all" on public.bk_customers
  for all using (public.user_owns_company(company_id)) with check (public.user_owns_company(company_id));

drop policy if exists "bk_vendors_owner_all" on public.bk_vendors;
create policy "bk_vendors_owner_all" on public.bk_vendors
  for all using (public.user_owns_company(company_id)) with check (public.user_owns_company(company_id));

grant select, insert, update, delete on public.bk_customers to authenticated;
grant select, insert, update, delete on public.bk_vendors to authenticated;
