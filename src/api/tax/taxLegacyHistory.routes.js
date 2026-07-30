import { Router } from "express";
import { Parser } from "@json2csv/plainjs";
import { supabase as defaultSupabase } from "../../services/supabaseAdmin.js";
import { assertTaxBusinessAccess } from "./taxRouteUtils.js";
import { optionalTaxYear, validateBusinessIdInput } from "./taxValidation.js";
import { sendTaxError, sendTaxSuccess, setTaxNoStore } from "./taxHttp.js";

const router = Router();

router.get("/legacy/snapshots", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = req.query?.year || req.query?.taxYear ? optionalTaxYear(req.query.year ?? req.query.taxYear) : null;
    const snapshots = await listLegacySnapshots({ supabase, businessId, taxYear, limit: Number(req.query?.limit || 50) });
    return sendTaxSuccess(res, {
      source: "legacy_tax_snapshots",
      authoritative: false,
      warning: "Imported from legacy Bizzi snapshots. Full formula/source trace is unavailable.",
      rows: snapshots,
    });
  } catch (err) {
    return sendTaxError(res, err, "legacy_tax_snapshots_failed");
  }
});

router.get("/legacy/snapshots/:snapshotId/export", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const snapshot = await getLegacySnapshot({ supabase, businessId, snapshotId: req.params.snapshotId });
    if (!snapshot) return res.status(404).json({ ok: false, error: { code: "legacy_snapshot_not_found", message: "Legacy tax snapshot not found." } });
    const kind = String(req.query?.kind || "json").toLowerCase();
    const payload = legacyEnvelope(snapshot);
    if (kind === "csv") {
      const parser = new Parser({ fields: ["key", "value"] });
      const csv = parser.parse(flattenPayload(payload));
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="legacy-tax-snapshot-${snapshot.id || snapshot.month}.csv"`);
      return res.send(csv);
    }
    return sendTaxSuccess(res, payload);
  } catch (err) {
    return sendTaxError(res, err, "legacy_tax_snapshot_export_failed");
  }
});

async function listLegacySnapshots({ supabase, businessId, taxYear, limit }) {
  if (supabase.store) {
    return (supabase.store.tax_snapshots || [])
      .filter((row) => row.business_id === businessId)
      .filter((row) => !taxYear || String(row.month || row.created_at || "").startsWith(`${taxYear}-`) || Number(row.tax_year) === taxYear)
      .slice(0, limit)
      .map(legacyEnvelope);
  }
  let query = supabase.from("tax_snapshots").select("*").eq("business_id", businessId).order("created_at", { ascending: false }).limit(limit);
  const { data, error } = await query;
  if (error) throw error;
  return (data || [])
    .filter((row) => !taxYear || String(row.month || row.created_at || "").startsWith(`${taxYear}-`) || Number(row.tax_year) === taxYear)
    .map(legacyEnvelope);
}

async function getLegacySnapshot({ supabase, businessId, snapshotId }) {
  if (supabase.store) {
    return (supabase.store.tax_snapshots || []).find((row) => row.business_id === businessId && String(row.id || row.month) === String(snapshotId)) || null;
  }
  const { data, error } = await supabase
    .from("tax_snapshots")
    .select("*")
    .eq("business_id", businessId)
    .eq("id", snapshotId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

function legacyEnvelope(row) {
  return {
    id: row.id || row.month || null,
    businessId: row.business_id || null,
    month: row.month || null,
    taxYear: row.tax_year || Number(String(row.month || row.created_at || "").slice(0, 4)) || null,
    createdAt: row.created_at || null,
    source: "legacy_tax_snapshot",
    authoritative: false,
    confidence: "legacy_unverified",
    warning: "Imported from a legacy Bizzi snapshot. Full formula/source trace is unavailable.",
    payload: row.payload || row.snapshot || row.data || {},
  };
}

function flattenPayload(payload) {
  const rows = [];
  function walk(value, prefix) {
    if (value == null || typeof value !== "object") {
      rows.push({ key: prefix, value });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${prefix}.${index}`));
      return;
    }
    Object.entries(value).forEach(([key, val]) => walk(val, prefix ? `${prefix}.${key}` : key));
  }
  walk(payload, "");
  return rows;
}

export default router;
