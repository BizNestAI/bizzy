import crypto from "crypto";
import { resolveBankTransactionCurrency } from "./bankTransactionCurrency.js";

const LOAN_KEYWORDS_RE = /\b(?:loan|mortgage|principal|installment|lending|finance|financing|credit union|cu|alliant|navient|nelnet|sba|kabbage|fundbox|ondeck|paypal working capital)\b/i;
const GENERIC_LENDER_FRAGMENTS = new Set(["payment", "loan", "principal", "finance", "financing", "online", "mobile", "transfer", "ach", "pmt"]);

export const LOAN_PAYMENT_TAXONOMY_TYPE = "loan_payment";
export const LOAN_PAYMENT_PROFILE_SOURCE_TYPE = "business_lender_profile";

export class LoanPaymentWorkflowError extends Error {
  constructor(error, details = {}) {
    super(error);
    this.name = "LoanPaymentWorkflowError";
    this.error = error;
    this.details = details;
  }
}

export function signedAmountMinor(transaction = {}) {
  const signedMinor = Number(transaction.signed_amount_minor ?? transaction.amount_minor);
  if (Number.isInteger(signedMinor) && signedMinor !== 0) return signedMinor;
  const signed = Number(transaction.signed_amount ?? transaction.amount);
  if (!Number.isFinite(signed) || signed === 0) return null;
  return Math.round(signed * 100);
}

export function normalizeLoanText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(?:ach|web|dep|pymt|pmt|debit|credit|auto|autopay|online|payment|withdrawal|withdraw|pos|card|visa|mc|id|ref|trace)\b/g, " ")
    .replace(/\b\d{3,}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stableFingerprint(value = "") {
  const normalized = normalizeLoanText(value);
  if (!normalized) return null;
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 24);
}

export function getLoanPaymentIdentity(transaction = {}) {
  const providerMerchantId = transaction.merchant_entity_id || transaction.provider_merchant_id || null;
  const merchant = normalizeLoanText(transaction.merchant_name || transaction.counterparty_name || "");
  const descriptor = normalizeLoanText([
    transaction.name,
    transaction.original_description,
    transaction.raw?.original_description,
    transaction.raw?.name,
  ].filter(Boolean).join(" "));
  const memo = normalizeLoanText([
    transaction.memo,
    transaction.payment_channel,
    transaction.category_primary,
    transaction.category_detailed,
    transaction.personal_finance_category?.primary,
    transaction.personal_finance_category?.detailed,
  ].filter(Boolean).join(" "));

  if (providerMerchantId) {
    return {
      match_specificity: "exact_provider_lender_id",
      provider_merchant_id: String(providerMerchantId),
      normalized_lender: merchant || descriptor || null,
      fingerprint: `provider:${providerMerchantId}`,
      display_lender: transaction.merchant_name || transaction.counterparty_name || transaction.name || "Lender",
    };
  }

  const candidate = merchant || descriptor;
  const tokens = candidate.split(" ").filter(Boolean);
  const specific = tokens.some((token) => token.length >= 4 && !GENERIC_LENDER_FRAGMENTS.has(token));
  if (candidate && specific) {
    return {
      match_specificity: merchant ? "exact_normalized_lender" : "exact_descriptor_fingerprint",
      provider_merchant_id: null,
      normalized_lender: candidate,
      fingerprint: stableFingerprint(candidate),
      display_lender: transaction.merchant_name || transaction.counterparty_name || transaction.name || candidate,
    };
  }

  if (memo && memo.split(" ").filter((token) => token.length >= 4 && !GENERIC_LENDER_FRAGMENTS.has(token)).length >= 2) {
    return {
      match_specificity: "memo_fingerprint",
      provider_merchant_id: null,
      normalized_lender: memo,
      fingerprint: stableFingerprint(memo),
      display_lender: transaction.name || transaction.merchant_name || "Lender",
    };
  }

  return null;
}

