import { createHash } from "node:crypto";
import { supabase as defaultSupabase } from "../supabaseAdmin.js";

const SNAPSHOTS_TABLE = "monthly_review_qbo_pnl_snapshots";
const ACCOUNTS_TABLE = "monthly_review_qbo_pnl_accounts";
const TRANSACTIONS_TABLE = "monthly_review_qbo_pnl_transactions";

const LINKAGE = {
  LINKED: "linked",
  QBO_ONLY: "qbo_only",
  AMBIGUOUS: "ambiguous",
  MISSING_IDENTITY: "missing_qbo_identity",
  UNLINKED: "unlinked",
};

export class QboMonthlyPnlSnapshotError extends Error {
  constructor(error, status = 400, details = {}) {
    super(error);
    this.name = "QboMonthlyPnlSnapshotError";
    this.error = error;
    this.status = status;
    this.details = details;
  }
}

export function normalizeQboTxnType(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const compact = raw.replace(/[\s_-]+/g, "").toLowerCase();
  const known = {
    bill: "Bill",
    billpayment: "BillPayment",
    check: "Check",
    creditcardcharge: "CreditCardCharge",
    creditcardcredit: "CreditCardCredit",
    creditmemo: "CreditMemo",
    deposit: "Deposit",
    expense: "Purchase",
    invoice: "Invoice",
    journalentry: "JournalEntry",
    payment: "Payment",
    purchase: "Purchase",
    refundreceipt: "RefundReceipt",
    salesreceipt: "SalesReceipt",
    transfer: "Transfer",
    vendorcredit: "VendorCredit",
  };
  return known[compact] || raw;
}

export function getMonthlySourceRange(reviewYear, reviewMonth) {
  const year = Number(reviewYear);
  const month = Number(reviewMonth);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new QboMonthlyPnlSnapshotError("invalid_review_year", 400, { review_year: reviewYear });
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new QboMonthlyPnlSnapshotError("invalid_review_month", 400, { review_month: reviewMonth });
  }
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const endDate = new Date(Date.UTC(year, month, 0));
  const end = endDate.toISOString().slice(0, 10);
  return { sourceStartDate: start, sourceEndDate: end };
}

export async function getLatestMonthlyPnlSnapshot({
  businessId,
  reviewYear,
  reviewMonth,
  db = defaultSupabase,
  includeAccounts = false,
  includeTransactions = false,
} = {}) {
  assertSnapshotIdentity({ businessId, reviewYear, reviewMonth });

  const snapshot = await selectSingleSnapshot(
    db
      .from(SNAPSHOTS_TABLE)
      .select("*")
      .eq("business_id", businessId)
      .eq("review_year", Number(reviewYear))
      .eq("review_month", Number(reviewMonth))
      .eq("is_current", true)
      .order("snapshot_version", { ascending: false })
      .limit(1)
  );

  if (!snapshot) return null;

  if (includeAccounts) {
    snapshot.accounts = await selectRows(
      db
        .from(ACCOUNTS_TABLE)
        .select("*")
        .eq("business_id", businessId)
        .eq("snapshot_id", snapshot.id)
        .order("display_order", { ascending: true })
        .order("row_order", { ascending: true })
    );
  }

  if (includeTransactions) {
    snapshot.transactions = await selectRows(
      db
        .from(TRANSACTIONS_TABLE)
        .select("*")
        .eq("business_id", businessId)
        .eq("snapshot_id", snapshot.id)
        .order("txn_date", { ascending: true })
        .order("created_at", { ascending: true })
    );
  }

  return snapshot;
}

