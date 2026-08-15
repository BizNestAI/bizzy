import { supabase } from "../supabaseAdmin.js";
import { applyActiveBookkeepingScope, getBookkeepingStartDate } from "../bookkeeping/bookkeepingScope.js";
import {
  isCostTransaction as classifyCostTransaction,
  isRevenueTransaction as classifyRevenueTransaction,
} from "./accountClassification.js";

const FALLBACK_TARGET_MARGIN_PERCENT = 35;
const MAX_SAFE_TARGET_MARGIN_PERCENT = 95;
const MIN_COMPLETED_HISTORY_COUNT = 3;
const MAX_SIMILAR_RECORDS = 8;

const COMPLETED_STATUSES = new Set(["completed", "closed", "won", "paid"]);
const ACTIVE_STATUSES = new Set(["active", "scheduled", "in_progress", "qualified"]);

const FALLBACK_COST_PROFILES = [
  { pattern: /kitchen|bath|remodel|renovat/i, costPerSqft: 175, baseCost: 18000 },
  { pattern: /deck|porch|patio/i, costPerSqft: 65, baseCost: 7500 },
  { pattern: /roof/i, costPerSqft: 9, baseCost: 9000 },
  { pattern: /paint/i, costPerSqft: 4, baseCost: 3500 },
  { pattern: /plumb/i, costPerSqft: 18, baseCost: 4500 },
  { pattern: /electric/i, costPerSqft: 14, baseCost: 4000 },
  { pattern: /floor|tile/i, costPerSqft: 12, baseCost: 5500 },
  { pattern: /landscap|lawn|yard/i, costPerSqft: 8, baseCost: 3000 },
  { pattern: /carpentr|framing|trim/i, costPerSqft: 35, baseCost: 6500 },
];

