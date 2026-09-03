/* global process */
import express from "express";
import { supabase } from "../../services/supabaseAdmin.js"; // your existing helper
import { requireAuth } from "../gpt/middlewares/requireAuth.js";
import { createRateLimiter } from "../_shared/rateLimit.js";
import { fetchBookkeepingTransactions, normalizePostedBookTransaction } from "../bookkeeping/routes/bookkeeping.transactions.routes.js";
import { applyActiveBookkeepingScope, getBookkeepingStartDate, isTransactionInActiveBookkeepingScope } from "../../services/bookkeeping/bookkeepingScope.js";
import { generateJobAssignmentSuggestionsForBusiness } from "../../services/jobCosting/jobAssignmentSuggestionEngine.js";
import { triggerContractorCfoInsightsBestEffort } from "../../services/insights/contractorCfoTriggerService.js";
import {
  isCostTransaction as classifyCostTransaction,
  isRevenueTransaction as classifyRevenueTransaction,
} from "../../services/jobCosting/accountClassification.js";
import {
  buildAssignmentImpactPreview,
  createRevenueEvidenceForAssignment,
  fetchCanonicalJobRevenueSummaries,
  fetchJobFinancialDetail,
} from "../../services/jobCosting/jobRevenueService.js";
import {
  getQboJobCostingSyncDiagnostics,
  runQboJobCostingSync,
} from "../../services/jobCosting/qboJobCostingSyncService.js";
import {
  getQboOngoingSyncDiagnostics,
  processQueuedQboWebhookEvents,
  runDailyQboJobCostingReconciliation,
  runQboCdcForBusiness,
  runQboJobCostingBackfill,
} from "../../services/jobCosting/qboOngoingSyncService.js";
import {
  approveJobCandidateCreateNew,
  createManualJob,
  deleteManualJob,
  dismissJobCandidate,
  generateJobCandidatesForBusiness,
  linkJobCandidateToExisting,
  mergeJobCandidates,
  revertCandidateCreatedJob,
} from "../../services/jobCosting/jobIdentityResolver.js";

const highCostJobRouteRateLimit = createRateLimiter({
  windowMs: 60_000,
  max: Number(process.env.JOB_COSTING_HIGH_COST_RATE_LIMIT_PER_MINUTE || 10),
  code: "job_costing_rate_limited",
  message: "Too many job costing requests. Try again shortly.",
});
import {
  checkQboProjectsCapability,
  createQuickBooksProjectForJob,
  runQboProjectsSync,
} from "../../services/jobCosting/qboProjectsService.js";
const router = express.Router();

const requireRouteAuth = (req, res, next) => {
  if (req.tenantContext?.mode === "admin_view" || req.tenantContext?.mode === "customer") {
    return next();
  }
  return requireAuth(req, res, next);
};

