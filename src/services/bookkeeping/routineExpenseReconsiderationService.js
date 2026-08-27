import { isCheck } from "./checkDetector.js";
import { computePostAfterForAutoPost, getAutoPostToQuickBooks } from "./autoPostControl.js";
import { getBookkeepingStartDate, isTransactionInActiveBookkeepingScope } from "./bookkeepingScope.js";
import { isReviewAccount } from "./autoHandlingPolicy.js";
import { decideBookkeepingCategorization } from "./bookkeepingCategorizationDecisionService.js";
import { resolveCanonicalVendorForTransaction } from "./canonicalVendorService.js";
import { resolveCanonicalQboAccount, validateCanonicalQboAccountForPromotion } from "./canonicalQboAccountResolver.js";
import { resolveIntentToCanonicalKey } from "./canonicalCoaRegistry.js";
import { getUniversalVendorHintForTransaction } from "./universalVendorHintMatcher.js";
import { getVendorRuleForTransaction } from "./vendorRuleMatcher.js";
import { canonicalTxnDirection, looksLikeTaxonomyLandmineMemo } from "./vendorRuleLearner.js";
import {
  isStrongUniversalVendorEvidence,
  withCategorizationPolicyVersion,
} from "./categorizationEvidencePolicy.js";

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

async function fetchActiveQboAccountById({ businessId, accountId, fallbackName = null, db, dependencies = {} }) {
  if (!businessId || !accountId) return null;
  const getQBOClient = dependencies.getQBOClient || (async (id) => {
    const mod = await import("../../utils/qboClient.js");
    return mod.getQBOClient(id);
  });
  try {
    const qbo = await getQBOClient(businessId);
    if (!qbo?.findAccounts) return { id: String(accountId), name: fallbackName || String(accountId), type: null, subType: null };
    const result = await new Promise((resolve, reject) => {
      qbo.findAccounts({ Active: true }, (err, data) => {
        if (err) return reject(err);
        return resolve(data);
      });
    });
    const accounts = Array.isArray(result?.QueryResponse?.Account) ? result.QueryResponse.Account : [];
    const hit = accounts.find((account) => String(account.Id || account.id) === String(accountId));
    if (!hit || hit.Active === false) return null;
    return {
      id: String(hit.Id || hit.id),
      name: hit.Name || hit.name || fallbackName || String(accountId),
      type: hit.AccountType || hit.type || null,
      subType: hit.AccountSubType || hit.subType || null,
    };
  } catch {
    return { id: String(accountId), name: fallbackName || String(accountId), type: null, subType: null };
  }
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
      type: resolved.account.type || resolved.account.AccountType || null,
      subType: resolved.account.subType || resolved.account.AccountSubType || null,
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
  const transactionIds = Array.isArray(options.transactionIds)
    ? Array.from(new Set(options.transactionIds.map((id) => (id ? String(id) : null)).filter(Boolean)))
    : [];

  let catQuery = db
    .from("transaction_categorizations")
    .select("transaction_id,business_id,status,suggested_qbo_account_id,suggested_qbo_account_name,suggested_canonical_account_key,final_canonical_account_key,confidence,meta,final_qbo_account_id,final_qbo_account_name,decided_by,post_after,qbo_txn_id")
    .eq("business_id", businessId)
    .in("status", ["needs_review", "uncategorized"])
    .is("qbo_txn_id", null)
    .order("transaction_id", { ascending: true })
    .limit(limit);
  if (transactionIds.length) catQuery = catQuery.in("transaction_id", transactionIds);
  if (cursor && !transactionIds.length) catQuery = catQuery.gt("transaction_id", cursor);

  const { data: cats, error: catErr } = await catQuery;
  if (catErr) throw catErr;
  const catRows = cats || [];
  if (!catRows.length) {
    return { ok: true, processed: 0, promoted: 0, skipped: 0, next_cursor: null, rows: [] };
  }

  const catTransactionIds = catRows.map((row) => row.transaction_id).filter(Boolean);
  const { data: clarRows } = await db
    .from("clarification_requests")
    .select("transaction_id,status")
    .eq("business_id", businessId)
    .in("transaction_id", catTransactionIds);
  const answeredAwaitingReview = new Set(
    (clarRows || [])
      .filter((row) => String(row?.status || "").toLowerCase() === "answered")
      .map((row) => String(row.transaction_id))
  );
  let txQuery = db
    .from("bank_transactions")
    .select("id,plaid_account_id,plaid_transaction_id,date,name,merchant_name,merchant_entity_id,counterparty_name,counterparties,amount,signed_amount,direction,category_primary,category_detailed,personal_finance_category,transaction_type,check_number,payment_channel,pending,accounting_review_required,accounting_review_reason,canonical_vendor_id,qbo_entity_type,qbo_entity_id,is_archived")
    .eq("business_id", businessId)
    .eq("is_archived", false)
    .in("id", catTransactionIds);
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
    if (answeredAwaitingReview.has(String(cat.transaction_id))) {
      skipped += 1;
      rows.push({ transaction_id: cat.transaction_id, promoted: false, reason: "answered_awaiting_accountant_review" });
      continue;
    }
    const meta = cat.meta || {};
    const checkHit = isCheck(bankTxn);
    const vendorRule = await getVendorRuleForTransaction({ businessId, bankTransaction: bankTxn, db });
    const txnDir = canonicalTxnDirection(bankTxn);
    const vendorRuleDirection = String(vendorRule?.direction_hint || "").toUpperCase();
    const vendorRuleDirectionMatches =
      !vendorRuleDirection ||
      vendorRuleDirection === "UNKNOWN" ||
      txnDir === "UNKNOWN" ||
      vendorRuleDirection === txnDir;
    if (
      !checkHit.is_check &&
      vendorRule?.default_qbo_account_id &&
      vendorRuleDirectionMatches &&
      !looksLikeTaxonomyLandmineMemo(bankTxn)
    ) {
      const account = await fetchActiveQboAccountById({
        businessId,
        accountId: vendorRule.default_qbo_account_id,
        fallbackName: vendorRule.default_qbo_account_name,
        db,
        dependencies,
      });
      const confidenceTier = vendorRule.match_reason === "merchant_entity_id" ? "very_high" : "high";
      const decision = decideBookkeepingCategorization({
        transaction: bankTxn,
        account: account || {
          id: vendorRule.default_qbo_account_id,
          name: vendorRule.default_qbo_account_name,
        },
        evidence: {
          source: "approved_business_rule",
          confidenceTier,
          taxonomyType: meta.taxonomy_type || null,
          isCheck: false,
          meta,
          canonicalAccountResolved: true,
          canonicalVendorId: bankTxn.canonical_vendor_id || meta.canonical_vendor_id || null,
          canonicalVendorReliable: true,
          merchantEvidenceStrong: true,
          inBookkeepingScope: true,
          reconsiderationSource: options.source || "backlog_reconsideration",
          reason: "approved_business_rule",
        },
        businessContext: {},
      });
      const decisionMeta = withCategorizationPolicyVersion({
        ...meta,
        suggestion_source: "vendor_rule",
        evidence_source: "approved_business_rule",
        confidence_tier: confidenceTier,
        vendor_rule_id: vendorRule.id,
        vendor_rule_match_reason: vendorRule.match_reason,
        vendor_rule_match_score: vendorRule.match_score,
        vendor_rule_counterparty_name: vendorRule.counterparty_name || null,
        vendor_rule_coa_id: account?.id || vendorRule.default_qbo_account_id,
        vendor_rule_coa_name: account?.name || vendorRule.default_qbo_account_name,
        merchant_evidence_strong: true,
        safe_to_auto_handle: decision.auto_handle === true,
        safe_to_auto_post: decision.auto_handle === true,
        auto_handle_decision: {
          eligible: decision.auto_handle === true,
          confidence: decision.confidence_tier,
          source: decision.evidence_source,
          reason: decision.block_reason || decision.reason,
          reconsideration_source: options.source || "backlog_reconsideration",
          at: nowIso,
        },
      });
      if (decision.auto_handle === true && account?.id && account?.name) {
        const postAfter = computePostAfterForAutoPost(autoPostEnabled, Number(process.env.BOOKS_POST_GRACE_HOURS || 24));
        updates.push({
          business_id: businessId,
          transaction_id: cat.transaction_id,
          suggested_qbo_account_id: account.id,
          suggested_qbo_account_name: account.name,
          suggested_canonical_account_key: cat.suggested_canonical_account_key || meta.canonical_account_key || null,
          final_qbo_account_id: account.id,
          final_qbo_account_name: account.name,
          final_canonical_account_key: cat.suggested_canonical_account_key || meta.canonical_account_key || null,
          confidence: "high",
          status: "auto_approved",
          post_after: postAfter,
          decided_by: "bizzi",
          decided_at: nowIso,
          meta: {
            ...decisionMeta,
            auto_approve_reason: "approved_business_rule",
            auto_handled_reason: decision.reason,
          },
          updated_at: nowIso,
        });
        promoted += 1;
        rows.push({ transaction_id: cat.transaction_id, promoted: true, reason: decision.reason });
        continue;
      }
      skipped += 1;
      rows.push({ transaction_id: cat.transaction_id, promoted: false, reason: decision.block_reason || decision.reason });
      updates.push({
        business_id: businessId,
        transaction_id: cat.transaction_id,
        suggested_qbo_account_id: account?.id || cat.suggested_qbo_account_id || null,
        suggested_qbo_account_name: account?.name || cat.suggested_qbo_account_name || null,
        suggested_canonical_account_key: cat.suggested_canonical_account_key || meta.canonical_account_key || null,
        final_qbo_account_id: null,
        final_qbo_account_name: null,
        final_canonical_account_key: null,
        confidence: cat.confidence || "high",
        status: cat.status || "needs_review",
        post_after: null,
        meta: {
          ...decisionMeta,
          auto_handled_reason: decision.block_reason || decision.reason,
        },
        updated_at: nowIso,
      });
      continue;
    }
    const universalHint = await getUniversalVendorHintForTransaction({ bankTxn });
    if (!checkHit.is_check && isStrongUniversalVendorEvidence(universalHint)) {
      const canonicalKey = resolveIntentToCanonicalKey(universalHint.primary_intent);
      const canonicalResolution = await resolveCanonicalQboAccount({
        businessId,
        intent: universalHint.primary_intent,
        transactionId: cat.transaction_id,
        source: options.source || "backlog_reconsideration",
        allowCreate: false,
        dependencies: {
          ...(dependencies || {}),
          supabase: db,
        },
      });
      const account =
        canonicalResolution?.ok && canonicalResolution?.account?.id && canonicalResolution?.review_required !== true
          ? {
              id: String(canonicalResolution.account.id),
              name: canonicalResolution.account.name || canonicalResolution.account.fullyQualifiedName || null,
              type: canonicalResolution.account.type || canonicalResolution.account.AccountType || null,
              subType: canonicalResolution.account.subType || canonicalResolution.account.AccountSubType || null,
            }
          : { id: null, name: null };
      const vendorEvidence = await resolveVendorEvidence({
        db,
        businessId,
        bankTxn,
        meta: {
          ...meta,
          suggestion_source: "universal_hint",
          canonical_account_key: canonicalResolution?.canonical?.canonical_account_key || canonicalKey || null,
        },
      });
      const canonicalAccountResolved = Boolean(account.id && account.name);
      const decision = decideBookkeepingCategorization({
        transaction: bankTxn,
        account,
        evidence: {
          source: "universal_hint",
          confidenceTier: universalHint.confidence || "high",
          taxonomyType: meta.taxonomy_type || null,
          isCheck: false,
          meta,
          canonicalAccountResolved,
          canonicalAccountKey: canonicalResolution?.canonical?.canonical_account_key || canonicalKey || null,
          canonicalAccountReviewRequired: canonicalAccountResolved !== true,
          canonicalVendorId: vendorEvidence.canonicalVendorId || null,
          canonicalVendorReliable: vendorEvidence.canonicalVendorReliable === true,
          weakVendorEvidence: vendorEvidence.weakVendorEvidence === true,
          merchantEvidenceStrong:
            vendorEvidence.merchantEvidenceStrong === true ||
            Boolean(bankTxn.merchant_entity_id || bankTxn.merchant_name || bankTxn.counterparty_name),
          inBookkeepingScope: true,
          reconsiderationSource: options.source || "backlog_reconsideration",
        },
        businessContext: {},
      });
      const decisionMeta = withCategorizationPolicyVersion({
        ...meta,
        suggestion_source: "universal_hint",
        universal_bootstrap_mode: true,
        universal_hint: {
          key: universalHint.matched_rule_key,
          canonical_vendor: universalHint.canonical_vendor,
          primary_intent: universalHint.primary_intent,
          intents: universalHint.intents,
          confidence: universalHint.confidence,
          match_type: universalHint.match_type || null,
          matched_value: universalHint.matched_value || null,
          canonical_account_key: canonicalResolution?.canonical?.canonical_account_key || canonicalKey || null,
          canonical_account_name: canonicalResolution?.canonical?.preferred_account_name || null,
          canonical_resolution_status: canonicalResolution?.status || null,
        },
        canonical_account_key: canonicalResolution?.canonical?.canonical_account_key || canonicalKey || null,
        canonical_coa_resolved: canonicalAccountResolved,
        canonical_account_review_required: canonicalAccountResolved !== true,
        canonical_setup_required: canonicalAccountResolved !== true,
        canonical_setup_required_reason: canonicalResolution?.reason || null,
        canonical_vendor_id: vendorEvidence.canonicalVendorId || null,
        canonical_vendor_reliable: vendorEvidence.canonicalVendorReliable === true,
        merchant_evidence_strong: decision.evidence?.merchantEvidenceStrong === true,
        evidence_source: decision.evidence_source,
        confidence_tier: decision.confidence_tier,
        safe_to_auto_handle: decision.auto_handle === true,
        safe_to_auto_post: decision.auto_handle === true,
        auto_handle_decision: {
          eligible: decision.auto_handle === true,
          confidence: decision.confidence_tier,
          source: decision.evidence_source,
          reason: decision.block_reason || decision.reason,
          reconsideration_source: options.source || "backlog_reconsideration",
          at: nowIso,
        },
      });
      if (decision.auto_handle === true && account.id && account.name) {
        const postAfter = computePostAfterForAutoPost(autoPostEnabled, Number(process.env.BOOKS_POST_GRACE_HOURS || 24));
        updates.push({
          business_id: businessId,
          transaction_id: cat.transaction_id,
          suggested_qbo_account_id: account.id,
          suggested_qbo_account_name: account.name,
          suggested_canonical_account_key: canonicalResolution?.canonical?.canonical_account_key || canonicalKey || null,
          final_qbo_account_id: account.id,
          final_qbo_account_name: account.name,
          final_canonical_account_key: canonicalResolution?.canonical?.canonical_account_key || canonicalKey || null,
          confidence: universalHint.confidence || "high",
          status: "auto_approved",
          post_after: postAfter,
          decided_by: "bizzi",
          decided_at: nowIso,
          meta: {
            ...decisionMeta,
            auto_approve_reason: "routine_expense_fully_resolved",
            auto_handled_reason: decision.reason,
          },
          updated_at: nowIso,
        });
        promoted += 1;
        rows.push({ transaction_id: cat.transaction_id, promoted: true, reason: decision.reason });
        continue;
      }
      updates.push({
        business_id: businessId,
        transaction_id: cat.transaction_id,
        suggested_qbo_account_id: account.id || null,
        suggested_qbo_account_name: account.name || null,
        suggested_canonical_account_key: canonicalResolution?.canonical?.canonical_account_key || canonicalKey || null,
        final_qbo_account_id: null,
        final_qbo_account_name: null,
        final_canonical_account_key: null,
        confidence: universalHint.confidence || "high",
        status: "needs_review",
        post_after: null,
        meta: {
          ...decisionMeta,
          auto_handled_reason: decision.reason || canonicalResolution?.reason || "canonical_setup_required",
        },
        updated_at: nowIso,
      });
      skipped += 1;
      rows.push({ transaction_id: cat.transaction_id, promoted: false, reason: decision.block_reason || decision.reason || canonicalResolution?.reason || "canonical_setup_required" });
      continue;
    }
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
    const decision = decideBookkeepingCategorization({
      transaction: bankTxn,
      account,
      evidence: {
        source,
        confidenceTier: cat.confidence || meta.confidence || "medium",
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
      businessContext: {},
    });

    const decisionMeta = {
      ...meta,
      safe_to_auto_handle: decision.auto_handle === true,
      evidence_source: decision.evidence_source,
      confidence_tier: decision.confidence_tier,
      canonical_coa_resolved: canonicalAccountResolved,
      canonical_coa_revalidation_reason: canonicalAccount.reason || null,
      canonical_coa_revalidation_status: canonicalAccount.status || null,
      canonical_vendor_id: vendorEvidence.canonicalVendorId || meta.canonical_vendor_id || null,
      canonical_vendor_reliable: vendorEvidence.canonicalVendorReliable === true,
      canonical_vendor_resolution_reason: vendorEvidence.reason || null,
      merchant_evidence_strong: decision.evidence?.merchantEvidenceStrong === true,
      auto_handle_decision: {
        eligible: decision.auto_handle === true,
        confidence: decision.confidence_tier,
        source: decision.evidence_source,
        reason: decision.block_reason || decision.reason,
        reconsideration_source: options.source || "backlog_reconsideration",
        at: nowIso,
      },
    };

    if (decision.auto_handle !== true || !account.id || !account.name) {
      skipped += 1;
      rows.push({ transaction_id: cat.transaction_id, promoted: false, reason: decision.block_reason || decision.reason });
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
        meta: withCategorizationPolicyVersion({
          ...decisionMeta,
          auto_handled_reason: decision.block_reason || decision.reason || canonicalAccount.reason || "review_required",
        }),
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
      meta: withCategorizationPolicyVersion({
        ...decisionMeta,
        auto_approve_reason: decisionMeta.auto_approve_reason || "routine_expense_fully_resolved",
        auto_handled_reason: decision.reason,
      }),
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
    next_cursor: transactionIds.length ? null : catRows.length === limit ? last : null,
    rows,
  };
}

export default {
  reconsiderNeedsReviewTransactions,
};