export async function createOrReplaceMonthlyPnlSnapshot({
  businessId,
  reviewYear,
  reviewMonth,
  qboRealmId = null,
  qboEnvironment = null,
  accountingMethod = "Cash",
  sourceStartDate = null,
  sourceEndDate = null,
  pulledAt = new Date().toISOString(),
  revenue = 0,
  cogs = 0,
  expenses = 0,
  netProfit = 0,
  rawHash = null,
  status = "current",
  metadata = {},
  accounts = [],
  transactions = [],
  linkTransactions = true,
  promote = true,
  promoteSnapshot = promoteMonthlyPnlSnapshotCurrent,
  db = defaultSupabase,
} = {}) {
  assertSnapshotIdentity({ businessId, reviewYear, reviewMonth });
  const range = getMonthlySourceRange(reviewYear, reviewMonth);
  const normalizedAccounts = accounts.map((account, index) => normalizeAccountRow(account, index));
  const normalizedTransactions = transactions.map((transaction, index) => normalizeTransactionRow(transaction, index));
  validateSnapshotPayload({
    reviewYear,
    reviewMonth,
    sourceStartDate: sourceStartDate || range.sourceStartDate,
    sourceEndDate: sourceEndDate || range.sourceEndDate,
    accounts: normalizedAccounts,
    transactions: normalizedTransactions,
  });
  const computedRawHash = rawHash || hashSnapshotPayload({
    businessId,
    reviewYear: Number(reviewYear),
    reviewMonth: Number(reviewMonth),
    qboRealmId,
    qboEnvironment,
    accountingMethod,
    sourceStartDate: sourceStartDate || range.sourceStartDate,
    sourceEndDate: sourceEndDate || range.sourceEndDate,
    revenue,
    cogs,
    expenses,
    netProfit,
    accounts: normalizedAccounts,
    transactions: normalizedTransactions,
  });

  const nextVersion = await getNextSnapshotVersion({ db, businessId, reviewYear, reviewMonth });
  const snapshotPayload = {
    business_id: businessId,
    review_year: Number(reviewYear),
    review_month: Number(reviewMonth),
    snapshot_version: nextVersion,
    is_current: false,
    qbo_realm_id: nullableText(qboRealmId),
    qbo_environment: nullableText(qboEnvironment),
    accounting_method: nullableText(accountingMethod) || "Cash",
    source_start_date: sourceStartDate || range.sourceStartDate,
    source_end_date: sourceEndDate || range.sourceEndDate,
    pulled_at: pulledAt,
    revenue: numeric(revenue),
    cogs: numeric(cogs),
    expenses: numeric(expenses),
    net_profit: numeric(netProfit),
    raw_hash: computedRawHash,
    status: "building",
    metadata: plainObject(metadata),
  };

  const snapshot = await insertSingle(db.from(SNAPSHOTS_TABLE).insert(snapshotPayload).select("*"));
  let persistedAccounts = [];
  let persistedTransactions = [];
  let linkage = null;
  try {
    persistedAccounts = await persistNormalizedPnlAccounts({
      db,
      snapshot,
      accounts: normalizedAccounts,
    });
    persistedTransactions = await persistNormalizedPnlTransactions({
      db,
      snapshot,
      transactions: normalizedTransactions,
    });
    linkage = linkTransactions
      ? await linkSnapshotTransactionsToBizzi({ db, businessId, snapshotId: snapshot.id })
      : { linked: 0, qboOnly: 0, ambiguous: 0, missingIdentity: 0, skipped: persistedTransactions.length };
  } catch (err) {
    await markSnapshotFailed({ db, businessId, snapshotId: snapshot.id, err });
    throw err;
  }
  const promotedSnapshot = promote
    ? await promoteSnapshot({ db, businessId, reviewYear, reviewMonth, snapshotId: snapshot.id, status })
    : await markSnapshotReady({ db, businessId, snapshotId: snapshot.id, status: "validated" });

  return {
    ok: true,
    snapshot: promotedSnapshot,
    accounts: persistedAccounts,
    transactions: persistedTransactions,
    linkage,
  };
}

export async function promoteMonthlyPnlSnapshotCurrent({
  businessId,
  reviewYear,
  reviewMonth,
  snapshotId,
  status = "current",
  db = defaultSupabase,
} = {}) {
  assertSnapshotIdentity({ businessId, reviewYear, reviewMonth });
  if (!snapshotId) throw new QboMonthlyPnlSnapshotError("missing_snapshot_id", 400);

  if (typeof db.rpc === "function") {
    const { data, error } = await db.rpc("promote_monthly_review_qbo_pnl_snapshot", {
      p_business_id: businessId,
      p_review_year: Number(reviewYear),
      p_review_month: Number(reviewMonth),
      p_snapshot_id: snapshotId,
      p_status: status || "current",
    });
    if (error) throw new QboMonthlyPnlSnapshotError("snapshot_promotion_failed", 500, { cause: error.message });
    const promoted = Array.isArray(data) ? data[0] : data;
    if (!promoted?.id) throw new QboMonthlyPnlSnapshotError("snapshot_promotion_failed", 500);
    return promoted;
  }

  return promoteMonthlyPnlSnapshotCurrentForTest({ db, businessId, reviewYear, reviewMonth, snapshotId, status });
}

