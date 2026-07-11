-- ============================================================
-- BOOKKEEPING v8: bank statement import + reconciliation.
-- Employer uploads a CSV bank statement; each line becomes an unmatched
-- transaction they can match against an existing bk_journal_lines entry
-- on the Bank account (1000), or mark as ignored (e.g. an internal
-- transfer that never needs a journal entry). This is deliberately a
-- manual-match tool, not a live bank feed — no bank credentials touch
-- Burse. Run AFTER schema-bookkeeping-v7-cron-issue-invoice.sql.
-- ============================================================

create table if not exists public.bk_bank_transactions (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid references public.payroll_companies(id) on delete cascade not null,
  txn_date              date not null,
  description           text not null,
  amount                numeric(12,2) not null,   -- positive = money in, negative = money out
  status                text not null default 'unmatched' check (status in ('unmatched','matched','ignored')),
  matched_journal_line_id uuid references public.bk_journal_lines(id) on delete set null,
  imported_at           timestamptz default now()
);

create index if not exists idx_bk_bank_txns_company on public.bk_bank_transactions(company_id, txn_date);

alter table public.bk_bank_transactions enable row level security;
drop policy if exists "bk_bank_txns_owner_all" on public.bk_bank_transactions;
create policy "bk_bank_txns_owner_all" on public.bk_bank_transactions
  for all using (public.user_owns_company(company_id)) with check (public.user_owns_company(company_id));

grant select, insert, update, delete on public.bk_bank_transactions to authenticated;
