// /src/services/tax/explanations/taxExplanationComponent.js
import { TAX_EXPLANATION_DIRECTIONS, TAX_EXPLANATION_COMPONENT_GROUPS } from "./taxExplanationDomain.js";

export function createTaxExplanationComponent({
  componentKey,
  componentType,
  componentGroup,
  componentName,
  formula = null,
  taxableBase = null,
  rate = null,
  amount = 0,
  direction = TAX_EXPLANATION_DIRECTIONS.INFORMATIONAL,
  summary = "",
  explanation = "",
  detailedExplanation = "",
  sourceRefs = [],
  ruleRefs = [],
  assumptions = [],
  warnings = [],
  confidenceImpact = null,
  display = {},
  metadata = {},
} = {}) {
  const key = requiredString(componentKey, "componentKey");
  const group = componentGroup || TAX_EXPLANATION_COMPONENT_GROUPS.SOURCE_DATA;
  const type = componentType || group;
  const numericAmount = finite(amount, "amount");
  return {
    componentKey: key,
    componentType: type,
    componentGroup: group,
    componentName: componentName || labelFor(type),
    formula: formula ? sanitizeFormula(formula) : null,
    taxableBase: nullableFinite(taxableBase, "taxableBase"),
    rate: nullableFinite(rate, "rate"),
    amount: numericAmount,
    direction,
    summary: boundedText(summary || componentName || labelFor(type), 280),
    explanation: boundedText(explanation || summary || "", 1000),
    detailedExplanation: boundedText(detailedExplanation || explanation || summary || "", 4000),
    sourceRefs: sanitizeRefs(sourceRefs),
    ruleRefs: sanitizeRefs(ruleRefs),
    assumptions: sanitizeArray(assumptions, 20),
    warnings: sanitizeArray(warnings, 50),
    confidenceImpact,
    display: {
      section: display.section || group,
      sortOrder: Number.isFinite(Number(display.sortOrder)) ? Number(display.sortOrder) : 0,
      severity: display.severity || severityFromWarnings(warnings),
      expandable: display.expandable !== false,
      defaultExpanded: display.defaultExpanded === true,
    },
    metadata: sanitizeMetadata(metadata),
  };
}

export function componentToPersistenceRow(component, { businessId, sortOrder } = {}) {
  return {
    business_id: businessId,
    component_key: component.componentKey,
    component_type: component.componentType,
    component_name: component.componentName,
    taxable_base: nullableFinite(component.taxableBase, "taxableBase"),
    rate: nullableFinite(component.rate, "rate"),
    amount: finite(component.amount, "amount"),
    direction: component.direction || null,
    explanation: component.explanation || component.summary || null,
    source_refs: {
      sourceRefs: component.sourceRefs || [],
      ruleRefs: component.ruleRefs || [],
    },
    sort_order: Number.isFinite(Number(sortOrder)) ? Number(sortOrder) : component.display?.sortOrder || 0,
    metadata: component,
  };
}

function sanitizeFormula(formula) {
  return {
    expression: boundedText(formula.expression || "", 500),
    variables: sanitizeMetadata(formula.variables || {}),
    result: nullableFinite(formula.result, "formula.result"),
  };
}

function sanitizeRefs(refs) {
  return sanitizeArray(refs, 25).map((ref) => {
    const safe = {};
    for (const key of ["type", "id", "label", "field", "value", "date", "version", "supportLevel", "count", "filter", "drillDownEndpoint"]) {
      if (ref?.[key] != null) safe[key] = ref[key];
    }
    return sanitizeMetadata(safe);
  });
}

function sanitizeArray(items, max) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, max).map((item) => sanitizeMetadata(item));
}

function sanitizeMetadata(value, depth = 0) {
  if (value == null) return value;
  if (depth > 6) return "[truncated]";
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return boundedText(value, 1200);
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeMetadata(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (isUnsafeKey(key)) continue;
      out[key] = sanitizeMetadata(value[key], depth + 1);
    }
    return out;
  }
  return null;
}

function isUnsafeKey(key) {
  return ["raw", "payload", "response", "access_token", "refresh_token", "secret", "password", "embedding", "prompt"].includes(String(key).toLowerCase());
}

function severityFromWarnings(warnings) {
  if (!Array.isArray(warnings) || !warnings.length) return "info";
  if (warnings.some((warning) => warning?.severity === "critical")) return "critical";
  if (warnings.some((warning) => warning?.severity === "high")) return "high";
  if (warnings.some((warning) => warning?.severity === "medium")) return "medium";
  return "low";
}

function nullableFinite(value, field) {
  if (value == null || value === "") return null;
  return finite(value, field);
}

function finite(value, field) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) throw new TypeError(`${field} must be finite`);
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function requiredString(value, field) {
  const text = String(value || "").trim();
  if (!text) throw new TypeError(`${field} is required`);
  return text;
}

function boundedText(value, max) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function labelFor(value) {
  return String(value || "Tax Component").replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}
