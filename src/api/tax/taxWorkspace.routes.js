import { Router } from "express";
import { supabase as defaultSupabase } from "../../services/supabaseAdmin.js";
import { businessHasPaidEntitlement } from "../../services/billing/entitledBusinesses.js";
import {
  buildAndPersistTaxWorkspaceProjection,
  enqueueTaxWorkspaceProjection,
  getLatestTaxWorkspaceProjection,
  getTaxWorkspaceRefreshState,
  publicTaxWorkspaceProjection,
  TAX_WORKSPACE_LEGACY_PROJECTION_VERSION,
  TAX_WORKSPACE_PROJECTION_VERSION,
} from "../../services/tax/taxWorkspaceProjection.service.js";
import { TaxEngineError } from "../../services/tax/taxErrors.js";
import { assertTaxBusinessAccess } from "./taxRouteUtils.js";
import { optionalTaxYear, validateBusinessIdInput } from "./taxValidation.js";
import { sendTaxError, sendTaxSuccess, setTaxNoStore } from "./taxHttp.js";
import { assertInternalSchedulerAccess } from "./taxSchedulerAuth.js";
import { workspaceReadError } from "./taxWorkspaceErrors.js";

const router = Router();

router.get("/workspace", async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  try {
    const db = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    assertNoConflictingBusinessIdentity(req, businessId);
    const access = await assertTaxBusinessAccess({ req, businessId, supabase: db });
    if (String(access.businessId) !== String(businessId)) throw safeError("tax_workspace_scope_conflict", 403, "Tax workspace scope does not match the authenticated business.");
    if (!(await businessHasPaidEntitlement(businessId, { db }))) throw safeError("paid_entitlement_required", 403, "A paid subscription is required to view this Tax workspace.");
    const taxYear = optionalTaxYear(req.query.year ?? req.query.taxYear, new Date().getFullYear());
    const projectionVersion = String(req.query.projectionVersion || TAX_WORKSPACE_LEGACY_PROJECTION_VERSION);
    if (![TAX_WORKSPACE_LEGACY_PROJECTION_VERSION, TAX_WORKSPACE_PROJECTION_VERSION].includes(projectionVersion)) throw safeError("tax_workspace_version_unsupported", 422, "That Tax workspace version is not supported.");
    const [record, refreshState] = await Promise.all([
      getLatestTaxWorkspaceProjection({ supabase: db, businessId, taxYear, projectionVersion }),
      getTaxWorkspaceRefreshState({ supabase: db, businessId, taxYear }),
    ]);
    if (!record) throw safeError("projection_unavailable", 503, "Your Tax workspace is not available yet.", { action: "retry" });
    return sendTaxSuccess(res, {
      state: refreshState,
      projectionId: record.id,
      projectionVersion: record.projection_version,
      formulaVersion: record.formula_version,
      sourceFingerprint: record.source_fingerprint,
      generatedAt: record.generated_at,
      projection: publicTaxWorkspaceProjection(record.projection_data),
    });
  } catch (error) {
    return sendTaxError(res, workspaceReadError(error), "tax_workspace_read_failed");
  }
});

router.post("/workspace/backfill", async (req, res) => {
  setTaxNoStore(res);
  try {
    assertInternalSchedulerAccess(req);
    const db = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    assertNoConflictingBusinessIdentity(req, businessId);
    const taxYear = optionalTaxYear(req.body?.year ?? req.body?.taxYear, new Date().getFullYear());
    const projectionVersion = String(req.body?.projectionVersion || "").trim();
    if (projectionVersion !== TAX_WORKSPACE_PROJECTION_VERSION) {
      throw safeError("tax_workspace_version_required", 422, `projectionVersion must be ${TAX_WORKSPACE_PROJECTION_VERSION}.`);
    }
    const requestId = String(req.get?.("Idempotency-Key") || req.headers?.["idempotency-key"] || "").trim();
    if (!requestId || requestId.length > 200) throw safeError("invalid_idempotency_key", 422, "A bounded idempotency key is required.");
    const request = await enqueueTaxWorkspaceProjection({ supabase: db, businessId, taxYear, reason: "controlled_backfill", requestKey: `tax-workspace-backfill:${projectionVersion}:${requestId}` });
    if (String(request?.business_id) !== String(businessId) || Number(request?.tax_year) !== Number(taxYear)) {
      throw safeError("idempotency_key_conflict", 409, "That idempotency key was already used for a different Tax workspace scope.");
    }
    if (request?.status === "completed" && request.projection_id) return sendTaxSuccess(res, { status: "complete", requestId: request.id, projectionId: request.projection_id, projectionVersion, idempotent: true });
    const result = await buildAndPersistTaxWorkspaceProjection({ supabase: db, businessId, taxYear });
    if (db.store) Object.assign(request, { status: "completed", projection_id: result.projectionId, completed_at: new Date().toISOString() });
    else {
      const { error } = await db.from("tax_workspace_projection_requests").update({ status: "completed", projection_id: result.projectionId, completed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", request.id);
      if (error) throw error;
    }
    return sendTaxSuccess(res, { status: "complete", requestId: request.id, projectionId: result.projectionId, projectionVersion: TAX_WORKSPACE_PROJECTION_VERSION, idempotent: false });
  } catch (error) {
    return sendTaxError(res, error, "tax_workspace_backfill_failed");
  }
});

function safeError(code, status, message, details) {
  return new TaxEngineError({ code, status, message, details });
}

function assertNoConflictingBusinessIdentity(req, canonicalBusinessId) {
  const supplied = [
    req?.params?.businessId,
    req?.params?.business_id,
    req?.query?.businessId,
    req?.query?.business_id,
    req?.body?.businessId,
    req?.body?.business_id,
    req?.headers?.["x-business-id"],
  ].filter(Boolean).map(String);
  if (supplied.some((value) => value !== String(canonicalBusinessId))) {
    throw safeError("tax_workspace_scope_conflict", 403, "Tax workspace scope does not match the authenticated business.");
  }
}

export default router;
