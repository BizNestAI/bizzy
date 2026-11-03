import { validationError } from "./taxErrors.js";

export const VEHICLE_MILEAGE_RATES = Object.freeze([
  Object.freeze({ purpose: "business", effectiveFrom: "2026-01-01", effectiveTo: "2026-06-30", amountPerMile: 0.725, centsPerMile: 72.5, sourceVersion: "irs-2026-business-v1" }),
  Object.freeze({ purpose: "business", effectiveFrom: "2026-07-01", effectiveTo: "2026-12-31", amountPerMile: 0.76, centsPerMile: 76, sourceVersion: "irs-2026-business-v2" }),
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

export function calculateVehicleMileagePeriods({ entries = [], rates = VEHICLE_MILEAGE_RATES } = {}) {
  if (!Array.isArray(entries) || entries.length > 366) throw mileageError("invalid_mileage_period", "Enter no more than 366 mileage periods.");
  const normalized = entries.map(normalizeMileageEntry);
  const totalMileUnits = normalized.reduce((sum, entry) => sum + Math.round(entry.businessMiles * 100), 0);
  if (totalMileUnits > 100_000_000) throw mileageError("invalid_business_miles", "Annual business miles exceed the accepted range.");
  assertNoOverlappingMileage(normalized);
  const periods = normalized.map((entry) => {
    const matchingRates = rates.filter((rate) => entry.periodStart >= rate.effectiveFrom && entry.periodEnd <= rate.effectiveTo);
    if (matchingRates.length !== 1) throw mileageError("mileage_period_requires_rate_allocation", "Mileage must be allocated to one effective rate period.");
    const rate = matchingRates[0];
    const amount = exactMileageAmount(entry.businessMiles, Number(rate.amountPerMile ?? Number(rate.centsPerMile) / 100));
    return { ...entry, amount, amountPerMile: Number(rate.amountPerMile ?? Number(rate.centsPerMile) / 100), rateSourceVersion: rate.sourceVersion || null };
  });
  return { periods, totalBusinessMiles: totalMileUnits / 100, totalDeduction: roundMoney(periods.reduce((sum, period) => sum + period.amount, 0)) };
}

export function assertNoOverlappingMileage(entries = []) {
  const sorted = [...entries].sort((a, b) => a.periodStart.localeCompare(b.periodStart));
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].periodStart <= sorted[index - 1].periodEnd) throw mileageError("duplicate_or_overlapping_mileage", "Mileage periods cannot overlap.");
  }
}

function normalizeMileageEntry(entry = {}) {
  const periodStart = normalizeDateKey(entry.periodStart ?? entry.period_start ?? entry.date);
  const periodEnd = normalizeDateKey(entry.periodEnd ?? entry.period_end ?? entry.date);
  const rawMiles = entry.businessMiles ?? entry.business_miles;
  if (!periodStart || !periodEnd || periodStart > periodEnd) throw mileageError("invalid_mileage_period", "A valid mileage period is required.");
  if (rawMiles === "" || rawMiles == null || !/^\d+(?:\.\d{1,2})?$/.test(String(rawMiles))) throw mileageError("invalid_business_miles", "Business miles must be a nonnegative number with at most two decimal places.");
  const businessMiles = Number(rawMiles);
  if (!Number.isFinite(businessMiles) || businessMiles < 0 || businessMiles > 1_000_000) throw mileageError("invalid_business_miles", "Business miles are outside the accepted range.");
  return { periodStart, periodEnd, businessMiles };
}

function mileageError(code, message) { return validationError(code, message); }
function roundMoney(value) { return Math.round((Number(value) + Number.EPSILON) * 100) / 100; }

function normalizeDateKey(value) {
  const text = String(value || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text ? text : null;
}

// SQL rounds numeric(miles * rate, 2). Integer units reproduce that rounding
// exactly for the contract's two-place miles and six-place rate precision.
export function exactMileageAmount(miles, rate) {
  if (!Number.isFinite(rate) || rate < 0 || rate > 100 || Math.abs(rate * 1e6 - Math.round(rate * 1e6)) > 0.00001) throw mileageError("invalid_mileage_rate", "Mileage rate is unavailable.");
  const mileUnits = BigInt(Math.round(Number(miles) * 100));
  const rateUnits = BigInt(Math.round(rate * 1e6));
  return Number((mileUnits * rateUnits + 500000n) / 1000000n) / 100;
}
