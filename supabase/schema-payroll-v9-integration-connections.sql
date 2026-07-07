-- ============================================================
-- BURSE PAYROLL — v9: live third-party integration connections
-- Stores per-company API credentials for SimplePay / PaySpace using
-- Supabase Vault (pgsodium-backed encryption at rest) — never plaintext.
-- Run this in Supabase → SQL Editor AFTER schema-payroll-v8-migration-hub.sql.
-- ============================================================

create table if not exists public.payroll_integration_connections (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid references public.payroll_companies(id) on delete cascade not null,
  provider        text not null,              -- simplepay | payspace
  status          text not null default 'connected', -- connected | error | disconnected
  secret_id       uuid not null,               -- references vault.secrets(id) — the encrypted credential blob
  external_ref    text,                        -- e.g. SimplePay client_id this connection is scoped to
  last_error      text,
  last_sync_at    timestamptz,
  connected_by    uuid references auth.users(id),
  created_at      timestamptz default now(),
  unique (company_id, provider)
);

alter table public.payroll_integration_connections enable row level security;

create policy "integration_connections_owner_all" on public.payroll_integration_connections
  for all
  using (public.user_owns_company(company_id))
  with check (public.user_owns_company(company_id));

-- Service-role-only helpers: edge functions run with the service role key, which
-- bypasses RLS entirely, but Vault lives in its own `vault` schema which
-- PostgREST/supabase-js .rpc() can't call directly (it only reaches `public`
-- unless you .schema('vault')) — these SECURITY DEFINER wrappers bridge that.
create or replace function public.vault_create_secret_for_integration(p_secret text, p_name text)
returns uuid
language sql
security definer
set search_path = public, vault
as $$
  select vault.create_secret(p_secret, p_name);
$$;

create or replace function public.vault_read_secret_for_integration(p_secret_id uuid)
returns text
language sql
security definer
set search_path = public, vault
as $$
  select decrypted_secret from vault.decrypted_secrets where id = p_secret_id;
$$;

-- Both are intentionally NOT exposed to authenticated/anon roles — only callable
-- by the service role used inside integration-connect / integration-sync.
revoke all on function public.vault_create_secret_for_integration(text, text) from public, authenticated, anon;
revoke all on function public.vault_read_secret_for_integration(uuid) from public, authenticated, anon;
