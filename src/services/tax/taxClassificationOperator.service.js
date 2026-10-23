import { createHash } from "node:crypto";
import { listTaxClassifications } from "./taxClassification.repository.js";
import { listDeductionRules } from "./taxDeductionRule.repository.js";
import { computeClassificationAmounts } from "./taxClassificationAmounts.js";
import { TAX_ACTION_OWNERS, taxActionOwnerForRow } from "./taxDeductionsLifecycleProjection.js";
import { getLatestTaxClassificationRun, getTaxClassificationRulesVersion, listTaxClassificationRunItems } from "./taxClassificationRun.service.js";

const QUEUES = Object.freeze({
  [TAX_ACTION_OWNERS.BIZZI_TAX_MAPPING_REQUIRED]: "tax_mappings_needed",
  [TAX_ACTION_OWNERS.PROFESSIONAL_REVIEW_REQUIRED]: "professional_review",
  [TAX_ACTION_OWNERS.BOOKKEEPING_REVIEW_REQUIRED]: "bookkeeping_review",
  [TAX_ACTION_OWNERS.TERMINAL_SYSTEM_FAILURE]: "technical_failures",
  [TAX_ACTION_OWNERS.SYSTEM_PROCESSING]: "processing_retry_status",
  [TAX_ACTION_OWNERS.SYSTEM_RETRY]: "processing_retry_status",
  [TAX_ACTION_OWNERS.NONE]: "resolved_history",
});

export async function getTaxClassificationOperatorWorkspace({ supabase, businessId, taxYear } = {}) {
  const classifications = await listAllClassifications({ supabase, businessId, taxYear });
  const rules = await listDeductionRules({ supabase, businessId, taxYear, includeInactive: false });
  const latestRun = await getLatestTaxClassificationRun({ supabase, businessId, taxYear });
  const runItems = latestRun?.metadata?.exact_membership === true
    ? await listTaxClassificationRunItems({ supabase, businessId, taxYear, runId: latestRun.id })
    : [];
  const runByTransaction = new Map(runItems.map((item) => [String(item.stable_transaction_id), item]));
  const groups = new Map();
  for (const row of classifications) {
    const runItem = runByTransaction.get(String(row.transaction_id));
    const projectionRow = { ...row, runItem, raw: row };
    const actionOwner = taxActionOwnerForRow(projectionRow);
    const queue = QUEUES[actionOwner] || "professional_review";
    const qboAccountId = row.source_qbo_account_id || row.metadata?.source_qbo_account_id || null;
    const qboAccountName = row.source_qbo_account_name || row.metadata?.source_qbo_account_name || "Unmapped account";
    const qboAccountType = row.metadata?.source_qbo_account_type || null;
    const reasonCode = safeReasonCode(runItem?.safe_reason_code || row.metadata?.reason_code || row.metadata?.fallback_reason);
    const key = [queue, qboAccountId || "unmapped", reasonCode || "none"].join(":");
    if (!groups.has(key)) groups.set(key, {
      id: key, queue, actionOwner, businessId, taxYear,
      qboAccountId, qboAccountName, qboAccountType, reasonCode,
      transactionCount: 0, grossAmount: 0, months: new Set(),
      currentTaxMapping: null, proposedTaxCategory: null, deductibilityState: null,
      ruleSource: null, authorities: { customer: 0, operator: 0, cpa: 0 }, transactions: [],
    });
    const group = groups.get(key);
    group.transactionCount += 1;
    group.grossAmount += Math.abs(Number(row.book_amount || 0));
    if (row.transaction_date) group.months.add(String(row.transaction_date).slice(0, 7));
    group.currentTaxMapping ||= row.tax_category || null;
    group.proposedTaxCategory ||= row.metadata?.proposed_tax_category || null;
    group.deductibilityState ||= row.deductibility_status || null;
    group.ruleSource ||= row.rule_code ? "rule" : row.source || null;
    if (row.classification_status === "user_confirmed") group.authorities.customer += 1;
    if (row.classification_status === "bizzi_operator_confirmed") group.authorities.operator += 1;
    if (["cpa_confirmed", "accountant_reviewed"].includes(row.classification_status)) group.authorities.cpa += 1;
    group.transactions.push({
      transactionId: row.transaction_id,
      transactionDate: row.transaction_date,
      grossAmount: Math.abs(Number(row.book_amount || 0)),
      classificationStatus: row.classification_status,
      updatedAt: row.updated_at,
      runItemStatus: runItem?.lifecycle_state || null,
      nextRetryAt: runItem?.next_retry_at || null,
      bookkeepingReviewHref: buildBookkeepingReviewHref(row),
    });
  }
  const normalized = [...groups.values()].map((group) => ({ ...group, months: [...group.months].sort(), grossAmount: round2(group.grossAmount) }));
  return {
    businessId, taxYear,
    ruleOptions: operatorRuleOptions(rules),
    latestRun: latestRun ? { id: latestRun.id, status: latestRun.status, hasExactMembership: latestRun.metadata?.exact_membership === true, createdAt: latestRun.created_at } : null,
    queues: Object.fromEntries(["tax_mappings_needed", "professional_review", "bookkeeping_review", "technical_failures", "processing_retry_status", "resolved_history"].map((queue) => [queue, normalized.filter((group) => group.queue === queue)])),
  };
}

