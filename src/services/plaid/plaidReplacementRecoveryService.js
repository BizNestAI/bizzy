import crypto from "crypto";
import { supabase } from "../supabaseAdmin.js";
import { getPlaidClient, plaidEnvName } from "./plaidClient.js";
import { resolveStoredPlaidAccessToken } from "./plaidTokenCrypto.js";
import {
  findPendingLifecycleCandidate,
  findProbableRelinkDuplicateCandidates,
  isPlaidMutationDuringPaginationError,
} from "./plaidCanonicalIdentity.js";
import { normalizePlaidAuthorizedDate, normalizePlaidPostedDate } from "../bookkeeping/accountingDatePolicy.js";

function recoveryError(code, message, status = 409, details = null) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
}

export function validateRecoveryReviewPopulation({ summary = {}, rows = [], replacementAccountId }) {
  const expectedCount = Number(summary.new_after_cutoff ?? summary.genuinely_new ?? 0);
  const reviewRows = (rows || []).filter((row) => row.disposition === "new_after_cutoff"
    && row.plaid_account_id === replacementAccountId);
  if (reviewRows.length !== expectedCount) {
    throw recoveryError(
      "recovery_preview_row_count_mismatch",
      "This recovery preview is incomplete and cannot be imported. Prepare a fresh recovery preview and try again.",
      409,
      { expected_count: expectedCount, staged_count: reviewRows.length },
    );
  }
  return { expected_count: expectedCount, staged_count: reviewRows.length, rows: reviewRows };
}

function normalizedIncoming(tx = {}) {
  const raw = Number(tx.amount || 0);
  return {
    plaid_transaction_id: tx.transaction_id || null,
    pending_transaction_id: tx.pending_transaction_id || null,
    plaid_account_id: tx.account_id || null,
    date: normalizePlaidPostedDate(tx.date),
    authorized_date: normalizePlaidAuthorizedDate(tx.authorized_date),
    amount: raw * -1,
    signed_amount: raw * -1,
    name: tx.name || tx.merchant_name || "Transaction",
    merchant_name: tx.merchant_name || null,
    pending: Boolean(tx.pending),
  };
}

export function toRecoveryBatchRow({ transaction, changeType, classification, businessId, batchId = null }) {
  const normalized = normalizedIncoming(transaction);
  return {
    ...(batchId ? { batch_id: batchId } : {}),
    business_id: businessId,
    change_type: changeType,
    disposition: classification.disposition,
    plaid_transaction_id: normalized.plaid_transaction_id,
    pending_transaction_id: normalized.pending_transaction_id,
    plaid_account_id: normalized.plaid_account_id,
    transaction_date: normalized.date,
    authorized_date: normalized.authorized_date,
    amount: normalized.amount,
    signed_amount: normalized.signed_amount,
    pending: normalized.pending,
    payload: { transaction, classification },
  };
}

export function normalizeRecoverySchemaContractError(error) {
  if (error?.code !== "PGRST204") return error;
  return recoveryError(
    "plaid_recovery_schema_contract_unavailable",
    "The recovery preview schema is temporarily unavailable. Nothing was imported; retry after the application update is deployed.",
    503,
    { upstream_code: error.code, upstream_message: error.message || null, upstream_details: error.details || null, upstream_hint: error.hint || null },
  );
}

export async function collectCompletePlaidSyncPreview({ plaid, accessToken, originalCursor = null, maxRestarts = 3 }) {
  let restartCount = 0;
  for (;;) {
    let cursor = originalCursor;
    let hasMore = true;
    const pages = [];
    try {
      while (hasMore) {
        const response = await plaid.transactionsSync({ access_token: accessToken, cursor: cursor || undefined });
        const page = response?.data || {};
        pages.push({ added: page.added || [], modified: page.modified || [], removed: page.removed || [] });
        cursor = page.next_cursor || cursor;
        hasMore = page.has_more === true;
      }
      return {
        original_cursor: originalCursor,
        staged_next_cursor: cursor,
        pages,
        added: pages.flatMap((page) => page.added),
        modified: pages.flatMap((page) => page.modified),
        removed: pages.flatMap((page) => page.removed),
        mutation_restarts: restartCount,
      };
    } catch (error) {
      if (!isPlaidMutationDuringPaginationError(error) || restartCount >= maxRestarts) throw error;
      restartCount += 1;
    }
  }
}

