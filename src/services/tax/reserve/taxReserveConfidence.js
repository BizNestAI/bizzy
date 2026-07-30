// /src/services/tax/reserve/taxReserveConfidence.js
import { TAX_CONFIDENCE_LEVELS } from "../confidence/taxConfidenceDomain.js";
import { TAX_RESERVE_WARNING_CODES } from "./taxReserveDomain.js";

export function computeTaxReserveConfidence({
  canonicalTaxResult,
  reserveAccount,
  reserveBalance,
  policy,
  warnings = [],
  asOfDate,
} = {}) {
  const factors = [];
  const penalties = [];
  const blockers = [];
  let score = clamp(Number(canonicalTaxResult?.confidence?.score ?? 50));

  addFactor(factors, "tax_estimate_confidence", "Tax estimate confidence", score, "canonical_tax_result");
  if (!canonicalTaxResult?.liability || !Number.isFinite(Number(canonicalTaxResult.liability.projectedTotalTax))) {
    blockers.push({
      code: TAX_RESERVE_WARNING_CODES.LIABILITY_UNAVAILABLE,
      severity: "fatal",
      message: "Projected tax liability is unavailable, so reserve guidance cannot be calculated.",
      affectedOutputs: ["reserve"],
      fixAction: "run_tax_calculation",
      resolvable: true,
    });
  }

  if (!reserveAccount) {
    penalties.push(penalty(TAX_RESERVE_WARNING_CODES.RESERVE_ACCOUNT_MISSING, 25, "No designated tax reserve account is connected.", "connect_reserve_account"));
    blockers.push({
      code: TAX_RESERVE_WARNING_CODES.RESERVE_ACCOUNT_MISSING,
      severity: "major",
      message: "Current reserve balance is unknown because no reserve account is designated.",
      affectedOutputs: ["currentReserve", "reserveGap"],
      fixAction: "connect_reserve_account",
      resolvable: true,
    });
  } else {
    addFactor(factors, "reserve_account_designated", "Reserve account designated", 100, reserveAccount.trackingMethod || "manual");
  }

  if (reserveAccount && reserveBalance?.currentReserve == null) {
    penalties.push(penalty(TAX_RESERVE_WARNING_CODES.RESERVE_ACCOUNT_NOT_VERIFIED, 20, "Reserve account balance is unavailable.", "refresh_reserve_account"));
  }

  const stale = isStale(reserveBalance?.lastVerifiedAt, asOfDate, 7);
  if (reserveBalance?.lastVerifiedAt && stale) {
    penalties.push(penalty(TAX_RESERVE_WARNING_CODES.RESERVE_BALANCE_STALE, 10, "Reserve balance is older than the freshness threshold.", "refresh_reserve_account"));
  }

  if (warnings.some((warning) => warning.code === TAX_RESERVE_WARNING_CODES.SAFE_HARBOR_UNAVAILABLE)) {
    penalties.push(penalty(TAX_RESERVE_WARNING_CODES.SAFE_HARBOR_UNAVAILABLE, 8, "Safe harbor is unavailable for reserve strategy.", "verify_tax_rule_config"));
  }
  if (canonicalTaxResult?.confidence?.reserveReady === false) {
    penalties.push(penalty(TAX_RESERVE_WARNING_CODES.LOW_CONFIDENCE_TAX_ESTIMATE, 10, "The tax estimate is not reserve-ready.", "improve_tax_confidence"));
  }

  for (const item of penalties) score -= item.points;
  if (blockers.some((blocker) => blocker.severity === "fatal")) score = 0;
  score = clamp(score);
  const level = blockers.some((blocker) => blocker.severity === "fatal")
    ? TAX_CONFIDENCE_LEVELS.UNAVAILABLE
    : score >= 80
      ? TAX_CONFIDENCE_LEVELS.HIGH
      : score >= 60
        ? TAX_CONFIDENCE_LEVELS.MEDIUM
        : score >= 30
          ? TAX_CONFIDENCE_LEVELS.LOW
          : TAX_CONFIDENCE_LEVELS.UNAVAILABLE;

  return {
    score,
    level,
    reserveReady: !blockers.length && score >= 60,
    factors,
    penalties,
    blockers,
    policySource: policy?.source || null,
  };
}

function addFactor(factors, code, label, score, source) {
  factors.push({ code, label, score: clamp(score), source });
}

function penalty(code, points, message, fixAction) {
  return { code, points, message, fixAction };
}

function isStale(date, asOfDate, thresholdDays) {
  const then = Date.parse(date || "");
  const cutoff = Date.parse(`${asOfDate || new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(then) || !Number.isFinite(cutoff)) return false;
  return cutoff - then > thresholdDays * 86400000;
}

function clamp(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}
