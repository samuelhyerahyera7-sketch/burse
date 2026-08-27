(function () {
  'use strict';

  function money(value) {
    return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', maximumFractionDigits: 0 }).format(Number(value || 0));
  }

  function daysUntil(date) {
    if (!date) return null;
    const now = new Date();
    const target = new Date(date);
    const diff = Math.ceil((target.setHours(0,0,0,0) - now.setHours(0,0,0,0)) / 86400000);
    return Number.isFinite(diff) ? diff : null;
  }

  async function safeCount(sb, table, filters) {
    try {
      let q = sb.from(table).select('*', { count: 'exact', head: true });
      (filters || []).forEach(function (f) { q = q[f.op || 'eq'](f.key, f.value); });
      const res = await q;
      return res.error ? 0 : (res.count || 0);
    } catch (_) { return 0; }
  }

  async function safeRows(sb, table, columns, filters, limit) {
    try {
      let q = sb.from(table).select(columns || '*');
      (filters || []).forEach(function (f) { q = q[f.op || 'eq'](f.key, f.value); });
      if (limit) q = q.limit(limit);
      const res = await q;
      return res.error ? [] : (res.data || []);
    } catch (_) { return []; }
  }

  async function loadActionCentreData(sb, companyId) {
    if (!sb || !companyId) return null;

    const [unreconciled, overdueInvoices, staff, runs, compliance, bankRows] = await Promise.all([
      safeCount(sb, 'bk_bank_transactions', [
        { key: 'company_id', value: companyId },
        { key: 'is_reconciled', value: false }
      ]),
      safeCount(sb, 'bk_invoices', [
        { key: 'company_id', value: companyId },
        { key: 'status', value: 'overdue' }
      ]),
      safeRows(sb, 'payroll_staff', 'id,full_name,basic_salary,is_active,bank_account_number,tax_number', [
        { key: 'company_id', value: companyId },
        { key: 'is_active', value: true }
      ]),
      safeRows(sb, 'payroll_runs', '*', [
        { key: 'company_id', value: companyId }
      ], 20),
      safeRows(sb, 'payroll_compliance_tasks', '*', [
        { key: 'company_id', value: companyId }
      ], 50),
      safeRows(sb, 'bk_bank_transactions', 'id,amount,transaction_date,is_reconciled', [
        { key: 'company_id', value: companyId }
      ], 250)
    ]);

    const activeStaff = staff.length;
    const payrollEstimate = staff.reduce(function (sum, s) { return sum + Number(s.basic_salary || 0); }, 0);
    const missingBank = staff.filter(function (s) { return !s.bank_account_number; }).length;
    const missingTax = staff.filter(function (s) { return !s.tax_number; }).length;

    const sortedRuns = runs.slice().sort(function (a,b) {
      return new Date(b.pay_date || b.period_end || b.created_at || 0) - new Date(a.pay_date || a.period_end || a.created_at || 0);
    });
    const latestRun = sortedRuns[0] || null;

    const dueCompliance = compliance
      .filter(function (c) { return c.status !== 'completed' && c.status !== 'done'; })
      .sort(function (a,b) { return new Date(a.due_date || 8640000000000000) - new Date(b.due_date || 8640000000000000); });

    const recentNet = bankRows.reduce(function (sum, row) { return sum + Number(row.amount || 0); }, 0);

    const actions = [];
    if (unreconciled) actions.push({ severity: unreconciled > 20 ? 'high' : 'medium', label: unreconciled + ' bank transaction' + (unreconciled === 1 ? '' : 's') + ' need reconciliation', target: 'banking' });
    if (overdueInvoices) actions.push({ severity: 'high', label: overdueInvoices + ' overdue invoice' + (overdueInvoices === 1 ? '' : 's') + ' need attention', target: 'invoices' });
    if (missingBank) actions.push({ severity: 'high', label: missingBank + ' employee' + (missingBank === 1 ? '' : 's') + ' missing bank details', target: 'employees' });
    if (missingTax) actions.push({ severity: 'medium', label: missingTax + ' employee' + (missingTax === 1 ? '' : 's') + ' missing tax numbers', target: 'employees' });
    dueCompliance.slice(0, 5).forEach(function (task) {
      const d = daysUntil(task.due_date);
      const when = d === null ? '' : d < 0 ? ' overdue' : d === 0 ? ' due today' : ' due in ' + d + ' day' + (d === 1 ? '' : 's');
      actions.push({ severity: d !== null && d <= 3 ? 'high' : 'medium', label: (task.title || task.task_type || 'Compliance task') + when, target: 'compliance' });
    });

    return {
      activeStaff: activeStaff,
      payrollEstimate: payrollEstimate,
      latestRun: latestRun,
      unreconciled: unreconciled,
      overdueInvoices: overdueInvoices,
      recentNet: recentNet,
      actions: actions.slice(0, 8)
    };
  }

  function renderActionCentre(root, data, options) {
    options = options || {};
    if (!root || !data) return;
    const go = typeof options.onNavigate === 'function' ? options.onNavigate : function (target) {
      if (typeof window.showSection === 'function') window.showSection(target);
    };

    const actionHtml = data.actions.length
      ? data.actions.map(function (a) {
          return '<button class="bac-action bac-' + a.severity + '" data-target="' + a.target + '">' +
            '<span class="bac-dot"></span><span>' + a.label + '</span><span class="bac-arrow">›</span></button>';
        }).join('')
      : '<div class="bac-clear">Nothing urgent. Burse is up to date.</div>';

    root.innerHTML = '<section class="burse-action-centre">' +
      '<div class="bac-head"><div><div class="bac-eyebrow">Today</div><h2>What needs your attention</h2></div></div>' +
      '<div class="bac-kpis">' +
        '<div class="bac-kpi"><span>Active employees</span><strong>' + data.activeStaff + '</strong></div>' +
        '<div class="bac-kpi"><span>Estimated payroll</span><strong>' + money(data.payrollEstimate) + '</strong></div>' +
        '<div class="bac-kpi"><span>Bank items to match</span><strong>' + data.unreconciled + '</strong></div>' +
        '<div class="bac-kpi"><span>Overdue invoices</span><strong>' + data.overdueInvoices + '</strong></div>' +
      '</div>' +
      '<div class="bac-actions">' + actionHtml + '</div>' +
    '</section>';

    root.querySelectorAll('[data-target]').forEach(function (btn) {
      btn.addEventListener('click', function () { go(btn.getAttribute('data-target')); });
    });
  }

  async function mount(config) {
    config = config || {};
    const root = typeof config.root === 'string' ? document.querySelector(config.root) : config.root;
    const sb = config.supabase || window.sb;
    const companyId = config.companyId || (window.company && window.company.id);
    if (!root || !sb || !companyId) return false;
    root.innerHTML = '<div class="bac-loading">Loading business overview…</div>';
    const data = await loadActionCentreData(sb, companyId);
    if (!data) return false;
    renderActionCentre(root, data, config);
    return true;
  }

  window.BurseActionCentre = { mount: mount, load: loadActionCentreData, render: renderActionCentre };
})();