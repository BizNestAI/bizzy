import { Router } from "express";
import { requireAuth } from "../gpt/middlewares/requireAuth.js";
import { requireInternalStaff } from "../_shared/internalStaffAuth.js";

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

export default router;
