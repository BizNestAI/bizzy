// Tax estimates use whole-dollar USD consistently. Exact cents remain in the
// calculation, API and saved records; this formatter changes presentation only.
const wholeDollarUsd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
export function formatTaxCurrency(value, fallback = '—') {
  if (value == null || value === '' || !Number.isFinite(Number(value))) return fallback;
  return wholeDollarUsd.format(Number(value));
}
