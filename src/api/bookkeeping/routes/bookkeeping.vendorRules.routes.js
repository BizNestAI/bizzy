import { Router } from "express";
import { supabase } from "../../../services/supabaseAdmin.js";
import { requireAuth } from "../../gpt/middlewares/requireAuth.js";
import { looksLikeTaxonomyLandmineMemo, canonicalTxnDirection, computeMemoPrefixForLearning } from "../../../services/bookkeeping/vendorRuleLearner.js";
import { ensureBusinessId } from "./_bookkeepingRouteUtils.js";
import { getBookkeepingStartDate, isTransactionInActiveBookkeepingScope } from "../../../services/bookkeeping/bookkeepingScope.js";

const router = Router();

router.patch("/vendor-rules/:id", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  const ruleId = req.params?.id;
  if (!ruleId) return res.status(400).json({ ok: false, error: "missing_rule_id" });

  const body = req.body || {};
  try {
    const { data: existing, error: selErr } = await supabase
      .from("vendor_rules")
      .select("*")
      .eq("business_id", businessId)
      .eq("id", ruleId)
      .maybeSingle();
    if (selErr) throw selErr;
    if (!existing) {
      return res.status(404).json({ ok: false, error: "rule_not_found" });
    }

    const clearDefault = body.clear_default === true || body.default_qbo_account_id === null;
    const updates = {};

    if (clearDefault) {
      updates.default_qbo_account_id = null;
      updates.default_qbo_account_name = null;
    } else if (Object.prototype.hasOwnProperty.call(body, "default_qbo_account_id")) {
      if (!body.default_qbo_account_id) {
        return res.status(400).json({ ok: false, error: "missing_account_id" });
      }
      if (!Object.prototype.hasOwnProperty.call(body, "default_qbo_account_name")) {
        return res.status(400).json({ ok: false, error: "missing_account_name" });
      }
      updates.default_qbo_account_id = body.default_qbo_account_id;
      updates.default_qbo_account_name = body.default_qbo_account_name || null;
      updates.usage_count = (existing.usage_count || 0) + 1;
      updates.last_used_at = new Date().toISOString();
    }

    if (Object.prototype.hasOwnProperty.call(body, "direction_hint")) {
      updates.direction_hint = body.direction_hint || null;
    }
    if (Object.prototype.hasOwnProperty.call(body, "confidence")) {
      updates.confidence = body.confidence || null;
    }
    if (Object.prototype.hasOwnProperty.call(body, "notes")) {
      updates.notes = body.notes ?? null;
    }

    if (Object.keys(updates).length === 0) {
      return res.json({ ok: true, rule: existing });
    }

    const { data: updated, error: updErr } = await supabase
      .from("vendor_rules")
      .update(updates)
      .eq("business_id", businessId)
      .eq("id", ruleId)
      .select("*")
      .maybeSingle();
    if (updErr) throw updErr;

    return res.json({ ok: true, rule: updated });
  } catch (err) {
    console.error("[bookkeeping][vendor-rule-update] failed", err?.message || err);
    return res.status(500).json({ ok: false, error: "vendor_rule_update_failed", message: err?.message || "failed" });
  }
});

