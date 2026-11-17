/* global process */
import { getBusinessQuickPromptByIntent } from "../../config/businessQuickPrompts.js";
export const BOOKKEEPING_STATUS_FALLBACK = "Bookkeeping status: Transaction completeness could not be verified for this period. Review Books and Reconciliations before relying on these results as final.";
export const BOOKKEEPING_STATUS_INSTRUCTION = "The server appends bookkeeping status after your answer. Do not write bookkeeping-status/completeness claims, transaction workflow counts, percentages of bank activity represented in QuickBooks, or claims that the books are complete. Discuss only the supplied financial results. Do not infer the financial impact of unresolved or pending activity.";
export const BOOKKEEPING_STATUS_INTENTS = new Set([
  "financial_month_performance", "financial_income_categories", "financial_expense_categories", "financial_period_changes", "tax_ytd_book_profit",
  "financial_summary", "financial_revenue", "financial_expenses", "financial_net_income", "fin_overview", "fin_variance_explain",
]);
const OPEN_BUCKETS = ["needs_review", "handled_waiting", "scheduled", "posting_in_progress", "posting_failed", "ambiguous"];
export const NUMERIC_BOOKKEEPING_PROMPT_IDS = Object.freeze([
  "financial_month_performance", "financial_income_categories", "financial_expense_categories",
]);
// Request context is untrusted. Only the handler may install canonical evidence.
export function withoutCanonicalEvidence(input = {}) {
  const safe = { ...input };
  delete safe.canonicalEvidence;
  delete safe.canonicalEvidencePackageId;
  delete safe.canonicalProvenance;
  return safe;
}
function localToday(now, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = type => parts.find(part => part.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
export function supportedBookkeepingPeriod({ canonicalPrompt, period, now = new Date() }) {
  // Identity must be the server registry object, not a client ID or inferred intent.
  if (!canonicalPrompt || getBusinessQuickPromptByIntent(canonicalPrompt.id) !== canonicalPrompt ||
      !NUMERIC_BOOKKEEPING_PROMPT_IDS.includes(canonicalPrompt.id)) return null;
  const start = period?.start || period?.start_date, end = period?.end || period?.end_date;
  const timezone = period?.timezone;
  if (!timezone) return null;
  let today;
  try { today = localToday(now, timezone); } catch { return null; }
  if (start !== `${today.slice(0, 7)}-01` || end !== today) return null;
  const exclusive = new Date(`${end}T00:00:00Z`);
  exclusive.setUTCDate(exclusive.getUTCDate() + 1);
  return { start, end, endExclusive: exclusive.toISOString().slice(0, 10), timezone };
}
export function validateWorkflowSummary(result) {
  const totals = result?.totals;
  const buckets = [...OPEN_BUCKETS, "pending", "posted_by_bizzi", "matched_existing_qbo", "matched_transfer_or_card_payment", "excluded"];
  if (!totals || !totals.conservation_ok || !Number.isSafeInteger(totals.plaid_transactions_count) || totals.plaid_transactions_count < 0) throw new Error("workflow_conservation_failed");
  let sum = 0;
  for (const key of buckets) {
    const value = totals[`${key}_count`];
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("workflow_count_invalid");
    sum += value;
  }
  if (sum !== totals.plaid_transactions_count || totals.explained_count !== sum || totals.matched_transfer_or_card_payment_count !== 0) throw new Error("workflow_conservation_failed");
  if (![result.started_at, result.observed_at].every(value => Number.isFinite(Date.parse(value))) || result.started_at > result.observed_at) throw new Error("workflow_observation_invalid");
  return { open_workflow_count: OPEN_BUCKETS.reduce((sum, key) => sum + totals[`${key}_count`], 0), pending_count: totals.pending_count, started_at: result.started_at, observed_at: result.observed_at };
}
export async function acquireBookkeepingStatus({ db, businessId, intent, canonicalPrompt, period, configuration, now = new Date(), plaidEnv = process.env.PLAID_ENV || "sandbox", qboEnv = process.env.QB_ENVIRONMENT || "production", loadPipeline } = {}) {
  if (!BOOKKEEPING_STATUS_INTENTS.has(intent)) return null;
  const unavailable = { available: false };
  const bounds = supportedBookkeepingPeriod({ canonicalPrompt, period, now });
  if (!bounds || !businessId) return unavailable;
  try {
    if (configuration?.business_id !== businessId || configuration.status !== "verified" || configuration.reporting_timezone !== bounds.timezone || !configuration.qbo_realm_id) return unavailable;
    loadPipeline ||= (await import("../bookkeeping/monthlyReconciliationPipelineService.js")).loadMonthlyReconciliationPipeline;
    const result = await loadPipeline(businessId, { evidenceOnly: true, db, month: bounds.start.slice(0, 7), date_from: bounds.start, date_to: bounds.endExclusive, plaidEnv, qboEnv, realmId: configuration.qbo_realm_id });
    return { available: true, period: bounds, ...validateWorkflowSummary(result) };
  } catch { return unavailable; }
}
export function renderBookkeepingStatus(evidence) {
  if (!evidence?.available) return BOOKKEEPING_STATUS_FALLBACK;
  const { open_workflow_count: open, pending_count: pending } = evidence;
  const openItems = `${open} imported transaction${open === 1 ? " is" : "s are"} still being reviewed or posted`;
  const pendingItems = `${pending} bank transaction${pending === 1 ? " remains" : "s remain"} pending`;
  if (open > 0 && pending > 0) {
    return `Bookkeeping status: ${openItems}, and ${pendingItems}. These QuickBooks figures may change as those items are completed.`;
  }
  if (open > 0) {
    return `Bookkeeping status: ${openItems}. No bank transactions remain pending. These QuickBooks figures may change as the outstanding items are completed.`;
  }
  if (pending > 0) {
    return `Bookkeeping status: No imported transactions are currently awaiting review or posting, but ${pendingItems}. These QuickBooks figures may change as pending transactions settle.`;
  }
  return "Bookkeeping status: No imported transactions are currently awaiting review or posting, and no bank transactions remain pending.";
}
// Called once by the response-composition boundary before persistence/cache.
// Prose (including quotations) is never inspected or rewritten here.
export function appendBookkeepingStatus(prose, evidence) {
  if (!evidence) return prose;
  return `${prose}\n\n${renderBookkeepingStatus(evidence)}`;
}
