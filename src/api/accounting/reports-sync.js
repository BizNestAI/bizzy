import express from "express";
import { canonicalBusinessId, rejectConflictingBusinessId } from "../_shared/sensitiveStorage.js";

const router = express.Router();

/**
 * POST /api/accounting/reports-sync
 * body: { user_id, business_id, window?: number, endYear?: number, endMonth?: number, forceMock?: boolean }
 * returns: { synced, skipped, mocked, errors }
 */
router.post("/", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const businessId = canonicalBusinessId(req);
    rejectConflictingBusinessId(req, businessId);
    return res.status(403).json({ ok: false, error: "report_publication_admin_only", code: "report_publication_admin_only" });
  } catch (e) {
    const status = Number(e?.status || 500);
    return res.status(status).json({ ok: false, error: status < 500 ? e.code || e.message : "reports_sync_failed" });
  }
});

export default router;
