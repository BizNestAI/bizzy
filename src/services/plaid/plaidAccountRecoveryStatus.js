/* global process */
import { importFreshnessHours, PLAID_RECOVERY_CONTRACT } from "./plaidRecoveryContract.js";
// Pure projections of aggregate database evidence. No provider or worker calls.
const REAUTH = new Set(["ITEM_LOGIN_REQUIRED", "INVALID_CREDENTIALS", "INVALID_MFA", "USER_SETUP_REQUIRED", "provider_reauthentication_required"]);
const OUTAGE = new Set(["INSTITUTION_DOWN", "INSTITUTION_NOT_RESPONDING"]);
const stamp = value => value ? Date.parse(value) : 0;
const safeCode = value => typeof value === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(value) ? value : null;

function dimension(state, reason, action, copy, times = {}, count = null, diagnostic = {}) {
  return { state, reason_code: reason, last_attempt_at: times.attempt || null, last_success_at: times.success || null,
    error_at: times.error || null, next_retry_at: times.retry || null, affected_count: count,
    recommended_action: action, customer_copy: copy,
    diagnostic: { stage: safeCode(diagnostic.stage), code: safeCode(diagnostic.code) } };
}

export function projectPlaidAccountRecoveryStatus(facts, { observedAt = new Date().toISOString(), eligibility = {}, freshnessHours = importFreshnessHours() } = {}) {
  const { account: a, item: i, metrics: m, latest_run: run, last_checkpoint: checkpoint } = facts;
  const itemSuccess = checkpoint?.finished_at || i.last_success_at || null;
  const success = a.last_sync_at && checkpoint && stamp(a.last_sync_at) <= stamp(itemSuccess) ? a.last_sync_at : null;
  const failed = run?.status === "failed" && stamp(run.finished_at || run.started_at) > stamp(itemSuccess);
  const itemErrorCurrent = i.error_code && stamp(i.updated_at) > stamp(itemSuccess);
  const providerCode = failed && run.stage === "provider_fetch" ? run.source_error_code : itemErrorCurrent && REAUTH.has(i.error_code) ? i.error_code : null;
  const bankTimes = { attempt: run?.started_at, success, error: providerCode && failed && run?.stage === "provider_fetch" ? run.finished_at : null };
  let bank = dimension("connected", "connection_available", "none", "Bank connected", bankTimes);
  if (!i.status) bank = dimension("attention_required", "item_missing", "contact_support", "Bank connection needs attention", bankTimes);
  else if (a.is_active === false || i.is_active === false || a.disconnected_at || i.disconnected_at || ["disconnected", "closed_historical"].includes(a.connection_state)) {
    bank = dimension("disconnected", "disconnected", "connect_bank", "Bank disconnected", bankTimes);
  } else if (a.connection_state === "attention_required" || REAUTH.has(providerCode) || (i.status === "reauth_required" && stamp(i.updated_at) > stamp(itemSuccess))) {
    bank = dimension("attention_required", REAUTH.has(providerCode) || i.status === "reauth_required" ? "plaid_reauthentication_required" : "account_connection_attention_required",
      REAUTH.has(providerCode) || i.status === "reauth_required" ? "reconnect_bank_securely" : "review_bank_connection",
      REAUTH.has(providerCode) || i.status === "reauth_required" ? "Reconnect your bank securely" : "Bank connection needs attention", bankTimes, null, { stage: "provider_fetch", code: providerCode });
  } else if (failed && run.stage === "provider_fetch" && OUTAGE.has(run.source_error_code)) {
    bank = dimension("institution_unavailable", "verified_provider_outage", "none", "Bank temporarily unavailable", bankTimes, null, { stage: "provider_fetch", code: run.source_error_code });
  }

  if (a.connection_state === "closed_historical") bank = dimension("disconnected", "closed_historical", "none", "Closed account · history retained", bankTimes);

  const importTimes = { attempt: run?.started_at, success, error: failed ? run.finished_at : null };
  const stale = !success || stamp(observedAt) - stamp(success) > freshnessHours * 3600000;
  let imported = dimension(stale ? "delayed" : "current", stale ? "checkpoint_overdue" : "checkpoint_completed", stale ? "inspect_import" : "none",
    stale ? "Transaction import is delayed" : "Transaction import current", importTimes, 0);
  if (run?.status === "running") imported = dimension("processing", "sync_in_progress", "none", "Importing transactions", importTimes);
  if (failed) {
    const internal = ["transaction_persistence", "downstream_admission"].includes(run.stage) || run.failure_code === "database_persistence_failure";
    imported = dimension("failed", run.reason === "plaid_processing_request_requires_replay" ? "retained_cursor_replay_required" : internal ? "internal_transaction_persistence_failure" : providerCode && REAUTH.has(providerCode) ? "plaid_reauthentication_required" : "provider_fetch_failed",
      internal ? "inspect_import" : bank.recommended_action, internal ? "Transaction import needs attention" : "Bank transaction import needs attention",
      importTimes, internal ? m.missing_both : null, { stage: run.database_stage || run.stage, code: run.source_error_code || run.failure_code });
    imported.replay = { required: internal, reason_code: internal ? "retained_cursor_replay_required" : null, recommended_action: internal ? "replay_retained_cursor_after_fix" : "none" };
  } else imported.replay = { required: false, reason_code: null, recommended_action: "none" };
  imported.persisted_active_count = m.active_count;
  imported.latest_active_transaction_date = m.latest_transaction_date;
  imported.first_active_transaction_date = m.first_transaction_date;
  imported.last_transaction_persisted_at = m.last_persisted_at;
  imported.last_transaction_mutation_at = m.last_mutation_at;
  imported.last_transaction_observed_at = m.last_observed_at;
  imported.last_completed_checkpoint_at = success;
  imported.last_checked_at = success;
  imported.item_last_completed_checkpoint_at = itemSuccess;
  imported.partial_persistence_after_checkpoint = failed && Math.max(stamp(m.last_persisted_at), stamp(m.last_mutation_at)) > stamp(success);
  // Polling configuration is not a durable per-Item retry appointment.
  imported.next_retry_at = null;
  if (bank.state === "disconnected") {
    imported.state = "paused"; imported.reason_code = "account_disconnected";
    imported.customer_copy = bank.reason_code === "closed_historical" ? "Closed account · history retained" : "Bank feed disconnected";
    imported.recommended_action = bank.recommended_action;
  }

  // Reauthentication is not healthy until the verified retained-cursor run
  // commits its categorization/admission checkpoint. Other dimensions stay independent.
  const reconnect = i.reconnect_state || {};
  if (bank.state !== "disconnected" && reconnect.state === "identity_review_required") {
    bank = dimension("attention_required", "account_identity_review_required", "review_account_identity", "Account identity needs review", bankTimes);
    imported.state = "gap_review_required"; imported.reason_code = "identity_review_required";
    imported.recommended_action = "review_account_identity"; imported.customer_copy = "Import paused for account identity review";
  } else if (bank.state !== "disconnected" && reconnect.state === "waiting_for_replay") {
    bank = dimension("reconnect_in_progress", "reconnect_checkpoint_required", failed ? "resume_reconnect" : "wait_for_replay", "Reconnection is being verified", bankTimes);
    imported.state = failed ? "failed" : run?.status === "running" ? "replaying" : "waiting_for_replay";
    imported.reason_code = "reconnect_checkpoint_required"; imported.recommended_action = failed ? "resume_reconnect" : "wait_for_replay";
    imported.customer_copy = failed ? "Reconnection replay needs attention" : "Waiting for verified transaction replay";
    imported.replay = { required: true, reason_code: "reconnect_checkpoint_required", recommended_action: imported.recommended_action };
  } else if (bank.reason_code === "plaid_reauthentication_required") {
    bank.recommended_action = "reconnect_securely"; imported.recommended_action = "reconnect_securely";
  }
  if (bank.state !== "disconnected" && reconnect.state === "completed" && m.recovery_gap_review_count > 0) {
    imported.state="gap_review_required"; imported.reason_code="authoritative_gap_review_required";
    imported.recommended_action="review_possible_gap"; imported.customer_copy="Historical coverage needs review";
  }

  const blockedByAdmission = failed && run.reason === "plaid_processing_request_requires_replay";
  const automationTimes = { attempt: m.automation_last_attempt_at, success: m.automation_last_success_at,
    error: m.automation_error_at || (blockedByAdmission ? run.finished_at : null) };
  let automation = dimension("active", "automation_current", "none", "Categorization active", automationTimes, 0);
  if (m.review_count > 0) automation = dimension("needs_review", "user_review_required", "review_transactions", "Transactions need review", automationTimes, m.review_count);
  if (m.processing_count > 0) automation = dimension("processing", "categorization_processing", "none", m.active_lease_count > 0 ? "Categorizing transactions" : "Categorization work is queued", automationTimes, m.processing_count);
  if (m.automation_failed_count > 0) automation = dimension("failed", "categorization_failed", "review_automation", "Categorization needs attention", automationTimes, m.automation_failed_count);
  if (m.missing_categorization > 0 || m.required_processing_admission_missing > 0) automation = dimension("failed", "durable_admission_missing", "review_automation",
    "Automation admission needs attention", automationTimes, m.missing_categorization + m.required_processing_admission_missing - m.missing_both, { stage: "processing_admission", code: "durable_admission_missing" });
  if (m.dead_letter_count > 0) automation = dimension("blocked", "unresolved_dead_letter", "resolve_dead_letter", "Categorization needs attention", automationTimes, m.dead_letter_count);
  if (blockedByAdmission) automation = dimension("blocked", m.dead_letter_count > 0 ? "unresolved_dead_letter" : m.stale_lease_count > 0 ? "stale_processing_lease" : "active_processing_lease",
    m.dead_letter_count > 0 ? "resolve_dead_letter" : "inspect_processing_lease", "Categorization admission is blocked", automationTimes,
    m.dead_letter_count || m.active_lease_count || m.stale_lease_count, { stage: "processing_admission", code: run.reason });
  if (automation.state === "processing" && m.active_lease_count === 0 && (eligibility.paid_entitlement === false || eligibility.processing_worker_enabled === false)) {
    automation = dimension("blocked", eligibility.paid_entitlement === false ? "paid_entitlement_required" : "processing_worker_disabled",
      eligibility.paid_entitlement === false ? "review_billing" : "inspect_processing_worker", "Categorization is paused", automationTimes, m.processing_count);
  }
  automation.missing = { categorization: m.missing_categorization, processing_admission: m.required_processing_admission_missing, required_processing_admission: m.required_processing_admission_missing, both: m.missing_both };
  automation.conflicts = { active_processing_leases: m.active_lease_count, stale_processing_leases: m.stale_lease_count, unresolved_dead_letters: m.dead_letter_count };
  if (eligibility.paid_entitlement === true && eligibility.processing_worker_enabled === true && ["processing", "failed"].includes(automation.state)
    && m.active_lease_count === 0 && m.stale_lease_count === 0 && m.dead_letter_count === 0 && m.automation_due_count === 0 && stamp(m.automation_retry_candidate_at) > stamp(observedAt)) {
    automation.next_retry_at = m.automation_retry_candidate_at;
  }

  const postTimes = { attempt: m.posting_last_attempt_at, success: m.posting_last_success_at, error: m.posting_error_at };
  let posting = dimension("active", "posting_available", "none", "QuickBooks posting available", postTimes, 0);
  if (!facts.qbo_token_status) posting = dimension("unknown", "qbo_connection_unverified", "inspect_quickbooks_connection", "QuickBooks connection is unverified", postTimes);
  if (facts.qbo_token_status === "disconnected" || facts.qbo_token_active === false) posting = dimension("held", "qbo_connection_inactive", "inspect_quickbooks_connection", "QuickBooks connection needs attention", postTimes);
  if (!facts.mapped_to_qbo) posting = dimension("held", "account_mapping_required", "review_account_mapping", "Account mapping required", postTimes);
  if (m.posting_failed_count > 0) posting = dimension("failed", "qbo_posting_failed", "review_posting", "QuickBooks posting needs attention", postTimes, m.posting_failed_count);
  if (!facts.auto_post_enabled || m.posting_hold_count > 0) posting = dimension("held", m.posting_hold_count > 0 ? "recovery_posting_hold" : "auto_post_disabled",
    m.posting_hold_count > 0 ? "reconcile_recovery_cohort" : "review_posting_policy", "QuickBooks posting held", postTimes, m.posting_hold_count);
  if (m.receipt_reconciliation_count > 0) posting = dimension("reconciling", "qbo_receipt_reconciliation_required", "reconcile_qbo_receipts",
    "QuickBooks receipts need reconciliation", postTimes, m.receipt_reconciliation_count);
  const authFailureCurrent = stamp(m.qbo_auth_error_at) > Math.max(stamp(m.posting_last_success_at), facts.qbo_token_status === "active" && facts.qbo_token_active ? stamp(facts.qbo_token_connected_at) : 0);
  if (authFailureCurrent || facts.qbo_token_status === "reauth_required") posting = dimension("QBO_reconnect_required", "qbo_authentication_failure",
    "reconnect_quickbooks", "Reconnect QuickBooks", { ...postTimes, error: m.qbo_auth_error_at || facts.qbo_token_status_at }, null, { stage: "qbo_auth", code: "qbo_authentication_failure" });
  if (posting.state === "active" && eligibility.posting_worker_enabled !== true) posting = dimension("held", "posting_worker_not_confirmed", "inspect_posting_worker", "Posting worker needs verification", postTimes);
  if (posting.state === "active" && eligibility.paid_entitlement === false) posting = dimension("held", "paid_entitlement_required", "review_billing", "QuickBooks posting held", postTimes);
  if (m.posting_hold_count > 0) {
    posting = dimension(m.receipt_reconciliation_count > 0 ? "reconciling" : "held", "recovery_posting_hold",
      "reconcile_recovery_cohort", "QuickBooks posting held for reconciliation", postTimes, m.posting_hold_count);
  }
  posting.held_count = m.posting_hold_count;
  posting.receipt_reconciliation_count = m.receipt_reconciliation_count;
  posting.blockers = { qbo_authentication_failure: authFailureCurrent || facts.qbo_token_status === "reauth_required", auto_post_disabled: !facts.auto_post_enabled, recovery_holds: m.posting_hold_count,
    receipt_reconciliation: m.receipt_reconciliation_count, entitlement_eligible: eligibility.paid_entitlement ?? null,
    worker_enabled: eligibility.posting_worker_enabled ?? null, mapping_missing: !facts.mapped_to_qbo };
  return { account_id: a.id, bank_connection: bank, transaction_import: imported, categorization_automation: automation, quickbooks_posting: posting };
}