export async function persistNormalizedPnlAccounts({ db = defaultSupabase, snapshot, accounts = [] } = {}) {
  if (!snapshot?.id || !snapshot?.business_id) {
    throw new QboMonthlyPnlSnapshotError("missing_snapshot_context", 400);
  }
  if (!Array.isArray(accounts) || accounts.length === 0) return [];

  const rows = accounts.map((account, index) => ({
    snapshot_id: snapshot.id,
    business_id: snapshot.business_id,
    qbo_account_id: nullableText(account.qbo_account_id),
    account_name: nullableText(account.account_name) || "Unresolved account",
    account_path: nullableText(account.account_path),
    account_type: nullableText(account.account_type),
    account_subtype: nullableText(account.account_subtype),
    total_amount: numeric(account.total_amount),
    display_order: integer(account.display_order, index),
    row_order: integer(account.row_order, index),
    metadata: plainObject(account.metadata),
    raw_ref: plainObject(account.raw_ref),
  }));

  return insertRows(db.from(ACCOUNTS_TABLE).insert(rows).select("*"));
}

export async function persistNormalizedPnlTransactions({ db = defaultSupabase, snapshot, transactions = [] } = {}) {
  if (!snapshot?.id || !snapshot?.business_id) {
    throw new QboMonthlyPnlSnapshotError("missing_snapshot_context", 400);
  }
  if (!Array.isArray(transactions) || transactions.length === 0) return [];

  const rows = transactions.map((transaction) => ({
    snapshot_id: snapshot.id,
    business_id: snapshot.business_id,
    qbo_account_id: nullableText(transaction.qbo_account_id),
    qbo_account_name: nullableText(transaction.qbo_account_name),
    qbo_txn_id: nullableText(transaction.qbo_txn_id),
    qbo_txn_type: normalizeQboTxnType(transaction.qbo_txn_type),
    txn_date: transaction.txn_date,
    entity_name: nullableText(transaction.entity_name),
    payee_name: nullableText(transaction.payee_name),
    customer_name: nullableText(transaction.customer_name),
    vendor_name: nullableText(transaction.vendor_name),
    memo: nullableText(transaction.memo),
    description: nullableText(transaction.description),
    amount: numeric(transaction.amount),
    bizzi_transaction_id: null,
    linkage_status: transaction.qbo_txn_id && transaction.qbo_txn_type ? LINKAGE.UNLINKED : LINKAGE.MISSING_IDENTITY,
    linkage_confidence: "none",
    metadata: plainObject(transaction.metadata),
    raw_ref: plainObject(transaction.raw_ref),
  }));

  return insertRows(db.from(TRANSACTIONS_TABLE).insert(rows).select("*"));
}

export async function invalidateMonthlyPnlSnapshot({
  businessId,
  reviewYear,
  reviewMonth,
  snapshotId = null,
  reason = null,
  db = defaultSupabase,
} = {}) {
  assertSnapshotIdentity({ businessId, reviewYear, reviewMonth });

  let query = db
    .from(SNAPSHOTS_TABLE)
    .update({
      is_current: false,
      status: "invalidated",
      updated_at: new Date().toISOString(),
    })
    .eq("business_id", businessId)
    .eq("review_year", Number(reviewYear))
    .eq("review_month", Number(reviewMonth));

  if (snapshotId) query = query.eq("id", snapshotId);
  else query = query.eq("is_current", true);

  const { data, error } = await query.select("*");
  if (error) throw new QboMonthlyPnlSnapshotError("snapshot_invalidation_failed", 500, { cause: error.message });
  return { ok: true, invalidated: Array.isArray(data) ? data : [], reason: reason || null };
}

