import { TAX_RECALCULATION_EVENT_TYPES as EVENTS } from "../taxRecalculationEventDomain.js";

export function forecastTaxEvent({ businessId, taxYear, forecastId, userId, changedFields = [], before, after, amount } = {}) {
  return {
    eventType: EVENTS.CASHFLOW_FORECAST_UPDATED,
    businessId,
    taxYear,
    userId,
    source: "cashflow_forecast",
    sourceRecordId: forecastId,
    sourceTable: "cashflow_forecast",
    changedFields,
    before,
    after,
    materiality: { amount: Math.abs(Number(amount || 0)) || null },
  };
}
