// /src/services/tax/explanations/taxSourceReferenceBuilder.js
import { TAX_SOURCE_REFERENCE_TYPES } from "./taxExplanationDomain.js";

export function profileRef(profile, field, value = undefined) {
  if (!profile?.id) return null;
  return compactRef({
    type: TAX_SOURCE_REFERENCE_TYPES.TAX_PROFILE,
    id: profile.id,
    label: `Tax profile ${profile.tax_year || ""}`.trim(),
    field,
    value: value ?? profile?.[field],
    date: profile.updated_at || profile.created_at || null,
  });
}

export function memoryRef(memory, field = "value_json") {
  if (!memory?.id) return null;
  return compactRef({
    type: TAX_SOURCE_REFERENCE_TYPES.TAX_MEMORY,
    id: memory.id,
    label: memory.memory_key,
    field,
    value: memory[field],
    date: memory.effective_from || memory.updated_at || null,
  });
}

export function ruleRef(rule, type = TAX_SOURCE_REFERENCE_TYPES.TAX_RULE_CONFIG) {
  if (!rule?.id && !rule?.version) return null;
  return compactRef({
    type,
    id: rule.id || null,
    label: rule.rule_type || rule.source_name || "Tax rule",
    field: "config",
    version: rule.version || null,
    supportLevel: rule.support_level || rule.supportLevel || null,
    date: rule.verified_at || rule.verifiedAt || null,
  });
}

export function paymentRef(payment, field = "amount") {
  if (!payment?.id) return null;
  return compactRef({
    type: TAX_SOURCE_REFERENCE_TYPES.TAX_PAYMENT,
    id: payment.id,
    label: payment.payment_type || payment.type || "Tax payment",
    field,
    value: payment[field],
    date: payment.payment_date || payment.date || null,
  });
}

export function forecastRef(source, field = "projection") {
  return compactRef({
    type: TAX_SOURCE_REFERENCE_TYPES.FORECAST,
    id: source?.id || null,
    label: source?.label || source?.method || "Projection source",
    field,
    value: source?.value,
    date: source?.date || source?.updated_at || null,
  });
}

export function priorRunRef(run, field = "estimated_total_tax") {
  if (!run?.id) return null;
  return compactRef({
    type: TAX_SOURCE_REFERENCE_TYPES.PRIOR_CALCULATION_RUN,
    id: run.id,
    label: `Prior tax run ${run.tax_year || ""}`.trim(),
    field,
    value: run[field],
    date: run.completed_at || run.created_at || null,
  });
}

export function aggregateTransactionClassificationRef({ businessId, taxYear, taxCategory, count, representativeRefs = [] } = {}) {
  return compactRef({
    type: TAX_SOURCE_REFERENCE_TYPES.TRANSACTION_CLASSIFICATION,
    id: null,
    label: taxCategory ? `Classified ${taxCategory} transactions` : "Classified transactions",
    count: Number(count || 0),
    filter: { businessId, taxYear, taxCategory },
    drillDownEndpoint: `/api/tax/deductions/transactions?businessId=${businessId}&year=${taxYear}${taxCategory ? `&taxCategory=${encodeURIComponent(taxCategory)}` : ""}`,
    representativeRefs: representativeRefs.slice(0, 5),
  });
}

export function systemAssumptionRef(label, field, value) {
  return compactRef({
    type: TAX_SOURCE_REFERENCE_TYPES.SYSTEM_ASSUMPTION,
    id: null,
    label,
    field,
    value,
  });
}

export function compactRefs(refs) {
  return (refs || []).filter(Boolean).map(compactRef).filter(Boolean);
}

function compactRef(ref) {
  if (!ref) return null;
  const out = {};
  for (const [key, value] of Object.entries(ref)) {
    if (value != null && value !== "") out[key] = value;
  }
  return out;
}
