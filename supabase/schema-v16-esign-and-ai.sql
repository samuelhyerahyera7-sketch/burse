-- Document e-signing. Lightweight acknowledgement-style signing (typed name +
-- drawn signature + timestamp), not a full DocuSign-grade envelope/audit
-- product — suitable for policy acknowledgements, contract sign-off, etc.
-- The AI assistant (ai-payroll-assistant edge function) needs no new
-- tables; it only reads existing payslip/leave data, so this migration is
-- e-signing only.

create table if not exists public.payroll_sign_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.payroll_companies(id) on delete cascade,
  title text not null,
  description text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
alter table public.payroll_sign_documents enable row level security;

drop policy if exists "sign_documents_owner_all" on public.payroll_sign_documents;
create policy "sign_documents_owner_all" on public.payroll_sign_documents
  for all using (public.user_owns_company(company_id)) with check (public.user_owns_company(company_id));

drop policy if exists "sign_documents_self_read" on public.payroll_sign_documents;
create policy "sign_documents_self_read" on public.payroll_sign_documents
  for select using (
    company_id in (select company_id from public.payroll_staff where user_id = auth.uid())
  );

create table if not exists public.payroll_document_signatures (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.payroll_sign_documents(id) on delete cascade,
  staff_id uuid not null references public.payroll_staff(id) on delete cascade,
  typed_name text not null,
  signature_image text,          -- base64 PNG from the canvas signature pad, optional
  signed_at timestamptz not null default now(),
  unique (document_id, staff_id)
);
alter table public.payroll_document_signatures enable row level security;

drop policy if exists "document_signatures_owner_read" on public.payroll_document_signatures;
create policy "document_signatures_owner_read" on public.payroll_document_signatures
  for select using (
    document_id in (select id from public.payroll_sign_documents where public.user_owns_company(company_id))
  );

drop policy if exists "document_signatures_self_all" on public.payroll_document_signatures;
create policy "document_signatures_self_all" on public.payroll_document_signatures
  for all using (staff_id in (select id from public.payroll_staff where user_id = auth.uid()))
  with check (staff_id in (select id from public.payroll_staff where user_id = auth.uid()));

grant select, insert, delete on public.payroll_sign_documents to authenticated;
grant select, insert on public.payroll_document_signatures to authenticated;
