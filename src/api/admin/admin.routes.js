import { Router } from "express";
import { requireAuth } from "../gpt/middlewares/requireAuth.js";
import { requireInternalStaff } from "../_shared/internalStaffAuth.js";
import { getMonthlyFinancialPulseSchedulerHealth } from "../../cron/monthlyFinancialPulse.cron.js";

const router = Router();

router.get("/me", requireAuth, requireInternalStaff(), (req, res) => {
  res.json({
    ok: true,
    user: {
      id: req.user.id,
      email: req.user.email || null,
    },
    staff: {
      user_id: req.internalStaff.userId,
      role: req.internalStaff.role,
      active: true,
    },
  });
});

router.get("/worker-health/monthly-brief", requireAuth, requireInternalStaff(), (_req, res) => {
  res.json({ ok: true, scheduler: getMonthlyFinancialPulseSchedulerHealth() });
});

export default router;
