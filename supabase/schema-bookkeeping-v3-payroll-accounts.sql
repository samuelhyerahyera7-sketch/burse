-- ============================================================
-- BURSE BOOKKEEPING — v3: additional system accounts for payroll auto-post
-- Needed so a finalized payroll run's journal entry actually balances:
-- retirement contributions and other itemized deductions are owed to a
-- third party (not the company), and a loan repayment reduces an asset
-- the company already holds (the staff loan), not a new liability.
-- Run this in Supabase → SQL Editor AFTER schema-bookkeeping-v2-invoices-expenses.sql.
-- ============================================================

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
    (p_company_id, '1200', 'Staff Loans Receivable', 'asset', true),
    (p_company_id, '2000', 'Accounts Payable', 'liability', true),
    (p_company_id, '2100', 'PAYE Payable', 'liability', true),
    (p_company_id, '2200', 'UIF Payable', 'liability', true),
    (p_company_id, '2300', 'SDL Payable', 'liability', true),
    (p_company_id, '2400', 'VAT Payable', 'liability', true),
    (p_company_id, '2500', 'Net Pay Payable', 'liability', true),
    (p_company_id, '2600', 'Retirement Fund Payable', 'liability', true),
    (p_company_id, '2700', 'Other Payroll Deductions Payable', 'liability', true),
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

-- Backfill the 3 new accounts for any company that already ran ensure_default_chart_of_accounts
insert into public.bk_accounts (company_id, code, name, type, is_system)
select id, '1200', 'Staff Loans Receivable', 'asset', true from public.payroll_companies
where exists (select 1 from public.bk_accounts a where a.company_id = payroll_companies.id)
on conflict (company_id, code) do nothing;

insert into public.bk_accounts (company_id, code, name, type, is_system)
select id, '2600', 'Retirement Fund Payable', 'liability', true from public.payroll_companies
where exists (select 1 from public.bk_accounts a where a.company_id = payroll_companies.id)
on conflict (company_id, code) do nothing;

insert into public.bk_accounts (company_id, code, name, type, is_system)
select id, '2700', 'Other Payroll Deductions Payable', 'liability', true from public.payroll_companies
where exists (select 1 from public.bk_accounts a where a.company_id = payroll_companies.id)
on conflict (company_id, code) do nothing;
