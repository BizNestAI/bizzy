// Optimistic display only. The authenticated Undo operation revokes authority.
export function splitUndoReviewState(row) {
  if (row.meta?.taxonomy_type !== "split_transaction" && !row.meta?.split_transaction_id) {
    return { ...row, status: "needs_review" };
  }
  const meta = { ...row.meta };
  for (const key of ["taxonomy_type", "split_transaction_id", "split_transaction_status", "posting_shape_binding", "posting_shape_expected", "user_selected_resolution"]) delete meta[key];
  if (meta.protected_workflow === "split_transaction") delete meta.protected_workflow;
  return {
    ...row, meta: { ...meta, split_undo_audit: { at: "optimistic" } }, status: "needs_review", review_status: "needs_review",
    taxonomy_type: null,
    split_transaction: null, split_lines: [],
    final_qbo_account_id: null, final_qbo_account_name: null, final_canonical_account_key: null,
    glAccountId: null, glAccountName: null, accountId: null,
    effective_account_id: null, effective_account_name: null,
    post_after: null, post_error: null, posting_status: "not_scheduled",
  };
}