export async function previewBizziOperatorTaxDecision({ supabase, businessId, taxYear, groupId, input = {} } = {}) {
  assertOperatorDecisionInput({ businessId, taxYear, groupId, input });
  const [classifications, rules] = await Promise.all([
    listAllClassifications({ supabase, businessId, taxYear }),
    listDeductionRules({ supabase, businessId, taxYear, includeInactive: false }),
  ]);
  const workspace = await getTaxClassificationOperatorWorkspace({ supabase, businessId, taxYear });
  const group = Object.values(workspace.queues).flat().find((candidate) => candidate.id === groupId);
  if (!group) throw operatorError(404, "tax_review_group_not_found", "This Tax review group is no longer available.");
  if (!group.qboAccountId || group.queue === "bookkeeping_review") {
    throw operatorError(409, "bookkeeping_review_required", "Resolve the bookkeeping account before applying a Tax treatment.");
  }
  if (!["tax_mappings_needed", "professional_review"].includes(group.queue)) {
    throw operatorError(409, "tax_review_group_not_editable", "This Tax review group is not eligible for an operator decision.");
  }

  const sameGl = classifications.filter((row) => stableAccountId(row) === String(group.qboAccountId));
  const protectedRows = sameGl.filter(isProfessionalConfirmed);
  const mutableRows = sameGl.filter((row) => {
    if (isProfessionalConfirmed(row) || row.classification_status === "excluded") return false;
    const owner = taxActionOwnerForRow({ ...row, raw: row });
    return [TAX_ACTION_OWNERS.BIZZI_TAX_MAPPING_REQUIRED, TAX_ACTION_OWNERS.PROFESSIONAL_REVIEW_REQUIRED].includes(owner)
      || ["user_confirmed", "bizzi_operator_confirmed"].includes(row.classification_status)
      || row.user_override === true;
  });
  const requestedIds = [...new Set((input.transaction_ids || group.transactions.map((row) => row.transactionId)).map(String))].sort();
  const canonicalRows = input.scope_type === "exact_transactions"
    ? mutableRows.filter((row) => requestedIds.includes(String(row.transaction_id)))
    : mutableRows;
  if (!canonicalRows.length || canonicalRows.length !== requestedIds.length && input.scope_type === "exact_transactions") {
    throw operatorError(409, "operator_decision_population_changed", "The Tax review group changed. Refresh it before continuing.");
  }
  if (input.scope_type === "exact_transactions" && canonicalRows.some((row) => !group.transactions.some((item) => String(item.transactionId) === String(row.transaction_id)))) {
    throw operatorError(409, "operator_decision_scope_changed", "The selected transactions are outside this review group.");
  }

  const decisionMode = input.decision_mode === "professional_hold" ? "professional_hold" : "tax_mapping";
  const selectedRule = decisionMode === "tax_mapping" ? findSupportedRule(rules, input.rule_id) : null;
  if (decisionMode === "tax_mapping" && !selectedRule) {
    throw operatorError(400, "supported_tax_rule_required", "Select a supported versioned Tax treatment.");
  }
  const customerConflicts = canonicalRows.filter((row) => row.classification_status === "user_confirmed" || row.user_override === true);
  const reason = String(input.reason || "").trim();
  if (!reason || reason.length > 1000 || (customerConflicts.length && reason.length < 8)) {
    throw operatorError(400, "operator_reason_required", "Enter an internal audit reason for this Tax decision.");
  }
  const items = canonicalRows.map((row) => buildOperatorItem(row, selectedRule, decisionMode, reason));
  const transactionIds = items.map((item) => item.transaction_id).sort();
  const scope = {
    scope_type: input.scope_type,
    decision_mode: decisionMode,
    qbo_account_id: String(group.qboAccountId),
    reason,
  };
  const expectedVersions = items.map((item) => ({ transaction_id: item.transaction_id, classification_id: item.classification_id, expected_updated_at: item.expected_updated_at }));
  const scopeFingerprint = fingerprint({ businessId, taxYear, scope, expectedVersions });
  const proposed = decisionMode === "professional_hold" ? {
    label: "Professional review", taxCategory: "tax_review_holding", deductibilityStatus: "not_yet_determined", deductiblePercent: null,
  } : {
    label: selectedRule.explanation || selectedRule.tax_category, taxCategory: selectedRule.tax_category,
    deductibilityStatus: selectedRule.deductibility_status, deductiblePercent: Number(selectedRule.default_deductible_percent),
    ruleId: selectedRule.id, ruleCode: selectedRule.rule_code, ruleVersion: selectedRule.version,
  };
  return {
    business: { id: businessId }, taxYear, stableQboGlAccount: { id: String(group.qboAccountId), name: group.qboAccountName },
    scope, exactAffectedTransactionIds: transactionIds, count: items.length,
    grossAmount: round2(canonicalRows.reduce((sum, row) => sum + Math.abs(Number(row.book_amount || 0)), 0)),
    currentAuthorityBreakdown: authorityBreakdown(canonicalRows), proposedTreatment: proposed,
    estimatedDeductionEffect: decisionMode === "professional_hold" ? null : round2(items.reduce((sum, item) => sum + Number(item.deductible_amount || 0), 0)),
    previouslyProtectedRowsExcluded: protectedRows.length, professionalConfirmedRowsExcluded: protectedRows.length,
    customerFactConflicts: customerConflicts.map((row) => ({ transactionId: row.transaction_id, authority: "customer" })),
    futureDefaultScope: input.scope_type === "future_business_gl_tax_year" ? { businessId, taxYear, qboAccountId: String(group.qboAccountId) } : null,
    scopeFingerprint, expectedVersions, items,
    rule: selectedRule ? operatorRulePayload(selectedRule, group, businessId, taxYear) : {},
  };
}

