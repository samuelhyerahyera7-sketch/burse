-- ============================================================
-- BURSE PAYROLL — v3 security fix
-- Closes a privilege-escalation gap: the original policies on
-- payroll_payslips, payroll_leave_balances and payroll_leave_requests
-- had no `for select` restriction and no `with check`, so Postgres
-- applied the (self OR owner) USING clause to every command — meaning
-- an authenticated employee could call the Supabase REST API directly
-- (bypassing the UI, which only *hides* the Approve/Reject buttons from
-- non-owners) to:
--   - edit their own payslip amounts,
--   - edit their own leave balance (taken_days), and
--   - self-approve their own leave request.
-- Run this in Supabase → SQL Editor AFTER schema-payroll-v2.sql.
-- ============================================================

-- ── Payslips: read-only for everyone at the RLS layer ─────────
-- All writes happen server-side in the payroll-engine edge function using
-- the service role key, which bypasses RLS entirely — so neither the
-- owner nor the employee ever needs INSERT/UPDATE/DELETE from the browser.
drop policy if exists "payslips_owner_or_self" on public.payroll_payslips;

create policy "payslips_owner_or_self_read" on public.payroll_payslips
  for select
  using (
    staff_id in (select id from public.payroll_staff where user_id = auth.uid())
    or run_id in (
      select r.id from public.payroll_runs r
      join public.payroll_companies c on c.id = r.company_id
      where c.owner_id = auth.uid()
    )
  );

-- ── Leave balances: employees read-only; only the owner can adjust ────
drop policy if exists "leave_balances_owner_or_self" on public.payroll_leave_balances;

create policy "leave_balances_self_read" on public.payroll_leave_balances
  for select
  using (staff_id in (select id from public.payroll_staff where user_id = auth.uid()));

create policy "leave_balances_owner_all" on public.payroll_leave_balances
  for all
  using (
    staff_id in (
      select s.id from public.payroll_staff s
      join public.payroll_companies c on c.id = s.company_id
      where c.owner_id = auth.uid()
    )
  )
  with check (
    staff_id in (
      select s.id from public.payroll_staff s
      join public.payroll_companies c on c.id = s.company_id
      where c.owner_id = auth.uid()
    )
  );

-- ── Leave requests: employees can submit + read their own, but only ───
-- the owner can approve/reject (decide). Employees can no longer set
-- their own request's status via a direct REST call.
drop policy if exists "leave_requests_owner_or_self" on public.payroll_leave_requests;

create policy "leave_requests_self_read" on public.payroll_leave_requests
  for select
  using (staff_id in (select id from public.payroll_staff where user_id = auth.uid()));

create policy "leave_requests_self_insert" on public.payroll_leave_requests
  for insert
  with check (
    staff_id in (select id from public.payroll_staff where user_id = auth.uid())
    and status = 'pending'
  );

create policy "leave_requests_owner_all" on public.payroll_leave_requests
  for all
  using (
    staff_id in (
      select s.id from public.payroll_staff s
      join public.payroll_companies c on c.id = s.company_id
      where c.owner_id = auth.uid()
    )
  )
  with check (
    staff_id in (
      select s.id from public.payroll_staff s
      join public.payroll_companies c on c.id = s.company_id
      where c.owner_id = auth.uid()
    )
  );

-- ── Audit log: read-only, tamper-proof at the RLS layer ────────────────
-- The original policies had no `for select`, so with no `with check` given,
-- Postgres used the USING clause as the WITH CHECK too — meaning an owner
-- (or an accepted accountant) could UPDATE or DELETE their own company's
-- audit log rows, defeating the entire point of an audit trail. Only the
-- "audit_log_insert" policy should ever allow a write, and rows should never
-- be editable or deletable by anyone through the API.
drop policy if exists "audit_log_owner_read" on public.payroll_audit_log;
drop policy if exists "audit_log_accountant_read" on public.payroll_audit_log;

create policy "audit_log_owner_read" on public.payroll_audit_log
  for select
  using (company_id in (select id from public.payroll_companies where owner_id = auth.uid()));

create policy "audit_log_accountant_read" on public.payroll_audit_log
  for select
  using (company_id in (
    select company_id from public.payroll_accountants where user_id = auth.uid() and status = 'accepted'
  ));

-- ── Accountant invites: an accepted accountant can read their own invite ──
-- row (to claim/display it) but should never be able to write to it —
-- only the owner (accountants_owner_manage) or the claim_accountant_invites()
-- SECURITY DEFINER function should ever change this table.
drop policy if exists "accountants_self_read" on public.payroll_accountants;

create policy "accountants_self_read" on public.payroll_accountants
  for select
  using (user_id = auth.uid());
