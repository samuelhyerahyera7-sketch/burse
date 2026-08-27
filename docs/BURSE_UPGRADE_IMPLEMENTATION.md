# Burse product upgrade implementation

This branch starts the Burse product upgrade without replacing the existing payroll or bookkeeping screens wholesale.

## Added now

### 1. Action Centre
Files:
- `assets/js/action-centre.js`
- `assets/css/action-centre.css`

Purpose:
- Surface what needs attention today.
- Show active employees, estimated payroll, unreconciled bank items and overdue invoices.
- Flag missing employee bank/tax details and upcoming compliance tasks.

Integration target:
- Mount near the top of the payroll/business dashboard once `sb` and `company` are available.

Example:
```html
<link rel="stylesheet" href="/assets/css/action-centre.css">
<div id="burseActionCentre"></div>
<script src="/assets/js/action-centre.js"></script>
<script>
  BurseActionCentre.mount({ root: '#burseActionCentre', supabase: sb, companyId: company.id });
</script>
```

### 2. Core double-entry finance ledger
File:
- `supabase/schema-finance-v1-core-ledger.sql`

Adds:
- chart-of-account records
- journal headers
- journal lines
- balance validation
- controlled posting function
- trial balance function
- RLS hooks using the existing company membership model when available

This is additive. Existing bookkeeping tables remain intact while modules migrate progressively to the canonical ledger.

Recommended posting order:
1. payroll finalisation
2. customer invoices and payments
3. supplier bills and payments
4. expenses
5. bank reconciliation
6. inventory movements

### 3. Payroll anomaly detection
File:
- `assets/js/payroll-anomaly-detector.js`

Flags:
- large pay changes versus previous run
- excessive overtime
- missing bank details
- missing tax number
- duplicated bank accounts
- negative net pay
- zero PAYE for review

The module returns structured issues so the existing payroll UI can decide how to present or block finalisation.

## Next integration phase

### Dashboard
- Add the Action Centre to the current admin dashboard.
- Add cash available, money due in, bills due, next payroll and compliance deadlines.
- Use owner-friendly wording by default, with advanced accounting labels in accountant mode.

### Payroll
- Run anomaly checks before a pay run can be finalised.
- Add Review -> Approve -> Finalise -> Payslips -> Payment -> EMP201 as a single workflow.
- On finalisation, post a balanced payroll journal into `finance_journals`.

### Banking
- Introduce a provider abstraction rather than hard-coding one bank-feed provider.
- Imported transactions should enter a single normalised bank transaction table.
- Matching should produce suggestions with confidence rather than silently auto-posting low-confidence items.

### Accountant portal
- Add client status indicators for unreconciled transactions, VAT, payroll, overdue invoices and compliance.
- Allow switching into a client company without separate login flows.

### Compliance Centre
- Keep due dates and status in `payroll_compliance_tasks`.
- Add VAT and company compliance task types to the same action framework.

### Cash-flow forecast
- Start with deterministic cash flow from bank balance + open invoices + bills + scheduled payroll.
- Keep forecast assumptions visible and editable.

### Ask Burse
- Do not expose unrestricted SQL to the model.
- Build approved finance queries/RPCs for questions such as who owes me money, upcoming payroll, expense changes and cash runway.
- Always show the data period and source used in the answer.

## Architecture rule going forward

Avoid adding substantial new inline JavaScript or CSS to `payroll-admin.html` and `bookkeeping-admin.html`.

New functionality should be split into modules under:

```text
assets/js/payroll/
assets/js/bookkeeping/
assets/js/dashboard/
assets/js/shared/
assets/css/
```

The existing large HTML files can then be reduced gradually instead of through one risky rewrite.

## Safety / rollout

- Apply database migrations in staging first.
- Verify the actual Burse company membership table before relying on the conditional RLS policies in the ledger migration.
- Do not post historical bookkeeping into the new ledger until opening balances and migration reconciliation have been agreed.
- Do not automatically submit SARS/UIF filings from browser code or store filing credentials in the frontend.
