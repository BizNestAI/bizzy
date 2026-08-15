import { supabase } from "../supabaseAdmin.js";
import { recommendChangeOrderPrice } from "./changeOrderPricingService.js";
import { applyActiveBookkeepingScope, getBookkeepingStartDate } from "../bookkeeping/bookkeepingScope.js";
import {
  isCostTransaction as classifyCostTransaction,
  isRevenueTransaction as classifyRevenueTransaction,
} from "./accountClassification.js";

const MIN_CONFIDENCE = 60;
const MATERIAL_SPIKE_THRESHOLD = 1.25;
const FALLBACK_TARGET_MARGIN = 35;
const RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function roundCurrency(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function roundScore(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function normalizeText(value) {
  return String(value || "").trim();
}

function isMissingSchemaError(error) {
  return error?.code === "42P01" || error?.code === "42703" || /does not exist|schema cache|column/i.test(error?.message || "");
}

function getJobName(job = {}) {
  return job.name || job.job_name || job.project_name || job.customer_name || job.display_name || job.id || "this job";
}

function getTradeType(job = {}) {
  return normalizeText(job.trade_type || job.trade || job.service_type || job.category || "general");
}

function getCompletionDate(job = {}) {
  const value = job.completed_at || job.completion_date || job.end_date || job.ended_at || job.due_date || job.scheduled_end;
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}

function isCompletedJob(job = {}) {
  const status = String(job.status || job.stage || "").toLowerCase();
  return /complete|completed|closed|won/.test(status);
}

function isRevenueTransaction(transaction = {}, categorization = {}) {
  return classifyRevenueTransaction(transaction, categorization);
}

function isCostTransaction(transaction = {}, categorization = {}) {
  return classifyCostTransaction(transaction, categorization);
}

function isMaterialCost(row = {}) {
  const text = [
    row.vendor,
    row.memo,
    row.account_name,
    row.name,
  ].join(" ").toLowerCase();
  return /material|materials|supply|supplies|tool|tools|lumber|tile|hardware|paint|home depot|lowe'?s|amazon business|ferguson|sherwin|floor|plumb|electric/.test(text);
}

function getVendor(transaction = {}) {
  return normalizeText(transaction.merchant_name || transaction.counterparty_name || transaction.vendor || transaction.payee || transaction.name || "Unknown vendor");
}

function getMemo(transaction = {}) {
  return normalizeText(transaction.memo || transaction.description || transaction.name || transaction.original_description);
}

function asDate(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}

function getTargetMargin(job = {}) {
  const margin = Number(job.target_margin ?? job.target_margin_percent ?? job.margin_target_percent);
  return Number.isFinite(margin) && margin > 0 && margin < 95 ? margin : FALLBACK_TARGET_MARGIN;
}

function buildKey(row) {
  return `${row.job_id}:${row.trigger_type}:${row.title}`;
}

async function fetchJobs(businessId) {
  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("business_id", businessId)
    .limit(300);
  if (error) {
    if (isMissingSchemaError(error)) return [];
    throw error;
  }
  return data || [];
}

async function fetchAssignments(businessId) {
  const { data, error } = await supabase
    .from("job_transaction_assignments")
    .select("*")
    .eq("business_id", businessId);
  if (error) {
    if (isMissingSchemaError(error)) return [];
    throw error;
  }
  return data || [];
}

async function fetchExistingSuggestionKeys(businessId) {
  const { data, error } = await supabase
    .from("potential_change_orders")
    .select("job_id,trigger_type,title,status")
    .eq("business_id", businessId)
    .in("status", ["pending", "dismissed", "converted"]);
  if (error) {
    if (isMissingSchemaError(error)) return new Set();
    throw error;
  }
  return new Set((data || []).map(buildKey));
}

async function fetchTransactionContext(businessId, transactionIds) {
  const ids = Array.from(new Set((transactionIds || []).filter(Boolean).map(String)));
  if (!ids.length) return { transactionMap: new Map(), categorizationMap: new Map() };
  const bookkeepingStartDate = await getBookkeepingStartDate(supabase, businessId);

  const [{ data: transactions, error: txnErr }, { data: categorizations, error: catErr }] = await Promise.all([
    applyActiveBookkeepingScope(
      supabase
      .from("bank_transactions")
      .select("id,business_id,date,name,merchant_name,counterparty_name,amount,direction,is_archived")
      .eq("business_id", businessId)
      .eq("is_archived", false)
      .in("id", ids),
      bookkeepingStartDate
    ),
    supabase
      .from("transaction_categorizations")
      .select("*")
      .eq("business_id", businessId)
      .in("transaction_id", ids),
  ]);
  if (txnErr) throw txnErr;
  if (catErr) throw catErr;

  return {
    transactionMap: new Map((transactions || []).map((row) => [String(row.id), row])),
    categorizationMap: new Map((categorizations || []).map((row) => [String(row.transaction_id), row])),
  };
}

function buildJobFinancials(assignments, transactionMap, categorizationMap) {
  return assignments.reduce((acc, assignment) => {
    const transaction = transactionMap.get(String(assignment.transaction_id));
    if (!transaction || transaction.is_archived) return acc;
    const categorization = categorizationMap.get(String(assignment.transaction_id)) || assignment;
    const isPosted = categorization?.status === "posted" || Boolean(categorization?.qbo_txn_id);
    if (!isPosted) return acc;

    const jobId = String(assignment.job_id);
    if (!acc[jobId]) {
      acc[jobId] = {
        revenue: 0,
        cost: 0,
        materialCost: 0,
        costRows: [],
        revenueRows: [],
        vendors: new Map(),
      };
    }

    const allocationPercent = Number(assignment.allocation_percent ?? 100);
    const allocatedAmount = assignment.allocated_amount === null || assignment.allocated_amount === undefined
      ? Math.abs(Number(transaction.amount || 0)) * ((Number.isFinite(allocationPercent) ? allocationPercent : 100) / 100)
      : Math.abs(Number(assignment.allocated_amount || 0));
    const row = {
      assignment,
      transaction,
      transactionId: transaction.id,
      amount: allocatedAmount,
      date: asDate(transaction.date || assignment.created_at),
      vendor: getVendor(transaction),
      memo: getMemo(transaction),
      account_name: categorization.final_qbo_account_name || assignment.final_qbo_account_name || "",
      name: transaction.name || "",
    };

    if (isRevenueTransaction(transaction, categorization)) {
      acc[jobId].revenue += allocatedAmount;
      acc[jobId].revenueRows.push(row);
    } else if (isCostTransaction(transaction, categorization)) {
      acc[jobId].cost += allocatedAmount;
      acc[jobId].costRows.push(row);
      if (isMaterialCost(row)) acc[jobId].materialCost += allocatedAmount;
      const vendorKey = row.vendor.toLowerCase();
      if (vendorKey && vendorKey !== "unknown vendor") {
        const current = acc[jobId].vendors.get(vendorKey) || { vendor: row.vendor, amount: 0, transactionIds: [] };
        current.amount += allocatedAmount;
        current.transactionIds.push(row.transactionId);
        acc[jobId].vendors.set(vendorKey, current);
      }
    }
    return acc;
  }, {});
}

async function priceSuggestion({ businessId, jobId, estimatedCost, tradeType, targetMarginPercent }) {
  try {
    const recommendation = await recommendChangeOrderPrice({
      businessId,
      jobId,
      estimatedCost,
      targetMarginPercent,
      tradeType,
    });
    return Number(recommendation?.recommended_price || 0);
  } catch {
    return roundCurrency(Number(estimatedCost || 0) / 0.65);
  }
}

async function buildSuggestion({ businessId, job, triggerType, confidence, title, explanation, estimatedCost, transactionIds }) {
  const safeCost = roundCurrency(estimatedCost);
  const suggestedPrice = await priceSuggestion({
    businessId,
    jobId: job.id,
    estimatedCost: safeCost,
    tradeType: getTradeType(job),
    targetMarginPercent: getTargetMargin(job),
  });
  return {
    business_id: businessId,
    job_id: job.id,
    trigger_type: triggerType,
    confidence_score: roundScore(confidence),
    title,
    explanation,
    estimated_extra_cost: safeCost,
    suggested_price: roundCurrency(suggestedPrice),
    related_transaction_ids: Array.from(new Set((transactionIds || []).filter(Boolean).map(String))),
    status: "pending",
  };
}

function addIfQualified(suggestions, suggestion) {
  if (!suggestion || Number(suggestion.confidence_score || 0) < MIN_CONFIDENCE) return;
  suggestions.push(suggestion);
}

export async function detectPotentialChangeOrders({ businessId } = {}) {
  if (!businessId) return { created: [], suggestions: [] };

  const [jobs, assignments, existingKeys] = await Promise.all([
    fetchJobs(businessId),
    fetchAssignments(businessId),
    fetchExistingSuggestionKeys(businessId),
  ]);
  const transactionIds = assignments.map((row) => row.transaction_id).filter(Boolean);
  const { transactionMap, categorizationMap } = await fetchTransactionContext(businessId, transactionIds);
  const financialsByJob = buildJobFinancials(assignments, transactionMap, categorizationMap);
  const now = new Date();

  const completedJobsByTrade = new Map();
  for (const job of jobs) {
    if (!isCompletedJob(job)) continue;
    const trade = getTradeType(job);
    if (!completedJobsByTrade.has(trade)) completedJobsByTrade.set(trade, []);
    completedJobsByTrade.get(trade).push(job);
  }

  const suggestions = [];
  for (const job of jobs) {
    const jobFinancials = financialsByJob[String(job.id)] || { revenue: 0, cost: 0, materialCost: 0, costRows: [], vendors: new Map() };
    if (!jobFinancials.costRows.length) continue;

    const trade = getTradeType(job);
    const completedPeers = (completedJobsByTrade.get(trade) || []).filter((peer) => String(peer.id) !== String(job.id));
    const peerFinancials = completedPeers.map((peer) => financialsByJob[String(peer.id)]).filter(Boolean);
    const peerMaterialCosts = peerFinancials.map((row) => row.materialCost).filter((value) => Number(value) > 0);
    const materialBaseline = peerMaterialCosts.length
      ? peerMaterialCosts.reduce((sum, value) => sum + value, 0) / peerMaterialCosts.length
      : 0;

    if (materialBaseline > 0 && jobFinancials.materialCost >= materialBaseline * MATERIAL_SPIKE_THRESHOLD) {
      const extra = jobFinancials.materialCost - materialBaseline;
      const overPercent = ((jobFinancials.materialCost / materialBaseline) - 1) * 100;
      addIfQualified(suggestions, await buildSuggestion({
        businessId,
        job,
        triggerType: "material_cost_spike",
        confidence: Math.min(95, 65 + Math.max(0, overPercent - 25) * 0.6),
        title: "Potential material cost change order",
        explanation: `Assigned material, tool, or supply costs on ${getJobName(job)} are ${roundScore(overPercent)}% above similar completed ${trade} jobs.`,
        estimatedCost: extra,
        transactionIds: jobFinancials.costRows.filter(isMaterialCost).map((row) => row.transactionId),
      }));
    }

    const completionDate = getCompletionDate(job);
    const endDatePassed = completionDate && completionDate.getTime() < now.getTime();
    if ((isCompletedJob(job) || endDatePassed) && completionDate) {
      const lateCosts = jobFinancials.costRows.filter((row) => row.date && row.date.getTime() > completionDate.getTime());
      const lateCostTotal = lateCosts.reduce((sum, row) => sum + Number(row.amount || 0), 0);
      if (lateCostTotal > 0) {
        addIfQualified(suggestions, await buildSuggestion({
          businessId,
          job,
          triggerType: "cost_after_completion",
          confidence: Math.min(95, 75 + Math.min(20, lateCosts.length * 3)),
          title: "Costs added after job completion",
          explanation: `${lateCosts.length} assigned cost transaction${lateCosts.length === 1 ? "" : "s"} landed after the completion/end date for ${getJobName(job)}.`,
          estimatedCost: lateCostTotal,
          transactionIds: lateCosts.map((row) => row.transactionId),
        }));
      }
    }

    const targetMargin = getTargetMargin(job);
    const margin = jobFinancials.revenue > 0 ? ((jobFinancials.revenue - jobFinancials.cost) / jobFinancials.revenue) * 100 : null;
    const recentCutoff = Date.now() - RECENT_WINDOW_MS;
    const recentCosts = jobFinancials.costRows.filter((row) => row.date && row.date.getTime() >= recentCutoff);
    const recentCostTotal = recentCosts.reduce((sum, row) => sum + Number(row.amount || 0), 0);
    if (Number.isFinite(margin) && margin < targetMargin - 5 && recentCostTotal > 0) {
      const gap = targetMargin - margin;
      addIfQualified(suggestions, await buildSuggestion({
        businessId,
        job,
        triggerType: "margin_below_target",
        confidence: Math.min(92, 60 + gap * 1.8),
        title: "Margin below target after recent costs",
        explanation: `${getJobName(job)} is ${roundScore(gap)} percentage points below its ${roundScore(targetMargin)}% target margin after recent assigned costs.`,
        estimatedCost: recentCostTotal,
        transactionIds: recentCosts.map((row) => row.transactionId),
      }));
    }

    if (completedPeers.length && jobFinancials.vendors.size) {
      const peerVendors = new Set();
      for (const peer of completedPeers) {
        const peerRows = financialsByJob[String(peer.id)];
        if (!peerRows?.vendors) continue;
        for (const vendor of peerRows.vendors.keys()) peerVendors.add(vendor);
      }
      const unusualVendors = Array.from(jobFinancials.vendors.values()).filter((vendor) => !peerVendors.has(vendor.vendor.toLowerCase()));
      if (unusualVendors.length) {
        const vendorTotal = unusualVendors.reduce((sum, vendor) => sum + Number(vendor.amount || 0), 0);
        const primaryVendor = unusualVendors.sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0))[0];
        addIfQualified(suggestions, await buildSuggestion({
          businessId,
          job,
          triggerType: "unusual_vendor",
          confidence: Math.min(72, 60 + unusualVendors.length * 3),
          title: "Unusual vendor may indicate extra scope",
          explanation: `${primaryVendor.vendor} appears on ${getJobName(job)} but not on similar completed ${trade} jobs.`,
          estimatedCost: vendorTotal,
          transactionIds: unusualVendors.flatMap((vendor) => vendor.transactionIds || []),
        }));
      }
    }
  }

  const newSuggestions = suggestions.filter((suggestion) => !existingKeys.has(buildKey(suggestion)));
  if (!newSuggestions.length) return { created: [], suggestions };

  const { data, error } = await supabase
    .from("potential_change_orders")
    .upsert(newSuggestions, {
      onConflict: "business_id,job_id,trigger_type,title",
      ignoreDuplicates: true,
    })
    .select("*");
  if (error) {
    if (isMissingSchemaError(error)) return { created: [], suggestions };
    throw error;
  }

  return { created: data || [], suggestions };
}

export default detectPotentialChangeOrders;
