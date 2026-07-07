-- ============================================================
-- BURSE BOOKKEEPING — v2: invoices + expenses
-- Both post to the same double-entry journal from v1. VAT is kept as a
-- single netting control account (2400 VAT Payable) — invoices credit
-- it with output VAT owed, expenses debit it with input VAT reclaimed.
-- This is a standard simplified approach for small-business books; a
-- full VAT201 return needs more granularity and is deliberately out of
-- scope for this pass. Run this in Supabase → SQL Editor AFTER
-- schema-bookkeeping-v1.sql.
-- ============================================================

create table if not exists public.bk_invoices (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid references public.payroll_companies(id) on delete cascade not null,
  invoice_number    text not null,
  customer_name     text not null,
  customer_email    text,
  issue_date        date not null default current_date,
  due_date          date,
  status            text not null default 'draft',   -- draft | sent | paid | overdue | void
  subtotal          numeric(12,2) not null default 0,
  vat_amount        numeric(12,2) not null default 0,
  total             numeric(12,2) not null default 0,
  notes             text,
  issue_journal_id  uuid references public.bk_journal_entries(id),
  paid_journal_id   uuid references public.bk_journal_entries(id),
  created_at        timestamptz default now(),
  updated_at        timestamptz default now(),
  unique (company_id, invoice_number)
);

create table if not exists public.bk_invoice_lines (
  id            uuid primary key default gen_random_uuid(),
  invoice_id    uuid references public.bk_invoices(id) on delete cascade not null,
  description   text not null,
  quantity      numeric(10,2) not null default 1,
  unit_price    numeric(12,2) not null default 0,
  vat_rate      numeric(5,2) not null default 15,   -- SA standard VAT rate %
  line_total    numeric(12,2) not null default 0
);

create table if not exists public.bk_expenses (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid references public.payroll_companies(id) on delete cascade not null,
  expense_date  date not null default current_date,
  vendor        text not null,
  account_id    uuid references public.bk_accounts(id) not null,
  amount        numeric(12,2) not null default 0,    -- net of VAT
  vat_amount    numeric(12,2) not null default 0,
  description   text,
  journal_id    uuid references public.bk_journal_entries(id),
  created_at    timestamptz default now()
);

create index if not exists idx_bk_invoices_company on public.bk_invoices(company_id, issue_date);
create index if not exists idx_bk_invoice_lines_invoice on public.bk_invoice_lines(invoice_id);
create index if not exists idx_bk_expenses_company on public.bk_expenses(company_id, expense_date);

alter table public.bk_invoices enable row level security;
alter table public.bk_invoice_lines enable row level security;
alter table public.bk_expenses enable row level security;

create policy "bk_invoices_owner_all" on public.bk_invoices
  for all using (public.user_owns_company(company_id)) with check (public.user_owns_company(company_id));

create policy "bk_invoice_lines_owner_all" on public.bk_invoice_lines
  for all
  using (invoice_id in (select id from public.bk_invoices where public.user_owns_company(company_id)))
  with check (invoice_id in (select id from public.bk_invoices where public.user_owns_company(company_id)));

create policy "bk_expenses_owner_all" on public.bk_expenses
  for all using (public.user_owns_company(company_id)) with check (public.user_owns_company(company_id));

-- ── Issue an invoice: Dr Accounts Receivable, Cr Sales Revenue, Cr VAT Payable ──
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

  update public.bk_invoices set status = 'sent', issue_journal_id = v_entry_id, updated_at = now() where id = p_invoice_id;
  return v_entry_id;
end;
$$;

-- ── Mark an invoice paid: Dr Bank, Cr Accounts Receivable ────────────────
create or replace function public.mark_invoice_paid(p_invoice_id uuid, p_paid_date date)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inv record;
  v_ar uuid; v_bank uuid;
  v_entry_id uuid;
begin
  select * into v_inv from public.bk_invoices where id = p_invoice_id;
  if v_inv is null or not public.user_owns_company(v_inv.company_id) then
    raise exception 'Invoice not found';
  end if;
  if v_inv.status not in ('sent', 'overdue') then
    raise exception 'Only a sent invoice can be marked paid';
  end if;

  select id into v_ar from public.bk_accounts where company_id = v_inv.company_id and code = '1100';
  select id into v_bank from public.bk_accounts where company_id = v_inv.company_id and code = '1000';

  v_entry_id := public.post_journal_entry(
    v_inv.company_id, coalesce(p_paid_date, current_date), 'Payment received for invoice ' || v_inv.invoice_number,
    'invoice_payment', p_invoice_id,
    jsonb_build_array(
      jsonb_build_object('account_id', v_bank, 'debit', v_inv.total, 'credit', 0, 'description', 'Invoice ' || v_inv.invoice_number || ' paid'),
      jsonb_build_object('account_id', v_ar, 'debit', 0, 'credit', v_inv.total, 'description', 'Invoice ' || v_inv.invoice_number || ' paid')
    )
  );

  update public.bk_invoices set status = 'paid', paid_journal_id = v_entry_id, updated_at = now() where id = p_invoice_id;
  return v_entry_id;
end;
$$;

-- ── Record an expense: Dr Expense account (+ Dr VAT Payable for input VAT), Cr Bank ──
create or replace function public.record_expense(
  p_company_id uuid, p_expense_date date, p_vendor text, p_account_id uuid,
  p_amount numeric, p_vat_amount numeric, p_description text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bank uuid; v_vat uuid;
  v_entry_id uuid; v_expense_id uuid;
  v_lines jsonb;
  v_total numeric;
begin
  if not public.user_owns_company(p_company_id) then
    raise exception 'Not authorised for this company';
  end if;

  select id into v_bank from public.bk_accounts where company_id = p_company_id and code = '1000';
  select id into v_vat from public.bk_accounts where company_id = p_company_id and code = '2400';
  v_total := coalesce(p_amount, 0) + coalesce(p_vat_amount, 0);

  v_lines := jsonb_build_array(jsonb_build_object('account_id', p_account_id, 'debit', p_amount, 'credit', 0, 'description', p_vendor));
  if coalesce(p_vat_amount, 0) > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', v_vat, 'debit', p_vat_amount, 'credit', 0, 'description', 'Input VAT — ' || p_vendor));
  end if;
  v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', v_bank, 'debit', 0, 'credit', v_total, 'description', p_vendor));

  insert into public.bk_expenses (company_id, expense_date, vendor, account_id, amount, vat_amount, description)
  values (p_company_id, coalesce(p_expense_date, current_date), p_vendor, p_account_id, p_amount, coalesce(p_vat_amount, 0), p_description)
  returning id into v_expense_id;

  v_entry_id := public.post_journal_entry(p_company_id, coalesce(p_expense_date, current_date), 'Expense — ' || p_vendor, 'expense', v_expense_id, v_lines);

  update public.bk_expenses set journal_id = v_entry_id where id = v_expense_id;
  return v_expense_id;
end;
$$;

revoke all on function public.issue_invoice(uuid) from public, anon;
revoke all on function public.mark_invoice_paid(uuid, date) from public, anon;
revoke all on function public.record_expense(uuid, date, text, uuid, numeric, numeric, text) from public, anon;
grant execute on function public.issue_invoice(uuid) to authenticated;
grant execute on function public.mark_invoice_paid(uuid, date) to authenticated;
grant execute on function public.record_expense(uuid, date, text, uuid, numeric, numeric, text) to authenticated;
