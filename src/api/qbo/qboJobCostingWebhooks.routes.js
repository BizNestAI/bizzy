import express from "express";
import { supabase } from "../../services/supabaseAdmin.js";
import {
  processQueuedQboWebhookEvents,
  storeQuickBooksWebhookEvents,
  verifyQuickBooksWebhookSignature,
} from "../../services/jobCosting/qboOngoingSyncService.js";

const router = express.Router();

function getVerifierToken() {
  return process.env.QB_WEBHOOK_VERIFIER_TOKEN || process.env.QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN || "";
}

function getRawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body);
  return Buffer.from(JSON.stringify(req.body || {}));
}

function enqueueWebhookProcessor() {
  if (String(process.env.DISABLE_QBO_JOB_COSTING_SYNC || "").toLowerCase() === "true") return;
  if (String(process.env.DISABLE_QBO_JOB_COSTING_WEBHOOK_WORKER || "").toLowerCase() === "true") return;
  setImmediate(() => {
    processQueuedQboWebhookEvents({ db: supabase, limit: Number(process.env.QBO_JOB_COSTING_WEBHOOK_BATCH_SIZE || 25) })
      .catch((error) => console.warn("[qbo-job-costing-webhook-worker]", error?.message || error));
  });
}

export async function quickBooksJobCostingWebhookHandler(req, res) {
  const rawBody = getRawBody(req);
  const intuitSignature = req.get("intuit-signature") || "";
  const intuitTid = req.get("intuit_tid") || req.get("intuit-tid") || null;

  if (!verifyQuickBooksWebhookSignature({
    rawBody,
    signature: intuitSignature,
    verifierToken: getVerifierToken(),
  })) {
    return res.status(401).json({ ok: false, error: "invalid_qbo_webhook_signature" });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8") || "{}");
  } catch (_error) {
    return res.status(400).json({ ok: false, error: "invalid_qbo_webhook_json" });
  }

  try {
    const result = await storeQuickBooksWebhookEvents({
      payload,
      intuitSignature,
      intuitTid,
      db: supabase,
    });
    res.status(200).json({
      ok: true,
      accepted: result.accepted,
      queued: result.queued,
      duplicates: result.duplicates,
    });
    enqueueWebhookProcessor();
  } catch (error) {
    console.error("[qbo-job-costing-webhook]", error);
    res.status(500).json({
      ok: false,
      error: "qbo_webhook_store_failed",
      message: error?.message || "Failed to store QuickBooks webhook event.",
    });
  }
}

router.post("/job-costing", express.raw({ type: "application/json" }), quickBooksJobCostingWebhookHandler);

export default router;
