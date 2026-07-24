-- schema-bookkeeping-v9-job-orders.sql
-- Job Orders for the Business Hub: track incoming customer jobs, due dates, and status.

CREATE TABLE IF NOT EXISTS bk_job_orders (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid        NOT NULL REFERENCES payroll_companies(id) ON DELETE CASCADE,
  job_number      text        NOT NULL,
  customer_name   text        NOT NULL,
  customer_phone  text,
  customer_email  text,
  description     text        NOT NULL,
  notes           text,
  received_date   date        NOT NULL DEFAULT CURRENT_DATE,
  due_date        date,
  status          text        NOT NULL DEFAULT 'new'
                              CHECK (status IN ('new','in_progress','ready','completed','archived')),
  priority        text        NOT NULL DEFAULT 'normal'
                              CHECK (priority IN ('low','normal','high','urgent')),
  invoice_id      uuid        REFERENCES bk_invoices(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bk_job_orders_company_idx    ON bk_job_orders (company_id);
CREATE INDEX IF NOT EXISTS bk_job_orders_received_idx   ON bk_job_orders (company_id, received_date);
CREATE INDEX IF NOT EXISTS bk_job_orders_due_idx        ON bk_job_orders (company_id, due_date);
CREATE INDEX IF NOT EXISTS bk_job_orders_status_idx     ON bk_job_orders (company_id, status);

-- Row Level Security
ALTER TABLE bk_job_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "bk_job_orders_company_members" ON bk_job_orders;
CREATE POLICY "bk_job_orders_company_members" ON bk_job_orders
  USING (
    company_id IN (
      SELECT id          FROM payroll_companies   WHERE owner_id = auth.uid()
      UNION
      SELECT company_id  FROM payroll_accountants WHERE user_id  = auth.uid()
    )
  );