export async function linkSnapshotTransactionsToBizzi({
  businessId,
  snapshotId,
  db = defaultSupabase,
} = {}) {
  if (!businessId) throw new QboMonthlyPnlSnapshotError("missing_business_id", 400);
  if (!snapshotId) throw new QboMonthlyPnlSnapshotError("missing_snapshot_id", 400);

  const rows = await selectRows(
    db
      .from(TRANSACTIONS_TABLE)
      .select("id,business_id,qbo_txn_id,qbo_txn_type,bizzi_transaction_id")
      .eq("business_id", businessId)
      .eq("snapshot_id", snapshotId)
  );

  const qboIds = unique(rows.map((row) => nullableText(row.qbo_txn_id)).filter(Boolean));
  const missingIdentity = rows.filter((row) => !row.qbo_txn_id || !row.qbo_txn_type);
  let stats = { linked: 0, qboOnly: 0, ambiguous: 0, missingIdentity: missingIdentity.length, skipped: 0 };

  if (missingIdentity.length > 0) {
    await updateSnapshotTransactionRows({
      db,
      rows: missingIdentity,
      patch: { bizzi_transaction_id: null, linkage_status: LINKAGE.MISSING_IDENTITY, linkage_confidence: "none" },
    });
  }
  if (qboIds.length === 0) return stats;

  const categorizations = await selectRows(
    db
      .from("transaction_categorizations")
      .select("business_id,transaction_id,qbo_txn_id,qbo_txn_type,status")
      .eq("business_id", businessId)
      .in("qbo_txn_id", qboIds)
  );

  const txnIds = unique(categorizations.map((row) => nullableText(row.transaction_id)).filter(Boolean));
  const bankRows = txnIds.length > 0
    ? await selectRows(
        db
          .from("bank_transactions")
          .select("id,business_id,is_archived")
          .eq("business_id", businessId)
          .in("id", txnIds)
      )
    : [];
  const activeTxnIds = new Set(
    bankRows
      .filter((row) => row?.business_id === businessId && row?.is_archived !== true)
      .map((row) => String(row.id))
  );

  const matchesByIdentity = new Map();
  for (const cat of categorizations) {
    if (cat?.business_id !== businessId) continue;
    if (!cat?.transaction_id || !activeTxnIds.has(String(cat.transaction_id))) continue;
    const key = identityKey(cat.qbo_txn_id, cat.qbo_txn_type);
    if (!key) continue;
    const bucket = matchesByIdentity.get(key) || [];
    bucket.push(cat);
    matchesByIdentity.set(key, bucket);
  }

  for (const row of rows) {
    const key = identityKey(row.qbo_txn_id, row.qbo_txn_type);
    if (!key) continue;
    const matches = uniqueBy(matchesByIdentity.get(key) || [], (match) => match.transaction_id);
    if (matches.length === 1) {
      await updateSnapshotTransactionRows({
        db,
        rows: [row],
        patch: {
          bizzi_transaction_id: matches[0].transaction_id,
          linkage_status: LINKAGE.LINKED,
          linkage_confidence: "exact_qbo_id_type",
        },
      });
      stats.linked += 1;
    } else if (matches.length > 1) {
      await updateSnapshotTransactionRows({
        db,
        rows: [row],
        patch: { bizzi_transaction_id: null, linkage_status: LINKAGE.AMBIGUOUS, linkage_confidence: "ambiguous" },
      });
      stats.ambiguous += 1;
    } else {
      await updateSnapshotTransactionRows({
        db,
        rows: [row],
        patch: { bizzi_transaction_id: null, linkage_status: LINKAGE.QBO_ONLY, linkage_confidence: "none" },
      });
      stats.qboOnly += 1;
    }
  }

  return stats;
}

async function getNextSnapshotVersion({ db, businessId, reviewYear, reviewMonth }) {
  const latest = await selectSingleSnapshot(
    db
      .from(SNAPSHOTS_TABLE)
      .select("snapshot_version")
      .eq("business_id", businessId)
      .eq("review_year", Number(reviewYear))
      .eq("review_month", Number(reviewMonth))
      .order("snapshot_version", { ascending: false })
      .limit(1)
  );
  return Math.max(0, Number(latest?.snapshot_version || 0)) + 1;
}