function buildManualLoanPaymentIdentity(split = {}) {
  const lenderName = String(split.lender_name || split.lenderName || "").trim();
  const loanName = String(split.loan_name || split.loanName || "").trim();
  const referenceLastFour = String(split.reference_last_four || split.referenceLastFour || "").replace(/\D/g, "").slice(-4);
  if (!lenderName || !loanName) return null;
  const normalizedLender = normalizeLoanText(lenderName);
  const normalizedLoan = normalizeLoanText([lenderName, loanName, referenceLastFour].filter(Boolean).join(" "));
  if (!normalizedLender || !normalizedLoan) return null;
  return {
    match_specificity: "exact_descriptor_fingerprint",
    provider_merchant_id: null,
    normalized_lender: normalizedLender,
    fingerprint: stableFingerprint(normalizedLoan),
    display_lender: loanName,
    manual: true,
    loan_name: loanName,
    lender_name: lenderName,
    reference_last_four: referenceLastFour || null,
  };
}

function buildProfileLoanPaymentIdentity(profile = {}) {
  if (!profile?.id) return null;
  return {
    match_specificity: profile.match_specificity || "exact_descriptor_fingerprint",
    provider_merchant_id: profile.provider_merchant_id || null,
    normalized_lender: profile.normalized_lender || normalizeLoanText(profile.lender_display_name || profile.meta?.lender_name || ""),
    fingerprint: profile.descriptor_fingerprint || stableFingerprint([profile.lender_display_name, profile.meta?.loan_name, profile.meta?.reference_last_four].filter(Boolean).join(" ")),
    display_lender: profile.meta?.loan_name || profile.lender_display_name || "Loan",
    lender_name: profile.meta?.lender_name || profile.lender_display_name || null,
    loan_name: profile.meta?.loan_name || profile.lender_display_name || null,
    reference_last_four: profile.meta?.reference_last_four || null,
  };
}

export function detectPossibleLoanPayment(transaction = {}) {
  const direction = String(transaction.direction || "").toUpperCase();
  const signedMinor = signedAmountMinor(transaction);
  const isOutflow = direction === "OUTFLOW" || (direction !== "INFLOW" && Number.isInteger(signedMinor) && signedMinor < 0);
  const text = [
    transaction.name,
    transaction.merchant_name,
    transaction.counterparty_name,
    transaction.original_description,
    transaction.raw?.original_description,
    transaction.raw?.name,
    transaction.category_primary,
    transaction.category_detailed,
    transaction.personal_finance_category?.primary,
    transaction.personal_finance_category?.detailed,
  ].filter(Boolean).join(" ");
  if (transaction.pending === true || !isOutflow || !LOAN_KEYWORDS_RE.test(text)) return null;
  const identity = getLoanPaymentIdentity(transaction);
  if (!identity) return null;
  return {
    taxonomy_type: LOAN_PAYMENT_TAXONOMY_TYPE,
    confidence: /loan|mortgage|principal|alliant/i.test(text) ? "high" : "medium",
    label: "Possible Loan Payment · Needs Review",
    reason: "loan_payment_evidence",
    identity,
  };
}

function compactObject(value = {}) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

