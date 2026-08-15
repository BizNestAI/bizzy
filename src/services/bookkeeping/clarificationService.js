import { supabase } from "../supabaseAdmin.js";
import { fetchChartOfAccounts } from "./qboAccounts.js";
import { mapIntentToCoa } from "./intentToCoaMapper.js";
import { computeMemoPrefixForLearning, canonicalTxnDirection, cleanMemoForPrefix } from "./vendorRuleLearner.js";
import { getBookkeepingStartDate, isTransactionInActiveBookkeepingScope } from "./bookkeepingScope.js";
import { computePostAfterForAutoPost, getAutoPostToQuickBooks } from "./autoPostControl.js";

const GRACE_HOURS = Number(process.env.BOOKS_POST_GRACE_HOURS || 24);

const devLog = (tag, payload) => {
  if (process.env.NODE_ENV !== "production") {
    console.info("[clarification]", tag, payload);
  }
};

const normalize = (str = "") => (str || "").toLowerCase().replace(/[^a-z0-9\s&-]+/g, " ").replace(/\s+/g, " ").trim();

async function resolveCanonicalTransactionForClarification({ businessId, transactionId }) {
  if (!businessId || !transactionId) return null;

  const { data: exactRow, error: exactErr } = await supabase
    .from("bank_transactions")
    .select(
      "id,date,plaid_transaction_id,pending_transaction_id,duplicate_fingerprint,is_archived,name,merchant_name,counterparty_name,merchant_entity_id,qbo_entity_type,qbo_entity_id,amount,direction,check_number,category_primary,personal_finance_category"
    )
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
        .select(
          "id,date,plaid_transaction_id,pending_transaction_id,duplicate_fingerprint,is_archived,name,merchant_name,counterparty_name,merchant_entity_id,qbo_entity_type,qbo_entity_id,amount,direction,check_number,category_primary,personal_finance_category"
        )
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
        .select(
          "id,date,plaid_transaction_id,pending_transaction_id,duplicate_fingerprint,is_archived,name,merchant_name,counterparty_name,merchant_entity_id,qbo_entity_type,qbo_entity_id,amount,direction,check_number,category_primary,personal_finance_category"
        )
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
      .select(
        "id,date,plaid_transaction_id,pending_transaction_id,duplicate_fingerprint,is_archived,name,merchant_name,counterparty_name,merchant_entity_id,qbo_entity_type,qbo_entity_id,amount,direction,check_number,category_primary,personal_finance_category"
      )
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

function scoreCoaNameMatch(answerNorm, acct) {
  const name = normalize(acct.name || acct.Name || "");
  if (!name) return { score: 0, reason: null };
  if (name === answerNorm) return { score: 120, reason: "name_exact" };
  if (answerNorm.startsWith(name) || name.startsWith(answerNorm)) return { score: 90, reason: "name_prefix" };
  if (answerNorm.includes(name) || name.includes(answerNorm)) return { score: 70, reason: "name_contains" };
  const answerTokens = answerNorm.split(" ").filter(Boolean);
  const nameTokens = name.split(" ").filter(Boolean);
  if (!answerTokens.length || !nameTokens.length) return { score: 0, reason: null };
  const overlap = answerTokens.filter((t) => nameTokens.includes(t));
  const score = (overlap.length / Math.max(answerTokens.length, nameTokens.length)) * 80;
  if (score > 0) return { score, reason: "token_overlap" };
  return { score: 0, reason: null };
}

export async function mapAnswerToCoa({ businessId, txn = {}, answerText = "", coaAccounts = [] }) {
  if (!answerText || !coaAccounts?.length) return null;
  const answerNorm = normalize(answerText);
  if (!answerNorm || answerNorm.length < 2) return null;

  // 1) Direct-ish name match against COA
  let best = null;
  let bestScore = 0;
  for (const acct of coaAccounts || []) {
    const { score, reason } = scoreCoaNameMatch(answerNorm, acct);
    if (score > bestScore) {
      bestScore = score;
      best = { acct, reason };
    }
  }
  if (best && bestScore >= 80) {
    devLog("answer_mapped", { txn_id: txn.id, match: best.acct?.name, reason: best.reason });
    return {
      account: { id: best.acct.id || best.acct.Id, name: best.acct.name || best.acct.Name },
      match_reason: best.reason || "name_match",
      confidence: bestScore >= 100 ? "high" : "medium",
    };
  }

  // 2) Intent keyword mapping (includes synonyms)
  const intentMatch = mapIntentToCoa({ businessId, intent: answerNorm, coaAccounts });
  if (intentMatch?.qbo_account_id) {
    devLog("answer_mapped", { txn_id: txn.id, match: intentMatch.qbo_account_name, reason: intentMatch.match_reason || "intent" });
    return {
      account: { id: intentMatch.qbo_account_id, name: intentMatch.qbo_account_name },
      match_reason: intentMatch.match_reason || "intent",
      confidence: "medium",
    };
  }

  // 3) Soft fuzzy against COA names
  let softBest = null;
  let softScore = 0;
  for (const acct of coaAccounts || []) {
    const { score, reason } = scoreCoaNameMatch(answerNorm, acct);
    if (score > softScore) {
      softScore = score;
      softBest = { acct, reason };
    }
  }
  if (softBest && softScore >= 50) {
    devLog("answer_mapped", { txn_id: txn.id, match: softBest.acct?.name, reason: softBest.reason || "soft_name" });
    return {
      account: { id: softBest.acct.id || softBest.acct.Id, name: softBest.acct.name || softBest.acct.Name },
      match_reason: softBest.reason || "soft_name",
      confidence: "low",
    };
  }

  devLog("answer_unmapped", { txn_id: txn.id, answer: answerText });
  return null;
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

export async function processClarificationAnswers({ businessId, answers = [] }) {
  if (!businessId) return { ok: false, error: "missing_business_id" };
  if (!Array.isArray(answers) || !answers.length) return { ok: false, error: "missing_answers" };

  const sanitized = answers
    .map((a) => ({
      request_id: a?.request_id || a?.id || a?.requestId,
      transaction_id: a?.transaction_id || a?.transactionId || null,
      answer_text: typeof a?.answer_text === "string" ? a.answer_text : a?.answerText,
    }))
    .filter((a) => a.request_id && a.transaction_id && typeof a.answer_text === "string");
  if (!sanitized.length) return { ok: false, error: "invalid_answers" };

  const requestIds = sanitized.map((a) => a.request_id);
  const txnIds = sanitized.map((a) => a.transaction_id);
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
        .select("transaction_id,meta")
        .eq("business_id", businessId)
        .in("transaction_id", canonicalTxnIds)
    : { data: [] };
  const catMeta = {};
  (catRows || []).forEach((row) => {
    catMeta[row.transaction_id] = row.meta || {};
  });

  const bookkeepingStartDate = await getBookkeepingStartDate(supabase, businessId);
  const autoPostEnabled = await getAutoPostToQuickBooks(supabase, businessId);
  const coaAccounts = await fetchChartOfAccounts(businessId, { includeSubaccounts: true });

  const results = [];
  let mapped = 0;
  let unmapped = 0;

  for (const ans of sanitized) {
    const req = reqMap[ans.request_id];
    const resolved = resolutionMap[ans.request_id] || null;
    const txn = resolved?.txn || null;
    const canonicalTxnId = resolved?.canonicalTxnId || null;
    if (!req || req.transaction_id !== ans.transaction_id) {
      results.push({ request_id: ans.request_id, transaction_id: ans.transaction_id, error: "not_found_or_mismatch" });
      unmapped += 1;
      continue;
    }
    if (req.status !== "pending") {
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
    const answerText = (ans.answer_text || "").trim();
    if (answerText.length < 2 || answerText.length > 200) {
      results.push({ request_id: ans.request_id, transaction_id: ans.transaction_id, error: "invalid_answer_length" });
      unmapped += 1;
      continue;
    }

    const mapping = await mapAnswerToCoa({ businessId, txn, answerText, coaAccounts });
    const baseMeta = { ...(catMeta[canonicalTxnId] || {}) };
    baseMeta.clarification_request_id = ans.request_id;
    baseMeta.clarification_answer_text = answerText;
    baseMeta.auto_approve_reason = "user_clarification";
    if (baseMeta.safe_to_auto_post !== true) {
      baseMeta.safe_to_auto_post = false;
    }

    let finalId = null;
    let finalName = null;
    let status = "needs_review";
    let post_after = null;
    let mappedFlag = false;

    if (mapping?.account?.id && mapping?.account?.name) {
      finalId = mapping.account.id;
      finalName = mapping.account.name;
      status = baseMeta.safe_to_auto_post === true ? "auto_approved" : "approved";
      post_after = computePostAfterForAutoPost(autoPostEnabled, GRACE_HOURS);
      mappedFlag = true;
    } else {
      baseMeta.clarification_unmapped = true;
      baseMeta.clarification_unmapped_reason = "no_safe_mapping";
    }

    const catPayload = {
      business_id: businessId,
      transaction_id: canonicalTxnId,
      status,
      final_qbo_account_id: finalId,
      final_qbo_account_name: finalName,
      decided_by: "user_clarification",
      decided_at: nowIso,
      updated_at: nowIso,
      post_after,
      post_error: null,
      meta: baseMeta,
      reason: "user_clarification",
    };

    if (resolved?.wasRemapped && canonicalTxnId && canonicalTxnId !== req.transaction_id && txn.is_archived !== true) {
      const { error: remapReqErr } = await supabase
        .from("clarification_requests")
        .update({
          transaction_id: canonicalTxnId,
          updated_at: nowIso,
        })
        .eq("business_id", businessId)
        .eq("id", ans.request_id);
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
        answer_text: answerText,
        meta: req.meta || null,
        updated_at: nowIso,
      })
      .eq("business_id", businessId)
      .eq("id", ans.request_id);
    if (clarErr) {
      results.push({ request_id: ans.request_id, transaction_id: ans.transaction_id, error: "clarification_update_failed" });
      unmapped += 1;
      continue;
    }

    const { error: catErr } = await supabase
      .from("transaction_categorizations")
      .upsert(catPayload, { onConflict: "business_id,transaction_id" });
    if (catErr) {
      results.push({ request_id: ans.request_id, transaction_id: ans.transaction_id, error: "categorization_update_failed" });
      unmapped += 1;
      continue;
    }

    if (mappedFlag) {
      const { error: learnErr } = await supabase.from("clarification_learning_events").insert({
        business_id: businessId,
        transaction_id: canonicalTxnId,
        vendor_key: txn.merchant_entity_id || (txn.counterparty_name || txn.merchant_name || txn.name || "").toLowerCase(),
        memo_key: computeMemoPrefixForLearning(txn, 20)?.prefix || null,
        user_answer_text: answerText,
        resulting_qbo_account_id: finalId,
        resulting_qbo_account_name: finalName,
        meta: { clarification_request_id: ans.request_id },
      });
      if (learnErr) {
        devLog("learning_insert_failed", { error: learnErr?.message || learnErr, transaction_id: ans.transaction_id });
      }
      const vr = await upsertVendorRuleFromClarification({
        businessId,
        txn,
        accountId: finalId,
        accountName: finalName,
      });
      if (vr?.error) {
        devLog("vendor_rule_error", { error: vr.error, transaction_id: ans.transaction_id });
      }
      mapped += 1;
    } else {
      unmapped += 1;
    }

    results.push({
      request_id: ans.request_id,
      transaction_id: ans.transaction_id,
      canonical_transaction_id: canonicalTxnId,
      remapped: !!resolved?.wasRemapped,
      mapped: mappedFlag,
      status: catPayload.status,
      final_qbo_account_id: finalId,
      final_qbo_account_name: finalName,
    });
  }

  return { ok: true, updated: sanitized.length, mapped, unmapped, rows: results };
}

export default {
  fetchPendingClarifications,
  mapAnswerToCoa,
  createOrUpdateClarificationRequest,
  processClarificationAnswers,
};
