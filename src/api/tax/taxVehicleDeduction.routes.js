import { emitTaxDataChanged, TAX_CHANGE_TYPES } from "../../services/tax/taxChangeEvents.js";
import { previewVehicleCommand, applyVehicleCommand } from "../../services/tax/taxVehicleCommands.service.js";
import { Router } from "express";
import { supabase as defaultSupabase } from "../../services/supabaseAdmin.js";
import { createTaxVehicle, listVehicleDeductionWorkflows, previewVehicleMileage, saveVehicleMileage } from "../../services/tax/taxVehicleDeduction.service.js";
import { assertTaxBusinessAccess } from "./taxRouteUtils.js";
import { optionalTaxYear, validateBusinessIdInput } from "./taxValidation.js";
import { sendTaxError, sendTaxSuccess, setTaxNoStore } from "./taxHttp.js";

const router = Router();

router.get("/vehicle-deductions", handle(async ({ supabase, businessId, taxYear }) =>
  listVehicleDeductionWorkflows({ supabase, businessId, taxYear })));

router.post("/vehicles", handle(async ({ supabase, businessId, actor, req }) =>
  createTaxVehicle({ supabase, businessId, actor, input: req.body || {} }), { mutation: true }));

router.post("/vehicle-mileage/preview", handle(async ({ supabase, businessId, taxYear, actor, req }) =>
  previewVehicleMileage({ supabase, businessId, taxYear, actor, input: req.body || {} })));

router.post("/vehicle-mileage/apply", handle(async ({ supabase, businessId, taxYear, actor, req }) =>
  saveVehicleMileage({ supabase, businessId, taxYear, actor, input: req.body || {} }), { mutation: true }));

router.post("/vehicle-commands/preview", handle(async ({ supabase, businessId, taxYear, actor, req }) =>
  previewVehicleCommand({ supabase, businessId, taxYear, actor, input: req.body || {} }), { mutation: true }));
router.post("/vehicle-commands/apply", handle(async ({ supabase, businessId, taxYear, actor, req }) => {
  const result = await applyVehicleCommand({ supabase, businessId, taxYear, actor, input: { previewId: req.body?.previewId, idempotencyKey: req.get("Idempotency-Key") } });
  emitTaxDataChanged({ businessId, taxYear, changeType: TAX_CHANGE_TYPES.CLASSIFICATION_OVERRIDDEN, entityId: result.previewId, userId: actor.userId, metadata: { vehicleCommand: true, correlationId: result.previewId } });
  return result;
}, { mutation: true }));

function handle(operation, { mutation = false } = {}) {
  return async (req, res) => {
    setTaxNoStore(res);
    try {
      const supabase = req.app?.locals?.supabase || defaultSupabase;
      const businessId = validateBusinessIdInput(req);
      await assertTaxBusinessAccess({ req, businessId, supabase });
      const tenantMode = String(req.tenantContext?.mode || "customer");
      if (mutation && (String(req.headers?.["x-data-mode"] || "live").toLowerCase() === "demo" || tenantMode === "admin_view")) {
        const error = Object.assign(new Error("Tax changes are unavailable in this session."), { status: 403, code: "tax_mutation_forbidden" });
        throw error;
      }
      const taxYear = optionalTaxYear(req.query.year ?? req.body?.year, new Date().getFullYear());
      const actor = {
        userId: req.auth?.userId || req.user?.id || req.user?.sub || req.userId || null,
        source: "user",
        tenantMode,
      };
      return sendTaxSuccess(res, await operation({ req, supabase, businessId, taxYear, actor }));
    } catch (error) {
      return sendTaxError(res, error, "tax_vehicle_deduction_failed");
    }
  };
}

export default router;
