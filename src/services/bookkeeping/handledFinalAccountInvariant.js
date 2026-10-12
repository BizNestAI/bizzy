const HANDLED_STATUSES = new Set(["auto_approved", "approved", "handled"]);
const ORDINARY_EXPENSE_ACCOUNT_TYPES = new Set(["expense", "otherexpense", "costofgoodssold"]);

function normalized(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function enforceHandledFinalAccountInvariant(payload = {}) {
  const next = { ...payload, meta: { ...(payload.meta || {}) } };
  const handled = HANDLED_STATUSES.has(String(next.status || "").toLowerCase());
  if (!handled || (next.final_qbo_account_id && next.final_qbo_account_name)) return next;
  next.status = "needs_review";
  next.review_status = "needs_review";
  next.final_qbo_account_id = null;
  next.final_qbo_account_name = null;
  next.final_canonical_account_key = null;
  next.post_after = null;
  next.post_error = null;
  next.decided_by = null;
  next.decided_at = null;
  next.meta.safe_to_auto_handle = false;
  next.meta.safe_to_auto_post = false;
  next.meta.auto_approve_reason = null;
  next.meta.post_block_reason = "missing_final_qbo_account";
  next.meta.handled_final_account_invariant = "rejected_partial_auto_approval";
  return next;
}

export function resolveMissingFinalAccount({ categorization = {}, bankTransaction = {}, qboAccounts = [] } = {}) {
  const taxonomy = normalized(categorization.meta?.taxonomy_type);
  const direction = String(bankTransaction.direction || "").toUpperCase();
  if (bankTransaction.pending === true || direction !== "OUTFLOW" || taxonomy) return { kind: "not_ordinary" };

  const compatible = qboAccounts.filter((account) =>
    account?.active !== false && ORDINARY_EXPENSE_ACCOUNT_TYPES.has(normalized(account?.account_type).replace(/ /g, ""))
  );
  const finalId = String(categorization.final_qbo_account_id || "").trim();
  const existingFinal = compatible.filter((account) => String(account.qbo_account_id) === finalId);
  if (existingFinal.length === 1 && categorization.final_qbo_account_name) return { kind: "not_required", account: existingFinal[0] };

  const authoritativeId = finalId || String(categorization.suggested_qbo_account_id || "").trim();
  if (authoritativeId) {
    const exact = compatible.filter((account) => String(account.qbo_account_id) === authoritativeId);
    if (exact.length === 1) return { kind: "resolved", account: exact[0], authority: finalId ? "existing_final_qbo_account_id" : "suggested_qbo_account_id" };
    if (exact.length > 1) return { kind: "ambiguous", reason: "missing_final_qbo_account_ambiguous" };
  }

  const suggestedNames = new Set([
    categorization.suggested_qbo_account_name,
    categorization.meta?.semantic_coa_match?.qbo_account_name,
    categorization.meta?.universal_vendor_hint?.qbo_account_name,
  ].map(normalized).filter(Boolean));
  const nameMatches = compatible.filter((account) => {
    const aliases = [account.name, account.fully_qualified_name].map(normalized).filter(Boolean);
    return aliases.some((alias) => suggestedNames.has(alias));
  });
  if (nameMatches.length === 1) return { kind: "resolved", account: nameMatches[0], authority: "unique_exact_account_name" };
  return {
    kind: nameMatches.length > 1 ? "ambiguous" : "unresolved",
    reason: nameMatches.length > 1 ? "missing_final_qbo_account_ambiguous" : "missing_final_qbo_account_unresolved",
  };
}

export default { enforceHandledFinalAccountInvariant, resolveMissingFinalAccount };
