// Shared mock insights used in dev/demo mode.
// The live rail defaults to global Contractor CFO alerts only.

const MODULE = 'contractor_cfo';

function cta(label, path) {
  return {
    action: 'navigate',
    label,
    payload: { path },
  };
}

const CONTRACTOR_CFO_MOCK_INSIGHTS = [
  {
    id: 'mock-cfo-collections-priority-1',
    module: MODULE,
    severity: 'warn',
    category: 'collections',
    title: 'Collections should come first',
    body: 'Overdue AR is large enough to affect this month\'s operating cash flow. Follow up before approving new material purchases.',
    metrics: [
      { label: 'Overdue AR', value: '$18.6K' },
      { label: 'Potential inflow', value: '$9.3K' },
    ],
    created_at: null,
    is_read: false,
    is_seen: false,
    primary_cta: cta('Review Collections', '/dashboard/leads-jobs/collections'),
  },
  {
    id: 'mock-cfo-books-1',
    module: MODULE,
    severity: 'warn',
    category: 'bookkeeping_reconciliation',
    title: '18 transactions need review',
    body: 'Uncategorized spend is high enough to distort your margin and tax estimate.',
    metrics: [
      { label: 'Needs review', value: '18' },
      { label: 'Oldest', value: '11 days' },
    ],
    created_at: null,
    is_read: false,
    is_seen: false,
    primary_cta: cta('Open Books', '/dashboard/accounting'),
    secondary_cta: cta('Run Reconciliation', '/dashboard/accounting/reconciliations'),
  },
  {
    id: 'mock-cfo-collections-1',
    module: MODULE,
    severity: 'warn',
    category: 'collections',
    title: 'AR overdue is $18.6K',
    body: 'Collecting half would add $9.3K cash this month and reduce short-term funding pressure.',
    metrics: [
      { label: 'Overdue AR', value: '$18.6K' },
      { label: 'Largest invoice', value: '$7.4K' },
    ],
    created_at: null,
    is_read: false,
    is_seen: false,
    primary_cta: cta('Open Collections', '/dashboard/leads-jobs/collections'),
  },
  {
    id: 'mock-cfo-labor-1',
    module: MODULE,
    severity: 'info',
    category: 'labor_payroll',
    title: 'Labor is 39% of spend',
    body: 'A 5% trim adds roughly $1,600 to monthly profit without changing revenue.',
    metrics: [
      { label: 'Labor share', value: '39%' },
      { label: 'Profit impact', value: '$1.6K' },
    ],
    created_at: null,
    is_read: false,
    is_seen: false,
    primary_cta: cta('Review Reports', '/dashboard/accounting/reports'),
  },
  {
    id: 'mock-cfo-jobs-1',
    module: MODULE,
    severity: 'critical',
    category: 'job_costing',
    title: 'Brown Bath Remodel margin is at 0%',
    body: 'Costs are posted but revenue is missing. Assign revenue or review the job before more spend lands.',
    metrics: [
      { label: 'Margin', value: '0%' },
      { label: 'Posted cost', value: '$400' },
    ],
    created_at: null,
    is_read: false,
    is_seen: false,
    primary_cta: cta('Open Job Costing', '/dashboard/leads-jobs/job-costing'),
  },
  {
    id: 'mock-cfo-change-orders-1',
    module: MODULE,
    severity: 'warn',
    category: 'change_orders',
    title: '$6.8K approved change orders are unbilled',
    body: 'Billing these approved changes protects job margin and speeds up cash collection.',
    metrics: [
      { label: 'Unbilled COs', value: '$6.8K' },
      { label: 'Count', value: '3' },
    ],
    created_at: null,
    is_read: false,
    is_seen: false,
    primary_cta: cta('Open Change Orders', '/dashboard/leads-jobs/change-orders'),
  },
  {
    id: 'mock-cfo-tax-1',
    module: MODULE,
    severity: 'warn',
    category: 'tax',
    title: 'Tax set-aside is running light',
    body: 'Set aside another $2.4K this month to keep the next estimated payment covered.',
    metrics: [
      { label: 'Reserve gap', value: '$2.4K' },
      { label: 'Due window', value: 'Next quarter' },
    ],
    created_at: null,
    is_read: false,
    is_seen: false,
    primary_cta: cta('View Tax Estimate', '/dashboard/tax'),
  },
  {
    id: 'mock-cfo-reconciliation-1',
    module: MODULE,
    severity: 'warn',
    category: 'bookkeeping_reconciliation',
    title: 'Plaid sync is stale',
    body: 'Bank data has not refreshed in 4 days. Refresh before relying on cash or reconciliation alerts.',
    metrics: [
      { label: 'Last sync', value: '4 days ago' },
    ],
    created_at: null,
    is_read: false,
    is_seen: false,
    primary_cta: cta('Run Reconciliation', '/dashboard/accounting/reconciliations'),
  },
];