function roundCurrency(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function roundPercent(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeNeedle(value) {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isMissingSchemaError(error) {
  return error?.code === "42P01" || error?.code === "42703" || /does not exist|schema cache|column/i.test(error?.message || "");
}

function normalizeMargin(value) {
  const margin = Number(value);
  if (!Number.isFinite(margin) || margin <= 0 || margin >= MAX_SAFE_TARGET_MARGIN_PERCENT) return null;
  return margin;
}

function getJobName(job = {}) {
  return job.name || job.job_name || job.project_name || job.customer_name || job.display_name || job.id || "Untitled job";
}

function getJobType(row = {}) {
  return normalizeText(row.job_type || row.type || row.service_type || row.category);
}

function getTradeType(row = {}) {
  return normalizeText(row.trade_type || row.trade || row.service_type || row.category);
}

function getScopeText(row = {}) {
  return normalizeText([
    row.scope_description,
    row.description,
    row.notes,
    row.internal_notes,
    row.draft_scope_summary,
  ].filter(Boolean).join(" "));
}

function getSquareFootage(row = {}) {
  const value = asNumber(row.square_footage ?? row.sqft ?? row.area_sqft);
  return value > 0 ? value : null;
}

function tokenize(...values) {
  const stop = new Set(["the", "and", "for", "with", "from", "into", "this", "that", "job", "project", "scope"]);
  return new Set(
    values
      .map(normalizeNeedle)
      .join(" ")
      .split(" ")
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !stop.has(token))
  );
}

function tokenOverlapScore(inputTokens, recordTokens) {
  if (!inputTokens.size || !recordTokens.size) return 0;
  let matches = 0;
  for (const token of inputTokens) {
    if (recordTokens.has(token)) matches += 1;
  }
  return Math.min(25, (matches / Math.max(inputTokens.size, 1)) * 25);
}

function isCompletedStatus(status) {
  return COMPLETED_STATUSES.has(normalizeNeedle(status));
}

function isActiveStatus(status) {
  return ACTIVE_STATUSES.has(normalizeNeedle(status));
}

function getTransactionAmount(assignment = {}, transaction = {}) {
  const allocationPercent = Number(assignment.allocation_percent ?? 100);
  const percent = Number.isFinite(allocationPercent) ? allocationPercent : 100;
  if (assignment.allocated_amount !== null && assignment.allocated_amount !== undefined) {
    return Math.abs(asNumber(assignment.allocated_amount));
  }
  return Math.abs(asNumber(transaction.amount)) * (percent / 100);
}

function isPostedCategorization(categorization = {}) {
  return categorization?.status === "posted" || Boolean(categorization?.qbo_txn_id);
}

function isRevenueTransaction(transaction = {}, categorization = {}) {
  return classifyRevenueTransaction(transaction, categorization);
}

function isCostTransaction(transaction = {}, categorization = {}) {
  return classifyCostTransaction(transaction, categorization);
}

function classifyCostCategory(row = {}) {
  const text = [
    row.accountName,
    row.vendor,
    row.memo,
    row.transactionName,
  ].join(" ").toLowerCase();

  if (/\b(labor|payroll|wages?|employee|1099 labor|field labor|crew|foreman|installer|technician|worker'?s comp)\b/.test(text)) return "labor";
  if (/\b(materials?|supplies|supply|tools?|lumber|tile|hardware|paint|concrete|drywall|framing|flooring|roofing|shingles?|siding|fasteners?|adhesive|caulk|plumbing parts?|electrical parts?|home depot|lowe'?s|ferguson|sherwin|abc supply|84 lumber|floor & decor|floor and decor|white cap|grainger)\b/.test(text)) return "materials";
  if (/\b(subcontract|sub contractor|contractor|vendor labor|outside service|electrician|plumber|roofer|hvac|masonry|excavat|demo crew|drywall crew)\b/.test(text)) return "subcontractors";
  if (/\b(permit|inspection|license|licence|fee|filing|city of|county|municipal|building dept|building department|plan review)\b/.test(text)) return "permits";
  return "other";
}

async function fetchOptional(table, buildQuery) {
  try {
    const query = buildQuery(supabase.from(table));
    const { data, error } = await query;
    if (error) {
      if (isMissingSchemaError(error)) return [];
      throw error;
    }
    return data || [];
  } catch (error) {
    if (isMissingSchemaError(error)) return [];
    throw error;
  }
}

async function fetchHistoricalData(businessId) {
  const bookkeepingStartDate = await getBookkeepingStartDate(supabase, businessId);
  const jobs = await fetchOptional("jobs", (query) =>
    query.select("*").eq("business_id", businessId).limit(300)
  );

  const jobIds = jobs.map((job) => job.id).filter(Boolean);
  const assignments = await fetchOptional("job_transaction_assignments", (query) =>
    query.select("*").eq("business_id", businessId)
  );
  const transactionIds = Array.from(new Set(assignments.map((row) => row.transaction_id).filter(Boolean)));

  const [transactions, categorizations, changeOrders, bids, outcomes] = await Promise.all([
    transactionIds.length
      ? fetchOptional("bank_transactions", (query) =>
          applyActiveBookkeepingScope(
            query
            .select("id,business_id,date,name,merchant_name,counterparty_name,amount,direction,is_archived")
            .eq("business_id", businessId)
            .in("id", transactionIds),
            bookkeepingStartDate
          )
        )
      : [],
    transactionIds.length
      ? fetchOptional("transaction_categorizations", (query) =>
          query
            .select("*")
            .eq("business_id", businessId)
            .in("transaction_id", transactionIds)
        )
      : [],
    jobIds.length
      ? fetchOptional("job_change_orders", (query) =>
          query.select("*").eq("business_id", businessId).in("job_id", jobIds)
        )
      : [],
    fetchOptional("bid_estimates", (query) =>
      query.select("*").eq("business_id", businessId).limit(100)
    ),
    fetchOptional("bid_outcomes", (query) =>
      query.select("*").eq("business_id", businessId).limit(200)
    ),
  ]);

  return { jobs, assignments, transactions, categorizations, changeOrders, bids, outcomes };
}

function summarizeChangeOrders(changeOrders = []) {
  const approvedStatuses = new Set(["client_approved", "billed", "paid"]);
  return changeOrders.reduce((acc, row) => {
    const status = normalizeNeedle(row.status);
    if (!approvedStatuses.has(status)) return acc;
    acc.revenue += asNumber(row.approved_price ?? row.proposed_price);
    acc.cost += asNumber(row.estimated_cost);
    return acc;
  }, { revenue: 0, cost: 0 });
}

function buildJobFinancialRecords({ jobs, assignments, transactions, categorizations, changeOrders }) {
  const transactionMap = new Map(transactions.map((row) => [String(row.id), row]));
  const categorizationMap = new Map(categorizations.map((row) => [String(row.transaction_id), row]));
  const changeOrdersByJob = changeOrders.reduce((acc, row) => {
    const key = String(row.job_id);
    if (!acc.has(key)) acc.set(key, []);
    acc.get(key).push(row);
    return acc;
  }, new Map());

  const assignmentTotals = assignments.reduce((acc, assignment) => {
    const transaction = transactionMap.get(String(assignment.transaction_id));
    const categorization = categorizationMap.get(String(assignment.transaction_id)) || assignment;
    if (!transaction || transaction.is_archived || !isPostedCategorization(categorization)) return acc;

    const jobId = String(assignment.job_id);
    if (!acc.has(jobId)) {
      acc.set(jobId, {
        revenue: 0,
        totalCost: 0,
        categories: { labor: 0, materials: 0, subcontractors: 0, permits: 0, other: 0 },
        assignedCount: 0,
        revenueAssignmentCount: 0,
        costAssignmentCount: 0,
      });
    }
    const totals = acc.get(jobId);
    const amount = getTransactionAmount(assignment, transaction);
    const rowContext = {
      accountName: categorization.final_qbo_account_name || assignment.final_qbo_account_name || "",
      vendor: transaction.merchant_name || transaction.counterparty_name || transaction.vendor || transaction.payee || "",
      memo: transaction.memo || transaction.description || transaction.name || "",
      transactionName: transaction.name || "",
    };

    if (isRevenueTransaction(transaction, categorization)) {
      totals.revenue += amount;
      totals.assignedCount += 1;
      totals.revenueAssignmentCount += 1;
    } else if (isCostTransaction(transaction, categorization)) {
      const category = classifyCostCategory(rowContext);
      totals.totalCost += amount;
      totals.categories[category] += amount;
      totals.assignedCount += 1;
      totals.costAssignmentCount += 1;
    }
    return acc;
  }, new Map());

  return jobs.map((job) => {
    const jobId = String(job.id);
    const assignmentSummary = assignmentTotals.get(jobId) || null;
    const changeOrderSummary = summarizeChangeOrders(changeOrdersByJob.get(jobId) || []);
    const jobRevenue = asNumber(job.revenue ?? job.total_revenue ?? job.amount_contracted ?? job.amount_invoiced ?? job.amount_estimated);
    const jobCost = asNumber(job.total_cost ?? job.cost ?? job.actual_cost ?? job.amount_cost);
    const categories = assignmentSummary?.categories || { labor: 0, materials: 0, subcontractors: 0, permits: 0, other: 0 };
    const baseRevenue = assignmentSummary?.revenueAssignmentCount ? assignmentSummary.revenue : jobRevenue;
    const baseCost = assignmentSummary?.costAssignmentCount ? assignmentSummary.totalCost : jobCost;
    const totalCost = baseCost + changeOrderSummary.cost;
    const revenue = baseRevenue + changeOrderSummary.revenue;
    const marginPercent = revenue > 0 ? ((revenue - totalCost) / revenue) * 100 : null;

    return {
      source: "job",
      id: job.id,
      title: getJobName(job),
      jobType: getJobType(job),
      tradeType: getTradeType(job),
      scopeText: getScopeText(job),
      status: normalizeText(job.status || job.stage || "active"),
      completed: isCompletedStatus(job.status || job.stage),
      active: isActiveStatus(job.status || job.stage),
      squareFootage: getSquareFootage(job),
      revenue,
      totalCost,
      categories,
      marginPercent,
      assignedTransactionCount: assignmentSummary?.assignedCount || 0,
      changeOrderRevenue: changeOrderSummary.revenue,
      changeOrderCost: changeOrderSummary.cost,
    };
  }).filter((record) => record.totalCost > 0 || record.revenue > 0);
}

function buildBidFinancialRecords({ bids, outcomes }) {
  const outcomesByBid = outcomes.reduce((acc, row) => {
    const key = String(row.bid_estimate_id);
    if (!acc.has(key)) acc.set(key, []);
    acc.get(key).push(row);
    return acc;
  }, new Map());

  return bids.map((bid) => {
    const bidOutcomes = outcomesByBid.get(String(bid.id)) || [];
    const wonOutcome = bidOutcomes.find((row) => normalizeNeedle(row.outcome) === "won");
    const revenue = asNumber(wonOutcome?.won_amount ?? bid.recommended_price);
    const totalCost = asNumber(bid.estimated_total_cost);
    const marginPercent = revenue > 0 ? ((revenue - totalCost) / revenue) * 100 : normalizeMargin(bid.projected_margin_percent);
    return {
      source: "bid_estimate",
      id: bid.id,
      title: bid.bid_title || "Historical bid",
      jobType: getJobType(bid),
      tradeType: getTradeType(bid),
      scopeText: getScopeText(bid),
      status: normalizeText(wonOutcome?.outcome || bid.status || "draft"),
      completed: ["won", "converted"].includes(normalizeNeedle(wonOutcome?.outcome || bid.status)),
      active: ["sent", "draft", "revised"].includes(normalizeNeedle(wonOutcome?.outcome || bid.status)),
      squareFootage: getSquareFootage(bid),
      revenue,
      totalCost,
      categories: {
        labor: asNumber(bid.estimated_labor_cost),
        materials: asNumber(bid.estimated_material_cost),
        subcontractors: asNumber(bid.estimated_subcontractor_cost),
        permits: asNumber(bid.estimated_permit_cost),
        other: asNumber(bid.estimated_other_cost),
      },
      marginPercent,
      outcomeCount: bidOutcomes.length,
    };
  }).filter((record) => record.totalCost > 0 || record.revenue > 0);
}

function scoreHistoricalRecord(record, input) {
  const inputTrade = normalizeNeedle(input.tradeType);
  const inputJobType = normalizeNeedle(input.jobType);
  const recordTrade = normalizeNeedle(record.tradeType);
  const recordJobType = normalizeNeedle(record.jobType);
  const inputTokens = tokenize(input.bidTitle, input.jobType, input.tradeType, input.scopeDescription);
  const recordTokens = tokenize(record.title, record.jobType, record.tradeType, record.scopeText);

  let score = tokenOverlapScore(inputTokens, recordTokens);
  if (inputTrade && recordTrade && inputTrade === recordTrade) score += 45;
  if (inputTrade && recordTrade && (inputTrade.includes(recordTrade) || recordTrade.includes(inputTrade))) score += 20;
  if (inputJobType && recordJobType && inputJobType === recordJobType) score += 25;
  if (inputJobType && recordJobType && (inputJobType.includes(recordJobType) || recordJobType.includes(inputJobType))) score += 10;
  if (record.completed) score += 15;
  if (!record.completed && record.active) score += 5;
  if (record.source === "bid_estimate") score -= 5;

  return roundPercent(score);
}

function selectSimilarRecords(records, input) {
  const scored = records
    .map((record) => ({ ...record, similarityScore: scoreHistoricalRecord(record, input) }))
    .filter((record) => record.similarityScore > 0)
    .sort((a, b) => b.similarityScore - a.similarityScore);

  const completed = scored.filter((record) => record.completed);
  if (completed.length >= MIN_COMPLETED_HISTORY_COUNT) return completed.slice(0, MAX_SIMILAR_RECORDS);
  return scored.slice(0, MAX_SIMILAR_RECORDS);
}

function average(rows, getter) {
  const values = rows.map(getter).map(Number).filter((value) => Number.isFinite(value) && value > 0);
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function calculateHistoricalAverages(records) {
  const categoryAverage = (category) => average(records, (row) => row.categories?.[category]);
  const avgRevenue = average(records, (row) => row.revenue);
  const avgTotalCost = average(records, (row) => row.totalCost);
  const avgMarginPercent = average(records, (row) => row.marginPercent);
  const costPerSqft = average(records, (row) => {
    if (!row.squareFootage || row.squareFootage <= 0 || !row.totalCost) return null;
    return row.totalCost / row.squareFootage;
  });

  return {
    average_revenue: roundCurrency(avgRevenue),
    average_total_cost: roundCurrency(avgTotalCost),
    average_labor_cost: roundCurrency(categoryAverage("labor")),
    average_material_cost: roundCurrency(categoryAverage("materials")),
    average_subcontractor_cost: roundCurrency(categoryAverage("subcontractors")),
    average_permit_cost: roundCurrency(categoryAverage("permits")),
    average_other_cost: roundCurrency(categoryAverage("other")),
    average_margin_percent: avgMarginPercent === null ? null : roundPercent(avgMarginPercent),
    cost_per_square_foot: costPerSqft === null ? null : roundCurrency(costPerSqft),
  };
}

function resolveFallbackCost({ tradeType, jobType, squareFootage }) {
  const text = `${tradeType || ""} ${jobType || ""}`;
  const profile = FALLBACK_COST_PROFILES.find((item) => item.pattern.test(text)) || {
    costPerSqft: 25,
    baseCost: 5000,
  };
  const sqft = asNumber(squareFootage);
  const estimatedTotalCost = sqft > 0 ? profile.costPerSqft * sqft : profile.baseCost;
  return {
    estimatedTotalCost,
    basis: {
      source: "fallback_profile",
      cost_per_square_foot: sqft > 0 ? profile.costPerSqft : null,
      base_cost: profile.baseCost,
    },
  };
}

function splitCategoryCosts(estimatedTotalCost, averages) {
  const categories = {
    labor: asNumber(averages.average_labor_cost),
    materials: asNumber(averages.average_material_cost),
    subcontractors: asNumber(averages.average_subcontractor_cost),
    permits: asNumber(averages.average_permit_cost),
    other: asNumber(averages.average_other_cost),
  };
  const knownTotal = Object.values(categories).reduce((sum, value) => sum + value, 0);

  if (knownTotal > 0) {
    const scale = estimatedTotalCost / knownTotal;
    return {
      labor: roundCurrency(categories.labor * scale),
      materials: roundCurrency(categories.materials * scale),
      subcontractors: roundCurrency(categories.subcontractors * scale),
      permits: roundCurrency(categories.permits * scale),
      other: roundCurrency(categories.other * scale),
    };
  }

  return {
    labor: roundCurrency(estimatedTotalCost * 0.35),
    materials: roundCurrency(estimatedTotalCost * 0.35),
    subcontractors: roundCurrency(estimatedTotalCost * 0.15),
    permits: roundCurrency(estimatedTotalCost * 0.05),
    other: roundCurrency(estimatedTotalCost * 0.10),
  };
}

function normalizeCategoryRemainder(categories, targetTotal) {
  const roundedTotal = Object.values(categories).reduce((sum, value) => sum + asNumber(value), 0);
  const difference = roundCurrency(targetTotal - roundedTotal);
  return {
    ...categories,
    other: roundCurrency(asNumber(categories.other) + difference),
  };
}

function resolveTargetMargin({ desiredMarginPercent, minimumMarginPercent, averageMarginPercent }) {
  const desired = normalizeMargin(desiredMarginPercent);
  if (desired !== null) return { targetMarginPercent: desired, basis: "desired_margin" };

  const minimum = normalizeMargin(minimumMarginPercent);
  if (minimum !== null) return { targetMarginPercent: minimum, basis: "minimum_margin" };

  const historical = normalizeMargin(asNumber(averageMarginPercent) + 5);
  if (historical !== null) return { targetMarginPercent: historical, basis: "historical_average_plus_5" };

  return { targetMarginPercent: FALLBACK_TARGET_MARGIN_PERCENT, basis: "fallback" };
}

function calculatePrice(estimatedTotalCost, targetMarginPercent) {
  if (!estimatedTotalCost || estimatedTotalCost <= 0) {
    return { recommendedPrice: 0, grossMargin: 0, marginPercent: 0 };
  }
  const targetMarginDecimal = targetMarginPercent / 100;
  const recommendedPrice = roundCurrency(estimatedTotalCost / (1 - targetMarginDecimal));
  const grossMargin = roundCurrency(recommendedPrice - estimatedTotalCost);
  return {
    recommendedPrice,
    grossMargin,
    marginPercent: roundPercent(recommendedPrice > 0 ? (grossMargin / recommendedPrice) * 100 : 0),
  };
}

function buildPaymentSchedule(recommendedPrice) {
  return [
    { label: "Deposit", percent: 30, amount: roundCurrency(recommendedPrice * 0.3) },
    { label: "Progress payment", percent: 40, amount: roundCurrency(recommendedPrice * 0.4) },
    { label: "Final payment", percent: 30, amount: roundCurrency(recommendedPrice * 0.3) },
  ];
}

function buildRiskFlags({ similarRecords, averages, desiredMarginPercent, minimumMarginPercent, estimatedTotalCost, categories, marginPercent, squareFootage }) {
  const flags = [];
  const desired = normalizeMargin(desiredMarginPercent);
  const minimum = normalizeMargin(minimumMarginPercent);
  const materialShare = estimatedTotalCost > 0 ? categories.materials / estimatedTotalCost : 0;

  if (similarRecords.length < MIN_COMPLETED_HISTORY_COUNT) {
    flags.push({
      message: `Only ${similarRecords.length} similar job${similarRecords.length === 1 ? "" : "s"} found`,
      severity: similarRecords.length === 0 ? "high" : "medium",
      code: "limited_historical_data",
    });
  }
  if (desired !== null && averages.average_margin_percent !== null && averages.average_margin_percent < desired) {
    flags.push({
      message: `Similar jobs averaged ${roundPercent(averages.average_margin_percent)}% margin, below your ${roundPercent(desired)}% target`,
      severity: averages.average_margin_percent + 5 < desired ? "high" : "medium",
      code: "historical_margin_below_target",
    });
  }
  if (materialShare >= 0.45) {
    flags.push({
      message: "Material-heavy job type",
      severity: materialShare >= 0.6 ? "high" : "medium",
      code: "material_heavy",
    });
  }
  if (averages.average_total_cost && estimatedTotalCost > averages.average_total_cost * 1.1) {
    flags.push({
      message: "Estimated cost is above historical average",
      severity: estimatedTotalCost > averages.average_total_cost * 1.25 ? "high" : "medium",
      code: "cost_above_average",
    });
  }
  if (!asNumber(squareFootage)) {
    flags.push({
      message: "No square footage provided",
      severity: "low",
      code: "missing_square_footage",
    });
  }
  if (minimum !== null && marginPercent < minimum) {
    flags.push({
      message: "Margin below minimum target",
      severity: "high",
      code: "margin_below_minimum",
    });
  }

  return flags;
}

function buildLineItems(categories, recommendedPrice) {
  const totalCost = Object.values(categories).reduce((sum, value) => sum + asNumber(value), 0);
  const multiplier = totalCost > 0 ? recommendedPrice / totalCost : 0;
  const labels = {
    labor: "Estimated labor",
    materials: "Estimated materials",
    subcontractors: "Estimated subcontractors",
    permits: "Estimated permits and fees",
    other: "Estimated other costs",
  };

  return Object.entries(categories).map(([category, total]) => ({
    category,
    name: labels[category] || `Estimated ${category}`,
    description: null,
    quantity: 1,
    unit: "allowance",
    unit_cost: roundCurrency(total),
    total_cost: roundCurrency(total),
    markup_percent: multiplier > 0 ? roundPercent((multiplier - 1) * 100) : null,
    selling_price: multiplier > 0 ? roundCurrency(total * multiplier) : null,
    source: "generated",
  }));
}

function formatMoney(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(roundCurrency(value));
}

function buildProposalText({ bidTitle, scopeDescription, recommendedPrice, targetMarginPercent }) {
  const title = normalizeText(bidTitle) || "this project";
  const scope = normalizeText(scopeDescription);
  return `Based on the described scope, Bizzi recommends a project price of ${formatMoney(recommendedPrice)} for ${title}. This recommendation uses historical job costing data and targets a ${roundPercent(targetMarginPercent)}% gross margin. Scope summary: ${scope}`;
}

function logPricingTelemetry({ businessId, input, historicalBasis, categoryCosts, pricing, riskFlags }) {
  const payload = {
    event: "bid_pricing_recommendation",
    business_id: businessId,
    bid_title: input.bidTitle || null,
    job_type: input.jobType || null,
    trade_type: input.tradeType || null,
    square_footage_present: Boolean(input.squareFootage),
    source_count: historicalBasis.source_count,
    similar_record_count: historicalBasis.similar_record_count,
    completed_similar_record_count: historicalBasis.completed_similar_record_count,
    cost_basis: historicalBasis.cost_basis,
    margin_basis: historicalBasis.margin_basis,
    target_margin_percent: historicalBasis.target_margin_percent,
    average_margin_percent: historicalBasis.average_margin_percent,
    estimated_total_cost: Object.values(categoryCosts).reduce((sum, value) => sum + asNumber(value), 0),
    recommended_price: pricing.recommendedPrice,
    projected_margin_percent: pricing.marginPercent,
    similar_records: historicalBasis.similar_records.map((record) => ({
      source: record.source,
      id: record.id,
      title: record.title,
      similarity_score: record.similarity_score,
      margin_percent: record.margin_percent,
    })),
    risk_flags: riskFlags.map((flag) => ({ code: flag.code, severity: flag.severity })),
  };
  console.info("[bid-pricing]", JSON.stringify(payload));
}

export async function generateBidEstimate({
  businessId,
  bidTitle,
  customerName,
  jobType,
  tradeType,
  scopeDescription,
  squareFootage,
  desiredMarginPercent,
  minimumMarginPercent,
} = {}) {
  if (!businessId) {
    const error = new Error("businessId is required");
    error.status = 400;
    error.code = "business_id_required";
    throw error;
  }

  const input = {
    bidTitle: normalizeText(bidTitle),
    customerName: normalizeText(customerName),
    jobType: normalizeText(jobType),
    tradeType: normalizeText(tradeType),
    scopeDescription: normalizeText(scopeDescription),
    squareFootage: asNumber(squareFootage) > 0 ? asNumber(squareFootage) : null,
    desiredMarginPercent: normalizeMargin(desiredMarginPercent),
    minimumMarginPercent: normalizeMargin(minimumMarginPercent),
  };

  const historicalData = await fetchHistoricalData(businessId);
  const records = [
    ...buildJobFinancialRecords(historicalData),
    ...buildBidFinancialRecords(historicalData),
  ];
  const similarRecords = selectSimilarRecords(records, input);
  const averages = calculateHistoricalAverages(similarRecords);

  let estimatedTotalCost;
  let costBasis = "fallback_profile";
  let fallbackBasis = null;

  if (input.squareFootage && averages.cost_per_square_foot) {
    estimatedTotalCost = averages.cost_per_square_foot * input.squareFootage;
    costBasis = "historical_cost_per_square_foot";
  } else if (averages.average_total_cost) {
    estimatedTotalCost = averages.average_total_cost;
    costBasis = "historical_average_total_cost";
  } else {
    const fallback = resolveFallbackCost(input);
    estimatedTotalCost = fallback.estimatedTotalCost;
    fallbackBasis = fallback.basis;
  }

  estimatedTotalCost = roundCurrency(estimatedTotalCost);
  const categoryCosts = normalizeCategoryRemainder(splitCategoryCosts(estimatedTotalCost, averages), estimatedTotalCost);
  const { targetMarginPercent, basis: marginBasis } = resolveTargetMargin({
    desiredMarginPercent,
    minimumMarginPercent,
    averageMarginPercent: averages.average_margin_percent,
  });
  const pricing = calculatePrice(estimatedTotalCost, targetMarginPercent);
  const paymentSchedule = buildPaymentSchedule(pricing.recommendedPrice);
  const riskFlags = buildRiskFlags({
    similarRecords,
    averages,
    desiredMarginPercent,
    minimumMarginPercent,
    estimatedTotalCost,
    categories: categoryCosts,
    marginPercent: pricing.marginPercent,
    squareFootage: input.squareFootage,
  });

  const historicalBasis = {
    source_count: records.length,
    similar_record_count: similarRecords.length,
    completed_similar_record_count: similarRecords.filter((record) => record.completed).length,
    cost_basis: costBasis,
    margin_basis: marginBasis,
    fallback_basis: fallbackBasis,
    target_margin_percent: roundPercent(targetMarginPercent),
    average_revenue: averages.average_revenue,
    average_total_cost: averages.average_total_cost,
    average_margin_percent: averages.average_margin_percent,
    average_cost_per_square_foot: averages.cost_per_square_foot,
    averages,
    category_keyword_version: 2,
    similar_records: similarRecords.map((record) => ({
      source: record.source,
      id: record.id,
      title: record.title,
      status: record.status,
      trade_type: record.tradeType || null,
      job_type: record.jobType || null,
      similarity_score: record.similarityScore,
      revenue: roundCurrency(record.revenue),
      total_cost: roundCurrency(record.totalCost),
      margin_percent: record.marginPercent === null ? null : roundPercent(record.marginPercent),
    })),
  };

  logPricingTelemetry({
    businessId,
    input,
    historicalBasis,
    categoryCosts,
    pricing,
    riskFlags,
  });

  const estimate = {
    business_id: businessId,
    customer_name: input.customerName || null,
    prospect_name: null,
    bid_title: input.bidTitle || "Untitled bid",
    job_type: input.jobType || null,
    trade_type: input.tradeType || null,
    scope_description: input.scopeDescription,
    square_footage: input.squareFootage,
    desired_margin_percent: input.desiredMarginPercent,
    minimum_margin_percent: input.minimumMarginPercent,
    status: "draft",
    estimated_labor_cost: categoryCosts.labor,
    estimated_material_cost: categoryCosts.materials,
    estimated_subcontractor_cost: categoryCosts.subcontractors,
    estimated_permit_cost: categoryCosts.permits,
    estimated_other_cost: categoryCosts.other,
    estimated_total_cost: estimatedTotalCost,
    recommended_price: pricing.recommendedPrice,
    projected_gross_margin: pricing.grossMargin,
    projected_margin_percent: pricing.marginPercent,
    deposit_amount: paymentSchedule[0]?.amount || 0,
    payment_schedule: paymentSchedule,
    risk_flags: riskFlags,
    historical_basis: historicalBasis,
    proposal_text: buildProposalText({
      bidTitle: input.bidTitle,
      scopeDescription: input.scopeDescription,
      recommendedPrice: pricing.recommendedPrice,
      targetMarginPercent,
    }),
    internal_notes: null,
    converted_job_id: null,
    converted_at: null,
  };

  const lineItems = buildLineItems(categoryCosts, pricing.recommendedPrice);

  return {
    estimate,
    line_items: lineItems,
    historical_basis: historicalBasis,
    risk_flags: riskFlags,
    payment_schedule: paymentSchedule,
    proposal_text: estimate.proposal_text,
  };
}

export default generateBidEstimate;
