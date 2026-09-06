// /src/services/tax/taxClassificationAmounts.js
import { DEDUCTIBILITY_STATUSES } from "./taxDomain.js";
import { validationError } from "./taxErrors.js";

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
  if (deductiblePercent == null || deductiblePercent === "") return 0;
  if (typeof deductiblePercent === "string") {
    throw validationError("invalid_deductible_percent", "deductiblePercent must be a numeric whole percentage from 0 to 100.", { field: "deductiblePercent" });
  }
  const raw = Number(deductiblePercent);
  if (!Number.isFinite(raw) || raw < 0 || raw > 100) {
    throw validationError("invalid_deductible_percent", "deductiblePercent must be between 0 and 100.", { field: "deductiblePercent" });
  }
  return round2(raw);
}

function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}
