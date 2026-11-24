import { isReopenedSplitDecision } from "./splitUndoReviewState.js";

// Only invoke during an authenticated manual decision, never during feed reads.
export async function resetReopenedSplitDecision({ db, businessId, transactionId, actorId, current }) {
  if (!isReopenedSplitDecision(current)) return current;
  const { error } = await db.rpc("undo_split_categorization", {
    p_business_id: businessId, p_transaction_id: transactionId, p_actor_id: actorId,
  });
  if (error) {
    const failure = new Error(error.message || "split_decision_reset_failed");
    failure.code = error.message || "split_decision_reset_failed";
    failure.status = 409;
    if (failure.code === "split_undo_requires_posting_reconciliation") {
      failure.message = "The previous posting attempt requires reconciliation before this split can be reset. No retry was scheduled.";
    }
    throw failure;
  }
  const { data, error: fetchError } = await db.from("transaction_categorizations").select("*")
    .eq("business_id", businessId).eq("transaction_id", transactionId).single();
  if (fetchError) throw fetchError;
  return data;
}
