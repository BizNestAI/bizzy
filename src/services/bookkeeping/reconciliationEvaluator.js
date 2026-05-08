import { supabase } from "../supabaseAdmin.js";
import { getQboAccountForPlaidAccount } from "./accountMapping.js";
import { fetchQboAccountBalance } from "./qboAccounts.js";

const SENTINEL_ACCOUNT_ID = "__recon_sentinel__";

function daysAgoIso(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchAllRows(queryBuilderFactory, pageSize = 1000, hardCap = 20000) {
  const rows = [];
  let from = 0;

  while (true) {
    const to = from + pageSize - 1;
    const { data, error } = await queryBuilderFactory(from, to);
    if (error) throw error;

    const page = data || [];
    rows.push(...page);

    if (rows.length >= hardCap) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[recon] pagination hardCap reached", {
          pageSize,
          hardCap,
          fetched: rows.length,
        });
      }
      return rows.slice(0, hardCap);
    }

    if (page.length < pageSize) return rows;
    from += pageSize;
  }
}

function computeTolerance(bankBalance) {
  const base = Math.max(5, Math.abs(Number(bankBalance) || 0) * 0.005);
  return base;
}

function adjustToleranceForTiming(base, { pendingCount, approvedWaitingCount }) {
  const hasTiming = (pendingCount || 0) > 0 || (approvedWaitingCount || 0) > 0;
  if (!hasTiming) return { adjusted: base, timingNote: null };
  const adjusted = Math.max(base, 25);
  return { adjusted, timingNote: "Timing lag: pending/approved waiting to post" };
}

function buildExplanationSummary({
  status,
  comparisonMode,
  accountName,
  diffAmount,
  toleranceAdjusted,
  pendingCount,
  needsReviewCount,
  approvedWaitingCount,
  notes,
}) {
  const label = accountName || "This account";
  if (status === "ok") {
    return `${label} matches within tolerance${Number.isFinite(diffAmount) ? ` (${Math.abs(diffAmount).toFixed(2)} diff)` : ""}.`;
  }
  if (status === "investigating") {
    return `${label} is outside tolerance${Number.isFinite(diffAmount) ? ` by ${Math.abs(diffAmount).toFixed(2)}` : ""}${Number.isFinite(toleranceAdjusted) ? ` (tolerance ${toleranceAdjusted.toFixed(2)})` : ""}.`;
  }
  if (status === "partial") {
    if (comparisonMode === "bizzi_proxy") {
      return `${label} has only an informational proxy balance. Status is partial until a live QBO-backed balance is available.`;
    }
    return `${label} has partial reconciliation data and needs more signals before Bizzi can confirm correctness.`;
  }
  if (pendingCount || needsReviewCount || approvedWaitingCount) {
    return `${label} does not have enough finalized data yet: ${pendingCount || 0} pending, ${needsReviewCount || 0} needs review, ${approvedWaitingCount || 0} approved waiting.`;
  }
  if (Array.isArray(notes) && notes.length) {
    return `${label}: ${notes[0]}`;
  }
  return `${label} does not yet have enough data for a reliable reconciliation verdict.`;
}

async function fetchPendingCounts(businessId) {
  const pendingCounts = new Map();
  const { data, error } = await supabase
    .from("bank_transactions")
    .select("plaid_account_id,count:id")
    .eq("business_id", businessId)
    .eq("is_archived", false)
    .eq("pending", true)
    .group("plaid_account_id");
  if (error) {
    console.warn("[recon] pending fetch failed", error.message || error);
    return pendingCounts;
  }
  (data || []).forEach((row) => {
    if (row.plaid_account_id) pendingCounts.set(row.plaid_account_id, Number(row.count) || 0);
  });
  return pendingCounts;
}

async function fetchNeedsReviewCounts(businessId) {
  const needsCounts = new Map();
  const sixtyDaysAgo = daysAgoIso(60);
  let txRows = [];
  try {
    txRows = await fetchAllRows((from, to) =>
      supabase
        .from("bank_transactions")
        .select("id,plaid_account_id")
        .eq("business_id", businessId)
        .eq("is_archived", false)
        .gte("date", sixtyDaysAgo)
        .range(from, to)
    );
  } catch (txErr) {
    console.warn("[recon] needs-review tx fetch failed", txErr.message || txErr);
    return needsCounts;
  }
  const ids = (txRows || []).map((r) => r.id).filter(Boolean);
  const catMap = new Map();
  for (const slice of chunk(ids, 1000)) {
    const { data: catRows, error: catErr } = await supabase
      .from("transaction_categorizations")
      .select("transaction_id,status")
      .eq("business_id", businessId)
      .eq("is_archived", false)
      .in("transaction_id", slice);
    if (catErr) {
      console.warn("[recon] needs-review cat fetch failed", catErr.message || catErr);
      continue;
    }
    (catRows || []).forEach((c) => catMap.set(c.transaction_id, c.status || null));
  }
  (txRows || []).forEach((row) => {
    const status = catMap.get(row.id);
    const needsReview = !status || status === "needs_review" || status === "uncategorized";
    if (needsReview && row.plaid_account_id) {
      needsCounts.set(row.plaid_account_id, (needsCounts.get(row.plaid_account_id) || 0) + 1);
    }
  });
  return needsCounts;
}

