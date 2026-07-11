-- ============================================================
-- BURSE BOOKKEEPING — v5: vendor bills, partial invoice payments,
-- estimates/quotes, recurring invoices.
-- Mirrors QuickBooks' "Enter Bill" / "Pay Bills" flow (Accounts Payable
-- side, distinct from an immediate cash bk_expenses row), lets an
-- invoice be paid in instalments instead of only all-or-nothing, and
-- adds quote-to-invoice conversion + recurring invoice templates.
-- Run AFTER schema-bookkeeping-v4-customers-vendors.sql.
-- ============================================================

-- ── Vendor bills (Accounts Payable) ──────────────────────────────────
create table if not exists public.bk_bills (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid references public.payroll_companies(id) on delete cascade not null,
  vendor_id         uuid references public.bk_vendors(id) on delete set null,
  vendor_name       text not null,
  bill_number       text,
  bill_date         date not null default current_date,
  due_date          date,
  account_id        uuid references public.bk_accounts(id) not null,
  amount            numeric(12,2) not null default 0,
  vat_amount        numeric(12,2) not null default 0,
  total             numeric(12,2) not null default 0,
  amount_paid       numeric(12,2) not null default 0,
  status            text not null default 'open' check (status in ('open','partial','paid')),
  description       text,
  bill_journal_id   uuid references public.bk_journal_entries(id),
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

create table if not exists public.bk_bill_payments (
  id            uuid primary key default gen_random_uuid(),
  bill_id       uuid references public.bk_bills(id) on delete cascade not null,
  paid_date     date not null default current_date,
  amount        numeric(12,2) not null check (amount > 0),
  journal_id    uuid references public.bk_journal_entries(id),
  created_at    timestamptz default now()
);

-- ── Partial invoice payments ──────────────────────────────────────────
create table if not exists public.bk_invoice_payments (
  id            uuid primary key default gen_random_uuid(),
  invoice_id    uuid references public.bk_invoices(id) on delete cascade not null,
  paid_date     date not null default current_date,
  amount        numeric(12,2) not null check (amount > 0),
  journal_id    uuid references public.bk_journal_entries(id),
  created_at    timestamptz default now()
);
alter table public.bk_invoices add column if not exists amount_paid numeric(12,2) not null default 0;
alter table public.bk_invoices drop constraint if exists bk_invoices_status_check;
-- status now also allows 'partial'

-- ── Estimates / quotes ─────────────────────────────────────────────────
create table if not exists public.bk_estimates (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid references public.payroll_companies(id) on delete cascade not null,
  customer_id       uuid references public.bk_customers(id) on delete set null,
  customer_name     text not null,
  customer_email    text,
  estimate_number   text not null,
  issue_date        date not null default current_date,
  expiry_date       date,
  status            text not null default 'draft' check (status in ('draft','sent','accepted','declined','converted')),
  subtotal          numeric(12,2) not null default 0,
  vat_amount        numeric(12,2) not null default 0,
  total             numeric(12,2) not null default 0,
  notes             text,
  converted_invoice_id uuid references public.bk_invoices(id),
  created_at        timestamptz default now(),
  unique (company_id, estimate_number)
);
create table if not exists public.bk_estimate_lines (
  id            uuid primary key default gen_random_uuid(),
  estimate_id   uuid references public.bk_estimates(id) on delete cascade not null,
  description   text not null,
  quantity      numeric(10,2) not null default 1,
  unit_price    numeric(12,2) not null default 0,
  vat_rate      numeric(5,2) not null default 15,
  line_total    numeric(12,2) not null default 0
);

-- ── Recurring invoice templates ────────────────────────────────────────
create table if not exists public.bk_recurring_invoices (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid references public.payroll_companies(id) on delete cascade not null,
  customer_id       uuid references public.bk_customers(id) on delete set null,
  customer_name     text not null,
  customer_email    text,
  frequency         text not null check (frequency in ('weekly','monthly')),
  next_run_date     date not null,
  active            boolean not null default true,
  lines             jsonb not null,   -- [{description, quantity, unit_price, vat_rate}]
  last_generated_invoice_id uuid references public.bk_invoices(id),
  created_at        timestamptz default now()
);

create index if not exists idx_bk_bills_company on public.bk_bills(company_id, bill_date);
create index if not exists idx_bk_bill_payments_bill on public.bk_bill_payments(bill_id);
create index if not exists idx_bk_invoice_payments_invoice on public.bk_invoice_payments(invoice_id);
create index if not exists idx_bk_estimates_company on public.bk_estimates(company_id, issue_date);
create index if not exists idx_bk_estimate_lines_estimate on public.bk_estimate_lines(estimate_id);
create index if not exists idx_bk_recurring_company on public.bk_recurring_invoices(company_id);

alter table public.bk_bills enable row level security;
alter table public.bk_bill_payments enable row level security;
alter table public.bk_invoice_payments enable row level security;
alter table public.bk_estimates enable row level security;
alter table public.bk_estimate_lines enable row level security;
alter table public.bk_recurring_invoices enable row level security;

drop policy if exists "bk_bills_owner_all" on public.bk_bills;
create policy "bk_bills_owner_all" on public.bk_bills
  for all using (public.user_owns_company(company_id)) with check (public.user_owns_company(company_id));

drop policy if exists "bk_bill_payments_owner_all" on public.bk_bill_payments;
create policy "bk_bill_payments_owner_all" on public.bk_bill_payments
  for all
  using (bill_id in (select id from public.bk_bills where public.user_owns_company(company_id)))
  with check (bill_id in (select id from public.bk_bills where public.user_owns_company(company_id)));

drop policy if exists "bk_invoice_payments_owner_all" on public.bk_invoice_payments;
create policy "bk_invoice_payments_owner_all" on public.bk_invoice_payments
  for all
  using (invoice_id in (select id from public.bk_invoices where public.user_owns_company(company_id)))
  with check (invoice_id in (select id from public.bk_invoices where public.user_owns_company(company_id)));

drop policy if exists "bk_estimates_owner_all" on public.bk_estimates;
create policy "bk_estimates_owner_all" on public.bk_estimates
  for all using (public.user_owns_company(company_id)) with check (public.user_owns_company(company_id));

drop policy if exists "bk_estimate_lines_owner_all" on public.bk_estimate_lines;
create policy "bk_estimate_lines_owner_all" on public.bk_estimate_lines
  for all
  using (estimate_id in (select id from public.bk_estimates where public.user_owns_company(company_id)))
  with check (estimate_id in (select id from public.bk_estimates where public.user_owns_company(company_id)));

drop policy if exists "bk_recurring_owner_all" on public.bk_recurring_invoices;
create policy "bk_recurring_owner_all" on public.bk_recurring_invoices
  for all using (public.user_owns_company(company_id)) with check (public.user_owns_company(company_id));

grant select, insert, update, delete on public.bk_bills to authenticated;
grant select, insert, update, delete on public.bk_bill_payments to authenticated;
grant select, insert, update, delete on public.bk_invoice_payments to authenticated;
grant select, insert, update, delete on public.bk_estimates to authenticated;
grant select, insert, update, delete on public.bk_estimate_lines to authenticated;
grant select, insert, update, delete on public.bk_recurring_invoices to authenticated;

-- ── Enter a bill: Dr Expense account (+ Dr VAT Payable), Cr Accounts Payable ──
create or replace function public.record_bill(
  p_company_id uuid, p_vendor_id uuid, p_vendor_name text, p_bill_number text,
  p_bill_date date, p_due_date date, p_account_id uuid, p_amount numeric, p_vat_amount numeric, p_description text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ap uuid; v_vat uuid;
  v_entry_id uuid; v_bill_id uuid;
  v_lines jsonb;
  v_total numeric;
begin
  if not public.user_owns_company(p_company_id) then
    raise exception 'Not authorised for this company';
  end if;

  select id into v_ap from public.bk_accounts where company_id = p_company_id and code = '2000';
  select id into v_vat from public.bk_accounts where company_id = p_company_id and code = '2400';
  v_total := coalesce(p_amount, 0) + coalesce(p_vat_amount, 0);

  insert into public.bk_bills (company_id, vendor_id, vendor_name, bill_number, bill_date, due_date, account_id, amount, vat_amount, total, description)
  values (p_company_id, p_vendor_id, p_vendor_name, p_bill_number, coalesce(p_bill_date, current_date), p_due_date, p_account_id, p_amount, coalesce(p_vat_amount,0), v_total, p_description)
  returning id into v_bill_id;

  v_lines := jsonb_build_array(jsonb_build_object('account_id', p_account_id, 'debit', p_amount, 'credit', 0, 'description', p_vendor_name));
  if coalesce(p_vat_amount, 0) > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', v_vat, 'debit', p_vat_amount, 'credit', 0, 'description', 'Input VAT — ' || p_vendor_name));
  end if;
  v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', v_ap, 'debit', 0, 'credit', v_total, 'description', 'Bill — ' || p_vendor_name));

  v_entry_id := public.post_journal_entry(p_company_id, coalesce(p_bill_date, current_date), 'Bill — ' || p_vendor_name, 'bill', v_bill_id, v_lines);
  update public.bk_bills set bill_journal_id = v_entry_id where id = v_bill_id;
  return v_bill_id;
end;
$$;

-- ── Pay a bill (in full or in part): Dr Accounts Payable, Cr Bank ──────
create or replace function public.pay_bill(p_bill_id uuid, p_paid_date date, p_amount numeric)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bill record;
  v_ap uuid; v_bank uuid;
  v_entry_id uuid;
  v_new_paid numeric;
begin
  select * into v_bill from public.bk_bills where id = p_bill_id;
  if v_bill is null or not public.user_owns_company(v_bill.company_id) then
    raise exception 'Bill not found';
  end if;
  if v_bill.status = 'paid' then
    raise exception 'This bill is already fully paid';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Enter a payment amount greater than zero';
  end if;
  v_new_paid := v_bill.amount_paid + p_amount;
  if v_new_paid > v_bill.total + 0.01 then
    raise exception 'Payment of % exceeds the outstanding balance of %', p_amount, (v_bill.total - v_bill.amount_paid);
  end if;

  select id into v_ap from public.bk_accounts where company_id = v_bill.company_id and code = '2000';
  select id into v_bank from public.bk_accounts where company_id = v_bill.company_id and code = '1000';

  v_entry_id := public.post_journal_entry(
    v_bill.company_id, coalesce(p_paid_date, current_date), 'Payment on bill — ' || v_bill.vendor_name,
    'bill_payment', gen_random_uuid(),
    jsonb_build_array(
      jsonb_build_object('account_id', v_ap, 'debit', p_amount, 'credit', 0, 'description', 'Bill — ' || v_bill.vendor_name),
      jsonb_build_object('account_id', v_bank, 'debit', 0, 'credit', p_amount, 'description', 'Bill — ' || v_bill.vendor_name)
    )
  );

  insert into public.bk_bill_payments (bill_id, paid_date, amount, journal_id) values (p_bill_id, coalesce(p_paid_date, current_date), p_amount, v_entry_id);
  update public.bk_bills set amount_paid = v_new_paid, status = (case when v_new_paid >= v_bill.total - 0.01 then 'paid' else 'partial' end), updated_at = now() where id = p_bill_id;
  return v_entry_id;
end;
$$;

-- ── Record a (possibly partial) payment against an invoice ────────────
create or replace function public.record_invoice_payment(p_invoice_id uuid, p_paid_date date, p_amount numeric)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inv record;
  v_ar uuid; v_bank uuid;
  v_entry_id uuid;
  v_new_paid numeric;
begin
  select * into v_inv from public.bk_invoices where id = p_invoice_id;
  if v_inv is null or not public.user_owns_company(v_inv.company_id) then
    raise exception 'Invoice not found';
  end if;
  if v_inv.status not in ('sent','overdue','partial') then
    raise exception 'This invoice cannot take a payment right now';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Enter a payment amount greater than zero';
  end if;
  v_new_paid := v_inv.amount_paid + p_amount;
  if v_new_paid > v_inv.total + 0.01 then
    raise exception 'Payment of % exceeds the outstanding balance of %', p_amount, (v_inv.total - v_inv.amount_paid);
  end if;

  select id into v_ar from public.bk_accounts where company_id = v_inv.company_id and code = '1100';
  select id into v_bank from public.bk_accounts where company_id = v_inv.company_id and code = '1000';

  v_entry_id := public.post_journal_entry(
    v_inv.company_id, coalesce(p_paid_date, current_date), 'Payment received for invoice ' || v_inv.invoice_number,
    'invoice_payment', gen_random_uuid(),
    jsonb_build_array(
      jsonb_build_object('account_id', v_bank, 'debit', p_amount, 'credit', 0, 'description', 'Invoice ' || v_inv.invoice_number),
      jsonb_build_object('account_id', v_ar, 'debit', 0, 'credit', p_amount, 'description', 'Invoice ' || v_inv.invoice_number)
    )
  );

  insert into public.bk_invoice_payments (invoice_id, paid_date, amount, journal_id) values (p_invoice_id, coalesce(p_paid_date, current_date), p_amount, v_entry_id);
  update public.bk_invoices set amount_paid = v_new_paid, status = (case when v_new_paid >= v_inv.total - 0.01 then 'paid' else 'partial' end), paid_journal_id = v_entry_id, updated_at = now() where id = p_invoice_id;
  return v_entry_id;
end;
$$;

-- ── Convert an accepted estimate into a draft invoice ──────────────────
create or replace function public.convert_estimate_to_invoice(p_estimate_id uuid, p_invoice_number text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_est record;
  v_inv_id uuid;
begin
  select * into v_est from public.bk_estimates where id = p_estimate_id;
  if v_est is null or not public.user_owns_company(v_est.company_id) then
    raise exception 'Estimate not found';
  end if;
  if v_est.status = 'converted' then
    raise exception 'This estimate has already been converted';
  end if;

  insert into public.bk_invoices (company_id, customer_id, invoice_number, customer_name, customer_email, issue_date, due_date, subtotal, vat_amount, total)
  values (v_est.company_id, v_est.customer_id, p_invoice_number, v_est.customer_name, v_est.customer_email, current_date, current_date + 30, v_est.subtotal, v_est.vat_amount, v_est.total)
  returning id into v_inv_id;

  insert into public.bk_invoice_lines (invoice_id, description, quantity, unit_price, vat_rate, line_total)
  select v_inv_id, description, quantity, unit_price, vat_rate, line_total from public.bk_estimate_lines where estimate_id = p_estimate_id;

  update public.bk_estimates set status = 'converted', converted_invoice_id = v_inv_id where id = p_estimate_id;
  return v_inv_id;
end;
$$;

revoke all on function public.record_bill(uuid, uuid, text, text, date, date, uuid, numeric, numeric, text) from public, anon;
revoke all on function public.pay_bill(uuid, date, numeric) from public, anon;
revoke all on function public.record_invoice_payment(uuid, date, numeric) from public, anon;
revoke all on function public.convert_estimate_to_invoice(uuid, text) from public, anon;
grant execute on function public.record_bill(uuid, uuid, text, text, date, date, uuid, numeric, numeric, text) to authenticated;
grant execute on function public.pay_bill(uuid, date, numeric) to authenticated;
grant execute on function public.record_invoice_payment(uuid, date, numeric) to authenticated;
grant execute on function public.convert_estimate_to_invoice(uuid, text) to authenticated;
