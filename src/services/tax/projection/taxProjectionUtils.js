// /src/services/tax/projection/taxProjectionUtils.js
import { normalizeDateOnly, normalizeMoney, normalizeTaxYear } from "../taxDomain.js";
import { validationError } from "../taxErrors.js";
import { PROJECTION_WARNING_CODES, projectionWarning, round2 } from "./taxProjectionDomain.js";

export function buildProjectionContext({ supabase, businessId, taxYear, year, asOfDate }) {
  if (!supabase) throw new Error("Supabase client required");
  if (!businessId) throw validationError("missing_business_id", "businessId is required.");
  const normalizedYear = normalizeTaxYear(taxYear ?? year);
  if (!normalizedYear) throw validationError("invalid_tax_year", "Tax year must be between 2000 and 2100.", { field: "year" });
  const cutoff = normalizeDateOnly(asOfDate) || currentAsOfDate(normalizedYear);
  if (!cutoff.startsWith(`${normalizedYear}-`)) {
    throw validationError("invalid_as_of_date", "asOfDate must be within the selected tax year.", { field: "asOfDate" });
  }
  return { supabase, businessId, taxYear: normalizedYear, asOfDate: cutoff };
}

export function currentAsOfDate(year) {
  const today = new Date().toISOString().slice(0, 10);
  if (today.startsWith(`${year}-`)) return today;
  return `${year}-12-31`;
}

export function monthKey(date) {
  return String(date).slice(0, 7);
}

export function monthsForYear(year) {
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
}

export function monthStart(month) {
  return `${month}-01`;
}

