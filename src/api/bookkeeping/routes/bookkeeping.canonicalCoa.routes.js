import { Router } from "express";
import { requireAuth } from "../../gpt/middlewares/requireAuth.js";
import { ensureBusinessId } from "./_bookkeepingRouteUtils.js";
import {
  approveExistingQboAccountForCanonical,
  createPreferredQboAccountForCanonical,
  fetchCanonicalAccountMappingsForBusiness,
} from "../../../services/bookkeeping/canonicalQboAccountResolver.js";

const router = Router();

function displayStatus(status = "") {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "existing_exact") return "Existing";
  if (normalized === "existing_approved_equivalent") return "Mapped Equivalent";
  if (normalized === "created_by_bizzi") return "Created by Bizzi";
  if (normalized === "needs_review") return "Needs Review";
  if (normalized === "rejected") return "Rejected";
  if (normalized === "disabled") return "Disabled";
  return "Needs Review";
}

router.get("/qbo/canonical-coa", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  const month = req.query?.month || null;
  try {
    const { rows, history, decisions } = await fetchCanonicalAccountMappingsForBusiness({ businessId, month });
    return res.json({
      ok: true,
      rows: (rows || []).map((row) => ({
        canonical_account_key: row.canonical_account_key,
        bizzi_account_name: row.bizzi_account_name,
        qbo_account_id: row.qbo_account_id,
        qbo_account_name: row.qbo_account_name,
        status: row.status,
        status_label: displayStatus(row.status),
        account_type: row.account_type,
        account_subtype: row.account_subtype,
        date: row.mapped_at || row.created_at || null,
        usage_count: row.usage_count || 0,
        review_reason: row.review_reason || null,
      })),
      history: (history || []).map((event) => ({
        id: event.id,
        canonical_account_key: event.canonical_account_key,
        qbo_account_id: event.qbo_account_id,
        qbo_account_name: event.qbo_account_name,
        event_type: event.event_type,
        status_label: displayStatus(event.event_type),
        source: event.source,
        reason: event.reason,
        created_at: event.created_at,
      })),
      decisions: (decisions || []).map((decision) => ({
        ...decision,
        status_label: displayStatus(decision.status),
      })),
    });
  } catch (err) {
    console.error("[bookkeeping][canonical-coa] failed", err?.message || err);
    return res.status(500).json({ ok: false, error: "canonical_coa_failed", message: err?.message || "failed" });
  }
});

router.post("/qbo/canonical-coa/:canonicalKey/use-existing", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  try {
    const result = await approveExistingQboAccountForCanonical({
      businessId,
      canonicalAccountKey: req.params.canonicalKey,
      qboAccountId: req.body?.qbo_account_id,
      actor: req.user?.id || "user",
      source: "manual",
    });
    return res.json(result);
  } catch (err) {
    console.error("[bookkeeping][canonical-coa][use-existing] failed", err?.message || err);
    return res.status(400).json({ ok: false, error: "canonical_coa_use_existing_failed", message: err?.message || "failed" });
  }
});

router.post("/qbo/canonical-coa/:canonicalKey/create-preferred", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  try {
    const result = await createPreferredQboAccountForCanonical({
      businessId,
      canonicalAccountKey: req.params.canonicalKey,
      reviewedCandidateQboAccountId: req.body?.reviewed_candidate_qbo_account_id || null,
      actor: req.user?.id || "user",
      source: "manual",
    });
    const statusCode = result?.ok ? 200 : 409;
    return res.status(statusCode).json(result);
  } catch (err) {
    console.error("[bookkeeping][canonical-coa][create-preferred] failed", err?.message || err);
    return res.status(400).json({ ok: false, error: "canonical_coa_create_preferred_failed", message: err?.message || "failed" });
  }
});

export default router;
