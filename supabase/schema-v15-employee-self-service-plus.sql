-- Employee self-service expansion: salary advance requests, company
-- announcements, overtime/timesheet requests, and clock in/out. Follows the
-- same owner-vs-self RLS shape as payroll_leave_requests throughout.

-- ── Salary advance requests (employee-initiated; owner approves) ────────
-- Distinct from record_salary_advance (schema-api-v1.sql), which is the
-- service-role-only RPC that actually writes to payroll_loans once a
-- request is approved — this table is just the request/approval workflow.
create table if not exists public.payroll_advance_requests (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.payroll_staff(id) on delete cascade,
  company_id uuid not null references public.payroll_companies(id) on delete cascade,
  amount numeric(12,2) not null check (amount > 0),
  reason text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users(id)
);
alter table public.payroll_advance_requests enable row level security;

drop policy if exists "advance_requests_owner_all" on public.payroll_advance_requests;
create policy "advance_requests_owner_all" on public.payroll_advance_requests
  for all using (public.user_owns_company(company_id)) with check (public.user_owns_company(company_id));

drop policy if exists "advance_requests_self_read" on public.payroll_advance_requests;
create policy "advance_requests_self_read" on public.payroll_advance_requests
  for select using (staff_id in (select id from public.payroll_staff where user_id = auth.uid()));

drop policy if exists "advance_requests_self_insert" on public.payroll_advance_requests;
create policy "advance_requests_self_insert" on public.payroll_advance_requests
  for insert with check (staff_id in (select id from public.payroll_staff where user_id = auth.uid()));

-- Owner decides a request. On approval, calls the existing loan mechanism
-- (same one the api-v1 EWA endpoint uses) so it's recovered from the next
-- payslip exactly like any other advance.
create or replace function public.decide_advance_request(p_request_id uuid, p_decision text)
returns public.payroll_advance_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req public.payroll_advance_requests;
begin
  if p_decision not in ('approved', 'declined') then
    raise exception 'decision must be approved or declined';
  end if;
  select * into v_req from public.payroll_advance_requests where id = p_request_id;
  if v_req is null then raise exception 'Request not found'; end if;
  if not public.user_owns_company(v_req.company_id) then raise exception 'Not authorised'; end if;
  if v_req.status <> 'pending' then raise exception 'This request has already been decided'; end if;

  update public.payroll_advance_requests
    set status = p_decision, decided_at = now(), decided_by = auth.uid()
    where id = p_request_id
    returning * into v_req;

  if p_decision = 'approved' then
    perform public.record_salary_advance(v_req.company_id, v_req.staff_id, v_req.amount, coalesce(v_req.reason, 'Salary Advance'));
  end if;

  return v_req;
end;
$$;
revoke all on function public.decide_advance_request(uuid, text) from public;
grant execute on function public.decide_advance_request(uuid, text) to authenticated;

-- ── Company announcements (owner posts; every employee reads) ───────────
create table if not exists public.payroll_announcements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.payroll_companies(id) on delete cascade,
  title text not null,
  body text not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
alter table public.payroll_announcements enable row level security;

drop policy if exists "announcements_owner_all" on public.payroll_announcements;
create policy "announcements_owner_all" on public.payroll_announcements
  for all using (public.user_owns_company(company_id)) with check (public.user_owns_company(company_id));

drop policy if exists "announcements_self_read" on public.payroll_announcements;
create policy "announcements_self_read" on public.payroll_announcements
  for select using (
    company_id in (select company_id from public.payroll_staff where user_id = auth.uid())
  );

-- ── Overtime / timesheet requests (employee submits; owner approves) ────
-- Recorded for visibility and approval tracking. Approved hours are not
-- automatically recalculated into a payslip's taxable earnings this pass —
-- that needs a rate/multiplier configuration step per company which is a
-- separate, larger piece of payroll-engine work.
create table if not exists public.payroll_overtime_requests (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.payroll_staff(id) on delete cascade,
  company_id uuid not null references public.payroll_companies(id) on delete cascade,
  work_date date not null,
  hours numeric(5,2) not null check (hours > 0),
  note text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users(id)
);
alter table public.payroll_overtime_requests enable row level security;

drop policy if exists "overtime_requests_owner_all" on public.payroll_overtime_requests;
create policy "overtime_requests_owner_all" on public.payroll_overtime_requests
  for all using (public.user_owns_company(company_id)) with check (public.user_owns_company(company_id));

drop policy if exists "overtime_requests_self_read" on public.payroll_overtime_requests;
create policy "overtime_requests_self_read" on public.payroll_overtime_requests
  for select using (staff_id in (select id from public.payroll_staff where user_id = auth.uid()));

drop policy if exists "overtime_requests_self_insert" on public.payroll_overtime_requests;
create policy "overtime_requests_self_insert" on public.payroll_overtime_requests
  for insert with check (staff_id in (select id from public.payroll_staff where user_id = auth.uid()));

-- ── Clock in/out ──────────────────────────────────────────────────────
-- Timestamp + optional browser-geolocation coordinates (best-effort, never
-- required — the button works even if location is denied).
create table if not exists public.payroll_clock_events (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.payroll_staff(id) on delete cascade,
  company_id uuid not null references public.payroll_companies(id) on delete cascade,
  event_type text not null check (event_type in ('in', 'out')),
  occurred_at timestamptz not null default now(),
  lat numeric(9,6),
  lng numeric(9,6)
);
alter table public.payroll_clock_events enable row level security;

drop policy if exists "clock_events_owner_read" on public.payroll_clock_events;
create policy "clock_events_owner_read" on public.payroll_clock_events
  for select using (public.user_owns_company(company_id));

drop policy if exists "clock_events_self_all" on public.payroll_clock_events;
create policy "clock_events_self_all" on public.payroll_clock_events
  for all using (staff_id in (select id from public.payroll_staff where user_id = auth.uid()))
  with check (staff_id in (select id from public.payroll_staff where user_id = auth.uid()));

grant select, insert on public.payroll_advance_requests to authenticated;
grant select, insert on public.payroll_overtime_requests to authenticated;
grant select on public.payroll_announcements to authenticated;
grant insert, update, delete on public.payroll_announcements to authenticated;
grant select, insert on public.payroll_clock_events to authenticated;
