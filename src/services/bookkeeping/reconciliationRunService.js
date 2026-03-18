// Reconciliation Run Engine (posting integrity) — not bank-statement reconciliation.
// Evaluates Plaid bank_transactions + Bizzi categ/posting metadata to populate reconciliation_runs + reconciliation_items.

import { supabase } from "../supabaseAdmin.js";

const CHUNK_SIZE = 500;
const NOW = () => new Date().toISOString();

const DEFAULT_SCOPE = "last_30_days";
const SCOPES = {
  last_30_days: 30,
  last_90_days: 90,
  this_month: null, // handled specially
};

function devLog(tag, payload) {
  if (process.env.NODE_ENV !== "production") {
    console.info("[reconciliationRun]", tag, payload);
  }
}

function normalizeDate(d) {
  if (!d) return null;
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(String(d));
  return ok ? d : null;
}

function computeRange(scope) {
  const today = new Date();
  const end = today.toISOString().slice(0, 10);
  if (scope === "this_month") {
    const start = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);
    return { start, end };
  }
  const days = SCOPES[scope] || SCOPES[DEFAULT_SCOPE];
  const startDate = new Date(today.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { start: startDate, end };
}

function normalizeDirection(txn) {
  const dir = (txn?.direction || "").toUpperCase();
  if (dir === "INFLOW") return "inflow";
  if (dir === "OUTFLOW") return "outflow";
  const signed = Number(txn?.signed_amount);
  if (Number.isFinite(signed)) return signed > 0 ? "inflow" : signed < 0 ? "outflow" : "unknown";
  const amt = Number(txn?.amount);
  if (Number.isFinite(amt)) return amt > 0 ? "inflow" : amt < 0 ? "outflow" : "unknown";
  return "unknown";
}

function categorizeItem({ bank, cat, nowTs, includePending }) {
  const statusLower = (cat?.status || "").toLowerCase();
  const pending = bank?.pending === true || cat?.meta?.pending === true;
  const hasCat = !!cat;
  const hasQbo = !!cat?.qbo_txn_id;
  const hasPostedAt = !!cat?.posted_at;
  const hasReconciled = !!cat?.reconciled_at;
  const postAfterTs = cat?.post_after ? Date.parse(cat.post_after) : null;
  const nextAttemptTs = cat?.meta?.next_post_attempt_at ? Date.parse(cat.meta.next_post_attempt_at) : null;
  const postBlocked = !!cat?.meta?.post_block_reason;
  const retryCount = Number(cat?.meta?.post_retry_count || 0);

  const needsReview =
    !hasCat ||
    statusLower === "needs_review" ||
    statusLower === "uncategorized" ||
    statusLower === "" ||
    postBlocked;

  if (pending) {
    return { status: "pending", note: "Pending/settling", reason_code: "pending" };
  }

  const lastAttempt = cat?.last_post_attempt_at ? Date.parse(cat.last_post_attempt_at) : null;
  const staleAttempt = lastAttempt ? Date.now() - lastAttempt > 30 * 60 * 1000 : false;
  if (
    statusLower === "failed" ||
    (cat?.post_error && !hasQbo && (retryCount >= 5 || staleAttempt))
  ) {
    return { status: "failed_post", note: "Posting failed; retrying", reason_code: "failed_post" };
  }

  if (statusLower === "posted" && hasQbo && (hasReconciled || hasPostedAt)) {
    return { status: "matched", note: "Posted to QuickBooks", reason_code: "matched" };
  }

  const approvedLike = statusLower === "approved" || statusLower === "auto_approved" || statusLower === "failed";
  const inFuture = (postAfterTs && postAfterTs > nowTs) || (nextAttemptTs && nextAttemptTs > nowTs) || cat?.meta?.posting_in_progress;
  if (approvedLike && !hasQbo && inFuture) {
    return { status: "approved_waiting_post", note: "Approved; queued for posting", reason_code: "approved_waiting_post" };
  }

  if (approvedLike && !hasQbo && postAfterTs && postAfterTs <= nowTs && !needsReview) {
    return { status: "missing_in_qbo", note: "Posting gap detected; retrying", reason_code: "missing_in_qbo" };
  }

  if (needsReview) {
    return { status: "needs_review", note: "Needs review before posting", reason_code: "needs_review" };
  }

  if (includePending && approvedLike && !hasQbo) {
    return { status: "pending", note: "Pending/settling", reason_code: "pending" };
  }

  if (retryCount >= 5 && cat?.post_error && !hasQbo) {
    return { status: "failed_post", note: "Posting failed; retrying", reason_code: "failed_post" };
  }

  return { status: "unknown", note: "Status not determined.", reason_code: "unknown" };
}