export function classifyRecoveryTransaction({ transaction, changeType = "added", existingRows = [], cutoffDate, confirmedAccountIds = [] }) {
  const row = normalizedIncoming(transaction);
  const exact = existingRows.find((candidate) => candidate.plaid_transaction_id === row.plaid_transaction_id);
  if (exact) return { disposition: changeType === "removed" ? "removed_existing" : "exact_existing", existing_id: exact.id };

  const pending = row.pending_transaction_id
    ? existingRows.find((candidate) => candidate.plaid_transaction_id === row.pending_transaction_id || candidate.pending_transaction_id === row.pending_transaction_id)
    : findPendingLifecycleCandidate(row, existingRows);
  if (pending) return { disposition: "pending_replacement", existing_id: pending.id };

  const effectiveDates = [row.date, row.authorized_date].filter(Boolean);
  if (effectiveDates.length === 0 || (effectiveDates.length === 2 && (effectiveDates[0] <= cutoffDate) !== (effectiveDates[1] <= cutoffDate))) {
    return { disposition: "ambiguous", reason: "cutoff_date_ambiguous" };
  }
  if (effectiveDates.every((date) => date <= cutoffDate)) return { disposition: "historical_discrepancy" };

  if (!confirmedAccountIds.includes(row.plaid_account_id)) {
    return { disposition: "ambiguous", reason: "replacement_lineage_confirmation_required" };
  }
  const probable = findProbableRelinkDuplicateCandidates(row, existingRows);
  if (probable.length) {
    return { disposition: "probable_duplicate", candidate_transaction_ids: probable.map((candidate) => candidate.id).filter(Boolean) };
  }
  return { disposition: "new_after_cutoff" };
}

export function summarizeRecoveryRows(rows = []) {
  const summary = {
    total_added: 0, total_modified: 0, total_removed: 0, exact_existing: 0,
    pending_replacements: 0, represented: 0, historical_discrepancies: 0,
    new_after_cutoff: 0, probable_duplicates: 0, ambiguous: 0, genuinely_new: 0,
  };
  for (const row of rows) {
    if (row.change_type === "added") summary.total_added += 1;
    if (row.change_type === "modified") summary.total_modified += 1;
    if (row.change_type === "removed") summary.total_removed += 1;
    if (row.disposition === "exact_existing") summary.exact_existing += 1;
    if (row.disposition === "pending_replacement") summary.pending_replacements += 1;
    if (row.disposition === "represented") summary.represented += 1;
    if (row.disposition === "historical_discrepancy") summary.historical_discrepancies += 1;
    if (row.disposition === "new_after_cutoff") summary.new_after_cutoff += 1;
    if (row.disposition === "probable_duplicate") summary.probable_duplicates += 1;
    if (row.disposition === "ambiguous") summary.ambiguous += 1;
  }
  summary.genuinely_new = summary.new_after_cutoff;
  return summary;
}

export function validateRecoveryPopulation({ summary = {}, rows = [], replacementAccountId }) {
  if ((rows || []).some((row) => row.plaid_account_id !== replacementAccountId)) {
    throw recoveryError("recovery_preview_account_scope_mismatch", "The rebuilt preview contains transactions outside the confirmed replacement account.", 409);
  }
  const addedRows = (rows || []).filter((row) => row.change_type === "added");
  const classifiedAdded = addedRows.filter((row) => [
    "exact_existing", "pending_replacement", "represented", "historical_discrepancy",
    "new_after_cutoff", "probable_duplicate", "ambiguous",
  ].includes(row.disposition));
  if (Number(summary.total_added || 0) !== addedRows.length || classifiedAdded.length !== addedRows.length) {
    throw recoveryError("recovery_preview_classification_mismatch", "The rebuilt preview classifications do not reconcile to the complete added population.", 409,
      { expected_added: Number(summary.total_added || 0), staged_added: addedRows.length, classified_added: classifiedAdded.length });
  }
  return { added_count: addedRows.length, classified_added_count: classifiedAdded.length };
}

