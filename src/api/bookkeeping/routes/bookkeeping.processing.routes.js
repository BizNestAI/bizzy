import { Router } from "express";
import { ensureBusinessId } from "./_bookkeepingRouteUtils.js";
import {
  enqueueBookkeepingProcessingForTransactions,
  getBookkeepingProcessingStatus,
} from "../../../services/bookkeeping/backgroundBookkeepingProcessingService.js";

const router = Router();

function setNoStoreHeaders(res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");
  res.set("Vary", "Authorization, x-business-id, x-bizzi-admin-view");
}

router.get("/processing/status", async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  setNoStoreHeaders(res);
  try {
    const result = await getBookkeepingProcessingStatus({ businessId });
    return res.json(result);
  } catch (err) {
    console.error("[bookkeeping-processing] status failed", {
      business_id: businessId,
      message: err?.message || String(err),
    });
    return res.status(500).json({
      ok: false,
      error: "bookkeeping_processing_status_failed",
      message: err?.message || "failed",
    });
  }
});

router.post("/processing/retry", async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  try {
    const transactionIds = Array.isArray(req.body?.transaction_ids) ? req.body.transaction_ids : [];
    const result = await enqueueBookkeepingProcessingForTransactions({
      businessId,
      transactionIds,
      source: "manual_retry",
      priority: 5,
    });
    return res.json(result);
  } catch (err) {
    console.error("[bookkeeping-processing] retry enqueue failed", {
      business_id: businessId,
      message: err?.message || String(err),
    });
    return res.status(500).json({
      ok: false,
      error: "bookkeeping_processing_retry_failed",
      message: err?.message || "failed",
    });
  }
});

export default router;
