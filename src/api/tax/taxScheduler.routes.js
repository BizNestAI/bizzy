import { Router } from "express";
import { supabase as defaultSupabase } from "../../services/supabaseAdmin.js";
import { runDailyTaxScheduler } from "../../services/tax/scheduling/runDailyTaxScheduler.js";
import { runWeeklyTaxScheduler } from "../../services/tax/scheduling/runWeeklyTaxScheduler.js";
import { optionalTaxYear } from "./taxValidation.js";
import { sendTaxError, sendTaxSuccess, setTaxNoStore } from "./taxHttp.js";
import { assertInternalSchedulerAccess } from "./taxSchedulerAuth.js";

const router = Router();

router.post("/scheduler/run-daily", async (req, res) => {
  setTaxNoStore(res);
  try {
    assertInternalSchedulerAccess(req);
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const result = await runDailyTaxScheduler({
      supabase,
      scheduledFor: req.body?.scheduledFor || req.query?.scheduledFor || new Date(),
      taxYear: optionalTaxYear(req.body?.taxYear || req.query?.taxYear || new Date().getUTCFullYear()),
      workerId: req.body?.workerId || "tax-scheduler:manual-route",
    });
    return sendTaxSuccess(res, result);
  } catch (err) {
    return sendTaxError(res, err, "tax_daily_scheduler_failed");
  }
});

router.post("/scheduler/run-weekly", async (req, res) => {
  setTaxNoStore(res);
  try {
    assertInternalSchedulerAccess(req);
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const result = await runWeeklyTaxScheduler({
      supabase,
      scheduledFor: req.body?.scheduledFor || req.query?.scheduledFor || new Date(),
      taxYear: optionalTaxYear(req.body?.taxYear || req.query?.taxYear || new Date().getUTCFullYear()),
      workerId: req.body?.workerId || "tax-scheduler:manual-route",
    });
    return sendTaxSuccess(res, result);
  } catch (err) {
    return sendTaxError(res, err, "tax_weekly_scheduler_failed");
  }
});

export default router;