async function scopedItem({ db, businessId, plaidItemId }) {
  const { data, error } = await db.from("plaid_items")
    .select("id,business_id,plaid_item_id,plaid_env,plaid_access_token,cursor,institution_name,is_active,replacement_recovery_status,replacement_recovery_account_id,replacement_recovery_cutoff_date,replacement_repair_completed_at")
    .eq("business_id", businessId).eq("plaid_env", plaidEnvName).eq("plaid_item_id", plaidItemId).maybeSingle();
  if (error) {
    if (error.code === "42703" || /replacement_recovery_/i.test(error.message || "")) {
      throw recoveryError("plaid_recovery_schema_unavailable", "The durable replacement-recovery migration is not available.", 503);
    }
    throw error;
  }
  if (!data?.id || data.is_active === false) throw recoveryError("plaid_item_not_found", "The selected active Plaid connection was not found.", 404);
  return data;
}

function safeCandidate(row = {}) {
  const snapshot = row.account_snapshot || {};
  return {
    id: row.id,
    plaid_account_id: row.plaid_account_id,
    status: row.status,
    name: snapshot.name || snapshot.official_name || "Replacement account",
    official_name: snapshot.official_name || null,
    mask: snapshot.mask || null,
    type: snapshot.type || null,
    subtype: snapshot.subtype || null,
    qbo_account_id: snapshot.qbo_account_id || null,
    qbo_account_name: snapshot.qbo_account_name || null,
    qbo_account_type: snapshot.qbo_account_type || null,
  };
}

export async function getReplacementRecoveryStatus({ businessId, plaidItemId, db = supabase }) {
  const item = await scopedItem({ db, businessId, plaidItemId });
  const { data: candidates, error: candidateError } = await db.from("plaid_replacement_account_candidates")
    .select("id,plaid_account_id,account_snapshot,status,created_at,decided_at")
    .eq("business_id", businessId).eq("plaid_env", plaidEnvName).eq("plaid_item_id", plaidItemId)
    .order("created_at", { ascending: false });
  if (candidateError) throw candidateError;
  const { data: batches, error: batchError } = await db.from("plaid_recovery_batches")
    .select("id,status,cutoff_date,posting_hold,summary,failure_code,failure_detail,rebuild_source_batch_id,created_at,updated_at")
    .eq("business_id", businessId).eq("plaid_env", plaidEnvName).eq("plaid_item_id", plaidItemId)
    .order("created_at", { ascending: false }).limit(20);
  if (batchError) throw batchError;
  // Never hydrate an abandoned audit record. Prefer the newest usable preview;
  // otherwise expose the newest in-flight/failed attempt so recovery can resume.
  let batch = (batches || []).find((row) => ["preview_ready", "imported_held", "released"].includes(row.status))
    || (batches || []).find((row) => row.status !== "abandoned") || null;
  let integrity = null;
  if (batch?.status === "preview_ready") {
    const expectedCount = Number(batch.summary?.new_after_cutoff ?? batch.summary?.genuinely_new ?? 0);
    const { count, error: countError } = await db.from("plaid_recovery_batch_rows").select("id", { count: "exact", head: true })
      .eq("business_id", businessId).eq("batch_id", batch.id)
      .eq("plaid_account_id", item.replacement_recovery_account_id).eq("disposition", "new_after_cutoff");
    if (countError) throw countError;
    integrity = { ok: Number(count || 0) === expectedCount, expected_count: expectedCount, staged_count: Number(count || 0) };
  }
  return {
    plaid_item_id: plaidItemId,
    orchestration: {
      status: item.replacement_recovery_status || null,
      selected_plaid_account_id: item.replacement_recovery_account_id || null,
      cutoff_date: item.replacement_recovery_cutoff_date || "2026-08-27",
      repair_completed_at: item.replacement_repair_completed_at || null,
    },
    recovery_required: Boolean(item.replacement_recovery_status && item.replacement_recovery_status !== "released")
      || Boolean((candidates || []).some((row) => row.status === "pending") || (batch && !["released", "abandoned"].includes(batch.status))),
    candidates: (candidates || []).map(safeCandidate),
    batch: batch ? {
      batch_id: batch.id,
      status: batch.status,
      cutoff_date: batch.cutoff_date,
      posting_hold: batch.posting_hold,
      summary: batch.summary || {},
      failure_code: batch.failure_code || null,
      failure_detail: batch.failure_detail || null,
      rebuild_source_batch_id: batch.rebuild_source_batch_id || null,
      integrity,
      created_at: batch.created_at,
      updated_at: batch.updated_at,
    } : null,
  };
}

