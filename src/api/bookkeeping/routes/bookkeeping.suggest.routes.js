import { Router } from "express";
import { supabase } from "../../../services/supabaseAdmin.js";
import { requireAuth } from "../../gpt/middlewares/requireAuth.js";
import { getQBOClient } from "../../../utils/qboClient.js";
import { classifyTaxonomy, buildTaxonomyMeta } from "../../../services/bookkeeping/taxonomyClassifier.js";
import { getVendorRuleForTransaction } from "../../../services/bookkeeping/vendorRuleMatcher.js";
import {
  looksLikeTaxonomyLandmineMemo,
  canonicalTxnDirection,
} from "../../../services/bookkeeping/vendorRuleLearner.js";
import { isCheck } from "../../../services/bookkeeping/checkDetector.js";
import { ensureBusinessId } from "./_bookkeepingRouteUtils.js";
import { getUniversalVendorHintForTransaction } from "../../../services/bookkeeping/universalVendorHintMatcher.js";
import { resolveIntentKey } from "../../../services/bookkeeping/intentToCoaMapper.js";
import {
  resolveCanonicalQboAccount,
  validateCanonicalQboAccountForPromotion,
} from "../../../services/bookkeeping/canonicalQboAccountResolver.js";
import { createOrUpdateClarificationRequest } from "../../../services/bookkeeping/clarificationService.js";
import { computeMemoPrefixForLearning } from "../../../services/bookkeeping/vendorRuleLearner.js";
import { applyActiveBookkeepingScope, getBookkeepingStartDate, isTransactionInActiveBookkeepingScope } from "../../../services/bookkeeping/bookkeepingScope.js";
import { computePostAfterForAutoPost, getAutoPostToQuickBooks } from "../../../services/bookkeeping/autoPostControl.js";
import { decideBookkeepingCategorization } from "../../../services/bookkeeping/bookkeepingCategorizationDecisionService.js";
import { resolveCanonicalVendorForTransaction } from "../../../services/bookkeeping/canonicalVendorService.js";
import { reconsiderNeedsReviewTransactions } from "../../../services/bookkeeping/routineExpenseReconsiderationService.js";
import {
  createSafeCreditCardPaymentPairForRow,
  hasCreditCardPaymentSignal,
} from "../../../services/bookkeeping/creditCardPaymentPairService.js";
import { refreshOperatorRequestSummaryBestEffort } from "../../../services/bookkeeping/operatorRequestSummaryService.js";
import { resolveIntentToCanonicalKey } from "../../../services/bookkeeping/canonicalCoaRegistry.js";
import {
  isStrongUniversalVendorEvidence,
  withCategorizationPolicyVersion,
} from "../../../services/bookkeeping/categorizationEvidencePolicy.js";

const router = Router();

const GRACE_HOURS = Number(process.env.BOOKS_POST_GRACE_HOURS || 24);
const VENDOR_RULE_MEMO_PREFIX_PROMOTE_MIN_USES = Number(
  process.env.VENDOR_RULE_MEMO_PREFIX_PROMOTE_MIN_USES || 3
);

const devLog = (tag, payload) => {
  if (process.env.NODE_ENV !== "production") {
    console.info("[bookkeeping][suggest]", tag, payload);
  }
};
const UNIVERSAL_COA_ALLOWLIST = new Set([
  "airfare",
  "transportation",
  "travel",
  "vehicle_expense",
  "fuel",
  "gas_charging",
  "meals",
  "software",
  "advertising",
  "insurance",
  "equipment_rental",
  "subcontractors",
  "permits_fees",
  "business_licensing_fees",
  "waste_disposal",
  "uniforms_laundry",
  "safety_ppe",
  "utilities",
  "internet_services",
  "electric",
  "office_supplies",
  "supplies_materials",
  "supplies",
  "cleaning",
  "parking_tolls",
  "shipping",
  "bank_fees",
  "payment_processing",
  "sales",
]);

function isUniversalIntentAllowlisted(intent = "") {
  return UNIVERSAL_COA_ALLOWLIST.has(resolveIntentKey(intent));
}

const UNIVERSAL_AUTO_APPROVE_ALLOWLIST = new Set([
  "airfare",
  "transportation",
  "travel",
  "vehicle_expense",
  "fuel",
  "gas_charging",
  "meals",
  "software",
  "advertising",
  "insurance",
  "equipment_rental",
  "permits_fees",
  "business_licensing_fees",
  "waste_disposal",
  "uniforms_laundry",
  "safety_ppe",
  "utilities",
  "internet_services",
  "electric",
  "office_supplies",
  "supplies_materials",
  "supplies",
  "cleaning",
  "parking_tolls",
  "shipping",
  "bank_fees",
  "payment_processing",
  "sales",
]);

function isUniversalIntentAutoApproveAllowed(intent = "") {
  return UNIVERSAL_AUTO_APPROVE_ALLOWLIST.has(resolveIntentKey(intent));
}

function intentToStandardAccountName(intent = "") {
  const key = resolveIntentKey(intent);
  const map = {
    airfare: "Airfare",
    transportation: "Transportation",
    vehicle_expense: "Vehicle Expense",
    fuel: "Fuel",
    gas_charging: "Gas/Charging",
    meals: "Meals & Entertainment",
    software: "Software Subscriptions",
    advertising: "Advertising",
    insurance: "Insurance",
    equipment_rental: "Equipment Rental",
    subcontractors: "Subcontractors",
    permits_fees: "Permits & Fees",
    business_licensing_fees: "Business Licensing Fees",
    waste_disposal: "Waste Disposal",
    uniforms_laundry: "Uniforms & Laundry",
    safety_ppe: "Safety & PPE",
    utilities: "Utilities",
    internet_services: "Internet Services",
    electric: "Electric",
    office_supplies: "Office Supplies",
    supplies_materials: "Supplies & Materials",
    cleaning: "Cleaning",
    parking_tolls: "Parking & Tolls",
    shipping: "Shipping",
    bank_fees: "Bank Fees",
    payment_processing: "Payment Processing Fees",
    sales: "Sales",
    travel: "Travel",
    supplies: "Supplies",
    materials: "Supplies & Materials",
    tools: "Tools & Equipment",
  };
  return map[key] || null;
}

function shouldForceCanonicalIntentAccount(intent = "", mappedAccountName = "") {
  const key = resolveIntentKey(intent);
  if (!["transportation", "airfare"].includes(key)) return false;
  const canonical = normalizeName(intentToStandardAccountName(key) || "");
  const mapped = normalizeName(mappedAccountName || "");
  return Boolean(canonical) && canonical !== mapped;
}

function applyAutoApproval({
  status,
  confidence,
  meta = {},
  checkHit = {},
  suggestedAcct = {},
  taxonomyType = null,
  nowIso,
  reason,
  autoApprove = false,
  autoPostEnabled = false,
  txnId = null,
  transaction = {},
  businessContext = {},
  evidence = {},
}) {
  const decision = decideBookkeepingCategorization({
    transaction: transaction || {},
    account: {
      id: suggestedAcct?.id || evidence.accountId || null,
      name: suggestedAcct?.name || evidence.accountName || null,
      type: suggestedAcct?.type || evidence.accountType || null,
      subType: suggestedAcct?.subType || evidence.accountSubType || null,
    },
    evidence: {
      source: evidence.source || meta.suggestion_source || reason || "unknown",
      confidenceTier: evidence.confidenceTier || confidence,
      taxonomyType,
      isCheck: checkHit?.is_check === true,
      meta,
      reason,
      ...evidence,
      safeToAutoHandle: evidence.safeToAutoHandle === true || meta.safe_to_auto_handle === true,
      verifiedCcPayment: evidence.verifiedCcPayment === true,
      allowTaxonomyAutoHandle: evidence.allowTaxonomyAutoHandle === true,
      weakRule: evidence.weakRule === true,
    },
    businessContext: businessContext || {},
  });
  const decisionMeta = {
    ...meta,
    safe_to_auto_handle: decision.eligible === true,
    auto_handle_decision: {
      eligible: decision.eligible === true,
      confidence: decision.confidence_tier || decision.confidence,
      source: decision.evidence_source || decision.source,
      reason: decision.block_reason || decision.reason,
      at: nowIso,
    },
  };
  if (autoApprove === true && decision.auto_handle === true && suggestedAcct?.id && suggestedAcct?.name) {
    const finalAcctId = suggestedAcct?.id || null;
    const finalAcctName = suggestedAcct?.name || null;
    const postAfter = computePostAfterForAutoPost(autoPostEnabled, GRACE_HOURS);
    const decidedBy = "bizzi";
    const decidedAt = nowIso;
    const nextMeta = {
      ...decisionMeta,
      auto_approve_reason: decisionMeta.auto_approve_reason || reason || decision.reason || "auto_handle_policy",
      auto_handled_reason: decision.reason,
    };
    devLog("auto_approved", {
      txnId,
      reason: nextMeta.auto_approve_reason,
      post_after: postAfter,
      auto_post_to_quickbooks: autoPostEnabled === true,
    });
    return {
      status: "auto_approved",
      meta: nextMeta,
      finalAcctId,
      finalAcctName,
      postAfter,
      decidedBy,
      decidedAt,
    };
  }
  return { status, meta: decisionMeta, finalAcctId: undefined, finalAcctName: undefined, postAfter: undefined, decidedBy: undefined, decidedAt: undefined };
}

function firstDayOfMonth() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