async function insertLoanAuditEvent({
  db,
  businessId,
  transactionId,
  lenderProfileId,
  splitId,
  eventType,
  actorId,
  actorType,
  previousState = null,
  nextState = null,
  meta = {},
}) {
  if (!db || !businessId || !eventType) return null;
  const { data, error } = await db
    .from("loan_payment_audit_events")
    .insert({
      business_id: businessId,
      transaction_id: transactionId || null,
      lender_profile_id: lenderProfileId || null,
      split_id: splitId || null,
      event_type: eventType,
      actor_id: actorId || null,
      actor_type: actorType || null,
      previous_state: previousState,
      next_state: nextState,
      meta,
    })
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

function normalizeAccountType(value = "") {
  return String(value || "").replace(/[\s_-]+/g, "").toLowerCase();
}

export function isLiabilityQboAccount(account = {}) {
  const type = normalizeAccountType(account.type || account.AccountType || account.account_type);
  return type === "othercurrentliability" || type === "longtermliability" || type === "liability";
}

export function isExpenseQboAccount(account = {}) {
  const type = normalizeAccountType(account.type || account.AccountType || account.account_type);
  return type === "expense" || type === "otherexpense" || type === "costofgoodssold" || type === "costofgoodsold";
}

export function validateLoanPaymentSplit({ transaction = {}, split = {}, accountsById = new Map() } = {}) {
  if (transaction.pending === true) throw new LoanPaymentWorkflowError("pending_transaction_not_postable");
  const signedMinor = signedAmountMinor(transaction);
  if (!Number.isInteger(signedMinor) || signedMinor >= 0) throw new LoanPaymentWorkflowError("loan_payment_requires_outflow");
  const expected = Math.abs(signedMinor);
  const lines = [
    { role: "principal", amount_minor: split.principal_amount_minor, qbo_account_id: split.principal_qbo_account_id },
    { role: "interest", amount_minor: split.interest_amount_minor, qbo_account_id: split.interest_qbo_account_id },
    ...(Array.isArray(split.fee_lines) ? split.fee_lines.map((line) => ({ role: "fee", ...line })) : []),
  ].filter((line) => Number(line.amount_minor || 0) > 0);
  if (!lines.length) throw new LoanPaymentWorkflowError("loan_split_required");
  const total = lines.reduce((sum, line) => sum + Number(line.amount_minor || 0), 0);
  if (total !== expected) throw new LoanPaymentWorkflowError("loan_split_total_mismatch", { expected_amount_minor: expected, actual_amount_minor: total });
  for (const line of lines) {
    if (!Number.isInteger(Number(line.amount_minor)) || Number(line.amount_minor) <= 0) {
      throw new LoanPaymentWorkflowError("loan_split_line_amount_invalid", { role: line.role });
    }
    if (!line.qbo_account_id) throw new LoanPaymentWorkflowError("loan_split_line_missing_account", { role: line.role });
    const account = accountsById.get(String(line.qbo_account_id));
    if (!account) {
      if (accountsById.size > 0) throw new LoanPaymentWorkflowError("loan_split_line_account_not_found", { role: line.role, qbo_account_id: line.qbo_account_id });
      continue;
    }
    if (line.role === "principal" && !isLiabilityQboAccount(account)) {
      throw new LoanPaymentWorkflowError("loan_principal_account_must_be_liability", { qbo_account_id: line.qbo_account_id });
    }
    if (line.role !== "principal" && !isExpenseQboAccount(account)) {
      throw new LoanPaymentWorkflowError("loan_interest_or_fee_account_must_be_expense", { role: line.role, qbo_account_id: line.qbo_account_id });
    }
  }
  return { ok: true, expected_amount_minor: expected, lines };
}

export function buildLoanPaymentPurchasePayload({ transaction = {}, split = {}, mapping = {}, requestId, lineDescription, privateNote } = {}) {
  const validation = validateLoanPaymentSplit({ transaction, split });
  const paymentType = normalizeAccountType(mapping.qbo_account_type) === "creditcard" ? "CreditCard" : "Cash";
  const txnDate = transaction.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(txnDate || ""))) throw new LoanPaymentWorkflowError("missing_plaid_posted_date");
  const lineBase = lineDescription || transaction.merchant_name || transaction.name || "Loan payment";
  return {
    requestId,
    PaymentType: paymentType,
    AccountRef: { value: String(mapping.qbo_account_id) },
    TxnDate: txnDate,
    PrivateNote: privateNote || `Loan payment split by Bizzi for bank transaction ${transaction.id || transaction.transaction_id || ""}`.trim(),
    Line: validation.lines.map((line) => ({
      DetailType: "AccountBasedExpenseLineDetail",
      Amount: Number(line.amount_minor) / 100,
      Description: `${lineBase} · ${line.role}`,
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: String(line.qbo_account_id) },
      },
    })),
  };
}

