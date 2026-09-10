export const VEHICLE_MILEAGE_RATES = Object.freeze([
  Object.freeze({ effectiveFrom: "2026-01-01", effectiveTo: "2026-06-30", centsPerMile: 72.5 }),
  Object.freeze({ effectiveFrom: "2026-07-01", effectiveTo: "2026-12-31", centsPerMile: 76 }),
]);

export function getVehicleMileageRateForDate(dateValue, rates = VEHICLE_MILEAGE_RATES) {
  const date = normalizeDateKey(dateValue);
  if (!date) return null;
  return rates.find((rate) => date >= rate.effectiveFrom && date <= rate.effectiveTo) || null;
}

export function calculateVehicleMileageDeduction({ date, miles, estimate = false } = {}) {
  const rate = getVehicleMileageRateForDate(date);
  const normalizedMiles = Number(miles);
  if (!rate || !Number.isFinite(normalizedMiles) || normalizedMiles < 0) {
    return { amount: 0, rate: null, label: "Not calculated", estimate: Boolean(estimate) };
  }
  const amount = Math.round(((rate.centsPerMile / 100) * normalizedMiles + Number.EPSILON) * 100) / 100;
  return { amount, rate: rate.centsPerMile / 100, label: `$${amount.toFixed(2)}`, estimate: Boolean(estimate) };
}

function normalizeDateKey(value) {
  const text = String(value || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}
