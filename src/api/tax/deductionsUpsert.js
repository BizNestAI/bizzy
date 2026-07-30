// /src/api/tax/deductionsUpsert.js
// Internal/admin bookkeeping rollup sync. Tax deductions are canonical from
// transaction_tax_classifications; this endpoint must not be customer-facing.
/* global process */
import { supabase } from "../../services/supabaseAdmin.js";
import { upsertExpenseTotals } from "../../services/tax/deductions.service.js";
import { assertTaxBusinessAccess } from "./taxRouteUtils.js";
import { validateBusinessIdInput } from "./taxValidation.js";
import { sendTaxError, sendTaxSuccess, setTaxNoStore } from "./taxHttp.js";

const MAX_ROLLUP_ROWS = 500;

export default async function deductionsUpsertHandler(req, res) {
  setTaxNoStore(res);

  if ((req.method || "").toUpperCase() !== "POST") {
    return sendTaxError(res, { code: "method_not_allowed", message: "Method Not Allowed. Use POST.", status: 405 }, "method_not_allowed");
  }

  let businessId;
  let payload;
  try {
    assertInternalDeductionsUpsert(req);
    businessId = validateBusinessIdInput(req);
    payload = req.body?.payload;
    if (!Array.isArray(payload)) {
      throw { code: "invalid_payload", message: "payload (array) is required", status: 422 };
    }
    if (payload.length > MAX_ROLLUP_ROWS) {
      throw { code: "payload_too_large", message: `payload cannot exceed ${MAX_ROLLUP_ROWS} rows`, status: 422 };
    }
    await assertTaxBusinessAccess({ req, businessId, supabase });
  } catch (err) {
    return sendTaxError(res, err, "invalid_deductions_upsert");
  }

  try {
    const result = await upsertExpenseTotals({ supabase, businessId, payload });
    return sendTaxSuccess(res, result);
  } catch (err) {
    console.error("[deductionsUpsert] error:", err);
    return sendTaxError(res, err, "tax_data_unavailable");
  }
}

function assertInternalDeductionsUpsert(req) {
  const role = String(req.user?.role || "").toLowerCase();
  const isAdminRole = ["admin", "internal_admin", "bizzy_admin", "super_admin", "system"].includes(role);
  const configuredKey = process.env.TAX_INTERNAL_SYNC_KEY || process.env.ADMIN_API_KEY;
  const headerKey = req.headers?.["x-tax-sync-key"] || req.headers?.["x-admin-key"];
  const hasInternalKey = Boolean(configuredKey && headerKey === configuredKey);
  if (!isAdminRole && !hasInternalKey) {
    throw {
      code: "forbidden_internal_tax_sync_only",
      message: "Deductions rollup upsert is restricted to internal sync/admin callers.",
      status: 403,
    };
  }
}
