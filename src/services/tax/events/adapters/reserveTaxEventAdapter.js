import { TAX_RECALCULATION_EVENT_TYPES as EVENTS } from "../taxRecalculationEventDomain.js";

export function reserveTaxEvent({ changeType, businessId, taxYear, accountId, userId, before, after } = {}) {
  const eventType = changeType === "tax_reserve_account_created"
    ? EVENTS.TAX_RESERVE_ACCOUNT_CREATED
    : changeType === "tax_reserve_account_primary_changed"
      ? EVENTS.TAX_RESERVE_ACCOUNT_PRIMARY_CHANGED
      : changeType === "tax_reserve_balance_refreshed"
        ? EVENTS.TAX_RESERVE_BALANCE_REFRESHED
        : EVENTS.TAX_RESERVE_ACCOUNT_UPDATED;
  return {
    eventType,
    businessId,
    taxYear,
    userId,
    source: "tax_reserve",
    sourceRecordId: accountId || after?.id || before?.id,
    sourceTable: "tax_reserve_accounts",
    changedFields: changedFields(before, after),
    before,
    after,
    materiality: { amount: Math.abs(Number(after?.manual_balance ?? before?.manual_balance ?? 0)) || null },
  };
}

function changedFields(before = {}, after = {}) {
  return [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])]
    .filter((field) => before?.[field] !== after?.[field]);
}