export async function bootstrapReplacementRecoveryState({ businessId, plaidItemId, actorUserId, db = supabase }) {
  await scopedItem({ db, businessId, plaidItemId });
  const { data, error } = await db.rpc("bootstrap_plaid_replacement_recovery", {
    p_business_id: businessId, p_plaid_env: plaidEnvName, p_plaid_item_id: plaidItemId, p_actor_user_id: actorUserId || null,
  });
  if (error) throw recoveryError("plaid_recovery_bootstrap_failed", "Recovery state could not be reconstructed. Verify the recovery migration and retry.");
  return data;
}

export async function selectReplacementRecoveryAccount({ businessId, plaidItemId, plaidAccountId, actorUserId, db = supabase }) {
  await scopedItem({ db, businessId, plaidItemId });
  if (!plaidAccountId) throw recoveryError("replacement_account_required", "Select the replacement card account.", 400);
  const { data, error } = await db.rpc("select_plaid_replacement_recovery_account", {
    p_business_id: businessId, p_plaid_env: plaidEnvName, p_plaid_item_id: plaidItemId,
    p_plaid_account_id: plaidAccountId, p_actor_user_id: actorUserId || null,
  });
  if (error) throw recoveryError(error.message?.includes("mapping") ? "replacement_account_qbo_mapping_required" : "replacement_candidate_persistence_failed", "The replacement account selection could not be saved.");
  return data;
}

export async function confirmReplacementAccountLineage({ businessId, plaidItemId, candidateId, priorPlaidAccountId, actorUserId, db = supabase }) {
  await scopedItem({ db, businessId, plaidItemId });
  if (!candidateId || !priorPlaidAccountId) throw recoveryError("invalid_lineage_confirmation", "Select the prior account represented by this replacement card.", 400);
  const { data, error } = await db.rpc("confirm_plaid_replacement_lineage_and_advance", {
    p_business_id: businessId,
    p_plaid_env: plaidEnvName,
    p_plaid_item_id: plaidItemId,
    p_candidate_id: candidateId,
    p_prior_plaid_account_id: priorPlaidAccountId,
    p_actor_user_id: actorUserId || null,
  });
  if (error) throw recoveryError(
    /lineage_state_persistence_failed/.test(error.message || "") ? "lineage_state_persistence_failed" : "lineage_confirmation_failed",
    error.message || "Account lineage could not be confirmed.",
  );
  return data || { status: "confirmed" };
}

