// /src/services/tax/explanations/taxExplanationWarnings.js
import { EXPLANATION_SEVERITY_RANK } from "./taxExplanationDomain.js";

export function normalizeExplanationWarnings(warnings = [], relatedComponentKeys = []) {
  const byCode = new Map();
  for (const warning of warnings.flat().filter(Boolean)) {
    const normalized = normalizeWarning(warning, relatedComponentKeys);
    const current = byCode.get(normalized.code);
    if (!current || severityRank(normalized.severity) > severityRank(current.severity)) {
      byCode.set(normalized.code, normalized);
    } else if (current) {
      current.relatedComponentKeys = unique([...(current.relatedComponentKeys || []), ...(normalized.relatedComponentKeys || [])]);
      current.sourceRefs = [...(current.sourceRefs || []), ...(normalized.sourceRefs || [])].slice(0, 10);
    }
  }
  return [...byCode.values()].sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.code.localeCompare(b.code));
}

export function normalizeExplanationAssumptions(assumptions = [], relatedComponentKeys = []) {
  return unique((assumptions || []).filter(Boolean).map((assumption) => {
    if (typeof assumption === "string") {
      return {
        code: slug(assumption),
        label: assumption,
        value: true,
        source: "system",
        confidence: "medium",
        editable: false,
        relatedComponentKeys,
      };
    }
    return {
      code: assumption.code || slug(assumption.label || assumption.message || "assumption"),
      label: assumption.label || assumption.message || assumption.code || "Assumption",
      value: assumption.value ?? true,
      source: assumption.source || "system",
      confidence: assumption.confidence || "medium",
      editable: assumption.editable === true,
      relatedComponentKeys: unique([...(assumption.relatedComponentKeys || []), ...relatedComponentKeys]),
    };
  }), (item) => item.code);
}

function normalizeWarning(warning, relatedComponentKeys) {
  if (typeof warning === "string") {
    return {
      code: slug(warning),
      severity: "medium",
      title: warning,
      message: warning,
      impact: "This may affect estimate confidence.",
      recommendedAction: "review_tax_inputs",
      relatedComponentKeys,
      sourceRefs: [],
    };
  }
  return {
    code: warning.code || slug(warning.message || "tax_warning"),
    severity: warning.severity || "medium",
    title: warning.title || labelFor(warning.code || "Tax warning"),
    message: warning.message || warning.title || warning.code || "Tax warning.",
    impact: warning.impact || "This may affect estimate confidence.",
    recommendedAction: warning.action || warning.recommendedAction || "review_tax_inputs",
    relatedComponentKeys: unique([...(warning.relatedComponentKeys || []), ...relatedComponentKeys]),
    sourceRefs: warning.sourceRefs || [],
  };
}

function severityRank(severity) {
  return EXPLANATION_SEVERITY_RANK[severity] ?? 0;
}

function unique(items, keyFn = (item) => item) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

function slug(value) {
  return String(value || "item").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 80) || "item";
}

function labelFor(value) {
  return String(value || "Tax warning").replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}