/* ---------- Helpers ---------- */
const asNum = (n) => (typeof n === "number" ? n : Number(n || 0));
const DEFAULT_MARGIN_TARGET = 35;
const startOfMonthIso = () => new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
const normalizePrompt = (value = "") => String(value || "").trim();
const normalizeNeedle = (value = "") => String(value || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
const getJobName = (job = {}) => job.name || job.job_name || job.project_name || job.customer_name || job.display_name || job.id || "Untitled Job";
const knownVendorKeywords = ["home depot", "amazon", "uber", "lowe", "lowe's", "lowes", "tile house", "cedar supply"];

function isCompletedJobStatus(status = "") {
  return /complete|completed|closed|won|lost|cancel/i.test(String(status || ""));
}

function normalizeJob(row = {}) {
  const revenue = asNum(row.revenue ?? row.total_revenue ?? row.amount_contracted ?? row.amount_invoiced ?? row.amount_estimated);
  const totalCost = asNum(row.total_cost ?? row.cost ?? row.actual_cost ?? row.amount_cost);
  const marginPercent = Number.isFinite(Number(row.margin_percent ?? row.margin_pct))
    ? Number(row.margin_percent ?? row.margin_pct)
    : revenue > 0
      ? ((revenue - totalCost) / revenue) * 100
      : null;
  return {
    id: row.id || row.job_id || row.external_id || null,
    jobName: getJobName(row),
    customerName: row.customer_name || row.client_name || row.customer || row.parent_customer_name || row.client || "Unknown customer",
    tradeType: row.trade_type || row.trade || row.service_type || row.category || "Unassigned",
    revenue,
    totalCost,
    marginPercent,
    status: row.status || row.stage || "active",
  };
}

function withNormalizedJob(row = {}) {
  const normalized = normalizeJob(row);
  return {
    ...row,
    jobName: normalized.jobName,
    job_name: row.job_name || normalized.jobName,
    customerName: normalized.customerName,
    customer_name: row.customer_name || normalized.customerName,
    tradeType: normalized.tradeType,
    trade_type: row.trade_type || normalized.tradeType,
    revenue: normalized.revenue,
    total_cost: normalized.totalCost,
    margin_percent: normalized.marginPercent,
    status: normalized.status,
  };
}

function getBusinessId(req) {
  return req.business?.id || req.auth?.businessId || req.get("x-business-id") || req.query.business_id || req.body?.business_id || req.body?.businessId || null;
}

function ensureBusinessId(req, res) {
  const businessId = getBusinessId(req);
  if (!businessId) {
    res.status(400).json({ ok: false, error: "business_id required", message: "business_id required" });
    return null;
  }
  return businessId;
}

function getAuthenticatedUserId(req) {
  return req.auth?.userId || req.user?.id || req.user?.sub || req.auth?.user_id || req.body?.user_id || req.body?.userId || null;
}

function parseAssignmentPrompt(prompt) {
  const raw = normalizePrompt(prompt);
  const lower = raw.toLowerCase();
  const jobMatch = lower.match(/\b(?:to|for|on)\s+(?:the\s+)?(.+?)\s+(?:job|project)\b/);
  const jobName = jobMatch?.[1]?.trim() || null;

  const vendorMatch =
    lower.match(/\bassign\s+(?:all\s+)?(.+?)\s+(?:expenses?|transactions?|charges?|spend)\b/) ||
    lower.match(/\bassign\s+(?:the\s+)?(.+?)\s+from\b/);
  const vendorText = vendorMatch?.[1]?.replace(/\b(all|the)\b/g, " ").trim() || null;

  let startDate = null;
  let endDate = null;
  if (/\bthis month\b/.test(lower)) {
    startDate = startOfMonthIso();
  }

  const monthDay = lower.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (monthDay) {
    const months = {
      january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
      july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
    };
    const d = new Date(new Date().getFullYear(), months[monthDay[1]], Number(monthDay[2]));
    if (!Number.isNaN(d.getTime())) {
      startDate = d.toISOString().slice(0, 10);
      endDate = startDate;
    }
  }

  return { raw, jobName, vendorText, startDate, endDate };
}

function getDateRangeFromInstruction(lower) {
  const today = new Date();
  const asIso = (d) => d.toISOString().slice(0, 10);
  if (/\bthis month\b/.test(lower)) {
    return {
      label: "this month",
      startDate: asIso(new Date(today.getFullYear(), today.getMonth(), 1)),
      endDate: null,
    };
  }
  if (/\blast 30 days\b/.test(lower)) {
    const start = new Date(today);
    start.setDate(start.getDate() - 30);
    return { label: "last 30 days", startDate: asIso(start), endDate: null };
  }
  if (/\blast week\b/.test(lower)) {
    const end = new Date(today);
    end.setDate(end.getDate() - 7);
    const start = new Date(today);
    start.setDate(start.getDate() - 14);
    return { label: "last week", startDate: asIso(start), endDate: asIso(end) };
  }
  return { label: "all time", startDate: null, endDate: null };
}

function parseSplitAllocations(instruction) {
  const lower = instruction.toLowerCase();
  if (!/\bsplit\b/.test(lower)) return [];
  const allocations = [];
  const re = /(\d+(?:\.\d+)?)\s*%\s+to\s+(.+?)(?=\s+(?:and|,)\s+\d+(?:\.\d+)?\s*%\s+to\s+|$)/gi;
  let match;
  while ((match = re.exec(instruction))) {
    allocations.push({ percent: Number(match[1]), jobText: match[2].replace(/\b(job|project)\b/gi, "").trim() });
  }
  return allocations;
}

function extractVendorText(instruction) {
  const lower = instruction.toLowerCase();
  const known = knownVendorKeywords.find((vendor) => lower.includes(vendor));
  if (known) return known;
  const vendorMatch =
    lower.match(/\bassign\s+(?:all\s+)?(.+?)\s+(?:expenses?|transactions?|charges?|purchases?|spend)\b/) ||
    lower.match(/\bshow\s+(?:unassigned\s+)?(.+?)\s+purchases?\b/);
  return vendorMatch?.[1]?.replace(/\b(all|the|unassigned)\b/g, " ").trim() || "";
}

function parseAssignmentInstruction(instruction) {
  const raw = normalizePrompt(instruction);
  const lower = raw.toLowerCase();
  const dateRange = getDateRangeFromInstruction(lower);
  const splitAllocations = parseSplitAllocations(raw);
  const showOnly = /^\s*show\b/i.test(raw);
  const vendorText = extractVendorText(raw);
  const materialOnly = /\bmaterial|materials|supplies|purchases\b/.test(lower);

  let jobTexts = [];
  if (splitAllocations.length) {
    jobTexts = splitAllocations.map((item) => item.jobText).filter(Boolean);
  } else {
    const jobMatch =
      lower.match(/\b(?:to|for|on)\s+(?:the\s+)?(.+?)\s+(?:job|project)\b/) ||
      lower.match(/\b(?:to|for|on)\s+(?:the\s+)?([a-z0-9][a-z0-9\s'.&-]+?)\s*$/i);
    if (jobMatch?.[1]) jobTexts = [jobMatch[1].replace(/\b(job|project)\b/gi, "").trim()];
  }

  return { raw, lower, dateRange, vendorText, materialOnly, showOnly, splitAllocations, jobTexts };
}

function matchJobByText(jobs, text) {
  const needle = normalizeNeedle(text);
  if (!needle) return null;
  return (jobs || []).find((job) => {
    const haystack = normalizeNeedle([getJobName(job), job.customer_name, job.client_name, job.customer, job.parent_customer_name].filter(Boolean).join(" "));
    return haystack.includes(needle) || needle.includes(haystack);
  }) || null;
}

function isExpenseTransaction(txn) {
  return (txn.direction || "").toUpperCase() === "OUTFLOW" || Number(txn.amount || 0) < 0;
}

function getTransactionMemo(txn = {}) {
  const raw = txn?.raw && typeof txn.raw === "object" ? txn.raw : {};
  const candidates = [
    txn.bank_memo,
    txn.memo,
    txn.transaction_memo,
    txn.plaid_memo,
    txn.original_description,
    txn.originalDescription,
    txn.payment_channel_memo,
    raw.bank_memo,
    raw.memo,
    raw.original_description,
    raw.originalDescription,
    raw.name,
    txn.name,
    txn.description,
  ];
  const value = candidates.find((item) => String(item || "").trim());
  return value ? String(value).trim() : "";
}

function transactionHaystack(txn) {
  return normalizeNeedle([
    txn.counterparty_name,
    txn.merchant_name,
    txn.name,
    txn.vendor,
    txn.payee,
    getTransactionMemo(txn),
    txn.bank_memo,
    txn.memo,
    txn.original_description,
    txn.description,
    txn.category_primary,
    txn.category_detailed,
    txn.final_qbo_account_name,
    txn.gl_account,
  ].filter(Boolean).join(" "));
}

function isMissingTableError(error) {
  return ["42P01", "42703", "PGRST204", "PGRST205"].includes(error?.code) || /does not exist|schema cache|column/i.test(error?.message || "");
}

function buildHistoryTransactionsFromPreview(preview = {}) {
  return (preview.transactions || []).map((txn) => ({
    id: txn.id || txn.transaction_id || null,
    transaction_id: txn.transaction_id || txn.id || null,
    date: txn.date || null,
    vendor: txn.vendor || txn.payee || "",
    payee: txn.payee || txn.vendor || "",
    memo: getTransactionMemo(txn),
    description: getTransactionMemo(txn),
    gl_account: txn.category || txn.final_qbo_account_name || txn.gl_account || "Uncategorized",
    amount: Number(txn.amount || 0),
    allocations: (txn.allocations || []).map((allocation) => ({
      job_id: allocation.job_id || null,
      job_name: allocation.job_name || "",
      allocation_percent: Number(allocation.allocation_percent || 0),
      allocated_amount: Number(allocation.allocated_amount || 0),
    })),
    already_assigned: Boolean(txn.already_assigned),
    existing_assignments: (txn.existing_assignments || []).map((row) => ({
      id: row.id || null,
      job_id: row.job_id || null,
      allocation_percent: Number(row.allocation_percent || 0),
      allocated_amount: Number(row.allocated_amount || 0),
      source: row.source || null,
    })),
  }));
}

async function fetchMarginTargets(businessId) {
  const { data, error } = await supabase
    .from("job_margin_targets")
    .select("business_id,trade_type,target_margin_percent,created_at,updated_at")
    .eq("business_id", businessId);
  if (error) {
    if (isMissingTableError(error)) return [];
    throw error;
  }
  return data || [];
}

async function fetchChangeOrders(businessId, jobIds = []) {
  if (!jobIds.length) return [];
  const { data, error } = await supabase
    .from("job_change_orders")
    .select("*")
    .eq("business_id", businessId)
    .in("job_id", jobIds)
    .order("created_at", { ascending: false });
  if (error) {
    if (isMissingTableError(error)) return [];
    throw error;
  }
  return data || [];
}

function summarizeChangeOrders(changeOrders = []) {
  const approvedStatuses = new Set(["client_approved", "billed", "paid"]);
  const openStatuses = new Set(["proposed", "client_approved", "billed"]);
  return (changeOrders || []).reduce((acc, row) => {
    const status = String(row.status || "").toLowerCase();
    const proposedPrice = asNum(row.proposed_price);
    const approvedRevenue = asNum(row.approved_price ?? row.proposed_price);
    const billedAmount = asNum(row.billed_amount);
    const paidAmount = asNum(row.paid_amount);

    acc.change_order_count += 1;
    if (openStatuses.has(status)) acc.open_change_order_count += 1;
    if (status === "proposed") {
      acc.change_order_proposed_total += proposedPrice;
      acc.proposed_change_order_value += proposedPrice;
    }
    if (approvedStatuses.has(status)) {
      acc.approved_change_order_value += approvedRevenue;
      acc.change_order_approved_revenue += approvedRevenue;
      acc.change_order_cost_total += asNum(row.estimated_cost);
    }
    if (status === "billed" || status === "paid") acc.change_order_billed_total += billedAmount;
    if (status === "paid") acc.change_order_paid_total += paidAmount;
    return acc;
  }, {
    change_order_proposed_total: 0,
    proposed_change_order_value: 0,
    change_order_approved_revenue: 0,
    approved_change_order_value: 0,
    change_order_billed_total: 0,
    change_order_paid_total: 0,
    change_order_cost_total: 0,
    change_order_count: 0,
    open_change_order_count: 0,
  });
}

function finalizeChangeOrderSummary(summary) {
  const proposed = asNum(summary.proposed_change_order_value ?? summary.change_order_proposed_total);
  const approved = asNum(summary.approved_change_order_value ?? summary.change_order_approved_revenue);
  const billed = asNum(summary.change_order_billed_total);
  const paid = asNum(summary.change_order_paid_total);
  return {
    ...summary,
    change_order_proposed_total: proposed,
    proposed_change_order_value: proposed,
    change_order_approved_revenue: approved,
    approved_change_order_value: approved,
    change_order_billed_total: billed,
    change_order_paid_total: paid,
    change_order_cost_total: asNum(summary.change_order_cost_total),
    unbilled_change_order_value: Math.max(0, approved - billed),
    unpaid_change_order_value: Math.max(0, billed - paid),
    change_order_count: Number(summary.change_order_count || 0),
    open_change_order_count: Number(summary.open_change_order_count || 0),
  };
}

async function fetchAssignmentHistory(businessId, limit = 12) {
  const { data, error } = await supabase
    .from("job_assignment_instruction_history")
    .select("*")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    if (isMissingTableError(error)) return [];
    throw error;
  }
  return data || [];
}

async function recordAssignmentHistory(businessId, preview, assigned, status = "confirmed") {
  const now = new Date().toISOString();
  const targetJobs = (preview.target_jobs || []).map((job) => ({
    id: job.id,
    job_name: job.job_name || getJobName(job),
  }));
  const payload = {
    business_id: businessId,
    instruction_text: preview.parsed?.instruction || "",
    parsed_summary: preview.parsed || {},
    target_jobs: targetJobs,
    matched_count: Number(preview.matched_count || 0),
    total_amount: Number(preview.total_amount || 0),
    assigned_count: Number(assigned || 0),
    status,
    source: "natural_language",
    transactions: buildHistoryTransactionsFromPreview(preview),
    assignment_summary: {
      mode: preview.parsed?.mode || null,
      warnings: preview.warnings || [],
      allocations: preview.allocations || [],
      confirmed_at: now,
    },
    created_at: now,
    updated_at: now,
  };
  let { data, error } = await supabase
    .from("job_assignment_instruction_history")
    .insert(payload)
    .select("*")
    .single();
  if (error) {
    if (isMissingTableError(error)) return null;
    if (/transactions|assignment_summary|column/i.test(error.message || "")) {
      const fallbackPayload = { ...payload };
      delete fallbackPayload.transactions;
      delete fallbackPayload.assignment_summary;
      const retry = await supabase
        .from("job_assignment_instruction_history")
        .insert(fallbackPayload)
        .select("*")
        .single();
      data = retry.data;
      error = retry.error;
    }
  }
  if (error) {
    if (isMissingTableError(error)) return null;
    throw error;
  }
  return data;
}

function getTargetForTrade(targets = [], tradeType = "") {
  const trade = normalizeNeedle(tradeType || "");
  const match = targets.find((target) => normalizeNeedle(target.trade_type || "") === trade);
  return Number(match?.target_margin_percent ?? DEFAULT_MARGIN_TARGET);
}

function buildMarginInsights(jobs = [], targets = []) {
  return (jobs || []).flatMap((job) => {
    const margin = Number(job.margin_percent);
    const target = getTargetForTrade(targets, job.trade_type);
    const revenue = Number(job.revenue || 0);
    const cost = Number(job.total_cost || 0);
    const insights = [];
    if (Number.isFinite(margin)) {
      if (margin < target) {
        insights.push(`${job.job_name} is trending ${Math.round((target - margin) * 10) / 10}% below target margin.`);
        insights.push("Consider price increases on similar future jobs.");
      } else {
        insights.push(`${job.job_name} is within target margin.`);
      }
    }
    if (revenue === 0 && cost > 0) insights.push(`${job.job_name} has costs but no revenue recorded.`);
    if (cost > 0 && revenue > 0 && cost / revenue > 0.7) insights.push("Material costs are unusually high for this trade.");
    return insights.map((message) => ({
      job_id: job.id,
      job_name: job.job_name,
      trade_type: job.trade_type,
      target_margin_percent: target,
      margin_percent: Number.isFinite(margin) ? margin : null,
      message,
    }));
  }).slice(0, 8);
}

async function buildAssignmentPreview(businessId, instruction) {
  const parsed = parseAssignmentInstruction(instruction);
  if (!parsed.raw) {
    const e = new Error("Instruction required.");
    e.status = 400;
    e.code = "instruction_required";
    throw e;
  }
  if (parsed.splitAllocations.length) {
    const totalSplit = parsed.splitAllocations.reduce((sum, item) => sum + Number(item.percent || 0), 0);
    if (Math.abs(totalSplit - 100) > 0.01) {
      const e = new Error("Split percentages must total 100%.");
      e.status = 400;
      e.code = "split_percent_invalid";
      throw e;
    }
  }

  const { data: jobs, error: jobsErr } = await supabase
    .from("jobs")
    .select("*")
    .eq("business_id", businessId)
    .limit(200);
  if (jobsErr) throw jobsErr;

  const assignableJobs = (jobs || []).filter((job) => !isCompletedJobStatus(job.status || job.stage));
  const targetJobs = parsed.jobTexts.map((text) => {
    const job = matchJobByText(assignableJobs, text);
    return job ? { id: job.id, job_name: getJobName(job), match_text: text } : null;
  });
  if (!parsed.showOnly && (!targetJobs.length || targetJobs.some((job) => !job))) {
    const e = new Error("No matching job found.");
    e.status = 404;
    e.code = "job_not_found";
    throw e;
  }

  // Job Costing uses posted Books transactions as the source of truth.
  const { rows: postedRows } = await fetchBookkeepingTransactions({
    businessId,
    statusFilter: "posted",
    rangeParam: "all",
    page: 1,
    pageSize: 500,
  });
  const txns = (postedRows || []).map(normalizePostedBookTransaction).filter((txn) => {
    const txnDate = txn.date ? new Date(txn.date) : null;
    if (parsed.dateRange.startDate && txnDate && txnDate < new Date(parsed.dateRange.startDate)) return false;
    if (parsed.dateRange.endDate && txnDate && txnDate > new Date(parsed.dateRange.endDate)) return false;
    return true;
  });

  const vendorNeedle = normalizeNeedle(parsed.vendorText);
  const matches = (txns || []).filter((txn) => {
    const haystack = transactionHaystack(txn);
    const matchesVendor = !vendorNeedle || haystack.includes(vendorNeedle);
    const matchesMaterial = !parsed.materialOnly || /\bmaterial|materials|supply|supplies|lumber|tile|hardware|paint\b/.test(haystack);
    return isExpenseTransaction(txn) && matchesVendor && matchesMaterial;
  });
  if (!matches.length) {
    const e = new Error("No matching transactions found.");
    e.status = 404;
    e.code = "transactions_not_found";
    throw e;
  }

  const ids = matches.map((txn) => txn.id);
  let existingAssignments = [];
  if (ids.length) {
    const { data: existing, error: existingErr } = await supabase
      .from("job_transaction_assignments")
      .select("*")
      .eq("business_id", businessId)
      .in("transaction_id", ids);
    if (existingErr) throw existingErr;
    existingAssignments = existing || [];
  }
  const existingByTxn = existingAssignments.reduce((acc, row) => {
    if (!acc[row.transaction_id]) acc[row.transaction_id] = [];
    acc[row.transaction_id].push(row);
    return acc;
  }, {});

  const baseAllocations = parsed.splitAllocations.length
    ? parsed.splitAllocations.map((item, idx) => ({
        job_id: targetJobs[idx]?.id,
        job_name: targetJobs[idx]?.job_name,
        allocation_percent: item.percent,
      }))
    : targetJobs.map((job) => ({ job_id: job.id, job_name: job.job_name, allocation_percent: 100 }));

  const previewTransactions = matches.map((txn) => {
    const existing = existingByTxn[txn.id] || [];
    const assignedTotalPercent = existing.reduce((sum, row) => sum + asNum(row.allocation_percent), 0);
    const remainingPercent = Math.max(0, 100 - assignedTotalPercent);
    const allocations = baseAllocations.map((allocation) => {
      const allocationPercent = Number(allocation.allocation_percent || 0);
      return {
        ...allocation,
        allocation_percent: allocationPercent,
        allocated_amount: Math.abs(Number(txn.amount || 0)) * (allocationPercent / 100),
        exceeds_remaining: allocationPercent > remainingPercent,
      };
    });
    const memo = getTransactionMemo(txn);
    return {
      id: txn.id,
      date: txn.date,
      vendor: txn.vendor || txn.payee || "",
      description: memo,
      memo,
      category: txn.final_qbo_account_name || txn.gl_account || "Uncategorized",
      amount: Number(txn.amount || 0),
      already_assigned: Boolean(existing.length),
      existing_assignments: existing,
      assigned_total_percent: assignedTotalPercent,
      remaining_percent: remainingPercent,
      allocations,
    };
  });
  const totalAllocatedAmount = previewTransactions.reduce(
    (sum, txn) => sum + (txn.allocations || []).reduce((inner, allocation) => inner + Number(allocation.allocated_amount || 0), 0),
    0
  );
  const overAllocated = previewTransactions.some((txn) => (txn.allocations || []).some((allocation) => allocation.exceeds_remaining));

  return {
    parsed: {
      instruction: parsed.raw,
      vendor: parsed.vendorText || "any vendor",
      date_range: parsed.dateRange.label,
      material_only: parsed.materialOnly,
      mode: parsed.showOnly ? "show" : parsed.splitAllocations.length ? "split" : "assign",
    },
    target_jobs: targetJobs.filter(Boolean),
    allocations: baseAllocations,
    matched_count: previewTransactions.length,
    total_amount: totalAllocatedAmount,
    warnings: [
      ...(previewTransactions.some((txn) => txn.already_assigned) ? ["Some matched transactions already have job allocations. New allocations must fit the remaining percent."] : []),
      ...(overAllocated ? ["One or more matched transactions do not have enough remaining allocation."] : []),
    ],
    transactions: previewTransactions,
  };
}

function getSuggestionJobId(row = {}) {
  return row.suggested_job_id || row.job_id || null;
}

function getSuggestionConfidence(row = {}) {
  return Number(row.confidence_score ?? row.confidence ?? 0);
}

function getSuggestionMethods(row = {}) {
  return Array.isArray(row.methods_used) ? row.methods_used : [];
}

function getSuggestionReasoningSummary(row = {}) {
  if (row.reasoning?.summary) return row.reasoning.summary;
  return row.reason || "Rule-based job assignment suggestion.";
}

function getSuggestionConfidenceLabel(score) {
  return score >= 80 ? "high" : "medium";
}

function formatSuggestionPayload(row = {}, transaction = {}, job = {}) {
  const score = getSuggestionConfidence(row);
  return {
    id: row.id,
    transaction_id: row.transaction_id,
    job_id: getSuggestionJobId(row),
    suggestion_id: row.id,
    transaction: {
      id: transaction.id || row.transaction_id,
      date: transaction.date || null,
      vendor: transaction.vendor || transaction.payee || "",
      payee: transaction.payee || transaction.vendor || "",
      description: transaction.description || "",
      amount: Number(transaction.amount || 0),
      gl_account: transaction.final_qbo_account_name || transaction.gl_account || "Uncategorized",
      final_qbo_account_id: transaction.final_qbo_account_id || null,
      final_qbo_account_name: transaction.final_qbo_account_name || transaction.gl_account || null,
      qbo_txn_id: transaction.qbo_txn_id || null,
      qbo_txn_type: transaction.qbo_txn_type || null,
      posted_at: transaction.posted_at || null,
    },
    suggested_job: {
      id: job.id || getSuggestionJobId(row),
      job_name: getJobName(job),
      customer_name: job.customer_name || job.client_name || job.customer || "",
      trade_type: job.trade_type || job.trade || job.service_type || "",
      status: job.status || "active",
    },
    confidence_score: score,
    confidence_label: row.confidence_label || getSuggestionConfidenceLabel(score),
    methods_used: getSuggestionMethods(row),
    reasoning_summary: getSuggestionReasoningSummary(row),
    reasoning: row.reasoning || {},
    status: row.status || "pending",
    created_at: row.created_at || null,
  };
}

async function fetchPendingJobAssignmentSuggestions(businessId, { status = "pending", minConfidence = 60, limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit || 50), 1), 200);
  const statusFilter = normalizePrompt(status || "pending");
  const query = supabase
    .from("job_assignment_suggestions")
    .select("*")
    .eq("business_id", businessId)
    .eq("status", statusFilter)
    .order("created_at", { ascending: false })
    .limit(safeLimit);
  const { data, error } = await query;
  if (error) {
    if (isMissingTableError(error)) return [];
    throw error;
  }
  const rows = (data || []).filter((row) => getSuggestionConfidence(row) >= Number(minConfidence || 60));
  if (!rows.length) return [];

  const transactionIds = Array.from(new Set(rows.map((row) => row.transaction_id).filter(Boolean)));
  const jobIds = Array.from(new Set(rows.map(getSuggestionJobId).filter(Boolean)));
  const [jobCostingRows, { data: jobs, error: jobsErr }] = await Promise.all([
    fetchJobCostingRows(businessId),
    jobIds.length
      ? supabase.from("jobs").select("*").eq("business_id", businessId).in("id", jobIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (jobsErr) throw jobsErr;
  const transactionById = (jobCostingRows.transactions || []).reduce((acc, row) => {
    acc[String(row.id)] = row;
    return acc;
  }, {});
  const jobById = (jobs || jobCostingRows.jobs || []).reduce((acc, job) => {
    acc[String(job.id)] = job;
    return acc;
  }, {});
  return rows
    .filter((row) => !transactionIds.length || transactionById[String(row.transaction_id)])
    .map((row) => formatSuggestionPayload(row, transactionById[String(row.transaction_id)] || {}, jobById[String(getSuggestionJobId(row))] || {}));
}

async function fetchSuggestionOrThrow(businessId, id) {
  const { data, error } = await supabase
    .from("job_assignment_suggestions")
    .select("*")
    .eq("business_id", businessId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.status !== "pending") {
    const e = new Error("Suggestion not found.");
    e.status = 404;
    e.code = "suggestion_not_found";
    throw e;
  }
  return data;
}

async function markSuggestionStatus({ businessId, id, status, now, acceptedAssignmentId = null, feedback = null }) {
  const updatePayload = {
    status,
    updated_at: now,
  };
  if (status === "approved" || status === "accepted") {
    updatePayload.accepted_at = now;
    updatePayload.accepted_assignment_id = acceptedAssignmentId;
  }
  if (status === "rejected" || status === "ignored") {
    updatePayload.rejected_at = now;
    updatePayload.user_feedback = feedback || null;
  }
  const { error } = await supabase
    .from("job_assignment_suggestions")
    .update(updatePayload)
    .eq("business_id", businessId)
    .eq("id", id);
  if (!error) return status;
  if (/accepted_assignment_id|user_feedback|status|schema cache|column .* does not exist|check constraint/i.test(error.message || "")) {
    const legacyStatus = status === "approved" ? "accepted" : status === "ignored" ? "rejected" : status;
    const fallbackPayload = {
      status: legacyStatus,
      updated_at: now,
      ...(legacyStatus === "accepted" ? { accepted_at: now } : {}),
      ...(legacyStatus === "rejected" ? { rejected_at: now } : {}),
    };
    const { error: fallbackError } = await supabase
      .from("job_assignment_suggestions")
      .update(fallbackPayload)
      .eq("business_id", businessId)
      .eq("id", id);
    if (fallbackError) throw fallbackError;
    return legacyStatus;
  }
  throw error;
}

async function recordSuggestionAssignmentHistory({ businessId, suggestion, assignment = null, feedback = null, source = "ai_suggestion" }) {
  const jobId = getSuggestionJobId(suggestion);
  const payload = {
    business_id: businessId,
    transaction_id: suggestion.transaction_id,
    job_id: jobId,
    assignment_id: assignment?.id || null,
    assigned_by: "user",
    confidence_score: getSuggestionConfidence(suggestion) || null,
    method_used: getSuggestionMethods(suggestion),
    source,
    user_feedback: feedback,
  };
  const { data, error } = await supabase
    .from("assignment_history")
    .insert(payload)
    .select("*")
    .maybeSingle();
  if (error) {
    if (isMissingTableError(error)) return null;
    throw error;
  }
  return data;
}

async function recordJobAssignmentHistory({
  businessId,
  transactionId,
  jobId,
  assignmentId = null,
  source = "manual_drag_drop",
  methodUsed = null,
  confidenceScore = null,
  userFeedback = null,
}) {
  if (!businessId || !transactionId || !jobId) return null;
  const methods = Array.isArray(methodUsed) && methodUsed.length ? methodUsed : [source];
  if (assignmentId) {
    const { data: existing, error: existingErr } = await supabase
      .from("assignment_history")
      .select("id")
      .eq("business_id", businessId)
      .eq("assignment_id", assignmentId)
      .eq("source", source)
      .limit(1);
    if (existingErr) {
      if (isMissingTableError(existingErr)) return null;
      throw existingErr;
    }
    if (existing?.length) return existing[0];
  }
  const payload = {
    business_id: businessId,
    transaction_id: transactionId,
    job_id: jobId,
    assignment_id: assignmentId,
    assigned_by: "user",
    confidence_score: confidenceScore,
    method_used: methods,
    source,
    user_feedback: userFeedback,
  };
  const { data, error } = await supabase
    .from("assignment_history")
    .insert(payload)
    .select("*")
    .maybeSingle();
  if (error) {
    if (isMissingTableError(error)) return null;
    throw error;
  }
  return data;
}

async function fetchJobCostingRows(businessId) {
  // Job Costing uses posted Books transactions as the source of truth.
  // This endpoint intentionally mirrors Books Review Posted transactions for job costing assignment.
  // This reuses the same underlying query as Books Review > Posted:
  // GET /api/bookkeeping/transactions?status=posted
  const postedRows = [];
  const pageSize = 200;
  let totalCount = 0;
  for (let page = 1; page <= 25; page += 1) {
    const result = await fetchBookkeepingTransactions({
      businessId,
      statusFilter: "posted",
      rangeParam: "all",
      page,
      pageSize,
    });
    const rows = Array.isArray(result?.rows) ? result.rows : [];
    if (page === 1) totalCount = Number(result?.totalCount || rows.length || 0);
    postedRows.push(...rows);
    if (!rows.length || postedRows.length >= totalCount) break;
  }
  const txns = (postedRows || []).map(normalizePostedBookTransaction);

  const ids = (txns || []).map((row) => row.id);
  let assignmentsByTransaction = {};
  if (ids.length) {
    const { data: assignments, error: assignmentErr } = await supabase
      .from("job_transaction_assignments")
      .select("*")
      .eq("business_id", businessId)
      .in("transaction_id", ids);
    if (assignmentErr) throw assignmentErr;
    assignmentsByTransaction = (assignments || []).reduce((acc, row) => {
      const key = String(row.transaction_id);
      if (!acc[key]) acc[key] = [];
      acc[key].push(row);
      return acc;
    }, {});
  }

  const { data: jobs, error: jobsErr } = await supabase
    .from("jobs")
    .select("*")
    .eq("business_id", businessId)
    .limit(100);
  if (jobsErr) throw jobsErr;
  // Change Orders are intentionally excluded from launch-critical Job Costing
  // summaries so an out-of-scope schema/route issue cannot block core jobs.
  const changeOrders = [];
  const changeOrdersByJob = changeOrders.reduce((acc, row) => {
    const key = String(row.job_id);
    if (!acc[key]) acc[key] = [];
    acc[key].push(row);
    return acc;
  }, {});

  const jobNameById = (jobs || []).reduce((acc, job) => {
    acc[String(job.id)] = getJobName(job);
    return acc;
  }, {});
  const rows = (txns || []).map((row) => {
    const assignments = assignmentsByTransaction[String(row.id)] || [];
    const assignment = assignments[0] || null;
    const assignedJobNames = Array.from(new Set(assignments.map((item) => item.job_label || jobNameById[String(item.job_id)]).filter(Boolean)));
    const assignedTotalPercent = assignments.reduce((sum, item) => sum + asNum(item.allocation_percent ?? 100), 0);
    const remainingPercent = Math.max(0, 100 - assignedTotalPercent);
    const memo = getTransactionMemo(row);
    const base = {
      id: row.id,
      date: row.date,
      vendor: row.vendor || row.payee || "",
      payee: row.payee || row.vendor || "",
      description: memo,
      memo,
      bank_memo: row.bank_memo || row.memo || row.original_description || row.name || row.description || "",
      amount: Number(row.amount || 0),
      direction: row.direction || (Number(row.amount || 0) < 0 ? "OUTFLOW" : "INFLOW"),
      final_qbo_account_id: row.final_qbo_account_id || null,
      final_qbo_account_name: row.final_qbo_account_name || null,
      gl_account_id: row.gl_account_id || row.final_qbo_account_id || null,
      gl_account: row.gl_account || row.final_qbo_account_name || "Uncategorized",
      qbo_txn_id: row.qbo_txn_id || null,
      qbo_txn_type: row.qbo_txn_type || null,
      posted_at: row.posted_at || null,
      plaid_account_id: row.plaid_account_id || null,
      status: "posted",
      job_id: assignment?.job_id || null,
      assignment_id: assignment?.id || null,
      assignment_ids: assignments.map((item) => item.id).filter(Boolean),
      allocation_percent: assignment?.allocation_percent ?? null,
      allocated_amount: assignment?.allocated_amount ?? null,
      job_label: assignedJobNames.length > 1 ? `Split across ${assignedJobNames.length} jobs` : assignment?.job_label || assignedJobNames[0] || null,
      assigned_job_names: assignedJobNames,
      assigned_total_percent: assignedTotalPercent,
      remaining_percent: remainingPercent,
      assignment_status: assignedTotalPercent >= 99.999 ? "assigned" : assignedTotalPercent > 0 ? "partial" : "unassigned",
      assignment_count: assignments.length,
      assignment_source: assignment?.source || assignment?.assignment_source || null,
      assignment_confidence: assignment?.confidence || null,
    };
    const assignment_rows = assignments.map((item) => ({
      ...base,
      assignment_row_id: `${row.id}:${item.id}`,
      assignment_id: item.id,
      job_id: item.job_id,
      job_label: item.job_label || jobNameById[String(item.job_id)] || null,
      allocation_percent: item.allocation_percent ?? null,
      allocated_amount: item.allocated_amount ?? null,
      assignment_source: item.source || item.assignment_source || null,
      assignment_confidence: item.confidence || null,
    }));
    return { ...base, assignment_rows };
  });

  const summaryByJob = (await fetchJobSummaries(businessId)).reduce((acc, row) => {
    acc[String(row.id)] = row;
    return acc;
  }, {});
  const activeJobs = (jobs || []).filter((job) => (
    !job.archived_at && String(job.status || "").toLowerCase() !== "archived"
  ));
  const normalizedJobs = activeJobs.map((job) => {
    const normalized = normalizeJob(job);
    const summary = summaryByJob[String(job.id)] || null;
    const jobChangeOrders = changeOrdersByJob[String(job.id)] || [];
    const baseRevenue = asNum(summary?.base_revenue ?? summary?.revenue);
    const baseCost = asNum(summary?.base_total_cost ?? summary?.total_cost);
    const changeOrderSummary = finalizeChangeOrderSummary(summarizeChangeOrders(jobChangeOrders));
    const changeOrderRevenue = changeOrderSummary.change_order_approved_revenue;
    const changeOrderCost = changeOrderSummary.change_order_cost_total;
    const revenue = baseRevenue + changeOrderRevenue;
    const totalCost = baseCost + changeOrderCost;
    const marginPercent = revenue > 0 ? ((revenue - totalCost) / revenue) * 100 : null;
    return {
      ...job,
      ...(summary || {}),
      jobName: normalized.jobName,
      job_name: normalized.jobName,
      customerName: normalized.customerName,
      customer_name: normalized.customerName,
      tradeType: normalized.tradeType,
      trade_type: normalized.tradeType,
      status: normalized.status,
      base_revenue: baseRevenue,
      base_total_cost: baseCost,
      revenue_summary: summary?.revenue_summary || null,
      selected_revenue_basis: summary?.selected_revenue_basis || job.job_costing_revenue_basis || null,
      revenue_basis_label: summary?.revenue_basis_label || null,
      revenue_source_status: summary?.revenue_source_status || job.revenue_source_status || null,
      estimated_value: summary?.estimated_value ?? 0,
      contract_value: summary?.contract_value ?? asNum(job.contract_amount),
      gross_invoiced_revenue: summary?.gross_invoiced_revenue ?? baseRevenue,
      credit_memo_amount: summary?.credit_memo_amount ?? 0,
      net_invoiced_revenue: summary?.net_invoiced_revenue ?? baseRevenue,
      collected_cash: summary?.collected_cash ?? 0,
      outstanding_receivable: summary?.outstanding_receivable ?? 0,
      remaining_to_bill: summary?.remaining_to_bill ?? 0,
      recognized_revenue: summary?.recognized_revenue ?? 0,
      job_costing_revenue: summary?.job_costing_revenue ?? baseRevenue,
      change_order_revenue: changeOrderRevenue,
      change_order_cost: changeOrderCost,
      ...changeOrderSummary,
      revenue,
      total_revenue: revenue,
      total_cost: totalCost,
      gross_margin: revenue - totalCost,
      gross_margin_dollars: revenue - totalCost,
      marginPercent,
      margin_percent: marginPercent,
      assigned_transaction_count: summary?.assigned_transaction_count || 0,
      change_orders: jobChangeOrders,
    };
  });

  return {
    transactions: rows,
    jobs: normalizedJobs,
    pagination: {
      total_posted_transactions: totalCount || rows.length,
      loaded_posted_transactions: rows.length,
      page_size: pageSize,
    },
  };
}

async function fetchPostedTransactionForAssignment(businessId, transactionId) {
  const bookkeepingStartDate = await getBookkeepingStartDate(supabase, businessId);
  const [{ data: transaction, error: txnErr }, { data: categorization, error: catErr }] = await Promise.all([
    supabase
      .from("bank_transactions")
      .select("id,business_id,date,name,merchant_name,counterparty_name,amount,direction,is_archived,plaid_account_id")
      .eq("business_id", businessId)
      .eq("id", transactionId)
      .eq("is_archived", false)
      .maybeSingle(),
      supabase
        .from("transaction_categorizations")
        .select("*")
        .eq("business_id", businessId)
        .eq("transaction_id", transactionId)
        .maybeSingle(),
  ]);
  if (txnErr) throw txnErr;
  if (catErr) throw catErr;
  if (!transaction) {
    const e = new Error("Transaction was not found for this business.");
    e.status = 404;
    e.code = "transaction_not_found";
    throw e;
  }
  if (!isTransactionInActiveBookkeepingScope(transaction, bookkeepingStartDate)) {
    const e = new Error("Transaction is before the bookkeeping start date.");
    e.status = 400;
    e.code = "transaction_before_bookkeeping_start_date";
    throw e;
  }
  const isPosted = categorization?.status === "posted" || Boolean(categorization?.qbo_txn_id);
  if (!isPosted) {
    const e = new Error("Only posted Books transactions can be assigned to jobs.");
    e.status = 400;
    e.code = "transaction_not_posted";
    throw e;
  }
  return { transaction, categorization: categorization || {} };
}

async function fetchJobForAssignment(businessId, jobId) {
  const { data: job, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("business_id", businessId)
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw error;
  if (!job) {
    const e = new Error("That job was not found for this business.");
    e.status = 404;
    e.code = "job_not_found";
    throw e;
  }
  const normalized = withNormalizedJob(job);
  if (isCompletedJobStatus(normalized.status)) {
    const e = new Error("Completed jobs are archived from assignment. Reopen the job before assigning more transactions.");
    e.status = 400;
    e.code = "job_not_assignable";
    throw e;
  }
  return normalized;
}

function buildAssignmentPayload({ businessId, job, transaction, categorization, source = "manual_drag_drop", allocationPercent = 100, allocatedAmount = null, notes = null }) {
  const percentValue = Number(allocationPercent || 100);
  const safePercent = Number.isFinite(percentValue) ? percentValue : 100;
  const amountValue = allocatedAmount === null || allocatedAmount === undefined || allocatedAmount === ""
    ? Math.abs(asNum(transaction.amount)) * (safePercent / 100)
    : Math.abs(asNum(allocatedAmount));
  return {
    business_id: businessId,
    job_id: job.id,
    transaction_id: transaction.id,
    qbo_txn_id: categorization.qbo_txn_id || null,
    qbo_txn_type: categorization.qbo_txn_type || null,
    final_qbo_account_id: categorization.final_qbo_account_id || null,
    final_qbo_account_name: categorization.final_qbo_account_name || null,
    allocated_amount: amountValue,
    allocation_percent: safePercent,
    source,
    notes,
  };
}

async function savePostedTransactionAssignment({ businessId, jobId, transactionId, allocationPercent = 100, allocatedAmount = null, source = "manual_drag_drop", notes = null, replaceExistingForTransaction = true }) {
  const [job, posted] = await Promise.all([
    fetchJobForAssignment(businessId, jobId),
    fetchPostedTransactionForAssignment(businessId, transactionId),
  ]);
  const payload = buildAssignmentPayload({
    businessId,
    job,
    transaction: posted.transaction,
    categorization: posted.categorization,
    source,
    allocationPercent,
    allocatedAmount,
    notes,
  });
  if (payload.allocation_percent <= 0 || payload.allocation_percent > 100) {
    const e = new Error("Allocation percent must be between 1 and 100.");
    e.status = 400;
    e.code = "allocation_percent_invalid";
    throw e;
  }
  if (replaceExistingForTransaction) {
    const { error: deleteErr } = await supabase
      .from("job_transaction_assignments")
      .delete()
      .eq("business_id", businessId)
      .eq("transaction_id", transactionId);
    if (deleteErr) throw deleteErr;
  }
  const { data: existingRows, error: existingErr } = await supabase
    .from("job_transaction_assignments")
    .select("id,job_id,allocation_percent")
    .eq("business_id", businessId)
    .eq("transaction_id", transactionId);
  if (existingErr) throw existingErr;
  const existingPercent = (existingRows || [])
    .filter((row) => String(row.job_id) !== String(jobId))
    .reduce((sum, row) => sum + asNum(row.allocation_percent), 0);
  if (existingPercent + payload.allocation_percent > 100.0001) {
    const e = new Error("This transaction is already fully allocated.");
    e.status = 400;
    e.code = "transaction_fully_allocated";
    e.details = {
      assigned_total_percent: existingPercent,
      remaining_percent: Math.max(0, 100 - existingPercent),
    };
    throw e;
  }
  const { data, error } = await supabase
    .from("job_transaction_assignments")
    .upsert([payload], { onConflict: "business_id,job_id,transaction_id" })
    .select("*")
    .single();
  if (error) throw error;
  const savedAssignment = data || payload;
  const resolution = await createRevenueEvidenceForAssignment({
    businessId,
    job,
    transaction: posted.transaction,
    categorization: posted.categorization,
    assignment: savedAssignment,
  });
  if (resolution.evidence || resolution.financial_role || resolution.assignment_resolution) {
    const { data: updatedAssignment, error: resolutionErr } = await supabase
      .from("job_transaction_assignments")
      .update({
        financial_role: resolution.financial_role || null,
        revenue_evidence_id: resolution.evidence?.id || null,
        assignment_resolution: resolution.assignment_resolution || {},
      })
      .eq("business_id", businessId)
      .eq("id", savedAssignment.id)
      .select("*")
      .maybeSingle();
    if (resolutionErr && !isMissingTableError(resolutionErr)) throw resolutionErr;
    return { assignment: updatedAssignment || { ...savedAssignment, financial_role: resolution.financial_role, assignment_resolution: resolution.assignment_resolution }, job, transaction: posted.transaction, impact: resolution.assignment_resolution };
  }
  return { assignment: savedAssignment, job, transaction: posted.transaction };
}

function isRevenueAssignment(transaction = {}, categorization = {}) {
  return classifyRevenueTransaction(transaction, categorization);
}

function isCostAssignment(transaction = {}, categorization = {}) {
  return classifyCostTransaction(transaction, categorization);
}

async function fetchJobSummaries(businessId) {
  const [{ data: jobs, error: jobsErr }, { data: assignments, error: assignmentsErr }] = await Promise.all([
    supabase
      .from("jobs")
      .select("*")
      .eq("business_id", businessId)
      .limit(200),
    supabase
      .from("job_transaction_assignments")
      .select("*")
      .eq("business_id", businessId),
  ]);
  if (jobsErr) throw jobsErr;
  if (assignmentsErr) throw assignmentsErr;
  // Change Orders are intentionally excluded from launch-critical Job Costing
  // rows so core posted transactions and jobs do not depend on that feature.
  const changeOrders = [];
  const changeOrdersByJob = changeOrders.reduce((acc, row) => {
    const key = String(row.job_id);
    if (!acc[key]) acc[key] = [];
    acc[key].push(row);
    return acc;
  }, {});

  const transactionIds = Array.from(new Set((assignments || []).map((row) => row.transaction_id).filter(Boolean)));
  let transactionMap = {};
  let categorizationMap = {};
  if (transactionIds.length) {
    const bookkeepingStartDate = await getBookkeepingStartDate(supabase, businessId);
    const [{ data: transactions, error: txnErr }, { data: categorizations, error: catErr }] = await Promise.all([
      applyActiveBookkeepingScope(
        supabase
        .from("bank_transactions")
        .select("id,business_id,amount,direction,is_archived")
        .eq("business_id", businessId)
        .eq("is_archived", false),
        bookkeepingStartDate
      )
        .in("id", transactionIds),
      supabase
        .from("transaction_categorizations")
        .select("*")
        .eq("business_id", businessId)
        .in("transaction_id", transactionIds),
    ]);
    if (txnErr) throw txnErr;
    if (catErr) throw catErr;
    transactionMap = (transactions || []).reduce((acc, row) => {
      acc[row.id] = row;
      return acc;
    }, {});
    categorizationMap = (categorizations || []).reduce((acc, row) => {
      acc[row.transaction_id] = row;
      return acc;
    }, {});
  }

  const totalsByJob = (assignments || []).reduce((acc, assignment) => {
    const transaction = transactionMap[assignment.transaction_id];
    const categorization = categorizationMap[assignment.transaction_id] || assignment;
    const isPosted = categorization?.status === "posted" || Boolean(categorization?.qbo_txn_id);
    if (!transaction || transaction.is_archived || !isPosted) return acc;

    const jobId = String(assignment.job_id);
    if (!acc[jobId]) {
      acc[jobId] = { revenue: 0, total_cost: 0, assigned_transaction_count: 0 };
    }
    const allocationPercent = Number(assignment.allocation_percent ?? 100);
    const allocatedAmount = assignment.allocated_amount === null || assignment.allocated_amount === undefined
      ? Math.abs(asNum(transaction.amount)) * ((Number.isFinite(allocationPercent) ? allocationPercent : 100) / 100)
      : Math.abs(asNum(assignment.allocated_amount));

    if (isRevenueAssignment(transaction, categorization)) {
      acc[jobId].revenue += allocatedAmount;
    } else if (isCostAssignment(transaction, categorization)) {
      acc[jobId].total_cost += allocatedAmount;
    }
    acc[jobId].assigned_transaction_count += 1;
    return acc;
  }, {});

  const canonicalRevenueByJob = await fetchCanonicalJobRevenueSummaries({
    businessId,
    jobs: jobs || [],
  });

  return (jobs || []).map((job) => {
    const normalized = normalizeJob(job);
    const totals = totalsByJob[String(job.id)] || { revenue: 0, total_cost: 0, assigned_transaction_count: 0 };
    const changeOrderSummary = finalizeChangeOrderSummary(summarizeChangeOrders(changeOrdersByJob[String(job.id)] || []));
    const revenueSummary = canonicalRevenueByJob[String(job.id)] || null;
    const baseRevenue = asNum(revenueSummary?.jobCostingRevenue);
    const totalRevenue = baseRevenue + changeOrderSummary.change_order_approved_revenue;
    const totalCost = totals.total_cost + changeOrderSummary.change_order_cost_total;
    const grossMargin = totalRevenue - totalCost;
    const marginPercent = totalRevenue > 0 ? (grossMargin / totalRevenue) * 100 : null;
    return {
      id: normalized.id,
      job_name: normalized.jobName,
      jobName: normalized.jobName,
      customer_name: normalized.customerName,
      customerName: normalized.customerName,
      trade_type: normalized.tradeType,
      tradeType: normalized.tradeType,
      status: normalized.status,
      revenue_summary: revenueSummary,
      selected_revenue_basis: revenueSummary?.selectedBasis || null,
      revenue_basis_label: revenueSummary?.basisLabel || null,
      revenue_source_status: revenueSummary?.sourceStatus || null,
      estimated_value: revenueSummary?.estimatedValue ?? 0,
      contract_value: revenueSummary?.contractValue ?? asNum(job.contract_amount),
      gross_invoiced_revenue: revenueSummary?.grossInvoicedRevenue ?? 0,
      credit_memo_amount: revenueSummary?.creditMemoAmount ?? 0,
      net_invoiced_revenue: revenueSummary?.netInvoicedRevenue ?? 0,
      collected_cash: revenueSummary?.collectedCash ?? 0,
      outstanding_receivable: revenueSummary?.outstandingReceivable ?? 0,
      remaining_to_bill: revenueSummary?.remainingToBill ?? 0,
      recognized_revenue: revenueSummary?.recognizedRevenue ?? 0,
      job_costing_revenue: revenueSummary?.jobCostingRevenue ?? baseRevenue,
      base_revenue: baseRevenue,
      legacy_assigned_revenue: totals.revenue,
      base_total_cost: totals.total_cost,
      revenue: totalRevenue,
      total_revenue: totalRevenue,
      total_cost: totalCost,
      gross_margin: grossMargin,
      gross_margin_dollars: grossMargin,
      margin_percent: marginPercent,
      marginPercent,
      assigned_transaction_count: totals.assigned_transaction_count,
      change_order_revenue: changeOrderSummary.change_order_approved_revenue,
      change_order_cost: changeOrderSummary.change_order_cost_total,
      ...changeOrderSummary,
    };
  });
}

/** Map Jobber stage/status → Busy status */
export function mapJobberToBusyStatus(stage = "") {
  const s = String(stage).toLowerCase();
  if (s.includes("request")) return "lead";
  if (s.includes("quote")) return "qualified";
  if (s.includes("visit")) return "scheduled";
  if (s.includes("progress")) return "in_progress";
  if (s.includes("completed")) return "completed";
  if (s.includes("won") || s.includes("paid") || s.includes("closed")) return "won";
  if (s.includes("lost") || s.includes("declined")) return "lost";
  return "lead";
}

/* ---------- GET /api/jobs/summary ---------- */
/* KPIs: new leads (7d), scheduled (next 14d), win rate (30d), outstanding AR */
router.get("/summary", async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    if (!businessId) return res.status(400).json({ error: "business_id required" });

    const now = new Date();
    const d7  = new Date(now); d7.setDate(d7.getDate() - 7);
    const d30 = new Date(now); d30.setDate(d30.getDate() - 30);
    const d14 = new Date(now); d14.setDate(d14.getDate() + 14);

    // New Leads (7d)
    const { count: leads7 } = await supabase
      .from("jobs")
      .select("*", { count: "exact", head: true })
      .eq("business_id", businessId)
      .eq("status", "lead")
      .gte("created_at", d7.toISOString());

    // Scheduled (next 14d)
    const { count: scheduled14 } = await supabase
      .from("jobs")
      .select("*", { count: "exact", head: true })
      .eq("business_id", businessId)
      .in("status", ["scheduled","in_progress"])
      .gte("start_date", now.toISOString().slice(0,10))
      .lte("start_date", d14.toISOString().slice(0,10));

    // Win rate (30d)
    const { data: wonLost } = await supabase
      .from("jobs")
      .select("status")
      .eq("business_id", businessId)
      .gte("created_at", d30.toISOString());
    const won = (wonLost || []).filter(r => r.status === "won").length;
    const lost = (wonLost || []).filter(r => r.status === "lost").length;
    const winRate = (won + lost) > 0 ? Math.round((won / (won + lost)) * 100) : null;

    // Outstanding AR
    const { data: arRows } = await supabase
      .from("jobs")
      .select("amount_invoiced, amount_paid, invoice_status")
      .eq("business_id", businessId)
      .neq("invoice_status", "paid");
    const arOutstanding = (arRows || []).reduce((sum, r) => {
      const inv = asNum(r.amount_invoiced);
      const paid = asNum(r.amount_paid);
      const due = Math.max(inv - paid, 0);
      return sum + due;
    }, 0);

    res.json({
      leads_7d: leads7 ?? 0,
      scheduled_next_14d: scheduled14 ?? 0,
      win_rate_30d: winRate,
      outstanding_ar: Math.round(arOutstanding),
    });
  } catch (e) {
    console.error("[jobs.summary]", e);
    res.status(500).json({ error: "summary_failed" });
  }
});

/* ---------- GET /api/jobs/pipeline ---------- */
/* columns: lead, qualified, scheduled, in_progress, completed, won, lost (read-only v1) */
router.get("/pipeline", async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    if (!businessId) return res.status(400).json({ error: "business_id required" });

    const { data, error } = await supabase
      .from("jobs")
      .select("*")
      .eq("business_id", businessId)
      .order("due_date", { ascending: true })
      .limit(500);

    if (error) throw error;

    const cols = ["lead","qualified","scheduled","in_progress","completed","won","lost"].reduce((acc, k) => {
      acc[k] = [];
      return acc;
    }, {});
    (data || []).forEach((j) => {
      const row = withNormalizedJob(j);
      (cols[row.status] || cols.lead).push(row);
    });
    res.json(cols);
  } catch (e) {
    console.error("[jobs.pipeline]", e);
    res.status(500).json({ error: "pipeline_failed" });
  }
});

/* ---------- GET /api/jobs/top-unpaid ---------- */
router.get("/top-unpaid", async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    if (!businessId) return res.status(400).json({ error: "business_id required" });

    const { data, error } = await supabase
      .from("jobs")
      .select("*")
      .eq("business_id", businessId)
      .in("invoice_status", ["unpaid","partial"])
      .order("last_update_at", { ascending: false })
      .limit(10);
    if (error) throw error;

    const rows = (data || []).map(r => {
      const due = Math.max(asNum(r.amount_invoiced) - asNum(r.amount_paid), 0);
      return { ...withNormalizedJob(r), amount_due: due };
    }).sort((a,b) => b.amount_due - a.amount_due);

    res.json(rows);
  } catch (e) {
    console.error("[jobs.top-unpaid]", e);
    res.status(500).json({ error: "top_unpaid_failed" });
  }
});