export async function listReplacementRecoveryRows({ businessId, plaidItemId, batchId, page = 1, pageSize = 25, search = "", dateFrom = null, dateTo = null, sort = "oldest", db = supabase }) {
  const item = await scopedItem({ db, businessId, plaidItemId });
  if (!item.replacement_recovery_account_id) throw recoveryError("replacement_account_required", "Confirm the replacement account before reviewing transactions.", 409);
  const { data: batch, error: batchError } = await db.from("plaid_recovery_batches")
    .select("id,status,cutoff_date,posting_hold,summary")
    .eq("id", batchId).eq("business_id", businessId).eq("plaid_env", item.plaid_env).eq("plaid_item_id", plaidItemId).maybeSingle();
  if (batchError) throw batchError;
  if (!batch || !["preview_ready", "imported_held"].includes(batch.status)) throw recoveryError("recovery_batch_not_reviewable", "The active recovery preview could not be found.", 404);
  const { data, error } = await db.from("plaid_recovery_batch_rows")
    .select("id,plaid_transaction_id,plaid_account_id,transaction_date,authorized_date,amount,signed_amount,pending,disposition,payload,admitted_transaction_id")
    .eq("business_id", businessId).eq("batch_id", batchId).eq("plaid_account_id", item.replacement_recovery_account_id)
    .eq("disposition", "new_after_cutoff");
  if (error) throw error;
  const integrity = validateRecoveryReviewPopulation({
    summary: batch.summary || {}, rows: data || [], replacementAccountId: item.replacement_recovery_account_id,
  });
  const sanitized = integrity.rows.map((row) => {
    const transaction = row.payload?.transaction || {};
    const name = transaction.merchant_name || transaction.name || "Transaction";
    const amount = Number(row.signed_amount ?? row.amount ?? 0);
    const normalizedName = String(name).toLowerCase();
    const activityType = amount < 0 ? "charge" : /payment/.test(normalizedName) ? "payment" : /statement\s+credit|credit/.test(normalizedName) ? "statement_credit" : "refund";
    return { id: row.id, plaid_transaction_id: row.plaid_transaction_id, transaction_date: row.transaction_date, authorized_date: row.authorized_date,
      merchant_or_description: name, amount, pending: row.pending === true, classification: row.disposition, activity_type: activityType,
      admitted: Boolean(row.admitted_transaction_id) };
  });
  const needle = String(search || "").trim().toLowerCase();
  const filtered = sanitized.filter((row) => (!needle || row.merchant_or_description.toLowerCase().includes(needle))
    && (!dateFrom || row.transaction_date >= dateFrom) && (!dateTo || row.transaction_date <= dateTo));
  filtered.sort((a, b) => sort === "newest" ? b.transaction_date.localeCompare(a.transaction_date)
    : sort === "amount" ? Math.abs(b.amount) - Math.abs(a.amount) : a.transaction_date.localeCompare(b.transaction_date));
  const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 25));
  const safePage = Math.max(1, Number(page) || 1);
  const start = (safePage - 1) * safePageSize;
  return { batch_id: batch.id, plaid_item_id: plaidItemId, status: batch.status, cutoff_date: batch.cutoff_date, posting_hold: batch.posting_hold,
    summary: batch.summary || {}, integrity: { ok: true, expected_count: integrity.expected_count, staged_count: integrity.staged_count },
    page: safePage, page_size: safePageSize, total: filtered.length, rows: filtered.slice(start, start + safePageSize),
    eligible_row_ids: sanitized.filter((row) => !row.admitted).map((row) => row.id) };
}

export async function admitReplacementRecoveryBatch({ businessId, plaidItemId, batchId, selectedRowIds, actorUserId, db = supabase }) {
  const item = await scopedItem({ db, businessId, plaidItemId });
  if (!Array.isArray(selectedRowIds) || selectedRowIds.length === 0) throw recoveryError("recovery_selection_required", "Select at least one staged transaction.", 400);
  if (new Set(selectedRowIds).size !== selectedRowIds.length) throw recoveryError("duplicate_recovery_row_selection", "The transaction selection contains duplicates.", 400);
  const { data: batch, error: batchError } = await db.from("plaid_recovery_batches").select("id,status")
    .eq("id", batchId).eq("business_id", businessId).eq("plaid_env", item.plaid_env).eq("plaid_item_id", plaidItemId).maybeSingle();
  if (batchError) throw batchError;
  if (!batch || batch.status !== "preview_ready") throw recoveryError("recovery_batch_not_admissible", "Only the active valid recovery preview can be admitted.", 409);
  const { data, error } = await db.rpc("admit_plaid_recovery_batch", {
    p_business_id: businessId,
    p_batch_id: batchId,
    p_plaid_item_id: plaidItemId,
    p_selected_row_ids: selectedRowIds,
    p_actor_user_id: actorUserId || null,
  });
  if (error) throw recoveryError("recovery_admission_failed", error.message || "Recovery transactions could not be admitted.");
  return data || { batch_id: batchId, status: "imported_held", posting_hold: true };
}

