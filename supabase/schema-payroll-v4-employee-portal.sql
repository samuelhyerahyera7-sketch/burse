-- ============================================================
-- BURSE PAYROLL — v4: employee self-service portal
-- Fixes a gap where a plain employee (a payroll_staff row not linked to
-- any auth.users account) had no way to ever get user_id populated, and
-- payroll-admin.html had no route for that role — they'd fall through to
-- the owner's "set up your company" onboarding screen. Run this in
-- Supabase → SQL Editor AFTER schema-payroll-v3-security-fix.sql.
-- ============================================================

-- Mirrors claim_accountant_invites(): a signed-in user claims any
-- payroll_staff row matching their own email, across any company, the
-- first time they log in. Safe because it only ever links to auth.uid()'s
-- own account and only matches on that account's own verified email.
create or replace function public.claim_payroll_staff_invites()
returns void language plpgsql security definer as $$
begin
  update public.payroll_staff s
  set user_id = auth.uid(), updated_at = now()
  from auth.users u
  where u.id = auth.uid()
    and s.user_id is null
    and s.email is not null
    and lower(s.email) = lower(u.email);
end;
$$;

-- ── Employees can read the pay run behind their own payslip ────────────
-- The employee self-service portal joins payroll_payslips -> payroll_runs
-- (to show period/pay date). payroll_runs previously had no employee-facing
-- read policy at all (only "runs_owner" and "runs_accountant_read"), so that
-- join would silently come back empty for a logged-in employee.
create policy "runs_self_read" on public.payroll_runs
  for select
  using (id in (
    select p.run_id from public.payroll_payslips p
    join public.payroll_staff s on s.id = p.staff_id
    where s.user_id = auth.uid()
  ));
