import { supabase } from "../supabaseAdmin.js";

const FALLBACK_TARGET_MARGIN_PERCENT = 35;
const MAX_SAFE_TARGET_MARGIN_PERCENT = 95;

function roundCurrency(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function roundPercent(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function isMissingSchemaError(error) {
  return error?.code === "42P01" || error?.code === "42703" || /does not exist|schema cache|column/i.test(error?.message || "");
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeMargin(value) {
  const margin = Number(value);
  if (!Number.isFinite(margin) || margin <= 0 || margin >= MAX_SAFE_TARGET_MARGIN_PERCENT) {
    return null;
  }
  return margin;
}

function hasMarginValue(value) {
  return value !== undefined && value !== null && value !== "";
}

function getJobTradeType(job = {}, explicitTradeType = null) {
  return normalizeText(explicitTradeType || job.trade_type || job.trade || job.service_type || job.category);
}

function getJobMarginPercent(job = {}) {
  const explicitMargin = Number(job.margin_percent ?? job.margin_pct ?? job.margin);
  if (Number.isFinite(explicitMargin)) return explicitMargin;

  const revenue = Number(job.revenue ?? job.total_revenue ?? job.amount_contracted ?? job.amount_invoiced ?? job.amount_estimated);
  const cost = Number(job.total_cost ?? job.cost ?? job.actual_cost ?? job.amount_cost);
  if (Number.isFinite(revenue) && revenue > 0 && Number.isFinite(cost)) {
    return ((revenue - cost) / revenue) * 100;
  }
  return null;
}

function calculatePrice(estimatedCost, targetMarginPercent) {
  if (!Number.isFinite(estimatedCost) || estimatedCost <= 0) {
    return {
      recommended_price: 0,
      gross_margin_amount: 0,
      margin_percent: 0,
      markup_percent: 0,
    };
  }

  const targetMarginDecimal = targetMarginPercent / 100;
  const recommendedPrice = roundCurrency(estimatedCost / (1 - targetMarginDecimal));
  const grossMarginAmount = roundCurrency(recommendedPrice - estimatedCost);
  return {
    recommended_price: recommendedPrice,
    gross_margin_amount: grossMarginAmount,
    margin_percent: roundPercent(recommendedPrice > 0 ? (grossMarginAmount / recommendedPrice) * 100 : 0),
    markup_percent: roundPercent(estimatedCost > 0 ? (grossMarginAmount / estimatedCost) * 100 : 0),
  };
}

async function fetchJob(businessId, jobId) {
  if (!businessId || !jobId) return null;
  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("business_id", businessId)
    .eq("id", jobId)
    .maybeSingle();
  if (error) {
    if (isMissingSchemaError(error)) return null;
    throw error;
  }
  return data || null;
}

async function fetchTradeTarget(businessId, tradeType) {
  if (!businessId || !tradeType) return null;
  const { data, error } = await supabase
    .from("job_margin_targets")
    .select("target_margin_percent")
    .eq("business_id", businessId)
    .eq("trade_type", tradeType)
    .maybeSingle();
  if (error) {
    if (isMissingSchemaError(error)) return null;
    throw error;
  }
  return normalizeMargin(data?.target_margin_percent);
}

async function fetchHistoricalAverageMargin(businessId, tradeType) {
  if (!businessId) return null;

  let query = supabase
    .from("jobs")
    .select("*")
    .eq("business_id", businessId)
    .in("status", ["completed", "closed", "won"])
    .limit(100);

  if (tradeType) query = query.eq("trade_type", tradeType);

  const { data, error } = await query;
  if (error) {
    if (isMissingSchemaError(error)) return null;
    throw error;
  }

  const margins = (data || [])
    .map(getJobMarginPercent)
    .map(normalizeMargin)
    .filter((margin) => margin !== null);

  if (!margins.length) return null;
  return margins.reduce((sum, margin) => sum + margin, 0) / margins.length;
}

async function resolveTargetMargin({ businessId, jobId, targetMarginPercent, tradeType }) {
  const explicitMargin = normalizeMargin(targetMarginPercent);
  if (explicitMargin !== null) {
    return { margin: explicitMargin, basis: "explicit_target", job: null, tradeType: normalizeText(tradeType) };
  }
  if (hasMarginValue(targetMarginPercent)) {
    return { margin: FALLBACK_TARGET_MARGIN_PERCENT, basis: "fallback", job: null, tradeType: normalizeText(tradeType) };
  }

  const job = await fetchJob(businessId, jobId);
  const resolvedTradeType = getJobTradeType(job || {}, tradeType);
  const jobMargin = normalizeMargin(job?.target_margin ?? job?.target_margin_percent);
  if (jobMargin !== null) {
    return { margin: jobMargin, basis: "job_target", job, tradeType: resolvedTradeType };
  }
  if (hasMarginValue(job?.target_margin ?? job?.target_margin_percent)) {
    return { margin: FALLBACK_TARGET_MARGIN_PERCENT, basis: "fallback", job, tradeType: resolvedTradeType };
  }

  const tradeMargin = await fetchTradeTarget(businessId, resolvedTradeType);
  if (tradeMargin !== null) {
    return { margin: tradeMargin, basis: "trade_target", job, tradeType: resolvedTradeType };
  }

  const historicalMargin = await fetchHistoricalAverageMargin(businessId, resolvedTradeType);
  if (historicalMargin !== null) {
    return { margin: historicalMargin, basis: "historical_average", job, tradeType: resolvedTradeType };
  }

  return { margin: FALLBACK_TARGET_MARGIN_PERCENT, basis: "fallback", job, tradeType: resolvedTradeType };
}

function buildExplanation(basis, targetMarginPercent, tradeType) {
  const margin = roundPercent(targetMarginPercent);
  if (basis === "explicit_target") return `Used the requested ${margin}% target margin.`;
  if (basis === "job_target") return `Used this job's ${margin}% target margin.`;
  if (basis === "trade_target") return `Used the ${margin}% target margin for ${tradeType || "this trade"}.`;
  if (basis === "historical_average") return `Used the ${margin}% average margin from similar completed jobs.`;
  return `Used the fallback ${margin}% target margin.`;
}

export async function recommendChangeOrderPrice({
  businessId,
  jobId,
  estimatedCost,
  targetMarginPercent,
  tradeType,
} = {}) {
  const parsedEstimatedCost = Number(estimatedCost);
  const safeEstimatedCost = Number.isFinite(parsedEstimatedCost) && parsedEstimatedCost > 0 ? parsedEstimatedCost : 0;
  const { margin, basis, tradeType: resolvedTradeType } = await resolveTargetMargin({
    businessId,
    jobId,
    targetMarginPercent,
    tradeType,
  });
  const pricing = calculatePrice(safeEstimatedCost, margin);

  return {
    estimated_cost: roundCurrency(safeEstimatedCost),
    target_margin_percent: roundPercent(margin),
    recommended_price: pricing.recommended_price,
    gross_margin_amount: pricing.gross_margin_amount,
    margin_percent: pricing.margin_percent,
    markup_percent: pricing.markup_percent,
    basis,
    explanation: buildExplanation(basis, margin, resolvedTradeType),
  };
}

export default recommendChangeOrderPrice;
