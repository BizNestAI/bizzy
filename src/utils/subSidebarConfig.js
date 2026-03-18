// /src/utils/subSidebarConfig.js

const financialsTabs = [
  { label: 'Books', path: '/dashboard/accounting/bookkeeping' },
  { label: 'Forecasts', path: '/dashboard/accounting/Forecasts' },
  { label: 'Health', path: '/dashboard/accounting' },
  { label: 'Reports', path: '/dashboard/accounting/Reports' },
  { label: 'Reconciliations', path: '/dashboard/accounting/reconciliations' },
  //{ label: 'Scenarios', path: '/dashboard/accounting/Scenarios' },
];

export const subSidebarConfig = {
  financials: financialsTabs,
  accounting: financialsTabs, // alias for accounting paths
  marketing: [
    { label: 'Reviews', path: '/dashboard/marketing/reviews' },
    { label: 'Caption Generator', path: '/dashboard/marketing/captions' },
    // { label: 'Gallery', path: '/dashboard/marketing/Gallery' },
  ],
  tax: [
    { label: 'Deductions', path: '/dashboard/tax/Deductions' },
  ],
  investments: [
    { label: 'Retirement Simulator', path: '/dashboard/investments/Retirement' },
  ],
};