export async function createReplacementRecoveryPreview({ businessId, plaidItemId, cutoffDate, actorUserId, db = supabase, plaid = getPlaidClient() }) {
  if (!plaid) throw recoveryError("plaid_not_configured", "Plaid is unavailable.", 503);
  const item = await scopedItem({ db, businessId, plaidItemId });
  const { data: activeBatches, error: activeBatchError } = await db.from("plaid_recovery_batches")
    .select("id,status,cutoff_date,posting_hold,summary")
    .eq("business_id", businessId).eq("plaid_env", item.plaid_env).eq("plaid_item_id", plaidItemId)
    .eq("cutoff_date", cutoffDate).in("status", ["staging", "preview_ready", "lineage_confirmation_required", "imported_held"])
    .order("created_at", { ascending: false }).limit(1);
  if (activeBatchError) throw activeBatchError;
  if (activeBatches?.[0]) {
    const active = activeBatches[0];
    if (active.status === "preview_ready") {
      const { data: stagedRows, error: stagedRowsError } = await db.from("plaid_recovery_batch_rows")
        .select("id,plaid_account_id,disposition").eq("business_id", businessId).eq("batch_id", active.id)
        .eq("plaid_account_id", item.replacement_recovery_account_id).eq("disposition", "new_after_cutoff");
      if (stagedRowsError) throw stagedRowsError;
      validateRecoveryReviewPopulation({ summary: active.summary || {}, rows: stagedRows || [], replacementAccountId: item.replacement_recovery_account_id });
    }
    return { batch_id: active.id, plaid_item_id: plaidItemId, status: active.status, cutoff_date: active.cutoff_date, posting_hold: active.posting_hold, summary: active.summary || {}, reused: true };
  }
  if (!item.replacement_recovery_account_id) throw recoveryError("replacement_account_required", "Confirm the replacement account before preparing a preview.");
  const accessToken = await resolveStoredPlaidAccessToken({ storedToken: item.plaid_access_token });
  const collected = await collectCompletePlaidSyncPreview({ plaid, accessToken, originalCursor: item.cursor || null });
  const accountIds = [...new Set([...collected.added, ...collected.modified].map((tx) => tx.account_id).filter(Boolean))];
  const { data: accounts, error: accountError } = await db.from("plaid_accounts")
    .select("plaid_account_id,physical_account_id").eq("business_id", businessId).eq("plaid_item_id", plaidItemId);
  if (accountError) throw accountError;
  const knownAccounts = new Set((accounts || []).map((row) => row.plaid_account_id));
  const unknownAccounts = accountIds.filter((id) => !knownAccounts.has(id));
  const { data: existing, error: existingError } = await db.from("bank_transactions")
    .select("id,plaid_transaction_id,pending_transaction_id,plaid_account_id,physical_account_id,date,authorized_date,amount,signed_amount,name,merchant_name,pending,is_archived")
    .eq("business_id", businessId);
  if (existingError) throw existingError;

  const recoveryAccountId = item.replacement_recovery_account_id;
  const makeRows = (transactions, changeType) => transactions.filter((transaction) => transaction.account_id === recoveryAccountId).map((transaction) => {
    const classification = classifyRecoveryTransaction({ transaction, changeType, existingRows: existing || [], cutoffDate, confirmedAccountIds: [recoveryAccountId] });
    return toRecoveryBatchRow({ transaction, changeType, classification, businessId });
  });
  const rows = [
    ...makeRows(collected.added, "added"),
    ...makeRows(collected.modified, "modified"),
    ...(collected.removed || []).filter((transaction) => (existing || []).some((row) => row.plaid_transaction_id === transaction.transaction_id && row.plaid_account_id === recoveryAccountId)).map((transaction) => ({
      business_id: businessId, change_type: "removed", disposition: (existing || []).some((row) => row.plaid_transaction_id === transaction.transaction_id) ? "removed_existing" : "ambiguous",
      plaid_transaction_id: transaction.transaction_id || null, payload: { transaction },
    })),
  ];
  const summary = { ...summarizeRecoveryRows(rows), pages: collected.pages.length, mutation_restarts: collected.mutation_restarts, unknown_account_ids: unknownAccounts };
  const batchId = crypto.randomUUID();
  const status = unknownAccounts.includes(recoveryAccountId) ? "lineage_confirmation_required" : "preview_ready";
  const { error: batchError } = await db.from("plaid_recovery_batches").insert({
    id: batchId, business_id: businessId, plaid_env: item.plaid_env, plaid_item_id: plaidItemId,
    original_cursor: item.cursor || null, staged_next_cursor: collected.staged_next_cursor, cutoff_date: cutoffDate,
    status: "staging", posting_hold: true, summary, created_by: actorUserId || null,
  });
  if (batchError) throw batchError;
  if (rows.length) {
    const { error: rowError } = await db.from("plaid_recovery_batch_rows").insert(rows.map((row) => ({ ...row, batch_id: batchId })));
    if (rowError) {
      await db.from("plaid_recovery_batches").update({ status: "failed", failure_code: "recovery_row_staging_failed", failure_detail: rowError.message || null })
        .eq("business_id", businessId).eq("id", batchId);
      throw recoveryError("recovery_row_staging_failed", "Recovery transactions could not be staged. Nothing was imported.", 503);
    }
  }
  validateRecoveryReviewPopulation({ summary, rows, replacementAccountId: recoveryAccountId });
  const { error: readyError } = await db.from("plaid_recovery_batches").update({ status }).eq("business_id", businessId).eq("id", batchId).eq("status", "staging");
  if (readyError) throw recoveryError("recovery_preview_finalize_failed", "The recovery preview could not be finalized. Nothing was imported.", 503);
  return { batch_id: batchId, plaid_item_id: plaidItemId, status, cutoff_date: cutoffDate, posting_hold: true, summary };
}

