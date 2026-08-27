-- Burse finance core ledger foundation
-- Safe additive migration. Does not replace existing bookkeeping tables.

create extension if not exists pgcrypto;

create table if not exists public.finance_accounts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  code text not null,
  name text not null,
  account_type text not null check (account_type in ('asset','liability','equity','income','expense')),
  subtype text,
  is_system boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(company_id, code)
);

create table if not exists public.finance_journals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  journal_date date not null default current_date,
  source_type text not null default 'manual',
  source_id uuid,
  reference text,
  description text,
  status text not null default 'draft' check (status in ('draft','posted','reversed')),
  posted_at timestamptz,
  posted_by uuid,
  reversal_of uuid references public.finance_journals(id),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.finance_journal_lines (
  id uuid primary key default gen_random_uuid(),
  journal_id uuid not null references public.finance_journals(id) on delete cascade,
  account_id uuid not null references public.finance_accounts(id),
  description text,
  debit numeric(18,2) not null default 0 check (debit >= 0),
  credit numeric(18,2) not null default 0 check (credit >= 0),
  tax_code text,
  counterparty_type text,
  counterparty_id uuid,
  created_at timestamptz not null default now(),
  check ((debit = 0 and credit > 0) or (credit = 0 and debit > 0))
);

create index if not exists finance_accounts_company_idx on public.finance_accounts(company_id);
create index if not exists finance_journals_company_date_idx on public.finance_journals(company_id, journal_date desc);
create index if not exists finance_journals_source_idx on public.finance_journals(company_id, source_type, source_id);
create index if not exists finance_journal_lines_journal_idx on public.finance_journal_lines(journal_id);
create index if not exists finance_journal_lines_account_idx on public.finance_journal_lines(account_id);

alter table public.finance_accounts enable row level security;
alter table public.finance_journals enable row level security;
alter table public.finance_journal_lines enable row level security;

-- Reuse Burse's existing company ownership/membership model where available.
-- These policies intentionally check common company access tables without granting
-- broad anonymous access. Adjust table names only if the deployment uses a different membership table.

do $$
begin
  if to_regclass('public.company_members') is not null then
    execute $p$
      create policy finance_accounts_member_access on public.finance_accounts
      for all using (
        exists (select 1 from public.company_members cm where cm.company_id = finance_accounts.company_id and cm.user_id = auth.uid())
      ) with check (
        exists (select 1 from public.company_members cm where cm.company_id = finance_accounts.company_id and cm.user_id = auth.uid())
      )
    $p$;
    execute $p$
      create policy finance_journals_member_access on public.finance_journals
      for all using (
        exists (select 1 from public.company_members cm where cm.company_id = finance_journals.company_id and cm.user_id = auth.uid())
      ) with check (
        exists (select 1 from public.company_members cm where cm.company_id = finance_journals.company_id and cm.user_id = auth.uid())
      )
    $p$;
    execute $p$
      create policy finance_journal_lines_member_access on public.finance_journal_lines
      for all using (
        exists (
          select 1 from public.finance_journals j
          join public.company_members cm on cm.company_id = j.company_id
          where j.id = finance_journal_lines.journal_id and cm.user_id = auth.uid()
        )
      ) with check (
        exists (
          select 1 from public.finance_journals j
          join public.company_members cm on cm.company_id = j.company_id
          where j.id = finance_journal_lines.journal_id and cm.user_id = auth.uid()
        )
      )
    $p$;
  end if;
exception when duplicate_object then null;
end $$;

create or replace function public.finance_assert_balanced(p_journal_id uuid)
returns void
language plpgsql
security invoker
as $$
declare
  v_debit numeric(18,2);
  v_credit numeric(18,2);
begin
  select coalesce(sum(debit),0), coalesce(sum(credit),0)
    into v_debit, v_credit
  from public.finance_journal_lines
  where journal_id = p_journal_id;

  if v_debit <= 0 or v_credit <= 0 or v_debit <> v_credit then
    raise exception 'Journal % is not balanced. Debits %, credits %', p_journal_id, v_debit, v_credit;
  end if;
end;
$$;

create or replace function public.finance_post_journal(p_journal_id uuid)
returns public.finance_journals
language plpgsql
security invoker
as $$
declare
  v_journal public.finance_journals;
begin
  select * into v_journal from public.finance_journals where id = p_journal_id for update;
  if not found then raise exception 'Journal not found'; end if;
  if v_journal.status <> 'draft' then raise exception 'Only draft journals can be posted'; end if;

  perform public.finance_assert_balanced(p_journal_id);

  update public.finance_journals
  set status = 'posted', posted_at = now(), posted_by = auth.uid(), updated_at = now()
  where id = p_journal_id
  returning * into v_journal;

  return v_journal;
end;
$$;

create or replace function public.finance_trial_balance(p_company_id uuid, p_to_date date default current_date)
returns table(account_id uuid, code text, name text, account_type text, debit numeric, credit numeric, balance numeric)
language sql
security invoker
stable
as $$
  select
    a.id,
    a.code,
    a.name,
    a.account_type,
    coalesce(sum(l.debit),0)::numeric as debit,
    coalesce(sum(l.credit),0)::numeric as credit,
    case when a.account_type in ('asset','expense')
      then (coalesce(sum(l.debit),0)-coalesce(sum(l.credit),0))::numeric
      else (coalesce(sum(l.credit),0)-coalesce(sum(l.debit),0))::numeric
    end as balance
  from public.finance_accounts a
  left join public.finance_journal_lines l on l.account_id = a.id
  left join public.finance_journals j on j.id = l.journal_id and j.status = 'posted' and j.journal_date <= p_to_date
  where a.company_id = p_company_id and a.is_active
  group by a.id, a.code, a.name, a.account_type
  order by a.code;
$$;

comment on table public.finance_journals is 'Canonical Burse double-entry journal header. Financial modules should progressively post here.';
comment on table public.finance_journal_lines is 'Debit/credit lines for the canonical Burse finance ledger.';