async function supersedeCurrentSnapshots({ db, businessId, reviewYear, reviewMonth }) {
  const { error } = await db
    .from(SNAPSHOTS_TABLE)
    .update({ is_current: false, status: "superseded", updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("review_year", Number(reviewYear))
    .eq("review_month", Number(reviewMonth))
    .eq("is_current", true);
  if (error) throw new QboMonthlyPnlSnapshotError("snapshot_supersede_failed", 500, { cause: error.message });
}

async function promoteSnapshotCurrent({ db, businessId, snapshotId, status }) {
  const snapshot = await insertSingle(
    db
      .from(SNAPSHOTS_TABLE)
      .update({ is_current: true, status: status || "current", updated_at: new Date().toISOString() })
      .eq("business_id", businessId)
      .eq("id", snapshotId)
      .select("*")
  );
  if (!snapshot) throw new QboMonthlyPnlSnapshotError("snapshot_promotion_failed", 500);
  return snapshot;
}

async function markSnapshotReady({ db, businessId, snapshotId, status }) {
  const snapshot = await insertSingle(
    db
      .from(SNAPSHOTS_TABLE)
      .update({ is_current: false, status: status || "validated", updated_at: new Date().toISOString() })
      .eq("business_id", businessId)
      .eq("id", snapshotId)
      .select("*")
  );
  if (!snapshot) throw new QboMonthlyPnlSnapshotError("snapshot_stage_ready_failed", 500);
  return snapshot;
}

async function promoteMonthlyPnlSnapshotCurrentForTest({ db, businessId, reviewYear, reviewMonth, snapshotId, status }) {
  const candidate = await selectSingleSnapshot(
    db
      .from(SNAPSHOTS_TABLE)
      .select("*")
      .eq("business_id", businessId)
      .eq("review_year", Number(reviewYear))
      .eq("review_month", Number(reviewMonth))
      .eq("id", snapshotId)
      .limit(1)
  );
  if (!candidate) throw new QboMonthlyPnlSnapshotError("snapshot_candidate_not_found", 404);
  if (candidate.is_current === true || !["building", "validated"].includes(candidate.status)) {
    throw new QboMonthlyPnlSnapshotError("snapshot_candidate_not_promotable", 409, { status: candidate.status });
  }
  await supersedeCurrentSnapshots({ db, businessId, reviewYear, reviewMonth });
  return promoteSnapshotCurrent({ db, businessId, snapshotId, status });
}

async function markSnapshotFailed({ db, businessId, snapshotId, err }) {
  await db
    .from(SNAPSHOTS_TABLE)
    .update({
      is_current: false,
      status: "failed",
      metadata: { error: err?.error || err?.message || String(err) },
      updated_at: new Date().toISOString(),
    })
    .eq("business_id", businessId)
    .eq("id", snapshotId);
}

async function updateSnapshotTransactionRows({ db, rows, patch }) {
  for (const row of rows) {
    const { error } = await db
      .from(TRANSACTIONS_TABLE)
      .update(patch)
      .eq("business_id", row.business_id)
      .eq("id", row.id);
    if (error) throw new QboMonthlyPnlSnapshotError("snapshot_transaction_link_update_failed", 500, { cause: error.message });
  }
}

async function selectRows(query) {
  const { data, error } = await query;
  if (error) throw new QboMonthlyPnlSnapshotError("snapshot_query_failed", 500, { cause: error.message });
  return Array.isArray(data) ? data : [];
}

async function selectSingleSnapshot(query) {
  const { data, error } = await query;
  if (error) throw new QboMonthlyPnlSnapshotError("snapshot_query_failed", 500, { cause: error.message });
  if (Array.isArray(data)) return data[0] || null;
  return data || null;
}

async function insertSingle(query) {
  const { data, error } = await query;
  if (error) throw new QboMonthlyPnlSnapshotError("snapshot_insert_failed", 500, { cause: error.message });
  if (Array.isArray(data)) return data[0] || null;
  return data || null;
}

async function insertRows(query) {
  const { data, error } = await query;
  if (error) throw new QboMonthlyPnlSnapshotError("snapshot_insert_failed", 500, { cause: error.message });
  return Array.isArray(data) ? data : [];
}

function assertSnapshotIdentity({ businessId, reviewYear, reviewMonth }) {
  if (!businessId) throw new QboMonthlyPnlSnapshotError("missing_business_id", 400);
  getMonthlySourceRange(reviewYear, reviewMonth);
}

function normalizeAccountRow(account, index) {
  return {
    qbo_account_id: nullableText(account?.qbo_account_id || account?.qboAccountId || account?.accountId),
    account_name: nullableText(account?.account_name || account?.name || account?.accountName) || "Unresolved account",
    account_path: nullableText(account?.account_path || account?.fullyQualifiedName || account?.fully_qualified_name || account?.path),
    account_type: nullableText(account?.account_type || account?.accountType || account?.type),
    account_subtype: nullableText(account?.account_subtype || account?.accountSubType || account?.subtype),
    total_amount: numeric(account?.total_amount ?? account?.amount ?? account?.total),
    display_order: integer(account?.display_order ?? account?.displayOrder, index),
    row_order: integer(account?.row_order ?? account?.rowOrder, index),
    metadata: plainObject(account?.metadata),
    raw_ref: plainObject(account?.raw_ref || account?.rawRef),
  };
}

function normalizeTransactionRow(transaction, index) {
  const txnDate = nullableText(transaction?.txn_date || transaction?.txnDate || transaction?.date);
  if (!txnDate) {
    throw new QboMonthlyPnlSnapshotError("missing_qbo_transaction_date", 400, { row_index: index });
  }
  return {
    qbo_account_id: nullableText(transaction?.qbo_account_id || transaction?.qboAccountId || transaction?.accountId),
    qbo_account_name: nullableText(transaction?.qbo_account_name || transaction?.qboAccountName || transaction?.accountName),
    qbo_txn_id: nullableText(transaction?.qbo_txn_id || transaction?.qboTxnId || transaction?.txnId || transaction?.id),
    qbo_txn_type: normalizeQboTxnType(transaction?.qbo_txn_type || transaction?.qboTxnType || transaction?.txnType || transaction?.type),
    txn_date: txnDate,
    entity_name: nullableText(transaction?.entity_name || transaction?.entityName || transaction?.entity),
    payee_name: nullableText(transaction?.payee_name || transaction?.payeeName || transaction?.payee),
    customer_name: nullableText(transaction?.customer_name || transaction?.customerName || transaction?.customer),
    vendor_name: nullableText(transaction?.vendor_name || transaction?.vendorName || transaction?.vendor),
    memo: nullableText(transaction?.memo),
    description: nullableText(transaction?.description || transaction?.desc),
    amount: numeric(transaction?.amount),
    metadata: plainObject(transaction?.metadata),
    raw_ref: plainObject(transaction?.raw_ref || transaction?.rawRef),
  };
}

function validateSnapshotPayload({ reviewYear, reviewMonth, sourceStartDate, sourceEndDate, accounts, transactions }) {
  const range = getMonthlySourceRange(reviewYear, reviewMonth);
  if (sourceStartDate !== range.sourceStartDate || sourceEndDate !== range.sourceEndDate) {
    throw new QboMonthlyPnlSnapshotError("snapshot_source_range_mismatch", 409, {
      expected_start_date: range.sourceStartDate,
      expected_end_date: range.sourceEndDate,
      source_start_date: sourceStartDate,
      source_end_date: sourceEndDate,
    });
  }

  const seenAccounts = new Set();
  for (const account of accounts) {
    const key = [account.qbo_account_id || account.account_path || account.account_name, account.display_order].join("::");
    if (seenAccounts.has(key)) {
      throw new QboMonthlyPnlSnapshotError("duplicate_qbo_account_line_identity", 409, { account: account.account_name });
    }
    seenAccounts.add(key);
  }

  const seenTransactions = new Set();
  for (const transaction of transactions) {
    if (transaction.txn_date < range.sourceStartDate || transaction.txn_date > range.sourceEndDate) {
      throw new QboMonthlyPnlSnapshotError("qbo_transaction_outside_selected_month", 409, {
        qbo_txn_id: transaction.qbo_txn_id,
        txn_date: transaction.txn_date,
      });
    }
    if (!transaction.qbo_txn_id || !transaction.qbo_txn_type) continue;
    const key = [
      transaction.qbo_account_id || transaction.qbo_account_name || "",
      transaction.qbo_txn_id,
      transaction.qbo_txn_type,
      transaction.txn_date,
      transaction.amount,
      transaction.description || transaction.memo || "",
    ].join("::");
    if (seenTransactions.has(key)) {
      throw new QboMonthlyPnlSnapshotError("duplicate_qbo_transaction_line_identity", 409, {
        qbo_txn_id: transaction.qbo_txn_id,
        qbo_txn_type: transaction.qbo_txn_type,
      });
    }
    seenTransactions.add(key);
  }
}

function hashSnapshotPayload(payload) {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function identityKey(qboTxnId, qboTxnType) {
  const id = nullableText(qboTxnId);
  const type = normalizeQboTxnType(qboTxnType);
  if (!id || !type) return null;
  return `${id}::${type}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function nullableText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function numeric(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function integer(value, fallback = 0) {
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function unique(values) {
  return [...new Set(values.map((value) => String(value)))];
}

function uniqueBy(rows, keyFn) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = String(keyFn(row));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

export default {
  createOrReplaceMonthlyPnlSnapshot,
  getLatestMonthlyPnlSnapshot,
  getMonthlySourceRange,
  invalidateMonthlyPnlSnapshot,
  linkSnapshotTransactionsToBizzi,
  normalizeQboTxnType,
  promoteMonthlyPnlSnapshotCurrent,
  persistNormalizedPnlAccounts,
  persistNormalizedPnlTransactions,
};