async function claimRecoveryLease({ db, item, businessId, owner }) {
  const { data, error } = await db.rpc("claim_plaid_sync_lease", {
    p_item_id: item.id, p_business_id: businessId, p_owner: owner, p_ttl_seconds: 300,
  });
  if (error) throw error;
  if (data !== true) throw recoveryError("recovery_rebuild_in_progress", "A recovery preview rebuild is already running.", 202);
}

async function releaseRecoveryLease({ db, item, businessId, owner }) {
  const { error } = await db.rpc("release_plaid_sync_lease", { p_item_id: item.id, p_business_id: businessId, p_owner: owner });
  if (error) console.warn("[plaid-recovery] rebuild lease release failed", { business_id: businessId, plaid_item_id: item.plaid_item_id });
}

export async function rebuildReplacementRecoveryPreview({ businessId, plaidItemId, batchId, actorUserId, idempotencyKey, db = supabase, plaid = getPlaidClient() }) {
  if (!plaid) throw recoveryError("plaid_not_configured", "Plaid is unavailable.", 503);
  const item = await scopedItem({ db, businessId, plaidItemId });
  if (!item.replacement_recovery_account_id) throw recoveryError("replacement_account_required", "Confirmed replacement-card lineage is required.");
  const { data: handoff, error: handoffError } = await db.rpc("begin_plaid_recovery_preview_rebuild", {
    p_business_id: businessId, p_plaid_env: item.plaid_env, p_plaid_item_id: plaidItemId, p_batch_id: batchId,
    p_actor_user_id: actorUserId || null, p_idempotency_key: idempotencyKey,
  });
  if (handoffError) throw recoveryError(handoffError.message || "recovery_rebuild_validation_failed", "This recovery preview is not eligible for a controlled rebuild.");
  const newBatchId = handoff?.batch_id;
  if (!handoff?.created) {
    if (handoff?.status === "preview_ready") {
      const status = await getReplacementRecoveryStatus({ businessId, plaidItemId, db });
      return { ...status.batch, batch_id: newBatchId, reused: true, previous_expected_count: handoff.previous_expected_count || null };
    }
    return { batch_id: newBatchId, status: handoff?.status || "staging", posting_hold: true, reused: true, processing: true };
  }

  const leaseOwner = `recovery-rebuild:${newBatchId}`;
  try {
    await claimRecoveryLease({ db, item, businessId, owner: leaseOwner });
    const accessToken = await resolveStoredPlaidAccessToken({ storedToken: item.plaid_access_token });
    const collected = await collectCompletePlaidSyncPreview({ plaid, accessToken, originalCursor: item.cursor || null });
    const { data: existing, error: existingError } = await db.from("bank_transactions")
      .select("id,plaid_transaction_id,pending_transaction_id,plaid_account_id,physical_account_id,date,authorized_date,amount,signed_amount,name,merchant_name,pending,is_archived")
      .eq("business_id", businessId);
    if (existingError) throw existingError;
    const recoveryAccountId = item.replacement_recovery_account_id;
    const cutoffDate = item.replacement_recovery_cutoff_date;
    const makeRows = (transactions, changeType) => transactions.filter((transaction) => transaction.account_id === recoveryAccountId).map((transaction) => {
      const classification = classifyRecoveryTransaction({ transaction, changeType, existingRows: existing || [], cutoffDate, confirmedAccountIds: [recoveryAccountId] });
      return toRecoveryBatchRow({ transaction, changeType, classification, businessId, batchId: newBatchId });
    });
    const rows = [...makeRows(collected.added, "added"), ...makeRows(collected.modified, "modified")];
    const summary = { ...summarizeRecoveryRows(rows), pages: collected.pages.length, mutation_restarts: collected.mutation_restarts,
      rebuild_previous_expected_count: Number(handoff.previous_expected_count || 0) };
    if (rows.length) {
      const { error } = await db.from("plaid_recovery_batch_rows").upsert(rows, { onConflict: "batch_id,change_type,plaid_transaction_id", ignoreDuplicates: true });
      if (error) throw error;
    }
    const { data: durable, error: durableError } = await db.from("plaid_recovery_batch_rows")
      .select("id,plaid_transaction_id,plaid_account_id,change_type,disposition").eq("business_id", businessId).eq("batch_id", newBatchId)
      .eq("plaid_account_id", recoveryAccountId);
    if (durableError) throw durableError;
    // The durable copy, not the in-memory Plaid response, is the readiness authority.
    validateRecoveryPopulation({ summary, rows: durable || [], replacementAccountId: recoveryAccountId });
    validateRecoveryReviewPopulation({ summary, rows: durable || [], replacementAccountId: recoveryAccountId });
    const { data: ready, error: readyError } = await db.from("plaid_recovery_batches").update({ status: "preview_ready", posting_hold: true,
      staged_next_cursor: collected.staged_next_cursor, summary, failure_code: null, failure_detail: null, updated_at: new Date().toISOString() })
      .eq("id", newBatchId).eq("business_id", businessId).eq("status", "staging").select("id").maybeSingle();
    if (readyError || !ready?.id) throw recoveryError("recovery_preview_finalize_failed", "The rebuilt preview could not be finalized.", 503);
    return { batch_id: newBatchId, source_batch_id: batchId, plaid_item_id: plaidItemId, status: "preview_ready",
      cutoff_date: cutoffDate, posting_hold: true, summary, previous_expected_count: Number(handoff.previous_expected_count || 0) };
  } catch (error) {
    await db.from("plaid_recovery_batches").update({ status: "failed", failure_code: error?.code || "recovery_rebuild_failed",
      failure_detail: error?.message || null, updated_at: new Date().toISOString() }).eq("id", newBatchId).eq("business_id", businessId).eq("status", "staging");
    const safeError = normalizeRecoverySchemaContractError(error);
    throw safeError?.code ? safeError : recoveryError("recovery_rebuild_failed", "The recovery preview could not be rebuilt. Nothing was imported and the cursor was preserved.", 503);
  } finally {
    await releaseRecoveryLease({ db, item, businessId, owner: leaseOwner });
  }
}

export async function releaseReplacementRecoveryHold({ businessId, batchId, actorUserId, db = supabase }) {
  const { data: batch, error } = await db.from("plaid_recovery_batches").select("id,status,posting_hold")
    .eq("id", batchId).eq("business_id", businessId).maybeSingle();
  if (error) throw error;
  if (!batch?.id) throw recoveryError("recovery_batch_not_found", "Recovery batch not found.", 404);
  if (batch.status !== "imported_held") throw recoveryError("recovery_batch_not_reviewed", "Import and review the recovery batch before releasing its posting hold.");
  const now = new Date().toISOString();
  const { error: updateError } = await db.from("transaction_categorizations").update({ posting_hold_batch_id: null, updated_at: now })
    .eq("business_id", businessId).eq("posting_hold_batch_id", batchId);
  if (updateError) throw updateError;
  const { error: batchUpdateError } = await db.from("plaid_recovery_batches").update({ status: "released", posting_hold: false, released_by: actorUserId || null, released_at: now, updated_at: now })
    .eq("business_id", businessId).eq("id", batchId).eq("posting_hold", true);
  if (batchUpdateError) throw batchUpdateError;
  return { batch_id: batchId, status: "released", posting_hold: false };
}
