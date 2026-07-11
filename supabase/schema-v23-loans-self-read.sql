-- ============================================================
-- v23: let an employee read their own loan/advance record (balance,
-- monthly installment). Previously payroll_loans only had an owner-all
-- policy, so leave.html couldn't show a staff member their own
-- outstanding balance when requesting a new advance.
-- ============================================================

drop policy if exists "loans_self_read" on public.payroll_loans;
create policy "loans_self_read" on public.payroll_loans
  for select using (staff_id in (select id from public.payroll_staff where user_id = auth.uid()));