/* ---------- GET /api/jobs/activity (last 7 days) ---------- */
router.get("/activity", async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    if (!businessId) return res.status(400).json({ error: "business_id required" });

    const d7 = new Date(); d7.setDate(d7.getDate() - 7);

    const { data, error } = await supabase
      .from("job_events")
      .select("id,job_id,event_type,payload,source,created_at")
      .eq("business_id", businessId)
      .gte("created_at", d7.toISOString())
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;

    res.json(data || []);
  } catch (e) {
    console.error("[jobs.activity]", e);
    res.status(500).json({ error: "activity_failed" });
  }
});

router.get("/job-costing", requireRouteAuth, async (req, res) => {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const payload = await fetchJobCostingRows(businessId);
    return res.json({ ok: true, ...payload });
  } catch (e) {
    console.error("[jobs.job-costing]", e);
    res.status(500).json({ ok: false, error: "job_costing_failed", message: e?.message || "failed" });
  }
});

async function handleAssignmentHistory(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const limit = Math.min(Math.max(Number(req.query.limit || 12), 1), 50);
    const history = await fetchAssignmentHistory(businessId, limit);
    return res.json({ ok: true, history });
  } catch (e) {
    console.error("[job-costing.assignment-history]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "assignment_history_failed",
      message: e?.message || "Failed to load assignment history.",
    });
  }
}

