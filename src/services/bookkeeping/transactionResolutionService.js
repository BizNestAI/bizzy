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

export async function persistTransactionResolution({ db, businessId, transactionId, resolution, actor = null, source = "books_review" } = {}) {
  const normalized = normalizeTransactionResolution(resolution);
  if (!db || !businessId || !transactionId || !normalized) {
    const error = new Error("invalid_transaction_resolution");
    error.code = "invalid_transaction_resolution";
    error.status = 400;
    throw error;
  }
  const { data: current, error: fetchError } = await db.from("transaction_categorizations")
    .select("status,posted_at,qbo_txn_id,meta")
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
  const payload = {
    business_id: businessId,
    transaction_id: transactionId,
    status: current?.status || "needs_review",
    meta: nextMeta,
    updated_at: now,
  };
  const { data, error } = await db.from("transaction_categorizations").upsert(payload, { onConflict: "business_id,transaction_id" }).select("transaction_id,status,meta").maybeSingle();
  if (error) throw error;
  return { ok: true, transaction_id: transactionId, system_suggested_resolution: nextMeta.system_suggested_resolution, user_selected_resolution: normalized, effective_resolution: normalized, row: data || payload };
}
