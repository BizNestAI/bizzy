import { supabase } from "../supabaseAdmin.js";
import {
  fetchBookkeepingTransactions,
  normalizePostedBookTransaction,
} from "../../api/bookkeeping/routes/bookkeeping.transactions.routes.js";

const MIN_CONFIDENCE = 60;
const HIGH_CONFIDENCE = 80;
const ACTIVE_JOB_PATTERN = /active|progress|scheduled|open/i;

function getDateRangeBounds(value) {
  const key = String(value || "all").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const now = new Date();
  const start = new Date(now);
  if (key === "this_month") {
    return { startDate: new Date(now.getFullYear(), now.getMonth(), 1), endDate: null };
  }
  if (key === "last_30_days") {
    start.setDate(start.getDate() - 30);
    return { startDate: start, endDate: null };
  }
  if (key === "last_90_days") {
    start.setDate(start.getDate() - 90);
    return { startDate: start, endDate: null };
  }
  return { startDate: null, endDate: null };
}

function dateInRange(dateValue, dateRange) {
  if (!dateRange?.startDate && !dateRange?.endDate) return true;
  if (!dateValue) return false;
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return false;
  if (dateRange.startDate && date < dateRange.startDate) return false;
  if (dateRange.endDate && date > dateRange.endDate) return false;
  return true;
}

