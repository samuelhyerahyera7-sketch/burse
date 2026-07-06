-- ============================================================
-- BURSE PAYROLL — v5: fix RLS infinite recursion
-- payroll_companies.companies_accountant_read queries payroll_accountants,
-- and payroll_accountants.accountants_owner_manage queries payroll_companies
-- right back — a circular cross-table RLS reference. Postgres detects this
-- and throws "infinite recursion detected in policy for relation
-- payroll_companies" on ANY operation touching either table (not just
-- accountant-related ones — this broke creating a company at all for any
-- user, since loadCompany()/saveCompany() query payroll_companies).
--
-- Fix: move both cross-table lookups into SECURITY DEFINER helper functions.
-- A function call breaks the direct correlated-subquery cycle that
-- Postgres's recursion detector flags, which is the standard Supabase
-- pattern for this exact error. Run this in Supabase → SQL Editor AFTER
-- schema-payroll-v4-employee-portal.sql.
-- ============================================================

create or replace function public.user_owns_company(p_company_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from payroll_companies
    where id = p_company_id and owner_id = auth.uid()
  );
$$;

create or replace function public.user_is_accepted_accountant_for(p_company_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from payroll_accountants
    where company_id = p_company_id and user_id = auth.uid() and status = 'accepted'
  );
$$;

drop policy if exists "accountants_owner_manage" on public.payroll_accountants;
create policy "accountants_owner_manage" on public.payroll_accountants
  for all
  using (public.user_owns_company(company_id))
  with check (public.user_owns_company(company_id));

drop policy if exists "companies_accountant_read" on public.payroll_companies;
create policy "companies_accountant_read" on public.payroll_companies
  for select
  using (public.user_is_accepted_accountant_for(id));
