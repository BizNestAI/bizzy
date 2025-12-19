export const key = 'navigate';

export function test(t) {
  const s = String(t || '').toLowerCase();
  return /\b(open|go to|navigate|show me)\b/.test(s) &&
         /\b(dashboard|financials|marketing|tax|investments|calendar|settings|docs?)\b/.test(s);
}

export async function recipe() {
  // Static map; client will read navigateTo
  const routeMap = {
    bizzy: '/dashboard/bizzy',
    financials: '/dashboard/accounting',
    marketing: '/dashboard/marketing',
    tax: '/dashboard/tax',
    investments: '/dashboard/investments',
    calendar: '/dashboard/calendar',
    settings: '/dashboard/settings',
    docs: '/dashboard/bizzy-docs'
  };
  return { routeMap };
}
