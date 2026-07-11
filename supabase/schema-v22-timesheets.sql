-- Timesheets: per-day hours against an optional department/cost-centre and
-- task, feeding a job-costing report. Distinct from overtime_requests
-- (which is "extra hours beyond normal") — this is ordinary worked-hours
-- tracking for cost allocation, the same request/approve shape used
-- throughout (leave, advance, overtime, expense claims).
create table if not exists public.payroll_timesheets (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.payroll_staff(id) on delete cascade,
  company_id uuid not null references public.payroll_companies(id) on delete cascade,
  department_id uuid references public.payroll_departments(id) on delete set null,
  work_date date not null,
  hours numeric(5,2) not null check (hours > 0 and hours <= 24),
  task text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users(id)
);
alter table public.payroll_timesheets enable row level security;

drop policy if exists "timesheets_owner_all" on public.payroll_timesheets;
create policy "timesheets_owner_all" on public.payroll_timesheets
  for all using (public.user_owns_company(company_id)) with check (public.user_owns_company(company_id));

drop policy if exists "timesheets_self_read" on public.payroll_timesheets;
create policy "timesheets_self_read" on public.payroll_timesheets
  for select using (staff_id in (select id from public.payroll_staff where user_id = auth.uid()));

drop policy if exists "timesheets_self_insert" on public.payroll_timesheets;
create policy "timesheets_self_insert" on public.payroll_timesheets
  for insert with check (staff_id in (select id from public.payroll_staff where user_id = auth.uid()));

drop policy if exists "timesheets_manager_select" on public.payroll_timesheets;
create policy "timesheets_manager_select" on public.payroll_timesheets
  for select using (public.is_manager_or_delegate_of(staff_id));
drop policy if exists "timesheets_manager_update" on public.payroll_timesheets;
create policy "timesheets_manager_update" on public.payroll_timesheets
  for update using (public.is_manager_or_delegate_of(staff_id)) with check (public.is_manager_or_delegate_of(staff_id));

grant select, insert, update on public.payroll_timesheets to authenticated;
