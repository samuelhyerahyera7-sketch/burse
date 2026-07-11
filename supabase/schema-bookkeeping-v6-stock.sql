-- ============================================================
-- BURSE BOOKKEEPING — v6: stock / inventory items
-- Simple perpetual inventory: an item has a sales price, a cost price,
-- and a quantity on hand. Invoice lines can optionally reference an
-- item (item_id) — issuing that invoice then decrements stock.
-- Deliberately no warehouses/locations/serial tracking — out of scope
-- for a small-business first pass. Run AFTER schema-bookkeeping-v5.
-- ============================================================

create table if not exists public.bk_items (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid references public.payroll_companies(id) on delete cascade not null,
  sku               text,
  name              text not null,
  sales_price       numeric(12,2) not null default 0,
  cost_price        numeric(12,2) not null default 0,
  vat_rate          numeric(5,2) not null default 15,
  quantity_on_hand  numeric(12,2) not null default 0,
  reorder_level     numeric(12,2) not null default 0,
  archived          boolean not null default false,
  created_at        timestamptz default now()
);

alter table public.bk_invoice_lines add column if not exists item_id uuid references public.bk_items(id) on delete set null;

create table if not exists public.bk_stock_adjustments (
  id            uuid primary key default gen_random_uuid(),
  item_id       uuid references public.bk_items(id) on delete cascade not null,
  quantity_delta numeric(12,2) not null,
  reason        text,
  created_by    uuid references auth.users(id),
  created_at    timestamptz default now()
);

create index if not exists idx_bk_items_company on public.bk_items(company_id);
create index if not exists idx_bk_stock_adjustments_item on public.bk_stock_adjustments(item_id);

alter table public.bk_items enable row level security;
alter table public.bk_stock_adjustments enable row level security;

drop policy if exists "bk_items_owner_all" on public.bk_items;
create policy "bk_items_owner_all" on public.bk_items
  for all using (public.user_owns_company(company_id)) with check (public.user_owns_company(company_id));

drop policy if exists "bk_stock_adjustments_owner_all" on public.bk_stock_adjustments;
create policy "bk_stock_adjustments_owner_all" on public.bk_stock_adjustments
  for all
  using (item_id in (select id from public.bk_items where public.user_owns_company(company_id)))
  with check (item_id in (select id from public.bk_items where public.user_owns_company(company_id)));

grant select, insert, update, delete on public.bk_items to authenticated;
grant select, insert, update, delete on public.bk_stock_adjustments to authenticated;

create or replace function public.adjust_stock(p_item_id uuid, p_quantity_delta numeric, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
begin
  select company_id into v_company_id from public.bk_items where id = p_item_id;
  if v_company_id is null or not public.user_owns_company(v_company_id) then
    raise exception 'Item not found';
  end if;
  update public.bk_items set quantity_on_hand = quantity_on_hand + p_quantity_delta where id = p_item_id;
  insert into public.bk_stock_adjustments (item_id, quantity_delta, reason, created_by) values (p_item_id, p_quantity_delta, p_reason, auth.uid());
end;
$$;

-- ── Extend issue_invoice to decrement stock for lines tied to an item ──
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
  if v_inv is null or not public.user_owns_company(v_inv.company_id) then
    raise exception 'Invoice not found';
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

revoke all on function public.adjust_stock(uuid, numeric, text) from public, anon;
grant execute on function public.adjust_stock(uuid, numeric, text) to authenticated;
