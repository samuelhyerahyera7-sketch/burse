-- HR core module (Phase 1 of the Workday-inspired build-out): departments,
-- org structure fields, expense/travel claims, employee sub-records
-- (emergency contacts, qualifications, skills, training, assets), employment
-- history, HR events (warnings/disciplinary/PIP/probation/exit), and
-- document templates for generating contracts/policies. All new tables
-- follow the same owner/self(/manager) RLS shape used throughout the app.

-- ── Departments / cost centres / business units ──────────────────────────
create table if not exists public.payroll_departments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.payroll_companies(id) on delete cascade,
  name text not null,
  cost_centre_code text,
  business_unit text,
  created_at timestamptz not null default now(),
  unique (company_id, name)
);
alter table public.payroll_departments enable row level security;
drop policy if exists "departments_owner_all" on public.payroll_departments;
create policy "departments_owner_all" on public.payroll_departments
  for all using (public.user_owns_company(company_id)) with check (public.user_owns_company(company_id));
drop policy if exists "departments_self_read" on public.payroll_departments;
create policy "departments_self_read" on public.payroll_departments
  for select using (company_id in (select company_id from public.payroll_staff where user_id = auth.uid()));
grant select, insert, update, delete on public.payroll_departments to authenticated;

alter table public.payroll_staff add column if not exists department_id uuid references public.payroll_departments(id) on delete set null;
alter table public.payroll_staff add column if not exists probation_end_date date;
alter table public.payroll_staff add column if not exists contract_end_date date;

-- ── Expense & travel claims (same request/approve shape as advance/overtime) ──
create table if not exists public.payroll_expense_claims (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.payroll_staff(id) on delete cascade,
  company_id uuid not null references public.payroll_companies(id) on delete cascade,
  claim_type text not null check (claim_type in ('expense', 'travel')),
  description text not null,
  amount numeric(12,2) not null check (amount > 0),
  claim_date date not null,
  receipt_storage_path text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users(id)
);
alter table public.payroll_expense_claims enable row level security;
drop policy if exists "expense_claims_owner_all" on public.payroll_expense_claims;
create policy "expense_claims_owner_all" on public.payroll_expense_claims
  for all using (public.user_owns_company(company_id)) with check (public.user_owns_company(company_id));
drop policy if exists "expense_claims_self_read" on public.payroll_expense_claims;
create policy "expense_claims_self_read" on public.payroll_expense_claims
  for select using (staff_id in (select id from public.payroll_staff where user_id = auth.uid()));
drop policy if exists "expense_claims_self_insert" on public.payroll_expense_claims;
create policy "expense_claims_self_insert" on public.payroll_expense_claims
  for insert with check (staff_id in (select id from public.payroll_staff where user_id = auth.uid()));
drop policy if exists "expense_claims_manager_select" on public.payroll_expense_claims;
create policy "expense_claims_manager_select" on public.payroll_expense_claims
  for select using (public.is_manager_or_delegate_of(staff_id));
drop policy if exists "expense_claims_manager_update" on public.payroll_expense_claims;
create policy "expense_claims_manager_update" on public.payroll_expense_claims
  for update using (public.is_manager_or_delegate_of(staff_id)) with check (public.is_manager_or_delegate_of(staff_id));
grant select, insert, update on public.payroll_expense_claims to authenticated;

-- ── Emergency contacts (employee-managed) ────────────────────────────────
create table if not exists public.payroll_emergency_contacts (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.payroll_staff(id) on delete cascade,
  company_id uuid not null references public.payroll_companies(id) on delete cascade,
  name text not null,
  relationship text,
  phone text,
  email text,
  created_at timestamptz not null default now()
);
alter table public.payroll_emergency_contacts enable row level security;
drop policy if exists "emergency_contacts_owner_all" on public.payroll_emergency_contacts;
create policy "emergency_contacts_owner_all" on public.payroll_emergency_contacts
  for all using (public.user_owns_company(company_id)) with check (public.user_owns_company(company_id));