function computeRunStatus(counts) {
  if (!counts.total_seen) return "unknown";
  if (counts.missing_in_qbo_count > 0 || counts.duplicate_in_qbo_count > 0 || counts.failed_post_count > 0) return "investigating";
  return "ok";
}

function computeOverallNote(status, counts) {
  if (status === "ok") return "All eligible transactions matched. Some items may still be pending review.";
  if (status === "investigating")
    return `Investigating ${counts.missing_in_qbo_count + counts.duplicate_in_qbo_count + counts.failed_post_count || 0} posting issues. Bizzi is retrying quietly.`;
  if (status === "failed") return "Monitoring paused. Bizzi will retry automatically.";
  if (status === "partial") return "Monitoring is partially available while Bizzi collects more data.";
  return "No recent transactions to monitor yet.";
}

async function insertItems(runId, items) {
  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    const slice = items.slice(i, i + CHUNK_SIZE);
    const { error } = await supabase.from("reconciliation_items").upsert(slice, {
      onConflict: "run_id,bank_transaction_id",
    });
    if (error) throw error;
  }
}

export async function computeReconciliationRun(businessId, opts = {}) {
  if (!businessId) throw new Error("businessId_required");
  const scope = opts.scope || DEFAULT_SCOPE;
  const range = { start: normalizeDate(opts.date_from), end: normalizeDate(opts.date_to) };
  const { start, end } = range.start && range.end ? range : computeRange(scope);
  const includePending = opts.include_pending === true;
  const plaidAccountId = opts.plaid_account_id || null;
  const nowTs = Date.now();

  // Insert run skeleton
  const { data: runRow, error: runErr } = await supabase
    .from("reconciliation_runs")
    .insert({
      business_id: businessId,
      scope,
      period_start: start,
      period_end: end,
      status: "unknown",
      overall_note: computeOverallNote("unknown", { total_seen: 0 }),
      last_checked_at: NOW(),
      details: { opts },
    })
    .select("id")
    .maybeSingle();
  if (runErr) throw runErr;
  const runId = runRow?.id;

  try {
    // Fetch bank txns
    let bankQuery = supabase
      .from("bank_transactions")
      .select(
        "id,business_id,plaid_account_id,plaid_transaction_id,pending,date,name,merchant_name,counterparty_name,amount,signed_amount,direction"
      )
      .eq("business_id", businessId)
      .gte("date", start)
      .lte("date", end);
    if (plaidAccountId) bankQuery = bankQuery.eq("plaid_account_id", plaidAccountId);
    const { data: bankRows, error: bankErr } = await bankQuery;
    if (bankErr) throw bankErr;

    const bankIds = (bankRows || []).map((b) => b.id);
    if (!bankIds.length) {
      const finalStatus = "unknown";
      const overall_note = computeOverallNote(finalStatus, { total_seen: 0 });
      await supabase.from("reconciliation_runs").update({ status: finalStatus, overall_note }).eq("id", runId);
      return { ok: true, run_id: runId, status: finalStatus, counts: { total_seen: 0 } };
    }

    // Fetch categorizations
    const { data: catRows, error: catErr } = await supabase
      .from("transaction_categorizations")
      .select(
        "business_id,transaction_id,status,post_after,post_error,qbo_txn_id,qbo_txn_type,posted_at,reconciled_at,final_qbo_account_name,suggested_qbo_account_name,meta,last_post_attempt_at"
      )
      .eq("business_id", businessId)
      .in("transaction_id", bankIds);
    if (catErr) throw catErr;
    const catMap = new Map((catRows || []).map((c) => [c.transaction_id, c]));

    // Build items
    const items = [];
    const counts = {
      total_seen: 0,
      matched_count: 0,
      needs_review_count: 0,
      approved_waiting_post_count: 0,
      pending_count: 0,
      failed_post_count: 0,
      missing_in_qbo_count: 0,
      duplicate_in_qbo_count: 0,
    };

    const qboIdCount = {};

    for (const bank of bankRows || []) {
      const cat = catMap.get(bank.id) || null;
      const dir = normalizeDirection(bank);
      const amount = Number.isFinite(Number(bank.signed_amount)) ? Number(bank.signed_amount) : Number(bank.amount);
      const statusMeta = categorizeItem({ bank, cat, nowTs, includePending });

      const item = {
        run_id: runId,
        business_id: businessId,
        bank_transaction_id: bank.id,
        plaid_account_id: bank.plaid_account_id,
        txn_date: bank.date || null,
        merchant: bank.merchant_name || bank.counterparty_name || null,
        description: bank.name || null,
        amount: Number.isFinite(amount) ? amount : null,
        direction: dir,
        category_name: cat?.final_qbo_account_name || cat?.suggested_qbo_account_name || null,
        status: statusMeta.status,
        note: statusMeta.note,
        details: {
          source: "posting_integrity",
          reason_code: statusMeta.reason_code,
          post_error: cat?.post_error || null,
          post_after: cat?.post_after || null,
          retry_count: cat?.meta?.post_retry_count || null,
          suggestion_source: cat?.meta?.suggestion_source || null,
          taxonomy_type: cat?.meta?.taxonomy_type || null,
        },
        posted_at: cat?.posted_at || null,
        reconciled_at: cat?.reconciled_at || null,
        qbo_txn_id: cat?.qbo_txn_id || null,
        qbo_txn_type: cat?.qbo_txn_type || null,
      };

      items.push(item);
      counts.total_seen += 1;
      if (cat?.qbo_txn_id) {
        qboIdCount[cat.qbo_txn_id] = (qboIdCount[cat.qbo_txn_id] || 0) + 1;
      }
    }

    // Duplicate detection on qbo_txn_id
  const dupIds = new Set(Object.keys(qboIdCount).filter((k) => qboIdCount[k] > 1));
  items.forEach((item) => {
    if (item.qbo_txn_id && dupIds.has(item.qbo_txn_id)) {
      item.status = "duplicate_in_qbo";
      item.note = "Duplicate post detected; investigating";
      item.details = {
        ...(item.details || {}),
        reason_code: "duplicate_in_qbo",
        duplicate_qbo_txn_id: item.qbo_txn_id,
      };
    }
  });

    // Recount with final statuses
    items.forEach((item) => {
      switch (item.status) {
        case "matched":
          counts.matched_count += 1;
          break;
        case "needs_review":
          counts.needs_review_count += 1;
          break;
        case "approved_waiting_post":
          counts.approved_waiting_post_count += 1;
          break;
        case "pending":
          counts.pending_count += 1;
          break;
        case "failed_post":
          counts.failed_post_count += 1;
          break;
        case "missing_in_qbo":
          counts.missing_in_qbo_count += 1;
          break;
        case "duplicate_in_qbo":
          counts.duplicate_in_qbo_count += 1;
          break;
        default:
          break;
      }
    });

    // Persist items
    if (items.length) {
      await insertItems(runId, items);
    }

    const finalStatus = computeRunStatus(counts);
    const overall_note = computeOverallNote(finalStatus, counts);

    await supabase
      .from("reconciliation_runs")
      .update({
        status: finalStatus,
        overall_note,
        last_checked_at: NOW(),
        total_seen: counts.total_seen,
        matched_count: counts.matched_count,
        needs_review_count: counts.needs_review_count,
        approved_waiting_post_count: counts.approved_waiting_post_count,
        pending_count: counts.pending_count,
        failed_post_count: counts.failed_post_count,
        missing_in_qbo_count: counts.missing_in_qbo_count,
        duplicate_in_qbo_count: counts.duplicate_in_qbo_count,
        details: { counts, opts },
      })
      .eq("id", runId);

    devLog("run_complete", { businessId, run_id: runId, status: finalStatus, counts });
    return { ok: true, run_id: runId, status: finalStatus, counts };
  } catch (err) {
    await supabase
      .from("reconciliation_runs")
      .update({
        status: "failed",
        overall_note: computeOverallNote("failed", {}),
        last_checked_at: NOW(),
        details: { error: err?.message || err },
      })
      .eq("id", runId);
    throw err;
  }
}

export default {
  computeReconciliationRun,
};