router.post("/vendor-rules/from-transaction", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  const body = req.body || {};
  const txnId = body.transaction_id;
  const accountId = body.default_qbo_account_id;
  const accountName = body.default_qbo_account_name;
  if (!txnId) return res.status(400).json({ ok: false, error: "missing_transaction_id" });
  if (!accountId) return res.status(400).json({ ok: false, error: "missing_account_id" });
  if (!accountName) return res.status(400).json({ ok: false, error: "missing_account_name" });

  try {
    const bookkeepingStartDate = await getBookkeepingStartDate(supabase, businessId);
    const { data: bankTxn, error: txnErr } = await supabase
      .from("bank_transactions")
      .select("id,date,merchant_entity_id,name,merchant_name,counterparty_name,amount,direction,category_primary,personal_finance_category,qbo_entity_type,qbo_entity_id")
      .eq("business_id", businessId)
      .eq("is_archived", false)
      .eq("id", txnId)
      .maybeSingle();
    if (txnErr) throw txnErr;
    if (!bankTxn) return res.status(404).json({ ok: false, error: "transaction_not_found" });
    if (!isTransactionInActiveBookkeepingScope(bankTxn, bookkeepingStartDate)) {
      return res.status(400).json({ ok: false, error: "transaction_before_bookkeeping_start_date" });
    }

    const { data: catRow } = await supabase
      .from("transaction_categorizations")
      .select("meta")
      .eq("business_id", businessId)
      .eq("transaction_id", txnId)
      .maybeSingle();
    const taxonomyType = catRow?.meta?.taxonomy_type || null;
    const landmineTypes = new Set(["transfer_internal", "cc_payment", "owner_draw", "owner_contribution", "refund"]);
    if (taxonomyType && landmineTypes.has(taxonomyType)) {
      return res.status(400).json({ ok: false, error: "vendor_rule_not_allowed_for_taxonomy" });
    }
    if (looksLikeTaxonomyLandmineMemo(bankTxn)) {
      return res.status(400).json({ ok: false, error: "vendor_rule_not_allowed_for_taxonomy" });
    }

    const direction = canonicalTxnDirection(bankTxn);
    if (direction === "UNKNOWN") {
      return res.status(400).json({ ok: false, error: "unknown_direction" });
    }
    if (direction === "INFLOW" && (bankTxn.qbo_entity_type || "").toLowerCase() !== "customer") {
      return res.status(400).json({ ok: false, error: "inflow_not_customer" });
    }

    const merchantEntityId = bankTxn.merchant_entity_id || null;
    const { prefix } = computeMemoPrefixForLearning(bankTxn, 20);
    let match_type = null;
    let match_value = null;
    let confidence = null;
    let counterparty_confidence = null;
    if (merchantEntityId) {
      match_type = "merchant_entity_id";
      match_value = merchantEntityId;
      confidence = "high";
      counterparty_confidence = "high";
    } else if (prefix && prefix.length >= 8) {
      match_type = "memo_prefix";
      match_value = prefix;
      confidence = "medium";
      counterparty_confidence = "medium";
    } else {
      return res.status(400).json({ ok: false, error: "no_vendor_identity" });
    }

    const counterpartyName = bankTxn.counterparty_name || bankTxn.merchant_name || bankTxn.name || "Unknown";
    const nowIso = new Date().toISOString();

    const { data: existingRows } = await supabase
      .from("vendor_rules")
      .select("*")
      .eq("business_id", businessId)
      .eq("match_type", match_type)
      .eq("match_value", match_value)
      .limit(1);
    const existing = existingRows?.[0] || null;

    if (existing) {
      const nextConfidence = existing.confidence === "high" ? "high" : confidence || existing.confidence || null;
      const payload = {
        default_qbo_account_id: accountId,
        default_qbo_account_name: accountName || null,
        usage_count: (existing.usage_count || 0) + 1,
        last_used_at: nowIso,
        direction_hint: Object.prototype.hasOwnProperty.call(body, "direction_hint") ? body.direction_hint || null : existing.direction_hint,
        confidence: nextConfidence,
        notes: Object.prototype.hasOwnProperty.call(body, "notes") ? body.notes ?? existing.notes ?? null : existing.notes,
      };
      const { data: updData, error: updErr } = await supabase
        .from("vendor_rules")
        .update(payload)
        .eq("business_id", businessId)
        .eq("id", existing.id)
        .select("*")
        .maybeSingle();
      if (updErr) throw updErr;
      return res.json({ ok: true, rule: updData });
    }

    const insertPayload = {
      business_id: businessId,
      match_type,
      match_value,
      counterparty_name: counterpartyName,
      counterparty_confidence,
      default_qbo_account_id: accountId,
      default_qbo_account_name: accountName || null,
      direction_hint: Object.prototype.hasOwnProperty.call(body, "direction_hint") ? body.direction_hint || direction : direction,
      confidence,
      notes: Object.prototype.hasOwnProperty.call(body, "notes") ? body.notes ?? null : null,
      usage_count: 1,
      last_used_at: nowIso,
      qbo_entity_type: bankTxn.qbo_entity_type || null,
      qbo_entity_id: bankTxn.qbo_entity_id || null,
    };
    const { data: insData, error: insErr } = await supabase
      .from("vendor_rules")
      .insert(insertPayload)
      .select("*")
      .maybeSingle();
    if (insErr) throw insErr;
    return res.json({ ok: true, rule: insData });
  } catch (err) {
    console.error("[bookkeeping][vendor-rule-from-txn] failed", err?.message || err);
    return res.status(500).json({ ok: false, error: "vendor_rule_from_txn_failed", message: err?.message || "failed" });
  }
});

export default router;