export function normalizeVendorName(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(inc|llc|ltd|co|company|corp|corporation|the|store|stores)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getJobName(job = {}) {
  return job.name || job.job_name || job.project_name || job.customer_name || job.display_name || "Untitled Job";
}

function getTransactionVendor(transaction = {}) {
  return transaction.vendor || transaction.payee || transaction.counterparty_name || transaction.merchant_name || transaction.name || "";
}

function getTransactionDescription(transaction = {}) {
  return transaction.description || transaction.name || transaction.memo || "";
}

function getTransactionAccount(transaction = {}) {
  return transaction.final_qbo_account_name || transaction.gl_account || transaction.glAccountName || transaction.suggestedAccountName || "";
}

function toNumber(value, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function isMissingTableError(error) {
  return error?.code === "42P01" || /does not exist|schema cache|Could not find/i.test(error?.message || "");
}

async function safeSelect(query, fallback = []) {
  const { data, error } = await query;
  if (error) {
    if (isMissingTableError(error)) return fallback;
    throw error;
  }
  return data || fallback;
}

export function haversineMiles(lat1, lon1, lat2, lon2) {
  const values = [lat1, lon1, lat2, lon2].map(Number);
  if (values.some((value) => !Number.isFinite(value))) return null;
  const [aLat, aLon, bLat, bLon] = values.map((value) => (value * Math.PI) / 180);
  const dLat = bLat - aLat;
  const dLon = bLon - aLon;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat) * Math.cos(bLat) * Math.sin(dLon / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getTransactionVendorCandidates(transaction = {}) {
  return [
    transaction.counterparty_name,
    transaction.merchant_name,
    transaction.name,
    transaction.vendor,
    transaction.payee,
  ]
    .map(normalizeVendorName)
    .filter(Boolean);
}

export async function getVendorLocationForTransaction(businessId, transaction = {}) {
  if (!businessId) return null;
  const vendorNames = Array.from(new Set(getTransactionVendorCandidates(transaction)));
  if (!vendorNames.length) return null;
  const { data, error } = await supabase
    .from("vendor_locations")
    .select("*")
    .eq("business_id", businessId)
    .in("normalized_vendor_name", vendorNames)
    .limit(1)
    .maybeSingle();
  if (error) {
    if (isMissingTableError(error)) return null;
    throw error;
  }
  return data || null;
}

export function getJobLocation(job = {}) {
  const latitude = Number(job.latitude);
  const longitude = Number(job.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
}

function groupBy(rows, keyFn) {
  return (rows || []).reduce((acc, row) => {
    const key = keyFn(row);
    if (!key) return acc;
    if (!acc[key]) acc[key] = [];
    acc[key].push(row);
    return acc;
  }, {});
}

function getAssignedPercentByTransaction(assignments = []) {
  return assignments.reduce((acc, row) => {
    const key = String(row.transaction_id);
    acc[key] = (acc[key] || 0) + toNumber(row.allocation_percent, 100);
    return acc;
  }, {});
}

function getSuggestionJobId(row = {}) {
  return row.suggested_job_id || row.job_id || null;
}

function getConfidenceLabel(score) {
  return score >= HIGH_CONFIDENCE ? "high" : "medium";
}

function buildSummary(parts, finalScore, label) {
  const active = [
    parts.historical?.explanation,
    parts.proximity?.explanation,
    parts.employee?.explanation,
    parts.clustering?.explanation,
  ].filter((item) => item && !/^No /.test(item));
  if (active.length) return `${label} confidence: ${active.slice(0, 2).join(" ")}`;
  return `${label} confidence deterministic job assignment suggestion.`;
}

export function buildSuggestionReasoning({ historical, proximity, employee, clustering, finalScore }) {
  const confidenceLabel = getConfidenceLabel(finalScore);
  const reasoning = {
    historical,
    proximity,
    employee,
    clustering,
    final_score: finalScore,
    confidence_label: confidenceLabel,
  };
  reasoning.summary = buildSummary(reasoning, finalScore, confidenceLabel);
  return reasoning;
}

function scoreHistoricalPattern({ transaction, job, historicalByVendor }) {
  const vendor = normalizeVendorName(getTransactionVendor(transaction));
  const rows = historicalByVendor[vendor] || [];
  if (!vendor || !rows.length) {
    return { score: 0, explanation: "No historical vendor assignment pattern." };
  }
  const total = rows.length;
  const jobHits = rows.filter((row) => String(row.job_id) === String(job.id)).length;
  const ratio = total ? jobHits / total : 0;
  const score = Math.round(Math.min(45, ratio * 45));
  return {
    score,
    explanation: score > 0
      ? `${getTransactionVendor(transaction)} was assigned to ${getJobName(job)} ${jobHits}/${total} historical times.`
      : `Historical assignments for ${getTransactionVendor(transaction)} point to other jobs.`,
  };
}

function scoreVendorProximity({ transaction, job, vendorLocationByName }) {
  const vendorNames = getTransactionVendorCandidates(transaction);
  const location = vendorNames.map((name) => vendorLocationByName[name]?.[0]).find(Boolean);
  const jobLocation = getJobLocation(job);
  const distance = location && jobLocation
    ? haversineMiles(location.latitude, location.longitude, jobLocation.latitude, jobLocation.longitude)
    : null;
  if (distance === null) {
    return { score: 0, explanation: "Vendor or job latitude/longitude unavailable for proximity scoring.", distance_miles: null };
  }
  let score = 0;
  if (distance <= 5) score = 20;
  else if (distance <= 15) score = 16;
  return {
    score,
    explanation: score > 0
      ? `Vendor location is ${distance.toFixed(1)} miles from job site.`
      : `Vendor location is ${distance.toFixed(1)} miles from job site, outside the proximity scoring range.`,
    distance_miles: Number(distance.toFixed(2)),
  };
}

export function extractEmployeeSignalFromTransaction(transaction = {}) {
  const raw = transaction.raw || transaction.meta || transaction.metadata || {};
  const idValues = [
    transaction.employee_id,
    transaction.employeeId,
    raw.employee_id,
    raw.employeeId,
    raw.employee_external_id,
    raw.employeeExternalId,
  ].filter(Boolean);
  const nameValues = [
    transaction.cardholder_name,
    transaction.cardholderName,
    transaction.memo,
    transaction.description,
    raw.cardholder_name,
    raw.cardholderName,
    raw.memo,
    raw.employee_name,
    raw.employeeName,
    transaction.counterparty_name,
    transaction.merchant_name,
    transaction.name,
  ].filter(Boolean);
  return {
    employeeIds: Array.from(new Set(idValues.map((value) => String(value).trim()).filter(Boolean))),
    textSignals: Array.from(new Set(nameValues.map((value) => normalizeText(value)).filter(Boolean))),
  };
}

function isActiveJob(job = {}) {
  return ACTIVE_JOB_PATTERN.test(String(job.status || "active"));
}

function scoreEmployeeMatch({ transaction, job, jobEmployeeRows, employeesById, jobsById }) {
  const signals = extractEmployeeSignalFromTransaction(transaction);
  if (!signals.employeeIds.length && !signals.textSignals.length) return { score: 0, explanation: "No employee or crew signal on transaction." };
  const assignedRows = jobEmployeeRows.filter((row) => String(row.job_id) === String(job.id));
  for (const row of assignedRows) {
    const employee = employeesById[String(row.employee_id)] || {};
    const exactEmployeeIds = [
      row.employee_id,
      employee.id,
      employee.external_id,
    ].map((value) => String(value || "").trim()).filter(Boolean);
    const employeeSignals = [
      employee.name,
      employee.email,
      employee.phone,
    ].map((value) => normalizeText(value)).filter(Boolean);
    const exactMatch = signals.employeeIds.some((signal) => exactEmployeeIds.includes(signal));
    const textMatch = signals.textSignals.some((signal) => employeeSignals.some((employeeSignal) => signal.includes(employeeSignal) || employeeSignal.includes(signal)));
    if (exactMatch || textMatch) {
      const employeeJobRows = jobEmployeeRows.filter((candidate) => String(candidate.employee_id) === String(row.employee_id));
      const activeJobCount = employeeJobRows.filter((candidate) => isActiveJob(jobsById[String(candidate.job_id)] || {})).length || employeeJobRows.length || 1;
      const baseScore = exactMatch ? 20 : 14;
      const score = activeJobCount > 1 ? Math.max(exactMatch ? 14 : 10, Math.round(baseScore / Math.min(activeJobCount, 3))) : baseScore;
      return {
        score,
        explanation: activeJobCount > 1
          ? `Employee/crew match: transaction appears tied to ${employee.name || row.employee_id}, assigned to ${activeJobCount} active jobs including ${getJobName(job)}.`
          : `Employee/crew match: transaction appears tied to ${employee.name || row.employee_id}, assigned to ${getJobName(job)}.`,
      };
    }
  }
  return { score: 0, explanation: "Employee signal did not match this job's crew." };
}

function scoreDescriptionClustering({ transaction, job, priorAssignedRows }) {
  const vendor = normalizeVendorName(getTransactionVendor(transaction));
  const description = normalizeText(getTransactionDescription(transaction));
  const account = normalizeText(getTransactionAccount(transaction));
  const amount = Math.abs(toNumber(transaction.amount));
  const candidates = priorAssignedRows.filter((row) => String(row.job_id) === String(job.id));
  let best = 0;
  for (const row of candidates) {
    const prior = row.transaction || {};
    const priorVendor = normalizeVendorName(getTransactionVendor(prior));
    const priorDescription = normalizeText(getTransactionDescription(prior));
    const priorAccount = normalizeText(getTransactionAccount(prior));
    const priorAmount = Math.abs(toNumber(row.allocated_amount ?? prior.amount));
    const amountDelta = priorAmount > 0 ? Math.abs(priorAmount - amount) / priorAmount : 1;
    let score = 0;
    if (vendor && vendor === priorVendor) score += 6;
    if (account && account === priorAccount) score += 4;
    if (amount > 0 && amountDelta <= 0.2) score += 3;
    if (description && priorDescription && (description.includes(priorDescription) || priorDescription.includes(description))) score += 2;
    best = Math.max(best, score);
  }
  return {
    score: Math.min(15, best),
    explanation: best > 0
      ? "Similar vendor, GL account, description, or amount appeared in prior assignments for this job."
      : "No similar prior assigned transaction cluster for this job.",
  };
}

export async function scoreTransactionAgainstJob({ businessId, transaction, job, context = null }) {
  const scoringContext = context || await buildScoringContext(businessId);
  const historical = scoreHistoricalPattern({ transaction, job, historicalByVendor: scoringContext.historicalByVendor });
  const proximity = scoreVendorProximity({ transaction, job, vendorLocationByName: scoringContext.vendorLocationByName });
  const employee = scoreEmployeeMatch({
    transaction,
    job,
    jobEmployeeRows: scoringContext.jobEmployeeRows,
    employeesById: scoringContext.employeesById,
    jobsById: scoringContext.jobsById,
  });
  const clustering = scoreDescriptionClustering({
    transaction,
    job,
    priorAssignedRows: scoringContext.priorAssignedRows,
  });
  const finalScore = Math.min(100, historical.score + proximity.score + employee.score + clustering.score);
  const reasoning = buildSuggestionReasoning({ historical, proximity, employee, clustering, finalScore });
  return {
    score: finalScore,
    confidence_score: finalScore,
    confidence_label: reasoning.confidence_label,
    reasoning,
  };
}

async function fetchPostedTransactions(businessId, pageSize) {
  // Job Costing suggestions use the same posted Books transactions as Books Review > Posted.
  const { rows } = await fetchBookkeepingTransactions({
    businessId,
    statusFilter: "posted",
    rangeParam: "all",
    page: 1,
    pageSize,
  });
  return (rows || []).map(normalizePostedBookTransaction);
}

async function buildScoringContext(businessId, options = {}) {
  const pageSize = options.pageSize || 500;
  const [jobs, postedTransactions, assignments, assignmentHistory, vendorLocations, employees, jobEmployeeRows] = await Promise.all([
    safeSelect(supabase.from("jobs").select("*").eq("business_id", businessId).limit(300)),
    fetchPostedTransactions(businessId, pageSize),
    safeSelect(supabase.from("job_transaction_assignments").select("*").eq("business_id", businessId)),
    safeSelect(supabase.from("assignment_history").select("*").eq("business_id", businessId).order("created_at", { ascending: false }).limit(1000)),
    safeSelect(supabase.from("vendor_locations").select("*").eq("business_id", businessId)),
    safeSelect(supabase.from("employees").select("*").eq("business_id", businessId)),
    safeSelect(supabase.from("job_employees").select("*").eq("business_id", businessId)),
  ]);
  const postedById = postedTransactions.reduce((acc, transaction) => {
    acc[String(transaction.id)] = transaction;
    return acc;
  }, {});
  const assignmentsWithTransactions = assignments.map((assignment) => ({
    ...assignment,
    transaction: postedById[String(assignment.transaction_id)] || {},
  }));
  const historyWithTransactions = assignmentHistory.map((history) => ({
    ...history,
    transaction: postedById[String(history.transaction_id)] || {},
  }));
  const historicalRows = [...assignmentsWithTransactions, ...historyWithTransactions].filter((row) => row.transaction_id && row.job_id);
  const historicalByVendor = groupBy(historicalRows, (row) => normalizeVendorName(getTransactionVendor(row.transaction)));
  return {
    jobs,
    jobsById: jobs.reduce((acc, job) => {
      acc[String(job.id)] = job;
      return acc;
    }, {}),
    postedTransactions,
    assignments,
    assignmentHistory,
    assignedPercentByTransaction: getAssignedPercentByTransaction(assignments),
    vendorLocationByName: groupBy(vendorLocations, (row) => row.normalized_vendor_name || normalizeVendorName(row.vendor_name)),
    employeesById: employees.reduce((acc, employee) => {
      acc[String(employee.id)] = employee;
      if (employee.external_id) acc[String(employee.external_id)] = employee;
      return acc;
    }, {}),
    jobEmployeeRows,
    priorAssignedRows: historicalRows,
    historicalByVendor,
  };
}

function getExistingSuggestionKey(row = {}) {
  const jobId = getSuggestionJobId(row);
  return jobId ? `${row.transaction_id}:${jobId}` : null;
}

async function fetchExistingSuggestions(businessId, transactionIds = []) {
  if (!transactionIds.length) return [];
  return safeSelect(
    supabase
      .from("job_assignment_suggestions")
      .select("*")
      .eq("business_id", businessId)
      .in("transaction_id", transactionIds)
  );
}

async function expireSuggestionsForFullyAssignedTransactions(businessId, transactionIds = []) {
  if (!transactionIds.length) return 0;
  const { data, error } = await supabase
    .from("job_assignment_suggestions")
    .update({ status: "expired", updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("status", "pending")
    .in("transaction_id", transactionIds)
    .select("id");
  if (error) {
    if (isMissingTableError(error)) return 0;
    throw error;
  }
  return (data || []).length;
}

function formatSuggestionForUi({ row, transaction, job, score, reasoning }) {
  const confidence = score ?? row?.confidence_score ?? row?.confidence ?? 0;
  return {
    id: row?.id || `${transaction.id}:${job.id}`,
    business_id: row?.business_id,
    transaction_id: transaction.id,
    job_id: job.id,
    suggested_job_id: job.id,
    confidence,
    confidence_score: confidence,
    confidence_label: row?.confidence_label || getConfidenceLabel(confidence),
    reason: row?.reason || row?.reasoning?.summary || reasoning?.summary || "Rule-based job assignment suggestion.",
    reasoning: row?.reasoning || reasoning || {},
    methods_used: row?.methods_used || [],
    status: row?.status || "pending",
    source: row?.source || "rule_based",
    transaction: {
      id: transaction.id,
      date: transaction.date,
      vendor: transaction.vendor || transaction.payee || "",
      description: transaction.description || "",
      amount: toNumber(transaction.amount),
      category: getTransactionAccount(transaction) || "Uncategorized",
    },
    job: {
      id: job.id,
      job_name: getJobName(job),
      customer_name: job.customer_name || job.client_name || job.customer || "",
      trade_type: job.trade_type || job.trade || job.service_type || "",
    },
  };
}

async function upsertSuggestionRows(rows) {
  if (!rows.length) return { rows: [], count: 0 };
  const { data, error } = await supabase
    .from("job_assignment_suggestions")
    .upsert(rows.map((row) => row.newSchema), {
      onConflict: "business_id,transaction_id,suggested_job_id",
      ignoreDuplicates: false,
    })
    .select("*");
  if (!error) return { rows: data || [], count: rows.length };
  if (!/null value in column "id"|column .* does not exist|constraint|schema cache|unique/i.test(error.message || "")) {
    throw error;
  }
  const { data: fallbackData, error: fallbackError } = await supabase
    .from("job_assignment_suggestions")
    .upsert(rows.map((row) => row.compatSchema), {
      onConflict: "id",
      ignoreDuplicates: false,
    })
    .select("*");
  if (!fallbackError) return { rows: fallbackData || [], count: rows.length };
  if (!/column .* does not exist|schema cache/i.test(fallbackError.message || "")) {
    throw fallbackError;
  }
  const { data: legacyData, error: legacyError } = await supabase
    .from("job_assignment_suggestions")
    .upsert(rows.map((row) => row.legacyCompatSchema), {
      onConflict: "id",
      ignoreDuplicates: false,
    })
    .select("*");
  if (legacyError) throw legacyError;
  return { rows: legacyData || [], count: rows.length };
}

export async function generateJobAssignmentSuggestionsForBusiness(businessId, options = {}) {
  if (!businessId) {
    const error = new Error("business_id required");
    error.status = 400;
    throw error;
  }
  const context = await buildScoringContext(businessId, options);
  const minConfidence = Math.max(0, Math.min(100, toNumber(options.minConfidence ?? options.min_confidence, MIN_CONFIDENCE)));
  const dateRange = getDateRangeBounds(options.dateRange ?? options.date_range);
  const activeJobs = context.jobs.filter((job) => ACTIVE_JOB_PATTERN.test(String(job.status || "active")));
  const eligibleTransactions = context.postedTransactions.filter((transaction) => dateInRange(transaction.date || transaction.posted_at, dateRange));
  const transactionIds = eligibleTransactions.map((transaction) => transaction.id);
  const existingSuggestions = await fetchExistingSuggestions(businessId, transactionIds);
  const blockedSuggestionKeys = new Set(
    existingSuggestions
      .filter((row) => ["pending", "approved", "accepted", "rejected"].includes(String(row.status || "")))
      .map(getExistingSuggestionKey)
      .filter(Boolean)
  );
  const existingByKey = existingSuggestions.reduce((acc, row) => {
    const key = getExistingSuggestionKey(row);
    if (key) acc[key] = row;
    return acc;
  }, {});

  const fullyAssignedIds = [];
  const candidates = [];
  for (const transaction of eligibleTransactions) {
    const assignedPercent = context.assignedPercentByTransaction[String(transaction.id)] || 0;
    if (assignedPercent >= 100) {
      fullyAssignedIds.push(transaction.id);
      continue;
    }
    for (const job of activeJobs) {
      const key = `${transaction.id}:${job.id}`;
      if (blockedSuggestionKeys.has(key)) continue;
      const scored = await scoreTransactionAgainstJob({ businessId, transaction, job, context });
      if (scored.score < minConfidence) continue;
      candidates.push({ transaction, job, ...scored, key });
    }
  }

  const expiredCount = await expireSuggestionsForFullyAssignedTransactions(businessId, fullyAssignedIds);
  const now = new Date().toISOString();
  const rowsToUpsert = candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit || 100)
    .map((candidate) => {
      const methodsUsed = Object.entries(candidate.reasoning)
        .filter(([key, value]) => ["historical", "proximity", "employee", "clustering"].includes(key) && value?.score > 0)
        .map(([key]) => key);
      const common = {
        business_id: businessId,
        transaction_id: candidate.transaction.id,
        confidence_score: candidate.score,
        confidence_label: candidate.confidence_label,
        methods_used: methodsUsed,
        reasoning: candidate.reasoning,
        status: "pending",
        updated_at: now,
      };
      return {
        candidate,
        newSchema: {
          ...common,
          suggested_job_id: candidate.job.id,
        },
        compatSchema: {
          ...common,
          id: candidate.key,
          job_id: candidate.job.id,
          confidence: candidate.score,
          reason: candidate.reasoning.summary,
          source: "rule_based",
        },
        legacyCompatSchema: {
          id: candidate.key,
          business_id: businessId,
          transaction_id: candidate.transaction.id,
          job_id: candidate.job.id,
          confidence: candidate.score,
          reason: candidate.reasoning.summary,
          status: "pending",
          source: "rule_based",
          updated_at: now,
        },
      };
    });

  const existingCandidateKeys = new Set(Object.keys(existingByKey));
  const upserted = await upsertSuggestionRows(rowsToUpsert);
  const upsertedByKey = (upserted.rows || []).reduce((acc, row) => {
    const key = getExistingSuggestionKey(row);
    if (key) acc[key] = row;
    return acc;
  }, {});
  const suggestions = rowsToUpsert.map(({ candidate }) => formatSuggestionForUi({
    row: upsertedByKey[candidate.key] || existingByKey[candidate.key],
    transaction: candidate.transaction,
    job: candidate.job,
    score: candidate.score,
    reasoning: candidate.reasoning,
  }));
  return {
    createdCount: rowsToUpsert.filter(({ candidate }) => !existingCandidateKeys.has(candidate.key)).length,
    updatedCount: rowsToUpsert.filter(({ candidate }) => existingCandidateKeys.has(candidate.key)).length,
    createdOrUpdatedCount: upserted.count,
    expiredCount,
    suggestions,
  };
}
