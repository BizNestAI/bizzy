import { supabase } from "../supabaseAdmin.js";
import { computeMemoPrefixForLearning, canonicalTxnDirection, cleanMemoForPrefix } from "./vendorRuleLearner.js";
import { getBookkeepingStartDate, isTransactionInActiveBookkeepingScope } from "./bookkeepingScope.js";
import { resolveCanonicalQboAccount } from "./canonicalQboAccountResolver.js";
import { matchesTransactionStatusFilter } from "../../api/bookkeeping/routes/bookkeeping.transactions.routes.js";
import { refreshOperatorRequestSummaryBestEffort } from "./operatorRequestSummaryService.js";
import {
  getCanonicalAccountByKey,
  getCanonicalAccountForIntent,
  getCanonicalAccounts,
  getCanonicalIntentMappings,
} from "./canonicalCoaRegistry.js";

const devLog = (tag, payload) => {
  if (process.env.NODE_ENV !== "production") {
    console.info("[clarification]", tag, payload);
  }
};

const normalize = (str = "") => (str || "").toLowerCase().replace(/[^a-z0-9\s&-]+/g, " ").replace(/\s+/g, " ").trim();
const CLARIFICATION_TXN_SELECT =
  "id,date,plaid_transaction_id,pending_transaction_id,duplicate_fingerprint,is_archived,name,merchant_name,counterparty_name,merchant_entity_id,qbo_entity_type,qbo_entity_id,amount,direction,check_number,category_primary,personal_finance_category,pending,accounting_review_required,accounting_review_reason";

async function resolveCanonicalTransactionForClarification({ businessId, transactionId }) {
  if (!businessId || !transactionId) return null;

  const { data: exactRow, error: exactErr } = await supabase
    .from("bank_transactions")
    .select(CLARIFICATION_TXN_SELECT)
    .eq("business_id", businessId)
    .eq("id", transactionId)
    .maybeSingle();
  if (exactErr) throw new Error(exactErr?.message || "canonical_txn_lookup_failed");

  if (!exactRow) {
    return {
      originalTxnId: transactionId,
      canonicalTxnId: null,
      txn: null,
      wasRemapped: false,
      remapReason: "missing_transaction",
    };
  }

  if (exactRow.is_archived === false) {
    return {
      originalTxnId: transactionId,
      canonicalTxnId: exactRow.id,
      txn: exactRow,
      wasRemapped: false,
    };
  }

  const pickReplacement = async (builder, remapReason) => {
    const { data, error } = await builder.limit(5);
    if (error) throw new Error(error?.message || "canonical_txn_replacement_lookup_failed");
    const candidates = (data || []).filter((row) => row?.id && row.id !== exactRow.id && row.is_archived === false);
    const replacement = candidates[0] || null;
    if (!replacement) return null;
    devLog("clarification_txn_remapped", {
      original_transaction_id: transactionId,
      canonical_transaction_id: replacement.id,
      reason: remapReason,
    });
    return {
      originalTxnId: transactionId,
      canonicalTxnId: replacement.id,
      txn: replacement,
      wasRemapped: true,
      remapReason,
    };
  };

  if (exactRow.plaid_transaction_id) {
    const replacement = await pickReplacement(
      supabase
        .from("bank_transactions")
        .select(CLARIFICATION_TXN_SELECT)
        .eq("business_id", businessId)
        .eq("is_archived", false)
        .or(
          `pending_transaction_id.eq.${exactRow.plaid_transaction_id},plaid_transaction_id.eq.${exactRow.plaid_transaction_id}`
        ),
      "plaid_linkage"
    );
    if (replacement) return replacement;
  }

  if (exactRow.pending_transaction_id) {
    const replacement = await pickReplacement(
      supabase
        .from("bank_transactions")
        .select(CLARIFICATION_TXN_SELECT)
        .eq("business_id", businessId)
        .eq("is_archived", false)
        .or(
          `plaid_transaction_id.eq.${exactRow.pending_transaction_id},pending_transaction_id.eq.${exactRow.pending_transaction_id}`
        ),
      "plaid_linkage"
    );
    if (replacement) return replacement;
  }

  if (exactRow.duplicate_fingerprint) {
    const { data, error } = await supabase
      .from("bank_transactions")
      .select(CLARIFICATION_TXN_SELECT)
      .eq("business_id", businessId)
      .eq("is_archived", false)
      .eq("duplicate_fingerprint", exactRow.duplicate_fingerprint)
      .limit(5);
    if (error) throw new Error(error?.message || "canonical_txn_fingerprint_lookup_failed");
    const candidates = (data || []).filter((row) => row?.id && row.id !== exactRow.id);
    if (candidates.length === 1) {
      const replacement = candidates[0];
      devLog("clarification_txn_remapped", {
        original_transaction_id: transactionId,
        canonical_transaction_id: replacement.id,
        reason: "duplicate_fingerprint",
      });
      return {
        originalTxnId: transactionId,
        canonicalTxnId: replacement.id,
        txn: replacement,
        wasRemapped: true,
        remapReason: "duplicate_fingerprint",
      };
    }
  }

  return {
    originalTxnId: transactionId,
    canonicalTxnId: null,
    txn: null,
    wasRemapped: false,
    remapReason: "archived_without_active_replacement",
  };
}

