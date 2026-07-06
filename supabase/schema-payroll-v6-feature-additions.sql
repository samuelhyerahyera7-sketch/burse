-- ============================================================
-- BURSE PAYROLL — v6: feature additions
-- Supports: mark payslip as sent, company bank reference + notification
-- preferences, and employee document uploads. Run this in Supabase → SQL
-- Editor AFTER schema-payroll-v5-fix-rls-recursion.sql.
-- ============================================================

-- ── Payslips: track when a payslip was emailed / manually marked as sent ──
alter table public.payroll_payslips add column if not exists sent_at timestamptz;
alter table public.payroll_payslips add column if not exists sent_to text;

-- ── Companies: reference bank account (informational — Burse never moves
-- money; payment still happens via the owner's own business banking using
-- the exported CSV) + notification preferences ──────────────────────────
alter table public.payroll_companies add column if not exists bank_name text;
alter table public.payroll_companies add column if not exists bank_account_number text;
alter table public.payroll_companies add column if not exists bank_branch_code text;
alter table public.payroll_companies add column if not exists notification_prefs jsonb default '{
  "payroll_approved": true,
  "leave_requested": true,
  "accountant_invited": true
}'::jsonb;

-- ── Employee documents (metadata; files live in Supabase Storage) ───────
create table if not exists public.payroll_staff_documents (
  id            uuid primary key default gen_random_uuid(),
  staff_id      uuid references public.payroll_staff(id) on delete cascade not null,
  company_id    uuid references public.payroll_companies(id) on delete cascade not null,
  file_name     text not null,
  storage_path  text not null,
  content_type  text,
  size_bytes    bigint,
  uploaded_by   uuid references auth.users(id),
  uploaded_at   timestamptz default now()
);

alter table public.payroll_staff_documents enable row level security;

-- Owner: full access to documents for their own company's staff
create policy "staff_documents_owner_all" on public.payroll_staff_documents
  for all
  using (public.user_owns_company(company_id))
  with check (public.user_owns_company(company_id));

-- Employee: can read their own documents
create policy "staff_documents_self_read" on public.payroll_staff_documents
  for select
  using (staff_id in (select id from public.payroll_staff where user_id = auth.uid()));

-- Storage bucket for the actual files — private, accessed only via signed
-- URLs generated server-side-equivalent (owner's authenticated session).
insert into storage.buckets (id, name, public)
values ('staff-documents', 'staff-documents', false)
on conflict (id) do nothing;

-- Storage RLS: path convention is `${company_id}/${staff_id}/${filename}` so
-- policies can check company ownership from the path itself.
create policy "staff_docs_owner_all" on storage.objects
  for all
  using (
    bucket_id = 'staff-documents'
    and public.user_owns_company((storage.foldername(name))[1]::uuid)
  )
  with check (
    bucket_id = 'staff-documents'
    and public.user_owns_company((storage.foldername(name))[1]::uuid)
  );

create policy "staff_docs_self_read" on storage.objects
  for select
  using (
    bucket_id = 'staff-documents'
    and (storage.foldername(name))[2]::uuid in (
      select id from public.payroll_staff where user_id = auth.uid()
    )
  );
