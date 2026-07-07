-- ============================================================
-- BURSE PAYROLL — v10: employee self-service contact/banking updates
-- Employees previously had no way to update their own phone, email or
-- bank details — payroll_staff's RLS "with check" only ever allowed the
-- company owner to write to the table, so even if the UI had a form for
-- it, the update would silently fail (0 rows affected). This adds a
-- narrow, audited RPC that lets an employee touch ONLY those columns on
-- their OWN row — never salary, tax fields, or another employee's row.
-- Run this in Supabase → SQL Editor AFTER schema-payroll-v9-integration-connections.sql.
-- ============================================================

create or replace function public.update_my_staff_details(
  p_phone text,
  p_email text,
  p_bank_name text,
  p_bank_account_number text,
  p_bank_branch_code text,
  p_account_type text
)
returns public.payroll_staff
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.payroll_staff;
  v_before jsonb;
begin
  select to_jsonb(s) into v_before from public.payroll_staff s where s.user_id = auth.uid();
  if v_before is null then
    raise exception 'No employee record found for this account';
  end if;

  update public.payroll_staff
  set
    phone = nullif(trim(p_phone), ''),
    email = nullif(trim(p_email), ''),
    bank_name = nullif(trim(p_bank_name), ''),
    bank_account_number = nullif(trim(p_bank_account_number), ''),
    bank_branch_code = nullif(trim(p_bank_branch_code), ''),
    account_type = coalesce(nullif(trim(p_account_type), ''), 'Savings'),
    updated_at = now()
  where user_id = auth.uid()
  returning * into v_row;

  insert into public.payroll_audit_log (company_id, actor_id, action, meta)
  values (
    v_row.company_id, auth.uid(), 'staff_self_updated_details',
    jsonb_build_object(
      'staff_id', v_row.id,
      'staff_name', v_row.full_name,
      'bank_changed', (v_before->>'bank_account_number') is distinct from v_row.bank_account_number,
      'contact_changed', (v_before->>'phone') is distinct from v_row.phone or (v_before->>'email') is distinct from v_row.email
    )
  );

  return v_row;
end;
$$;

revoke all on function public.update_my_staff_details(text, text, text, text, text, text) from public, anon;
grant execute on function public.update_my_staff_details(text, text, text, text, text, text) to authenticated;