function answerIntentCandidates(answerNorm = "") {
  const normalized = normalize(answerNorm);
  if (!normalized) return [];
  const candidates = new Set();
  candidates.add(normalized);
  candidates.add(normalized.replace(/\s+/g, "_"));

  const explicitAliases = {
    "owner draw": "owner_draw",
    "owner distribution": "owner_distribution",
    "owner distributions": "owner_distributions",
    "owner contribution": "owner_contribution",
    "owner contributions": "owner_contributions",
    "loan payable": "loans_payable",
    "loans payable": "loans_payable",
    "loan principal": "loan_principal",
    "software subscription": "software",
    "software subscriptions": "software",
    "office supplies": "office_supplies",
    "supplies and materials": "materials",
    "supplies materials": "materials",
    "payment processing fees": "payment_processing",
    "bank charges": "bank_fees",
    "bank charges and fees": "bank_fees",
    "parking and tolls": "parking_tolls",
    "parking tolls": "parking_tolls",
  };
  if (explicitAliases[normalized]) candidates.add(explicitAliases[normalized]);

  const intentEntries = Object.keys(getCanonicalIntentMappings())
    .map((key) => ({ key, phrase: normalize(key.replace(/_/g, " ")) }))
    .filter((entry) => entry.phrase)
    .sort((a, b) => b.phrase.length - a.phrase.length);
  for (const entry of intentEntries) {
    const escaped = entry.phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|\\s)${escaped}(\\s|$)`).test(normalized)) {
      candidates.add(entry.key);
    }
  }

  for (const acct of getCanonicalAccounts()) {
    const preferred = normalize(acct.preferred_account_name);
    if (preferred && normalized === preferred) candidates.add(acct.canonical_account_key);
  }
  return Array.from(candidates);
}

function resolveClarificationCanonical(answerText = "") {
  const candidates = answerIntentCandidates(answerText);
  for (const candidate of candidates) {
    const canonical = getCanonicalAccountForIntent(candidate) || getCanonicalAccountByKey(candidate);
    if (canonical) return { intent: candidate, canonical };
  }
  return null;
}

export async function mapAnswerToCoa({
  businessId,
  txn = {},
  answerText = "",
  coaAccounts = [],
  dependencies = {},
  allowQboAccountCreate = false,
  allowProviderWrites = false,
} = {}) {
  void coaAccounts;
  if (!answerText) return null;
  const answerNorm = normalize(answerText);
  if (!answerNorm || answerNorm.length < 2) return null;

  const resolvedCanonical = resolveClarificationCanonical(answerText);
  if (!resolvedCanonical?.canonical) {
    devLog("answer_unmapped", { txn_id: txn.id, answer: answerText, reason: "unknown_canonical_intent" });
    return null;
  }

  const resolved = await resolveCanonicalQboAccount({
    businessId,
    intent: resolvedCanonical.intent,
    canonicalAccountKey: resolvedCanonical.canonical.canonical_account_key,
    transactionId: txn?.id || null,
    source: "clarification",
    allowCreate: allowQboAccountCreate === true && allowProviderWrites === true,
    dependencies,
  });

  if (resolved?.ok && resolved?.account?.id) {
    devLog("answer_mapped", {
      txn_id: txn.id,
      match: resolved.account?.name,
      canonical_account_key: resolved.canonical?.canonical_account_key,
      reason: resolved.status || "canonical_resolved",
    });
    return {
      account: {
        id: resolved.account.id,
        name: resolved.account.name,
        type: resolved.account.type || null,
        subType: resolved.account.subType || null,
      },
      canonical_account_key: resolved.canonical?.canonical_account_key || resolvedCanonical.canonical.canonical_account_key,
      canonical_account_name: resolved.canonical?.preferred_account_name || resolvedCanonical.canonical.preferred_account_name,
      canonical_resolution_status: resolved.status || "canonical_resolved",
      match_reason: resolved.status || "canonical_resolved",
      confidence: resolved.status === "existing_exact" ? "high" : "medium",
      created: resolved.created === true,
      review_required: false,
      resolution: resolved,
    };
  }

  devLog("answer_review_required", {
    txn_id: txn.id,
    answer: answerText,
    canonical_account_key: resolvedCanonical.canonical.canonical_account_key,
    reason: resolved?.reason || "canonical_resolution_failed",
  });
  return {
    account: null,
    canonical_account_key: resolved?.canonical?.canonical_account_key || resolvedCanonical.canonical.canonical_account_key,
    canonical_account_name: resolved?.canonical?.preferred_account_name || resolvedCanonical.canonical.preferred_account_name,
    canonical_resolution_status: resolved?.status || "needs_review",
    match_reason: resolved?.reason || "canonical_resolution_failed",
    confidence: "low",
    review_required: true,
    resolution: resolved || null,
  };
}

export async function createOrUpdateClarificationRequest({ businessId, txn, reason_code = "other", meta = {}, prompt_text = "What was this for?" }) {
  if (!businessId || !txn?.id) return { ok: false, error: "missing_inputs" };
  const nowIso = new Date().toISOString();

  const { data: existing, error: selErr } = await supabase
    .from("clarification_requests")
    .select("id,status,dismissed_until,answered_at")
    .eq("business_id", businessId)
    .eq("transaction_id", txn.id)
    .maybeSingle();
  if (selErr) return { ok: false, error: selErr?.message || "select_failed" };

  const dismissedUntil = existing?.dismissed_until ? Date.parse(existing.dismissed_until) : null;
  if (existing && existing.status === "answered") {
    return { ok: true, skipped: true, reason: "already_answered", id: existing.id };
  }
  if (existing && existing.status === "dismissed" && dismissedUntil && dismissedUntil > Date.now()) {
    return { ok: true, skipped: true, reason: "dismissed_recently", id: existing.id };
  }

  const payload = {
    business_id: businessId,
    transaction_id: txn.id,
    reason_code,
    prompt_text,
    meta: {
      ...meta,
      confidence: meta.confidence || null,
      suggestion_source: meta.suggestion_source || null,
      suggested_qbo_account_id: meta.suggested_qbo_account_id || null,
      suggested_qbo_account_name: meta.suggested_qbo_account_name || null,
      taxonomy_type: meta.taxonomy_type || null,
      is_check: meta.is_check || false,
    },
    status: "pending",
    updated_at: nowIso,
  };

  if (existing?.id) {
    const { error: updErr, data: updData } = await supabase
      .from("clarification_requests")
      .update(payload)
      .eq("id", existing.id)
      .select("id")
      .maybeSingle();
    if (updErr) return { ok: false, error: updErr?.message || "update_failed" };
    return { ok: true, id: updData?.id || existing.id, updated: true };
  }

  const { data: insData, error: insErr } = await supabase
    .from("clarification_requests")
    .upsert(payload, { onConflict: "business_id,transaction_id" })
    .select("id")
    .maybeSingle();
  if (insErr) return { ok: false, error: insErr?.message || "insert_failed" };
  return { ok: true, id: insData?.id, created: true };
}

export async function fetchPendingClarifications({ businessId, limit = 25 }) {
  if (!businessId) return { ok: false, error: "missing_business_id" };
  const cappedLimit = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 200);
  const nowIso = new Date().toISOString();

  const { data, error, count } = await supabase
    .from("clarification_requests")
    .select("id,transaction_id,status,reason_code,prompt_text,created_at,meta,dismissed_until", { count: "exact" })
    .eq("business_id", businessId)
    .eq("status", "pending")
    .or(`dismissed_until.is.null,dismissed_until.lte.${nowIso}`)
    .order("created_at", { ascending: true })
    .limit(cappedLimit);
  if (error) return { ok: false, error: error?.message || "fetch_failed" };

  const rows = [];
  for (const row of data || []) {
    let resolved = null;
    try {
      resolved = await resolveCanonicalTransactionForClarification({
        businessId,
        transactionId: row.transaction_id,
      });
    } catch (err) {
      if (process.env.NODE_ENV !== "production") {
        devLog("queue_txn_missing_canonical", {
          request_id: row.id,
          transaction_id: row.transaction_id,
          error: err?.message || String(err),
        });
      }
    }

    const canonicalTxnId = resolved?.canonicalTxnId || null;
    const txn = resolved?.txn || null;
    const remapped = !!resolved?.wasRemapped;

    if (remapped && canonicalTxnId && canonicalTxnId !== row.transaction_id) {
      if (process.env.NODE_ENV !== "production") {
        devLog("queue_txn_remapped", {
          request_id: row.id,
          original_transaction_id: row.transaction_id,
          canonical_transaction_id: canonicalTxnId,
          reason: resolved?.remapReason || null,
        });
      }
      const { error: repointErr } = await supabase
        .from("clarification_requests")
        .update({
          transaction_id: canonicalTxnId,
          updated_at: nowIso,
        })
        .eq("business_id", businessId)
        .eq("id", row.id);
      if (repointErr && process.env.NODE_ENV !== "production") {
        devLog("queue_txn_repoint_failed", {
          request_id: row.id,
          original_transaction_id: row.transaction_id,
          canonical_transaction_id: canonicalTxnId,
          error: repointErr?.message || repointErr,
        });
      }
    } else if (!txn && process.env.NODE_ENV !== "production") {
      devLog("queue_txn_missing_canonical", {
        request_id: row.id,
        transaction_id: row.transaction_id,
        reason: resolved?.remapReason || null,
      });
    }

    rows.push({
      id: row.id,
      transaction_id: row.transaction_id,
      canonical_transaction_id: canonicalTxnId,
      remapped,
      status: row.status,
      reason_code: row.reason_code,
      prompt_text: row.prompt_text,
      created_at: row.created_at,
      meta: row.meta || null,
      txn: txn
        ? {
            date: txn.date || null,
            amount: txn.amount ?? null,
            name: txn.name || null,
            merchant_name: txn.merchant_name || null,
            counterparty_name: txn.counterparty_name || null,
            plaid_account_id: txn.plaid_account_id || null,
            plaid_transaction_id: txn.plaid_transaction_id || null,
            direction: txn.direction || null,
            check_number: txn.check_number || null,
          }
        : null,
    });
  }

  devLog("queue_fetch", { businessId, returned: rows.length });
  return { ok: true, count: typeof count === "number" ? count : rows.length, rows };
}

async function ensurePendingRequestForTransaction({ businessId, transaction }) {
  if (!businessId || !transaction?.id) return null;
  const existing = transaction.operator_request?.id
    ? { id: transaction.operator_request.id, status: transaction.operator_request.status }
    : null;
  if (existing?.id) return existing;
  const result = await createOrUpdateClarificationRequest({
    businessId,
    txn: { id: transaction.id },
    reason_code: "other",
    prompt_text: Number(transaction.amount || 0) > 0 ? "What was this deposit for?" : "What was this charge for?",
    meta: {
      source: "operator_requests",
      suggested_qbo_account_id: transaction.suggestedAccountId || transaction.suggested_qbo_account_id || null,
      suggested_qbo_account_name: transaction.suggestedAccountName || transaction.suggested_qbo_account_name || null,
      suggested_canonical_account_key: transaction.suggested_canonical_account_key || null,
      transaction_snapshot: {
        date: transaction.date || null,
        amount: transaction.amount ?? null,
        merchant_name: transaction.vendor || transaction.payee || transaction.counterparty_name || transaction.merchant_name || null,
        description: transaction.description || transaction.name || null,
        plaid_account_id: transaction.plaid_account_id || null,
        source_account: transaction.currentAccount || transaction.account_name || transaction.account_official_name || null,
      },
    },
  });
  return result?.ok ? { id: result.id, status: "pending" } : null;
}

export async function fetchOperatorRequests({ businessId, page = 1, pageSize = 25, includeRows = true }) {
  if (!businessId) return { ok: false, error: "missing_business_id" };
  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const safePageSize = Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 100);

  const { error: staleErr } = await supabase.rpc("expire_stale_operator_requests", {
    p_business_id: businessId,
  });
  if (staleErr) throw new Error(staleErr?.message || "operator_stale_expire_failed");

  const { data: countRows, error: countErr } = await supabase.rpc("get_operator_request_counts_bounded", {
    p_business_id: businessId,
  });
  if (countErr) throw new Error(countErr?.message || "operator_counts_fetch_failed");
  const counts = Array.isArray(countRows) ? countRows[0] || {} : countRows || {};
  const outstandingCount = Number(counts.outstanding_count || 0);
  const answeredAwaitingReviewCount = Number(counts.answered_awaiting_review_count || 0);
  const accountingNeedsReviewCount = Number(counts.accounting_needs_review_count || 0);

  let paged = [];
  if (includeRows && outstandingCount > 0) {
    const { data: pageRows, error: pageErr } = await supabase.rpc("get_operator_requests_bounded", {
      p_business_id: businessId,
      p_limit: safePageSize,
      p_offset: (safePage - 1) * safePageSize,
    });
    if (pageErr) throw new Error(pageErr?.message || "operator_rows_fetch_failed");
    paged = pageRows || [];
  }
  const rows = [];

  for (const txn of paged) {
    const request = await ensurePendingRequestForTransaction({ businessId, transaction: txn });
    const merchant = txn.counterparty_name || txn.merchant_name || txn.name || "Unknown merchant";
    const sourceAccount = txn.account_name || txn.account_official_name || txn.currentAccount || null;
    rows.push({
      id: request?.id || txn.id,
      request_id: request?.id || null,
      transaction_id: txn.id,
      status: request?.status || "pending",
      reason_code: "other",
      prompt_text: Number(txn.amount || 0) > 0 ? "What was this deposit for?" : "What was this charge for?",
      created_at: null,
      meta: {
        suggested_qbo_account_id: txn.suggested_qbo_account_id || txn.suggestedAccountId || null,
        suggested_qbo_account_name: txn.suggested_qbo_account_name || txn.suggestedAccountName || null,
      },
      txn: {
        date: txn.date || null,
        amount: txn.signed_amount ?? txn.amount ?? null,
        name: txn.name || null,
        description: txn.name || null,
        merchant_name: merchant,
        counterparty_name: txn.counterparty_name || merchant,
        plaid_account_id: txn.plaid_account_id || null,
        source_account: sourceAccount,
        suggested_qbo_account_id: txn.suggested_qbo_account_id || txn.suggestedAccountId || null,
        suggested_qbo_account_name: txn.suggested_qbo_account_name || txn.suggestedAccountName || null,
      },
    });
  }

  if (includeRows) {
    refreshOperatorRequestSummaryBestEffort({
      businessId,
      reason: "operator_requests_rows_loaded",
    }).catch(() => null);
  }

  return {
    ok: true,
    outstanding_count: outstandingCount,
    answered_awaiting_review_count: answeredAwaitingReviewCount,
    accounting_needs_review_count: accountingNeedsReviewCount,
    count: outstandingCount,
    rows,
    meta: {
      page: safePage,
      page_size: safePageSize,
      total_count: outstandingCount,
      page_count: Math.max(1, Math.ceil(outstandingCount / safePageSize)),
    },
  };
}

async function upsertVendorRuleFromClarification({ businessId, txn, accountId, accountName }) {
  if (!businessId || !txn || !accountId) return { ok: true, skipped: true, reason: "missing_inputs" };
  const direction = canonicalTxnDirection(txn);
  if (direction === "UNKNOWN") return { ok: true, skipped: true, reason: "unknown_direction" };

  const merchantEntityId = txn.merchant_entity_id || null;
  const memoPrefix = computeMemoPrefixForLearning(txn, 20)?.prefix || null;
  let match_type = null;
  let match_value = null;
  if (merchantEntityId) {
    match_type = "merchant_entity_id";
    match_value = merchantEntityId;
  } else if (memoPrefix && memoPrefix.length >= 8) {
    match_type = "memo_prefix";
    match_value = memoPrefix;
  } else {
    const cleaned = cleanMemoForPrefix(txn.name || txn.merchant_name || txn.counterparty_name || "");
    if (cleaned && cleaned.length >= 8) {
      match_type = "memo_prefix";
      match_value = cleaned.slice(0, 20);
    }
  }
  if (!match_type || !match_value) {
    return { ok: true, skipped: true, reason: "no_identity" };
  }

  const nowIso = new Date().toISOString();
  const counterpartyName = txn.counterparty_name || txn.merchant_name || txn.name || "Unknown";

  const { data: existingRows, error: selErr } = await supabase
    .from("vendor_rules")
    .select("id,default_qbo_account_id,default_qbo_account_name,usage_count,notes")
    .eq("business_id", businessId)
    .eq("match_type", match_type)
    .eq("match_value", match_value)
    .eq("rule_kind", "category_default")
    .limit(1);
  if (selErr) return { ok: false, error: selErr?.message || "vendor_rule_select_failed" };
  const existing = existingRows?.[0] || null;

  if (existing?.default_qbo_account_id && existing.default_qbo_account_id !== accountId) {
    const note = existing.notes || "";
    const conflictNote = note.includes("clarification")
      ? note
      : [note, "clarification rule conflict: kept existing default"].filter(Boolean).join(" | ");
    await supabase
      .from("vendor_rules")
      .update({ notes: conflictNote })
      .eq("business_id", businessId)
      .eq("id", existing.id);
    devLog("vendor_rule_conflict_skipped", { match_type, match_value, existing_account: existing.default_qbo_account_id });
    return { ok: true, skipped: true, reason: "conflict_existing_account" };
  }

  if (existing?.id) {
    const payload = {
      default_qbo_account_id: accountId,
      default_qbo_account_name: accountName || null,
      usage_count: (existing.usage_count || 0) + 1,
      last_used_at: nowIso,
      direction_hint: direction,
      source: "clarification",
      confidence: existing.default_qbo_account_id ? "high" : "medium",
      counterparty_confidence: merchantEntityId ? "high" : "medium",
      rule_kind: "category_default",
    };
    const { error: updErr, data: updData } = await supabase
      .from("vendor_rules")
      .update(payload)
      .eq("business_id", businessId)
      .eq("id", existing.id)
      .select("id,match_type,match_value")
      .maybeSingle();
    if (updErr) return { ok: false, error: updErr?.message || "vendor_rule_update_failed" };
    devLog("vendor_rule_written", { id: updData?.id || existing.id, match_type, match_value });
    return { ok: true, rule: updData || { id: existing.id, match_type, match_value } };
  }

  const insertPayload = {
    business_id: businessId,
    match_type,
    match_value,
    counterparty_name: counterpartyName,
    counterparty_confidence: merchantEntityId ? "high" : "medium",
    default_qbo_account_id: accountId,
    default_qbo_account_name: accountName || null,
    direction_hint: direction,
    confidence: merchantEntityId ? "high" : "medium",
    usage_count: 1,
    last_used_at: nowIso,
    source: "clarification",
    rule_kind: "category_default",
  };
  const { data: insData, error: insErr } = await supabase
    .from("vendor_rules")
    .insert(insertPayload)
    .select("id,match_type,match_value")
    .maybeSingle();
  if (insErr) return { ok: false, error: insErr?.message || "vendor_rule_insert_failed" };
  devLog("vendor_rule_written", { id: insData?.id, match_type, match_value });
  return { ok: true, rule: insData };
}

export async function processClarificationAnswers({ businessId, answers = [], answeredByUserId = null }) {
  if (!businessId) return { ok: false, error: "missing_business_id" };
  if (!Array.isArray(answers) || !answers.length) return { ok: false, error: "missing_answers" };

  const sanitized = answers
    .map((a) => ({
      request_id: a?.request_id || a?.id || a?.requestId,
      transaction_id: a?.transaction_id || a?.transactionId || null,
      answer_text: typeof a?.answer_text === "string" ? a.answer_text : a?.answerText,
      selected_intent: typeof a?.selected_intent === "string" ? a.selected_intent : typeof a?.intent === "string" ? a.intent : null,
    }))
    .filter((a) => a.request_id && a.transaction_id && typeof a.answer_text === "string");
  if (!sanitized.length) return { ok: false, error: "invalid_answers" };

  const requestIds = sanitized.map((a) => a.request_id);
  const nowIso = new Date().toISOString();

  const { data: reqRows, error: reqErr } = await supabase
    .from("clarification_requests")
    .select("*")
    .eq("business_id", businessId)
    .in("id", requestIds);
  if (reqErr) return { ok: false, error: reqErr?.message || "clarification_fetch_failed" };
  const reqMap = (reqRows || []).reduce((acc, row) => {
    acc[row.id] = row;
    return acc;
  }, {});

  const resolutionMap = {};
  for (const ans of sanitized) {
    try {
      resolutionMap[ans.request_id] = await resolveCanonicalTransactionForClarification({
        businessId,
        transactionId: ans.transaction_id,
      });
    } catch (err) {
      return { ok: false, error: err?.message || "canonical_resolution_failed" };
    }
  }

  const canonicalTxnIds = Array.from(
    new Set(
      Object.values(resolutionMap)
        .map((resolved) => resolved?.canonicalTxnId)
        .filter(Boolean)
    )
  );

  const { data: catRows } = canonicalTxnIds.length
    ? await supabase
        .from("transaction_categorizations")
        .select("transaction_id,status,meta")
        .eq("business_id", businessId)
        .in("transaction_id", canonicalTxnIds)
    : { data: [] };
  const catMeta = {};
  (catRows || []).forEach((row) => {
    catMeta[row.transaction_id] = row.meta || {};
  });

  const bookkeepingStartDate = await getBookkeepingStartDate(supabase, businessId);
  const results = [];
  let mapped = 0;
  let unmapped = 0;

  for (const ans of sanitized) {
    const req = reqMap[ans.request_id];
    const resolved = resolutionMap[ans.request_id] || null;
    const txn = resolved?.txn || null;
    const canonicalTxnId = resolved?.canonicalTxnId || null;
    let effectiveReq = req;
    if (!effectiveReq && ans.request_id === ans.transaction_id) {
      const created = await createOrUpdateClarificationRequest({
        businessId,
        txn: { id: ans.transaction_id },
        reason_code: "other",
        prompt_text: "What was this for?",
        meta: { source: "operator_requests_answer_submit" },
      });
      if (created?.ok && created.id) {
        const { data: createdReq, error: createdReqErr } = await supabase
          .from("clarification_requests")
          .select("*")
          .eq("business_id", businessId)
          .eq("id", created.id)
          .maybeSingle();
        if (createdReqErr) return { ok: false, error: createdReqErr?.message || "clarification_create_fetch_failed" };
        effectiveReq = createdReq;
      }
    }
    if (!effectiveReq || effectiveReq.transaction_id !== ans.transaction_id) {
      results.push({ request_id: ans.request_id, transaction_id: ans.transaction_id, error: "not_found_or_mismatch" });
      unmapped += 1;
      continue;
    }
    if (effectiveReq.status !== "pending") {
      results.push({ request_id: ans.request_id, transaction_id: ans.transaction_id, error: "not_pending" });
      unmapped += 1;
      continue;
    }
    if (!txn || !canonicalTxnId) {
      if (process.env.NODE_ENV !== "production") {
        devLog("canonical_transaction_not_found", {
          request_id: ans.request_id,
          transaction_id: ans.transaction_id,
          remap_reason: resolved?.remapReason || null,
        });
      }
      results.push({ request_id: ans.request_id, transaction_id: ans.transaction_id, error: "canonical_transaction_not_found" });
      unmapped += 1;
      continue;
    }
    if (txn.pending === true) {
      await supabase
        .from("transaction_categorizations")
        .upsert(
          {
            business_id: businessId,
            transaction_id: canonicalTxnId,
            status: "needs_review",
            post_after: null,
            post_error: "pending_transaction_not_postable",
            pending_blocked_at: nowIso,
            meta: { ...(catMeta[canonicalTxnId] || {}), post_block_reason: "pending_transaction_not_postable" },
          },
          { onConflict: "business_id,transaction_id" }
        );
      results.push({
        request_id: ans.request_id,
        transaction_id: ans.transaction_id,
        canonical_transaction_id: canonicalTxnId,
        error: "pending_transaction_not_postable",
      });
      unmapped += 1;
      continue;
    }
    if (txn.accounting_review_required === true) {
      results.push({
        request_id: ans.request_id,
        transaction_id: ans.transaction_id,
        canonical_transaction_id: canonicalTxnId,
        error: "plaid_accounting_review_required",
      });
      unmapped += 1;
      continue;
    }
    if (!isTransactionInActiveBookkeepingScope(txn, bookkeepingStartDate)) {
      results.push({
        request_id: ans.request_id,
        transaction_id: ans.transaction_id,
        canonical_transaction_id: canonicalTxnId,
        error: "transaction_before_bookkeeping_start_date",
        bookkeeping_start_date: bookkeepingStartDate,
      });
      unmapped += 1;
      continue;
    }
    const currentCat = catRows?.find((row) => row.transaction_id === canonicalTxnId) || {};
    if (!matchesTransactionStatusFilter("needs_review", currentCat)) {
      results.push({
        request_id: ans.request_id,
        transaction_id: ans.transaction_id,
        canonical_transaction_id: canonicalTxnId,
        error: "transaction_not_needs_review",
      });
      unmapped += 1;
      continue;
    }
    const answerText = (ans.answer_text || "").trim();
    if (answerText.length < 2 || answerText.length > 200) {
      results.push({ request_id: ans.request_id, transaction_id: ans.transaction_id, error: "invalid_answer_length" });
      unmapped += 1;
      continue;
    }

    let mapping = null;
    try {
      mapping = await mapAnswerToCoa({
        businessId,
        txn,
        answerText,
        allowQboAccountCreate: false,
        allowProviderWrites: false,
      });
    } catch (err) {
      mapping = {
        account: null,
        canonical_account_key: null,
        canonical_account_name: null,
        canonical_resolution_status: "lookup_failed",
        match_reason: err?.message || "customer_answer_account_suggestion_failed",
        confidence: "low",
        review_required: true,
        resolution: null,
      };
    }
    const baseMeta = { ...(catMeta[canonicalTxnId] || {}) };
    const requestMeta = {
      ...(effectiveReq.meta || {}),
      selected_intent: ans.selected_intent || null,
      customer_context_only: true,
      non_authoritative_account_evidence: mapping
        ? {
            qbo_account_id: mapping.account?.id || null,
            qbo_account_name: mapping.account?.name || null,
            canonical_account_key: mapping.canonical_account_key || null,
            canonical_account_name: mapping.canonical_account_name || null,
            resolution_status: mapping.canonical_resolution_status || null,
            match_reason: mapping.match_reason || null,
            review_required: mapping.review_required === true,
          }
        : null,
      transaction_context_snapshot: {
        date: txn.date || null,
        amount: txn.amount ?? null,
        name: txn.name || null,
        merchant_name: txn.merchant_name || null,
        counterparty_name: txn.counterparty_name || null,
        plaid_account_id: txn.plaid_account_id || null,
        direction: txn.direction || null,
      },
    };

    if (resolved?.wasRemapped && canonicalTxnId && canonicalTxnId !== effectiveReq.transaction_id && txn.is_archived !== true) {
      const { error: remapReqErr } = await supabase
        .from("clarification_requests")
        .update({
          transaction_id: canonicalTxnId,
          updated_at: nowIso,
        })
        .eq("business_id", businessId)
        .eq("id", effectiveReq.id);
      if (remapReqErr) {
        results.push({ request_id: ans.request_id, transaction_id: ans.transaction_id, error: "clarification_repoint_failed" });
        unmapped += 1;
        continue;
      }
      devLog("clarification_request_repointed", {
        request_id: ans.request_id,
        original_transaction_id: ans.transaction_id,
        canonical_transaction_id: canonicalTxnId,
      });
    }

    const { error: clarErr } = await supabase
      .from("clarification_requests")
      .update({
        status: "answered",
        answered_at: nowIso,
        answered_by: "user",
        answered_by_user_id: answeredByUserId || null,
        answer_text: answerText,
        selected_intent: ans.selected_intent || null,
        meta: requestMeta,
        updated_at: nowIso,
      })
      .eq("business_id", businessId)
      .eq("id", effectiveReq.id);
    if (clarErr) {
      results.push({ request_id: ans.request_id, transaction_id: ans.transaction_id, error: "clarification_update_failed" });
      unmapped += 1;
      continue;
    }

    if (mapping?.account?.id && mapping?.account?.name) {
      mapped += 1;
    } else {
      unmapped += 1;
    }

    results.push({
      request_id: ans.request_id,
      transaction_id: ans.transaction_id,
      canonical_transaction_id: canonicalTxnId,
      remapped: !!resolved?.wasRemapped,
      mapped: Boolean(mapping?.account?.id),
      status: "answered",
      accounting_status: "needs_review",
      final_qbo_account_id: null,
      final_qbo_account_name: null,
    });
  }

  if (results.some((row) => row?.status === "answered")) {
    await refreshOperatorRequestSummaryBestEffort({
      businessId,
      reason: "customer_answer",
    });
  }

  return { ok: true, updated: sanitized.length, mapped, unmapped, rows: results };
}

export default {
  fetchPendingClarifications,
  fetchOperatorRequests,
  mapAnswerToCoa,
  createOrUpdateClarificationRequest,
  processClarificationAnswers,
};