export async function getPlaidAccountRecoveryStatus({ db, businessId, plaidEnv, qboEnv = process.env.QB_ENVIRONMENT || "production", eligibility = {} }) {
  const { data, error } = await db.rpc("get_plaid_account_recovery_facts", { p_business_id: businessId, p_plaid_env: plaidEnv, p_qbo_env: qboEnv });
  if (error) throw Object.assign(new Error("plaid_recovery_status_unavailable"), { code: "plaid_recovery_status_unavailable" });
  const accounts = data.accounts.map(f => ({ ...f.account, mapped_to_qbo: f.mapped_to_qbo,
    institution_id: f.item.institution_id, institution_name: f.item.institution_name,
    recovery_status: projectPlaidAccountRecoveryStatus(f, { observedAt: data.observed_at, eligibility }) }));
  const groups = new Map();
  for (const a of accounts) {
    const key = a.institution_id || a.plaid_item_id;
    const group = groups.get(key) || { institution_id: a.institution_id, institution_name: a.institution_name, accounts: [] };
    group.accounts.push(a); groups.set(key, group);
  }
  const institutions = [...groups.values()].map(g => ({ ...g, accounts_count: g.accounts.length,
    syncing_accounts_count: g.accounts.filter(a => ["connected", "institution_unavailable"].includes(a.recovery_status.bank_connection.state)).length }));
  return { contract_version: 1, settings: { import_freshness_hours: importFreshnessHours(), reconciliation_manifest_ttl_seconds: PLAID_RECOVERY_CONTRACT.reconciliationManifestTtlSeconds }, qbo_env: qboEnv, observed_at: data.observed_at, accounts, institutions, accounts_count: accounts.length,
    institutions_count: institutions.length, syncing_accounts_count: institutions.reduce((n, i) => n + i.syncing_accounts_count, 0) };
}

export function recoveryWorkerEligibility(paidEntitlement = false) {
  return { paid_entitlement: paidEntitlement, processing_worker_enabled: process.env.DISABLE_BOOKKEEPING_PROCESSING_WORKER !== "true",
    posting_worker_enabled: process.env.DISABLE_BOOKS_POST_CRON !== "true" };
}