async function handleAssignmentPreview(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const instruction = normalizePrompt(req.body?.instruction || req.body?.prompt);
    const preview = await buildAssignmentPreview(businessId, instruction);
    return res.json({ ok: true, preview });
  } catch (e) {
    console.error("[job-costing.assignment-preview]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "assignment_preview_failed",
      message: e?.message || "Failed to preview assignment.",
    });
  }
}

async function handleAssignmentConfirm(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const instruction = normalizePrompt(req.body?.instruction || req.body?.prompt);
    const preview = await buildAssignmentPreview(businessId, instruction);
    if (preview.parsed.mode === "show") {
      return res.status(400).json({
        ok: false,
        error: "assignment_target_required",
        message: "Add a target job before confirming an assignment.",
      });
    }

    let assigned = 0;
    for (const txn of preview.transactions) {
      for (const allocation of txn.allocations) {
        const { assignment } = await savePostedTransactionAssignment({
          businessId,
          jobId: allocation.job_id,
          transactionId: txn.id,
          allocationPercent: allocation.allocation_percent,
          allocatedAmount: allocation.allocated_amount,
          source: "natural_language",
          notes: preview.parsed.instruction,
          replaceExistingForTransaction: false,
        });
        await recordJobAssignmentHistory({
          businessId,
          transactionId: txn.id,
          jobId: allocation.job_id,
          assignmentId: assignment?.id || null,
          source: "natural_language",
          methodUsed: ["natural_language"],
        });
        assigned += 1;
      }
    }

    const historyRow = await recordAssignmentHistory(businessId, preview, assigned);
    const [refreshed, history] = await Promise.all([
      fetchJobCostingRows(businessId),
      fetchAssignmentHistory(businessId),
    ]);
    triggerContractorCfoInsightsBestEffort({
      businessId,
      trigger: "job_costing",
      force: false,
    });
    return res.json({
      ok: true,
      message: "Transactions assigned to job.",
      assigned,
      preview,
      history_row: historyRow,
      history,
      ...refreshed,
    });
  } catch (e) {
    console.error("[job-costing.assignments-confirm]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "assignment_confirm_failed",
      message: e?.message || "Failed to confirm assignment.",
    });
  }
}