async function fetchApprovedWaitingCounts(businessId) {
  const waitingCounts = new Map();
  let catRows = [];
  try {
    catRows = await fetchAllRows((from, to) =>
      supabase
        .from("transaction_categorizations")
        .select("transaction_id,status,post_after,qbo_txn_id")
        .eq("business_id", businessId)
        .eq("is_archived", false)
        .in("status", ["approved", "auto_approved", "failed"])
        .is("qbo_txn_id", null)
        .not("post_after", "is", null)
        .range(from, to)
    );
  } catch (catErr) {
    console.warn("[recon] waiting-to-post fetch failed", catErr.message || catErr);
    return waitingCounts;
  }
  const ids = (catRows || []).map((c) => c.transaction_id).filter(Boolean);
  const bankRows = [];
  if (ids.length) {
    for (const slice of chunk(ids, 1000)) {
      const { data, error: bankErr } = await supabase
        .from("bank_transactions")
        .select("id,plaid_account_id")
        .eq("business_id", businessId)
        .eq("is_archived", false)
        .in("id", slice);
      if (bankErr) {
        console.warn("[recon] waiting-to-post bank fetch failed", bankErr.message || bankErr);
        return waitingCounts;
      }
      bankRows.push(...(data || []));
    }
  }
  const acctMap = new Map((bankRows || []).map((r) => [r.id, r.plaid_account_id]));
  (catRows || []).forEach((row) => {
    const acctId = acctMap.get(row.transaction_id);
    if (!acctId) return;
    waitingCounts.set(acctId, (waitingCounts.get(acctId) || 0) + 1);
  });
  return waitingCounts;
}

async function fetchPostedStats(businessId) {
  const postedStats = new Map(); // acct -> { count, sum, lastPostedAt }
  const ninetyDaysAgo = daysAgoIso(90);
  let catRows = [];
  try {
    catRows = await fetchAllRows((from, to) =>
      supabase
        .from("transaction_categorizations")
        .select("transaction_id,posted_at,status")
        .eq("business_id", businessId)
        .eq("is_archived", false)
        .eq("status", "posted")
        .not("posted_at", "is", null)
        .gte("posted_at", `${ninetyDaysAgo}T00:00:00Z`)
        .range(from, to)
    );
  } catch (catErr) {
    console.warn("[recon] posted fetch failed", catErr.message || catErr);
    return postedStats;
  }
  const ids = (catRows || []).map((c) => c.transaction_id).filter(Boolean);
  if (!ids.length) return postedStats;

  const bankRows = [];
  for (const slice of chunk(ids, 1000)) {
    const { data, error: bankErr } = await supabase
      .from("bank_transactions")
      .select("id,plaid_account_id,amount")
      .eq("business_id", businessId)
      .eq("is_archived", false)
      .in("id", slice);
    if (bankErr) {
      console.warn("[recon] posted bank fetch failed", bankErr.message || bankErr);
      return postedStats;
    }
    bankRows.push(...(data || []));
  }
  const bankMap = new Map((bankRows || []).map((r) => [r.id, r]));

  (catRows || []).forEach((row) => {
    const bankRow = bankMap.get(row.transaction_id);
    if (!bankRow || !bankRow.plaid_account_id) return;
    const acctId = bankRow.plaid_account_id;
    const current = postedStats.get(acctId) || { count: 0, sum: 0, lastPostedAt: null };
    const amt = Number(bankRow.amount || 0);
    const postedAt = row.posted_at || null;
    current.count += 1;
    current.sum += Number.isFinite(amt) ? amt : 0;
    if (!current.lastPostedAt || (postedAt && postedAt > current.lastPostedAt)) {
      current.lastPostedAt = postedAt;
    }
    postedStats.set(acctId, current);
  });
  return postedStats;
}

