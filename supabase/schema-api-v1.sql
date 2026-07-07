-- Public API v1: API keys for third-party integrations (EWA providers, bookkeeping
-- sync, accounting software, etc). Keys are scoped to a single company and to a
-- named set of permissions ("scopes"). The raw key is only ever shown once, at
-- creation time — only its SHA-256 hash is stored.

create extension if not exists pgcrypto;

-- Metadata table. Safe to expose to the owning company via RLS — never holds
-- the raw key or its hash.
create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.payroll_companies(id) on delete cascade,
  name text not null,
  key_prefix text not null, -- first 12 chars of the raw key, shown in the UI so an owner can tell keys apart
  scopes text[] not null default '{}',
  created_by uuid not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index if not exists api_keys_company_idx on public.api_keys(company_id);

alter table public.api_keys enable row level security;

drop policy if exists "owners can view their api keys" on public.api_keys;
create policy "owners can view their api keys" on public.api_keys
  for select using (public.user_owns_company(company_id));

-- No insert/update/delete policies: all mutations go through the security
-- definer RPCs below, which enforce ownership themselves. Direct table writes
-- from the client are never allowed.
grant select on public.api_keys to authenticated;

-- Secret table. Never exposed to anon/authenticated — only the service role
-- (used exclusively inside edge functions) can read it, via the RPCs below.
create table if not exists public.api_key_secrets (
  id uuid primary key references public.api_keys(id) on delete cascade,
  key_hash text not null unique,
  window_start timestamptz not null default now(),
  window_count int not null default 0
);

alter table public.api_key_secrets enable row level security;
-- Deliberately no policies at all: default-deny for anon/authenticated. Only
-- service_role (which bypasses RLS) can touch this table.

-- ── create_api_key ──────────────────────────────────────────────────────
-- Generates a new key, returns the raw key (once) alongside its metadata.
create or replace function public.create_api_key(p_company_id uuid, p_name text, p_scopes text[])
returns table (id uuid, raw_key text, name text, key_prefix text, scopes text[], created_at timestamptz)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_raw_key text;
  v_hash text;
  v_id uuid;
begin
  if not public.user_owns_company(p_company_id) then
    raise exception 'Not authorised for this company';
  end if;
  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'Key name is required';
  end if;
  if p_scopes is null or array_length(p_scopes, 1) is null then
    raise exception 'At least one scope is required';
  end if;

  v_raw_key := 'bk_live_' || encode(gen_random_bytes(24), 'hex');
  v_hash := encode(digest(v_raw_key, 'sha256'), 'hex');

  insert into public.api_keys (company_id, name, key_prefix, scopes, created_by)
  values (p_company_id, p_name, left(v_raw_key, 16), p_scopes, auth.uid())
  returning public.api_keys.id into v_id;

  insert into public.api_key_secrets (id, key_hash) values (v_id, v_hash);

  return query select v_id, v_raw_key, p_name, left(v_raw_key, 16), p_scopes, now();
end;
$$;

revoke all on function public.create_api_key(uuid, text, text[]) from public;
grant execute on function public.create_api_key(uuid, text, text[]) to authenticated;

-- ── revoke_api_key ──────────────────────────────────────────────────────
create or replace function public.revoke_api_key(p_key_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
begin
  select company_id into v_company_id from public.api_keys where id = p_key_id;
  if v_company_id is null then
    raise exception 'Key not found';
  end if;
  if not public.user_owns_company(v_company_id) then
    raise exception 'Not authorised for this company';
  end if;
  update public.api_keys set revoked_at = now() where id = p_key_id;
end;
$$;

revoke all on function public.revoke_api_key(uuid) from public;
grant execute on function public.revoke_api_key(uuid) to authenticated;

-- ── validate_api_key ─────────────────────────────────────────────────────
-- Called only from edge functions (service role). Hashes the raw key, checks
-- it's live and not revoked, and atomically enforces a fixed-window rate
-- limit (default 120 requests/minute per key) via a row lock. Returns the
-- owning company and granted scopes on success.
create or replace function public.validate_api_key(p_raw_key text, p_limit int default 120)
returns table (company_id uuid, scopes text[], key_id uuid)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_hash text;
  v_secret record;
  v_key record;
begin
  v_hash := encode(digest(p_raw_key, 'sha256'), 'hex');

  select * into v_secret from public.api_key_secrets where key_hash = v_hash for update;
  if not found then
    raise exception 'Invalid API key' using errcode = '28000';
  end if;

  select * into v_key from public.api_keys where id = v_secret.id;
  if v_key.revoked_at is not null then
    raise exception 'This API key has been revoked' using errcode = '28000';
  end if;

  if now() - v_secret.window_start > interval '1 minute' then
    update public.api_key_secrets
      set window_start = now(), window_count = 1
      where id = v_secret.id;
  else
    if v_secret.window_count >= p_limit then
      raise exception 'Rate limit exceeded — try again shortly' using errcode = '57014';
    end if;
    update public.api_key_secrets
      set window_count = v_secret.window_count + 1
      where id = v_secret.id;
  end if;

  update public.api_keys set last_used_at = now() where id = v_key.id;

  return query select v_key.company_id, v_key.scopes, v_key.id;
end;
$$;

revoke all on function public.validate_api_key(text, int) from public;
grant execute on function public.validate_api_key(text, int) to service_role;

-- ── record_salary_advance ────────────────────────────────────────────────
-- Called only from the api-v1 edge function (service role), after it has
-- already validated the caller's API key and scope. Reuses the existing
-- payroll_loans mechanism so an advance is automatically recovered from the
-- employee's next payslip. Since a staff member can only have one active
-- loan at a time (idx_loans_one_active_per_staff), a second advance tops up
-- the existing one atomically via ON CONFLICT rather than a racy
-- insert-then-catch in application code. The full new balance is always set
-- as the monthly_installment so the whole advance is recovered on the next
-- run (an advance is not a multi-month loan).
create or replace function public.record_salary_advance(
  p_company_id uuid, p_staff_id uuid, p_amount numeric, p_label text default 'Salary Advance'
)
returns public.payroll_loans
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff record;
  v_loan public.payroll_loans;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be greater than zero';
  end if;

  select * into v_staff from public.payroll_staff where id = p_staff_id and company_id = p_company_id;
  if not found then
    raise exception 'Employee not found for this company' using errcode = 'P0002';
  end if;

  insert into public.payroll_loans (staff_id, company_id, label, principal, balance, monthly_installment, status)
  values (p_staff_id, p_company_id, p_label, p_amount, p_amount, p_amount, 'active')
  on conflict (staff_id) where status = 'active'
  do update set
    principal = public.payroll_loans.principal + excluded.principal,
    balance = public.payroll_loans.balance + excluded.balance,
    monthly_installment = public.payroll_loans.balance + excluded.balance,
    updated_at = now()
  returning * into v_loan;

  return v_loan;
end;
$$;

revoke all on function public.record_salary_advance(uuid, uuid, numeric, text) from public;
grant execute on function public.record_salary_advance(uuid, uuid, numeric, text) to service_role;