async function handleManualAssignment(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const transactionId = normalizePrompt(req.body?.transaction_id || req.body?.transactionId);
    const jobId = normalizePrompt(req.body?.job_id || req.body?.jobId);
    if (!transactionId || !jobId) {
      return res.status(400).json({
        ok: false,
        error: "manual_assignment_required",
        message: "Choose a posted transaction and job.",
      });
    }

    const { assignment, job } = await savePostedTransactionAssignment({
      businessId,
      jobId,
      transactionId,
      source: "manual_drag_drop",
    });
    await recordJobAssignmentHistory({
      businessId,
      transactionId,
      jobId,
      assignmentId: assignment?.id || null,
      source: "manual_drag_drop",
      methodUsed: ["manual_drag_drop"],
    });

    const refreshed = await fetchJobCostingRows(businessId);
    triggerContractorCfoInsightsBestEffort({
      businessId,
      trigger: "job_costing",
      force: false,
    });
    return res.json({
      ok: true,
      message: `Transaction assigned to ${job.jobName}.`,
      assignment,
      ...refreshed,
    });
  } catch (e) {
    console.error("[job-costing.assignments-manual]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "manual_assignment_failed",
      message: e?.message || "Failed to assign transaction.",
    });
  }
}

async function handleAssignmentsGet(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const query = supabase
      .from("job_transaction_assignments")
      .select("*")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false });
    if (req.query.job_id) query.eq("job_id", req.query.job_id);
    if (req.query.transaction_id) query.eq("transaction_id", req.query.transaction_id);
    const { data, error } = await query;
    if (error) throw error;
    return res.json({ ok: true, assignments: data || [] });
  } catch (e) {
    console.error("[job-costing.assignments-get]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "assignments_load_failed",
      message: e?.message || "Failed to load job transaction assignments.",
    });
  }
}

async function handleAssignmentCreate(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const jobId = normalizePrompt(req.body?.job_id || req.body?.jobId);
    const transactionId = normalizePrompt(req.body?.transaction_id || req.body?.transactionId);
    if (!jobId || !transactionId) {
      return res.status(400).json({
        ok: false,
        error: "assignment_required",
        message: "job_id and transaction_id are required.",
      });
    }
    const [jobForPreview, postedForPreview] = await Promise.all([
      fetchJobForAssignment(businessId, jobId),
      fetchPostedTransactionForAssignment(businessId, transactionId),
    ]);
    const impactPreview = buildAssignmentImpactPreview({
      transaction: postedForPreview.transaction,
      categorization: postedForPreview.categorization,
      allocationPercent: req.body?.allocation_percent ?? req.body?.allocationPercent ?? 100,
      allocatedAmount: req.body?.allocated_amount ?? req.body?.allocatedAmount ?? null,
    });
    const previewConfirmed = req.body?.impact_preview_confirmed === true || req.body?.impactPreviewConfirmed === true;
    if (!impactPreview.safe_to_assign_without_confirmation && !previewConfirmed) {
      return res.status(409).json({
        ok: false,
        error: "assignment_impact_preview_required",
        message: "Review and confirm assignment impact before assigning this transaction.",
        job: jobForPreview,
        transaction: postedForPreview.transaction,
        impact: impactPreview,
      });
    }
    const { assignment, job } = await savePostedTransactionAssignment({
      businessId,
      jobId,
      transactionId,
      allocationPercent: req.body?.allocation_percent ?? req.body?.allocationPercent ?? 100,
      allocatedAmount: req.body?.allocated_amount ?? req.body?.allocatedAmount ?? null,
      source: req.body?.source || "manual_drag_drop",
      notes: req.body?.notes || null,
      replaceExistingForTransaction: req.body?.replace_existing ?? req.body?.replaceExisting ?? true,
    });
    const source = req.body?.source || "manual_drag_drop";
    if (source !== "ai_suggestion") {
      await recordJobAssignmentHistory({
        businessId,
        transactionId,
        jobId,
        assignmentId: assignment?.id || null,
        source,
        methodUsed: [source],
      });
    }
    const refreshed = await fetchJobCostingRows(businessId);
    triggerContractorCfoInsightsBestEffort({
      businessId,
      trigger: "job_costing",
      force: false,
    });
    return res.json({
      ok: true,
      message: `Transaction assigned to ${job.jobName}.`,
      assignment,
      ...refreshed,
    });
  } catch (e) {
    console.error("[job-costing.assignments-create]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "assignment_create_failed",
      message: e?.message || "Failed to assign transaction.",
    });
  }
}

async function handleAssignmentDelete(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const assignmentId = req.params.assignmentId;
    const { data, error } = await supabase
      .from("job_transaction_assignments")
      .delete()
      .eq("business_id", businessId)
      .eq("id", assignmentId)
      .select("*")
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      return res.status(404).json({
        ok: false,
        error: "assignment_not_found",
        message: "Assignment was not found for this business.",
      });
    }
    await recordJobAssignmentHistory({
      businessId,
      transactionId: data.transaction_id,
      jobId: data.job_id,
      assignmentId: data.id,
      source: "manual_remove",
      methodUsed: ["manual_remove"],
      userFeedback: "removed",
    });
    const refreshed = await fetchJobCostingRows(businessId);
    triggerContractorCfoInsightsBestEffort({
      businessId,
      trigger: "job_costing",
      force: false,
    });
    return res.json({ ok: true, message: "Assignment removed.", deleted_id: assignmentId, ...refreshed });
  } catch (e) {
    console.error("[job-costing.assignments-delete]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "assignment_delete_failed",
      message: e?.message || "Failed to remove assignment.",
    });
  }
}

async function handleJobsSummary(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const jobs = await fetchJobSummaries(businessId);
    return res.json({ ok: true, jobs });
  } catch (e) {
    console.error("[job-costing.jobs-summary]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "jobs_summary_failed",
      message: e?.message || "Failed to load job costing summary.",
    });
  }
}

async function handleJobFinancialSummary(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const jobId = normalizePrompt(req.params.jobId || req.query.job_id || req.query.jobId);
    if (!jobId) {
      return res.status(400).json({
        ok: false,
        error: "job_required",
        message: "job_id is required.",
      });
    }
    const detail = await fetchJobFinancialDetail({ businessId, jobId });
    if (!detail) {
      return res.status(404).json({
        ok: false,
        error: "job_not_found",
        message: "That job was not found for this business.",
      });
    }
    return res.json({ ok: true, ...detail });
  } catch (e) {
    console.error("[job-costing.financial-summary]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "job_financial_summary_failed",
      message: e?.message || "Failed to load job financial summary.",
    });
  }
}

async function handleRevenueDocumentsGet(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const query = supabase
      .from("job_revenue_documents")
      .select("*")
      .eq("business_id", businessId)
      .order("document_date", { ascending: false });
    if (req.query.job_id) query.eq("job_id", req.query.job_id);
    if (req.query.customer_id) query.eq("customer_id", req.query.customer_id);
    if (req.query.type) query.eq("source_document_type", req.query.type);
    const { data, error } = await query;
    if (error) throw error;
    return res.json({ ok: true, revenue_documents: data || [] });
  } catch (e) {
    console.error("[job-costing.revenue-documents-get]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "revenue_documents_failed",
      message: e?.message || "Failed to load revenue documents.",
    });
  }
}

async function handleRevenueDocumentsPost(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const doc = req.body || {};
    const payload = {
      business_id: businessId,
      job_id: doc.job_id || doc.jobId || null,
      customer_id: doc.customer_id || doc.customerId || null,
      source_system: doc.source_system || doc.sourceSystem || "manual",
      source_document_type: doc.source_document_type || doc.sourceDocumentType || doc.type,
      external_document_id: doc.external_document_id || doc.externalDocumentId || null,
      realm_id: doc.realm_id || doc.realmId || null,
      qbo_env: doc.qbo_env || doc.qboEnv || null,
      document_number: doc.document_number || doc.documentNumber || null,
      document_date: doc.document_date || doc.documentDate || doc.date || null,
      due_date: doc.due_date || doc.dueDate || null,
      total_amount: asNum(doc.total_amount ?? doc.totalAmount),
      open_balance: asNum(doc.open_balance ?? doc.openBalance),
      status: doc.status || "active",
      currency: doc.currency || null,
      customer_ref: doc.customer_ref || doc.customerRef || null,
      project_ref: doc.project_ref || doc.projectRef || null,
      linked_txn: Array.isArray(doc.linked_txn || doc.linkedTxn) ? (doc.linked_txn || doc.linkedTxn) : [],
      line_summaries: Array.isArray(doc.line_summaries || doc.lineSummaries) ? (doc.line_summaries || doc.lineSummaries) : [],
      billing_address: doc.billing_address || doc.billingAddress || null,
      shipping_address: doc.shipping_address || doc.shippingAddress || null,
      source_snapshot: doc.source_snapshot || doc.sourceSnapshot || {},
      source_updated_at: doc.source_updated_at || doc.sourceUpdatedAt || null,
      last_synced_at: doc.last_synced_at || doc.lastSyncedAt || new Date().toISOString(),
      sync_status: doc.sync_status || doc.syncStatus || "synced",
    };
    if (!payload.source_document_type) {
      return res.status(400).json({ ok: false, error: "document_type_required", message: "source_document_type is required." });
    }
    const { data, error } = await supabase
      .from("job_revenue_documents")
      .upsert([payload], { onConflict: "business_id,realm_id,source_system,source_document_type,external_document_id" })
      .select("*")
      .maybeSingle();
    if (error) throw error;
    return res.json({ ok: true, revenue_document: data || payload });
  } catch (e) {
    console.error("[job-costing.revenue-documents-post]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "revenue_document_save_failed",
      message: e?.message || "Failed to save revenue document.",
    });
  }
}

async function handlePaymentsGet(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const [payments, allocations] = await Promise.all([
      supabase.from("job_payment_records").select("*").eq("business_id", businessId).order("payment_date", { ascending: false }),
      supabase.from("job_payment_allocations").select("*").eq("business_id", businessId).order("created_at", { ascending: false }),
    ]);
    if (payments.error) throw payments.error;
    if (allocations.error) throw allocations.error;
    return res.json({ ok: true, payments: payments.data || [], allocations: allocations.data || [] });
  } catch (e) {
    console.error("[job-costing.payments-get]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "payments_failed",
      message: e?.message || "Failed to load payment records.",
    });
  }
}

async function handlePaymentAllocationPost(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const body = req.body || {};
    const paymentPayload = {
      business_id: businessId,
      customer_id: body.customer_id || body.customerId || null,
      source_system: body.source_system || body.sourceSystem || "qbo",
      external_payment_id: body.external_payment_id || body.externalPaymentId || null,
      realm_id: body.realm_id || body.realmId || null,
      qbo_env: body.qbo_env || body.qboEnv || null,
      payment_date: body.payment_date || body.paymentDate || null,
      total_amount: asNum(body.total_amount ?? body.totalAmount),
      unapplied_amount: asNum(body.unapplied_amount ?? body.unappliedAmount),
      currency: body.currency || null,
      deposit_ref: body.deposit_ref || body.depositRef || null,
      sync_token: body.sync_token || body.syncToken || null,
      source_snapshot: body.source_snapshot || body.sourceSnapshot || {},
      source_updated_at: body.source_updated_at || body.sourceUpdatedAt || null,
      last_synced_at: body.last_synced_at || body.lastSyncedAt || new Date().toISOString(),
      sync_status: body.sync_status || body.syncStatus || "synced",
    };
    const { data: payment, error: paymentErr } = await supabase
      .from("job_payment_records")
      .upsert([paymentPayload], { onConflict: "business_id,realm_id,source_system,external_payment_id" })
      .select("*")
      .maybeSingle();
    if (paymentErr) throw paymentErr;
    const allocation = body.allocation || body.payment_allocation || body.paymentAllocation || null;
    if (!allocation) return res.json({ ok: true, payment });

    const allocationPayload = {
      business_id: businessId,
      payment_record_id: allocation.payment_record_id || allocation.paymentRecordId || payment?.id,
      revenue_document_id: allocation.revenue_document_id || allocation.revenueDocumentId,
      applied_amount: asNum(allocation.applied_amount ?? allocation.appliedAmount),
      linked_transaction_type: allocation.linked_transaction_type || allocation.linkedTransactionType || null,
      linked_transaction_id: allocation.linked_transaction_id || allocation.linkedTransactionId || null,
      allocation_source: allocation.allocation_source || allocation.allocationSource || "qbo_linked_txn",
      snapshot_version: allocation.snapshot_version || allocation.snapshotVersion || null,
      source_snapshot: allocation.source_snapshot || allocation.sourceSnapshot || {},
    };
    if (!allocationPayload.revenue_document_id) {
      return res.status(400).json({ ok: false, error: "revenue_document_required", message: "revenue_document_id is required for allocations." });
    }
    const { data: savedAllocation, error: allocationErr } = await supabase
      .from("job_payment_allocations")
      .upsert([allocationPayload], { onConflict: "business_id,payment_record_id,revenue_document_id,linked_transaction_type,linked_transaction_id" })
      .select("*")
      .maybeSingle();
    if (allocationErr) throw allocationErr;
    return res.json({ ok: true, payment, allocation: savedAllocation });
  } catch (e) {
    console.error("[job-costing.payment-allocation-post]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "payment_allocation_save_failed",
      message: e?.message || "Failed to save payment allocation.",
    });
  }
}