export async function applyBizziOperatorTaxDecision({ supabase, businessId, taxYear, groupId, input = {}, actorUserId, requestId, idempotencyKey } = {}) {
  if (!actorUserId) throw operatorError(401, "operator_actor_required", "An authenticated internal operator is required.");
  const preview = await previewBizziOperatorTaxDecision({ supabase, businessId, taxYear, groupId, input });
  if (preview.scopeFingerprint !== input.scope_fingerprint) {
    throw operatorError(409, "operator_decision_population_changed", "The Tax review group changed. Review the updated preview before applying it.");
  }
  const payloadFingerprint = fingerprint({ businessId, taxYear, groupId, scope: preview.scope, items: preview.items, rule: preview.rule });
  const { data, error } = await supabase.rpc("apply_bizzi_operator_tax_decision", {
    p_business_id: businessId, p_tax_year: taxYear, p_actor_user_id: actorUserId,
    p_actor_authority: "bizzi_operator", p_request_id: requestId, p_idempotency_key: idempotencyKey,
    p_scope: preview.scope, p_scope_fingerprint: preview.scopeFingerprint, p_payload_fingerprint: payloadFingerprint,
    p_expected_population_transaction_ids: preview.exactAffectedTransactionIds, p_items: preview.items, p_rule: preview.rule,
  });
  if (error) throw mapOperatorRpcError(error);
  return { operation: data, groupId, preview: { count: preview.count, grossAmount: preview.grossAmount } };
}