// Historical module mocks kept only for explicit backwards compatibility.
// InsightsRail imports MOCK_INSIGHTS, so these stale modules are not used by the live/demo rail.
const LEGACY_MOCK_INSIGHTS = [
  {
    id: 'legacy-mock-bizzy-1',
    module: 'bizzy',
    severity: 'warn',
    title: 'Bizzi Pulse 44/100 (At risk)',
    body: 'Legacy dashboard-only mock. Use Contractor CFO rail mocks for current demo behavior.',
    created_at: null,
    is_read: false,
    is_seen: false,
    primary_cta: cta('Open Accounting', '/dashboard/accounting'),
  },
  {
    id: 'legacy-mock-marketing-1',
    module: 'marketing',
    severity: 'info',
    title: '62 new leads this month',
    body: 'Legacy marketing mock retained for old module demos only.',
    created_at: null,
    is_read: false,
    is_seen: false,
    primary_cta: cta('Open Marketing', '/dashboard/marketing'),
  },
  {
    id: 'legacy-mock-investments-1',
    module: 'investments',
    severity: 'info',
    title: 'Portfolio up 5.4%',
    body: 'Legacy investments mock retained for old module demos only.',
    created_at: null,
    is_read: false,
    is_seen: false,
    primary_cta: cta('Open Investments', '/dashboard/investments'),
  },
  {
    id: 'legacy-mock-calendar-1',
    module: 'calendar',
    severity: 'info',
    title: 'No meetings scheduled',
    body: 'Legacy calendar mock retained for old module demos only.',
    created_at: null,
    is_read: false,
    is_seen: false,
  },
  {
    id: 'legacy-mock-email-1',
    module: 'email',
    severity: 'warn',
    title: '2 urgent emails pending',
    body: 'Legacy email mock retained for old module demos only.',
    created_at: null,
    is_read: false,
    is_seen: false,
    primary_cta: cta('Open Dashboard', '/dashboard/accounting'),
    account_id: 'mock-email-acct',
  },
  {
    id: 'legacy-mock-ops-1',
    module: 'ops',
    severity: 'info',
    title: '3 active jobs',
    body: 'Legacy ops mock retained for old module demos only.',
    created_at: null,
    is_read: false,
    is_seen: false,
    primary_cta: cta('Open Job Costing', '/dashboard/leads-jobs/job-costing'),
  },
];

const MOCK_INSIGHTS = CONTRACTOR_CFO_MOCK_INSIGHTS;

function getMockInsights({ includeLegacy = false } = {}) {
  return includeLegacy ? [...CONTRACTOR_CFO_MOCK_INSIGHTS, ...LEGACY_MOCK_INSIGHTS] : MOCK_INSIGHTS;
}

function countMockInsights({ suppress, includeLegacy = false } = {}) {
  const skip = suppress ? new Set([...suppress].map((x) => String(x || '').toLowerCase())) : null;
  return getMockInsights({ includeLegacy }).reduce((acc, item) => {
    const key = String(item.module || '').toLowerCase();
    if (skip && skip.has(key)) return acc;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

export {
  CONTRACTOR_CFO_MOCK_INSIGHTS,
  LEGACY_MOCK_INSIGHTS,
  MOCK_INSIGHTS,
  countMockInsights,
  getMockInsights,
};