async function handleRevenueEvidenceGet(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const query = supabase
      .from("job_revenue_evidence")
      .select("*")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false });
    if (req.query.job_id) query.eq("job_id", req.query.job_id);
    if (req.query.transaction_id) query.eq("bank_transaction_id", req.query.transaction_id);
    const { data, error } = await query;
    if (error) throw error;
    return res.json({ ok: true, revenue_evidence: data || [] });
  } catch (e) {
    console.error("[job-costing.revenue-evidence-get]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "revenue_evidence_failed",
      message: e?.message || "Failed to load revenue evidence.",
    });
  }
}

async function handleAssignmentImpactPreview(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const transactionId = normalizePrompt(req.body?.transaction_id || req.body?.transactionId);
    const jobId = normalizePrompt(req.body?.job_id || req.body?.jobId);
    if (!transactionId || !jobId) {
      return res.status(400).json({ ok: false, error: "assignment_required", message: "transaction_id and job_id are required." });
    }
    const [job, posted] = await Promise.all([
      fetchJobForAssignment(businessId, jobId),
      fetchPostedTransactionForAssignment(businessId, transactionId),
    ]);
    const impact = buildAssignmentImpactPreview({
      transaction: posted.transaction,
      categorization: posted.categorization,
      allocationPercent: req.body?.allocation_percent ?? req.body?.allocationPercent ?? 100,
      allocatedAmount: req.body?.allocated_amount ?? req.body?.allocatedAmount ?? null,
    });
    return res.json({ ok: true, job, transaction: posted.transaction, impact });
  } catch (e) {
    console.error("[job-costing.assignment-impact-preview]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "assignment_impact_preview_failed",
      message: e?.message || "Failed to preview assignment impact.",
    });
  }
}

async function handleAssignmentResolutionConfirm(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const jobId = normalizePrompt(req.body?.job_id || req.body?.jobId);
    const transactionId = normalizePrompt(req.body?.transaction_id || req.body?.transactionId);
    if (!jobId || !transactionId) {
      return res.status(400).json({ ok: false, error: "assignment_required", message: "job_id and transaction_id are required." });
    }
    const { assignment, job, impact } = await savePostedTransactionAssignment({
      businessId,
      jobId,
      transactionId,
      allocationPercent: req.body?.allocation_percent ?? req.body?.allocationPercent ?? 100,
      allocatedAmount: req.body?.allocated_amount ?? req.body?.allocatedAmount ?? null,
      source: req.body?.source || "manual_resolution",
      notes: req.body?.notes || req.body?.resolution_choice || null,
      replaceExistingForTransaction: req.body?.replace_existing ?? req.body?.replaceExisting ?? true,
    });
    await recordJobAssignmentHistory({
      businessId,
      transactionId,
      jobId,
      assignmentId: assignment?.id || null,
      source: req.body?.source || "manual_resolution",
      methodUsed: ["assignment_resolution"],
      userFeedback: req.body?.resolution_choice || null,
    });
    const [refreshed, financial] = await Promise.all([
      fetchJobCostingRows(businessId),
      fetchJobFinancialDetail({ businessId, jobId }),
    ]);
    return res.json({ ok: true, assignment, job, impact, financial, ...refreshed });
  } catch (e) {
    console.error("[job-costing.assignment-resolution-confirm]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "assignment_resolution_confirm_failed",
      message: e?.message || "Failed to confirm assignment resolution.",
    });
  }
}

async function updateJobCompletionStatus({ businessId, jobId }) {
  const completedAt = new Date().toISOString();
  const completeDate = completedAt.slice(0, 10);
  const basePayload = {
    status: "completed",
    end_date: completeDate,
    updated_at: completedAt,
  };
  const withCompletedAt = { ...basePayload, completed_at: completedAt };
  let result = await supabase
    .from("jobs")
    .update(withCompletedAt)
    .eq("business_id", businessId)
    .eq("id", jobId)
    .select("*")
    .maybeSingle();

  if (result.error && /completed_at/i.test(String(result.error.message || result.error.details || ""))) {
    result = await supabase
      .from("jobs")
      .update(basePayload)
      .eq("business_id", businessId)
      .eq("id", jobId)
      .select("*")
      .maybeSingle();
  }
  if (result.error) throw result.error;
  if (!result.data) {
    const e = new Error("That job was not found for this business.");
    e.status = 404;
    e.code = "job_not_found";
    throw e;
  }
  return withNormalizedJob(result.data);
}

async function updateJobReopenStatus({ businessId, jobId }) {
  const updatedAt = new Date().toISOString();
  const basePayload = {
    status: "active",
    updated_at: updatedAt,
  };
  const withCompletedAt = { ...basePayload, completed_at: null };
  let result = await supabase
    .from("jobs")
    .update(withCompletedAt)
    .eq("business_id", businessId)
    .eq("id", jobId)
    .select("*")
    .maybeSingle();

  if (result.error && /completed_at/i.test(String(result.error.message || result.error.details || ""))) {
    result = await supabase
      .from("jobs")
      .update(basePayload)
      .eq("business_id", businessId)
      .eq("id", jobId)
      .select("*")
      .maybeSingle();
  }
  if (result.error) throw result.error;
  if (!result.data) {
    const e = new Error("That job was not found for this business.");
    e.status = 404;
    e.code = "job_not_found";
    throw e;
  }
  return withNormalizedJob(result.data);
}

async function handleJobComplete(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const jobId = normalizePrompt(req.params.jobId || req.body?.job_id || req.body?.jobId);
    if (!jobId) {
      return res.status(400).json({
        ok: false,
        error: "job_required",
        message: "job_id is required.",
      });
    }
    const job = await updateJobCompletionStatus({ businessId, jobId });
    const jobs = await fetchJobSummaries(businessId);
    triggerContractorCfoInsightsBestEffort({
      businessId,
      trigger: "job_costing",
      force: false,
    });
    return res.json({
      ok: true,
      message: `${job.jobName} moved to Completed Jobs.`,
      job,
      jobs,
    });
  } catch (e) {
    console.error("[job-costing.jobs-complete]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "job_complete_failed",
      message: e?.message || "Failed to mark job complete.",
    });
  }
}

async function handleJobReopen(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const jobId = normalizePrompt(req.params.jobId || req.body?.job_id || req.body?.jobId);
    if (!jobId) {
      return res.status(400).json({
        ok: false,
        error: "job_required",
        message: "job_id is required.",
      });
    }
    const job = await updateJobReopenStatus({ businessId, jobId });
    const jobs = await fetchJobSummaries(businessId);
    triggerContractorCfoInsightsBestEffort({
      businessId,
      trigger: "job_costing",
      force: false,
    });
    return res.json({
      ok: true,
      message: `${job.jobName} moved back to Live Jobs.`,
      job,
      jobs,
    });
  } catch (e) {
    console.error("[job-costing.jobs-reopen]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "job_reopen_failed",
      message: e?.message || "Failed to move job back to Live Jobs.",
    });
  }
}

async function handleQboJobCostingSync(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const mode = req.body?.mode || req.query?.mode || "incremental";
    const since = req.body?.since || req.query?.since || null;
    const result = await runQboJobCostingSync({
      businessId,
      mode: mode === "full" || mode === "backfill" ? "full" : "incremental",
      since,
    });
    return res.json(result);
  } catch (e) {
    console.error("[job-costing.qbo-sync]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "qbo_job_costing_sync_failed",
      message: e?.message || "Failed to sync QuickBooks job costing entities.",
    });
  }
}

async function handleQboJobCostingDiagnostics(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const diagnostics = await getQboJobCostingSyncDiagnostics({ businessId });
    const ongoing = await getQboOngoingSyncDiagnostics({ businessId });
    return res.json({ ...diagnostics, ongoingSync: ongoing });
  } catch (e) {
    console.error("[job-costing.qbo-sync-diagnostics]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "qbo_job_costing_diagnostics_failed",
      message: e?.message || "Failed to load QuickBooks job costing sync diagnostics.",
    });
  }
}

async function handleQboWebhookQueueProcess(req, res) {
  try {
    const result = await processQueuedQboWebhookEvents({
      limit: Number(req.body?.limit || req.query?.limit || 25),
    });
    return res.json(result);
  } catch (e) {
    console.error("[job-costing.qbo-webhook-process]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "qbo_webhook_process_failed",
      message: e?.message || "Failed to process queued QuickBooks webhook events.",
    });
  }
}

async function handleQboCdcSync(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const result = await runQboCdcForBusiness({
      businessId,
      overlapMinutes: Number(req.body?.overlap_minutes || req.body?.overlapMinutes || req.query?.overlap_minutes || 10),
    });
    return res.json(result);
  } catch (e) {
    console.error("[job-costing.qbo-cdc]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "qbo_cdc_failed",
      message: e?.message || "Failed to run QuickBooks CDC recovery sync.",
    });
  }
}

async function handleQboDailyReconciliation(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const result = await runDailyQboJobCostingReconciliation({ businessId });
    return res.json(result);
  } catch (e) {
    console.error("[job-costing.qbo-daily-reconciliation]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "qbo_daily_reconciliation_failed",
      message: e?.message || "Failed to run QuickBooks job costing reconciliation.",
    });
  }
}

async function handleQboBackfillRun(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const result = await runQboJobCostingBackfill({
      businessId,
      startDate: req.body?.start_date || req.body?.startDate || req.query?.start_date || null,
      endDate: req.body?.end_date || req.body?.endDate || req.query?.end_date || null,
      batchSize: Number(req.body?.batch_size || req.body?.batchSize || req.query?.batch_size || 1000),
    });
    return res.json(result);
  } catch (e) {
    console.error("[job-costing.qbo-backfill]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "qbo_backfill_failed",
      message: e?.message || "Failed to run QuickBooks job costing backfill.",
    });
  }
}

async function handleQboProjectsCapabilityCheck(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const result = await checkQboProjectsCapability({ businessId });
    return res.json(result);
  } catch (e) {
    console.error("[job-costing.qbo-projects-capability]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "qbo_projects_capability_failed",
      message: e?.message || "Failed to check QuickBooks Projects capability.",
    });
  }
}

async function handleQboProjectsCapabilityRead(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const { data, error } = await supabase
      .from("qbo_projects_capabilities")
      .select("*")
      .eq("business_id", businessId)
      .order("checked_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return res.json({
      ok: true,
      capability: data || {
        status: "unknown",
        detail: "QuickBooks Projects capability has not been checked yet.",
        source_of_truth: "manual_link_only",
        auto_import_enabled: false,
      },
    });
  } catch (e) {
    console.error("[job-costing.qbo-projects-capability-read]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "qbo_projects_capability_read_failed",
      message: e?.message || "Failed to load stored QuickBooks Projects capability.",
    });
  }
}

async function handleQboProjectsSync(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const result = await runQboProjectsSync({
      businessId,
      autoImport: req.body?.auto_import ?? req.body?.autoImport ?? null,
      userId: getAuthenticatedUserId(req),
    });
    return res.json(result);
  } catch (e) {
    console.error("[job-costing.qbo-projects-sync]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "qbo_projects_sync_failed",
      message: e?.message || "Failed to sync QuickBooks Projects.",
    });
  }
}

async function handleQboProjectCreateForJob(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const jobId = normalizePrompt(req.params.jobId || req.body?.job_id || req.body?.jobId);
    if (!jobId) return res.status(400).json({ ok: false, error: "job_required", message: "job_id is required." });
    const result = await createQuickBooksProjectForJob({
      businessId,
      jobId,
      customerPayload: req.body?.customer || {},
      projectPayload: req.body?.project || req.body || {},
    });
    return res.json(result);
  } catch (e) {
    console.error("[job-costing.qbo-project-create]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "qbo_project_create_failed",
      message: e?.message || "Failed to create that QuickBooks Project.",
    });
  }
}

async function handleJobCandidatesGet(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    let query = supabase
      .from("job_candidates")
      .select("*", { count: "exact" })
      .eq("business_id", businessId)
      .order("confidence_score", { ascending: false })
      .order("updated_at", { ascending: false });
    if (req.query.status) query = query.eq("candidate_status", req.query.status);
    if (req.query.source_entity_type || req.query.type) query = query.eq("source_entity_type", req.query.source_entity_type || req.query.type);
    const limit = Number(req.query.limit || 100);
    if (Number.isFinite(limit) && limit > 0) query = query.limit(Math.min(limit, 250));
    const { data, error, count } = await query;
    if (error) throw error;
    return res.json({
      ok: true,
      candidates: data || [],
      total_count: Number.isFinite(Number(count)) ? Number(count) : (data || []).length,
      loaded_count: (data || []).length,
    });
  } catch (e) {
    console.error("[job-costing.candidates-get]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "job_candidates_failed",
      message: e?.message || "Failed to load job candidates.",
    });
  }
}

async function handleJobCandidatesGenerate(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const result = await generateJobCandidatesForBusiness({ businessId });
    return res.json(result);
  } catch (e) {
    console.error("[job-costing.candidates-generate]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "job_candidates_generate_failed",
      message: e?.message || "Failed to generate job candidates.",
    });
  }
}

function getCandidateId(req) {
  return normalizePrompt(req.params.candidateId || req.params.id || req.body?.candidate_id || req.body?.candidateId);
}

async function fetchJobCandidateOrThrow(businessId, candidateId) {
  const { data, error } = await supabase
    .from("job_candidates")
    .select("*")
    .eq("business_id", businessId)
    .eq("id", candidateId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const e = new Error("Candidate not found.");
    e.status = 404;
    e.code = "job_candidate_not_found";
    throw e;
  }
  return data;
}

async function buildJobCandidateApprovalPreview({ businessId, candidateId, mode = "create_new", jobId = null }) {
  const candidate = await fetchJobCandidateOrThrow(businessId, candidateId);
  let jobToLink = null;
  if (mode === "link_existing") {
    if (!jobId) {
      const e = new Error("job_id is required to preview linking a candidate.");
      e.status = 400;
      e.code = "job_required";
      throw e;
    }
    jobToLink = await fetchJobForAssignment(businessId, jobId);
  }
  const amount = Math.abs(asNum(candidate.invoice_estimate_amount ?? candidate.document_amount ?? candidate.total_amount));
  const type = normalizePrompt(candidate.source_entity_type || "invoice").toLowerCase();
  const document = {
    source_system: candidate.source_system || "quickbooks",
    source_entity_type: candidate.source_entity_type || "invoice",
    source_entity_id: candidate.source_entity_id || candidate.external_document_id || candidate.id,
    document_number: candidate.document_number || candidate.source_document_number || null,
  };
  return {
    mode,
    job_to_create: mode === "create_new"
      ? {
          job_name: candidate.suggested_job_name || candidate.job_name || candidate.candidate_name || "Suggested job",
          customer_name: candidate.customer_name || candidate.source_customer_name || candidate.display_name || null,
          address: candidate.service_address || candidate.address || null,
        }
      : null,
    job_to_link: jobToLink ? { id: jobToLink.id, job_name: getJobName(jobToLink), customer_name: jobToLink.customer_name || jobToLink.client_name || null } : null,
    documents_to_attach: [document],
    document_count: 1,
    invoiced_revenue_change: type.includes("invoice") || type.includes("estimate") ? amount : 0,
    collected_cash_change: type.includes("sales") ? amount : 0,
    receivable_change: type.includes("invoice") || type.includes("estimate") ? amount : 0,
    duplicate_prevention: {
      result: "source_document_identity_checked",
      source_system: document.source_system,
      source_entity_type: document.source_entity_type,
      source_entity_id: document.source_entity_id,
    },
  };
}