export async function findActiveLenderProfileForTransaction({ db, businessId, transaction = {} } = {}) {
  if (!db || !businessId) return null;
  const signedMinor = signedAmountMinor(transaction);
  const direction = String(transaction.direction || "").toUpperCase();
  const isOutflow = direction === "OUTFLOW" || (direction !== "INFLOW" && Number.isInteger(signedMinor) && signedMinor < 0);
  if (!isOutflow) return null;
  const identity = getLoanPaymentIdentity(transaction);
  if (!identity) return null;
  let query = db
    .from("loan_lender_profiles")
    .select("*")
    .eq("business_id", businessId)
    .eq("status", "active")
    .order("updated_at", { ascending: false })
    .limit(1);
  if (identity.provider_merchant_id) {
    query = query.eq("provider_merchant_id", identity.provider_merchant_id);
  } else {
    query = query.eq("descriptor_fingerprint", identity.fingerprint);
  }
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function confirmLoanPaymentSplit({
  db,
  businessId,
  transaction = {},
  split = {},
  accountsById = new Map(),
  actorId = null,
  actorType = "user",
} = {}) {
  if (!db || !businessId) throw new LoanPaymentWorkflowError("missing_database_or_business");
  const validation = validateLoanPaymentSplit({ transaction, split, accountsById });
  const nowIso = new Date().toISOString();
  let existingProfile = null;
  if (split.lender_profile_id) {
    const { data, error } = await db
      .from("loan_lender_profiles")
      .select("*")
      .eq("business_id", businessId)
      .eq("id", split.lender_profile_id)
      .eq("status", "active")
      .maybeSingle();
    if (error) throw error;
    existingProfile = data || null;
  }
  const identity = buildManualLoanPaymentIdentity(split) || buildProfileLoanPaymentIdentity(existingProfile) || getLoanPaymentIdentity(transaction);
  if (identity && !existingProfile) {
    let profileQuery = db
      .from("loan_lender_profiles")
      .select("*")
      .eq("business_id", businessId)
      .eq("status", "active")
      .order("updated_at", { ascending: false })
      .limit(1);
    profileQuery = identity.provider_merchant_id
      ? profileQuery.eq("provider_merchant_id", identity.provider_merchant_id)
      : profileQuery.eq("descriptor_fingerprint", identity.fingerprint);
    const { data, error } = await profileQuery.maybeSingle();
    if (error) throw error;
    existingProfile = data || null;
  }
  let lenderProfile = null;
  if (identity) {
    const profilePayload = compactObject({
      business_id: businessId,
      lender_display_name: identity.display_lender,
      normalized_lender: identity.normalized_lender,
      provider_merchant_id: identity.provider_merchant_id,
      descriptor_fingerprint: identity.fingerprint,
      match_specificity: identity.match_specificity,
      source_type: LOAN_PAYMENT_PROFILE_SOURCE_TYPE,
      authority: actorType === "admin" ? "admin_confirmed" : actorType === "bookkeeper" ? "bookkeeper_confirmed" : "user_confirmed",
      source_transaction_id: transaction.id || transaction.transaction_id || null,
      source_plaid_account_id: transaction.plaid_account_id || null,
      actor_id: actorId,
      actor_type: actorType,
      default_principal_qbo_account_id: split.principal_qbo_account_id || null,
      default_interest_qbo_account_id: split.interest_qbo_account_id || null,
      default_fee_qbo_account_id: split.default_fee_qbo_account_id || split.fee_lines?.[0]?.qbo_account_id || null,
      typical_payment_amount_minor: validation.expected_amount_minor,
      expected_cadence: split.expected_cadence || existingProfile?.expected_cadence || null,
      first_confirmed_at: existingProfile?.first_confirmed_at || nowIso,
      last_confirmed_at: nowIso,
      updated_at: nowIso,
      meta: {
        ...(existingProfile?.meta || {}),
        lender_name: identity.lender_name || existingProfile?.meta?.lender_name || identity.display_lender,
        loan_name: identity.loan_name || existingProfile?.meta?.loan_name || identity.display_lender,
        reference_last_four: identity.reference_last_four || existingProfile?.meta?.reference_last_four || null,
        remember_profile: split.remember_profile !== false,
        last_confirmed_transaction_id: transaction.id || transaction.transaction_id || null,
      },
    });
    if (existingProfile?.id) {
      const { data, error } = await db
        .from("loan_lender_profiles")
        .update(profilePayload)
        .eq("business_id", businessId)
        .eq("id", existingProfile.id)
        .select("*")
        .maybeSingle();
      if (error) throw error;
      lenderProfile = data || existingProfile;
    } else {
      const { data, error } = await db
        .from("loan_lender_profiles")
        .insert(profilePayload)
        .select("*")
        .maybeSingle();
      if (error) throw error;
      lenderProfile = data;
    }
  }
  const transactionId = transaction.id || transaction.transaction_id || null;
  const learningSkipped = !identity;
  const splitPayload = {
    business_id: businessId,
    transaction_id: transactionId,
    lender_profile_id: lenderProfile?.id || null,
    status: "confirmed",
    principal_amount_minor: Number(split.principal_amount_minor || 0),
    principal_qbo_account_id: split.principal_qbo_account_id || null,
    interest_amount_minor: Number(split.interest_amount_minor || 0),
    interest_qbo_account_id: split.interest_qbo_account_id || null,
    fee_lines: Array.isArray(split.fee_lines) ? split.fee_lines : [],
    currency: resolveBankTransactionCurrency(transaction, split.currency),
    confirmed_by: actorId,
    confirmed_actor_type: actorType,
    confirmed_at: nowIso,
    meta: {
      total_amount_minor: validation.expected_amount_minor,
      match_specificity: identity?.match_specificity || null,
      provider_merchant_id: identity?.provider_merchant_id || null,
      descriptor_fingerprint: identity?.fingerprint || null,
      lender_name: identity?.lender_name || split.lender_name || null,
      loan_name: identity?.loan_name || split.loan_name || null,
      reference_last_four: identity?.reference_last_four || split.reference_last_four || null,
      remember_profile: split.remember_profile !== false,
      lender_learning_skipped: learningSkipped,
      lender_learning_skip_reason: learningSkipped ? "insufficient_transaction_identity" : null,
    },
  };
  const { data: splitRow, error: splitError } = await db
    .from("loan_payment_splits")
    .insert(splitPayload)
    .select("*")
    .maybeSingle();
  if (splitError) throw splitError;
  if (identity) {
    await insertLoanAuditEvent({
      db,
      businessId,
      transactionId,
      lenderProfileId: lenderProfile?.id || null,
      splitId: splitRow?.id || null,
      eventType: existingProfile?.id ? "lender_profile_updated" : "lender_profile_created",
      actorId,
      actorType,
      nextState: { profile: lenderProfile, split: splitRow },
    });
  } else {
    await insertLoanAuditEvent({
      db,
      businessId,
      transactionId,
      lenderProfileId: null,
      splitId: splitRow?.id || null,
      eventType: "lender_profile_learning_skipped",
      actorId,
      actorType,
      nextState: {
        reason: "insufficient_transaction_identity",
        split: splitRow,
      },
      meta: { lender_learning_skipped: true },
    });
  }
  await insertLoanAuditEvent({
    db,
    businessId,
    transactionId,
    lenderProfileId: lenderProfile?.id || null,
    splitId: splitRow?.id || null,
    eventType: "split_confirmed",
    actorId,
    actorType,
    nextState: splitPayload,
  });
  return { lenderProfile, split: splitRow };
}

export async function recordLoanPaymentRegularOverride({
  db,
  businessId,
  transactionId,
  lenderProfileId = null,
  actorId = null,
  actorType = "user",
  reason = "categorized_normally",
} = {}) {
  return insertLoanAuditEvent({
    db,
    businessId,
    transactionId,
    lenderProfileId,
    eventType: "regular_flow_override_selected",
    actorId,
    actorType,
    nextState: { reason },
  });
}

export async function fetchConfirmedLoanPaymentSplit({ db, businessId, transactionId }) {
  if (!db || !businessId || !transactionId) return null;
  const { data, error } = await db
    .from("loan_payment_splits")
    .select("*")
    .eq("business_id", businessId)
    .eq("transaction_id", transactionId)
    .eq("status", "confirmed")
    .order("confirmed_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function markLoanPaymentSplitPosted({
  db,
  businessId,
  transactionId,
  qboTxnId,
  postedAt,
  actorId = null,
  actorType = "system",
} = {}) {
  if (!db || !businessId || !transactionId || !qboTxnId) return null;
  const postedIso = postedAt || new Date().toISOString();
  const { data, error } = await db
    .from("loan_payment_splits")
    .update({
      status: "posted",
      posted_qbo_txn_id: qboTxnId,
      posted_at: postedIso,
      updated_at: postedIso,
    })
    .eq("business_id", businessId)
    .eq("transaction_id", transactionId)
    .eq("status", "confirmed")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  if (data?.id) {
    await insertLoanAuditEvent({
      db,
      businessId,
      transactionId,
      lenderProfileId: data.lender_profile_id || null,
      splitId: data.id,
      eventType: "split_posted",
      actorId,
      actorType,
      nextState: { qbo_txn_id: qboTxnId, posted_at: postedIso },
    });
  }
  return data || null;
}

export function splitRowToExecutableSplit(row = {}) {
  if (!row) return null;
  return {
    principal_amount_minor: Number(row.principal_amount_minor || 0),
    principal_qbo_account_id: row.principal_qbo_account_id || null,
    interest_amount_minor: Number(row.interest_amount_minor || 0),
    interest_qbo_account_id: row.interest_qbo_account_id || null,
    fee_lines: Array.isArray(row.fee_lines) ? row.fee_lines : [],
  };
}
