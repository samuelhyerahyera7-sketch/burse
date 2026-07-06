-- ============================================================
-- BURSE DATABASE SCHEMA
-- Run this in Supabase → SQL Editor, before schema-payroll.sql
-- and schema-payroll-v2.sql.
-- ============================================================

-- ── User profiles (extends auth.users) ──────────────────────
create table if not exists public.profiles (
  id                uuid primary key references auth.users(id) on delete cascade,
  full_name         text,
  id_number         text,
  phone             text,
  role              text default 'employee',        -- employee | employer | admin | accountant
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

alter table public.profiles enable row level security;

-- profiles: users read/write own row only
create policy "profiles_own" on public.profiles
  using (auth.uid() = id) with check (auth.uid() = id);

-- ============================================================
-- AUTO-CREATE PROFILE ON SIGN UP
-- ============================================================
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data->>'full_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
