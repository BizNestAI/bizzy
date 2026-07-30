// /src/services/tax/reserve/taxReserveDomain.js

export const TAX_RESERVE_STATUSES = Object.freeze({
  ON_TRACK: "on_track",
  SLIGHTLY_BEHIND: "slightly_behind",
  RESERVE_GAP: "reserve_gap",
  CRITICAL_SHORTFALL: "critical_shortfall",
  SETUP_INCOMPLETE: "setup_incomplete",
  UNAVAILABLE: "unavailable",
});

export const TAX_RESERVE_STRATEGIES = Object.freeze({
  REMAINING_LIABILITY: "remaining_liability",
  SAFE_HARBOR: "safe_harbor",
  HIGHER_OF_LIABILITY_OR_SAFE_HARBOR: "higher_of_liability_or_safe_harbor",
  NEXT_DEADLINE: "next_deadline",
  CUSTOM: "custom",
  CONSERVATIVE_BUFFERED: "conservative_buffered",
});

export const TAX_RESERVE_TRACKING_METHODS = Object.freeze({
  PLAID: "plaid",
  QBO: "qbo",
  MANUAL: "manual",
});

export const TAX_RESERVE_WARNING_CODES = Object.freeze({
  RESERVE_ACCOUNT_MISSING: "reserve_account_missing",
  RESERVE_BALANCE_STALE: "reserve_balance_stale",
  LIABILITY_UNAVAILABLE: "liability_unavailable",
  SAFE_HARBOR_UNAVAILABLE: "safe_harbor_unavailable",
  PAYMENT_DATA_INCOMPLETE: "payment_data_incomplete",
  NEGATIVE_RESERVE_BALANCE: "negative_reserve_balance",
  MULTIPLE_PRIMARY_ACCOUNTS: "multiple_primary_accounts",
  RESERVE_ACCOUNT_NOT_VERIFIED: "reserve_account_not_verified",
  CASHFLOW_SHORTFALL: "cashflow_shortfall",
  NEXT_DEADLINE_MISSING: "next_deadline_missing",
  LOW_CONFIDENCE_TAX_ESTIMATE: "low_confidence_tax_estimate",
});

export const TAX_RESERVE_SNAPSHOT_STATUSES = new Set([
  TAX_RESERVE_STATUSES.ON_TRACK,
  TAX_RESERVE_STATUSES.SLIGHTLY_BEHIND,
  TAX_RESERVE_STATUSES.RESERVE_GAP,
  TAX_RESERVE_STATUSES.CRITICAL_SHORTFALL,
  TAX_RESERVE_STATUSES.SETUP_INCOMPLETE,
]);

export function reserveWarning(code, message, severity = "medium", action = null, extra = {}) {
  return { code, severity, message, action, ...extra };
}
