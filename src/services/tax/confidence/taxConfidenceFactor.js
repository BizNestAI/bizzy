// /src/services/tax/confidence/taxConfidenceFactor.js
import { TAX_CONFIDENCE_BLOCKER_SEVERITIES, TAX_CONFIDENCE_MATERIALITY } from "./taxConfidenceDomain.js";

export function createConfidenceFactor({
  code,
  category,
  label,
  score,
  weight,
  status,
  severity = TAX_CONFIDENCE_BLOCKER_SEVERITIES.INFORMATIONAL,
  materiality = TAX_CONFIDENCE_MATERIALITY.LOW,
  message,
  impact,
  source,
  fixAction = null,
  relatedComponents = [],
  metadata = {},
} = {}) {
  const numericScore = clamp(score);
  const numericWeight = Math.max(0, Number(weight || 0));
  return {
    code,
    category,
    label: label || code,
    score: numericScore,
    weight: numericWeight,
    weightedScore: round2(numericScore * numericWeight),
    status: status || statusForScore(numericScore),
    severity,
    materiality,
    message: message || label || code,
    impact: impact || impactForScore(numericScore),
    source: source || category,
    fixAction,
    relatedComponents,
    metadata,
  };
}

export function createConfidenceBlocker({
  code,
  severity = TAX_CONFIDENCE_BLOCKER_SEVERITIES.MAJOR,
  message,
  affectedOutputs = [],
  fixAction,
  resolvable = true,
} = {}) {
  return {
    code,
    severity,
    message: message || code,
    affectedOutputs,
    fixAction,
    resolvable,
  };
}

export function createConfidencePenalty({
  code,
  category,
  points,
  message,
  materiality = TAX_CONFIDENCE_MATERIALITY.LOW,
  fixAction = null,
  relatedComponents = [],
} = {}) {
  return {
    code,
    category,
    points: Math.max(0, Number(points || 0)),
    message: message || code,
    materiality,
    fixAction,
    relatedComponents,
  };
}

function statusForScore(score) {
  if (score >= 85) return "strong";
  if (score >= 60) return "usable";
  if (score > 0) return "weak";
  return "unavailable";
}

function impactForScore(score) {
  if (score >= 85) return "positive";
  if (score >= 60) return "neutral";
  if (score > 0) return "negative";
  return "blocking";
}

function clamp(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function round2(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}
