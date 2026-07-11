-- Automated/scheduled payroll runs (QuickBooks "Auto Payroll" equivalent):
-- when enabled, a daily cron job creates and calculates (never
-- auto-finalizes — the owner always reviews and approves) a draft run
-- ahead of the next expected pay date, based on the previous run's cadence.
alter table public.payroll_companies add column if not exists auto_run_payroll boolean not null default false;
alter table public.payroll_companies add column if not exists auto_run_days_before int not null default 5 check (auto_run_days_before between 1 and 14);

-- COID (Compensation for Occupational Injuries and Diseases Act) — the SA
-- equivalent of workers' compensation. Employers register with the
-- Compensation Fund and submit an annual Return of Earnings (ROE).
alter table public.payroll_companies add column if not exists coid_reference text;
alter table public.payroll_companies add column if not exists coid_rate_per_100 numeric(6,4);
