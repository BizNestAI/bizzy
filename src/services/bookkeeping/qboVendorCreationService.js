import { supabase } from "../supabaseAdmin.js";
import { getQBOClient } from "../../utils/qboClient.js";
import { getQboEntityCache, normalizeCandidate, tokenOverlapScore } from "./qboEntityCache.js";
import { looksLikeTaxonomyLandmineMemo } from "./vendorRuleLearner.js";

const devLog = ({ businessId, txnId, candidateName, decision, reason, extra }) => {
  if (process.env.NODE_ENV !== "production") {
    console.info("[qboVendorCreate]", { businessId, txnId, candidateName, decision, reason, ...extra });
  }
};

export function normalizeVendorName(name = "") {
  return (name || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksGenericOrPayment(name = "") {
  const n = normalizeVendorName(name);
  if (!n) return true;
  const stop = ["payment", "transfer", "fee", "interest", "check", "deposit", "refund", "zelle", "venmo", "cash app"];
  return stop.some((t) => n.includes(t));
}

function isOutflow(txn = {}) {
  const dir = (txn.direction || "").toUpperCase();
  if (dir === "OUTFLOW") return true;
  if (dir === "INFLOW") return false;
  if (typeof txn.signed_amount === "number") return txn.signed_amount < 0;
  if (typeof txn.amount === "number") return txn.amount > 0; // Plaid convention: positive outflow when direction unknown
  return false;
}

function extractCandidateName(bankTxn = {}, payeeResolution = {}) {
  return (
    payeeResolution?.counterpartyName ||
    bankTxn.counterparty_name ||
    bankTxn.merchant_name ||
    bankTxn.name ||
    ""
  );
}

function taxonomyBlocked(bankTxn = {}, taxonomyMeta = {}) {
  const tax = (taxonomyMeta?.taxonomy_type || taxonomyMeta?.meta?.taxonomy_type || "").toLowerCase();
  if (["transfer_internal", "cc_payment", "refund", "owner_draw", "owner_contribution"].includes(tax)) return true;
  if (looksLikeTaxonomyLandmineMemo(bankTxn)) return true;
  return false;
}

export function isVendorCreationEligible({ bankTxn = {}, payeeResolution = {}, taxonomyMeta = {} }) {
  if (!isOutflow(bankTxn)) return { ok: false, reason: "not_outflow" };
  const candidate = extractCandidateName(bankTxn, payeeResolution);
  if (!candidate || candidate.length < 2) return { ok: false, reason: "missing_name" };
  if (looksGenericOrPayment(candidate)) return { ok: false, reason: "generic_name" };
  if (taxonomyBlocked(bankTxn, taxonomyMeta)) return { ok: false, reason: "taxonomy_block" };
  if (bankTxn.is_check || bankTxn.check_number) {
    if (!candidate) return { ok: false, reason: "check_no_payee" };
  }
  return { ok: true };
}

async function persistVendorLink(businessId, txnId, vendorId) {
  if (!businessId || !txnId || !vendorId) return;
  try {
    await supabase
      .from("bank_transactions")
      .update({ qbo_entity_type: "vendor", qbo_entity_id: vendorId })
      .eq("business_id", businessId)
      .eq("id", txnId);
  } catch (err) {
    devLog({ businessId, txnId, decision: "persist_failed", reason: err?.message });
  }
}

async function logVendorCreation({ businessId, vendorId, vendorName, source, createdBy, txnId, meta }) {
  try {
    await supabase.from("qbo_vendor_creations").upsert(
      {
        business_id: businessId,
        qbo_entity_type: "vendor",
        qbo_entity_id: vendorId,
        vendor_name: vendorName,
        created_by: createdBy || "bizzi",
        source: source || "suggest",
        source_transaction_id: txnId || null,
        meta: meta || {},
      },
      { onConflict: "business_id,qbo_entity_type,qbo_entity_id" }
    );
  } catch (err) {
    devLog({ businessId, txnId, decision: "log_failed", reason: err?.message });
  }
}

async function tryCacheMatch({ businessId, candidateName }) {
  if (!businessId || !candidateName) return null;
  const cache = await getQboEntityCache(businessId);
  const vendors = cache?.vendors || [];
  const normCandidate = normalizeCandidate(candidateName);
  const candTokens = (normCandidate || "").split(" ").filter(Boolean);
  let best = null;
  vendors.forEach((v) => {
    const vendNorm = normalizeCandidate(v.displayName || v.display_name || v.name || "");
    const vendTokens = (vendNorm || "").split(" ").filter(Boolean);
    const score = tokenOverlapScore(candTokens, vendTokens);
    if (score > (best?.score || 0)) {
      best = { score, vendor: v };
    }
  });
  if (!best) return null;
  if (best.score >= 0.9) {
    return {
      qbo_entity_type: "vendor",
      qbo_entity_id: best.vendor?.id || best.vendor?.Id,
      vendor_name: best.vendor?.displayName || best.vendor?.display_name || best.vendor?.name,
      match_score: best.score,
      match_tier: "cache_match_strict",
    };
  }
  if (best.score >= 0.85) {
    return {
      qbo_entity_type: "vendor",
      qbo_entity_id: best.vendor?.id || best.vendor?.Id,
      vendor_name: best.vendor?.displayName || best.vendor?.display_name || best.vendor?.name,
      match_score: best.score,
      match_tier: "cache_match_soft",
    };
  }
  return null;
}

async function recentCreationExists({ businessId, vendorName }) {
  const norm = normalizeVendorName(vendorName);
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("qbo_vendor_creations")
    .select("vendor_name")
    .eq("business_id", businessId)
    .gte("created_at", since);
  if (error) return false;
  return (data || []).some((r) => normalizeVendorName(r.vendor_name) === norm);
}

async function createQboVendor(businessId, name) {
  const qbo = await getQBOClient(businessId);
  if (!qbo) throw new Error("qbo_client_unavailable");
  const payload = {
    DisplayName: name,
    CompanyName: name,
    PrintOnCheckName: name,
    Active: true,
  };
  const fn = qbo.vendor && typeof qbo.vendor.create === "function" ? qbo.vendor.create : qbo.createVendor;
  if (!fn) throw new Error("qbo_vendor_create_not_supported");
  return new Promise((resolve, reject) => {
    fn.call(qbo, payload, (err, data) => {
      if (err) return reject(err);
      const ven = data?.Vendor || data?.vendor || data || null;
      if (!ven?.Id && !ven?.id) return reject(new Error("qbo_vendor_create_missing_id"));
      resolve({ id: ven.Id || ven.id, name: ven.DisplayName || ven.CompanyName || name });
    });
  });
}

export async function ensureQboVendorForTransaction({
  businessId,
  bankTxn = {},
  payeeResolution = {},
  taxonomyMeta = {},
  source = "suggest",
  createdBy = "bizzi",
}) {
  const txnId = bankTxn.id;
  const candidateName = extractCandidateName(bankTxn, payeeResolution);
  const eligibility = isVendorCreationEligible({ bankTxn, payeeResolution, taxonomyMeta });
  if (!eligibility.ok) {
    devLog({ businessId, txnId, candidateName, decision: "blocked", reason: eligibility.reason });
    return { ok: true, created: false, skipped: true, reason: eligibility.reason };
  }

  if (bankTxn.qbo_entity_type && bankTxn.qbo_entity_id) {
    return {
      ok: true,
      created: false,
      reason: "already_linked",
      qbo_entity_type: bankTxn.qbo_entity_type,
      qbo_entity_id: bankTxn.qbo_entity_id,
    };
  }

  if (payeeResolution?.qbo_entity_type && payeeResolution?.qbo_entity_id) {
    await persistVendorLink(businessId, txnId, payeeResolution.qbo_entity_id);
    return {
      ok: true,
      created: false,
      reason: "payee_resolution_link",
      qbo_entity_type: payeeResolution.qbo_entity_type,
      qbo_entity_id: payeeResolution.qbo_entity_id,
      vendor_name: payeeResolution.counterpartyName || candidateName,
    };
  }

  const cacheMatch = await tryCacheMatch({ businessId, candidateName });
  if (cacheMatch?.qbo_entity_id) {
    await persistVendorLink(businessId, txnId, cacheMatch.qbo_entity_id);
    devLog({
      businessId,
      txnId,
      candidateName,
      decision: "linked_cache",
      reason: cacheMatch.match_tier || "cache_match",
      extra: { score: cacheMatch.match_score },
    });
    return {
      ok: true,
      created: false,
      reason: cacheMatch.match_tier || "cache_match",
      qbo_entity_type: cacheMatch.qbo_entity_type,
      qbo_entity_id: cacheMatch.qbo_entity_id,
      vendor_name: cacheMatch.vendor_name,
    };
  }

  if (await recentCreationExists({ businessId, vendorName: candidateName })) {
    devLog({ businessId, txnId, candidateName, decision: "blocked", reason: "recent_duplicate" });
    return { ok: true, created: false, skipped: true, reason: "recent_duplicate" };
  }

  const vendor = await createQboVendor(businessId, candidateName.slice(0, 41));
  await persistVendorLink(businessId, txnId, vendor.id);
  await logVendorCreation({
    businessId,
    vendorId: vendor.id,
    vendorName: vendor.name,
    source,
    createdBy,
    txnId,
    meta: { reason: "created_for_outflow", candidate: candidateName },
  });
  devLog({ businessId, txnId, candidateName, decision: "created", reason: "created_for_outflow" });
  return {
    ok: true,
    created: true,
    qbo_entity_type: "vendor",
    qbo_entity_id: vendor.id,
    vendor_name: vendor.name,
    reason: "created_for_outflow",
  };
}

export default {
  normalizeVendorName,
  isVendorCreationEligible,
  ensureQboVendorForTransaction,
};
