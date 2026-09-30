import express from "express";
import { supabase } from "../../services/supabaseAdmin.js";
import { requireAuth } from "../gpt/middlewares/requireAuth.js";
import { createInitialBusinessForAuthenticatedUser } from "./onboardingBusiness.service.js";
import { requireBusinessAccess } from "../_shared/tenantAuth.js";
import { getCanonicalOnboardingStatus } from "../../services/onboardingStatusService.js";

const router = express.Router();

router.get("/status", requireAuth, requireBusinessAccess(), async (req, res, next) => {
  try {
    const status = await getCanonicalOnboardingStatus({ businessId: req.business.id, db: supabase });
    return res.json({ ok: true, ...status });
  } catch (err) {
    return next(err);
  }
});

router.post("/business", requireAuth, async (req, res, next) => {
  try {
    const business = await createInitialBusinessForAuthenticatedUser({
      supabase,
      auth: req.auth,
      body: req.body || {},
    });

    return res.status(201).json({
      ok: true,
      business,
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
