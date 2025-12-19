import express from "express";
import { pullPnlPdfsForYear } from "./pullPnlPdfs.js"; // <-- path must match your file

const router = express.Router();

/**
 * POST /api/accounting/reports-sync
 * body: { user_id, business_id, window?: number, endYear?: number, endMonth?: number, forceMock?: boolean }
 * returns: { synced, skipped, mocked, errors }
 */
router.post("/", async (req, res) => {
  try {
    const b = req.body || {};
    const user_id = b.user_id || b.userId;
    const business_id = b.business_id || b.businessId;
    const window = Number(b.window || 12);
    const endYear = b.endYear ? Number(b.endYear) : undefined;
    const endMonth = b.endMonth ? Number(b.endMonth) : undefined;
    const forceMock = Boolean(b.forceMock);

    if (!user_id || !business_id) {
      return res.status(400).json({ error: "Missing user_id or business_id" });
    }

    const out = await pullPnlPdfsForYear(user_id, business_id, {
      window,
      endYear,
      endMonth,
      forceMock,
    });

    return res.status(200).json(out);
  } catch (e) {
    console.error("[reports-sync] error:", e?.message || e);
    return res.status(500).json({ error: "reports_sync_failed" });
  }
});

export default router;