export async function getBizziOperatorTaxDecisionStatus({ supabase, businessId, idempotencyKey, actorUserId } = {}) {
  const { data, error } = await supabase.from("tax_grouped_deduction_decision_operations")
    .select("status,result,request_id,actor_user_id,actor_authority,updated_at")
    .eq("business_id", businessId).eq("idempotency_key", idempotencyKey).maybeSingle();
  if (error) throw operatorError(500, "operator_status_unavailable", "Could not verify whether the Tax decision was saved.");
  if (!data) return { status: "not_found" };
  if (String(data.actor_user_id) !== String(actorUserId) || data.actor_authority !== "bizzi_operator") {
    throw operatorError(403, "operator_operation_forbidden", "This Tax operation belongs to another operator.");
  }
  return { status: data.status, result: data.result, requestId: data.request_id, updatedAt: data.updated_at };
}

export async function requestBizziOperatorTaxRetry({ supabase, businessId, taxYear, groupId, actorUserId, requestId } = {}) {
  if (!actorUserId || !requestId) throw operatorError(401, "operator_actor_required", "An authenticated internal operator is required.");
  const workspace = await getTaxClassificationOperatorWorkspace({ supabase, businessId, taxYear });
  const group = workspace.queues.technical_failures.find((candidate) => candidate.id === groupId);
  if (!group?.transactions?.length) throw operatorError(409, "tax_retry_not_eligible", "Only a current terminal Tax evaluation failure can be retried.");
  const transactionIds = group.transactions.map((row) => String(row.transactionId)).sort();
  if (group.transactions.some((row) => row.runItemStatus !== "failed_terminal")) {
    throw operatorError(409, "tax_retry_not_eligible", "This Tax evaluation is still processing or already has a retry scheduled.");
  }
  const sourceFingerprint = `operator-retry:${fingerprint({ businessId, taxYear, transactionIds })}`;
  const now = new Date().toISOString();
  const { data, error } = await supabase.rpc("create_tax_classification_run_with_items", {
    p_run: {
      business_id: businessId, tax_year: taxYear, trigger_source: "recovery_scan", status: "queued",
      total_eligible: transactionIds.length, queued_count: transactionIds.length, source_fingerprint: sourceFingerprint,
      rules_version: getTaxClassificationRulesVersion(), process_after: now,
      metadata: { source: "monthly_review_tax_retry", request_id: requestId, internal_actor_id: actorUserId, exact_membership: true, retry_group_id: groupId },
    },
    p_items: transactionIds.map((stableTransactionId) => ({ stable_transaction_id: stableTransactionId, source_fingerprint: sourceFingerprint, membership_snapshot_at: now })),
  });
  if (error && String(error.code || "") !== "23505") throw operatorError(500, "tax_retry_failed", "Could not request Tax reevaluation.");
  return { queued: !error, outcome: error ? "existing_active_run" : "queued", run: data ? { id: data.id, status: data.status } : null, transactionCount: transactionIds.length };
}

async function listAllClassifications({ supabase, businessId, taxYear }) {
  const rows = [];
  for (let offset = 0; ; offset += 250) {
    const page = await listTaxClassifications({ supabase, businessId, taxYear, limit: 250, offset });
    rows.push(...page.rows);
    if (page.rows.length < 250) return rows;
  }
}

function operatorRuleOptions(rules) {
  return (rules || []).filter((rule) => rule.scope === "global" && rule.id && rule.version).map((rule) => ({
    id: rule.id, ruleCode: rule.rule_code, version: rule.version, taxCategory: rule.tax_category,
    label: rule.explanation || rule.tax_category, deductibilityStatus: rule.deductibility_status,
    deductiblePercent: Number(rule.default_deductible_percent),
  }));
}

function findSupportedRule(rules, ruleId) {
  return (rules || []).find((rule) => String(rule.id) === String(ruleId) && rule.scope === "global" && rule.is_active !== false) || null;
}

