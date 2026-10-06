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

function recoveryError(code, message, status = 409) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
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

async function scopedItem({ db, businessId, plaidItemId }) {
  const { data, error } = await db.from("plaid_items")
    .select("id,business_id,plaid_item_id,plaid_env,plaid_access_token,cursor,institution_name,is_active")
    .eq("business_id", businessId).eq("plaid_env", plaidEnvName).eq("plaid_item_id", plaidItemId).maybeSingle();
  if (error) throw error;
  if (!data?.id || data.is_active === false) throw recoveryError("plaid_item_not_found", "The selected active Plaid connection was not found.", 404);
  return data;
}

export async function createReplacementRecoveryPreview({ businessId, plaidItemId, cutoffDate, actorUserId, db = supabase, plaid = getPlaidClient() }) {
  if (!plaid) throw recoveryError("plaid_not_configured", "Plaid is unavailable.", 503);
  const item = await scopedItem({ db, businessId, plaidItemId });
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

  const makeRows = (transactions, changeType) => transactions.map((transaction) => {
    const classification = classifyRecoveryTransaction({ transaction, changeType, existingRows: existing || [], cutoffDate, confirmedAccountIds: [...knownAccounts] });
    const normalized = normalizedIncoming(transaction);
    return { business_id: businessId, change_type: changeType, disposition: classification.disposition, ...normalized, payload: { transaction, classification } };
  });
  const rows = [
    ...makeRows(collected.added, "added"),
    ...makeRows(collected.modified, "modified"),
    ...(collected.removed || []).map((transaction) => ({
      business_id: businessId, change_type: "removed", disposition: (existing || []).some((row) => row.plaid_transaction_id === transaction.transaction_id) ? "removed_existing" : "ambiguous",
      plaid_transaction_id: transaction.transaction_id || null, payload: { transaction },
    })),
  ];
  const summary = { ...summarizeRecoveryRows(rows), pages: collected.pages.length, mutation_restarts: collected.mutation_restarts, unknown_account_ids: unknownAccounts };
  const batchId = crypto.randomUUID();
  const status = unknownAccounts.length ? "lineage_confirmation_required" : "preview_ready";
  const { error: batchError } = await db.from("plaid_recovery_batches").insert({
    id: batchId, business_id: businessId, plaid_env: item.plaid_env, plaid_item_id: plaidItemId,
    original_cursor: item.cursor || null, staged_next_cursor: collected.staged_next_cursor, cutoff_date: cutoffDate,
    status, posting_hold: true, summary, created_by: actorUserId || null,
  });
  if (batchError) throw batchError;
  if (rows.length) {
    const { error: rowError } = await db.from("plaid_recovery_batch_rows").insert(rows.map((row) => ({ ...row, batch_id: batchId })));
    if (rowError) throw rowError;
  }
  return { batch_id: batchId, plaid_item_id: plaidItemId, status, cutoff_date: cutoffDate, posting_hold: true, summary };
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