async function handleJobCandidateApprovalPreview(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const candidateId = getCandidateId(req);
    if (!candidateId) return res.status(400).json({ ok: false, error: "candidate_required", message: "candidate_id is required." });
    const preview = await buildJobCandidateApprovalPreview({
      businessId,
      candidateId,
      mode: req.body?.mode || "create_new",
      jobId: req.body?.job_id || req.body?.jobId || null,
    });
    return res.json({ ok: true, preview });
  } catch (e) {
    console.error("[job-costing.candidates-approval-preview]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "job_candidate_approval_preview_failed",
      message: e?.message || "Failed to preview candidate approval.",
    });
  }
}

async function handleJobCandidateApproveNew(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const userId = getAuthenticatedUserId(req);
    const candidateId = getCandidateId(req);
    if (!candidateId) return res.status(400).json({ ok: false, error: "candidate_required", message: "candidate_id is required." });
    if (!userId) return res.status(400).json({ ok: false, error: "user_required", message: "Authenticated user is required to create a job." });
    if (req.body?.approval_preview_confirmed !== true && req.body?.approvalPreviewConfirmed !== true) {
      const preview = await buildJobCandidateApprovalPreview({ businessId, candidateId, mode: "create_new" });
      return res.status(409).json({
        ok: false,
        error: "candidate_approval_preview_required",
        message: "Review and confirm candidate approval impact before approving this candidate.",
        preview,
      });
    }
    const result = await approveJobCandidateCreateNew({
      businessId,
      userId,
      candidateId,
      jobPayload: req.body?.job || req.body || {},
      mappingTypes: Array.isArray(req.body?.mapping_types || req.body?.mappingTypes) ? (req.body.mapping_types || req.body.mappingTypes) : [],
    });
    return res.json(result);
  } catch (e) {
    console.error("[job-costing.candidates-approve-new]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "job_candidate_approve_new_failed",
      message: e?.message || "Failed to create a job from that candidate.",
    });
  }
}

async function handleJobCandidateLinkExisting(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const candidateId = getCandidateId(req);
    const jobId = normalizePrompt(req.body?.job_id || req.body?.jobId);
    if (!candidateId || !jobId) {
      return res.status(400).json({ ok: false, error: "candidate_and_job_required", message: "candidate_id and job_id are required." });
    }
    if (req.body?.approval_preview_confirmed !== true && req.body?.approvalPreviewConfirmed !== true) {
      const preview = await buildJobCandidateApprovalPreview({ businessId, candidateId, mode: "link_existing", jobId });
      return res.status(409).json({
        ok: false,
        error: "candidate_approval_preview_required",
        message: "Review and confirm candidate approval impact before approving this candidate.",
        preview,
      });
    }
    const result = await linkJobCandidateToExisting({
      businessId,
      candidateId,
      jobId,
      mappingTypes: Array.isArray(req.body?.mapping_types || req.body?.mappingTypes) ? (req.body.mapping_types || req.body.mappingTypes) : [],
    });
    return res.json(result);
  } catch (e) {
    console.error("[job-costing.candidates-link-existing]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "job_candidate_link_failed",
      message: e?.message || "Failed to link that candidate to a job.",
    });
  }
}

async function handleJobRevertToCandidate(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const jobId = normalizePrompt(req.params.jobId || req.body?.job_id || req.body?.jobId);
    if (!jobId) return res.status(400).json({ ok: false, error: "job_required", message: "job_id is required." });
    const result = await revertCandidateCreatedJob({ businessId, jobId });
    const [summary, candidatesResult] = await Promise.all([
      fetchJobSummaries(businessId),
      supabase
        .from("job_candidates")
        .select("*", { count: "exact" })
        .eq("business_id", businessId)
        .order("confidence_score", { ascending: false })
        .order("updated_at", { ascending: false })
        .limit(250),
    ]);
    if (candidatesResult.error) throw candidatesResult.error;
    return res.json({
      ...result,
      jobs: summary,
      candidates: candidatesResult.data || [],
      total_count: Number.isFinite(Number(candidatesResult.count)) ? Number(candidatesResult.count) : (candidatesResult.data || []).length,
    });
  } catch (e) {
    console.error("[job-costing.jobs-revert-to-candidate]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "job_revert_to_candidate_failed",
      message: e?.message || "Failed to move that job back to Suggested Jobs.",
    });
  }
}

async function handleJobCandidateDismiss(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const candidateId = getCandidateId(req);
    if (!candidateId) return res.status(400).json({ ok: false, error: "candidate_required", message: "candidate_id is required." });
    const result = await dismissJobCandidate({
      businessId,
      candidateId,
      reason: normalizePrompt(req.body?.reason || req.body?.dismissal_reason || req.body?.dismissalReason) || null,
    });
    return res.json(result);
  } catch (e) {
    console.error("[job-costing.candidates-dismiss]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "job_candidate_dismiss_failed",
      message: e?.message || "Failed to dismiss that candidate.",
    });
  }
}

async function handleJobCandidatesMerge(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const result = await mergeJobCandidates({
      businessId,
      primaryCandidateId: normalizePrompt(req.body?.primary_candidate_id || req.body?.primaryCandidateId),
      candidateIds: Array.isArray(req.body?.candidate_ids || req.body?.candidateIds) ? (req.body.candidate_ids || req.body.candidateIds) : [],
    });
    return res.json(result);
  } catch (e) {
    console.error("[job-costing.candidates-merge]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "job_candidate_merge_failed",
      message: e?.message || "Failed to merge candidates.",
    });
  }
}

async function handleManualJobCreate(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const userId = getAuthenticatedUserId(req);
    if (!userId) return res.status(400).json({ ok: false, error: "user_required", message: "Authenticated user is required to create a job." });
    const result = await createManualJob({
      businessId,
      userId,
      jobPayload: req.body?.job || req.body || {},
      customerPayload: req.body?.customer || null,
    });
    return res.json(result);
  } catch (e) {
    console.error("[job-costing.manual-job-create]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "manual_job_create_failed",
      message: e?.message || "Failed to create the job.",
    });
  }
}

async function handleManualJobDelete(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const jobId = req.params?.jobId;
    if (!jobId) return res.status(400).json({ ok: false, error: "job_id_required", message: "Job ID is required." });
    const result = await deleteManualJob({ businessId, jobId });
    const refreshed = await fetchJobCostingRows(businessId);
    return res.json({ ...result, ...refreshed });
  } catch (e) {
    console.error("[job-costing.manual-job-delete]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "manual_job_delete_failed",
      message: e?.message || "Failed to delete the job.",
    });
  }
}

router.get("/assignment-history", requireRouteAuth, handleAssignmentHistory);
router.post("/assignment-preview", requireRouteAuth, handleAssignmentPreview);
router.post("/assignments/confirm", requireRouteAuth, handleAssignmentConfirm);
router.get("/assignments", requireRouteAuth, handleAssignmentsGet);
router.post("/assignments", requireRouteAuth, handleAssignmentCreate);
router.delete("/assignments/:assignmentId", requireRouteAuth, handleAssignmentDelete);
router.post("/assignments/manual", requireRouteAuth, handleManualAssignment);
router.get("/job-costing/assignment-history", requireRouteAuth, handleAssignmentHistory);
router.post("/job-costing/assignment-preview", requireRouteAuth, handleAssignmentPreview);
router.post("/job-costing/assignments/confirm", requireRouteAuth, handleAssignmentConfirm);
router.get("/job-costing/assignments", requireRouteAuth, handleAssignmentsGet);
router.post("/job-costing/assignments", requireRouteAuth, handleAssignmentCreate);
router.delete("/job-costing/assignments/:assignmentId", requireRouteAuth, handleAssignmentDelete);
router.post("/job-costing/assignments/manual", requireRouteAuth, handleManualAssignment);
router.get("/jobs/summary", requireRouteAuth, handleJobsSummary);
router.get("/job-costing/jobs/summary", requireRouteAuth, handleJobsSummary);
router.get("/jobs/:jobId/financial-summary", requireRouteAuth, handleJobFinancialSummary);
router.get("/job-costing/jobs/:jobId/financial-summary", requireRouteAuth, handleJobFinancialSummary);
router.get("/revenue-documents", requireRouteAuth, handleRevenueDocumentsGet);
router.post("/revenue-documents", requireRouteAuth, handleRevenueDocumentsPost);
router.get("/job-costing/revenue-documents", requireRouteAuth, handleRevenueDocumentsGet);
router.post("/job-costing/revenue-documents", requireRouteAuth, handleRevenueDocumentsPost);
router.get("/payments", requireRouteAuth, handlePaymentsGet);
router.post("/payments", requireRouteAuth, handlePaymentAllocationPost);
router.get("/job-costing/payments", requireRouteAuth, handlePaymentsGet);
router.post("/job-costing/payments", requireRouteAuth, handlePaymentAllocationPost);
router.get("/revenue-evidence", requireRouteAuth, handleRevenueEvidenceGet);
router.get("/job-costing/revenue-evidence", requireRouteAuth, handleRevenueEvidenceGet);
router.post("/assignment-impact-preview", requireRouteAuth, handleAssignmentImpactPreview);
router.post("/job-costing/assignment-impact-preview", requireRouteAuth, handleAssignmentImpactPreview);
router.post("/assignment-resolution/confirm", requireRouteAuth, handleAssignmentResolutionConfirm);
router.post("/job-costing/assignment-resolution/confirm", requireRouteAuth, handleAssignmentResolutionConfirm);
router.post("/jobs/:jobId/complete", requireRouteAuth, handleJobComplete);
router.post("/job-costing/jobs/:jobId/complete", requireRouteAuth, handleJobComplete);
router.post("/jobs/:jobId/reopen", requireRouteAuth, handleJobReopen);
router.post("/job-costing/jobs/:jobId/reopen", requireRouteAuth, handleJobReopen);
router.post("/jobs/:jobId/revert-to-candidate", requireRouteAuth, handleJobRevertToCandidate);
router.post("/job-costing/jobs/:jobId/revert-to-candidate", requireRouteAuth, handleJobRevertToCandidate);
router.get("/job-candidates", requireRouteAuth, handleJobCandidatesGet);
router.get("/job-costing/job-candidates", requireRouteAuth, handleJobCandidatesGet);
router.post("/job-candidates/generate", requireRouteAuth, highCostJobRouteRateLimit, handleJobCandidatesGenerate);
router.post("/job-costing/job-candidates/generate", requireRouteAuth, highCostJobRouteRateLimit, handleJobCandidatesGenerate);
router.post("/job-candidates/:candidateId/approve-new", requireRouteAuth, handleJobCandidateApproveNew);
router.post("/job-costing/job-candidates/:candidateId/approve-new", requireRouteAuth, handleJobCandidateApproveNew);
router.post("/job-candidates/:candidateId/approval-preview", requireRouteAuth, handleJobCandidateApprovalPreview);
router.post("/job-costing/job-candidates/:candidateId/approval-preview", requireRouteAuth, handleJobCandidateApprovalPreview);
router.post("/job-candidates/:candidateId/link-existing", requireRouteAuth, handleJobCandidateLinkExisting);
router.post("/job-costing/job-candidates/:candidateId/link-existing", requireRouteAuth, handleJobCandidateLinkExisting);
router.post("/job-candidates/:candidateId/dismiss", requireRouteAuth, handleJobCandidateDismiss);
router.post("/job-costing/job-candidates/:candidateId/dismiss", requireRouteAuth, handleJobCandidateDismiss);
router.post("/job-candidates/merge", requireRouteAuth, handleJobCandidatesMerge);
router.post("/job-costing/job-candidates/merge", requireRouteAuth, handleJobCandidatesMerge);
router.post("/jobs/manual", requireRouteAuth, handleManualJobCreate);
router.post("/job-costing/jobs/manual", requireRouteAuth, handleManualJobCreate);
router.delete("/jobs/:jobId/manual", requireRouteAuth, handleManualJobDelete);
router.delete("/job-costing/jobs/:jobId/manual", requireRouteAuth, handleManualJobDelete);
router.post("/qbo/job-costing/sync", requireRouteAuth, highCostJobRouteRateLimit, handleQboJobCostingSync);
router.post("/job-costing/qbo/sync", requireRouteAuth, highCostJobRouteRateLimit, handleQboJobCostingSync);
router.post("/qbo/job-costing/backfill", requireRouteAuth, highCostJobRouteRateLimit, handleQboJobCostingSync);
router.post("/job-costing/qbo/backfill", requireRouteAuth, highCostJobRouteRateLimit, handleQboJobCostingSync);
router.post("/qbo/job-costing/backfill/run", requireRouteAuth, highCostJobRouteRateLimit, handleQboBackfillRun);
router.post("/job-costing/qbo/backfill/run", requireRouteAuth, highCostJobRouteRateLimit, handleQboBackfillRun);
router.post("/qbo/job-costing/webhooks/process", requireRouteAuth, highCostJobRouteRateLimit, handleQboWebhookQueueProcess);
router.post("/job-costing/qbo/webhooks/process", requireRouteAuth, highCostJobRouteRateLimit, handleQboWebhookQueueProcess);
router.post("/qbo/job-costing/cdc", requireRouteAuth, highCostJobRouteRateLimit, handleQboCdcSync);
router.post("/job-costing/qbo/cdc", requireRouteAuth, highCostJobRouteRateLimit, handleQboCdcSync);
router.post("/qbo/job-costing/daily-reconciliation", requireRouteAuth, highCostJobRouteRateLimit, handleQboDailyReconciliation);
router.post("/job-costing/qbo/daily-reconciliation", requireRouteAuth, highCostJobRouteRateLimit, handleQboDailyReconciliation);
router.get("/qbo/job-costing/sync/diagnostics", requireRouteAuth, handleQboJobCostingDiagnostics);
router.get("/job-costing/qbo/sync/diagnostics", requireRouteAuth, handleQboJobCostingDiagnostics);
router.get("/qbo/projects/capability", requireRouteAuth, handleQboProjectsCapabilityRead);
router.get("/job-costing/qbo/projects/capability", requireRouteAuth, handleQboProjectsCapabilityRead);
router.get("/qbo/job-costing/projects/capability", requireRouteAuth, handleQboProjectsCapabilityRead);
router.post("/qbo/job-costing/projects/capability", requireRouteAuth, handleQboProjectsCapabilityCheck);
router.post("/job-costing/qbo/projects/capability", requireRouteAuth, handleQboProjectsCapabilityCheck);
router.post("/qbo/job-costing/projects/sync", requireRouteAuth, highCostJobRouteRateLimit, handleQboProjectsSync);
router.post("/job-costing/qbo/projects/sync", requireRouteAuth, highCostJobRouteRateLimit, handleQboProjectsSync);
router.post("/jobs/:jobId/qbo/project", requireRouteAuth, handleQboProjectCreateForJob);
router.post("/job-costing/jobs/:jobId/qbo/project", requireRouteAuth, handleQboProjectCreateForJob);