drop policy if exists "emergency_contacts_self_all" on public.payroll_emergency_contacts;
create policy "emergency_contacts_self_all" on public.payroll_emergency_contacts
  for all using (staff_id in (select id from public.payroll_staff where user_id = auth.uid()))
  with check (staff_id in (select id from public.payroll_staff where user_id = auth.uid()));
grant select, insert, update, delete on public.payroll_emergency_contacts to authenticated;

-- ── Qualifications, skills, training records (employee can add own; owner manages all) ──
create table if not exists public.payroll_qualifications (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.payroll_staff(id) on delete cascade,
  company_id uuid not null references public.payroll_companies(id) on delete cascade,
  institution text, qualification text not null, year_completed int,
  document_storage_path text,
  created_at timestamptz not null default now()
);
alter table public.payroll_qualifications enable row level security;
drop policy if exists "qualifications_owner_all" on public.payroll_qualifications;
create policy "qualifications_owner_all" on public.payroll_qualifications
  for all using (public.user_owns_company(company_id)) with check (public.user_owns_company(company_id));
drop policy if exists "qualifications_self_all" on public.payroll_qualifications;
create policy "qualifications_self_all" on public.payroll_qualifications
  for all using (staff_id in (select id from public.payroll_staff where user_id = auth.uid()))
  with check (staff_id in (select id from public.payroll_staff where user_id = auth.uid()));
grant select, insert, update, delete on public.payroll_qualifications to authenticated;

create table if not exists public.payroll_skills (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.payroll_staff(id) on delete cascade,
  company_id uuid not null references public.payroll_companies(id) on delete cascade,
  skill text not null,
  proficiency text check (proficiency in ('beginner', 'intermediate', 'advanced', 'expert')),
  created_at timestamptz not null default now()
);
alter table public.payroll_skills enable row level security;
drop policy if exists "skills_owner_all" on public.payroll_skills;
create policy "skills_owner_all" on public.payroll_skills
  for all using (public.user_owns_company(company_id)) with check (public.user_owns_company(company_id));
drop policy if exists "skills_self_all" on public.payroll_skills;
create policy "skills_self_all" on public.payroll_skills
  for all using (staff_id in (select id from public.payroll_staff where user_id = auth.uid()))
  with check (staff_id in (select id from public.payroll_staff where user_id = auth.uid()));
grant select, insert, update, delete on public.payroll_skills to authenticated;

create table if not exists public.payroll_training_records (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.payroll_staff(id) on delete cascade,
  company_id uuid not null references public.payroll_companies(id) on delete cascade,
  course_name text not null, provider text,
  completed_date date, expiry_date date,
  certificate_storage_path text,
  created_at timestamptz not null default now()
);
alter table public.payroll_training_records enable row level security;
drop policy if exists "training_records_owner_all" on public.payroll_training_records;
create policy "training_records_owner_all" on public.payroll_training_records
  for all using (public.user_owns_company(company_id)) with check (public.user_owns_company(company_id));
drop policy if exists "training_records_self_all" on public.payroll_training_records;
create policy "training_records_self_all" on public.payroll_training_records
  for all using (staff_id in (select id from public.payroll_staff where user_id = auth.uid()))
  with check (staff_id in (select id from public.payroll_staff where user_id = auth.uid()));
grant select, insert, update, delete on public.payroll_training_records to authenticated;

-- ── Assets assigned (HR/owner managed; employee can view their own) ─────
create table if not exists public.payroll_assets (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.payroll_staff(id) on delete cascade,
  company_id uuid not null references public.payroll_companies(id) on delete cascade,
  asset_name text not null, asset_tag text,
  assigned_date date not null default current_date, returned_date date,
  notes text,
  created_at timestamptz not null default now()
);
alter table public.payroll_assets enable row level security;
drop policy if exists "assets_owner_all" on public.payroll_assets;
create policy "assets_owner_all" on public.payroll_assets
  for all using (public.user_owns_company(company_id)) with check (public.user_owns_company(company_id));