function computeRangeStart(range) {
  const now = new Date();
  switch (range) {
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

function normalizeDate(d) {
  if (!d) return null;
  const parsed = new Date(d);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function normalizeName(name = "") {
  return (name || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeVendorCandidate(s = "") {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsWordBoundary(haystack = "", needle = "") {
  const h = normalizeVendorCandidate(haystack);
  const n = normalizeVendorCandidate(needle);
  if (!h || !n) return false;
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${escaped}\\b`, "i");
  return re.test(h);
}

function isUniversalHintAutoApproveSafe(universalHint = {}) {
  const mt = String(universalHint?.match_type || "").toLowerCase();
  const matchedValue = universalHint?.matched_value || "";
  const canonical = universalHint?.canonical_vendor || "";
  if (mt === "exact" || mt === "startswith") return true;
  if (mt !== "contains") return false;
  const candidate = normalizeVendorCandidate(matchedValue);
  const canon = normalizeVendorCandidate(canonical);
  if (!candidate || !canon) return false;
  if (candidate.startsWith(canon)) return true;
  if (containsWordBoundary(candidate, canon)) return true;
  return false;
}

async function autoLearnVendorRuleFromAutoApproval({
  businessId,
  bankTxn,
  finalAccountId,
  finalAccountName,
  taxonomyType,
  learnedFrom = "universal_hint",
}) {
  try {
    const { learnVendorRuleFromTransaction } = await import("../../../services/bookkeeping/vendorRuleLearner.js");
    return await learnVendorRuleFromTransaction({
      businessId,
      bankTxn,
      finalAccountId,
      finalAccountName,
      taxonomyType,
      options: {
        allowQboEntityFallback: true,
        learnedFrom,
      },
    });
  } catch (e) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[bookkeeping][suggest] auto-learn vendor rule skipped", e?.message || e);
    }
    return { ok: true, skipped: true, reason: "auto_learn_exception" };
  }
}

function findCoaNameById(coa = [], id) {
  const target = String(id || "");
  if (!target) return null;
  const hit = (coa || []).find((a) => String(a.id || a.Id) === target);
  return hit?.name || hit?.Name || null;
}

function findCoaAccountById(coa = [], id) {
  const target = String(id || "");
  if (!target) return null;
  return (coa || []).find((a) => String(a.id || a.Id) === target) || null;
}

function ensureAccountName({ acctId, acctName, coa }) {
  if (!acctId) return { id: null, name: "", type: null, subType: null };
  const coaAccount = findCoaAccountById(coa, acctId);
  const trimmed = String(acctName || "").trim();
  if (trimmed.length > 1) {
    return {
      id: acctId,
      name: trimmed,
      type: coaAccount?.type || coaAccount?.AccountType || null,
      subType: coaAccount?.subType || coaAccount?.AccountSubType || null,
    };
  }
  const resolved = coaAccount?.name || coaAccount?.Name || findCoaNameById(coa, acctId);
  return {
    id: acctId,
    name: resolved || "",
    type: coaAccount?.type || coaAccount?.AccountType || null,
    subType: coaAccount?.subType || coaAccount?.AccountSubType || null,
  };
}

function isUnresolvedAccountName(name = "") {
  const normalized = normalizeName(name || "");
  return !normalized || normalized === "selected account" || normalized === "select account" || normalized === "account";
}

function isSuspenseAccount({ acctId, acctName, suspenseIds }) {
  if (!acctId) return true;
  if (isUnresolvedAccountName(acctName)) return true;
  const name = String(acctName || "");
  return (
    suspenseIds.has(String(acctId)) ||
    /ask my accountant/i.test(name) ||
    /uncategorized/i.test(name)
  );
}

function shouldReevaluateExistingSuggestion({
  existingCat,
  suggestedId,
  suggestedName,
  suggestedSuspense,
  suggestionSource,
  allowProtectedReevaluation = false,
}) {
  if (!existingCat) return false;

  const statusLower = String(existingCat.status || "").toLowerCase();
  if (["approved", "auto_approved", "posted"].includes(statusLower) && !allowProtectedReevaluation) return false;

  if ((existingCat.final_qbo_account_id || existingCat.final_qbo_account_name) && !allowProtectedReevaluation) return false;
  if (existingCat?.meta?.auto_approve_reason === "manual_user") return false;

  const source = String(suggestionSource || "").toLowerCase();
  const confidence = String(existingCat.confidence || "").toLowerCase();
  const weakSource = source === "fallback" || source === "plaid_mapping" || source === "unknown" || !source;
  const weakConfidence = confidence === "low" || confidence === "medium" || !confidence;
  const unresolvedName = isUnresolvedAccountName(suggestedName);
  const systemOwnedUniversal =
    source === "universal_hint" &&
    (existingCat.decided_by === "universal_hint" || existingCat.decided_by === "bizzi");

  return (
    !suggestedId ||
    unresolvedName ||
    suggestedSuspense ||
    (weakSource && weakConfidence) ||
    systemOwnedUniversal
  );
}

function buildApprovalIdentity(txn = {}) {
  const merchantEntityId = txn?.merchant_entity_id ? String(txn.merchant_entity_id) : null;
  const vendorCandidates = [
    txn?.counterparty_name,
    txn?.merchant_name,
  ]
    .map((value) => normalizeVendorCandidate(value))
    .filter(Boolean);
  const { prefix } = computeMemoPrefixForLearning(txn, 20);
  return {
    merchantEntityId,
    vendorCandidates: [...new Set(vendorCandidates)],
    memoPrefix: prefix || "",
  };
}

function buildUserApprovalContext(approvedCats = [], bankTxnMap = {}) {
  const context = {
    hasAnyUserApprovals: false,
    byMerchantEntityId: new Map(),
    byVendorCandidate: new Map(),
    byMemoPrefix: new Map(),
  };

  for (const cat of approvedCats || []) {
    const txn = bankTxnMap?.[cat.transaction_id];
    if (!txn) continue;
    context.hasAnyUserApprovals = true;
    const identity = buildApprovalIdentity(txn);
    const entry = {
      transaction_id: cat.transaction_id,
      final_qbo_account_id: cat.final_qbo_account_id || null,
      final_qbo_account_name: cat.final_qbo_account_name || null,
      decided_by: cat.decided_by || null,
      status: cat.status || null,
    };

    if (identity.merchantEntityId && !context.byMerchantEntityId.has(identity.merchantEntityId)) {
      context.byMerchantEntityId.set(identity.merchantEntityId, entry);
    }
    for (const candidate of identity.vendorCandidates) {
      if (!context.byVendorCandidate.has(candidate)) {
        context.byVendorCandidate.set(candidate, entry);
      }
    }
    if (identity.memoPrefix && identity.memoPrefix.length >= 8 && !context.byMemoPrefix.has(identity.memoPrefix)) {
      context.byMemoPrefix.set(identity.memoPrefix, entry);
    }
  }

  return context;
}

async function resolveCanonicalVendorEvidenceForPromotion({ businessId, row, taxonomyMeta = {} }) {
  const providerStrong = Boolean(row?.merchant_entity_id);
  const qboVendorStrong = Boolean(row?.qbo_entity_id && String(row?.qbo_entity_type || "").toLowerCase() === "vendor");
  const providerNamed = Boolean(row?.merchant_name || row?.counterparty_name);
  if (row?.canonical_vendor_id) {
    return {
      canonicalVendorId: row.canonical_vendor_id,
      canonicalVendorReliable: providerStrong || qboVendorStrong || providerNamed,
      merchantEvidenceStrong: providerStrong || qboVendorStrong,
      canonicalVendorResolutionReason: "transaction_canonical_vendor",
    };
  }
  if (!providerStrong && !qboVendorStrong && !providerNamed) {
    return {
      canonicalVendorId: null,
      canonicalVendorReliable: false,
      merchantEvidenceStrong: false,
      canonicalVendorResolutionReason: "no_provider_vendor_signal",
    };
  }
  try {
    const resolved = await resolveCanonicalVendorForTransaction({
      db: supabase,
      businessId,
      bankTxn: row,
      taxonomyMeta,
    });
    const canonicalVendorId = resolved?.canonicalVendor?.id || resolved?.canonical_vendor_id || null;
    const weak = resolved?.reason === "weak_memo_evidence" || resolved?.needsReview === true || resolved?.skipped === true;
    return {
      canonicalVendorId,
      canonicalVendorReliable: Boolean(canonicalVendorId) && !weak && (providerStrong || qboVendorStrong || providerNamed),
      merchantEvidenceStrong: providerStrong || qboVendorStrong,
      weakVendorEvidence: weak,
      canonicalVendorResolutionReason: resolved?.reason || null,
    };
  } catch (err) {
    devLog("canonical_vendor_promotion_evidence_failed", {
      business_id: businessId,
      txn_id: row?.id || null,
      error: err?.message || String(err),
    });
    return {
      canonicalVendorId: null,
      canonicalVendorReliable: false,
      merchantEvidenceStrong: false,
      weakVendorEvidence: true,
      canonicalVendorResolutionReason: "canonical_vendor_resolution_failed",
    };
  }
}

function findSimilarUserApproval(context, txn = {}) {
  if (!context?.hasAnyUserApprovals) return null;
  const identity = buildApprovalIdentity(txn);

  if (identity.merchantEntityId && context.byMerchantEntityId.has(identity.merchantEntityId)) {
    return {
      ...context.byMerchantEntityId.get(identity.merchantEntityId),
      match_type: "merchant_entity_id",
      match_value: identity.merchantEntityId,
    };
  }

  for (const candidate of identity.vendorCandidates) {
    if (context.byVendorCandidate.has(candidate)) {
      return {
        ...context.byVendorCandidate.get(candidate),
        match_type: "vendor_candidate",
        match_value: candidate,
      };
    }
  }

  if (identity.memoPrefix && identity.memoPrefix.length >= 8 && context.byMemoPrefix.has(identity.memoPrefix)) {
    return {
      ...context.byMemoPrefix.get(identity.memoPrefix),
      match_type: "memo_prefix",
      match_value: identity.memoPrefix,
    };
  }

  return null;
}

function hasUserApprovedVendorRuleMatch({ vendorRule, similarUserApproval }) {
  if (!vendorRule || !similarUserApproval) return false;
  const vendorRuleAccountId = String(vendorRule.default_qbo_account_id || "");
  const approvalAccountId = String(similarUserApproval.final_qbo_account_id || "");
  if (!vendorRuleAccountId || !approvalAccountId) return false;
  return vendorRuleAccountId === approvalAccountId;
}

/* ----------------------- Chart of Accounts (QBO) ----------------------- */
async function fetchChartOfAccounts(businessId, opts = {}) {
  const includeSubaccounts = opts?.includeSubaccounts === true;
  const qbo = await getQBOClient(businessId);
  if (!qbo) return [];
  try {
    const res = await new Promise((resolve, reject) => {
      qbo.findAccounts({ Active: true }, (err, data) => {
        if (err) return reject(err);
        return resolve(data);
      });
    });
    const accounts = Array.isArray(res?.QueryResponse?.Account)
      ? res.QueryResponse.Account
      : [];
    return accounts
      .filter((a) => (includeSubaccounts || !a.SubAccount) && a.AccountType && !/header/i.test(a.Classification || ""))
      .map((a) => ({
        id: a.Id,
        name: a.Name,
        type: a.AccountType,
        subType: a.AccountSubType || null,
      }));
  } catch (e) {
    console.warn("[bookkeeping] fetch COA failed", e?.message || e);
    return [];
  }
}

function findCoaByNames(coaMap, names = []) {
  for (const n of names || []) {
    const key = normalizeName(n);
    if (coaMap[key]) return coaMap[key];
  }
  return null;
}

async function ensureSuspenseAccounts(businessId) {
  const coa = await fetchChartOfAccounts(businessId, { includeSubaccounts: true });
  const coaMap = (coa || []).reduce((acc, c) => {
    acc[normalizeName(c.name)] = c;
    return acc;
  }, {});

  const ama = findCoaByNames(coaMap, ["Ask My Accountant"]);
  let expenseFallback = findCoaByNames(coaMap, ["Uncategorized Expense"]);
  let incomeFallback = findCoaByNames(coaMap, ["Uncategorized Income"]);

  return {
    expenseFallback: expenseFallback ? { id: expenseFallback.id || expenseFallback.Id || null, name: expenseFallback.name || expenseFallback.Name || "Uncategorized Expense" } : null,
    incomeFallback: incomeFallback ? { id: incomeFallback.id || incomeFallback.Id || null, name: incomeFallback.name || incomeFallback.Name || "Uncategorized Income" } : null,
    ama: ama ? { id: ama.id || null, name: ama.name || null } : null,
  };
}

function findOwnerEquityAccounts(coaMap) {
  const drawNames = ["owner draw", "owner draws", "owner distribution", "owner distributions"];
  const contribNames = ["owner contribution", "owner contributions", "capital contribution", "capital contributions"];
  const findByNames = (names = []) => {
    for (const n of names) {
      const key = normalizeName(n);
      if (coaMap[key]) return coaMap[key];
    }
    return null;
  };
  return {
    drawAcct: findByNames(drawNames),
    contribAcct: findByNames(contribNames),
  };
}

async function ensureOwnerEquityAccounts(businessId, existingCoa = null) {
  const coa = existingCoa || (await fetchChartOfAccounts(businessId, { includeSubaccounts: true }));
  const coaMap = (coa || []).reduce((acc, c) => {
    acc[normalizeName(c.name)] = c;
    return acc;
  }, {});
  let { drawAcct, contribAcct } = findOwnerEquityAccounts(coaMap);

  return {
    drawAcct: drawAcct ? { id: drawAcct.id || drawAcct.Id || null, name: drawAcct.name || drawAcct.Name || null } : null,
    contribAcct: contribAcct ? { id: contribAcct.id || contribAcct.Id || null, name: contribAcct.name || contribAcct.Name || null } : null,
  };
}

function findTransferAccount(coaMap = {}) {
  const candidates = [
    "Transfers",
    "Transfer",
    "Intercompany Transfers",
    "Due To/From",
    "Due To",
    "Due From",
    "Owner Investment",
  ];
  for (const name of candidates) {
    const n = normalizeName(name);
    if (coaMap[n]) return coaMap[n];
  }
  return null;
}

function buildOwnerTokens(profile = {}) {
  const tokens = new Set();
  const fn = normalizeName(profile.first_name || "");
  const ln = normalizeName(profile.last_name || "");
  const full = normalizeName(profile.full_name || "");
  if (full) tokens.add(full);
  if (ln && ln.length >= 4) tokens.add(ln);
  if ((!ln || ln.length < 4) && fn && fn.length >= 5) tokens.add(fn);
  return Array.from(tokens).filter(Boolean);
}

function findQboCreditCardAccounts(coa = []) {
  return (coa || []).filter((acct) => {
    const t = (acct.type || "").toLowerCase();
    const name = (acct.name || "").toLowerCase();
    const looksCcType = t.includes("credit") && t.includes("card");
    const looksLiabilityCard = t.includes("liability") && (name.includes("card") || name.includes("visa") || name.includes("mastercard") || name.includes("amex"));
    return looksCcType || looksLiabilityCard;
  });
}

function findQboBankAccounts(coa = []) {
  return (coa || []).filter((acct) => {
    const t = (acct.type || "").toLowerCase();
    return t === "bank";
  });
}

async function fetchPlaidAccount(businessId, plaidAccountId) {
  if (!plaidAccountId) return null;
  const { data, error } = await supabase
    .from("plaid_accounts")
    .select("plaid_account_id,name,official_name,mask,type,subtype")
    .eq("business_id", businessId)
    .eq("plaid_account_id", plaidAccountId)
    .maybeSingle();
  if (error) return null;
  return data || null;
}

function plaidAccountLooksCredit(acct = {}) {
  const type = normalizeName(acct.type || "");
  const subtype = normalizeName(acct.subtype || "");
  const name = normalizeName(`${acct.name || ""} ${acct.official_name || ""}`);
  return (
    type.includes("credit") ||
    subtype.includes("credit") ||
    subtype.includes("credit card") ||
    /\b(?:amex|american express|discover|visa|mastercard|master card|credit card|chase card)\b/.test(name)
  );
}

function hasCreditCardPaymentMemoSignal(row = {}) {
  return hasCreditCardPaymentSignal(row);
}

async function findCreditCardPaymentPairTxnId(businessId, row, { bookkeepingStartDate = null, allowHistoricalContext = false } = {}) {
  const amount = Number(row.amount || 0);
  if (!Number.isFinite(amount) || amount === 0) return null;
  if (!row.plaid_account_id) return null;
  if (!hasCreditCardPaymentMemoSignal(row)) return null;
  const baseDate = row.date ? new Date(row.date) : null;
  if (!baseDate || Number.isNaN(baseDate.getTime())) return null;
  const EPS = 0.01;
  const targetAmount = -amount;
  const start = new Date(baseDate);
  start.setDate(start.getDate() - 3);
  const end = new Date(baseDate);
  end.setDate(end.getDate() + 3);

  const { data, error } = await supabase
    .from("bank_transactions")
    .select("id,plaid_account_id,amount,date,name,merchant_name,counterparty_name")
    .eq("business_id", businessId)
    .eq("is_archived", false)
    .neq("plaid_account_id", row.plaid_account_id)
    .gte("amount", targetAmount - EPS)
    .lte("amount", targetAmount + EPS)
    .gte("date", start.toISOString().slice(0, 10))
    .lte("date", end.toISOString().slice(0, 10))
    .limit(10);
  if (error || !data?.length) return null;

  const accountIds = [...new Set(data.map((candidate) => candidate.plaid_account_id).filter(Boolean))];
  if (!accountIds.length) return null;
  const { data: acctRows, error: acctErr } = await supabase
    .from("plaid_accounts")
    .select("plaid_account_id,name,official_name,type,subtype")
    .eq("business_id", businessId)
    .in("plaid_account_id", accountIds);
  if (acctErr) return null;
  const acctById = new Map((acctRows || []).map((acct) => [String(acct.plaid_account_id), acct]));

  const scored = (data || [])
    .map((candidate) => {
      const acct = acctById.get(String(candidate.plaid_account_id));
      const creditAcct = plaidAccountLooksCredit(acct);
      const candidateMemoSignal = hasCreditCardPaymentMemoSignal(candidate) || /mobile payment|thank you|payment/.test(normalizeName(candidate.name || ""));
      const dateDiff = Math.abs((new Date(row.date) - new Date(candidate.date)) / (1000 * 60 * 60 * 24));
      return { candidate, creditAcct, candidateMemoSignal, dateDiff };
    })
    .filter((entry) => entry.creditAcct && (entry.candidateMemoSignal || hasCreditCardPaymentMemoSignal(row)))
    .sort((a, b) => a.dateDiff - b.dateDiff);

  const hit = scored[0]?.candidate || null;
  if (!hit) return null;
  const inActiveScope = isTransactionInActiveBookkeepingScope(hit, bookkeepingStartDate);
  if (!inActiveScope && !allowHistoricalContext) return null;
  return {
    txnId: hit.id,
    pairedPlaidAccountId: hit.plaid_account_id,
    historicalContextOnly: !inActiveScope,
  };
}

function matchQboAccountByMaskOrName(qboAccounts = [], plaidAcct = {}) {
  if (!Array.isArray(qboAccounts) || !qboAccounts.length || !plaidAcct) return { account: null, confidence: "low", notes: "no_accounts" };
  const mask = plaidAcct.mask ? String(plaidAcct.mask) : "";
  const normName = normalizeName(plaidAcct.name || plaidAcct.official_name || "");
  const tokens = (str) => normalizeName(str).split(" ").filter(Boolean);
  if (mask) {
    const hit = qboAccounts.find((a) => normalizeName(a.name || "").includes(mask));
    if (hit) return { account: hit, confidence: "high", notes: "mask_match" };
  }
  if (normName) {
    const plaidTokens = tokens(normName);
    for (const acct of qboAccounts) {
      const acctTokens = tokens(acct.name || "");
      const inter = acctTokens.filter((t) => plaidTokens.includes(t));
      const maxLen = Math.max(plaidTokens.length, acctTokens.length, 1);
      const score = inter.length / maxLen;
      if (score >= 0.85) return { account: acct, confidence: "high", notes: "name_token_high" };
      if (score >= 0.66) return { account: acct, confidence: "medium", notes: "name_token_medium" };
    }
  }
  return { account: null, confidence: "low", notes: "no_match" };
}

async function resolveCcPaymentMapping({ businessId, txnRow, coa, coaMap }) {
  const bankAccounts = findQboBankAccounts(coa);
  const ccAccounts = findQboCreditCardAccounts(coa);
  const plaidAcct = await fetchPlaidAccount(businessId, txnRow.plaid_account_id);
  const bankMatch = matchQboAccountByMaskOrName(bankAccounts, plaidAcct);

  let ccMatch = { account: null, confidence: "low", notes: "no_cc_match" };
  const memo = [txnRow.name, txnRow.merchant_name, txnRow.counterparty_name].filter(Boolean).join(" ").toLowerCase();
  const last4 = (memo.match(/\b(\d{4})\b/) || [])[1] || null;
  if (last4) {
    const hit = ccAccounts.find((a) => (a.name || "").includes(last4));
    if (hit) ccMatch = { account: hit, confidence: "high", notes: "cc_last4_match" };
  }
  if (!ccMatch.account && ccAccounts.length === 1) {
    ccMatch = { account: ccAccounts[0], confidence: "medium", notes: "single_cc_account" };
  }

  const high = bankMatch.confidence === "high" && ccMatch.confidence === "high";
  const medium =
    (bankMatch.confidence === "high" && ccMatch.confidence === "medium") ||
    (bankMatch.confidence === "medium" && ccMatch.confidence === "high");

  return {
    bankAccountRef: bankMatch.account
      ? {
          id: bankMatch.account.id || bankMatch.account.Id,
          name: bankMatch.account.name || bankMatch.account.Name,
        }
      : null,
    creditCardAccountRef: ccMatch.account
      ? {
          id: ccMatch.account.id || ccMatch.account.Id,
          name: ccMatch.account.name || ccMatch.account.Name,
        }
      : null,
    confidence: high ? "high" : medium ? "medium" : "low",
    notes: `${bankMatch.notes || "bank?"}/${ccMatch.notes || "cc?"}`,
  };
}

function enforceCheckNeverAutoApprove(meta = {}) {
  return { ...meta, safe_to_auto_handle: false, safe_to_auto_post: false, auto_approve_reason: null };
}

async function findTransferPairTxnId(businessId, row, { bookkeepingStartDate = null, allowHistoricalContext = false } = {}) {
  const amount = Number(row.amount || 0);
  if (!Number.isFinite(amount) || amount === 0) return null;
  const targetAmount = -amount;
  if (!row.plaid_account_id) return null;
  const EPS = 0.01;
  const baseDate = row.date ? new Date(row.date) : null;
  if (!baseDate || Number.isNaN(baseDate.getTime())) return null;
  const start = new Date(baseDate);
  start.setDate(start.getDate() - 2);
  const end = new Date(baseDate);
  end.setDate(end.getDate() + 2);
  const startIso = start.toISOString().slice(0, 10);
  const endIso = end.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("bank_transactions")
    .select("id,plaid_account_id,amount,date,name,merchant_name,counterparty_name,category_primary,personal_finance_category")
    .eq("business_id", businessId)
    .eq("is_archived", false)
    .neq("plaid_account_id", row.plaid_account_id)
    .gte("amount", targetAmount - EPS)
    .lte("amount", targetAmount + EPS)
    .gte("date", startIso)
    .lte("date", endIso)
    .limit(5);
  if (error) return null;

  const tokens = ["transfer", "xfer", "online transfer", "bank transfer", "ach transfer", "internal transfer"];
  const matchesToken = (memo = "") => {
    const m = memo.toLowerCase();
    return tokens.some((t) => m.includes(t));
  };

  for (const candidate of data || []) {
    const pfc = candidate.personal_finance_category?.primary?.toUpperCase?.() || "";
    const catPrimary = (candidate.category_primary || "").toUpperCase();
    const memo = [candidate.name, candidate.merchant_name, candidate.counterparty_name].filter(Boolean).join(" ").toLowerCase();
    if (pfc.startsWith("TRANSFER") || catPrimary.startsWith("TRANSFER") || matchesToken(memo)) {
      const inActiveScope = isTransactionInActiveBookkeepingScope(candidate, bookkeepingStartDate);
      if (!inActiveScope && !allowHistoricalContext) return null;
      return {
        txnId: candidate.id,
        historicalContextOnly: !inActiveScope,
      };
    }
  }
  return null;
}

async function findRefundOriginalTxn({ businessId, refundTxn, bookkeepingStartDate = null, allowHistoricalContext = false }) {
  const amt = Number(refundTxn.amount || 0);
  if (!Number.isFinite(amt) || amt === 0) return null;
  const targetAmount = -amt;
  const EPS = 0.01;
  const baseDate = refundTxn.date ? new Date(refundTxn.date) : null;
  if (!baseDate || Number.isNaN(baseDate.getTime())) return null;
  const start = new Date(baseDate);
  start.setDate(start.getDate() - 90);
  const startIso = start.toISOString().slice(0, 10);
  const counterparty = refundTxn.counterparty_name || null;
  const merchant = refundTxn.merchant_name || null;
  const refundDirRaw = refundTxn.direction || (amt > 0 ? "INFLOW" : amt < 0 ? "OUTFLOW" : "UNKNOWN");
  const refundDir = typeof refundDirRaw === "string" ? refundDirRaw.toUpperCase() : "UNKNOWN";
  const { data, error } = await supabase
    .from("bank_transactions")
    .select("id,plaid_account_id,amount,direction,date,name,merchant_name,counterparty_name")
    .eq("business_id", businessId)
    .eq("is_archived", false)
    .gte("date", startIso)
    .lte("date", refundTxn.date)
    .lte("amount", targetAmount + EPS)
    .gte("amount", targetAmount - EPS);
  if (error) return null;

  const normalize = (s = "") => (s || "").toLowerCase().trim();
  const matchByCounterparty = (row) => counterparty && normalize(row.counterparty_name) === normalize(counterparty);
  const matchByMerchant = (row) => {
    if (!merchant) return false;
    const m = normalize(merchant);
    const candidate = normalize(row.merchant_name || row.name || "");
    return candidate.includes(m) || m.includes(candidate);
  };
  const oppositeDirection = (row) => {
    const rowAmt = Number(row.amount || 0);
    const rowDirRaw = row.direction || (rowAmt > 0 ? "INFLOW" : rowAmt < 0 ? "OUTFLOW" : "UNKNOWN");
    const rowDir = typeof rowDirRaw === "string" ? rowDirRaw.toUpperCase() : "UNKNOWN";
    if (refundDir === "INFLOW") return rowDir === "OUTFLOW" || rowAmt < 0;
    if (refundDir === "OUTFLOW") return rowDir === "INFLOW" || rowAmt > 0;
    return false;
  };

  const scored = (data || [])
    .filter(oppositeDirection)
    .map((row) => {
      const scoreCp = matchByCounterparty(row) ? 2 : 0;
      const scoreMerch = matchByMerchant(row) ? 1 : 0;
      const dateDiff = Math.abs((new Date(refundTxn.date) - new Date(row.date)) / (1000 * 60 * 60 * 24));
      return { row, score: scoreCp + scoreMerch, dateDiff };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.dateDiff - b.dateDiff;
    });

  const candidate = scored[0]?.row || null;
  if (!candidate) return null;
  const inActiveScope = isTransactionInActiveBookkeepingScope(candidate, bookkeepingStartDate);
  if (!inActiveScope && !allowHistoricalContext) return null;

  const { data: catRow } = await supabase
    .from("transaction_categorizations")
    .select("transaction_id,final_qbo_account_id,final_qbo_account_name,suggested_qbo_account_id,suggested_qbo_account_name")
    .eq("business_id", businessId)
    .eq("transaction_id", candidate.id)
    .maybeSingle();
  if (!catRow) return null;

  const accountId = catRow.final_qbo_account_id || catRow.suggested_qbo_account_id || null;
  const accountName = catRow.final_qbo_account_name || catRow.suggested_qbo_account_name || null;
  if (!accountId) return null;
  return {
    txnId: candidate.id,
    accountId,
    accountName,
    historicalContextOnly: !inActiveScope,
  };
}

export async function runBookkeepingSuggestionPass({
  businessId,
  body = {},
  query = {},
  user = null,
} = {}) {
  if (!businessId) throw new Error("missing_business_id");

  const txnIds = Array.isArray(body.transaction_ids) ? body.transaction_ids : null;
  const rangeParam = (body.range || query?.range || "this_month").toLowerCase();
  const accountId = body.account_id || query?.account_id || null;
  const autoApprove =
    process.env.DISABLE_AUTO_APPROVE === "true"
      ? false
      : body.auto_approve !== false;
  const allowQboAccountCreate =
    body.allow_qbo_account_create !== false &&
    body.allowQboAccountCreate !== false;
  const allowAiCategorization =
    body.allow_ai_categorization === true ||
    body.allowAiCategorization === true;
  // Any future paid model fallback in this pass must require this flag.
  const executionPolicy = {
    allow_ai_categorization: allowAiCategorization,
  };

  const rangeStart = txnIds ? null : computeRangeStart(rangeParam);

  function pickCoaMatch(coaMap, candidates = []) {
    for (const cand of candidates) {
      const norm = normalizeName(cand);
      if (coaMap[norm]) return coaMap[norm];
    }
    return null;
  }

  function mapPlaidToCoa(row, coaMap, fallback = {}) {
    const dirRaw = row.direction || row.Direction || null;
    const direction = typeof dirRaw === "string" ? dirRaw.toUpperCase() : dirRaw;
    const isOutflow = direction === "OUTFLOW" || (!direction && Number(row.amount || 0) < 0);
    const isInflow = direction === "INFLOW" || (!direction && Number(row.amount || 0) > 0);
    const primary = (row.category_primary || "").toUpperCase();
    const detailed = (row.category_detailed || "").toUpperCase();
    const pfcPrimary = row.personal_finance_category?.primary?.toUpperCase() || "";
    const pfcDetailed = row.personal_finance_category?.detailed?.toUpperCase() || "";
    const name = row.name || row.merchant_name || "";
    const upperName = name.toUpperCase();

    const candidateLists = [];

    if (primary === "TRAVEL" || pfcPrimary === "TRAVEL") {
      candidateLists.push(["Travel", "Travel Meals", "Transportation"]);
    }
    if (primary === "FOOD_AND_DRINK" || pfcPrimary === "FOOD_AND_DRINK") {
      candidateLists.push(["Meals & Entertainment", "Meals", "Dining", "Restaurants"]);
    }
    if (primary === "TRANSPORTATION" || pfcPrimary === "TRANSPORTATION") {
      candidateLists.push(["Vehicle", "Auto", "Travel", "Fuel"]);
    }
    if (primary === "BANK_FEES" || upperName.includes("FEE")) {
      candidateLists.push(["Bank Charges", "Bank Fees"]);
    }
    if (primary === "LOAN_PAYMENTS") {
      candidateLists.push(["Loan Interest", "Interest Expense"]);
    }
    if (primary === "TRANSFER_OUT" || primary === "TRANSFER_IN" || pfcPrimary === "TRANSFER_OUT" || pfcPrimary === "TRANSFER_IN") {
      candidateLists.push(["Transfers", "Owner Draws", "Owner Distributions"]);
    }
    if (!candidateLists.length && detailed) {
      candidateLists.push([detailed.replace(/_/g, " ").toLowerCase()]);
    }
    const flatCandidates = candidateLists.flat().filter(Boolean);
    const match = pickCoaMatch(coaMap, flatCandidates);
    if (match) {
      return {
        account: match,
        confidence: "medium",
        reason: `Plaid category ${(primary || pfcPrimary || "unknown")} mapped to COA '${match.name}'.`,
        direction: direction || (isOutflow ? "OUTFLOW" : isInflow ? "INFLOW" : "UNKNOWN"),
      };
    }

    // Safe fallback
    let fb = null;
    if (isOutflow) {
      fb = fallback.expenseFallback || fallback.ama || null;
    } else if (isInflow) {
      fb = fallback.incomeFallback || fallback.ama || null;
    } else {
      fb = fallback.ama || null;
    }
    if (fb) {
      return {
        account: fb,
        confidence: "low",
        reason: `Fallback to ${fb.name || "safe account"} (${isOutflow ? "outflow" : isInflow ? "inflow" : "unknown"})`,
        direction: direction || (isOutflow ? "OUTFLOW" : isInflow ? "INFLOW" : "UNKNOWN"),
      };
    }
    return {
      account: null,
      confidence: "low",
      reason: "No safe fallback account available; needs review.",
      direction: direction || (isOutflow ? "OUTFLOW" : isInflow ? "INFLOW" : "UNKNOWN"),
    };
  }

  function pickSafeFallbackForTxn(row, fb = {}) {
    const dirRaw = row.direction || row.Direction || null;
    const direction = typeof dirRaw === "string" ? dirRaw.toUpperCase() : dirRaw;
    const amt = Number(row.amount || 0);
    const isOutflow = direction === "OUTFLOW" || (!direction && amt < 0);
    const isInflow = direction === "INFLOW" || (!direction && amt > 0);
    if (isOutflow) return fb.expenseFallback || fb.ama || null;
    if (isInflow) return fb.incomeFallback || fb.ama || null;
    return fb.ama || null;
  }

  try {
    const bookkeepingStartDate = await getBookkeepingStartDate(supabase, businessId);
    const autoPostEnabled = await getAutoPostToQuickBooks(supabase, businessId);
    // Fetch COA
    const coa = await fetchChartOfAccounts(businessId, { includeSubaccounts: true });
    const coaMap = (coa || []).reduce((acc, c) => {
      acc[normalizeName(c.name)] = c;
      return acc;
    }, {});
    const fallbacks = await ensureSuspenseAccounts(businessId);
    const ownerEquityAccounts = await ensureOwnerEquityAccounts(businessId, coa);
    const userId = user?.id || user?.user_id || null;
    let ownerTokens = [];
    if (userId) {
      try {
        const { data: userProfile } = await supabase
          .from("user_profiles")
          .select("first_name,last_name,full_name")
          .eq("id", userId)
          .maybeSingle();
        ownerTokens = buildOwnerTokens(userProfile || {});
      } catch (userProfileErr) {
        devLog("owner_profile_lookup_skipped", {
          user_id: userId,
          error: userProfileErr?.message || String(userProfileErr),
        });
      }
    }
    const taxonomyContext = { ownerTokens };

    // Step A: base transactions to consider
    let txQuery = supabase
      .from("bank_transactions")
      .select("id,plaid_account_id,plaid_transaction_id,date,name,merchant_name,merchant_entity_id,counterparty_name,counterparties,amount,direction,category_primary,category_detailed,personal_finance_category,transaction_type,check_number,payment_channel,pending,accounting_review_required,accounting_review_reason,canonical_vendor_id,qbo_entity_type,qbo_entity_id,raw")
      .eq("business_id", businessId)
      .eq("is_archived", false);
    if (txnIds && txnIds.length) {
      txQuery.in("id", txnIds);
    } else {
      if (rangeStart) txQuery.gte("date", normalizeDate(rangeStart));
      if (accountId) txQuery.eq("plaid_account_id", accountId);
    }
    txQuery = applyActiveBookkeepingScope(txQuery, bookkeepingStartDate);
    const { data: txns, error: txErr } = await txQuery;
    if (txErr) throw txErr;
    const nowTs = Date.now();
    const blockedPendingIds = (txns || []).filter((t) => t.pending === true).map((t) => t.id).filter(Boolean);
    if (blockedPendingIds.length) {
      await supabase
        .from("transaction_categorizations")
        .upsert(
          blockedPendingIds.map((transactionId) => ({
            business_id: businessId,
            transaction_id: transactionId,
            status: "needs_review",
            post_after: null,
            post_error: "pending_transaction_not_postable",
            pending_blocked_at: new Date().toISOString(),
            meta: { post_block_reason: "pending_transaction_not_postable" },
          })),
          { onConflict: "business_id,transaction_id" }
        );
    }
    const eligibleTxns = (txns || []).filter((t) => t.pending !== true && t.accounting_review_required !== true);

    const ids = eligibleTxns.map((t) => t.id);
    if (!ids.length) {
      await refreshOperatorRequestSummaryBestEffort({
        businessId,
        reason: "bookkeeping_suggestion_pass",
      });
      return { ok: true, updated: 0, auto_approved: 0, skipped: 0, sample: [] };
    }

    const plaidAccountIds = [...new Set(eligibleTxns.map((t) => t.plaid_account_id).filter(Boolean))];
    let plaidAccountMap = new Map();
    if (plaidAccountIds.length) {
      const { data: plaidAcctRows } = await supabase
        .from("plaid_accounts")
        .select("plaid_account_id,name,official_name,type,subtype")
        .eq("business_id", businessId)
        .in("plaid_account_id", plaidAccountIds);
      plaidAccountMap = new Map((plaidAcctRows || []).map((acct) => [String(acct.plaid_account_id), acct]));
    }

    // Existing categs
    const { data: existing, error: catErr } = await supabase
      .from("transaction_categorizations")
      .select("transaction_id,suggested_qbo_account_id,suggested_qbo_account_name,suggested_canonical_account_key,final_canonical_account_key,confidence,status,meta,final_qbo_account_id,final_qbo_account_name,decided_by,post_after,qbo_txn_id")
      .eq("business_id", businessId)
      .in("transaction_id", ids);
    if (catErr) throw catErr;
    const existingMap = (existing || []).reduce((acc, row) => {
      acc[row.transaction_id] = row;
      return acc;
    }, {});

    const vendorRuleIds = Array.from(
      new Set(
        (existing || [])
          .map((row) => row?.meta?.vendor_rule_id)
          .filter(Boolean)
          .map((id) => String(id))
      )
    );
    let vendorRuleUsageMap = {};
    if (vendorRuleIds.length) {
      try {
        const { data: vendorRuleRows, error: vendorRuleErr } = await supabase
          .from("vendor_rules")
          .select("id,usage_count")
          .eq("business_id", businessId)
          .in("id", vendorRuleIds);
        if (vendorRuleErr) throw vendorRuleErr;
        vendorRuleUsageMap = (vendorRuleRows || []).reduce((acc, row) => {
          acc[String(row.id)] = row.usage_count || 0;
          return acc;
        }, {});
      } catch (vendorRuleUsageErr) {
        devLog("vendor_rule_usage_lookup_skipped", {
          business_id: businessId,
          count: vendorRuleIds.length,
          error: vendorRuleUsageErr?.message || String(vendorRuleUsageErr),
        });
        vendorRuleUsageMap = {};
      }
    }

    let userApprovalContext = {
      hasAnyUserApprovals: false,
      byMerchantEntityId: new Map(),
      byVendorCandidate: new Map(),
      byMemoPrefix: new Map(),
    };
    try {
      const { data: userApprovedCats, error: userApprovedErr } = await supabase
        .from("transaction_categorizations")
        .select("transaction_id,final_qbo_account_id,final_qbo_account_name,decided_by,status")
        .eq("business_id", businessId)
        .in("decided_by", ["user", "user_clarification"])
        .in("status", ["approved", "auto_approved", "posted"])
        .not("final_qbo_account_id", "is", null);
      if (userApprovedErr) throw userApprovedErr;

      const approvedTxnIds = Array.from(
        new Set((userApprovedCats || []).map((row) => row.transaction_id).filter(Boolean))
      );
      let approvedTxnMap = {};
      if (approvedTxnIds.length) {
        const { data: approvedBankTxns, error: approvedBankErr } = await supabase
          .from("bank_transactions")
          .select("id,name,merchant_name,counterparty_name,merchant_entity_id")
          .eq("business_id", businessId)
          .eq("is_archived", false)
          .in("id", approvedTxnIds);
        if (approvedBankErr) throw approvedBankErr;
        approvedTxnMap = (approvedBankTxns || []).reduce((acc, txn) => {
          acc[txn.id] = txn;
          return acc;
        }, {});
      }

      userApprovalContext = buildUserApprovalContext(userApprovedCats || [], approvedTxnMap);
      devLog("user_approval_context", {
        business_id: businessId,
        has_any_user_approvals: userApprovalContext.hasAnyUserApprovals,
        approved_category_count: (userApprovedCats || []).length,
      });
    } catch (userApprovalErr) {
      devLog("user_approval_context_skipped", {
        business_id: businessId,
        error: userApprovalErr?.message || String(userApprovalErr),
      });
    }

    const nowIso = new Date().toISOString();
    const rows = [];
    const rowErrors = [];
    let autoApproved = 0;
    let skipped = 0;
    const metaBackfills = [];
    let metaBackfilled = 0;

    let clarMap = {};
    try {
      const { data: clarRows, error: clarErr } = await supabase
        .from("clarification_requests")
        .select("id,transaction_id,status,last_notified_at,dismissed_until")
        .eq("business_id", businessId)
        .in("transaction_id", ids);
      if (clarErr) throw clarErr;
      clarMap = (clarRows || []).reduce((acc, row) => {
        acc[row.transaction_id] = row;
        return acc;
      }, {});
    } catch (clarErr) {
      devLog("clarification_lookup_skipped", {
        business_id: businessId,
        txn_count: ids.length,
        error: clarErr?.message || String(clarErr),
      });
      clarMap = {};
    }

    const suspenseIds = new Set(
      [fallbacks?.expenseFallback?.id, fallbacks?.incomeFallback?.id, fallbacks?.ama?.id]
        .filter(Boolean)
        .map((v) => String(v))
    );
    const ONE_HOUR_MS = 60 * 60 * 1000;

    const maybeQueueClarification = async ({
      txn,
      payload,
      meta = {},
      checkHit = {},
      vendorRule = null,
      universalHintKey = null,
      taxonomyType = null,
      confidenceOverride = null,
      suggestionSource = null,
    }) => {
      const clar = clarMap[txn.id];
      const nowTs = Date.now();
      const status = payload?.status || "needs_review";

      if (status !== "needs_review") {
        if (clar && clar.status === "pending") {
          const stamp = new Date().toISOString();
          await supabase
            .from("clarification_requests")
            .update({ status: "expired", updated_at: stamp })
            .eq("business_id", businessId)
            .eq("id", clar.id);
          clarMap[txn.id] = { ...clar, status: "expired", updated_at: stamp };
        }
        return;
      }

      if (clar?.dismissed_until && Date.parse(clar.dismissed_until) > nowTs) return;
      if (clar?.last_notified_at && nowTs - Date.parse(clar.last_notified_at) < ONE_HOUR_MS) return;

      const conf = String(confidenceOverride || payload?.confidence || meta?.confidence || "").toLowerCase();
      const safeToAutoPost = meta?.safe_to_auto_post ?? payload?.meta?.safe_to_auto_post ?? null;
      const safeToAutoHandle = meta?.safe_to_auto_handle ?? payload?.meta?.safe_to_auto_handle ?? null;
      const blockedTaxonomy = ["transfer_internal", "refund", "owner_draw", "owner_contribution", "cc_payment"];
      const taxType = String(taxonomyType || meta?.taxonomy_type || payload?.meta?.taxonomy_type || "").toLowerCase();
      if ((safeToAutoHandle === true || safeToAutoPost === true) && conf === "high" && !checkHit?.is_check && !blockedTaxonomy.includes(taxType)) {
        return;
      }
      const suggestedId = payload?.suggested_qbo_account_id || null;
      const suggestedName = payload?.suggested_qbo_account_name || "";
      const suggestedSuspense =
        !suggestedId ||
        suspenseIds.has(String(suggestedId)) ||
        /ask my accountant/i.test(suggestedName || "") ||
        /uncategorized/i.test(suggestedName || "");
      const memoPrefix = computeMemoPrefixForLearning(txn, 12)?.prefix || "";
      const missingPayee = !txn.counterparty_name && !txn.merchant_name && !memoPrefix;
      const isCheck = checkHit?.is_check === true;

      const condLow = conf === "low";
      const condMediumNoSafe = conf === "medium" && safeToAutoPost !== true;
      const condSuspense = suggestedSuspense;
      const condCheck = isCheck;
      const condMissing = missingPayee;

      if (!(condLow || condMediumNoSafe || condSuspense || condCheck || condMissing)) return;

      let reason_code = "other";
      if (condCheck) reason_code = "check";
      else if (condMissing) reason_code = "missing_vendor";
      else if (condSuspense) reason_code = "suspense";
      else if (condLow) reason_code = "low_confidence";
      else if (condMediumNoSafe) reason_code = "no_safe_default";

      const metaPayload = {
        confidence: conf || null,
        suggestion_source: suggestionSource || meta?.suggestion_source || payload?.meta?.suggestion_source || null,
        taxonomy_type: taxonomyType || meta?.taxonomy_type || payload?.meta?.taxonomy_type || null,
        is_check: isCheck,
        suggested_qbo_account_id: suggestedId,
        suggested_qbo_account_name: suggestedName || null,
        vendor_rule_id: vendorRule?.id || null,
        universal_hint_key: universalHintKey || null,
        post_block_reason: meta?.post_block_reason || payload?.meta?.post_block_reason || null,
        safe_to_auto_handle: safeToAutoHandle === true,
        safe_to_auto_post: safeToAutoPost === true,
      };

      const result = await createOrUpdateClarificationRequest({
        businessId,
        txn,
        reason_code,
        meta: metaPayload,
      });
      if (result?.ok && result.id) {
        const stamp = new Date().toISOString();
        await supabase
          .from("clarification_requests")
          .update({ last_notified_at: stamp, updated_at: stamp })
          .eq("business_id", businessId)
          .eq("id", result.id);
        clarMap[txn.id] = { id: result.id, status: "pending", last_notified_at: stamp };
        devLog("clarification_queued", { txn_id: txn.id, reason_code, source: metaPayload.suggestion_source || "unknown" });
      }
    };

    const pushRow = async (options) => {
      const { payload, txn, ...ctx } = options || {};
      if (!payload || !txn) return;
      const stampedPayload = {
        ...payload,
        meta: withCategorizationPolicyVersion(payload.meta || {}),
      };
      rows.push(stampedPayload);
      await maybeQueueClarification({ payload: stampedPayload, txn, ...ctx });
    };

    for (const row of eligibleTxns || []) {
      let rowBranch = "init";
      try {
      const checkHit = isCheck(row);
      const existingCat = existingMap[row.id];
      const similarUserApproval = findSimilarUserApproval(userApprovalContext, row);
      const hasSimilarUserApproval = Boolean(similarUserApproval);
      const metaBase = existingCat?.meta || {};
      const ccPaymentRejected =
        metaBase?.cc_payment_rejected === true ||
        metaBase?.taxonomy_override === "not_cc_payment";
      const checkMeta = checkHit.is_check
        ? {
            is_check: true,
            check_confidence: checkHit.confidence,
            check_reason: checkHit.reason,
            ...(checkHit.check_number ? { check_number: checkHit.check_number } : {}),
            taxonomy_flags: { ...(metaBase?.taxonomy_flags || {}), is_check: true },
          }
        : {};
      const baseMetaWithCheck = { ...metaBase, ...checkMeta };
      const plaidAcctForTxn = plaidAccountMap.get(String(row.plaid_account_id)) || null;
      const ccPaymentPairResult = ccPaymentRejected
        ? { status: "no_match", reason: "cc_payment_rejected_by_user" }
        : await createSafeCreditCardPaymentPairForRow({ businessId, row });
      const ccPaymentPair = ccPaymentPairResult?.pair
        ? {
            role:
              String(ccPaymentPairResult.pair.checking_transaction_id) === String(row.id)
                ? "checking"
                : "credit_card",
            txnId:
              String(ccPaymentPairResult.pair.checking_transaction_id) === String(row.id)
                ? ccPaymentPairResult.pair.credit_card_transaction_id
                : ccPaymentPairResult.pair.checking_transaction_id,
            pairedPlaidAccountId:
              String(ccPaymentPairResult.pair.checking_transaction_id) === String(row.id)
                ? ccPaymentPairResult.pair.credit_card_plaid_account_id
                : ccPaymentPairResult.pair.checking_plaid_account_id,
            historicalContextOnly: false,
            pairId: ccPaymentPairResult.pair.id,
            pairStatus: ccPaymentPairResult.pair.status,
            pairConfidence: ccPaymentPairResult.pair.match_confidence,
            checkingQboAccountId: ccPaymentPairResult.pair.checking_qbo_account_id,
            checkingQboAccountName: ccPaymentPairResult.pair.checking_qbo_account_name,
            creditCardQboAccountId: ccPaymentPairResult.pair.credit_card_qbo_account_id,
            creditCardQboAccountName: ccPaymentPairResult.pair.credit_card_qbo_account_name,
            targetQboAccountId:
              String(ccPaymentPairResult.pair.checking_transaction_id) === String(row.id)
                ? ccPaymentPairResult.pair.credit_card_qbo_account_id
                : ccPaymentPairResult.pair.checking_qbo_account_id,
            targetQboAccountName:
              String(ccPaymentPairResult.pair.checking_transaction_id) === String(row.id)
                ? ccPaymentPairResult.pair.credit_card_qbo_account_name
                : ccPaymentPairResult.pair.checking_qbo_account_name,
            counterpartAmount:
              String(ccPaymentPairResult.pair.checking_transaction_id) === String(row.id)
                ? Math.abs(Number(ccPaymentPairResult.pair.amount || 0))
                : -Math.abs(Number(ccPaymentPairResult.pair.amount || 0)),
            counterpartDate:
              String(ccPaymentPairResult.pair.checking_transaction_id) === String(row.id)
                ? ccPaymentPairResult.pair.matched_date || ccPaymentPairResult.pair.payment_date
                : ccPaymentPairResult.pair.payment_date || ccPaymentPairResult.pair.matched_date,
            counterpartAccountName:
              String(ccPaymentPairResult.pair.checking_transaction_id) === String(row.id)
                ? ccPaymentPairResult.pair.credit_card_qbo_account_name
                : ccPaymentPairResult.pair.checking_qbo_account_name,
          }
        : null;
      const rowTaxonomyContext = {
        ...taxonomyContext,
        currentAccountType: plaidAcctForTxn?.type || null,
        currentAccountSubtype: plaidAcctForTxn?.subtype || null,
        hasCreditCardPaymentPair: Boolean(ccPaymentPair?.txnId),
        suppressCcPayment: ccPaymentRejected,
        taxonomyOverride: ccPaymentRejected ? "not_cc_payment" : null,
        targetAccountTypes: ccPaymentPair?.txnId ? ["credit"] : [],
      };
      const freshTaxHit = classifyTaxonomy(row, rowTaxonomyContext);
      const freshUniversalHint = await getUniversalVendorHintForTransaction({ bankTxn: row });
      const existingStatusLower = String(existingCat?.status || "").toLowerCase();
      const existingProtected = ["approved", "auto_approved", "posted"].includes(existingStatusLower);
      const confirmedCcPaymentPair =
        freshTaxHit?.type === "cc_payment" &&
        ccPaymentPair?.txnId &&
        String(ccPaymentPair.pairStatus || "").toLowerCase() === "confirmed";
      const durableCcPaymentPair =
        freshTaxHit?.type === "cc_payment" &&
        ccPaymentPair?.txnId &&
        String(ccPaymentPair.pairConfidence || "").toLowerCase() === "high";
      const authoritativeSpecialWorkflow =
        confirmedCcPaymentPair ||
        durableCcPaymentPair ||
        ["transfer_internal", "owner_draw", "owner_contribution", "refund"].includes(String(freshTaxHit?.type || ""));
      const strongFreshUniversalEvidence =
        !existingProtected &&
        freshUniversalHint &&
        isUniversalIntentAllowlisted(freshUniversalHint.primary_intent) &&
        isStrongUniversalVendorEvidence(freshUniversalHint);
      const existingSuggested = ensureAccountName({
        acctId: existingCat?.suggested_qbo_account_id || null,
        acctName: existingCat?.suggested_qbo_account_name || null,
        coa,
      });
      const existingSuggestedSuspense = isSuspenseAccount({
        acctId: existingSuggested.id,
        acctName: existingSuggested.name,
        suspenseIds,
      });
      const existingCanonicalKey = existingCat?.suggested_canonical_account_key || metaBase?.canonical_account_key || null;
      const freshIntentKey = freshUniversalHint?.primary_intent ? resolveIntentKey(freshUniversalHint.primary_intent) : null;
      const bypassExistingForFreshEvidence =
        !existingProtected &&
        (
          authoritativeSpecialWorkflow ||
          checkHit.is_check ||
          (
            strongFreshUniversalEvidence &&
            (
              existingSuggestedSuspense ||
              !existingCanonicalKey ||
              String(existingCanonicalKey).toLowerCase() !== String(freshIntentKey || "").toLowerCase() ||
              String(metaBase?.suggestion_source || "") !== "universal_hint"
            )
          )
        );
      rowBranch = "existing_categorization";
        if (existingCat && existingCat.suggested_qbo_account_id && !bypassExistingForFreshEvidence) {
        const taxHit = freshTaxHit;
        let mergedMeta = { ...baseMetaWithCheck };
        mergedMeta.user_approval_backed = hasSimilarUserApproval;
        mergedMeta.user_approval_match_type = similarUserApproval?.match_type || null;
        mergedMeta.user_approval_match_txn_id = similarUserApproval?.transaction_id || null;
        if (taxHit) {
          const hasTaxonomyMeta = existingCat?.meta?.taxonomy_type;
          if (!hasTaxonomyMeta) {
            const taxonomyMeta = buildTaxonomyMeta(taxHit);
            mergedMeta = {
              ...mergedMeta,
              ...taxonomyMeta,
            };
            if (metaBase?.auto_approve_reason === "manual_user") {
              mergedMeta.safe_to_auto_handle = true;
              mergedMeta.safe_to_auto_post = true;
              mergedMeta.auto_approve_reason = "manual_user";
            }
            mergedMeta.suggestion_source = mergedMeta.suggestion_source || "taxonomy";
            if (taxHit.type === "transfer_internal") {
              const pair = await findTransferPairTxnId(businessId, row, {
                bookkeepingStartDate,
                allowHistoricalContext: true,
              });
              if (pair?.txnId) {
                mergedMeta.transfer_pair_txn_id = pair.txnId;
                mergedMeta.transfer_pair_confidence = "high";
                mergedMeta.transfer_pair_notes = pair.historicalContextOnly
                  ? "Matched opposite-side transfer by amount/date as historical context only"
                  : "Matched opposite-side transfer by amount/date";
                mergedMeta.transfer_pair_historical_context_only = !!pair.historicalContextOnly;
              }
            }
            if (taxHit.type === "owner_draw" || taxHit.type === "owner_contribution") {
              const equityAcct = taxHit.type === "owner_draw" ? ownerEquityAccounts?.drawAcct : ownerEquityAccounts?.contribAcct;
              const suggested = equityAcct || fallbacks.ama || null;
              mergedMeta.owner_move_equity_account_id = suggested?.id || null;
              mergedMeta.owner_move_equity_account_name = suggested?.name || null;
            }
            if (taxHit.type === "cc_payment" && ccPaymentPair?.txnId) {
              mergedMeta.cc_payment_pair_id = ccPaymentPair.pairId || null;
              mergedMeta.cc_payment_pair_txn_id = ccPaymentPair.txnId;
              mergedMeta.cc_payment_pair_plaid_account_id = ccPaymentPair.pairedPlaidAccountId || null;
              mergedMeta.cc_payment_pair_historical_context_only = !!ccPaymentPair.historicalContextOnly;
              mergedMeta.cc_payment_pair_status = ccPaymentPair.pairStatus || "needs_review";
              mergedMeta.cc_payment_pair_confidence = ccPaymentPair.pairConfidence || "high";
              mergedMeta.cc_payment_pair_role = ccPaymentPair.role || null;
              mergedMeta.cc_payment_transfer_target_qbo_account_id = ccPaymentPair.targetQboAccountId || null;
              mergedMeta.cc_payment_transfer_target_qbo_account_name = ccPaymentPair.targetQboAccountName || null;
              mergedMeta.cc_payment_pair_counterpart_amount = ccPaymentPair.counterpartAmount;
              mergedMeta.cc_payment_pair_counterpart_date = ccPaymentPair.counterpartDate || null;
              mergedMeta.cc_payment_pair_counterpart_account_name = ccPaymentPair.counterpartAccountName || null;
              mergedMeta.cc_payment_bank_qbo_account_id = ccPaymentPair.checkingQboAccountId || null;
              mergedMeta.cc_payment_bank_qbo_account_name = ccPaymentPair.checkingQboAccountName || null;
              mergedMeta.cc_payment_cc_qbo_account_id = ccPaymentPair.creditCardQboAccountId || null;
              mergedMeta.cc_payment_cc_qbo_account_name = ccPaymentPair.creditCardQboAccountName || null;
            } else if (taxHit.type === "cc_payment" && ccPaymentPairResult?.status === "ambiguous") {
              mergedMeta.post_block_reason = "cc_payment_pair_ambiguous";
              mergedMeta.cc_payment_pair_ambiguous = true;
              mergedMeta.cc_payment_pair_candidates = ccPaymentPairResult.candidates || [];
            }
            if (taxHit.type === "refund") {
              const orig = await findRefundOriginalTxn({
                businessId,
                refundTxn: row,
                bookkeepingStartDate,
                allowHistoricalContext: true,
              });
              if (orig) {
                mergedMeta.refund_match_source = "prior_txn";
                mergedMeta.refund_original_txn_id = orig.txnId;
                mergedMeta.refund_original_account_id = orig.accountId;
                mergedMeta.refund_original_account_name = orig.accountName;
                mergedMeta.refund_original_historical_context_only = !!orig.historicalContextOnly;
              } else {
                mergedMeta.refund_match_source = "none";
              }
            }
            metaBackfills.push({
              business_id: businessId,
              transaction_id: row.id,
              meta: mergedMeta,
              decided_by: "taxonomy_meta_backfill",
              decided_at: nowIso,
              updated_at: nowIso,
            });
            metaBackfilled += 1;
          }
        }
        if (checkHit.is_check && (!existingCat.meta?.is_check || !existingCat.meta?.check_confidence || !existingCat.meta?.check_reason)) {
          metaBackfills.push({
            business_id: businessId,
            transaction_id: row.id,
            meta: { ...existingCat.meta, ...checkMeta },
            decided_by: "check_meta_backfill",
            decided_at: nowIso,
            updated_at: nowIso,
          });
          metaBackfilled += 1;
        }
        if (taxHit?.type === "cc_payment") {
          const matched = Boolean(ccPaymentPair?.targetQboAccountId && ccPaymentPair?.pairConfidence === "high");
          const ccMeta = withCategorizationPolicyVersion({
            ...mergedMeta,
            taxonomy_type: "cc_payment",
            suggestion_source: "taxonomy",
            cc_payment_pair_id: ccPaymentPair?.pairId || null,
            cc_payment_pair_role: ccPaymentPair?.role || null,
            cc_payment_pair_txn_id: ccPaymentPair?.txnId || null,
            cc_payment_pair_plaid_account_id: ccPaymentPair?.pairedPlaidAccountId || null,
            cc_payment_pair_status: ccPaymentPair?.pairStatus || null,
            cc_payment_pair_confidence: ccPaymentPair?.pairConfidence || null,
            cc_payment_pair_ambiguous: ccPaymentPairResult?.status === "ambiguous",
            cc_payment_pair_candidates: ccPaymentPairResult?.candidates || null,
            cc_payment_transfer_target_qbo_account_id: ccPaymentPair?.targetQboAccountId || null,
            cc_payment_transfer_target_qbo_account_name: ccPaymentPair?.targetQboAccountName || null,
            cc_payment_pair_counterpart_amount: ccPaymentPair?.counterpartAmount ?? null,
            cc_payment_pair_counterpart_date: ccPaymentPair?.counterpartDate || null,
            cc_payment_pair_counterpart_account_name: ccPaymentPair?.counterpartAccountName || null,
            cc_payment_bank_qbo_account_id: ccPaymentPair?.checkingQboAccountId || null,
            cc_payment_bank_qbo_account_name: ccPaymentPair?.checkingQboAccountName || null,
            cc_payment_cc_qbo_account_id: ccPaymentPair?.creditCardQboAccountId || null,
            cc_payment_cc_qbo_account_name: ccPaymentPair?.creditCardQboAccountName || null,
            cc_payment_mapping_confidence: matched ? "high" : "low",
            cc_payment_mapping_notes: matched ? "durable_pair_target" : ccPaymentPairResult?.reason || "cc_payment_needs_match",
            safe_to_auto_handle: false,
            safe_to_auto_post: false,
            auto_handle_decision: {
              eligible: matched,
              confidence: matched ? "high" : taxHit.confidence || "medium",
              source: "cc_payment_pairing",
              reason: matched ? "cc_payment_pair_matched" : ccPaymentPairResult?.reason || "cc_payment_pair_requires_confirmation",
              at: nowIso,
            },
          });
          const targetId = matched ? ccPaymentPair.targetQboAccountId : null;
          const targetName = matched ? ccPaymentPair.targetQboAccountName : null;
          await pushRow({
            txn: row,
            payload: {
              business_id: businessId,
              transaction_id: row.id,
              suggested_qbo_account_id: targetId,
              suggested_qbo_account_name: targetName,
              suggested_canonical_account_key: null,
              final_qbo_account_id: null,
              final_qbo_account_name: null,
              final_canonical_account_key: null,
              confidence: matched ? "high" : taxHit.confidence || "medium",
              reason: matched ? "Credit card payment matched." : "Credit card payment needs matching before posting.",
              status: matched ? "auto_approved" : "needs_review",
              post_after: null,
              post_error: matched ? null : ccPaymentPairResult?.reason || "cc_payment_pair_requires_confirmation",
              meta: ccMeta,
              updated_at: nowIso,
              decided_by: matched ? "bizzi" : "taxonomy",
              decided_at: nowIso,
            },
            meta: ccMeta,
            checkHit,
            taxonomyType: taxHit.type,
            confidenceOverride: matched ? "high" : taxHit.confidence || "medium",
            suggestionSource: "taxonomy",
          });
          if (matched) autoApproved += 1;
          else skipped += 1;
          continue;
        }
        if (mergedMeta.safe_to_auto_handle !== true && mergedMeta.safe_to_auto_handle !== false) {
          const blockedTaxonomy = ["transfer_internal", "refund", "owner_draw", "owner_contribution", "cc_payment"];
          const taxType = String(mergedMeta.taxonomy_type || "").toLowerCase();
          const suggested = ensureAccountName({
            acctId: existingCat.suggested_qbo_account_id,
            acctName: existingCat.suggested_qbo_account_name,
            coa,
          });
          const suggestedId = suggested.id;
          const suggestedNameResolved = suggested.name;
          const suggestedSuspense = isSuspenseAccount({
            acctId: suggestedId,
            acctName: suggestedNameResolved,
            suspenseIds,
          });
          if (
            String(existingCat.confidence || "").toLowerCase() === "high" &&
            !checkHit.is_check &&
            !blockedTaxonomy.includes(taxType) &&
            !suggestedSuspense &&
            !!suggestedNameResolved
          ) {
            mergedMeta.safe_to_auto_handle = true;
            mergedMeta.safe_to_auto_post = true;
            mergedMeta.auto_approve_reason = mergedMeta.auto_approve_reason || "model_high";
          } else {
            mergedMeta.safe_to_auto_handle = false;
            mergedMeta.safe_to_auto_post = false;
          }
        }

        const suggested = ensureAccountName({
          acctId: existingCat.suggested_qbo_account_id,
          acctName: existingCat.suggested_qbo_account_name,
          coa,
        });
        const suggestedId = suggested.id;
        const suggestedNameResolved = suggested.name;
        const suggestedName = suggestedNameResolved || "Account";
        const suggestedSuspense = isSuspenseAccount({
          acctId: suggestedId,
          acctName: suggestedNameResolved,
          suspenseIds,
        });
        const existingSuggestionSource = String(mergedMeta.suggestion_source || "");
        const statusLower = String(existingCat.status || "").toLowerCase();
        const protectedBizziGraceEligible =
          ["approved", "auto_approved"].includes(statusLower) &&
          existingCat.decided_by === "bizzi" &&
          !existingCat.qbo_txn_id &&
          existingCat.post_after &&
          Date.parse(existingCat.post_after) > nowTs &&
          existingCat?.meta?.auto_approve_reason !== "manual_user";
        const existingVendorRuleApproved =
          existingSuggestionSource === "vendor_rule" &&
          Boolean(mergedMeta.vendor_rule_coa_id) &&
          String(mergedMeta.vendor_rule_coa_id) === String(similarUserApproval?.final_qbo_account_id || "");
        const preferUniversalForTxn =
          !userApprovalContext.hasAnyUserApprovals ||
          !existingVendorRuleApproved;
        let reevalExisting = shouldReevaluateExistingSuggestion({
          existingCat,
          suggestedId,
          suggestedName: suggestedNameResolved,
          suggestedSuspense,
          suggestionSource: existingSuggestionSource,
          allowProtectedReevaluation: protectedBizziGraceEligible,
        });
        if (
          !reevalExisting &&
          existingSuggestionSource === "vendor_rule" &&
          !existingVendorRuleApproved
        ) {
          reevalExisting = true;
          devLog("existing_vendor_rule_deferred_to_universal", {
            txn: row.id,
            plaid_transaction_id: row.plaid_transaction_id,
            has_any_user_approvals: userApprovalContext.hasAnyUserApprovals,
            user_approval_match_type: similarUserApproval?.match_type || null,
            user_approval_match_txn_id: similarUserApproval?.transaction_id || null,
            vendor_rule_coa_id: mergedMeta.vendor_rule_coa_id || null,
            approved_account_id: similarUserApproval?.final_qbo_account_id || null,
          });
        }
        if (reevalExisting) {
          devLog("existing_suggestion_reevaluate", {
            txn: row.id,
            plaid_transaction_id: row.plaid_transaction_id,
            suggested_qbo_account_id: suggestedId || null,
            suggested_qbo_account_name: suggestedNameResolved || null,
            suggestion_source: existingSuggestionSource || null,
            confidence: existingCat.confidence || null,
            suspense_account: suggestedSuspense,
            prefer_universal_for_txn: preferUniversalForTxn,
            user_approval_backed: existingVendorRuleApproved,
            protected_bizzi_grace_eligible: protectedBizziGraceEligible,
          });
        } else {
        let suggestedAcct = suggestedId ? { id: suggestedId, name: suggestedNameResolved || "" } : null;
        const protectedStatuses = ["approved", "auto_approved", "posted"];
        const canUpgrade = !protectedStatuses.includes(statusLower) || protectedBizziGraceEligible;
        const blockedTaxonomy = ["transfer_internal", "refund", "owner_draw", "owner_contribution", "cc_payment"];
        const taxType = String(mergedMeta.taxonomy_type || "").toLowerCase();
        let promotionSource = null;
        let promotionReason = null;
        let vendorRulePromote = false;
        let universalPromote = false;
        let highConfidencePromote = false;
        if (canUpgrade && !checkHit.is_check && !blockedTaxonomy.includes(taxType) && !suggestedSuspense) {
          const vendorRuleId = mergedMeta.vendor_rule_id || null;
          const vendorRuleUsage = vendorRuleId ? vendorRuleUsageMap[String(vendorRuleId)] || 0 : 0;
          vendorRulePromote =
            mergedMeta.vendor_rule_match_reason === "memo_prefix" &&
            vendorRuleId &&
            vendorRuleUsage >= VENDOR_RULE_MEMO_PREFIX_PROMOTE_MIN_USES;
          const hintMeta = mergedMeta.universal_hint || {};
          const hintConfidenceHigh = String(hintMeta.confidence || "").toLowerCase() === "high";
          const hintIntent = String(hintMeta.primary_intent || "").toLowerCase();
          const safeUniversal = isUniversalHintAutoApproveSafe({
            match_type: hintMeta.match_type,
            matched_value: hintMeta.matched_value,
            canonical_vendor: hintMeta.canonical_vendor,
          });
          universalPromote =
            mergedMeta.suggestion_source === "universal_hint" &&
            hintMeta.key &&
            hintConfidenceHigh &&
            isUniversalIntentAllowlisted(hintIntent) &&
            safeUniversal;
          const source = String(mergedMeta.suggestion_source || "");
          highConfidencePromote =
            String(existingCat.confidence || "").toLowerCase() === "high" &&
            mergedMeta.safe_to_auto_handle === false &&
            (source === "vendor_rule" || source === "universal_hint");
          if (vendorRulePromote || universalPromote || highConfidencePromote) {
            mergedMeta.safe_to_auto_handle = true;
            mergedMeta.safe_to_auto_post = true;
            mergedMeta.auto_approve_reason = "promotion_pass";
            promotionSource = source || "unknown";
            promotionReason = vendorRulePromote
              ? "vendor_rule_memo_prefix_matured"
              : universalPromote
              ? "universal_hint_safe"
              : "high_confidence_source";
            mergedMeta.promotion_pass = {
              source: promotionSource,
              reason: promotionReason,
              at: nowIso,
            };
          }
        }
        const confidenceForAutoApproval =
          vendorRulePromote || universalPromote
            ? "high"
            : existingCat.confidence || "low";
        const reevaluatedBaseStatus = protectedBizziGraceEligible ? "needs_review" : (existingCat.status || "needs_review");
        const reason = mergedMeta.auto_approve_reason || mergedMeta.suggestion_source || "model_high";
        const existingHintMeta = mergedMeta.universal_hint || {};
        const existingSafeUniversal = existingHintMeta?.key
          ? isUniversalHintAutoApproveSafe({
              match_type: existingHintMeta.match_type,
              matched_value: existingHintMeta.matched_value,
              canonical_vendor: existingHintMeta.canonical_vendor,
            })
          : false;
        const canonicalVendorEvidence = await resolveCanonicalVendorEvidenceForPromotion({
          businessId,
          row,
          taxonomyMeta: mergedMeta,
        });
        const canonicalAccountKey =
          existingCat.suggested_canonical_account_key ||
          existingCat.final_canonical_account_key ||
          mergedMeta.canonical_account_key ||
          existingHintMeta.canonical_account_key ||
          null;
        let canonicalAccountValidation = null;
        if (canonicalAccountKey) {
          canonicalAccountValidation = await validateCanonicalQboAccountForPromotion({
            businessId,
            canonicalAccountKey,
            transactionId: row.id,
            source: "page_suggest_existing",
            allowCreate: false,
          });
        }
        const validatedAccount = canonicalAccountValidation?.ok && canonicalAccountValidation?.account?.id
          ? {
              id: String(canonicalAccountValidation.account.id),
              name: canonicalAccountValidation.account.name || canonicalAccountValidation.account.fullyQualifiedName || "",
              type: canonicalAccountValidation.account.type || canonicalAccountValidation.account.AccountType || null,
              subType: canonicalAccountValidation.account.subType || canonicalAccountValidation.account.AccountSubType || null,
            }
          : null;
        const validatedSuspense = validatedAccount
          ? isSuspenseAccount({
              acctId: validatedAccount.id,
              acctName: validatedAccount.name,
              suspenseIds,
            })
          : true;
        const canonicalAccountResolved =
          canonicalAccountValidation?.ok === true &&
          canonicalAccountValidation.review_required !== true &&
          Boolean(canonicalAccountValidation.canonical?.canonical_account_key && validatedAccount?.id) &&
          !validatedSuspense;
        suggestedAcct = canonicalAccountKey ? (canonicalAccountResolved ? validatedAccount : null) : suggestedAcct;
        const merchantEvidenceStrong =
          canonicalVendorEvidence.merchantEvidenceStrong === true ||
          Boolean(row.merchant_entity_id) ||
          (
            Boolean(row.merchant_name) &&
            mergedMeta.suggestion_source === "universal_hint" &&
            existingSafeUniversal === true
          );
        mergedMeta.canonical_vendor_id = canonicalVendorEvidence.canonicalVendorId || mergedMeta.canonical_vendor_id || null;
        mergedMeta.canonical_vendor_reliable = canonicalVendorEvidence.canonicalVendorReliable === true;
        mergedMeta.canonical_vendor_resolution_reason = canonicalVendorEvidence.canonicalVendorResolutionReason || null;
        mergedMeta.canonical_coa_resolved = canonicalAccountResolved;
        mergedMeta.canonical_coa_revalidation_reason = canonicalAccountValidation?.reason || canonicalAccountValidation?.status || null;
        mergedMeta.canonical_coa_revalidation_status = canonicalAccountValidation?.status || null;
        mergedMeta.merchant_evidence_strong = merchantEvidenceStrong;
        const autoResult = applyAutoApproval({
          status: reevaluatedBaseStatus,
          confidence: confidenceForAutoApproval,
          meta: mergedMeta,
          checkHit,
          suggestedAcct,
          taxonomyType: mergedMeta.taxonomy_type || null,
          nowIso,
          reason,
          autoApprove,
          autoPostEnabled,
          txnId: row.id,
          transaction: row,
          businessContext: { suspenseIds },
          evidence: {
            source: mergedMeta.suggestion_source || "existing_suggestion",
            safeToAutoHandle: mergedMeta.safe_to_auto_handle === true,
            verifiedCcPayment:
              mergedMeta.taxonomy_type === "cc_payment" &&
              mergedMeta.cc_payment_mapping_confidence === "high" &&
              mergedMeta.cc_payment_bank_qbo_account_id &&
              mergedMeta.cc_payment_cc_qbo_account_id,
            canonicalVendorId: canonicalVendorEvidence.canonicalVendorId || null,
            canonicalVendorReliable: canonicalVendorEvidence.canonicalVendorReliable === true,
            weakVendorEvidence: canonicalVendorEvidence.weakVendorEvidence === true,
            merchantEvidenceStrong,
            canonicalAccountResolved,
            canonicalAccountKey: canonicalAccountValidation?.canonical?.canonical_account_key || canonicalAccountKey,
            canonicalAccountReviewRequired:
              canonicalAccountResolved !== true ||
              mergedMeta.canonical_account_review_required === true ||
              mergedMeta.canonical_mapping_review_required === true,
            inBookkeepingScope: true,
            reconsiderationSource: "page_suggest_existing",
          },
        });
        const nextStatus = canUpgrade ? autoResult.status : existingCat.status;
        if (promotionSource && autoResult.status === "auto_approved") {
          devLog("promotion_pass_auto_approved", {
            txnId: row.id,
            source: promotionSource,
            reason: promotionReason || "promotion_pass",
          });
        }

        const payload = {
          business_id: businessId,
          transaction_id: row.id,
          suggested_qbo_account_id: validatedAccount?.id || suggestedId || null,
          suggested_qbo_account_name: validatedAccount?.name || suggestedName || null,
          suggested_canonical_account_key: canonicalAccountValidation?.canonical?.canonical_account_key || existingCat.suggested_canonical_account_key || existingCat.final_canonical_account_key || mergedMeta.canonical_account_key || null,
          confidence:
            canUpgrade && autoResult.status === "auto_approved" && (vendorRulePromote || universalPromote)
              ? "high"
              : existingCat.confidence || null,
          status: nextStatus || "needs_review",
          meta: autoResult.meta,
          updated_at: nowIso,
        };
        if (payload.status !== "auto_approved" && payload.status !== "approved" && payload.status !== "posted") {
          payload.final_qbo_account_id = null;
          payload.final_qbo_account_name = null;
          payload.final_canonical_account_key = null;
          payload.post_after = null;
        }
        if (canUpgrade && autoResult.status === "auto_approved") {
          payload.status = "auto_approved";
          payload.final_qbo_account_id = validatedAccount?.id || null;
          payload.final_qbo_account_name = validatedAccount?.name || null;
          payload.final_canonical_account_key = payload.suggested_canonical_account_key || null;
          payload.post_after = autoResult.postAfter === undefined ? computePostAfterForAutoPost(autoPostEnabled, GRACE_HOURS) : autoResult.postAfter;
          payload.decided_by = "bizzi";
          payload.decided_at = nowIso;
        }
        if (autoResult.finalAcctId !== undefined && payload.final_qbo_account_id === undefined) {
          payload.final_qbo_account_id = autoResult.finalAcctId;
        }
        if (autoResult.finalAcctName !== undefined && payload.final_qbo_account_name === undefined) {
          payload.final_qbo_account_name = autoResult.finalAcctName;
        }
        if (autoResult.postAfter !== undefined && payload.post_after === undefined) {
          payload.post_after = autoResult.postAfter;
        }
        await pushRow({
          txn: row,
          payload,
          meta: autoResult.meta,
          checkHit,
          confidenceOverride: confidenceForAutoApproval,
          suggestionSource: mergedMeta.suggestion_source || null,
        });
        if (autoResult.status === "auto_approved" && !checkHit.is_check) {
          autoApproved += 1;
        } else {
          skipped += 1;
        }
        continue;
        }
      }

      rowBranch = "taxonomy";
      const taxHit = freshTaxHit;
      if (taxHit) {
        const taxonomyMeta = buildTaxonomyMeta(taxHit);
        let mergedMeta = {
          ...baseMetaWithCheck,
          ...taxonomyMeta,
        };
        if (metaBase?.auto_approve_reason === "manual_user") {
          mergedMeta.safe_to_auto_handle = true;
          mergedMeta.safe_to_auto_post = true;
          mergedMeta.auto_approve_reason = "manual_user";
        }
        mergedMeta.suggestion_source = taxonomyMeta.suggestion_source;
        mergedMeta.suggestion_debug = {
          taxonomy_type: taxHit.type,
          taxonomy_confidence: taxHit.confidence,
        };

        if (taxHit.type === "transfer_internal") {
          const pair = await findTransferPairTxnId(businessId, row, {
            bookkeepingStartDate,
            allowHistoricalContext: true,
          });
          if (pair?.txnId) {
            mergedMeta.transfer_pair_txn_id = pair.txnId;
            mergedMeta.transfer_pair_confidence = "high";
            mergedMeta.transfer_pair_notes = pair.historicalContextOnly
              ? "Matched opposite-side transfer by amount/date as historical context only"
              : "Matched opposite-side transfer by amount/date";
            mergedMeta.transfer_pair_historical_context_only = !!pair.historicalContextOnly;
          }
        }

        const transferAcct = taxHit.type === "transfer_internal" ? findTransferAccount(coaMap) : null;
        const safeFallback = taxHit.type === "transfer_internal" ? transferAcct || pickSafeFallbackForTxn(row, fallbacks) : pickSafeFallbackForTxn(row, fallbacks);

        let ccMapping = null;
        let suggestedAcct = safeFallback;
        let status = "needs_review";
        let reasonPrefix =
          taxHit.type === "transfer_internal"
            ? `Taxonomy: ${taxHit.type} (${taxHit.confidence}) — Review: internal transfer should not hit income/expense. Suggested: ${suggestedAcct?.name || "none"}`
            : `Taxonomy: ${taxHit.type}${taxHit.subtype ? `/${taxHit.subtype}` : ""} (${taxHit.confidence}) — Suggested: ${safeFallback?.name || "none"}`;

        if (taxHit.type === "cc_payment") {
          if (ccPaymentPair?.txnId) {
            mergedMeta.cc_payment_pair_id = ccPaymentPair.pairId || null;
            mergedMeta.cc_payment_pair_role = ccPaymentPair.role || null;
            mergedMeta.cc_payment_pair_txn_id = ccPaymentPair.txnId;
            mergedMeta.cc_payment_pair_plaid_account_id = ccPaymentPair.pairedPlaidAccountId || null;
            mergedMeta.cc_payment_pair_historical_context_only = !!ccPaymentPair.historicalContextOnly;
            mergedMeta.cc_payment_pair_status = ccPaymentPair.pairStatus || "needs_review";
            mergedMeta.cc_payment_pair_confidence = ccPaymentPair.pairConfidence || "high";
            mergedMeta.cc_payment_transfer_target_qbo_account_id = ccPaymentPair.targetQboAccountId || null;
            mergedMeta.cc_payment_transfer_target_qbo_account_name = ccPaymentPair.targetQboAccountName || null;
            mergedMeta.cc_payment_pair_counterpart_amount = ccPaymentPair.counterpartAmount;
            mergedMeta.cc_payment_pair_counterpart_date = ccPaymentPair.counterpartDate || null;
            mergedMeta.cc_payment_pair_counterpart_account_name = ccPaymentPair.counterpartAccountName || null;
            mergedMeta.cc_payment_bank_qbo_account_id = ccPaymentPair.checkingQboAccountId || null;
            mergedMeta.cc_payment_bank_qbo_account_name = ccPaymentPair.checkingQboAccountName || null;
            mergedMeta.cc_payment_cc_qbo_account_id = ccPaymentPair.creditCardQboAccountId || null;
            mergedMeta.cc_payment_cc_qbo_account_name = ccPaymentPair.creditCardQboAccountName || null;
          } else if (ccPaymentPairResult?.status === "ambiguous") {
            mergedMeta.post_block_reason = "cc_payment_pair_ambiguous";
            mergedMeta.cc_payment_pair_ambiguous = true;
            mergedMeta.cc_payment_pair_candidates = ccPaymentPairResult.candidates || [];
          }
          ccMapping = ccPaymentPair?.targetQboAccountId
            ? {
                bankAccountRef: ccPaymentPair.role === "credit_card" ? { id: ccPaymentPair.targetQboAccountId, name: ccPaymentPair.targetQboAccountName } : null,
                creditCardAccountRef: ccPaymentPair.role !== "credit_card" ? { id: ccPaymentPair.targetQboAccountId, name: ccPaymentPair.targetQboAccountName } : null,
                confidence: "high",
                notes: "durable_pair_target",
              }
            : null;
          if (ccPaymentPair?.targetQboAccountId) {
            suggestedAcct = {
              id: ccPaymentPair.targetQboAccountId,
              name: ccPaymentPair.targetQboAccountName || ccPaymentPair.targetQboAccountId,
            };
          } else {
            suggestedAcct = null;
          }
          mergedMeta.cc_payment_mapping_confidence = ccMapping?.confidence || "low";
          mergedMeta.cc_payment_bank_qbo_account_id = ccPaymentPair?.checkingQboAccountId || ccMapping?.bankAccountRef?.id || null;
          mergedMeta.cc_payment_bank_qbo_account_name = ccPaymentPair?.checkingQboAccountName || ccMapping?.bankAccountRef?.name || null;
          mergedMeta.cc_payment_cc_qbo_account_id = ccPaymentPair?.creditCardQboAccountId || ccMapping?.creditCardAccountRef?.id || null;
          mergedMeta.cc_payment_cc_qbo_account_name = ccPaymentPair?.creditCardQboAccountName || ccMapping?.creditCardAccountRef?.name || null;
          mergedMeta.cc_payment_mapping_notes = ccMapping?.notes || null;
          mergedMeta.safe_to_auto_handle = false;
          mergedMeta.safe_to_auto_post = metaBase?.auto_approve_reason === "manual_user";
          mergedMeta.auto_approve_reason = metaBase?.auto_approve_reason === "manual_user" ? "manual_user" : null;
          status = "needs_review";
          reasonPrefix = `Taxonomy: cc_payment (${taxHit.confidence}) — Not an expense. Suggested: ${suggestedAcct?.name || "none"}. Mapping: ${ccMapping?.confidence || "low"}.`;
          mergedMeta.suggestion_debug = {
            taxonomy_type: taxHit.type,
            taxonomy_confidence: taxHit.confidence,
            cc_mapping_confidence: ccMapping?.confidence || "low",
          };
          const matched = ccMapping?.confidence === "high" && ccPaymentPair?.pairConfidence === "high";
          const ccMeta = withCategorizationPolicyVersion({
            ...mergedMeta,
            safe_to_auto_handle: false,
            safe_to_auto_post: false,
            auto_handle_decision: {
              eligible: matched,
              confidence: matched ? "high" : taxHit.confidence || "medium",
              source: "cc_payment_pairing",
              reason: matched ? "cc_payment_pair_matched" : ccPaymentPairResult?.reason || "cc_payment_pair_requires_confirmation",
              at: nowIso,
            },
          });
          await pushRow({
            txn: row,
            payload: {
              business_id: businessId,
              transaction_id: row.id,
              suggested_qbo_account_id: suggestedAcct?.id || null,
              suggested_qbo_account_name: suggestedAcct?.name || null,
              suggested_canonical_account_key: null,
              final_qbo_account_id: null,
              final_qbo_account_name: null,
              final_canonical_account_key: null,
              confidence: matched ? "high" : taxHit.confidence || "medium",
              reason: matched
                ? `Credit card payment matched to ${ccPaymentPair.counterpartAccountName || "opposite account"}.`
                : `Credit card payment needs matching before posting.`,
              status: matched ? "auto_approved" : "needs_review",
              post_after: null,
              post_error: matched ? null : ccPaymentPairResult?.reason || "cc_payment_pair_requires_confirmation",
              meta: ccMeta,
              updated_at: nowIso,
              decided_by: matched ? "bizzi" : "taxonomy",
              decided_at: nowIso,
            },
            meta: ccMeta,
            checkHit,
            taxonomyType: taxHit.type,
            confidenceOverride: matched ? "high" : taxHit.confidence || "medium",
            suggestionSource: "taxonomy",
          });
          if (matched) autoApproved += 1;
          else skipped += 1;
          continue;
        } else if (taxHit.type === "owner_draw" || taxHit.type === "owner_contribution") {
          const equityAcct = taxHit.type === "owner_draw" ? ownerEquityAccounts?.drawAcct : ownerEquityAccounts?.contribAcct;
          suggestedAcct = equityAcct || fallbacks.ama || null;
          mergedMeta.owner_move_equity_account_id = suggestedAcct?.id || null;
          mergedMeta.owner_move_equity_account_name = suggestedAcct?.name || null;
          mergedMeta.safe_to_auto_handle = false;
          mergedMeta.safe_to_auto_post = metaBase?.auto_approve_reason === "manual_user" ? true : false;
          if (metaBase?.auto_approve_reason === "manual_user") {
            mergedMeta.auto_approve_reason = "manual_user";
          } else {
            mergedMeta.auto_approve_reason = null;
          }
          status = "needs_review";
          reasonPrefix = `Taxonomy: ${taxHit.type} (${taxHit.confidence}) — Owner move (equity). Suggested: ${suggestedAcct?.name || "none"}.`;
        } else if (taxHit.type === "refund") {
          const orig = await findRefundOriginalTxn({
            businessId,
            refundTxn: row,
            bookkeepingStartDate,
            allowHistoricalContext: true,
          });
          if (orig?.accountId) {
            suggestedAcct = { id: orig.accountId, name: orig.accountName };
            mergedMeta.refund_match_source = "prior_txn";
            mergedMeta.refund_original_txn_id = orig.txnId;
            mergedMeta.refund_original_account_id = orig.accountId;
            mergedMeta.refund_original_account_name = orig.accountName;
            mergedMeta.refund_original_historical_context_only = !!orig.historicalContextOnly;
            const shortId = typeof orig.txnId === "string" ? orig.txnId.slice(0, 8) : orig.txnId;
            reasonPrefix = `Refund detected — matched prior transaction category ${orig.accountName || "unknown"}${shortId ? ` (txn ${shortId})` : ""}.`;
          } else {
            suggestedAcct = fallbacks.ama || fallbacks.expenseFallback || null;
            mergedMeta.refund_match_source = "none";
            reasonPrefix = `Taxonomy: refund (${taxHit.confidence}) — Refund detected. Suggested: ${suggestedAcct?.name || "none"}. Review before posting.`;
          }
          mergedMeta.safe_to_auto_handle = false;
          mergedMeta.safe_to_auto_post = false;
          mergedMeta.post_block_reason = mergedMeta.post_block_reason || "refund_posting_not_supported";
          mergedMeta.auto_approve_reason = metaBase?.auto_approve_reason === "manual_user" ? "manual_user" : null;
          status = "needs_review";
        }

        if (checkHit.is_check) {
          mergedMeta = enforceCheckNeverAutoApprove(mergedMeta);
          status = "needs_review";
        }

        devLog("taxonomy_hit", {
          txn: row.id,
          plaid_transaction_id: row.plaid_transaction_id,
          taxonomy_type: taxHit.type,
        });

        const autoResult = applyAutoApproval({
          status,
          confidence: taxHit.confidence || "high",
          meta: mergedMeta,
          checkHit,
          suggestedAcct,
          taxonomyType: taxHit.type,
          nowIso,
          reason: mergedMeta.auto_approve_reason || "taxonomy",
          autoApprove,
          autoPostEnabled,
          txnId: row.id,
          transaction: row,
          businessContext: { suspenseIds },
          evidence: {
            source: "taxonomy",
            safeToAutoHandle: mergedMeta.safe_to_auto_handle === true,
            verifiedCcPayment:
              taxHit.type === "cc_payment" &&
              mergedMeta.cc_payment_mapping_confidence === "high" &&
              mergedMeta.cc_payment_bank_qbo_account_id &&
              mergedMeta.cc_payment_cc_qbo_account_id,
          },
        });
        if (autoResult.status === "auto_approved" && !checkHit.is_check) autoApproved += 1;

        const payload = {
          business_id: businessId,
          transaction_id: row.id,
          suggested_qbo_account_id: suggestedAcct?.id || null,
          suggested_qbo_account_name: suggestedAcct?.name || null,
          confidence: taxHit.confidence || "high",
          reason: reasonPrefix,
          status: autoResult.status,
          meta: autoResult.meta,
          updated_at: nowIso,
          decided_by: autoResult.decidedBy || "taxonomy",
          decided_at: autoResult.decidedAt || nowIso,
        };
        if (taxHit.type === "cc_payment") payload.suggested_canonical_account_key = null;
        if (payload.status !== "auto_approved" && payload.status !== "approved" && payload.status !== "posted") {
          payload.final_qbo_account_id = null;
          payload.final_qbo_account_name = null;
          payload.final_canonical_account_key = null;
          payload.post_after = null;
        }
        if (autoResult.finalAcctId !== undefined) payload.final_qbo_account_id = autoResult.finalAcctId;
        if (autoResult.finalAcctName !== undefined) payload.final_qbo_account_name = autoResult.finalAcctName;
        if (autoResult.postAfter !== undefined) payload.post_after = autoResult.postAfter;
        await pushRow({
          txn: row,
          payload,
          meta: autoResult.meta,
          checkHit,
          taxonomyType: taxHit.type,
          confidenceOverride: taxHit.confidence || payload.confidence,
          suggestionSource: "taxonomy",
        });
        continue;
      }

      // Business-learned vendor rules are the strongest category signal and should win before global hints.
      rowBranch = "vendor_rule";
      const vendorRule = await getVendorRuleForTransaction({ businessId, bankTransaction: row });
      const vendorRuleApprovalBacked = hasUserApprovedVendorRuleMatch({
        vendorRule,
        similarUserApproval,
      });
      if (vendorRule && vendorRule.default_qbo_account_id && vendorRuleApprovalBacked) {
        if (!looksLikeTaxonomyLandmineMemo(row)) {
          const txnDir = canonicalTxnDirection(row);
          const hint = (vendorRule.direction_hint || "").toUpperCase();
          const directionMismatch = hint && hint !== "UNKNOWN" && txnDir !== "UNKNOWN" && hint !== txnDir;
          if (!directionMismatch) {
            if (checkHit.is_check) {
              const strongVendor =
                vendorRule.match_reason === "merchant_entity_id" ||
                (vendorRule.confidence || "").toLowerCase() === "high";
              const vendorMeta = {
                suggestion_source: "vendor_rule",
                user_approval_backed: true,
                user_approval_match_type: similarUserApproval?.match_type || null,
                user_approval_match_txn_id: similarUserApproval?.transaction_id || null,
                suggestion_debug: {
                  rule_id: vendorRule.id,
                  match_reason: vendorRule.match_reason,
                  match_score: vendorRule.match_score,
                },
                vendor_rule_id: vendorRule.id,
                vendor_rule_match_reason: vendorRule.match_reason,
                vendor_rule_match_score: vendorRule.match_score,
                vendor_rule_counterparty_name: vendorRule.counterparty_name || null,
                vendor_rule_coa_id: vendorRule.default_qbo_account_id || null,
                vendor_rule_coa_name: vendorRule.default_qbo_account_name || null,
              };
              const suggestedAcct = ensureAccountName({
                acctId: vendorRule.default_qbo_account_id,
                acctName: vendorRule.default_qbo_account_name,
                coa,
              });
              const vendorConfidence = strongVendor ? "high" : "medium";
              const meta = enforceCheckNeverAutoApprove({ ...baseMetaWithCheck, ...vendorMeta });
              await pushRow({
                txn: row,
                payload: {
                  business_id: businessId,
                  transaction_id: row.id,
                  suggested_qbo_account_id: suggestedAcct?.id || null,
                  suggested_qbo_account_name: suggestedAcct?.name || null,
                  confidence: vendorConfidence,
                  reason: strongVendor
                    ? "Check detected — suggested via vendor rule; review required"
                    : "Check detected — suggested via vendor rule (low certainty); review required",
                  status: "needs_review",
                  meta,
                  decided_by: "vendor_rule",
                  decided_at: nowIso,
                  updated_at: nowIso,
                },
                meta,
                checkHit,
                vendorRule,
                confidenceOverride: vendorConfidence,
                suggestionSource: "vendor_rule",
              });
              continue;
            }
            const ruleConf = (vendorRule.confidence || "").toLowerCase();
            let vendorConfidence = vendorRule.match_reason === "merchant_entity_id" ? "high" : "medium";
            let vendorSafeToAutoPost = vendorRule.match_reason === "merchant_entity_id";
            if (ruleConf === "low") {
              vendorConfidence = "medium";
              vendorSafeToAutoPost = false;
            }
            const vendorSuggested = ensureAccountName({
              acctId: vendorRule.default_qbo_account_id,
              acctName: vendorRule.default_qbo_account_name,
              coa,
            });
            const vendorSuspense = isSuspenseAccount({
              acctId: vendorSuggested.id,
              acctName: vendorSuggested.name,
              suspenseIds,
            });
            const vendorUsage = vendorRule?.usage_count || 0;
            const memoPrefixEligible =
              vendorRule.match_reason === "memo_prefix" &&
              vendorUsage >= VENDOR_RULE_MEMO_PREFIX_PROMOTE_MIN_USES &&
              !vendorSuspense;
            let vendorAutoApproveReason = vendorSafeToAutoPost ? "vendor_rule" : null;
            if (memoPrefixEligible && ruleConf !== "low") {
              vendorConfidence = "high";
              vendorSafeToAutoPost = true;
              vendorAutoApproveReason = "vendor_rule_learned";
              devLog("vendor_rule_promoted_memo_prefix", {
                txnId: row.id,
                usage_count: vendorUsage,
                threshold: VENDOR_RULE_MEMO_PREFIX_PROMOTE_MIN_USES,
              });
            }
            const vendorMeta = {
              suggestion_source: "vendor_rule",
              user_approval_backed: true,
              user_approval_match_type: similarUserApproval?.match_type || null,
              user_approval_match_txn_id: similarUserApproval?.transaction_id || null,
              suggestion_debug: {
                rule_id: vendorRule.id,
                match_reason: vendorRule.match_reason,
                match_score: vendorRule.match_score,
              },
              vendor_rule_id: vendorRule.id,
              vendor_rule_match_reason: vendorRule.match_reason,
              vendor_rule_match_score: vendorRule.match_score,
              vendor_rule_counterparty_name: vendorRule.counterparty_name || null,
              vendor_rule_coa_id: vendorSuggested.id || null,
              vendor_rule_coa_name: vendorSuggested.name || null,
              safe_to_auto_handle: vendorSafeToAutoPost,
              safe_to_auto_post: vendorSafeToAutoPost,
              auto_approve_reason: vendorAutoApproveReason,
            };
            if (metaBase?.auto_approve_reason === "manual_user") {
              vendorMeta.safe_to_auto_handle = metaBase.safe_to_auto_handle === true || metaBase.safe_to_auto_post === true;
              vendorMeta.safe_to_auto_post = metaBase.safe_to_auto_post === true;
              vendorMeta.auto_approve_reason = metaBase.auto_approve_reason;
              vendorMeta.suggestion_source = metaBase.suggestion_source || vendorMeta.suggestion_source;
            }
            if (checkHit.is_check) {
              vendorMeta.is_check = true;
              vendorMeta.check_confidence = vendorMeta.check_confidence || checkHit.confidence;
              vendorMeta.check_reason = vendorMeta.check_reason || checkHit.reason;
              if (checkHit.check_number && !vendorMeta.check_number) vendorMeta.check_number = checkHit.check_number;
              vendorMeta.taxonomy_flags = { ...(vendorMeta.taxonomy_flags || {}), is_check: true };
            }

            const autoResult = applyAutoApproval({
              status: "needs_review",
              confidence: vendorConfidence,
              meta: { ...baseMetaWithCheck, ...vendorMeta },
              checkHit,
              suggestedAcct: vendorSuggested.id
                ? { id: vendorSuggested.id, name: vendorSuggested.name }
                : null,
              taxonomyType: null,
              nowIso,
              reason: vendorMeta.auto_approve_reason || "vendor_rule",
              autoApprove,
              autoPostEnabled,
              txnId: row.id,
              transaction: row,
              businessContext: { suspenseIds },
              evidence: {
                source: "vendor_rule",
                safeToAutoHandle: vendorMeta.safe_to_auto_handle === true,
                weakRule: ruleConf === "low",
              },
            });
            if (autoResult.status === "auto_approved" && !checkHit.is_check) autoApproved += 1;

            devLog("vendor_rule_applied", {
              txn: row.id,
              plaid_transaction_id: row.plaid_transaction_id,
              match_reason: vendorRule.match_reason,
              coa: vendorRule.default_qbo_account_name,
            });

            const payload = {
              business_id: businessId,
              transaction_id: row.id,
              suggested_qbo_account_id: vendorSuggested.id,
              suggested_qbo_account_name: vendorSuggested.name,
              confidence: vendorConfidence,
              reason: `Vendor rule: ${vendorRule.counterparty_name || "Vendor"} -> ${vendorRule.default_qbo_account_name || "Selected account"} (${vendorRule.match_reason})`,
              status: autoResult.status,
              meta: autoResult.meta,
              decided_by: autoResult.decidedBy || "vendor_rule",
              decided_at: autoResult.decidedAt || nowIso,
              updated_at: nowIso,
            };
            if (payload.status !== "auto_approved" && payload.status !== "approved" && payload.status !== "posted") {
              payload.final_qbo_account_id = null;
              payload.final_qbo_account_name = null;
              payload.post_after = null;
            }
            if (autoResult.finalAcctId !== undefined) payload.final_qbo_account_id = autoResult.finalAcctId;
            if (autoResult.finalAcctName !== undefined) payload.final_qbo_account_name = autoResult.finalAcctName;
            if (autoResult.postAfter !== undefined) payload.post_after = autoResult.postAfter;
            await pushRow({
              txn: row,
              payload,
              meta: autoResult.meta,
              checkHit,
              vendorRule,
              confidenceOverride: vendorConfidence,
              suggestionSource: "vendor_rule",
            });
            continue;
          }
        }
      } else if (vendorRule && vendorRule.default_qbo_account_id && !vendorRuleApprovalBacked) {
        devLog("vendor_rule_deferred_to_universal", {
          txn: row.id,
          plaid_transaction_id: row.plaid_transaction_id,
          vendor_rule_id: vendorRule.id,
          has_any_user_approvals: userApprovalContext.hasAnyUserApprovals,
          user_approval_match_type: similarUserApproval?.match_type || null,
          user_approval_match_txn_id: similarUserApproval?.transaction_id || null,
          vendor_rule_account_id: vendorRule.default_qbo_account_id || null,
          approved_account_id: similarUserApproval?.final_qbo_account_id || null,
        });
      }

      rowBranch = "universal_hint";
      const universalHint = freshUniversalHint;
      if (universalHint) {
        const preferUniversalForTxn =
          !userApprovalContext.hasAnyUserApprovals || !vendorRuleApprovalBacked;
        const canonicalResolution = await resolveCanonicalQboAccount({
          businessId,
          intent: universalHint.primary_intent,
          transactionId: row.id,
          source: "suggest",
          allowCreate: allowQboAccountCreate,
        });
        if (canonicalResolution?.ok && canonicalResolution?.account?.id) {
          const hintSuggested = {
            id: canonicalResolution.account.id,
            name: canonicalResolution.account.name,
            type: canonicalResolution.account.type || canonicalResolution.account.AccountType || null,
            subType: canonicalResolution.account.subType || canonicalResolution.account.AccountSubType || null,
          };
          const mappedConfidence = universalHint.confidence || "medium";
          const hintConfidenceHigh = (universalHint?.confidence || "").toLowerCase() === "high";
          const strongPrimaryIntentMatch = canonicalResolution.review_required !== true;
          const safeUniversalHint = isUniversalHintAutoApproveSafe(universalHint);
          const learnedRecurringMatch =
            hasSimilarUserApproval &&
            String(similarUserApproval?.final_qbo_account_id || "") === String(hintSuggested.id || "") &&
            isUniversalIntentAutoApproveAllowed(universalHint.primary_intent) &&
            safeUniversalHint;
          const allowAuto =
            !checkHit.is_check &&
            (
              (
                hintConfidenceHigh &&
                strongPrimaryIntentMatch &&
                isUniversalIntentAutoApproveAllowed(universalHint.primary_intent) &&
                safeUniversalHint
              ) ||
              learnedRecurringMatch
            );
          const canonicalVendorEvidence = await resolveCanonicalVendorEvidenceForPromotion({
            businessId,
            row,
            taxonomyMeta: {
              ...baseMetaWithCheck,
              suggestion_source: "universal_hint",
              canonical_account_key: canonicalResolution.canonical?.canonical_account_key || null,
            },
          });
          const canonicalAccountResolved =
            canonicalResolution.review_required !== true &&
            Boolean(canonicalResolution.canonical?.canonical_account_key && hintSuggested.id);
          const merchantEvidenceStrong =
            canonicalVendorEvidence.merchantEvidenceStrong === true ||
            Boolean(row.merchant_entity_id) ||
            (Boolean(row.merchant_name) && safeUniversalHint === true);
          const hintMeta = {
            ...baseMetaWithCheck,
            suggestion_source: "universal_hint",
            user_approval_backed: hasSimilarUserApproval,
            user_approval_match_type: similarUserApproval?.match_type || null,
            user_approval_match_txn_id: similarUserApproval?.transaction_id || null,
            universal_bootstrap_mode: preferUniversalForTxn,
            universal_hint: {
              key: universalHint.matched_rule_key,
              canonical_vendor: universalHint.canonical_vendor,
              primary_intent: universalHint.primary_intent,
              intents: universalHint.intents,
              confidence: universalHint.confidence,
              match_type: universalHint.match_type || null,
              matched_value: universalHint.matched_value || null,
              canonical_account_key: canonicalResolution.canonical?.canonical_account_key || null,
              canonical_account_name: canonicalResolution.canonical?.preferred_account_name || null,
              canonical_resolution_status: canonicalResolution.status || null,
              created_coa: canonicalResolution.created === true
                ? {
                    created: true,
                    qbo_account_id: hintSuggested.id,
                    qbo_account_name: hintSuggested.name,
                    account_type: canonicalResolution.account.type || null,
                    account_subtype: canonicalResolution.account.subType || null,
                  }
                : null,
            },
            canonical_account_key: canonicalResolution.canonical?.canonical_account_key || null,
            intent_to_coa_match: { match_reason: canonicalResolution.status || "canonical_resolved" },
            canonical_coa_resolved: canonicalAccountResolved,
            canonical_vendor_id: canonicalVendorEvidence.canonicalVendorId || null,
            canonical_vendor_reliable: canonicalVendorEvidence.canonicalVendorReliable === true,
            canonical_vendor_resolution_reason: canonicalVendorEvidence.canonicalVendorResolutionReason || null,
            merchant_evidence_strong: merchantEvidenceStrong,
          };
          hintMeta.safe_to_auto_handle = allowAuto;
          hintMeta.safe_to_auto_post = allowAuto;
          hintMeta.auto_approve_reason = allowAuto ? (learnedRecurringMatch ? "learned_recurring" : "universal_hint") : null;
          const autoResult = applyAutoApproval({
            status: "needs_review",
            confidence: allowAuto ? "high" : mappedConfidence,
            meta: hintMeta,
            checkHit,
            suggestedAcct: { id: hintSuggested.id, name: hintSuggested.name },
            taxonomyType: null,
            nowIso,
            reason: hintMeta.auto_approve_reason || "universal_hint",
            autoApprove,
            autoPostEnabled,
            txnId: row.id,
            transaction: row,
            businessContext: { suspenseIds },
            evidence: {
              source: learnedRecurringMatch ? "learned_recurring" : "universal_hint",
              safeToAutoHandle: hintMeta.safe_to_auto_handle === true,
              canonicalVendorId: canonicalVendorEvidence.canonicalVendorId || null,
              canonicalVendorReliable: canonicalVendorEvidence.canonicalVendorReliable === true,
              weakVendorEvidence: canonicalVendorEvidence.weakVendorEvidence === true,
              merchantEvidenceStrong,
              canonicalAccountResolved,
              canonicalAccountKey: canonicalResolution.canonical?.canonical_account_key || null,
              canonicalAccountReviewRequired: canonicalResolution.review_required === true,
              inBookkeepingScope: true,
              reconsiderationSource: "page_suggest_universal",
            },
          });
          const hintSuspense = isSuspenseAccount({
            acctId: hintSuggested.id,
            acctName: hintSuggested.name,
            suspenseIds,
          });
          if (autoResult.status === "auto_approved" && allowAuto && !checkHit.is_check && !hintSuspense) {
            const hasVendorSignal =
              Boolean(row.merchant_entity_id) ||
              Boolean(row.counterparty_name) ||
              Boolean(row.merchant_name) ||
              Boolean(row.qbo_entity_id);
            if (!hasVendorSignal) {
              devLog("auto_learn_vendor_rule_skipped", {
                txnId: row.id,
                learnedFrom: "universal_hint",
                reason: "no_vendor_signal",
              });
            } else {
              const learnResult = await autoLearnVendorRuleFromAutoApproval({
                businessId,
                bankTxn: row,
                finalAccountId: hintSuggested.id,
                finalAccountName: hintSuggested.name,
                taxonomyType: metaBase?.taxonomy_type || null,
                learnedFrom: "universal_hint",
              });
              if (learnResult?.ok && learnResult?.rule) {
                devLog("auto_learn_vendor_rule", {
                  txnId: row.id,
                  learnedFrom: "universal_hint",
                  rule: learnResult.rule,
                });
              } else if (learnResult?.ok && learnResult?.skipped) {
                devLog("auto_learn_vendor_rule_skipped", {
                  txnId: row.id,
                  learnedFrom: "universal_hint",
                  reason: learnResult.reason || "unknown",
                });
              }
            }
          }
          if (autoResult.status === "auto_approved" && !checkHit.is_check) autoApproved += 1;
          devLog("universal_hint_hit", {
            txn: row.id,
            plaid_transaction_id: row.plaid_transaction_id,
            key: universalHint.matched_rule_key,
            intent: universalHint.primary_intent,
            canonical_account_key: canonicalResolution.canonical?.canonical_account_key || null,
            coa: hintSuggested.name,
            match_reason: canonicalResolution.status,
          });
          const payload = {
            business_id: businessId,
            transaction_id: row.id,
            suggested_qbo_account_id: hintSuggested.id,
            suggested_qbo_account_name: hintSuggested.name,
            suggested_canonical_account_key: canonicalResolution.canonical?.canonical_account_key || null,
            confidence: allowAuto ? "high" : mappedConfidence,
            reason: `Universal vendor hint: ${universalHint.canonical_vendor} -> ${universalHint.primary_intent} -> ${canonicalResolution.canonical?.preferred_account_name || hintSuggested.name}`,
            status: autoResult.status,
            meta: autoResult.meta,
            decided_by: autoResult.decidedBy || "universal_hint",
            decided_at: autoResult.decidedAt || nowIso,
            updated_at: nowIso,
          };
          if (payload.status !== "auto_approved" && payload.status !== "approved" && payload.status !== "posted") {
            payload.final_qbo_account_id = null;
            payload.final_qbo_account_name = null;
            payload.final_canonical_account_key = null;
            payload.post_after = null;
          }
          if (autoResult.finalAcctId !== undefined) payload.final_qbo_account_id = autoResult.finalAcctId;
          if (autoResult.finalAcctName !== undefined) payload.final_qbo_account_name = autoResult.finalAcctName;
          if (autoResult.finalAcctId !== undefined) payload.final_canonical_account_key = canonicalResolution.canonical?.canonical_account_key || null;
          if (autoResult.postAfter !== undefined) payload.post_after = autoResult.postAfter;
          await pushRow({
            txn: row,
            payload,
            meta: autoResult.meta,
            checkHit,
            universalHintKey: universalHint.matched_rule_key,
            confidenceOverride: mappedConfidence,
            suggestionSource: "universal_hint",
          });
          continue;
        } else {
          devLog("universal_hint_no_coa_match", {
            txn: row.id,
            plaid_transaction_id: row.plaid_transaction_id,
            key: universalHint.matched_rule_key,
            intent: universalHint.primary_intent,
            canonical_reason: canonicalResolution?.reason || null,
          });
          if (isStrongUniversalVendorEvidence(universalHint)) {
            const canonicalKey =
              canonicalResolution?.canonical?.canonical_account_key ||
              resolveIntentToCanonicalKey(universalHint.primary_intent) ||
              null;
            const meta = {
              ...baseMetaWithCheck,
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
                canonical_account_key: canonicalKey,
                canonical_account_name: canonicalResolution?.canonical?.preferred_account_name || null,
                canonical_resolution_status: canonicalResolution?.status || null,
              },
              canonical_account_key: canonicalKey,
              canonical_coa_resolved: false,
              canonical_account_review_required: true,
              canonical_setup_required: true,
              canonical_setup_required_reason: canonicalResolution?.reason || "canonical_account_requires_review",
              safe_to_auto_handle: false,
              safe_to_auto_post: false,
              auto_handle_decision: {
                eligible: false,
                confidence: universalHint.confidence || "high",
                source: "universal_hint",
                reason: canonicalResolution?.reason || "canonical_setup_required",
                at: nowIso,
              },
            };
            await pushRow({
              txn: row,
              payload: {
                business_id: businessId,
                transaction_id: row.id,
                suggested_qbo_account_id: null,
                suggested_qbo_account_name: null,
                suggested_canonical_account_key: canonicalKey,
                final_qbo_account_id: null,
                final_qbo_account_name: null,
                final_canonical_account_key: null,
                confidence: universalHint.confidence || "high",
                reason: `Universal vendor hint: ${universalHint.canonical_vendor} -> ${universalHint.primary_intent}; canonical QBO setup required`,
                status: "needs_review",
                post_after: null,
                meta,
                decided_by: "universal_hint",
                decided_at: nowIso,
                updated_at: nowIso,
              },
              meta,
              checkHit,
              universalHintKey: universalHint.matched_rule_key,
              confidenceOverride: universalHint.confidence || "high",
              suggestionSource: "universal_hint",
            });
            continue;
          }
        }
      }

      rowBranch = "check_block";
      if (checkHit.is_check) {
        const dir = (row.direction || "").toUpperCase();
        const suggestedAcct =
          dir === "OUTFLOW"
            ? fallbacks.expenseFallback || fallbacks.ama || null
            : dir === "INFLOW"
            ? fallbacks.incomeFallback || fallbacks.ama || null
            : fallbacks.ama || null;
        const meta = enforceCheckNeverAutoApprove({
          ...baseMetaWithCheck,
          suggestion_source: "check_block",
          suggestion_debug: { reason: "check_detected", ...executionPolicy },
        });
        await pushRow({
          txn: row,
          payload: {
            business_id: businessId,
            transaction_id: row.id,
            suggested_qbo_account_id: suggestedAcct?.id || null,
            suggested_qbo_account_name: suggestedAcct?.name || null,
            confidence: "low",
            reason: "Check detected — needs clarification",
            status: "needs_review",
            meta,
            decided_by: "plaid_baseline",
            decided_at: nowIso,
            updated_at: nowIso,
          },
          meta,
          checkHit,
          confidenceOverride: "low",
          suggestionSource: "check_block",
        });
        continue;
      }

      rowBranch = "plaid_baseline";
      const mapped = mapPlaidToCoa(row, coaMap, fallbacks);
      const acct = mapped.account;
      const mappedSuggested = ensureAccountName({
        acctId: acct?.id || null,
        acctName: acct?.name || null,
        coa,
      });
      const confidence = mapped.confidence || "low";
      const suggestionSource =
        mapped.reason && mapped.reason.toLowerCase().includes("fallback")
          ? "fallback"
          : mapped.account
          ? "plaid_mapping"
          : "unknown";
      let newMeta = {
        ...baseMetaWithCheck,
        safe_to_auto_handle: confidence === "high",
        safe_to_auto_post: confidence === "high",
        auto_approve_reason: confidence === "high" ? "model_high" : null,
        suggestion_source: suggestionSource,
        suggestion_debug: {
          mapping_reason: mapped.reason || null,
          ...executionPolicy,
        },
      };
      if (metaBase?.auto_approve_reason === "manual_user") {
        newMeta.safe_to_auto_handle = metaBase.safe_to_auto_handle === true || metaBase.safe_to_auto_post === true;
        newMeta.safe_to_auto_post = metaBase.safe_to_auto_post === true;
        newMeta.auto_approve_reason = metaBase.auto_approve_reason;
        newMeta.suggestion_source = metaBase.suggestion_source || suggestionSource;
      }
      if (checkHit.is_check) {
        newMeta = enforceCheckNeverAutoApprove(newMeta);
        newMeta.is_check = true;
        newMeta.check_confidence = newMeta.check_confidence || checkHit.confidence;
        newMeta.check_reason = newMeta.check_reason || checkHit.reason;
        if (checkHit.check_number && !newMeta.check_number) newMeta.check_number = checkHit.check_number;
        newMeta.taxonomy_flags = { ...(newMeta.taxonomy_flags || {}), is_check: true };
      }
      const status =
        checkHit.is_check
          ? "needs_review"
          : "needs_review";
      const autoResult = applyAutoApproval({
        status,
        confidence,
        meta: newMeta,
        checkHit,
        suggestedAcct: mappedSuggested.id ? { id: mappedSuggested.id, name: mappedSuggested.name } : null,
        taxonomyType: newMeta?.taxonomy_type || null,
        nowIso,
        reason: newMeta.auto_approve_reason || "model_high",
        autoApprove,
        autoPostEnabled,
        txnId: row.id,
        transaction: row,
        businessContext: { suspenseIds },
        evidence: {
          source: suggestionSource,
          safeToAutoHandle: newMeta.safe_to_auto_handle === true,
        },
      });
      if (autoResult.status === "auto_approved" && !checkHit.is_check) autoApproved += 1;

      const mappedSuspense = isSuspenseAccount({
        acctId: mappedSuggested.id,
        acctName: mappedSuggested.name,
        suspenseIds,
      });
      if (!mappedSuggested.id || mappedSuspense) {
        devLog("categorization_fallthrough", {
          txn: row.id,
          plaid_transaction_id: row.plaid_transaction_id,
          source: suggestionSource,
          mapping_reason: mapped.reason || null,
          suggested_qbo_account_id: mappedSuggested.id || null,
          suggested_qbo_account_name: mappedSuggested.name || null,
          suspense_account: mappedSuspense,
          merchant_name: row.merchant_name || null,
          counterparty_name: row.counterparty_name || null,
          name: row.name || null,
          category_primary: row.category_primary || null,
        });
      }

      devLog("mapping_used", {
        txn: row.id,
        plaid_transaction_id: row.plaid_transaction_id,
        source: suggestionSource,
        confidence,
      });

      const payload = {
        business_id: businessId,
        transaction_id: row.id,
        suggested_qbo_account_id: mappedSuggested.id || null,
        suggested_qbo_account_name: mappedSuggested.name || null,
        confidence,
        reason: mapped.reason || "",
        status: autoResult.status,
        meta: autoResult.meta,
        decided_by: autoResult.decidedBy || "plaid_baseline",
        decided_at: autoResult.decidedAt || nowIso,
        updated_at: nowIso,
      };
      if (autoResult.finalAcctId !== undefined) payload.final_qbo_account_id = autoResult.finalAcctId;
      if (autoResult.finalAcctName !== undefined) payload.final_qbo_account_name = autoResult.finalAcctName;
      if (autoResult.postAfter !== undefined) payload.post_after = autoResult.postAfter;
      await pushRow({
        txn: row,
        payload,
        meta: autoResult.meta,
        checkHit,
        confidenceOverride: confidence,
        suggestionSource: suggestionSource,
      });
      } catch (rowErr) {
        skipped += 1;
        const errPayload = {
          transaction_id: row?.id || null,
          plaid_transaction_id: row?.plaid_transaction_id || null,
          branch: rowBranch,
          error: rowErr?.message || String(rowErr),
        };
        rowErrors.push(errPayload);
        if (process.env.NODE_ENV !== "production") {
          console.error("[bookkeeping][suggest][row_failed]", {
            business_id: businessId,
            ...errPayload,
          });
        }
        continue;
      }
    }

    if (!rows.length) {
      if (metaBackfills.length) {
        const { error: backfillErr } = await supabase
          .from("transaction_categorizations")
          .upsert(metaBackfills, { onConflict: "business_id,transaction_id" });
        if (backfillErr) {
          devLog("meta_backfill_skipped", {
            business_id: businessId,
            count: metaBackfills.length,
            error: backfillErr?.message || String(backfillErr),
          });
        }
      }
      await refreshOperatorRequestSummaryBestEffort({
        businessId,
        reason: "bookkeeping_suggestion_pass",
      });
      return {
        ok: true,
        updated: 0,
        auto_approved: autoApproved,
        skipped,
        meta_backfilled: metaBackfilled,
        row_error_count: rowErrors.length,
        row_errors: rowErrors,
        sample: [],
      };
    }

    if (metaBackfills.length) {
      const { error: backfillErr } = await supabase
        .from("transaction_categorizations")
        .upsert(metaBackfills, { onConflict: "business_id,transaction_id" });
      if (backfillErr) {
        devLog("meta_backfill_skipped", {
          business_id: businessId,
          count: metaBackfills.length,
          error: backfillErr?.message || String(backfillErr),
        });
      }
    }

    const normalizedRows = rows.map((row) => ({
      ...row,
      decided_by: row.decided_by || "bizzi",
      decided_at: row.decided_at || nowIso,
      updated_at: row.updated_at || nowIso,
    }));

    const { data: upserted, error: upErr } = await supabase
      .from("transaction_categorizations")
      .upsert(normalizedRows, { onConflict: "business_id,transaction_id" })
      .select("transaction_id,suggested_qbo_account_id,suggested_qbo_account_name,confidence,status,reason,meta");
    if (upErr) throw upErr;

    await refreshOperatorRequestSummaryBestEffort({
      businessId,
      reason: "bookkeeping_suggestion_pass",
    });

    return {
      ok: true,
      updated: upserted?.length || 0,
      auto_approved: autoApproved,
      skipped,
      meta_backfilled: metaBackfilled,
      row_error_count: rowErrors.length,
      row_errors: rowErrors,
      sample: (upserted || []).slice(0, 3),
    };
  } catch (err) {
    console.error("[bookkeeping][suggest] failed", {
      message: err?.message || String(err),
      stack: err?.stack || null,
    });
    throw err;
  }
}

router.post("/suggest", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;

  try {
    const result = await runBookkeepingSuggestionPass({
      businessId,
      body: req.body || {},
      query: req.query || {},
      user: req.user || null,
    });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: "suggest_failed", message: err?.message || "failed" });
  }
});

router.post("/suggest/reconsider", requireAuth, async (req, res) => {
  const body = req.body || {};
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;

  try {
    const result = await reconsiderNeedsReviewTransactions(businessId, {
      range: body.range || req.query?.range || "this_month",
      dateFrom: body.date_from || body.dateFrom || null,
      dateTo: body.date_to || body.dateTo || null,
      accountId: body.account_id || body.accountId || null,
      cursor: body.cursor || null,
      limit: body.limit || 200,
      source: body.source || "api_reconsideration",
    });
    return res.json(result);
  } catch (err) {
    console.error("[bookkeeping][suggest][reconsider] failed", {
      business_id: businessId,
      message: err?.message || String(err),
    });
    return res.status(500).json({ ok: false, error: "reconsider_failed", message: err?.message || "failed" });
  }
});

export default router;
