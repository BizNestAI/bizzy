export const TRANSACTION_RESOLUTIONS = Object.freeze([
  "categorize_new",
  "match_existing_qbo",
  "match_credit_card_payment",
  "split_transaction",
]);

export function normalizeTransactionResolution(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "create_new_income" || normalized === "categorize_as_new") return "categorize_new";
  if (normalized === "match_existing" || normalized === "match_existing_quickbooks") return "match_existing_qbo";
  if (normalized === "credit_card_payment") return "match_credit_card_payment";
  if (normalized === "loan_payment" || normalized === "loan_split" || normalized === "general_split") return "split_transaction";
  return TRANSACTION_RESOLUTIONS.includes(normalized) ? normalized : null;
}

export function suggestedTransactionResolution(transaction = {}) {
  const meta = transaction.meta || {};
  const persistedSuggestion = normalizeTransactionResolution(meta.system_suggested_resolution);
  if (persistedSuggestion) return persistedSuggestion;
  const incomingStatus = transaction.incoming_deposit_match_status || meta.incoming_deposit_match_status;
  const incomingId = transaction.incoming_deposit_match_id || meta.incoming_deposit_match_id;
  if (incomingId || ["candidate", "needs_confirmation", "ambiguous", "match_check_unavailable"].includes(String(incomingStatus || ""))) return "match_existing_qbo";
  const taxonomy = String(transaction.taxonomy_type || meta.taxonomy_type || "").toLowerCase();
  if (taxonomy === "cc_payment" || transaction.cc_payment_pair_id || meta.cc_payment_pair_id) return "match_credit_card_payment";
  if (["split_transaction", "loan_payment", "loan_movement"].includes(taxonomy) || meta.split_transaction_id || meta.loan_payment_split_id) return "split_transaction";
  return "categorize_new";
}

export function effectiveTransactionResolution(transaction = {}) {
  return normalizeTransactionResolution(transaction.meta?.user_selected_resolution) || suggestedTransactionResolution(transaction);
}

export function recoverOrphanedSplitResolution(resolution, hasActiveSplitDraft = false) {
  const normalized = normalizeTransactionResolution(resolution) || "categorize_new";
  return normalized === "split_transaction" && !hasActiveSplitDraft ? "categorize_new" : normalized;
}

export async function persistTransactionResolution({ db, businessId, transactionId, resolution, actor = null, source = "books_review" } = {}) {
  const normalized = normalizeTransactionResolution(resolution);
  if (!db || !businessId || !transactionId || !normalized) {
    const error = new Error("invalid_transaction_resolution");
    error.code = "invalid_transaction_resolution";
    error.status = 400;
    throw error;
  }
  const { data: current, error: fetchError } = await db.from("transaction_categorizations")
    .select("status,posted_at,qbo_txn_id,final_qbo_account_id,meta")
    .eq("business_id", businessId).eq("transaction_id", transactionId).maybeSingle();
  if (fetchError) throw fetchError;
  if (current?.status === "posted" || current?.posted_at || current?.qbo_txn_id || current?.meta?.matched_existing_qbo === true) {
    const error = new Error("transaction_already_resolved");
    error.code = "transaction_already_resolved";
    error.status = 409;
    throw error;
  }
  const systemSuggested = suggestedTransactionResolution({ ...current, meta: current?.meta || {} });
  const now = new Date().toISOString();
  const nextMeta = {
    ...(current?.meta || {}),
    system_suggested_resolution: current?.meta?.system_suggested_resolution || systemSuggested,
    user_selected_resolution: normalized,
    resolution_selected_by: actor,
    resolution_selected_at: now,
    resolution_selection_source: source,
  };
  if (normalized === "match_credit_card_payment") {
    nextMeta.taxonomy_type = "cc_payment";
    nextMeta.taxonomy_subtype = "credit_card_payment";
    nextMeta.taxonomy_override = "cc_payment";
    nextMeta.cc_payment_rejected = false;
    nextMeta.cc_payment_marked_by_user = true;
    nextMeta.cc_payment_marked_at = now;
    nextMeta.post_block_reason = "cc_payment_pair_requires_confirmation";
    nextMeta.safe_to_auto_handle = false;
    nextMeta.safe_to_auto_post = false;
    // This is an explicit operator-controlled lifecycle change. These audit
    // fields allow the review-state trigger to distinguish it from an
    // accidental approved -> needs_review regression.
    nextMeta.review_reopen_authorized = true;
    nextMeta.review_reopen_reason = "user_selected_credit_card_payment_match";
    delete nextMeta.cc_payment_rejected_at;
    delete nextMeta.cc_payment_rejected_pair_id;
  }
  const payload = {
    business_id: businessId,
    transaction_id: transactionId,
    status: normalized === "match_credit_card_payment" ? "needs_review" : current?.status || "needs_review",
    meta: nextMeta,
    updated_at: now,
  };
  if (normalized === "match_credit_card_payment") {
    Object.assign(payload, {
      suggested_qbo_account_id: null,
      suggested_qbo_account_name: null,
      suggested_canonical_account_key: null,
      final_qbo_account_id: null,
      final_qbo_account_name: null,
      final_canonical_account_key: null,
      post_after: null,
      post_error: "cc_payment_pair_requires_confirmation",
    });
  }
  const { data, error } = await db.from("transaction_categorizations").upsert(payload, { onConflict: "business_id,transaction_id" }).select("transaction_id,status,meta").maybeSingle();
  if (error) throw error;
  return { ok: true, transaction_id: transactionId, system_suggested_resolution: nextMeta.system_suggested_resolution, user_selected_resolution: normalized, effective_resolution: normalized, row: data || payload };
}
