/* global process */
import crypto from "crypto";
import { supabase as defaultSupabase } from "../supabaseAdmin.js";

const DEFAULT_FRESHNESS_MINUTES = Number(process.env.QBO_INCOMING_DEPOSIT_MATCH_FRESHNESS_MINUTES || 240);
const DEPOSIT_WINDOW_BEFORE_DAYS = Number(process.env.QBO_DEPOSIT_MATCH_WINDOW_BEFORE_DAYS || 7);
const DEPOSIT_WINDOW_AFTER_DAYS = Number(process.env.QBO_DEPOSIT_MATCH_WINDOW_AFTER_DAYS || 2);
const DIRECT_WINDOW_BEFORE_DAYS = Number(process.env.QBO_DIRECT_PAYMENT_MATCH_WINDOW_BEFORE_DAYS || 7);
const DIRECT_WINDOW_AFTER_DAYS = Number(process.env.QBO_DIRECT_PAYMENT_MATCH_WINDOW_AFTER_DAYS || 2);

const ACTIVE_CANDIDATE_STATUSES = new Set(["needs_confirmation", "ambiguous"]);
const FINAL_MATCH_STATUSES = new Set(["confirmed"]);
const VERIFIED_MAPPING_SOURCES = new Set(["manual", "user_confirmed", "admin", "admin_confirmed", "external", "externally_verified"]);
const INVALID_QBO_STATUSES = new Set(["deleted", "voided", "reversed"]);
const CUSTOMER_RECEIPT_EXCLUDED_TAXONOMIES = new Set([
  "transfer_internal",
  "owner_draw",
  "owner_contribution",
  "loan_proceeds",
  "refund",
  "cc_payment",
]);

export class IncomingDepositMatchError extends Error {
  constructor(code, status = 400, details = {}) {
    super(code);
    this.name = "IncomingDepositMatchError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function toMinorUnits(value, fallback = null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.round(numeric * 100);
}

function hashKey(parts = []) {
  return crypto.createHash("sha256").update(parts.map((part) => String(part ?? "")).join("|")).digest("hex");
}

function dateOnly(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value).slice(0, 10) || null;
  return parsed.toISOString().slice(0, 10);
}

