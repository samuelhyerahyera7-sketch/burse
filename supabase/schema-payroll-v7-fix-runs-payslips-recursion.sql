-- ============================================================
-- BURSE PAYROLL — v7: fix another RLS infinite recursion
-- runs_self_read (added in v4, for the employee portal) queries
-- payroll_payslips directly, and payroll_payslips.payslips_owner_or_self_read
-- queries payroll_runs right back — the same circular pattern fixed in v5,
-- just between a different pair of tables. Confirmed live: reading back a
-- payslip after emailing it threw "infinite recursion detected in policy
-- for relation payroll_payslips".
-- Run this in Supabase → SQL Editor AFTER schema-payroll-v6-feature-additions.sql.
-- ============================================================

create or replace function public.user_has_payslip_in_run(p_run_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from payroll_payslips p
    join payroll_staff s on s.id = p.staff_id
    where p.run_id = p_run_id and s.user_id = auth.uid()
  );
$$;

drop policy if exists "runs_self_read" on public.payroll_runs;

create policy "runs_self_read" on public.payroll_runs
  for select
  using (public.user_has_payslip_in_run(id));