export function monthEnd(month) {
  const [year, rawMonth] = month.split("-").map(Number);
  const day = new Date(Date.UTC(year, rawMonth, 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, "0")}`;
}

export function daysInMonthKey(month) {
  const [year, rawMonth] = month.split("-").map(Number);
  return new Date(Date.UTC(year, rawMonth, 0)).getUTCDate();
}

export function dayOfMonth(date) {
  return Number(String(date).slice(8, 10));
}

export function completedMonths({ taxYear, asOfDate }) {
  return monthsForYear(taxYear).filter((month) => monthEnd(month) <= asOfDate);
}

export function futureMonths({ taxYear, asOfDate }) {
  return monthsForYear(taxYear).filter((month) => monthStart(month) > asOfDate);
}

export function isPartialCurrentMonth(asOfDate) {
  return asOfDate < monthEnd(monthKey(asOfDate));
}

export function actualProjectionComponents(row = {}) {
  const revenue = Number(row.revenue || 0);
  const cogs = Number(row.cogs || 0);
  const deductibleExpenses = Number(row.deductibleExpenses || row.deductible_expenses || 0);
  const taxableBusinessIncome = row.taxableBusinessIncome == null
    ? round2(revenue - cogs - deductibleExpenses)
    : Number(row.taxableBusinessIncome || 0);
  return { revenue, cogs, deductibleExpenses, taxableBusinessIncome };
}

export function emptyComponentRow() {
  return { revenue: 0, cogs: 0, deductibleExpenses: 0, taxableBusinessIncome: 0 };
}

export function addRows(a = {}, b = {}) {
  return {
    revenue: round2(Number(a.revenue || 0) + Number(b.revenue || 0)),
    cogs: round2(Number(a.cogs || 0) + Number(b.cogs || 0)),
    deductibleExpenses: round2(Number(a.deductibleExpenses || 0) + Number(b.deductibleExpenses || 0)),
    taxableBusinessIncome: round2(Number(a.taxableBusinessIncome || 0) + Number(b.taxableBusinessIncome || 0)),
  };
}

export function scaleRow(row = {}, factor) {
  return {
    revenue: round2(Number(row.revenue || 0) * factor),
    cogs: round2(Number(row.cogs || 0) * factor),
    deductibleExpenses: round2(Number(row.deductibleExpenses || 0) * factor),
    taxableBusinessIncome: round2(Number(row.taxableBusinessIncome || 0) * factor),
  };
}

export function sumMonthly(monthly = {}, months = Object.keys(monthly)) {
  return months.reduce((sum, month) => addRows(sum, actualProjectionComponents(monthly[month] || {})), emptyComponentRow());
}

export function totalFromAnnual(revenue, cogs, deductibleExpenses) {
  return {
    revenue: round2(revenue),
    cogs: round2(cogs),
    deductibleExpenses: round2(deductibleExpenses),
    taxableBusinessIncome: round2(Number(revenue || 0) - Number(cogs || 0) - Number(deductibleExpenses || 0)),
  };
}

export function mergeActualAndProjectedMonths({ actualMonthly = {}, projectedMonthly = {}, asOfDate, taxYear, partialMode = "include_actual_to_date_and_project_remainder" }) {
  const months = monthsForYear(taxYear);
  const actualCutoffMonth = monthKey(asOfDate);
  const monthly = {};
  const warnings = [];
  for (const month of months) {
    const actual = actualProjectionComponents(actualMonthly[month] || {});
    const projected = actualProjectionComponents(projectedMonthly[month] || {});
    if (month < actualCutoffMonth) {
      monthly[month] = { ...actual, source: "actual" };
    } else if (month === actualCutoffMonth) {
      if (partialMode === "include_actual_to_date_and_project_remainder" && asOfDate < monthEnd(month)) {
        const remainingRatio = (daysInMonthKey(month) - dayOfMonth(asOfDate)) / daysInMonthKey(month);
        monthly[month] = { ...addRows(actual, scaleRow(projected, remainingRatio)), source: "actual_plus_projected_remainder", partial: true };
      } else {
        monthly[month] = { ...actual, source: "actual", partial: false };
      }
      if (projectedMonthly[month]) warnings.push(projectionWarning(PROJECTION_WARNING_CODES.FORECAST_ACTUAL_OVERLAP, "low", "Forecast overlapped the current actual month; actuals won and only the remainder was projected.", { month }));
    } else {
      monthly[month] = { ...projected, source: projectedMonthly[month] ? "projected" : "missing_projection" };
    }
  }
  return { monthly, warnings };
}

export function validateManualOverrides(manualOverrides, taxYear) {
  if (manualOverrides == null) return null;
  if (Array.isArray(manualOverrides) || typeof manualOverrides !== "object") {
    throw validationError("invalid_projection_override", "manualOverrides must be an object.", { field: "manualOverrides" });
  }
  if (!manualOverrides.reason || typeof manualOverrides.reason !== "string" || !manualOverrides.reason.trim()) {
    throw validationError("projection_override_reason_required", "manualOverrides.reason is required.", { field: "manualOverrides.reason" });
  }
  const out = { reason: manualOverrides.reason.trim(), annual: null, monthly: {} };
  if (manualOverrides.annual != null) out.annual = validateOverrideRow(manualOverrides.annual, "manualOverrides.annual");
  if (manualOverrides.monthly != null) {
    if (Array.isArray(manualOverrides.monthly) || typeof manualOverrides.monthly !== "object") {
      throw validationError("invalid_projection_override", "manualOverrides.monthly must be an object.", { field: "manualOverrides.monthly" });
    }
    for (const [month, row] of Object.entries(manualOverrides.monthly)) {
      if (!/^\d{4}-\d{2}$/.test(month) || !month.startsWith(`${taxYear}-`)) {
        throw validationError("invalid_projection_override_month", "Manual override month must be YYYY-MM within the selected year.", { field: `manualOverrides.monthly.${month}` });
      }
      out.monthly[month] = validateOverrideRow(row, `manualOverrides.monthly.${month}`);
    }
  }
  return out;
}

function validateOverrideRow(row, field) {
  if (Array.isArray(row) || typeof row !== "object" || row == null) {
    throw validationError("invalid_projection_override", "Manual override rows must be objects.", { field });
  }
  const allowed = new Set(["revenue", "cogs", "deductibleExpenses", "deductible_expenses", "taxableBusinessIncome", "taxable_business_income"]);
  for (const key of Object.keys(row)) {
    if (!allowed.has(key)) throw validationError("invalid_projection_override_field", "Unsupported manual override field.", { field: `${field}.${key}` });
  }
  return {
    revenue: normalizeOptionalMoney(row.revenue, `${field}.revenue`),
    cogs: normalizeOptionalMoney(row.cogs, `${field}.cogs`),
    deductibleExpenses: normalizeOptionalMoney(row.deductibleExpenses ?? row.deductible_expenses, `${field}.deductibleExpenses`),
    taxableBusinessIncome: normalizeOptionalMoney(row.taxableBusinessIncome ?? row.taxable_business_income, `${field}.taxableBusinessIncome`),
  };
}

function normalizeOptionalMoney(value, field) {
  if (value == null || value === "") return undefined;
  const normalized = normalizeMoney(value);
  if (normalized == null) throw validationError("invalid_projection_override_amount", "Manual override amounts must be finite numbers.", { field });
  return normalized;
}
