// /src/services/tax/taxClassificationAmounts.js
import { DEDUCTIBILITY_STATUSES } from "./taxDomain.js";

export function computeClassificationAmounts({
  signedAmount,
  direction,
  deductibilityStatus,
  deductiblePercent,
  taxCategory,
} = {}) {
  const bookAmount = round2(signedAmount);
  const absoluteAmount = Math.abs(bookAmount);
  const status = String(deductibilityStatus || "");
  const percent = normalizeDeductiblePercent({ deductibilityStatus: status, deductiblePercent });
  const isInflow = String(direction || "").toUpperCase() === "INFLOW";
  const isExcluded = taxCategory === "excluded" || status === "excluded";

  if (isInflow || isExcluded || status === DEDUCTIBILITY_STATUSES.BALANCE_SHEET) {
    return { bookAmount, deductibleAmount: 0, nondeductibleAmount: 0, capitalizableAmount: 0, deductiblePercent: percent };
  }
  if (status === DEDUCTIBILITY_STATUSES.CAPITALIZABLE) {
    return { bookAmount, deductibleAmount: 0, nondeductibleAmount: 0, capitalizableAmount: absoluteAmount, deductiblePercent: 0 };
  }
  if (status === DEDUCTIBILITY_STATUSES.NONDEDUCTIBLE) {
    return { bookAmount, deductibleAmount: 0, nondeductibleAmount: absoluteAmount, capitalizableAmount: 0, deductiblePercent: 0 };
  }
  if (status === DEDUCTIBILITY_STATUSES.NEEDS_REVIEW) {
    return { bookAmount, deductibleAmount: 0, nondeductibleAmount: 0, capitalizableAmount: 0, deductiblePercent: 0 };
  }

  const deductibleAmount = round2(absoluteAmount * (percent / 100));
  const nondeductibleAmount = round2(Math.max(0, absoluteAmount - deductibleAmount));
  return { bookAmount, deductibleAmount, nondeductibleAmount, capitalizableAmount: 0, deductiblePercent: percent };
}

export function normalizeDeductiblePercent({ deductibilityStatus, deductiblePercent } = {}) {
  const status = String(deductibilityStatus || "");
  if (status === DEDUCTIBILITY_STATUSES.FULLY_DEDUCTIBLE) return 100;
  if ([DEDUCTIBILITY_STATUSES.NONDEDUCTIBLE, DEDUCTIBILITY_STATUSES.CAPITALIZABLE, DEDUCTIBILITY_STATUSES.BALANCE_SHEET].includes(status)) return 0;
  const raw = Number(deductiblePercent || 0);
  if (!Number.isFinite(raw)) return 0;
  const pct = raw <= 1 ? raw * 100 : raw;
  return round2(Math.max(0, Math.min(100, pct)));
}

function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}
