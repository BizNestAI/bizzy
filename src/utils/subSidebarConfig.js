// /src/utils/subSidebarConfig.js

export const subSidebarConfig = {
  financials: [
    { label: 'Books', path: '/dashboard/accounting/bookkeeping' },
    { label: 'Forecasts', path: '/dashboard/accounting/Forecasts' },
    { label: 'Reports', path: '/dashboard/accounting/Reports' },
    //{ label: 'Scenarios', path: '/dashboard/accounting/Scenarios' },
  ],
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