function buildOperatorItem(row, rule, decisionMode, reason) {
  const holding = decisionMode === "professional_hold";
  const taxCategory = holding ? "tax_review_holding" : rule.tax_category;
  const deductibilityStatus = holding ? "not_yet_determined" : rule.deductibility_status;
  const amounts = computeClassificationAmounts({ signedAmount: row.book_amount, direction: row.metadata?.direction, deductibilityStatus, deductiblePercent: holding ? null : Number(rule.default_deductible_percent), taxCategory });
  return {
    transaction_id: row.transaction_id, classification_id: row.id, expected_updated_at: row.updated_at,
    tax_category: taxCategory, deductibility_status: deductibilityStatus, deductible_percent: amounts.deductiblePercent,
    deductible_amount: amounts.deductibleAmount, nondeductible_amount: amounts.nondeductibleAmount,
    capitalizable_amount: amounts.capitalizableAmount, tax_treatment: holding ? { type: "tax_review_holding", non_reportable: true } : rule.treatment,
    classification_status: holding ? "needs_tax_review" : "bizzi_operator_confirmed", source: "bizzi_operator",
    metadata: { operator_reason: reason, selected_rule_id: rule?.id || null, selected_rule_code: rule?.rule_code || null, selected_rule_version: rule?.version || null, customer_facts_preserved: true },
  };
}

function operatorRulePayload(rule, group, businessId, taxYear) {
  return { ...rule, business_id: businessId, tax_year: taxYear, scope: "business_override",
    rule_code: `operator_gl_${String(group.qboAccountId).replace(/[^a-zA-Z0-9_-]/g, "_")}`,
    qbo_account_id: String(group.qboAccountId), match_conditions: { qbo_account_id: String(group.qboAccountId) } };
}

function stableAccountId(row) { return String(row.source_qbo_account_id || row.metadata?.source_qbo_account_id || ""); }
function isProfessionalConfirmed(row) { return ["cpa_confirmed", "accountant_reviewed"].includes(row.classification_status) || row.cpa_override === true; }
function authorityBreakdown(rows) { return rows.reduce((acc, row) => { const key = isProfessionalConfirmed(row) ? "taxProfessional" : row.classification_status === "bizzi_operator_confirmed" ? "bizziOperator" : row.classification_status === "user_confirmed" || row.user_override ? "customer" : row.rule_code ? "rule" : "automatedOrUnresolved"; acc[key] += 1; return acc; }, { taxProfessional: 0, bizziOperator: 0, customer: 0, rule: 0, automatedOrUnresolved: 0 }); }
function fingerprint(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function buildBookkeepingReviewHref(row) { const month = row.transaction_date ? String(row.transaction_date).slice(0, 7) : ""; return `/admin/monthly-review?section=books&month=${encodeURIComponent(month)}&transaction_id=${encodeURIComponent(row.transaction_id || "")}&qbo_account_id=${encodeURIComponent(stableAccountId(row))}`; }
function assertOperatorDecisionInput({ businessId, taxYear, groupId, input }) { if (!businessId || !Number.isInteger(Number(taxYear)) || !groupId || !["exact_transactions", "business_gl_tax_year", "future_business_gl_tax_year"].includes(input.scope_type)) throw operatorError(400, "invalid_operator_tax_decision", "Choose a valid Tax decision scope."); }
function operatorError(status, error, message) { return Object.assign(new Error(message), { status, error }); }
function mapOperatorRpcError(error) { const message = String(error?.message || ""); if (/scope_changed|population_changed|idempotency_key_reused/.test(message)) return operatorError(409, message.match(/idempotency_key_reused/) ? "idempotency_key_reused" : "operator_decision_population_changed", "The Tax review group changed or this request conflicts with an earlier operation."); return operatorError(500, "operator_tax_decision_failed", "Could not apply the Tax decision. No partial changes were saved."); }

function safeReasonCode(value) {
  const code = String(value || "").trim().toLowerCase();
  return /^[a-z0-9_:-]{1,80}$/.test(code) ? code : null;
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}
