import { normalizeTransactionResolution } from "./transactionResolutionService.js";

const IMMUTABLE_STATUSES = new Set(["posted", "final", "finalized", "excluded", "matched", "matched_existing_qbo"]);

export function deriveMonthlyReviewActionState({
  row = {},
  resolution,
  selectedAccountId = null,
  selectedMatchCandidate = false,
  selectedCreditCardCounterpart = false,
  activeOperation = false,
  duplicateRisk = false,
  duplicateRiskAcknowledged = false,
} = {}) {
  const selectedResolution = normalizeTransactionResolution(resolution) || "categorize_new";
  const status = String(row.status || row.cat_status || "needs_review").toLowerCase();
  const meta = row.meta || {};
  const immutable = IMMUTABLE_STATUSES.has(status) || Boolean(row.posted_at || row.qbo_txn_id || meta.finalized_at || meta.excluded_at || meta.matched_existing_qbo);
  if (immutable) return { kind: "protected", enabled: false, instruction: "This transaction is already finalized." };
  if (row.pending === true) return { kind: "protected", enabled: false, instruction: "Pending transactions cannot be approved." };
  if (activeOperation || meta.posting_in_progress === true || meta.operation_lease_id) {
    return { kind: "protected", enabled: false, instruction: "Another bookkeeping operation is in progress." };
  }
  if (selectedResolution === "categorize_new") {
    if (!selectedAccountId) return { kind: "approve_categorization", enabled: false, instruction: "Select a GL account to approve." };
    if (duplicateRisk && !duplicateRiskAcknowledged) return { kind: "approve_categorization", enabled: false, instruction: "Confirm the duplicate risk to continue.", requiresDuplicateRiskConfirmation: true };
    return { kind: "approve_categorization", enabled: true, label: "Approve", requiresDuplicateRiskConfirmation: duplicateRisk };
  }
  if (selectedResolution === "match_existing_qbo") {
    return selectedMatchCandidate
      ? { kind: "approve_qbo_match", enabled: true, label: "Approve Match" }
      : { kind: "find_qbo_match", enabled: true, label: "Match", instruction: "Find and select an existing QuickBooks transaction." };
  }
  if (selectedResolution === "match_credit_card_payment") {
    return selectedCreditCardCounterpart
      ? { kind: "confirm_credit_card_match", enabled: true, label: "Confirm Match" }
      : { kind: "confirm_credit_card_match", enabled: false, label: "Confirm Match", instruction: "Select the opposite-side payment." };
  }
  return { kind: "unsupported", enabled: false, instruction: "Complete this resolution before approving." };
}