async function handleSuggestionsGenerate(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const result = await generateJobAssignmentSuggestionsForBusiness(businessId, {
      date_range: req.body?.date_range,
      dateRange: req.body?.dateRange,
      limit: req.body?.limit,
      min_confidence: req.body?.min_confidence,
      minConfidence: req.body?.minConfidence,
    });
    return res.json({
      ok: true,
      created: result.createdCount ?? 0,
      updated: result.updatedCount ?? 0,
      expired: result.expiredCount ?? 0,
      suggestions: result.suggestions || [],
    });
  } catch (e) {
    console.error("[job-costing.suggestions.generate]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "suggestions_generate_failed",
      message: e?.status && e?.message ? e.message : "Failed to generate job assignment suggestions.",
    });
  }
}

async function handleSuggestionsGet(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const suggestions = await fetchPendingJobAssignmentSuggestions(businessId, {
      status: req.query.status || "pending",
      minConfidence: req.query.min_confidence || req.query.minConfidence || 60,
      limit: req.query.limit || 50,
    });
    return res.json({ ok: true, suggestions });
  } catch (e) {
    console.error("[job-costing.suggestions]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "suggestions_failed",
      message: e?.status && e?.message ? e.message : "Failed to load suggestions.",
    });
  }
}

async function handleSuggestionApprove(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const id = req.params.id;
    const suggestion = await fetchSuggestionOrThrow(businessId, id);
    const suggestedJobId = suggestion.suggested_job_id || suggestion.job_id;
    const now = new Date().toISOString();
    const { assignment } = await savePostedTransactionAssignment({
      businessId,
      jobId: suggestedJobId,
      transactionId: suggestion.transaction_id,
      source: "ai_suggestion",
      notes: getSuggestionReasoningSummary(suggestion),
      replaceExistingForTransaction: false,
    });
    const savedStatus = await markSuggestionStatus({
      businessId,
      id,
      status: "approved",
      now,
      acceptedAssignmentId: assignment?.id || null,
    });
    await recordSuggestionAssignmentHistory({
      businessId,
      suggestion,
      assignment,
      source: "ai_suggestion",
    });
    const [refreshed, jobSummary] = await Promise.all([
      fetchJobCostingRows(businessId),
      fetchJobSummaries(businessId),
    ]);
    triggerContractorCfoInsightsBestEffort({
      businessId,
      trigger: "job_costing",
      force: false,
    });
    return res.json({
      ok: true,
      message: "Suggestion approved and assigned.",
      suggestion: { ...suggestion, status: savedStatus, accepted_assignment_id: assignment?.id || null },
      assignment,
      job_summary: jobSummary,
      ...refreshed,
    });
  } catch (e) {
    console.error("[job-costing.suggestions.approve]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "suggestion_approve_failed",
      message: e?.status && e?.message ? e.message : "Failed to approve suggestion.",
    });
  }
}

async function handleSuggestionReject(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const id = req.params.id;
    const suggestion = await fetchSuggestionOrThrow(businessId, id);
    const now = new Date().toISOString();
    const feedback = normalizePrompt(req.body?.feedback || req.body?.user_feedback || "");
    const requestedStatus = req.body?.status === "ignored" ? "ignored" : "rejected";
    const savedStatus = await markSuggestionStatus({
      businessId,
      id,
      status: requestedStatus,
      now,
      feedback,
    });
    await recordSuggestionAssignmentHistory({
      businessId,
      suggestion,
      feedback: feedback || savedStatus,
      source: "ai_suggestion_rejected",
    });
    return res.json({ ok: true, message: "Suggestion rejected.", suggestion: { ...suggestion, status: savedStatus, user_feedback: feedback || null } });
  } catch (e) {
    console.error("[job-costing.suggestions.reject]", e);
    res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || "suggestion_reject_failed",
      message: e?.status && e?.message ? e.message : "Failed to reject suggestion.",
    });
  }
}

router.post("/suggestions/generate", requireRouteAuth, highCostJobRouteRateLimit, handleSuggestionsGenerate);
router.get("/suggestions", requireRouteAuth, handleSuggestionsGet);
router.post("/suggestions/:id/approve", requireRouteAuth, handleSuggestionApprove);
router.post("/suggestions/:id/accept", requireRouteAuth, handleSuggestionApprove);
router.post("/suggestions/:id/reject", requireRouteAuth, handleSuggestionReject);
router.post("/job-costing/suggestions/generate", requireRouteAuth, highCostJobRouteRateLimit, handleSuggestionsGenerate);
router.get("/job-costing/suggestions", requireRouteAuth, handleSuggestionsGet);
router.post("/job-costing/suggestions/:id/approve", requireRouteAuth, handleSuggestionApprove);
router.post("/job-costing/suggestions/:id/accept", requireRouteAuth, handleSuggestionApprove);
router.post("/job-costing/suggestions/:id/reject", requireRouteAuth, handleSuggestionReject);

async function handleMarginTargetsGet(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const targets = await fetchMarginTargets(businessId);
    return res.json({ ok: true, default_target_margin_percent: DEFAULT_MARGIN_TARGET, targets });
  } catch (e) {
    console.error("[job-costing.margin-targets]", e);
    res.status(e?.status || 500).json({ ok: false, error: "margin_targets_failed", message: e?.message || "Failed to load margin targets." });
  }
}

async function handleMarginTargetsPut(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const rawTargets = Array.isArray(req.body?.targets) ? req.body.targets : [req.body || {}];
    const now = new Date().toISOString();
    const payload = rawTargets
      .map((target) => ({
        business_id: businessId,
        trade_type: normalizePrompt(target.trade_type || target.tradeType),
        target_margin_percent: Number(target.target_margin_percent ?? target.targetMarginPercent),
        updated_at: now,
      }))
      .filter((target) => target.trade_type && Number.isFinite(target.target_margin_percent));
    if (!payload.length) return res.status(400).json({ ok: false, error: "invalid_targets", message: "Trade type and target margin are required." });

    const { error } = await supabase
      .from("job_margin_targets")
      .upsert(payload, { onConflict: "business_id,trade_type" });
    if (error) {
      if (isMissingTableError(error)) {
        return res.status(501).json({ ok: false, error: "margin_targets_table_missing", message: "job_margin_targets table does not exist." });
      }
      throw error;
    }
    const targets = await fetchMarginTargets(businessId);
    return res.json({ ok: true, default_target_margin_percent: DEFAULT_MARGIN_TARGET, targets });
  } catch (e) {
    console.error("[job-costing.margin-targets.save]", e);
    res.status(e?.status || 500).json({ ok: false, error: "margin_targets_save_failed", message: e?.message || "Failed to save margin target." });
  }
}

async function handleMarginInsights(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const [payload, targets] = await Promise.all([
      fetchJobCostingRows(businessId),
      fetchMarginTargets(businessId),
    ]);
    return res.json({ ok: true, insights: buildMarginInsights(payload.jobs || [], targets) });
  } catch (e) {
    console.error("[job-costing.insights]", e);
    res.status(e?.status || 500).json({ ok: false, error: "margin_insights_failed", message: e?.message || "Failed to load margin insights." });
  }
}

router.get("/margin-targets", requireRouteAuth, handleMarginTargetsGet);
router.put("/margin-targets", requireRouteAuth, handleMarginTargetsPut);
router.get("/insights", requireRouteAuth, handleMarginInsights);
router.get("/job-costing/margin-targets", requireRouteAuth, handleMarginTargetsGet);
router.put("/job-costing/margin-targets", requireRouteAuth, handleMarginTargetsPut);
router.get("/job-costing/insights", requireRouteAuth, handleMarginInsights);

async function ensureJobBelongsToBusiness(businessId, jobId) {
  const { data, error } = await supabase
    .from("jobs")
    .select("id")
    .eq("business_id", businessId)
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const e = new Error("Job not found.");
    e.status = 404;
    e.code = "job_not_found";
    throw e;
  }
  return data;
}

async function handleChangeOrdersGet(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const jobId = req.params.jobId;
    await ensureJobBelongsToBusiness(businessId, jobId);
    const changeOrders = await fetchChangeOrders(businessId, [jobId]);
    return res.json({ ok: true, change_orders: changeOrders });
  } catch (e) {
    console.error("[job-costing.change-orders]", e);
    res.status(e?.status || 500).json({ ok: false, error: e?.code || "change_orders_failed", message: e?.message || "Failed to load change orders." });
  }
}

async function handleChangeOrdersPost(req, res) {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const jobId = req.params.jobId;
    await ensureJobBelongsToBusiness(businessId, jobId);
    const description = normalizePrompt(req.body?.description);
    const changeOrderDate = normalizePrompt(req.body?.change_order_date || req.body?.date);
    const additionalRevenue = Number(req.body?.additional_revenue ?? req.body?.additionalRevenue ?? 0);
    const additionalCost = Number(req.body?.additional_cost ?? req.body?.additionalCost ?? 0);
    const notes = normalizePrompt(req.body?.notes);

    if (!description) return res.status(400).json({ ok: false, error: "description_required", message: "Description is required." });
    if (!changeOrderDate || Number.isNaN(Date.parse(changeOrderDate))) return res.status(400).json({ ok: false, error: "date_required", message: "Date is required." });
    if (!Number.isFinite(additionalRevenue) || additionalRevenue < 0 || !Number.isFinite(additionalCost) || additionalCost < 0) {
      return res.status(400).json({ ok: false, error: "invalid_amounts", message: "Revenue and cost must be numeric and at least 0." });
    }

    const now = new Date().toISOString();
    const payload = {
      business_id: businessId,
      job_id: jobId,
      description,
      additional_revenue: additionalRevenue,
      additional_cost: additionalCost,
      change_order_date: new Date(changeOrderDate).toISOString().slice(0, 10),
      notes,
      created_at: now,
      updated_at: now,
    };
    const { data, error } = await supabase
      .from("job_change_orders")
      .insert(payload)
      .select("*")
      .single();
    if (error) throw error;
    const refreshed = await fetchJobCostingRows(businessId);
    return res.json({ ok: true, message: "Change order logged.", change_order: data, ...refreshed });
  } catch (e) {
    console.error("[job-costing.change-orders.create]", e);
    res.status(e?.status || 500).json({ ok: false, error: e?.code || "change_order_create_failed", message: e?.message || "Failed to log change order." });
  }
}

router.get("/jobs/:jobId/change-orders", requireRouteAuth, handleChangeOrdersGet);
router.post("/jobs/:jobId/change-orders", requireRouteAuth, handleChangeOrdersPost);
router.get("/job-costing/jobs/:jobId/change-orders", requireRouteAuth, handleChangeOrdersGet);
router.post("/job-costing/jobs/:jobId/change-orders", requireRouteAuth, handleChangeOrdersPost);

router.post("/job-costing/assign-natural-language", requireRouteAuth, highCostJobRouteRateLimit, async (req, res) => {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const prompt = normalizePrompt(req.body?.prompt);
    if (!prompt) return res.status(400).json({ ok: false, error: "prompt required" });

    const parsed = parseAssignmentPrompt(prompt);
    if (!parsed.jobName || !parsed.vendorText) {
      return res.status(400).json({
        ok: false,
        error: "assignment_prompt_unclear",
        message: "Try: Assign all Amazon expenses this month to the Johnson job.",
      });
    }

    const jobNeedle = normalizeNeedle(parsed.jobName);
    const { data: jobs, error: jobsErr } = await supabase
      .from("jobs")
      .select("*")
      .eq("business_id", businessId)
      .limit(200);
    if (jobsErr) throw jobsErr;

    const matchedJob = (jobs || []).filter((job) => !isCompletedJobStatus(job.status || job.stage)).find((job) => {
      const name = getJobName(job);
      return normalizeNeedle(name).includes(jobNeedle) || jobNeedle.includes(normalizeNeedle(name));
    });
    if (!matchedJob) {
      return res.status(404).json({ ok: false, error: "job_not_found", message: `No job matched "${parsed.jobName}".` });
    }

    // Job Costing uses posted Books transactions as the source of truth.
    const { rows: postedRows } = await fetchBookkeepingTransactions({
      businessId,
      statusFilter: "posted",
      rangeParam: "all",
      page: 1,
      pageSize: 500,
    });
    const txns = (postedRows || []).map(normalizePostedBookTransaction).filter((txn) => {
      const txnDate = txn.date ? new Date(txn.date) : null;
      if (parsed.startDate && txnDate && txnDate < new Date(parsed.startDate)) return false;
      if (parsed.endDate && txnDate && txnDate > new Date(parsed.endDate)) return false;
      return true;
    });

    const vendorNeedle = normalizeNeedle(parsed.vendorText);
    const matches = (txns || []).filter((txn) => {
      const haystack = transactionHaystack(txn);
      const isExpense = (txn.direction || "").toUpperCase() === "OUTFLOW" || Number(txn.amount || 0) < 0;
      return isExpense && haystack.includes(vendorNeedle);
    });

    if (!matches.length) {
      return res.json({ ok: true, assigned: 0, message: "No matching expense transactions found.", parsed });
    }

    const transactionIds = matches.map((txn) => txn.id).filter(Boolean);
    if (transactionIds.length) {
      const { error: deleteErr } = await supabase
        .from("job_transaction_assignments")
        .delete()
        .eq("business_id", businessId)
        .in("transaction_id", transactionIds);
      if (deleteErr) throw deleteErr;
    }
    for (const txn of matches) {
      const { assignment } = await savePostedTransactionAssignment({
        businessId,
        jobId: matchedJob.id,
        transactionId: txn.id,
        source: "natural_language",
        notes: prompt,
        replaceExistingForTransaction: false,
      });
      await recordJobAssignmentHistory({
        businessId,
        transactionId: txn.id,
        jobId: matchedJob.id,
        assignmentId: assignment?.id || null,
        source: "natural_language",
        methodUsed: ["natural_language"],
      });
    }

    const refreshed = await fetchJobCostingRows(businessId);
    return res.json({
      ok: true,
      assigned: matches.length,
      job: matchedJob,
      parsed,
      ...refreshed,
    });
  } catch (e) {
    console.error("[jobs.job-costing.assign]", e);
    res.status(500).json({ ok: false, error: "job_costing_assign_failed", message: e?.message || "failed" });
  }
});

/* ---------- Sync stubs ---------- */
router.post("/integrations/jobber/sync", async (_req, res) => {
  // TODO: call Jobber API, transform with mapJobberToBusyStatus, upsert into jobs + job_events
  res.json({ ok: true, message: "jobber sync stub" });
});

router.post("/integrations/housecall/sync", async (_req, res) => {
  // TODO: call Housecall Pro API + normalize pipeline/events
  res.json({ ok: true, message: "housecall sync stub" });
});

router.post("/integrations/qbo/sync", async (_req, res) => {
  // TODO: fetch QBO invoices w/ JobID in CustomField/Memo, aggregate to jobs
  res.json({ ok: true, message: "qbo sync stub" });
});

export default router;
