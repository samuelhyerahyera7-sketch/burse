-- Manager-level approvals + delegation, mirroring Workday's org-hierarchy
-- approval model but kept to one level deep (a staff member's direct
-- manager, not a multi-level escalation chain) to keep this shippable.

alter table public.payroll_staff add column if not exists manager_id uuid references public.payroll_staff(id) on delete set null;

-- ── Approval delegation ("I'm away, route my team's approvals to X") ────
create table if not exists public.payroll_approval_delegations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.payroll_companies(id) on delete cascade,
  delegator_staff_id uuid not null references public.payroll_staff(id) on delete cascade,
  delegate_staff_id uuid not null references public.payroll_staff(id) on delete cascade,
  starts_on date not null,
  ends_on date not null,
  created_at timestamptz not null default now(),
  check (ends_on >= starts_on),
  check (delegator_staff_id <> delegate_staff_id)
);
alter table public.payroll_approval_delegations enable row level security;

drop policy if exists "delegations_owner_all" on public.payroll_approval_delegations;
create policy "delegations_owner_all" on public.payroll_approval_delegations
  for all using (public.user_owns_company(company_id)) with check (public.user_owns_company(company_id));

drop policy if exists "delegations_delegator_all" on public.payroll_approval_delegations;
create policy "delegations_delegator_all" on public.payroll_approval_delegations
  for all using (delegator_staff_id in (select id from public.payroll_staff where user_id = auth.uid()))
  with check (delegator_staff_id in (select id from public.payroll_staff where user_id = auth.uid()));

drop policy if exists "delegations_delegate_read" on public.payroll_approval_delegations;
create policy "delegations_delegate_read" on public.payroll_approval_delegations
  for select using (delegate_staff_id in (select id from public.payroll_staff where user_id = auth.uid()));

grant select, insert, delete on public.payroll_approval_delegations to authenticated;

-- ── Manager-or-active-delegate check, reused across RLS policies ────────
create or replace function public.is_manager_or_delegate_of(p_staff_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.payroll_staff target
    join public.payroll_staff mgr on mgr.id = target.manager_id
    where target.id = p_staff_id
      and (
        mgr.user_id = auth.uid()
        or exists (
          select 1
          from public.payroll_approval_delegations d
          join public.payroll_staff dele on dele.id = d.delegate_staff_id
          where d.delegator_staff_id = mgr.id
            and dele.user_id = auth.uid()
            and current_date between d.starts_on and d.ends_on
        )
      )
  );
$$;
grant execute on function public.is_manager_or_delegate_of(uuid) to authenticated;

-- ── Extend RLS: managers (and their active delegates) can see/decide
-- their direct reports' requests, alongside the existing owner/self rules ──
drop policy if exists "leave_requests_manager_select" on public.payroll_leave_requests;
create policy "leave_requests_manager_select" on public.payroll_leave_requests
  for select using (public.is_manager_or_delegate_of(staff_id));
drop policy if exists "leave_requests_manager_update" on public.payroll_leave_requests;
create policy "leave_requests_manager_update" on public.payroll_leave_requests
  for update using (public.is_manager_or_delegate_of(staff_id)) with check (public.is_manager_or_delegate_of(staff_id));

drop policy if exists "advance_requests_manager_select" on public.payroll_advance_requests;
create policy "advance_requests_manager_select" on public.payroll_advance_requests
  for select using (public.is_manager_or_delegate_of(staff_id));

drop policy if exists "overtime_requests_manager_select" on public.payroll_overtime_requests;
create policy "overtime_requests_manager_select" on public.payroll_overtime_requests
  for select using (public.is_manager_or_delegate_of(staff_id));
drop policy if exists "overtime_requests_manager_update" on public.payroll_overtime_requests;
create policy "overtime_requests_manager_update" on public.payroll_overtime_requests
  for update using (public.is_manager_or_delegate_of(staff_id)) with check (public.is_manager_or_delegate_of(staff_id));

drop policy if exists "leave_balances_manager_select" on public.payroll_leave_balances;
create policy "leave_balances_manager_select" on public.payroll_leave_balances
  for select using (public.is_manager_or_delegate_of(staff_id));
drop policy if exists "leave_balances_manager_update" on public.payroll_leave_balances;
create policy "leave_balances_manager_update" on public.payroll_leave_balances
  for update using (public.is_manager_or_delegate_of(staff_id)) with check (public.is_manager_or_delegate_of(staff_id));

-- decide_advance_request: extend authorisation to managers/delegates, not just the owner
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
  if not (public.user_owns_company(v_req.company_id) or public.is_manager_or_delegate_of(v_req.staff_id)) then
    raise exception 'Not authorised';
  end if;
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