async function fetchLastSyncAt(businessId) {
  const { data, error } = await supabase
    .from("bank_sync_runs")
    .select("finished_at,started_at")
    .eq("business_id", businessId)
    .order("finished_at", { ascending: false, nullsLast: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn("[recon] last sync fetch failed", error.message || error);
    return null;
  }
  return data?.finished_at || data?.started_at || null;
}

export async function evaluateReconciliationStatus(businessId, opts = {}) {
  if (!businessId) return { overallStatus: "unknown", perAccount: [] };
  const nowIso = new Date().toISOString();
  const preferQboBalance = opts.preferQboBalance !== false;

  const { data: plaidAccounts, error: acctErr } = await supabase
    .from("plaid_accounts")
    .select("plaid_account_id,name,official_name,mask,current_balance,available_balance,is_active")
    .eq("business_id", businessId)
    .eq("is_active", true);
  if (acctErr) {
    console.warn("[recon] fetch plaid accounts failed", acctErr.message || acctErr);
    return { overallStatus: "unknown", perAccount: [] };
  }

  const pendingCounts = await fetchPendingCounts(businessId);
  const needsReviewCounts = await fetchNeedsReviewCounts(businessId);
  const waitingCounts = await fetchApprovedWaitingCounts(businessId);
  const postedStats = await fetchPostedStats(businessId);
  const lastSyncAt = await fetchLastSyncAt(businessId);

  const perAccount = [];

  for (const acct of plaidAccounts || []) {
    const bankBalance =
      acct.current_balance != null
        ? Number(acct.current_balance)
        : acct.available_balance != null
        ? Number(acct.available_balance)
        : null;
    const pendingCount = pendingCounts.get(acct.plaid_account_id) || 0;
    const needsReviewCount = needsReviewCounts.get(acct.plaid_account_id) || 0;
    const approvedWaitingCount = waitingCounts.get(acct.plaid_account_id) || 0;
    const posted = postedStats.get(acct.plaid_account_id) || { count: 0, sum: null, lastPostedAt: null };

    let bookBalance = null;
    let bookBalanceSource = "unknown";
    let qboAccountId = null;
    let qboAccountName = null;
    let qboAccountType = null;
    const notes = [];

    const mapping = await getQboAccountForPlaidAccount(businessId, acct.plaid_account_id);
    if (mapping?.qbo_account_id) {
      qboAccountId = mapping.qbo_account_id || null;
      qboAccountName = mapping.qbo_account_name || null;
      qboAccountType = mapping.qbo_account_type || null;
      if (preferQboBalance) {
        const qboBalance = await fetchQboAccountBalance(businessId, mapping.qbo_account_id);
        if (Number.isFinite(qboBalance)) {
          bookBalance = Number(qboBalance);
          bookBalanceSource = "qbo_balance";
        }
      } else {
        notes.push("QBO mapping present; QBO balance not fetched (scheduled run)");
      }
    } else {
      notes.push("Missing QBO account mapping");
    }

    if (bookBalance == null) {
      if (Number.isFinite(posted.sum)) {
        bookBalance = Number(posted.sum);
        bookBalanceSource = "bizzi_proxy";
        notes.push("Book balance source: Bizzi proxy (sum of posted txns)");
        notes.push("Bizzi proxy is informational only and is not used for strict balance reconciliation");
      }
    }

    const toleranceBase = computeTolerance(bankBalance ?? 0);
    const { adjusted: toleranceAdjusted, timingNote } = adjustToleranceForTiming(toleranceBase, {
      pendingCount,
      approvedWaitingCount,
    });
    if (timingNote) notes.push(timingNote);

    let status = "unknown";
    let diffAmount = null;
    let comparisonMode = "missing";
    if (bankBalance == null || bookBalance == null) {
      status = "unknown";
      if (bankBalance == null) notes.push("Missing bank balance");
      if (bookBalance == null) notes.push("Missing book balance");
    } else if (bookBalanceSource === "bizzi_proxy") {
      status = "partial";
      diffAmount = null;
      comparisonMode = "bizzi_proxy";
    } else {
      diffAmount = Number(bankBalance) - Number(bookBalance);
      const absDiff = Math.abs(diffAmount);
      status = absDiff <= toleranceAdjusted ? "ok" : "investigating";
      comparisonMode = "qbo_balance";
      if (status === "investigating" && timingNote) {
        notes.push("Investigating (timing lag) — discrepancy exceeds tolerance but timing signals present");
      }
    }

    const accountName = acct.name || acct.official_name || null;
    const accountMask = acct.mask || null;
    const explanationSummary = buildExplanationSummary({
      status,
      comparisonMode,
      accountName,
      diffAmount,
      toleranceAdjusted,
      pendingCount,
      needsReviewCount,
      approvedWaitingCount,
      notes,
    });

    const details = {
      plaid_account_name: accountName,
      plaid_account_mask: accountMask,
      plaid_account_display: accountMask ? `${accountName || "Account"} •••${accountMask}` : accountName || "Account",
      linked_qbo_account_id: qboAccountId,
      linked_qbo_account_name: qboAccountName,
      linked_qbo_account_type: qboAccountType,
      bank_balance,
      book_balance: bookBalance,
      balance_source: bookBalanceSource === "qbo_balance" ? "qbo_balance" : bookBalanceSource === "bizzi_proxy" ? "bizzi_proxy" : "missing",
      comparison_mode: comparisonMode,
      raw_diff_amount: diffAmount,
      tolerance: toleranceBase,
      tolerance_base: toleranceBase,
      tolerance_adjusted: toleranceAdjusted,
      pending_txn_count: pendingCount,
      needs_review_count: needsReviewCount,
      approved_waiting_to_post_count: approvedWaitingCount,
      posted_txn_count: posted.count,
      last_posted_at: posted.lastPostedAt || null,
      last_sync_at: lastSyncAt || null,
      book_balance_source: bookBalanceSource,
      qbo_account_id: qboAccountId,
      qbo_account_name: qboAccountName,
      qbo_account_type: qboAccountType,
      explanation_summary: explanationSummary,
      explanation_notes: notes,
      notes,
    };

    const row = {
      plaid_account_id: acct.plaid_account_id,
      plaid_account_name: accountName,
      plaid_account_mask: accountMask,
      status,
      bank_balance: bankBalance,
      book_balance: bookBalance,
      diff_amount: diffAmount,
      last_checked_at: nowIso,
      explanation_summary: explanationSummary,
      details,
    };
    perAccount.push(row);

    if (process.env.NODE_ENV !== "production" && (status === "investigating" || status === "unknown" || status === "partial")) {
      console.info("[recon] account_evaluated", {
        businessId,
        plaid_account_id: acct.plaid_account_id,
        plaid_account_name: accountName,
        status,
        comparison_mode: comparisonMode,
        bank_balance: bankBalance,
        book_balance: bookBalance,
        diff_amount: diffAmount,
        tolerance_adjusted: toleranceAdjusted,
        pendingCount,
        needsReviewCount,
        approvedWaitingCount,
        notes,
      });
    }
  }

  if (perAccount.length) {
    const upsertRows = perAccount.map((r) => ({
      business_id: businessId,
      plaid_account_id: r.plaid_account_id,
      status: r.status,
      bank_balance: r.bank_balance,
      book_balance: r.book_balance,
      diff_amount: r.diff_amount,
      last_checked_at: r.last_checked_at,
      details: r.details,
    }));
    const { error: upsertErr } = await supabase
      .from("reconciliation_health")
      .upsert(upsertRows, { onConflict: "business_id,plaid_account_id" });
    if (upsertErr) {
      console.warn("[recon] upsert failed", upsertErr.message || upsertErr);
    }
  } else {
    const { error: sentinelErr } = await supabase
      .from("reconciliation_health")
      .upsert(
        [
          {
            business_id: businessId,
            plaid_account_id: SENTINEL_ACCOUNT_ID,
            status: "unknown",
            bank_balance: null,
            book_balance: null,
            diff_amount: null,
            last_checked_at: nowIso,
            details: {
              note: "No active plaid_accounts rows found; wrote sentinel for throttle.",
              notes: ["Missing plaid_accounts rows"],
              source: "sentinel",
            },
          },
        ],
        { onConflict: "business_id,plaid_account_id" }
      );
    if (sentinelErr) {
      console.warn("[recon] sentinel upsert failed", sentinelErr.message || sentinelErr);
    }
  }

  let overallStatus = "unknown";
  const anyInvestigating = perAccount.some((r) => r.status === "investigating");
  const allOk = perAccount.length > 0 && perAccount.every((r) => r.status === "ok");
  const anyPartial = perAccount.some((r) => r.status === "partial");
  const anyOk = perAccount.some((r) => r.status === "ok");
  const anyUnknown = perAccount.some((r) => r.status === "unknown");
  if (!perAccount.length) overallStatus = "unknown";
  else if (anyInvestigating) overallStatus = "investigating";
  else if (allOk) overallStatus = "ok";
  else if (anyPartial || anyOk || anyUnknown) overallStatus = "partial";
  else overallStatus = "unknown";

  if (process.env.NODE_ENV !== "production" && overallStatus === "partial") {
    console.info("[recon] overall status resolved to partial", {
      businessId,
      account_count: perAccount.length,
      anyOk,
      anyUnknown,
    });
  }

  return { overallStatus, perAccount };
}

export default {
  evaluateReconciliationStatus,
};
