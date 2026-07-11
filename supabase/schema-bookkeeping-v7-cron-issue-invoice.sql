-- ============================================================
-- BURSE BOOKKEEPING — v7: let the recurring-invoice-generator cron
-- (which calls issue_invoice using the service-role key, with no user
-- JWT) issue invoices without tripping the owner-only check. Mirrors
-- the same service-role bypass pattern payroll-engine uses for its
-- cron caller. Run AFTER schema-bookkeeping-v6-stock.sql.
-- ============================================================

create or replace function public.issue_invoice(p_invoice_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inv record;
  v_ar uuid; v_rev uuid; v_vat uuid;
  v_entry_id uuid;
  v_lines jsonb;
  v_line record;
begin
  select * into v_inv from public.bk_invoices where id = p_invoice_id;
  if v_inv is null then
    raise exception 'Invoice not found';
  end if;
  if not (public.user_owns_company(v_inv.company_id) or auth.role() = 'service_role') then
    raise exception 'Not authorised for this company';
  end if;
  if v_inv.status != 'draft' then
    raise exception 'Only a draft invoice can be issued';
  end if;

  select id into v_ar from public.bk_accounts where company_id = v_inv.company_id and code = '1100';
  select id into v_rev from public.bk_accounts where company_id = v_inv.company_id and code = '4000';
  select id into v_vat from public.bk_accounts where company_id = v_inv.company_id and code = '2400';

  v_lines := jsonb_build_array(
    jsonb_build_object('account_id', v_ar, 'debit', v_inv.total, 'credit', 0, 'description', 'Invoice ' || v_inv.invoice_number),
    jsonb_build_object('account_id', v_rev, 'debit', 0, 'credit', v_inv.subtotal, 'description', 'Invoice ' || v_inv.invoice_number)
  );
  if v_inv.vat_amount > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', v_vat, 'debit', 0, 'credit', v_inv.vat_amount, 'description', 'Output VAT on ' || v_inv.invoice_number));
  end if;

  v_entry_id := public.post_journal_entry(v_inv.company_id, v_inv.issue_date, 'Invoice ' || v_inv.invoice_number || ' issued', 'invoice', p_invoice_id, v_lines);

  for v_line in select item_id, quantity from public.bk_invoice_lines where invoice_id = p_invoice_id and item_id is not null loop
    update public.bk_items set quantity_on_hand = quantity_on_hand - v_line.quantity where id = v_line.item_id;
    insert into public.bk_stock_adjustments (item_id, quantity_delta, reason) values (v_line.item_id, -v_line.quantity, 'Invoice ' || v_inv.invoice_number);
  end loop;

  update public.bk_invoices set status = 'sent', issue_journal_id = v_entry_id, updated_at = now() where id = p_invoice_id;
  return v_entry_id;
end;
$$;

-- post_journal_entry is called internally by issue_invoice above and
-- also needs the same bypass, since it independently re-checks ownership.
create or replace function public.post_journal_entry(
  p_company_id uuid,
  p_entry_date date,
  p_description text,
  p_source text,
  p_source_id uuid,
  p_lines jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry_id uuid;
  v_total_debit numeric(14,2) := 0;
  v_total_credit numeric(14,2) := 0;
  v_line jsonb;
begin
  if not (public.user_owns_company(p_company_id) or auth.role() = 'service_role') then
    raise exception 'Not authorised for this company';
  end if;
  if jsonb_array_length(p_lines) < 2 then
    raise exception 'A journal entry needs at least two lines';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_total_debit := v_total_debit + coalesce((v_line->>'debit')::numeric, 0);
    v_total_credit := v_total_credit + coalesce((v_line->>'credit')::numeric, 0);
  end loop;

  if round(v_total_debit, 2) != round(v_total_credit, 2) then
    raise exception 'Journal entry does not balance: debits %, credits %', v_total_debit, v_total_credit;
  end if;

  insert into public.bk_journal_entries (company_id, entry_date, description, source, source_id, created_by)
  values (p_company_id, coalesce(p_entry_date, current_date), coalesce(p_description, ''), coalesce(p_source, 'manual'), p_source_id, auth.uid())
  returning id into v_entry_id;

  insert into public.bk_journal_lines (entry_id, account_id, debit, credit, description)
  select
    v_entry_id,
    (elem->>'account_id')::uuid,
    coalesce((elem->>'debit')::numeric, 0),
    coalesce((elem->>'credit')::numeric, 0),
    elem->>'description'
  from jsonb_array_elements(p_lines) as elem;

  return v_entry_id;
end;
$$;
