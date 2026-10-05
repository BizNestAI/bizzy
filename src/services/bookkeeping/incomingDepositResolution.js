export const INCOMING_DEPOSIT_CATEGORIZE_AS_NEW = "categorize_as_new";

export function hasFinalCategorizeAsNewResolution(row = {}) {
  const meta = row.meta || row;
  const decision = meta.incoming_deposit_resolution;
  const mode = String(
    meta.resolution_mode ||
    decision?.resolution_mode ||
    decision?.resolution ||
    (decision === "categorized_as_new" ? INCOMING_DEPOSIT_CATEGORIZE_AS_NEW : "") ||
    meta.user_selected_resolution ||
    ""
  ).toLowerCase();
  const approved = Boolean(
    decision?.approved_at ||
    decision?.decided_at ||
    meta.manual_qbo_account_selection === true ||
    meta.auto_approve_reason === "manual_user"
  );
  return mode === INCOMING_DEPOSIT_CATEGORIZE_AS_NEW && approved && Boolean(
    row.final_qbo_account_id || meta.final_qbo_account_id || decision?.selected_qbo_account_id
  );
}

export function hasActiveConfirmedIncomingDepositMatch(row = {}) {
  const meta = row.meta || row;
  return meta.matched_existing_qbo === true || String(meta.incoming_deposit_match_status || "").toLowerCase() === "confirmed";
}

export function isPreProviderIncomingDepositMatchFailure(row = {}) {
  const meta = row.meta || {};
  const reason = String(row.post_error || meta.post_block_reason || "").toLowerCase();
  return reason === "incoming_deposit_needs_match" &&
    !row.qbo_txn_id &&
    !meta.provider_write_started_at &&
    !meta.qbo_write_started_at &&
    !meta.qbo_receipt_confirmed_at;
}
