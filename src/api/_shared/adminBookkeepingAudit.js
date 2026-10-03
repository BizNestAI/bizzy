import crypto from "node:crypto";
import { supabase as defaultSupabase } from "../../services/supabaseAdmin.js";

function transactionIds(req) {
  const body = req.body || {};
  const ids = [
    req.adminBookkeepingAccess?.transactionId,
    body.transaction_id,
    body.transactionId,
    body.txnId,
    body.id,
    ...(Array.isArray(body.items)
      ? body.items.map((item) => item?.transaction_id || item?.transactionId || item?.txnId || item?.id)
      : []),
  ].filter(Boolean).map(String);
  return [...new Set(ids)];
}

async function snapshot(db, businessId, ids) {
  if (!ids.length) return {};
  const { data, error } = await db
    .from("transaction_categorizations")
    .select("transaction_id,status,final_qbo_account_id,final_qbo_account_name,qbo_txn_id,qbo_txn_type,posted_at,post_after,excluded_at,meta,updated_at")
    .eq("business_id", businessId)
    .in("transaction_id", ids);
  if (error) throw error;
  return Object.fromEntries((data || []).map((row) => [String(row.transaction_id), row]));
}

export function auditAdminBookkeepingMutation({ db = defaultSupabase } = {}) {
  return async function adminBookkeepingAuditMiddleware(req, res, next) {
    if (!req.adminBookkeepingAccess) return next();

    const access = req.adminBookkeepingAccess;
    const ids = transactionIds(req);
    const correlationId = String(req.headers?.["x-correlation-id"] || req.headers?.["x-request-id"] || crypto.randomUUID());
    res.setHeader?.("x-correlation-id", correlationId);
    let beforeState = {};
    try {
      beforeState = await snapshot(db, access.businessId, ids);
    } catch (error) {
      console.error("[admin-bookkeeping-audit] before snapshot failed", { correlation_id: correlationId, code: error?.code || null });
      return res.status(503).json({ ok: false, error: "admin_bookkeeping_audit_unavailable", correlation_id: correlationId });
    }

    const eventIds = ids.length ? ids : [null];
    const auditRows = eventIds.map((transactionId) => ({
      id: crypto.randomUUID(),
      admin_view_session_id: access.sessionId,
      actor_user_id: access.actorId,
      business_id: access.businessId,
      transaction_id: transactionId,
      action: access.action,
      source: access.source,
      correlation_id: correlationId,
      request_method: access.method,
      request_path: access.path,
      previous_state: transactionId ? beforeState[transactionId] || {} : {},
    }));
    const { error: auditStartError } = await db.from("internal_admin_bookkeeping_audit_events").insert(auditRows);
    if (auditStartError) {
      console.error("[admin-bookkeeping-audit] intent write failed", { correlation_id: correlationId, code: auditStartError?.code || null });
      return res.status(503).json({ ok: false, error: "admin_bookkeeping_audit_unavailable", correlation_id: correlationId });
    }

    let responseBody = null;
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      responseBody = body;
      return originalJson(body);
    };

    res.once("finish", () => {
      void (async () => {
        const afterState = await snapshot(db, access.businessId, ids);
        for (const row of auditRows) {
          const { error } = await db
            .from("internal_admin_bookkeeping_audit_events")
            .update({
              succeeded: res.statusCode >= 200 && res.statusCode < 400 && responseBody?.ok !== false,
              response_status: res.statusCode,
              resulting_state: row.transaction_id ? afterState[row.transaction_id] || {} : {},
              response_summary: responseBody && typeof responseBody === "object"
                ? { ok: responseBody.ok !== false, error: responseBody.error || null }
                : {},
              completed_at: new Date().toISOString(),
            })
            .eq("id", row.id);
          if (error) throw error;
        }
      })().catch((error) => {
        console.error("[admin-bookkeeping-audit] write failed", {
          correlation_id: correlationId,
          action: access.action,
          code: error?.code || null,
        });
      });
    });
    return next();
  };
}

export function validateAdminBookkeepingMutation({ db = defaultSupabase } = {}) {
  return async function adminBookkeepingValidationMiddleware(req, res, next) {
    const access = req.adminBookkeepingAccess;
    if (!access) return next();
    if (access.action !== "retry_failed_qbo_posting") return next();

    const { data, error } = await db
      .from("transaction_categorizations")
      .select("status,post_error,qbo_txn_id,posted_at")
      .eq("business_id", access.businessId)
      .eq("transaction_id", access.transactionId)
      .maybeSingle();
    if (error) return res.status(503).json({ ok: false, error: "admin_bookkeeping_validation_unavailable" });
    const failedAndMutable = data
      && Boolean(data.post_error)
      && !data.qbo_txn_id
      && !data.posted_at
      && !["posted", "matched", "excluded", "finalized"].includes(String(data.status || ""));
    if (!failedAndMutable) {
      return res.status(409).json({ ok: false, error: "admin_bookkeeping_retry_not_eligible" });
    }
    return next();
  };
}
