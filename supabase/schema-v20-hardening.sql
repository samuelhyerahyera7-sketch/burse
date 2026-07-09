-- Hardening pass: track when an approved expense/travel claim has been
-- reimbursed via a bank payment file, so it's only ever included once.
alter table public.payroll_expense_claims add column if not exists reimbursed_at timestamptz;

-- Daily compliance-reminders digest, via pg_cron + pg_net calling the
-- compliance-reminders edge function. The x-cron-secret header value below
-- must match the CRON_SECRET function secret (set separately via the
-- Supabase dashboard/CLI — not stored in this file). Run manually once
-- after setting CRON_SECRET, substituting the real value.
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- select cron.schedule(
--   'burse-compliance-reminders-daily',
--   '0 6 * * *',
--   $$
--   select net.http_post(
--     url := 'https://pnpfurfodmejdggnyjof.supabase.co/functions/v1/compliance-reminders',
--     headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '<CRON_SECRET value>'),
--     body := '{}'::jsonb
--   );
--   $$
-- );
