import { isCheck } from "./checkDetector.js";
import { computePostAfterForAutoPost, getAutoPostToQuickBooks } from "./autoPostControl.js";
import { getBookkeepingStartDate, isTransactionInActiveBookkeepingScope } from "./bookkeepingScope.js";
import { canAutoHandle, isReviewAccount } from "./autoHandlingPolicy.js";
import { resolveCanonicalVendorForTransaction } from "./canonicalVendorService.js";
import { validateCanonicalQboAccountForPromotion } from "./canonicalQboAccountResolver.js";

const MAX_RECONSIDERATION_LIMIT = 500;

async function getDefaultDb() {
  const mod = await import("../supabaseAdmin.js");
  return mod.supabase;
}

function normalizeDate(d) {
  if (!d) return null;
  const parsed = new Date(d);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function firstDayOfMonth() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

function computeRangeStart(range) {
  const now = new Date();
  switch (String(range || "").toLowerCase()) {
    case "last_30": {
      const d = new Date(now);
      d.setDate(d.getDate() - 30);
      return d;
    }
    case "last_90": {
      const d = new Date(now);
      d.setDate(d.getDate() - 90);
      return d;
    }
    case "all":
      return null;
    case "this_month":
    default:
      return firstDayOfMonth();
  }
}

function boundedLimit(limit) {
  const n = Number(limit || 200);
  if (!Number.isFinite(n) || n <= 0) return 200;
  return Math.min(Math.floor(n), MAX_RECONSIDERATION_LIMIT);
}

function normalizeSource(source = "") {
  return String(source || "backlog_reconsideration").toLowerCase();
}

function accountFromCategorization(cat = {}) {
  return {
    id: cat.suggested_qbo_account_id || cat.final_qbo_account_id || null,
    name: cat.suggested_qbo_account_name || cat.final_qbo_account_name || null,
  };
}

function canonicalAccountKey(cat = {}, meta = {}) {
  return (
    cat.suggested_canonical_account_key ||
    cat.final_canonical_account_key ||
    meta.canonical_account_key ||
    meta.universal_hint?.canonical_account_key ||
    null
  );
}

async function resolveCanonicalAccountEvidence({ businessId, db, cat, meta, transactionId, source, dependencies }) {
  const key = canonicalAccountKey(cat, meta);
  if (!key) {
    return {
      ok: false,
      canonicalAccountResolved: false,
      canonicalAccountKey: null,
      account: { id: null, name: null },
      reason: "canonical_account_key_missing",
    };
  }
  try {
    const resolved = await validateCanonicalQboAccountForPromotion({
      businessId,
      canonicalAccountKey: key,
      transactionId,
      source,
      allowCreate: dependencies?.allowCanonicalAccountCreate === true,
      dependencies: {
        ...(dependencies || {}),
        supabase: db,
      },
    });
    if (!resolved?.ok || resolved.review_required === true || !resolved?.account?.id) {
      return {
        ok: false,
        canonicalAccountResolved: false,
        canonicalAccountKey: key,
        account: { id: null, name: null },
        reason: resolved?.reason || "canonical_account_not_resolved",
        status: resolved?.status || null,
      };
    }
    const account = {
      id: String(resolved.account.id),
      name: resolved.account.name || resolved.account.fullyQualifiedName || null,
    };
    const accountReview = isReviewAccount({ accountId: account.id, accountName: account.name });
    if (accountReview) {
      return {
        ok: false,
        canonicalAccountResolved: false,
        canonicalAccountKey: key,
        account,
        reason: "review_or_suspense_account",
        status: resolved.status || null,
      };
    }
    return {
      ok: true,
      canonicalAccountResolved: true,
      canonicalAccountKey: resolved.canonical?.canonical_account_key || key,
      account,
      reason: resolved.status || "canonical_account_revalidated",
      status: resolved.status || null,
      canonical: resolved.canonical || null,
      mapping: resolved.mapping || null,
      created: resolved.created === true,
    };
  } catch (err) {
    return {
      ok: false,
      canonicalAccountResolved: false,
      canonicalAccountKey: key,
      account: { id: null, name: null },
      reason: err?.message || "canonical_account_revalidation_failed",
    };
  }
}

async function resolveVendorEvidence({ db, businessId, bankTxn, meta }) {
  const providerStrong = Boolean(bankTxn?.merchant_entity_id);
  const qboVendorStrong = Boolean(
    bankTxn?.qbo_entity_id &&
    String(bankTxn?.qbo_entity_type || "").toLowerCase() === "vendor"
  );
  const providerNamed = Boolean(bankTxn?.merchant_name || bankTxn?.counterparty_name);
  if (bankTxn?.canonical_vendor_id) {
    return {
      canonicalVendorId: bankTxn.canonical_vendor_id,
      canonicalVendorReliable: providerStrong || qboVendorStrong || providerNamed || meta?.canonical_vendor_reliable === true,
      merchantEvidenceStrong: providerStrong || qboVendorStrong || meta?.merchant_evidence_strong === true,
      weakVendorEvidence: false,
      reason: "transaction_canonical_vendor",
    };
  }
  if (!providerStrong && !qboVendorStrong && !providerNamed) {
    return {
      canonicalVendorId: null,
      canonicalVendorReliable: false,
      merchantEvidenceStrong: meta?.merchant_evidence_strong === true,
      weakVendorEvidence: true,
      reason: "no_provider_vendor_signal",
    };
  }
  try {
    const resolved = await resolveCanonicalVendorForTransaction({
      db,
      businessId,
      bankTxn,
      taxonomyMeta: meta || {},
    });
    const canonicalVendorId = resolved?.canonicalVendor?.id || resolved?.canonical_vendor_id || null;
    const weak = resolved?.reason === "weak_memo_evidence" || resolved?.needsReview === true || resolved?.skipped === true;
    return {
      canonicalVendorId,
      canonicalVendorReliable: Boolean(canonicalVendorId) && !weak && (providerStrong || qboVendorStrong || providerNamed),
      merchantEvidenceStrong: providerStrong || qboVendorStrong || meta?.merchant_evidence_strong === true,
      weakVendorEvidence: weak,
      reason: resolved?.reason || null,
    };
  } catch (err) {
    return {
      canonicalVendorId: null,
      canonicalVendorReliable: false,
      merchantEvidenceStrong: false,
      weakVendorEvidence: true,
      reason: err?.message || "canonical_vendor_resolution_failed",
    };
  }
}

export async function reconsiderNeedsReviewTransactions(businessId, options = {}) {
  if (!businessId) throw new Error("missing_business_id");
  const db = options.db || await getDefaultDb();
  const limit = boundedLimit(options.limit);
  const rangeStart = options.dateFrom
    ? normalizeDate(options.dateFrom)
    : options.range
    ? normalizeDate(computeRangeStart(options.range))
    : null;
  const dateTo = normalizeDate(options.dateTo);
  const cursor = options.cursor ? String(options.cursor) : null;
  const nowIso = new Date().toISOString();
  const dependencies = options.dependencies || {};

  let catQuery = db
    .from("transaction_categorizations")
    .select("transaction_id,business_id,status,suggested_qbo_account_id,suggested_qbo_account_name,suggested_canonical_account_key,final_canonical_account_key,confidence,meta,final_qbo_account_id,final_qbo_account_name,decided_by,post_after,qbo_txn_id")
    .eq("business_id", businessId)
    .in("status", ["needs_review", "uncategorized"])
    .is("qbo_txn_id", null)
    .order("transaction_id", { ascending: true })
    .limit(limit);
  if (cursor) catQuery = catQuery.gt("transaction_id", cursor);

  const { data: cats, error: catErr } = await catQuery;
  if (catErr) throw catErr;
  const catRows = cats || [];
  if (!catRows.length) {
    return { ok: true, processed: 0, promoted: 0, skipped: 0, next_cursor: null, rows: [] };
  }

  const transactionIds = catRows.map((row) => row.transaction_id).filter(Boolean);
  let txQuery = db
    .from("bank_transactions")
    .select("id,plaid_account_id,plaid_transaction_id,date,name,merchant_name,merchant_entity_id,counterparty_name,counterparties,amount,signed_amount,direction,category_primary,category_detailed,personal_finance_category,transaction_type,check_number,payment_channel,pending,accounting_review_required,accounting_review_reason,canonical_vendor_id,qbo_entity_type,qbo_entity_id,is_archived")
    .eq("business_id", businessId)
    .eq("is_archived", false)
    .in("id", transactionIds);
  if (options.accountId) txQuery = txQuery.eq("plaid_account_id", options.accountId);
  if (rangeStart) txQuery = txQuery.gte("date", rangeStart);
  if (dateTo) txQuery = txQuery.lte("date", dateTo);

  const { data: txns, error: txErr } = await txQuery;
  if (txErr) throw txErr;
  const txnById = new Map((txns || []).map((txn) => [txn.id, txn]));
  const bookkeepingStartDate = await getBookkeepingStartDate(db, businessId);
  const autoPostEnabled = await getAutoPostToQuickBooks(db, businessId);

  const updates = [];
  const rows = [];
  let processed = 0;
  let promoted = 0;
  let skipped = 0;

  for (const cat of catRows) {
    const bankTxn = txnById.get(cat.transaction_id);
    if (!bankTxn) {
      skipped += 1;
      continue;
    }
    processed += 1;
    if (!isTransactionInActiveBookkeepingScope(bankTxn, bookkeepingStartDate)) {
      skipped += 1;
      continue;
    }
    const meta = cat.meta || {};
    const checkHit = isCheck(bankTxn);
    const canonicalAccount = await resolveCanonicalAccountEvidence({
      businessId,
      db,
      cat,
      meta,
      transactionId: cat.transaction_id,
      source: options.source || "backlog_reconsideration",
      dependencies,
    });
    const account = canonicalAccount.account || accountFromCategorization(cat);
    const canonicalKey = canonicalAccount.canonicalAccountKey || canonicalAccountKey(cat, meta);
    const vendorEvidence = await resolveVendorEvidence({ db, businessId, bankTxn, meta });
    const canonicalAccountResolved = canonicalAccount.canonicalAccountResolved === true;
    const source = normalizeSource(meta.suggestion_source || cat.decided_by || "backlog_reconsideration");
    const decision = canAutoHandle(
      bankTxn,
      {
        source,
        confidence: cat.confidence || meta.confidence || "medium",
        accountId: account.id,
        accountName: account.name,
        taxonomyType: meta.taxonomy_type || null,
        isCheck: checkHit.is_check === true,
        meta,
        canonicalAccountResolved,
        canonicalAccountKey: canonicalKey,
        canonicalAccountReviewRequired:
          canonicalAccountResolved !== true ||
          meta.canonical_account_review_required === true ||
          meta.canonical_mapping_review_required === true,
        canonicalVendorId: vendorEvidence.canonicalVendorId || null,
        canonicalVendorReliable: vendorEvidence.canonicalVendorReliable === true,
        weakVendorEvidence: vendorEvidence.weakVendorEvidence === true,
        merchantEvidenceStrong:
          vendorEvidence.merchantEvidenceStrong === true ||
          Boolean(bankTxn.merchant_name && meta.suggestion_source === "universal_hint"),
        inBookkeepingScope: true,
        reconsiderationSource: options.source || "backlog_reconsideration",
      },
      {}
    );

    const decisionMeta = {
      ...meta,
      safe_to_auto_handle: decision.eligible === true,
      canonical_coa_resolved: canonicalAccountResolved,
      canonical_coa_revalidation_reason: canonicalAccount.reason || null,
      canonical_coa_revalidation_status: canonicalAccount.status || null,
      canonical_vendor_id: vendorEvidence.canonicalVendorId || meta.canonical_vendor_id || null,
      canonical_vendor_reliable: vendorEvidence.canonicalVendorReliable === true,
      canonical_vendor_resolution_reason: vendorEvidence.reason || null,
      merchant_evidence_strong: decision.evidence?.merchantEvidenceStrong === true,
      auto_handle_decision: {
        eligible: decision.eligible === true,
        confidence: decision.confidence,
        source: decision.source,
        reason: decision.reason,
        reconsideration_source: options.source || "backlog_reconsideration",
        at: nowIso,
      },
    };

    if (decision.eligible !== true || !account.id || !account.name) {
      skipped += 1;
      rows.push({ transaction_id: cat.transaction_id, promoted: false, reason: decision.reason });
      updates.push({
        business_id: businessId,
        transaction_id: cat.transaction_id,
        suggested_qbo_account_id: cat.suggested_qbo_account_id || null,
        suggested_qbo_account_name: cat.suggested_qbo_account_name || null,
        suggested_canonical_account_key: cat.suggested_canonical_account_key || canonicalKey || null,
        final_qbo_account_id: null,
        final_qbo_account_name: null,
        final_canonical_account_key: null,
        confidence: cat.confidence || meta.confidence || "medium",
        status: cat.status || "needs_review",
        post_after: null,
        meta: {
          ...decisionMeta,
          auto_handled_reason: decision.reason || canonicalAccount.reason || "review_required",
        },
        updated_at: nowIso,
      });
      continue;
    }

    const postAfter = computePostAfterForAutoPost(autoPostEnabled, Number(process.env.BOOKS_POST_GRACE_HOURS || 24));
    updates.push({
      business_id: businessId,
      transaction_id: cat.transaction_id,
      suggested_qbo_account_id: account.id,
      suggested_qbo_account_name: account.name,
      suggested_canonical_account_key: canonicalKey,
      final_qbo_account_id: account.id,
      final_qbo_account_name: account.name,
      final_canonical_account_key: canonicalKey,
      confidence: cat.confidence || meta.confidence || "medium",
      status: "auto_approved",
      post_after: postAfter,
      decided_by: "bizzi",
      decided_at: nowIso,
      meta: {
        ...decisionMeta,
        auto_approve_reason: decisionMeta.auto_approve_reason || "routine_expense_fully_resolved",
        auto_handled_reason: decision.reason,
      },
      updated_at: nowIso,
    });
    promoted += 1;
    rows.push({ transaction_id: cat.transaction_id, promoted: true, reason: decision.reason });
  }

  if (updates.length) {
    const { error: upsertErr } = await db
      .from("transaction_categorizations")
      .upsert(updates, { onConflict: "business_id,transaction_id" });
    if (upsertErr) throw upsertErr;
  }

  const last = catRows[catRows.length - 1]?.transaction_id || null;
  return {
    ok: true,
    processed,
    promoted,
    skipped,
    next_cursor: catRows.length === limit ? last : null,
    rows,
  };
}

export default {
  reconsiderNeedsReviewTransactions,
};