drop policy if exists "assets_self_read" on public.payroll_assets;
create policy "assets_self_read" on public.payroll_assets
  for select using (staff_id in (select id from public.payroll_staff where user_id = auth.uid()));
grant select, insert, update, delete on public.payroll_assets to authenticated;

-- ── Employment history (salary changes, promotions, transfers, title changes) ──
create table if not exists public.payroll_employment_history (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.payroll_staff(id) on delete cascade,
  company_id uuid not null references public.payroll_companies(id) on delete cascade,
  event_type text not null check (event_type in ('salary_change', 'promotion', 'transfer', 'title_change')),
  effective_date date not null,
  previous_value jsonb, new_value jsonb, note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
alter table public.payroll_employment_history enable row level security;
drop policy if exists "employment_history_owner_all" on public.payroll_employment_history;
create policy "employment_history_owner_all" on public.payroll_employment_history
  for all using (public.user_owns_company(company_id)) with check (public.user_owns_company(company_id));
drop policy if exists "employment_history_self_read" on public.payroll_employment_history;
create policy "employment_history_self_read" on public.payroll_employment_history
  for select using (staff_id in (select id from public.payroll_staff where user_id = auth.uid()));
grant select, insert on public.payroll_employment_history to authenticated;

-- ── HR events: warnings, disciplinary hearings, PIPs, resignations, exits ─
create table if not exists public.payroll_hr_events (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.payroll_staff(id) on delete cascade,
  company_id uuid not null references public.payroll_companies(id) on delete cascade,
  event_type text not null check (event_type in ('warning', 'disciplinary_hearing', 'pip', 'resignation', 'exit_interview', 'termination')),
  event_date date not null,
  details text,
  document_storage_path text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
alter table public.payroll_hr_events enable row level security;
drop policy if exists "hr_events_owner_all" on public.payroll_hr_events;
create policy "hr_events_owner_all" on public.payroll_hr_events
  for all using (public.user_owns_company(company_id)) with check (public.user_owns_company(company_id));
drop policy if exists "hr_events_self_read" on public.payroll_hr_events;
create policy "hr_events_self_read" on public.payroll_hr_events
  for select using (staff_id in (select id from public.payroll_staff where user_id = auth.uid()));
grant select, insert on public.payroll_hr_events to authenticated;

-- ── Document templates (contracts, policies, offer/warning letters) ─────
-- Generating from a template renders {{tokens}} client-side and creates a
-- normal payroll_sign_documents row, reusing the e-signing flow already built.
create table if not exists public.payroll_document_templates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.payroll_companies(id) on delete cascade,
  name text not null,
  category text not null default 'document' check (category in ('contract', 'policy', 'offer_letter', 'warning', 'document')),
  body text not null,
  created_at timestamptz not null default now()
);
alter table public.payroll_document_templates enable row level security;
drop policy if exists "document_templates_owner_all" on public.payroll_document_templates;
create policy "document_templates_owner_all" on public.payroll_document_templates
  for all using (public.user_owns_company(company_id)) with check (public.user_owns_company(company_id));
grant select, insert, update, delete on public.payroll_document_templates to authenticated;

alter table public.payroll_sign_documents add column if not exists category text not null default 'document' check (category in ('contract', 'policy', 'offer_letter', 'warning', 'document'));
alter table public.payroll_sign_documents add column if not exists staff_id uuid references public.payroll_staff(id) on delete cascade;

-- A document with staff_id set (e.g. a generated contract) is personal —
-- only that employee (and the owner) should see it. staff_id null means a
-- broadcast document (policy/announcement-style), visible to the whole
-- company as before.
drop policy if exists "sign_documents_self_read" on public.payroll_sign_documents;
create policy "sign_documents_self_read" on public.payroll_sign_documents
  for select using (
    company_id in (select company_id from public.payroll_staff where user_id = auth.uid())
    and (staff_id is null or staff_id in (select id from public.payroll_staff where user_id = auth.uid()))
  );
