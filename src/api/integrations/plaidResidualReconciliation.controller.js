import { reconcileResidualPlaidBatch } from "../../services/plaid/plaidResidualReconciliationService.js";

export function residualReconciliationHandler({ db, plaidEnv }) {
  return async (req, res) => {
    // The router verifies authentication, tenant access and internal staff role.
    // Body actor/business IDs are never used, even if supplied.
    const businessId = req.business?.id;
    const actorUserId = req.internalStaff?.userId;
    if (!businessId || req.auth?.businessId !== businessId || !actorUserId || req.auth?.userId !== actorUserId) {
      return res.status(403).json({ ok: false, error: "plaid_reconciliation_operator_context_required" });
    }
    try {
      return res.json({ ok: true, ...(await reconcileResidualPlaidBatch({ db, businessId, plaidEnv, actorUserId,
        plaidAccountId: req.params.plaidAccountId, batchId: req.params.batchId,
        execute: req.body?.execute === true, manifestId: req.body?.manifest_id || null,
        reviewedTransactionIds: req.body?.reviewed_transaction_ids || [], liveQboAttestation: req.body?.live_qbo_attestation || null })) });
    } catch (error) {
      return res.status(error.status || 409).json({ ok: false, error: error.code || "plaid_reconciliation_failed", ...(error.details || {}) });
    }
  };
}