function shiftDate(value, days) {
  const date = new Date(`${dateOnly(value)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dayDistance(a, b) {
  const left = new Date(`${dateOnly(a)}T00:00:00Z`).getTime();
  const right = new Date(`${dateOnly(b)}T00:00:00Z`).getTime();
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return Math.round((left - right) / 86400000);
}

function refValue(ref) {
  if (!ref) return null;
  if (typeof ref === "string" || typeof ref === "number") return String(ref);
  return ref.value || ref.Value || ref.id || ref.Id || null;
}

function normalizeCurrency(value) {
  const text = String(value || "").trim().toUpperCase();
  return text || null;
}

function isIncomingDeposit(bankTxn = {}) {
  const amount = Number(bankTxn.amount || 0);
  const dir = String(bankTxn.direction || "").toUpperCase();
  if (dir === "INFLOW") return amount > 0;
  if (dir === "OUTFLOW") return false;
  const signed = Number(bankTxn.signed_amount);
  return Number.isFinite(signed) ? signed > 0 : amount > 0;
}

function mappingEvidence(mapping = null) {
  if (!mapping?.qbo_account_id) {
    return { verified: false, bank_account_match: "unavailable", reason: "plaid_qbo_account_mapping_missing" };
  }
  const source = String(mapping.source || "").toLowerCase();
  if (VERIFIED_MAPPING_SOURCES.has(source)) {
    return { verified: true, bank_account_match: "verified_same_account", reason: "verified_same_bank_account" };
  }
  return { verified: false, bank_account_match: "unverified_mapping", reason: "plaid_qbo_account_mapping_unverified" };
}

async function selectMaybe(query) {
  const result = await query;
  if (result?.error) throw result.error;
  return result?.data ?? null;
}

async function selectRows(query) {
  const result = await query;
  if (result?.error) throw result.error;
  return Array.isArray(result?.data) ? result.data : [];
}

function isMissingSchemaError(err) {
  const code = String(err?.code || "");
  const message = String(err?.message || "");
  return code === "42P01" || code === "42703" || /relation .* does not exist|column .* does not exist/i.test(message);
}

async function matchSchemaAvailable({ db }) {
  try {
    const matches = await db
      .from("bank_qbo_matches")
      .select("id,status,match_type,confidence_tier,bank_account_match,request_idempotency_key")
      .limit(1);
    if (matches?.error) throw matches.error;
    const items = await db
      .from("bank_qbo_match_items")
      .select("id,match_id,qbo_entity_type,qbo_entity_id,evidence_role,active_confirmed")
      .limit(1);
    if (items?.error) throw items.error;
    return { ok: true };
  } catch (err) {
    if (isMissingSchemaError(err)) return { ok: false, reason: "incoming_deposit_match_schema_unavailable" };
    throw err;
  }
}

async function fetchBankTransaction({ db, businessId, bankTransactionId }) {
  return selectMaybe(db
    .from("bank_transactions")
    .select("id,business_id,plaid_transaction_id,plaid_account_id,date,amount,signed_amount,direction,iso_currency_code,unofficial_currency_code,pending,is_archived,accounting_review_required,accounting_review_reason,name,merchant_name,counterparty_name,updated_at")
    .eq("business_id", businessId)
    .eq("id", bankTransactionId)
    .maybeSingle());
}

async function fetchMapping({ db, businessId, plaidAccountId }) {
  if (!plaidAccountId) return null;
  return selectMaybe(db
    .from("plaid_qbo_account_mappings")
    .select("id,plaid_account_id,qbo_account_id,qbo_account_name,qbo_account_type,source,confidence")
    .eq("business_id", businessId)
    .eq("plaid_account_id", plaidAccountId)
    .maybeSingle());
}

async function fetchFreshness({ db, businessId, nowMs = Date.now(), freshnessMinutes = DEFAULT_FRESHNESS_MINUTES }) {
  try {
    const latest = await selectRows(db
      .from("qbo_entity_sync_runs")
      .select("id,status,started_at,finished_at,created_at,error_message")
      .eq("business_id", businessId)
      .order("started_at", { ascending: false })
      .limit(1));
    if (!latest.length) return { ok: false, reason: "qbo_match_cache_never_synced", source_freshness_at: null };
    const run = latest[0];
    if (run.status !== "succeeded") {
      return { ok: false, reason: "qbo_match_cache_latest_sync_not_successful", source_freshness_at: run.finished_at || run.started_at || run.created_at || null };
    }
    const at = run.finished_at || run.started_at || run.created_at || null;
    const time = at ? new Date(at).getTime() : NaN;
    if (!Number.isFinite(time)) return { ok: false, reason: "qbo_match_cache_freshness_unknown", source_freshness_at: at };
    if (nowMs - time > freshnessMinutes * 60000) {
      return { ok: false, reason: "qbo_match_cache_stale", source_freshness_at: at };
    }
    return { ok: true, reason: "qbo_match_cache_fresh", source_freshness_at: at };
  } catch (err) {
    if (isMissingSchemaError(err)) return { ok: false, reason: "qbo_match_cache_unavailable", source_freshness_at: null };
    throw err;
  }
}

function candidateBase({ bankTxn, mapping, mappingInfo, row, entityType, entityId, txnDate, amountMinor, currency, syncToken, sourceSnapshotAt }) {
  const bankCurrency = normalizeCurrency(bankTxn.iso_currency_code || bankTxn.unofficial_currency_code);
  const qboCurrency = normalizeCurrency(currency);
  const exactAmount = amountMinor === toMinorUnits(Math.abs(Number(bankTxn.amount || 0)), null);
  const sameCurrency = !bankCurrency || !qboCurrency || bankCurrency === qboCurrency;
  const reasons = [
    exactAmount ? "exact_amount_cents" : "amount_mismatch",
    "compatible_positive_deposit_direction",
    mappingInfo.reason,
  ];
  if (sameCurrency) reasons.push("currency_compatible"); else reasons.push("currency_mismatch");
  return {
    qbo_entity_type: entityType,
    qbo_entity_id: String(entityId || ""),
    qbo_realm_id: row.realm_id || row.source_snapshot?.realm_id || null,
    txn_date: txnDate,
    amount_minor: amountMinor,
    currency: qboCurrency || bankCurrency,
    sync_token: syncToken || null,
    source_snapshot_at: sourceSnapshotAt || null,
    customer_ref: row.customer_ref || row.source_snapshot?.payment?.CustomerRef || null,
    invoice_ids: row.linked_invoice_ids || [],
    bank_account_match: mappingInfo.bank_account_match,
    exact_amount: exactAmount,
    same_currency: sameCurrency,
    verified_same_account: mappingInfo.verified,
    date_distance_days: dayDistance(bankTxn.date, txnDate),
    reason_codes: reasons,
    raw: row,
    mapping,
  };
}

function candidateEligible(candidate) {
  return candidate.qbo_entity_id && candidate.exact_amount && candidate.same_currency && !INVALID_QBO_STATUSES.has(String(candidate.raw?.status || "").toLowerCase());
}

async function fetchRejectedTargetKeys({ db, businessId, bankTransactionId }) {
  try {
    const matches = await selectRows(db
      .from("bank_qbo_matches")
      .select("id")
      .eq("business_id", businessId)
      .eq("bank_transaction_id", bankTransactionId)
      .eq("status", "rejected"));
    const ids = matches.map((row) => row.id).filter(Boolean);
    if (!ids.length) return new Set();
    const items = await selectRows(db
      .from("bank_qbo_match_items")
      .select("qbo_entity_type,qbo_entity_id")
      .eq("business_id", businessId)
      .in("match_id", ids)
      .eq("evidence_role", "primary"));
    return new Set(items.map((item) => `${item.qbo_entity_type}:${item.qbo_entity_id}`));
  } catch (err) {
    if (isMissingSchemaError(err)) return new Set();
    throw err;
  }
}

async function fetchAlreadyConfirmedTargetKeys({ db, businessId, bankTransactionId }) {
  try {
    const matches = await selectRows(db
      .from("bank_qbo_matches")
      .select("id,bank_transaction_id,status")
      .eq("business_id", businessId)
      .eq("status", "confirmed"));
    const ids = matches.filter((row) => String(row.bank_transaction_id) !== String(bankTransactionId)).map((row) => row.id).filter(Boolean);
    if (!ids.length) return new Set();
    const items = await selectRows(db
      .from("bank_qbo_match_items")
      .select("qbo_entity_type,qbo_entity_id")
      .eq("business_id", businessId)
      .in("match_id", ids)
      .eq("active_confirmed", true));
    return new Set(items.map((item) => `${item.qbo_entity_type}:${item.qbo_entity_id}`));
  } catch (err) {
    if (isMissingSchemaError(err)) return new Set();
    throw err;
  }
}

async function discoverCandidates({ db, businessId, bankTxn, mapping, mappingInfo, bankAmountMinor }) {
  const rejected = await fetchRejectedTargetKeys({ db, businessId, bankTransactionId: bankTxn.id });
  const consumed = await fetchAlreadyConfirmedTargetKeys({ db, businessId, bankTransactionId: bankTxn.id });
  const within = (field, value, before, after, query) => query.gte(field, shiftDate(value, -before)).lte(field, shiftDate(value, after));
  const candidates = [];
  let evidenceSchemaIncomplete = false;

  try {
    const deposits = await selectRows(within("qbo_txn_date", bankTxn.date, DEPOSIT_WINDOW_BEFORE_DAYS, DEPOSIT_WINDOW_AFTER_DAYS, db
      .from("job_revenue_evidence")
      .select("id,realm_id,qbo_txn_id,qbo_txn_type,qbo_txn_date,amount,amount_minor,currency,deposit_account_ref,status,linked_payment_ids,sync_token,source_snapshot_at,source_snapshot,private_note,line_descriptions,line_entity_refs")
      .eq("business_id", businessId)
      .eq("qbo_txn_type", "Deposit")
      .eq("amount_minor", bankAmountMinor)));
    const depositPaymentIds = Array.from(new Set(deposits.flatMap((row) => row.linked_payment_ids || row.source_snapshot?.linked_payment_ids || []).map(String).filter(Boolean)));
    const paymentContext = depositPaymentIds.length
      ? await selectRows(db
          .from("job_payment_records")
          .select("realm_id,external_payment_id,customer_ref,linked_invoice_ids")
          .eq("business_id", businessId)
          .in("external_payment_id", depositPaymentIds))
      : [];
    const paymentContextById = new Map(paymentContext.map((row) => [String(row.external_payment_id), row]));
    deposits.forEach((row) => {
      const accountMatches = String(refValue(row.deposit_account_ref) || "") === String(mapping?.qbo_account_id || "");
      const candidate = candidateBase({ bankTxn, mapping, mappingInfo, row, entityType: "Deposit", entityId: row.qbo_txn_id, txnDate: row.qbo_txn_date, amountMinor: row.amount_minor, currency: row.currency, syncToken: row.sync_token, sourceSnapshotAt: row.source_snapshot_at });
      candidate.match_type = "qbo_deposit";
      const linkedPayments = (row.linked_payment_ids || row.source_snapshot?.linked_payment_ids || []).map(String).filter(Boolean);
      const linkedContexts = linkedPayments.map((paymentId) => paymentContextById.get(String(paymentId))).filter(Boolean);
      candidate.invoice_ids = Array.from(new Set(linkedContexts.flatMap((context) => context.linked_invoice_ids || []).map(String).filter(Boolean)));
      candidate.customer_ref = linkedContexts.find((context) => context.customer_ref)?.customer_ref || candidate.customer_ref || null;
      candidate.reason_codes.push(accountMatches ? "qbo_deposit_affects_mapped_bank_account" : "qbo_deposit_bank_account_mismatch_or_missing");
      candidate.reason_codes.push(candidate.invoice_ids.length ? "deposit_payment_chain_reaches_invoice" : "deposit_payment_invoice_context_missing");
      candidate.bank_account_match = mappingInfo.verified && accountMatches ? "verified_same_account" : candidate.bank_account_match;
      candidate.verified_same_account = mappingInfo.verified && accountMatches;
      candidates.push(candidate);
    });
  } catch (err) {
    if (isMissingSchemaError(err)) evidenceSchemaIncomplete = true; else throw err;
  }

  try {
    const payments = await selectRows(within("payment_date", bankTxn.date, DIRECT_WINDOW_BEFORE_DAYS, DIRECT_WINDOW_AFTER_DAYS, db
      .from("job_payment_records")
      .select("id,realm_id,external_payment_id,payment_date,total_amount,amount_minor,unapplied_amount_minor,deposit_ref,currency,customer_ref,payment_ref_num,payment_method_ref,linked_invoice_ids,sync_token,source_snapshot_at,status,private_note,source_snapshot")
      .eq("business_id", businessId)
      .eq("amount_minor", bankAmountMinor)));
    payments.forEach((row) => {
      const directAccount = String(refValue(row.deposit_ref) || "") === String(mapping?.qbo_account_id || "");
      const candidate = candidateBase({ bankTxn, mapping, mappingInfo, row, entityType: "Payment", entityId: row.external_payment_id, txnDate: row.payment_date, amountMinor: row.amount_minor, currency: row.currency, syncToken: row.sync_token, sourceSnapshotAt: row.source_snapshot_at });
      candidate.match_type = directAccount ? "qbo_payment_direct" : "qbo_payment_with_invoice_context";
      candidate.reason_codes.push(directAccount ? "qbo_payment_deposited_directly_to_mapped_bank_account" : "qbo_payment_not_proven_to_mapped_bank_account");
      candidate.reason_codes.push(candidate.invoice_ids?.length ? "payment_linked_to_invoice" : "payment_invoice_link_missing");
      candidate.verified_same_account = mappingInfo.verified && directAccount;
      candidate.bank_account_match = candidate.verified_same_account ? "verified_same_account" : candidate.bank_account_match;
      candidates.push(candidate);
    });
  } catch (err) {
    if (isMissingSchemaError(err)) evidenceSchemaIncomplete = true; else throw err;
  }

  try {
    const receipts = await selectRows(within("document_date", bankTxn.date, DIRECT_WINDOW_BEFORE_DAYS, DIRECT_WINDOW_AFTER_DAYS, db
      .from("job_revenue_documents")
      .select("id,realm_id,external_document_id,document_date,total_amount,amount_minor,currency,customer_ref,deposit_account_ref,payment_ref_num,payment_method_ref,linked_payment_ids,sync_token,source_snapshot_at,status,source_snapshot")
      .eq("business_id", businessId)
      .eq("source_document_type", "sales_receipt")
      .eq("amount_minor", bankAmountMinor)));
    receipts.forEach((row) => {
      const directAccount = String(refValue(row.deposit_account_ref) || "") === String(mapping?.qbo_account_id || "");
      const candidate = candidateBase({ bankTxn, mapping, mappingInfo, row, entityType: "SalesReceipt", entityId: row.external_document_id, txnDate: row.document_date, amountMinor: row.amount_minor, currency: row.currency, syncToken: row.sync_token, sourceSnapshotAt: row.source_snapshot_at });
      candidate.match_type = "qbo_sales_receipt_direct";
      candidate.reason_codes.push(directAccount ? "qbo_sales_receipt_deposited_directly_to_mapped_bank_account" : "qbo_sales_receipt_bank_account_mismatch_or_missing");
      candidate.verified_same_account = mappingInfo.verified && directAccount;
      candidate.bank_account_match = candidate.verified_same_account ? "verified_same_account" : candidate.bank_account_match;
      candidates.push(candidate);
    });
  } catch (err) {
    if (isMissingSchemaError(err)) evidenceSchemaIncomplete = true; else throw err;
  }

  try {
    const invoices = await selectRows(within("document_date", bankTxn.date, DIRECT_WINDOW_BEFORE_DAYS, DIRECT_WINDOW_AFTER_DAYS, db
      .from("job_revenue_documents")
      .select("id,realm_id,external_document_id,document_number,document_date,total_amount,amount_minor,currency,customer_ref,linked_payment_ids,sync_token,source_snapshot_at,status,source_snapshot")
      .eq("business_id", businessId)
      .eq("source_document_type", "invoice")
      .eq("amount_minor", bankAmountMinor)));
    invoices.forEach((row) => {
      const candidate = candidateBase({ bankTxn, mapping, mappingInfo, row, entityType: "Invoice", entityId: row.external_document_id, txnDate: row.document_date, amountMinor: row.amount_minor, currency: row.currency, syncToken: row.sync_token, sourceSnapshotAt: row.source_snapshot_at });
      candidate.match_type = "qbo_invoice_only_context";
      candidate.invoice_ids = [row.external_document_id].filter(Boolean).map(String);
      candidate.reason_codes.push("invoice_only_duplicate_income_evidence");
      candidate.reason_codes.push(row.linked_payment_ids?.length ? "invoice_links_payment_but_bank_chain_unproven" : "invoice_payment_chain_unproven");
      candidate.verified_same_account = false;
      candidate.bank_account_match = mappingInfo.bank_account_match;
      candidates.push(candidate);
    });
  } catch (err) {
    if (isMissingSchemaError(err)) evidenceSchemaIncomplete = true; else throw err;
  }

  return {
    candidates: candidates
      .filter(candidateEligible)
      .filter((candidate) => !rejected.has(`${candidate.qbo_entity_type}:${candidate.qbo_entity_id}`))
      .filter((candidate) => !consumed.has(`${candidate.qbo_entity_type}:${candidate.qbo_entity_id}`)),
    evidenceSchemaIncomplete,
  };
}

function classifyCandidates(candidates = []) {
  const bankAffecting = candidates.filter((candidate) =>
    candidate.verified_same_account &&
    ["qbo_deposit", "qbo_payment_direct", "qbo_sales_receipt_direct"].includes(candidate.match_type));
  const withLinkedChain = bankAffecting.filter((candidate) =>
    candidate.qbo_entity_type === "SalesReceipt" || candidate.qbo_entity_type === "Deposit" || candidate.invoice_ids?.length);

  if (withLinkedChain.length === 1 && candidates.length === 1) {
    return {
      status: "needs_confirmation",
      confidence_tier: "tier_1",
      confidence_score: 0.98,
      candidates,
      primary: withLinkedChain[0],
      reason_codes: Array.from(new Set([...withLinkedChain[0].reason_codes, "unique_unmatched_qbo_bank_affecting_candidate", "human_confirmation_required_for_launch"])),
    };
  }
  if (bankAffecting.length === 1) {
    return {
      status: "needs_confirmation",
      confidence_tier: "tier_2",
      confidence_score: 0.86,
      candidates,
      primary: bankAffecting[0],
      reason_codes: Array.from(new Set([...bankAffecting[0].reason_codes, "strong_qbo_bank_affecting_candidate", "human_confirmation_required"])),
    };
  }
  if (candidates.length) {
    const invoiceOnly = candidates.every((candidate) => candidate.match_type === "qbo_invoice_only_context");
    return {
      status: "ambiguous",
      confidence_tier: "tier_3",
      confidence_score: 0.55,
      candidates,
      primary: candidates[0],
      reason_codes: Array.from(new Set(candidates.flatMap((candidate) => candidate.reason_codes).concat(invoiceOnly ? "invoice_only_payment_verification_needed" : "multiple_or_unproven_qbo_candidates", "ordinary_income_posting_blocked"))),
    };
  }
  return {
    status: "candidate",
    confidence_tier: "tier_4",
    confidence_score: null,
    candidates: [],
    primary: null,
    reason_codes: ["no_plausible_existing_qbo_match_after_fresh_search"],
  };
}

async function insertHistory({ db, businessId, bankTransactionId, matchId = null, action, previousState = null, newState = null, actor = null, actorRole = null, reason = null, supersedesMatchId = null }) {
  try {
    await db.from("bank_qbo_match_history").insert({
      business_id: businessId,
      bank_transaction_id: bankTransactionId,
      match_id: matchId,
      action,
      previous_state: previousState,
      new_state: newState,
      actor,
      actor_role: actorRole,
      reason,
      supersedes_match_id: supersedesMatchId,
    });
  } catch (err) {
    if (!isMissingSchemaError(err)) throw err;
  }
}

async function persistCandidateResult({ db, businessId, bankTxn, mapping, freshness, result, actor = null, actorRole = null }) {
  if (!ACTIVE_CANDIDATE_STATUSES.has(result.status) && result.status !== "match_check_unavailable") return null;
  const primary = result.primary || {};
  const requestKey = hashKey([
    "incoming-deposit-match",
    businessId,
    bankTxn.id,
    result.status,
    primary.qbo_entity_type,
    primary.qbo_entity_id,
    freshness.source_freshness_at,
    result.reason_codes.join(","),
  ]);
  const row = {
    business_id: businessId,
    bank_transaction_id: bankTxn.id,
    status: result.status,
    match_type: result.status === "match_check_unavailable" ? "unavailable" : primary.match_type || "unavailable",
    confidence_tier: result.confidence_tier,
    confidence_score: result.confidence_score,
    reason_codes: result.reason_codes,
    gross_bank_amount_minor: toMinorUnits(Math.abs(Number(bankTxn.amount || 0)), 0),
    matched_qbo_amount_minor: primary.amount_minor || null,
    fee_amount_minor: null,
    currency: normalizeCurrency(bankTxn.iso_currency_code || bankTxn.unofficial_currency_code || primary.currency),
    date_distance_days: primary.date_distance_days ?? null,
    bank_account_match: primary.bank_account_match || mappingEvidence(mapping).bank_account_match,
    plaid_account_id: bankTxn.plaid_account_id || null,
    qbo_realm_id: primary.qbo_realm_id || null,
    qbo_bank_account_id: mapping?.qbo_account_id || null,
    qbo_bank_account_name: mapping?.qbo_account_name || null,
    mapping_source: mapping?.source || null,
    mapping_confidence: mapping?.confidence || null,
    source_freshness_at: freshness.source_freshness_at || null,
    request_idempotency_key: requestKey,
    created_by: actor,
    actor_role: actorRole,
    meta: {
      launch_policy: "human_confirmation_required",
      candidates: result.candidates.map((candidate) => ({
        qbo_entity_type: candidate.qbo_entity_type,
        qbo_entity_id: candidate.qbo_entity_id,
        qbo_realm_id: candidate.qbo_realm_id || null,
        match_type: candidate.match_type,
        amount_minor: candidate.amount_minor,
        txn_date: candidate.txn_date,
        customer_ref: candidate.customer_ref,
        invoice_ids: candidate.invoice_ids || [],
        reason_codes: candidate.reason_codes,
      })),
    },
  };
  const existing = await selectMaybe(db
    .from("bank_qbo_matches")
    .select("*")
    .eq("business_id", businessId)
    .eq("request_idempotency_key", requestKey)
    .maybeSingle());
  const match = existing || (await selectMaybe(db.from("bank_qbo_matches").insert(row).select("*").maybeSingle()));
  if (!existing) {
    const items = result.candidates.map((candidate, index) => ({
      match_id: match.id,
      business_id: businessId,
      qbo_entity_type: candidate.qbo_entity_type,
      qbo_entity_id: candidate.qbo_entity_id,
      qbo_realm_id: candidate.qbo_realm_id || null,
      amount_allocated_minor: candidate.amount_minor,
      customer_ref: candidate.customer_ref || null,
      invoice_ids: candidate.invoice_ids || [],
      qbo_sync_token: candidate.sync_token || null,
      source_snapshot_at: candidate.source_snapshot_at || null,
      evidence_role: index === 0 ? "primary" : "supporting",
      meta: {
        match_type: candidate.match_type,
        txn_date: candidate.txn_date,
        reason_codes: candidate.reason_codes,
      },
    }));
    if (items.length) await db.from("bank_qbo_match_items").insert(items);
    await insertHistory({ db, businessId, bankTransactionId: bankTxn.id, matchId: match.id, action: "discovered", newState: row, actor, actorRole });
  }
  return match;
}

async function writeCategorizationBlockMeta({ db, businessId, bankTxn, result, match = null, reason }) {
  const { data: existing } = await db
    .from("transaction_categorizations")
    .select("meta")
    .eq("business_id", businessId)
    .eq("transaction_id", bankTxn.id)
    .maybeSingle();
  await db
    .from("transaction_categorizations")
    .update({
      status: "needs_review",
      post_after: null,
      post_error: reason,
      last_post_attempt_at: new Date().toISOString(),
      meta: {
        ...(existing?.meta || {}),
        safe_to_auto_post: false,
        post_block_reason: reason,
        incoming_deposit_match_id: match?.id || null,
        incoming_deposit_match_status: result.status,
        incoming_deposit_confidence_tier: result.confidence_tier,
        incoming_deposit_reason_codes: result.reason_codes,
        incoming_deposit_candidates: (result.candidates || []).map((candidate) => ({
          qbo_entity_type: candidate.qbo_entity_type,
          qbo_entity_id: candidate.qbo_entity_id,
          qbo_realm_id: candidate.qbo_realm_id || null,
          match_type: candidate.match_type,
          txn_date: candidate.txn_date,
          amount_minor: candidate.amount_minor,
          currency: candidate.currency || null,
          customer_ref: candidate.customer_ref || null,
          invoice_ids: candidate.invoice_ids || [],
          bank_account_match: candidate.bank_account_match || null,
          reason_codes: candidate.reason_codes || [],
        })),
        posting_in_progress: false,
        next_post_attempt_at: null,
      },
    })
    .eq("business_id", businessId)
    .eq("transaction_id", bankTxn.id);
}

export async function discoverIncomingDepositQboMatch({ db = defaultSupabase, businessId, bankTransactionId, actor = null, actorRole = null, persist = true, nowMs = Date.now() } = {}) {
  if (!businessId || !bankTransactionId) throw new IncomingDepositMatchError("missing_match_input", 400);
  const bankTxn = await fetchBankTransaction({ db, businessId, bankTransactionId });
  if (!bankTxn) throw new IncomingDepositMatchError("bank_transaction_not_found", 404);
  if (!isIncomingDeposit(bankTxn)) return { ok: true, status: "not_applicable", posting_eligibility: "ordinary_workflow", reason_codes: ["not_incoming_deposit"] };
  if (bankTxn.pending === true) return { ok: true, status: "pending", posting_eligibility: "blocked", reason_codes: ["pending_bank_transaction"] };

  const schema = await matchSchemaAvailable({ db });
  if (!schema.ok) {
    const result = { status: "match_check_unavailable", confidence_tier: "unavailable", confidence_score: null, candidates: [], primary: null, reason_codes: [schema.reason, "ordinary_income_posting_blocked"] };
    if (persist) await writeCategorizationBlockMeta({ db, businessId, bankTxn, result, match: null, reason: "match_check_unavailable" });
    return { ok: true, ...result, posting_eligibility: "blocked_match_check_unavailable", match: null };
  }

  const activeConfirmed = await selectRows(db
    .from("bank_qbo_matches")
    .select("*")
    .eq("business_id", businessId)
    .eq("bank_transaction_id", bankTransactionId)
    .eq("status", "confirmed")
    .is("superseded_at", null)
    .limit(1)).catch((err) => {
      if (isMissingSchemaError(err)) return [];
      throw err;
    });
  if (activeConfirmed.length) {
    return { ok: true, status: "confirmed", posting_eligibility: "blocked_existing_qbo_match", match: activeConfirmed[0], reason_codes: ["already_matched_to_existing_qbo"] };
  }

  const mapping = await fetchMapping({ db, businessId, plaidAccountId: bankTxn.plaid_account_id });
  const mappingInfo = mappingEvidence(mapping);
  const freshness = await fetchFreshness({ db, businessId, nowMs });
  if (!freshness.ok) {
    const result = { status: "match_check_unavailable", confidence_tier: "unavailable", confidence_score: null, candidates: [], primary: null, reason_codes: [freshness.reason, "ordinary_income_posting_blocked"] };
    const match = persist ? await persistCandidateResult({ db, businessId, bankTxn, mapping, freshness, result, actor, actorRole }) : null;
    if (persist) await writeCategorizationBlockMeta({ db, businessId, bankTxn, result, match, reason: "match_check_unavailable" });
    return { ok: true, ...result, posting_eligibility: "blocked_match_check_unavailable", match };
  }
  const bankAmountMinor = toMinorUnits(Math.abs(Number(bankTxn.amount || 0)), null);
  const { candidates, evidenceSchemaIncomplete } = await discoverCandidates({ db, businessId, bankTxn, mapping, mappingInfo, bankAmountMinor });
  if (evidenceSchemaIncomplete && !candidates.length) {
    const result = { status: "match_check_unavailable", confidence_tier: "unavailable", confidence_score: null, candidates: [], primary: null, reason_codes: ["qbo_match_evidence_columns_unavailable", "ordinary_income_posting_blocked"] };
    const match = persist ? await persistCandidateResult({ db, businessId, bankTxn, mapping, freshness, result, actor, actorRole }) : null;
    if (persist) await writeCategorizationBlockMeta({ db, businessId, bankTxn, result, match, reason: "match_check_unavailable" });
    return { ok: true, ...result, posting_eligibility: "blocked_match_check_unavailable", match };
  }
  const result = classifyCandidates(candidates);
  if (evidenceSchemaIncomplete) {
    result.reason_codes = Array.from(new Set([...(result.reason_codes || []), "qbo_match_evidence_schema_partial"]));
  }
  if (!mappingInfo.verified) {
    result.status = "ambiguous";
    result.confidence_tier = "tier_3";
    result.confidence_score = null;
    result.reason_codes = Array.from(new Set([...(result.reason_codes || []), mappingInfo.reason, "bank_account_could_not_be_fully_verified", "ordinary_income_posting_blocked"]));
  }
  const match = persist ? await persistCandidateResult({ db, businessId, bankTxn, mapping, freshness, result, actor, actorRole }) : null;
  if (result.status === "candidate" && result.confidence_tier === "tier_4") {
    return { ok: true, ...result, posting_eligibility: "ordinary_income_posting_allowed", match: null };
  }
  if (persist) {
    const reason = !mappingInfo.verified ? "incoming_deposit_bank_account_mapping_unverified" : result.status === "ambiguous" ? "incoming_deposit_needs_match" : "possible_existing_qbo_match";
    await writeCategorizationBlockMeta({ db, businessId, bankTxn, result, match, reason });
  }
  return { ok: true, ...result, posting_eligibility: !mappingInfo.verified ? "blocked_unverified_bank_account_mapping" : result.status === "ambiguous" ? "blocked_needs_match" : "blocked_confirmation_required", match };
}

export async function evaluateIncomingDepositPostingGuard(args = {}) {
  const result = await discoverIncomingDepositQboMatch({ ...args, persist: true });
  if (["ordinary_workflow", "ordinary_income_posting_allowed"].includes(result.posting_eligibility)) {
    return { ok: true, allowed: true, result };
  }
  return { ok: true, allowed: false, reason: result.posting_eligibility || result.status, result };
}

function isUnresolvedCustomerReceiptCandidate(bankTxn = {}, cat = {}) {
  if (!isIncomingDeposit(bankTxn)) return false;
  if (bankTxn.pending === true || bankTxn.is_archived === true) return false;
  const status = String(cat.status || "needs_review").toLowerCase();
  if (!["needs_review", "uncategorized", ""].includes(status)) return false;
  const meta = cat.meta || {};
  if (meta.matched_existing_qbo === true || meta.incoming_deposit_match_status === "rejected") return false;
  if (meta.incoming_deposit_match_status && meta.incoming_deposit_match_status !== "unchecked") return false;
  const taxonomy = String(meta.taxonomy_type || meta.taxonomy_override || "").toLowerCase();
  if (CUSTOMER_RECEIPT_EXCLUDED_TAXONOMIES.has(taxonomy)) return false;
  return true;
}

function matchResultSummary(result = {}) {
  return {
    status: result.status || null,
    posting_eligibility: result.posting_eligibility || null,
    confidence_tier: result.confidence_tier || null,
    reason_codes: result.reason_codes || [],
    match_id: result.match?.id || result.match_id || null,
    candidate_count: result.candidates?.length || 0,
    candidates: (result.candidates || []).map((candidate) => ({
      qbo_entity_type: candidate.qbo_entity_type,
      qbo_entity_id: candidate.qbo_entity_id,
      qbo_realm_id: candidate.qbo_realm_id || null,
      match_type: candidate.match_type,
      txn_date: candidate.txn_date,
      amount_minor: candidate.amount_minor,
      currency: candidate.currency || null,
      customer_ref: candidate.customer_ref || null,
      invoice_ids: candidate.invoice_ids || [],
      bank_account_match: candidate.bank_account_match || null,
      reason_codes: candidate.reason_codes || [],
    })),
  };
}

async function fetchCandidateRowsForDiscovery({ db, businessId, transactionId = null, limit = 25 }) {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  let query = db
    .from("bank_transactions")
    .select("id,business_id,plaid_transaction_id,plaid_account_id,date,amount,signed_amount,direction,pending,is_archived,name,merchant_name,counterparty_name")
    .eq("business_id", businessId)
    .eq("is_archived", false)
    .eq("pending", false)
    .gt("amount", 0)
    .order("date", { ascending: false })
    .limit(safeLimit);
  if (transactionId) query = query.eq("id", transactionId).limit(1);
  const bankRows = await selectRows(query);
  const ids = bankRows.map((row) => row.id).filter(Boolean);
  if (!ids.length) return [];
  const cats = await selectRows(db
    .from("transaction_categorizations")
    .select("transaction_id,status,post_error,meta")
    .eq("business_id", businessId)
    .in("transaction_id", ids));
  const catByTxn = new Map(cats.map((row) => [String(row.transaction_id), row]));
  return bankRows
    .map((bankTxn) => ({ bankTxn, cat: catByTxn.get(String(bankTxn.id)) || { status: "needs_review", meta: {} } }))
    .filter(({ bankTxn, cat }) => isUnresolvedCustomerReceiptCandidate(bankTxn, cat));
}

export async function discoverExistingIncomingDepositMatches({
  db = defaultSupabase,
  businessId,
  transactionId = null,
  dryRun = true,
  limit = 25,
  actor = null,
  actorRole = "candidate_backfill",
  nowMs = Date.now(),
} = {}) {
  if (!businessId) throw new IncomingDepositMatchError("missing_business_id", 400);
  const rows = await fetchCandidateRowsForDiscovery({ db, businessId, transactionId, limit });
  const results = [];
  for (const { bankTxn } of rows) {
    try {
      const result = await discoverIncomingDepositQboMatch({
        db,
        businessId,
        bankTransactionId: bankTxn.id,
        actor,
        actorRole,
        persist: !dryRun,
        nowMs,
      });
      results.push({ transaction_id: bankTxn.id, ok: true, ...matchResultSummary(result) });
    } catch (err) {
      results.push({
        transaction_id: bankTxn.id,
        ok: false,
        status: "match_check_unavailable",
        posting_eligibility: "blocked_match_check_unavailable",
        reason_codes: [err?.code || err?.message || "incoming_deposit_discovery_failed"],
      });
    }
  }
  return {
    ok: true,
    dry_run: dryRun,
    business_id: businessId,
    requested_transaction_id: transactionId || null,
    scanned: rows.length,
    blocked: results.filter((row) => row.posting_eligibility && !["ordinary_workflow", "ordinary_income_posting_allowed"].includes(row.posting_eligibility)).length,
    ordinary_allowed: results.filter((row) => row.posting_eligibility === "ordinary_income_posting_allowed").length,
    failed: results.filter((row) => row.ok === false).length,
    results,
  };
}

async function fetchPrimaryMatchItem({ db, businessId, matchId }) {
  return selectMaybe(db
    .from("bank_qbo_match_items")
    .select("*")
    .eq("business_id", businessId)
    .eq("match_id", matchId)
    .eq("evidence_role", "primary")
    .maybeSingle());
}

async function fetchCurrentQboVersion({ db, businessId, item }) {
  if (!item?.qbo_entity_type || !item?.qbo_entity_id) return null;
  if (item.qbo_entity_type === "Deposit") {
    return selectMaybe(db
      .from("job_revenue_evidence")
      .select("realm_id,qbo_txn_id,sync_token,source_snapshot_at,status")
      .eq("business_id", businessId)
      .eq("qbo_txn_type", "Deposit")
      .eq("qbo_txn_id", item.qbo_entity_id)
      .maybeSingle());
  }
  if (item.qbo_entity_type === "Payment") {
    return selectMaybe(db
      .from("job_payment_records")
      .select("realm_id,external_payment_id,sync_token,source_snapshot_at,status")
      .eq("business_id", businessId)
      .eq("external_payment_id", item.qbo_entity_id)
      .maybeSingle());
  }
  if (item.qbo_entity_type === "SalesReceipt") {
    return selectMaybe(db
      .from("job_revenue_documents")
      .select("realm_id,external_document_id,sync_token,source_snapshot_at,status")
      .eq("business_id", businessId)
      .eq("source_document_type", "sales_receipt")
      .eq("external_document_id", item.qbo_entity_id)
      .maybeSingle());
  }
  return null;
}

async function assertCandidateCurrent({ db, businessId, matchId }) {
  const item = await fetchPrimaryMatchItem({ db, businessId, matchId });
  if (!item) throw new IncomingDepositMatchError("primary_match_item_missing", 409);
  const current = await fetchCurrentQboVersion({ db, businessId, item });
  if (!current) throw new IncomingDepositMatchError("qbo_match_candidate_missing", 409);
  if (INVALID_QBO_STATUSES.has(String(current.status || "").toLowerCase())) throw new IncomingDepositMatchError("qbo_match_candidate_invalid_status", 409);
  if (item.qbo_realm_id && current.realm_id && String(item.qbo_realm_id) !== String(current.realm_id)) {
    throw new IncomingDepositMatchError("qbo_match_candidate_realm_changed", 409);
  }
  if (item.qbo_sync_token && current.sync_token && String(item.qbo_sync_token) !== String(current.sync_token)) {
    throw new IncomingDepositMatchError("qbo_match_candidate_stale", 409);
  }
  if (item.source_snapshot_at && current.source_snapshot_at && String(item.source_snapshot_at) !== String(current.source_snapshot_at)) {
    throw new IncomingDepositMatchError("qbo_match_candidate_snapshot_stale", 409);
  }
  return { item, current };
}

export async function confirmIncomingDepositQboMatch({ db = defaultSupabase, businessId, bankTransactionId, matchId, actor = null, actorRole = "user", idempotencyKey = null, expectedBankUpdatedAt = null } = {}) {
  if (!businessId || !bankTransactionId || !matchId) throw new IncomingDepositMatchError("missing_confirm_input", 400);
  const bankTxn = await fetchBankTransaction({ db, businessId, bankTransactionId });
  if (!bankTxn) throw new IncomingDepositMatchError("bank_transaction_not_found", 404);
  if (expectedBankUpdatedAt && bankTxn.updated_at && String(expectedBankUpdatedAt) !== String(bankTxn.updated_at)) {
    throw new IncomingDepositMatchError("stale_bank_transaction_version", 409);
  }
  const match = await selectMaybe(db
    .from("bank_qbo_matches")
    .select("*")
    .eq("business_id", businessId)
    .eq("bank_transaction_id", bankTransactionId)
    .eq("id", matchId)
    .maybeSingle());
  if (!match) throw new IncomingDepositMatchError("match_not_found", 404);
  if (match.status === "confirmed") {
    const existingKey = match.meta?.confirmed_idempotency_key || null;
    if (existingKey && idempotencyKey && String(existingKey) !== String(idempotencyKey)) {
      throw new IncomingDepositMatchError("idempotency_key_mismatch", 409);
    }
    return { ok: true, status: "confirmed", match_id: matchId, idempotent: true };
  }
  if (!ACTIVE_CANDIDATE_STATUSES.has(match.status)) throw new IncomingDepositMatchError("match_not_confirmable", 409, { status: match.status });
  if (match.match_type === "unavailable") throw new IncomingDepositMatchError("match_check_unavailable", 409);
  const primaryItem = await fetchPrimaryMatchItem({ db, businessId, matchId });
  if (!primaryItem) throw new IncomingDepositMatchError("primary_match_item_missing", 409);
  if (primaryItem.qbo_entity_type === "Invoice" || match.match_type === "qbo_invoice_only_context") {
    throw new IncomingDepositMatchError("invoice_only_match_not_confirmable", 409);
  }
  const { item } = await assertCandidateCurrent({ db, businessId, matchId });
  if (item.qbo_entity_type === "Invoice" || match.match_type === "qbo_invoice_only_context") {
    throw new IncomingDepositMatchError("invoice_only_match_not_confirmable", 409);
  }

  const active = await selectRows(db
    .from("bank_qbo_matches")
    .select("id")
    .eq("business_id", businessId)
    .eq("bank_transaction_id", bankTransactionId)
    .eq("status", "confirmed")
    .is("superseded_at", null)
    .limit(1));
  if (active.length && String(active[0].id) !== String(matchId)) throw new IncomingDepositMatchError("bank_transaction_already_matched", 409);

  const now = new Date().toISOString();
  await db.from("bank_qbo_matches").update({
    status: "confirmed",
    confirmed_at: now,
    updated_at: now,
    actor_role: actorRole,
    meta: { ...(match.meta || {}), confirmed_idempotency_key: idempotencyKey || null },
  }).eq("business_id", businessId).eq("id", matchId);
  await db.from("bank_qbo_match_items").update({ active_confirmed: true }).eq("business_id", businessId).eq("match_id", matchId).eq("evidence_role", "primary");

  const { data: existingCat } = await db
    .from("transaction_categorizations")
    .select("meta")
    .eq("business_id", businessId)
    .eq("transaction_id", bankTransactionId)
    .maybeSingle();
  await db.from("transaction_categorizations").update({
    status: "matched_existing_qbo",
    post_after: null,
    post_error: null,
    reconciled_at: now,
    last_post_attempt_at: now,
    meta: {
      ...(existingCat?.meta || {}),
      safe_to_auto_post: false,
      incoming_deposit_match_id: matchId,
      incoming_deposit_match_status: "confirmed",
      incoming_deposit_confidence_tier: match.confidence_tier,
      incoming_deposit_reason_codes: match.reason_codes || [],
      matched_existing_qbo: true,
      qbo_write_performed: false,
      posting_in_progress: false,
      next_post_attempt_at: null,
    },
  }).eq("business_id", businessId).eq("transaction_id", bankTransactionId);

  await insertHistory({
    db,
    businessId,
    bankTransactionId,
    matchId,
    action: "confirmed",
    previousState: match,
    newState: { ...match, status: "confirmed", confirmed_at: now },
    actor,
    actorRole,
    reason: "human_confirmed_existing_qbo_match",
  });
  return { ok: true, status: "confirmed", match_id: matchId };
}

export async function rejectIncomingDepositQboMatch({ db = defaultSupabase, businessId, bankTransactionId, matchId, actor = null, actorRole = "user", reason = "human_rejected" } = {}) {
  const match = await selectMaybe(db
    .from("bank_qbo_matches")
    .select("*")
    .eq("business_id", businessId)
    .eq("bank_transaction_id", bankTransactionId)
    .eq("id", matchId)
    .maybeSingle());
  if (!match) throw new IncomingDepositMatchError("match_not_found", 404);
  if (FINAL_MATCH_STATUSES.has(match.status)) throw new IncomingDepositMatchError("confirmed_match_requires_undo", 409);
  const now = new Date().toISOString();
  await db.from("bank_qbo_matches").update({ status: "rejected", updated_at: now }).eq("business_id", businessId).eq("id", matchId);
  const { data: existingCat } = await db
    .from("transaction_categorizations")
    .select("meta")
    .eq("business_id", businessId)
    .eq("transaction_id", bankTransactionId)
    .maybeSingle();
  await db.from("transaction_categorizations").update({
    status: "needs_review",
    post_after: null,
    post_error: "incoming_deposit_match_rejected_review_required",
    last_post_attempt_at: now,
    meta: {
      ...(existingCat?.meta || {}),
      safe_to_auto_post: false,
      post_block_reason: "incoming_deposit_match_rejected_review_required",
      incoming_deposit_match_id: matchId,
      incoming_deposit_match_status: "rejected",
      incoming_deposit_confidence_tier: match.confidence_tier || null,
      incoming_deposit_reason_codes: Array.from(new Set([...(match.reason_codes || []), "human_rejected_candidate", "ordinary_income_posting_blocked"])),
      posting_in_progress: false,
      next_post_attempt_at: null,
    },
  }).eq("business_id", businessId).eq("transaction_id", bankTransactionId);
  await insertHistory({ db, businessId, bankTransactionId, matchId, action: "rejected", previousState: match, newState: { ...match, status: "rejected" }, actor, actorRole, reason });
  return { ok: true, status: "rejected", posting_eligibility: "blocked_rejected_candidate_review_required", match_id: matchId };
}

export async function undoIncomingDepositQboMatch({ db = defaultSupabase, businessId, bankTransactionId, matchId, actor = null, actorRole = "user", reason = "human_undo" } = {}) {
  const match = await selectMaybe(db
    .from("bank_qbo_matches")
    .select("*")
    .eq("business_id", businessId)
    .eq("bank_transaction_id", bankTransactionId)
    .eq("id", matchId)
    .maybeSingle());
  if (!match) throw new IncomingDepositMatchError("match_not_found", 404);
  if (match.status !== "confirmed") throw new IncomingDepositMatchError("match_not_confirmed", 409);
  const now = new Date().toISOString();
  await db.from("bank_qbo_matches").update({ status: "superseded", superseded_at: now, updated_at: now }).eq("business_id", businessId).eq("id", matchId);
  await db.from("bank_qbo_match_items").update({ active_confirmed: false }).eq("business_id", businessId).eq("match_id", matchId);
  const { data: existingCat } = await db
    .from("transaction_categorizations")
    .select("meta")
    .eq("business_id", businessId)
    .eq("transaction_id", bankTransactionId)
    .maybeSingle();
  await db.from("transaction_categorizations").update({
    status: "needs_review",
    posted_at: null,
    reconciled_at: null,
    meta: {
      ...(existingCat?.meta || {}),
      incoming_deposit_match_status: "superseded",
      incoming_deposit_match_id: matchId,
      matched_existing_qbo: false,
      qbo_write_performed: false,
    },
  }).eq("business_id", businessId).eq("transaction_id", bankTransactionId);
  await insertHistory({ db, businessId, bankTransactionId, matchId, action: "superseded", previousState: match, newState: { ...match, status: "superseded" }, actor, actorRole, reason });
  return { ok: true, status: "superseded", match_id: matchId };
}
