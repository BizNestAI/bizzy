export const BUSINESS = '00000000-0000-4000-8000-000000000001';
export function operatingFixture() {
  const config = {
    qbo_realm_id: 'fixture-realm',
    reporting_timezone: 'America/New_York',
    status: 'verified',
    timezone_confirmed_at: '2026-01-01',
    home_currency: 'USD'
  };
  const months = Array.from({
    length: 12
  }, (_, i) => {
    const d = new Date(Date.UTC(2025, 10 + i, 1)),
      month = d.toISOString().slice(0, 10),
      id = `00000000-0000-4000-8000-${String(i + 10).padStart(12, '0')}`;
    const [revenue, expense] = i === 9 ? [3892.45, 5106.99] : i === 10 ? [975, 5221.32] : i === 11 ? [600, 3924.43] : [2500, 3600];
    const software = i % 2 ? 825 : 600;
    const account = (key, type, amount) => ({
      business_id: BUSINESS,
      snapshot_id: id,
      qbo_account_id: key,
      account_name: key,
      account_type: type,
      total_amount: Math.round(amount * 100) / 100
    });
    const accounts = [account('sales', 'Income', revenue), account('rent', 'Expense', 1800), account('software', 'Expense', software), account('other-costs', 'Expense', expense - 1800 - software), account('direct', 'Cost of Goods Sold', 100), account('credit', 'Expense', -25), account('offset', 'Expense', 25), account('investment', 'Other Income', i === 11 ? 2209.26 : 0)];
    const snapshot = {
      id,
      business_id: BUSINESS,
      qbo_realm_id: 'fixture-realm',
      review_year: d.getUTCFullYear(),
      review_month: d.getUTCMonth() + 1,
      source_start_date: month,
      source_end_date: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10),
      accounting_method: 'Cash',
      status: 'current',
      is_current: true,
      revenue,
      cogs: 100,
      expenses: expense,
      net_profit: Math.round((revenue - 100 - expense + (i === 11 ? 2209.26 : 0)) * 100) / 100,
      metadata: {}
    };
    return {
      month,
      snapshot,
      accounts
    };
  });
  return {
    config,
    months
  };
}
