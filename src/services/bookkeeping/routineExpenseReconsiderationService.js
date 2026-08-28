import { isCheck } from "./checkDetector.js";
import { computePostAfterForAutoPost, getAutoPostToQuickBooks } from "./autoPostControl.js";
import { getBookkeepingStartDate, isTransactionInActiveBookkeepingScope } from "./bookkeepingScope.js";
import { isReviewAccount } from "./autoHandlingPolicy.js";
import { decideBookkeepingCategorization } from "./bookkeepingCategorizationDecisionService.js";
import { resolveCanonicalVendorForTransaction } from "./canonicalVendorService.js";
import { resolveCanonicalQboAccount, validateCanonicalQboAccountForPromotion } from "./canonicalQboAccountResolver.js";
import { resolveIntentToCanonicalKey } from "./canonicalCoaRegistry.js";
import { mapIntentToCoa } from "./intentToCoaMapper.js";
import { getUniversalVendorHintForTransaction } from "./universalVendorHintMatcher.js";
import { getVendorRuleForTransaction } from "./vendorRuleMatcher.js";
import { canonicalTxnDirection, looksLikeTaxonomyLandmineMemo } from "./vendorRuleLearner.js";
import {
  isStrongUniversalVendorEvidence,
  isSpecificUniversalVendorEvidence,
  withCategorizationPolicyVersion,
} from "./categorizationEvidencePolicy.js";

const MAX_RECONSIDERATION_LIMIT = 500;
const PNL_ACCOUNT_TYPES = new Set(["income", "other income", "expense", "cost of goods sold", "costofgoodssold"]);
const PROTECTED_TAXONOMY_RE = /cc_payment|transfer|owner|loan|payroll|tax|refund|check/i;
const SAFE_SEMANTIC_FALLBACK_INTENTS = new Set([
  "bank_fees",
  "payment_processing",
  "parking_tolls",
  "transportation",
  "gas_charging",
  "fuel",
  "meals",
  "sales",
  "other_income",
]);

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

function categorizationProvenance(cat = {}, fallback = "backlog_reconsideration") {
  return String(cat.decided_by || fallback || "bizzi").trim() || "bizzi";
}

function accountFromCategorization(cat = {}) {
  return {
    id: cat.suggested_qbo_account_id || cat.final_qbo_account_id || null,
    name: cat.suggested_qbo_account_name || cat.final_qbo_account_name || null,
  };
}

function normalizeText(value = "") {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function stripBusinessSuffix(value = "") {
  return normalizeText(value)
    .replace(/\b(?:llc|l l c|inc|incorporated|corp|corporation|co|company|ltd|limited)\b/g, " ")
    .replace(/\bthe\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function merchantIdentityKeys(txn = {}) {
  const raw = [txn.merchant_name, txn.counterparty_name, txn.name]
    .filter(Boolean)
    .flatMap((value) => {
      const normalized = normalizeText(value);
      const stripped = stripBusinessSuffix(value);
      const compact = stripped.replace(/\s+/g, "");
      const firstTokens = stripped.split(" ").slice(0, 3).join(" ");
      return [normalized, stripped, compact.length >= 7 ? compact : null, firstTokens.length >= 7 ? firstTokens : null];
    })
    .filter(Boolean);
  return [...new Set(raw)];
}

function isPnlAccount(account = {}) {
  const type = normalizeText(account.type || account.accountType || account.AccountType || "");
  return PNL_ACCOUNT_TYPES.has(type);
}

function transactionText(txn = {}) {
  return normalizeText([
    txn.name,
    txn.merchant_name,
    txn.counterparty_name,
    txn.category_primary,
    txn.category_detailed,
    typeof txn.personal_finance_category === "string" ? txn.personal_finance_category : null,
    txn.personal_finance_category?.primary,
    txn.personal_finance_category?.detailed,
  ].filter(Boolean).join(" "));
}

function transactionDirection(txn = {}) {
  const direction = String(txn.direction || "").toUpperCase();
  if (direction === "INFLOW" || direction === "OUTFLOW") return direction;
  const amount = Number(txn.signed_amount ?? txn.amount);
  if (Number.isFinite(amount) && amount > 0) return "INFLOW";
  if (Number.isFinite(amount) && amount < 0) return "OUTFLOW";
  return "UNKNOWN";
}

function suggestedIntentFromAccountName(accountName = "") {
  const name = normalizeText(accountName);
  if (/\bmeal|restaurant|dining|food|coffee\b/.test(name)) return "meals";
  if (/\btransport|parking|toll|travel|lyft|uber\b/.test(name)) return "transportation";
  if (/\bgas|fuel|charging\b/.test(name)) return "gas_charging";
  if (/\bsoftware|subscription|dues\b/.test(name)) return "software";
  if (/\binsurance\b/.test(name)) return "insurance";
  if (/\bbank fee|bank charge|processing fee|transaction fee\b/.test(name)) return "bank_fees";
  if (/\bsales|service income|revenue|income\b/.test(name)) return "sales";
  if (/\bcash back|cashback|rewards?|statement credit|credit card rewards?\b/.test(name)) return "other_income";
  if (/\bentertainment|movies|theater|theatre|event\b/.test(name)) return "entertainment";
  if (/\bsupplies|materials\b/.test(name)) return "supplies";
  return null;
}

function hasDeterministicMediumSuggestionEvidence({ bankTxn = {}, account = {}, meta = {}, universalHint = null }) {
  if (!account?.id || !account?.name || !isPnlAccount(account)) return false;
  if (PROTECTED_TAXONOMY_RE.test(String(meta.taxonomy_type || ""))) return false;
  if (meta.conflicting_categorization_evidence === true) return false;
  const source = normalizeSource(meta.evidence_source || meta.suggestion_source || "");
  if (!["plaid_mapping", "plaid_baseline", "backlog_reconsideration"].includes(source)) return false;
  const intent = suggestedIntentFromAccountName(account.name);
  if (!intent) return false;
  const text = transactionText(bankTxn);
  if (!text) return false;
  if (intent === "meals") {
    return /\btst\b|\bcafe\b|\bcoffee\b|\bcocktail\b|\bbar\b|\bwhiskey\b|\brestaurant\b|\brestaurants\b|\bfood\b|\bdining\b|\bgrill\b|\bkitchen\b|\bchick\b|\bchipotle\b|\bcava\b|\bamelie\b|\byamazaru\b|\bsumaq\b|\bcarillon\b|\bexchange\b|\bbarcelona\b|\bsloan\b|\bpub\b|\bbistro\b|\btavern\b/.test(text);
  }
  if (intent === "transportation") {
    return /\bparking\b|\bpark\b|\btoll\b|\bsurface lot\b|\bpps\b|\bquiktrip\b|\bqt\b|\buber\b|\blyft\b|\btaxi\b/.test(text) ||
      ["parking_tolls", "transportation", "fuel", "gas_charging"].includes(String(universalHint?.primary_intent || ""));
  }
  if (intent === "gas_charging") {
    return /\bgas\b|\bfuel\b|\bchargeonsite\b|\bcharging\b|\bquiktrip\b|\bqt\b|\bmobil\b|\bshell\b/.test(text) ||
      ["fuel", "gas_charging"].includes(String(universalHint?.primary_intent || ""));
  }
  if (intent === "software" || intent === "insurance") {
    return String(universalHint?.primary_intent || "") === intent;
  }
  return false;
}

function deriveIntentFromTransaction(bankTxn = {}, meta = {}) {
  const text = transactionText(bankTxn);
  if (!text) return null;
  if (/\bstatement credit\b|\bautomatic statement credit\b|\bcash ?back\b|\brewards?\b/.test(text)) return "other_income";
  if (/\btran fee\b|\btransaction fee\b|\bbank fee\b|\bbank fees\b|\blate fee\b|\bfinance charge\b|\bservice charge\b|\bprocessing fee\b|\bmerchant fee\b/.test(text)) return "bank_fees";
  if (/\bparkmobile\b|\bpark mobile\b|\bparking\b|\bparking lot\b|\bsurface lot\b|\btoll\b|\btolls\b|\bcdot pay\b|\bpps\b/.test(text)) return "parking_tolls";
  if (/\bchargeonsite\b|\bcharging\b|\bev charge\b|\bgas\b|\bfuel\b|\bquiktrip\b|\bquicktrip\b|\bqt\b/.test(text)) return "gas_charging";
  if (/\bopenai\b|\bchatgpt\b|\bsoftware\b|\bsubscription\b|\bsubscriptions\b|\bsaas\b/.test(text)) return "software";
  if (/\btst\b|\bcafe\b|\bcoffee\b|\bcocktail\b|\bbar\b|\bwhiskey\b|\brestaurant\b|\brestaurants\b|\bfood\b|\bdining\b|\bgrill\b|\bkitchen\b|\bchick\b|\bchipotle\b|\bcava\b|\bamelie\b|\byamazaru\b|\bsumaq\b|\bcarillon\b|\bexchange\b|\bbarcelona\b|\bsloan\b|\bpub\b|\bbistro\b|\btavern\b/.test(text)) return "meals";
  if (/\bentertainment\b|\bmovie\b|\bmovies\b|\btheater\b|\btheatre\b|\bcinema\b|\bamc\b/.test(text)) return "entertainment";
  if (/\bsupplies\b|\bsupply\b/.test(text)) return "supplies";
  if (/\bsales\b|\brevenue\b|\bincome\b/.test(text) && transactionDirection(bankTxn) === "INFLOW") return "sales";
  return meta?.suggested_intent || null;
}

function statementCreditRewardsEvidence({ bankTxn = {}, account = {}, meta = {}, universalHint = null }) {
  const intent = suggestedIntentFromAccountName(account?.name);
  const text = transactionText(bankTxn);
  const direction = transactionDirection(bankTxn);
  const type = normalizeText(account?.type || account?.accountType || account?.AccountType || "");
  const rewardText = /\bstatement credit\b|\bautomatic statement credit\b|\bcash ?back\b|\brewards?\b|\bcredit card rewards?\b/.test(text);
  const rewardHint = ["other_income", "interest_income"].includes(String(universalHint?.primary_intent || "")) ||
    String(meta?.suggested_intent || "") === "other_income";
  return (
    direction === "INFLOW" &&
    type.includes("income") &&
    (intent === "other_income" || /\breward|cash back|statement credit\b/.test(normalizeText(account?.name || ""))) &&
    (rewardText || rewardHint)
  );
}

async function buildBusinessHistoryIndex({ db, businessId }) {
  const { data: cats, error: catErr } = await db
    .from("transaction_categorizations")
    .select("transaction_id,business_id,status,final_qbo_account_id,final_qbo_account_name,confidence,meta,decided_by")
    .eq("business_id", businessId)
    .in("status", ["approved", "auto_approved"])
    .not("final_qbo_account_id", "is", null);
  if (catErr) throw catErr;
  const finalCats = (cats || []).filter((row) => row?.final_qbo_account_id && row?.final_qbo_account_name);
  if (!finalCats.length) return new Map();
  const ids = finalCats.map((row) => row.transaction_id).filter(Boolean);
  const { data: txns, error: txnErr } = await db
    .from("bank_transactions")
    .select("id,business_id,date,name,merchant_name,merchant_entity_id,counterparty_name,amount,signed_amount,direction,pending,is_archived")
    .eq("business_id", businessId)
    .in("id", ids);
  if (txnErr) throw txnErr;
  const catByTxn = new Map(finalCats.map((row) => [String(row.transaction_id), row]));
  const index = new Map();
  for (const txn of txns || []) {
    if (!txn?.id || txn.is_archived === true || txn.pending === true) continue;
    const cat = catByTxn.get(String(txn.id));
    if (!cat) continue;
    const direction = transactionDirection(txn);
    for (const key of merchantIdentityKeys(txn)) {
      const entry = index.get(key) || { accounts: new Map(), directions: new Map(), transactionIds: new Set() };
      const accountKey = String(cat.final_qbo_account_id);
      const current = entry.accounts.get(accountKey) || {
        id: accountKey,
        name: cat.final_qbo_account_name,
        count: 0,
        sources: new Set(),
      };
      current.count += 1;
      current.sources.add(cat.decided_by || cat.meta?.evidence_source || cat.meta?.suggestion_source || "history");
      entry.accounts.set(accountKey, current);
      entry.directions.set(accountKey, direction);
      entry.transactionIds.add(String(txn.id));
      index.set(key, entry);
    }
  }
  return index;
}

function findBusinessHistoryAccount({ historyIndex, bankTxn = {} }) {
  if (!historyIndex?.size) return null;
  const matches = [];
  for (const key of merchantIdentityKeys(bankTxn)) {
    const entry = historyIndex.get(key);
    if (!entry) continue;
    for (const account of entry.accounts.values()) {
      matches.push({
        id: account.id,
        name: account.name,
        count: account.count,
        sources: [...account.sources],
        matched_key: key,
        prior_transaction_count: entry.transactionIds.size,
      });
    }
  }
  if (!matches.length) return null;
  const merged = new Map();
  for (const match of matches) {
    const existing = merged.get(match.id) || { ...match, count: 0, sources: new Set(), matched_keys: new Set() };
    existing.count += match.count;
    match.sources.forEach((source) => existing.sources.add(source));
    existing.matched_keys.add(match.matched_key);
    existing.prior_transaction_count = Math.max(existing.prior_transaction_count || 0, match.prior_transaction_count || 0);
    merged.set(match.id, existing);
  }
  const unique = [...merged.values()];
  if (unique.length !== 1) {
    return { conflict: true, accounts: unique.map((item) => ({ id: item.id, name: item.name })) };
  }
  const only = unique[0];
  return {
    id: only.id,
    name: only.name,
    count: only.count,
    sources: [...only.sources],
    matched_keys: [...only.matched_keys],
    prior_transaction_count: only.prior_transaction_count,
  };
}

function canUseUniversalIntentForResolution(hint = null) {
  if (!hint?.primary_intent) return false;
  if (hint.confidence === "high") return true;
  return ["entertainment", "supplies", "software", "insurance"].includes(String(hint.primary_intent));
}

function emptyBuckets() {
  return {
    reviewed: 0,
    moved_to_handled: 0,
    still_needs_review: 0,
    pending: 0,
    protected_workflow: 0,
    suspense_no_specific_gl: 0,
    valid_gl_policy_blocked: 0,
    other: 0,
  };
}

function bucketForResult({ promoted = false, reason = "", bankTxn = {}, account = {}, meta = {} } = {}) {
  if (promoted) return "moved_to_handled";
  if (bankTxn.pending === true || reason === "pending_transaction_not_postable") return "pending";
  if (PROTECTED_TAXONOMY_RE.test(String(meta.taxonomy_type || "")) || PROTECTED_TAXONOMY_RE.test(String(reason || ""))) return "protected_workflow";
  if (!account?.id || !account?.name || isReviewAccount({ accountId: account.id, accountName: account.name })) return "suspense_no_specific_gl";
  if (reason === "medium_confidence_requires_review" || reason === "low_confidence_requires_review" || reason === "canonical_account_not_resolved") {
    return "valid_gl_policy_blocked";
  }
  return "other";
}

async function fetchActiveQboAccounts({ businessId, dependencies = {} }) {
  if (!businessId) return [];
  const getQBOClient = dependencies.getQBOClient || (async (id) => {
    const mod = await import("../../utils/qboClient.js");
    return mod.getQBOClient(id);
  });
  try {
    const qbo = await getQBOClient(businessId);
    if (!qbo?.findAccounts) return [];
    const result = await new Promise((resolve, reject) => {
      qbo.findAccounts({ Active: true }, (err, data) => {
        if (err) return reject(err);
        return resolve(data);
      });
    });
    const accounts = Array.isArray(result?.QueryResponse?.Account) ? result.QueryResponse.Account : [];
    return accounts
      .filter((account) => account?.Active !== false)
      .map((account) => ({
        id: String(account.Id || account.id),
        name: account.Name || account.name || null,
        type: account.AccountType || account.type || null,
        subType: account.AccountSubType || account.subType || null,
      }))
      .filter((account) => account.id && account.name);
  } catch {
    return [];
  }
}

async function fetchActiveQboAccountById({ businessId, accountId, fallbackName = null, db, dependencies = {} }) {
  void db;
  if (!businessId || !accountId) return null;
  const accounts = await fetchActiveQboAccounts({ businessId, dependencies });
  const hit = accounts.find((account) => String(account.id) === String(accountId));
  if (!hit) return null;
  return {
    id: hit.id,
    name: hit.name || fallbackName || String(accountId),
    type: hit.type || null,
    subType: hit.subType || null,
  };
}

async function resolveStrongSemanticCoaAccount({ businessId, intent, dependencies = {} }) {
  if (!businessId || !intent) return null;
  const accounts = await fetchActiveQboAccounts({ businessId, dependencies });
  if (!accounts.length) return null;
  const match = mapIntentToCoa({
    businessId,
    intent,
    coaAccounts: accounts,
    allowSemanticFallbackForCanonicalOnly: true,
  });
  if (!match?.qbo_account_id || !match?.qbo_account_name) return null;
  const account = accounts.find((item) => String(item.id) === String(match.qbo_account_id));
  if (!account) return null;
  const score = Number(match.score || 0);
  if (!Number.isFinite(score) || score < 32) return null;
  return {
    id: account.id,
    name: account.name,
    type: account.type || null,
    subType: account.subType || null,
    match,
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
  let transactionIds = Array.isArray(options.transactionIds)
    ? Array.from(new Set(options.transactionIds.map((id) => (id ? String(id) : null)).filter(Boolean)))
    : [];

  if (!transactionIds.length && (rangeStart || dateTo || options.accountId)) {
    let scopedTxnQuery = db
      .from("bank_transactions")
      .select("id")
      .eq("business_id", businessId)
      .eq("is_archived", false)
      .order("id", { ascending: true });
    if (options.accountId) scopedTxnQuery = scopedTxnQuery.eq("plaid_account_id", options.accountId);
    if (rangeStart) scopedTxnQuery = scopedTxnQuery.gte("date", rangeStart);
    if (dateTo) scopedTxnQuery = scopedTxnQuery.lte("date", dateTo);
    const { data: scopedTxns, error: scopedTxnErr } = await scopedTxnQuery;
    if (scopedTxnErr) throw scopedTxnErr;
    transactionIds = (scopedTxns || []).map((row) => row.id).filter(Boolean).map(String);
    if (!transactionIds.length) {
      return {
        ok: true,
        processed: 0,
        promoted: 0,
        skipped: 0,
        bucket_counts: emptyBuckets(),
        next_cursor: null,
        rows: [],
      };
    }
  }

  let catQuery = db
    .from("transaction_categorizations")
    .select("transaction_id,business_id,status,suggested_qbo_account_id,suggested_qbo_account_name,suggested_canonical_account_key,final_canonical_account_key,confidence,meta,final_qbo_account_id,final_qbo_account_name,decided_by,decided_at,post_after,qbo_txn_id")
    .eq("business_id", businessId)
    .in("status", ["needs_review", "uncategorized"])
    .is("qbo_txn_id", null)
    .order("transaction_id", { ascending: true })
    .limit(limit);
  if (transactionIds.length) catQuery = catQuery.in("transaction_id", transactionIds);
  if (cursor) catQuery = catQuery.gt("transaction_id", cursor);

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
  const businessHistoryIndex = await buildBusinessHistoryIndex({ db, businessId });

  const updates = [];
  const rows = [];
  const bucketCounts = emptyBuckets();
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
    bucketCounts.reviewed += 1;
    if (!isTransactionInActiveBookkeepingScope(bankTxn, bookkeepingStartDate)) {
      skipped += 1;
      bucketCounts.other += 1;
      continue;
    }
    if (answeredAwaitingReview.has(String(cat.transaction_id))) {
      skipped += 1;
      bucketCounts.other += 1;
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
          conflictingEvidence: meta.conflicting_categorization_evidence === true,
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
        bucketCounts.moved_to_handled += 1;
        rows.push({
          transaction_id: cat.transaction_id,
          promoted: true,
          reason: decision.reason,
          categorization: {
            status: "auto_approved",
            final_qbo_account_id: account.id,
            final_qbo_account_name: account.name,
            suggested_qbo_account_id: account.id,
            suggested_qbo_account_name: account.name,
            post_after: postAfter,
            qbo_txn_id: null,
            meta: decisionMeta,
          },
        });
        continue;
      }
      skipped += 1;
      const blockReason = decision.block_reason || decision.reason;
      bucketCounts[bucketForResult({ reason: blockReason, bankTxn, account, meta })] += 1;
      rows.push({ transaction_id: cat.transaction_id, promoted: false, reason: blockReason });
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
        decided_by: categorizationProvenance(cat, "vendor_rule"),
        decided_at: cat.decided_at || null,
        meta: {
          ...decisionMeta,
          auto_handled_reason: decision.block_reason || decision.reason,
        },
        updated_at: nowIso,
      });
      continue;
    }
    const businessHistory = findBusinessHistoryAccount({ historyIndex: businessHistoryIndex, bankTxn });
    if (businessHistory?.conflict === true) {
      const reason = "conflicting_business_history";
      skipped += 1;
      bucketCounts.other += 1;
      rows.push({ transaction_id: cat.transaction_id, promoted: false, reason });
      updates.push({
        business_id: businessId,
        transaction_id: cat.transaction_id,
        suggested_qbo_account_id: cat.suggested_qbo_account_id || null,
        suggested_qbo_account_name: cat.suggested_qbo_account_name || null,
        suggested_canonical_account_key: cat.suggested_canonical_account_key || meta.canonical_account_key || null,
        final_qbo_account_id: null,
        final_qbo_account_name: null,
        final_canonical_account_key: null,
        confidence: cat.confidence || "medium",
        status: cat.status || "needs_review",
        post_after: null,
        decided_by: categorizationProvenance(cat, "business_history"),
        decided_at: cat.decided_at || null,
        meta: withCategorizationPolicyVersion({
          ...meta,
          conflicting_categorization_evidence: true,
          business_history_conflict: businessHistory.accounts,
          auto_handle_decision: {
            eligible: false,
            confidence: cat.confidence || "medium",
            source: "business_history",
            reason,
            reconsideration_source: options.source || "backlog_reconsideration",
            at: nowIso,
          },
        }),
        updated_at: nowIso,
      });
      continue;
    }
    if (businessHistory?.id) {
      const account = await fetchActiveQboAccountById({
        businessId,
        accountId: businessHistory.id,
        fallbackName: businessHistory.name,
        db,
        dependencies,
      });
      const decision = decideBookkeepingCategorization({
        transaction: bankTxn,
        account: account || { id: businessHistory.id, name: businessHistory.name },
        evidence: {
          source: "business_history",
          confidenceTier: "very_high",
          taxonomyType: meta.taxonomy_type || null,
          isCheck: false,
          meta,
          canonicalAccountResolved: true,
          canonicalVendorId: bankTxn.canonical_vendor_id || meta.canonical_vendor_id || null,
          canonicalVendorReliable: true,
          merchantEvidenceStrong: true,
          conflictingEvidence: meta.conflicting_categorization_evidence === true,
          inBookkeepingScope: true,
          reconsiderationSource: options.source || "backlog_reconsideration",
          reason: "prior_business_final_account_history",
        },
        businessContext: {},
      });
      const decisionMeta = withCategorizationPolicyVersion({
        ...meta,
        suggestion_source: "business_history",
        evidence_source: "business_history",
        confidence_tier: "very_high",
        business_history_account_id: businessHistory.id,
        business_history_account_name: businessHistory.name,
        business_history_match_keys: businessHistory.matched_keys,
        business_history_prior_transaction_count: businessHistory.prior_transaction_count,
        business_history_sources: businessHistory.sources,
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
            auto_approve_reason: "prior_business_final_account_history",
            auto_handled_reason: decision.reason,
          },
          updated_at: nowIso,
        });
        promoted += 1;
        bucketCounts.moved_to_handled += 1;
        rows.push({
          transaction_id: cat.transaction_id,
          promoted: true,
          reason: decision.reason,
          categorization: {
            status: "auto_approved",
            final_qbo_account_id: account.id,
            final_qbo_account_name: account.name,
            suggested_qbo_account_id: account.id,
            suggested_qbo_account_name: account.name,
            post_after: postAfter,
            qbo_txn_id: null,
            meta: decisionMeta,
          },
        });
        continue;
      }
      skipped += 1;
      const blockReason = decision.block_reason || decision.reason;
      bucketCounts[bucketForResult({ reason: blockReason, bankTxn, account, meta })] += 1;
      rows.push({ transaction_id: cat.transaction_id, promoted: false, reason: blockReason });
      continue;
    }
    const universalHint = await getUniversalVendorHintForTransaction({ bankTxn });
    if (!checkHit.is_check && canUseUniversalIntentForResolution(universalHint)) {
      const specificMediumEvidence = universalHint?.confidence === "medium" && !isStrongUniversalVendorEvidence(universalHint);
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
      const canonicalResolvedAccount =
        canonicalResolution?.ok && canonicalResolution?.account?.id && canonicalResolution?.review_required !== true
          ? {
              id: String(canonicalResolution.account.id),
              name: canonicalResolution.account.name || canonicalResolution.account.fullyQualifiedName || null,
              type: canonicalResolution.account.type || canonicalResolution.account.AccountType || null,
              subType: canonicalResolution.account.subType || canonicalResolution.account.AccountSubType || null,
            }
          : { id: null, name: null };
      let account = canonicalResolvedAccount.id
        ? await fetchActiveQboAccountById({
            businessId,
            accountId: canonicalResolvedAccount.id,
            fallbackName: canonicalResolvedAccount.name,
            db,
            dependencies,
          }) || { id: null, name: null }
        : { id: null, name: null };
      let semanticResolution = null;
      if (!account.id) {
        semanticResolution = await resolveStrongSemanticCoaAccount({
          businessId,
          intent: universalHint.primary_intent,
          dependencies,
        });
        if (semanticResolution?.id && semanticResolution?.name) {
          account = {
            id: semanticResolution.id,
            name: semanticResolution.name,
            type: semanticResolution.type,
            subType: semanticResolution.subType,
          };
        }
      }
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
      const allowStatementCredit = statementCreditRewardsEvidence({ bankTxn, account, meta, universalHint });
      const exactCanonicalAccountResolved = Boolean(canonicalResolvedAccount.id && account?.id && !semanticResolution);
      const resolvedAccount = Boolean(account.id && account.name);
      const semanticAccountResolved = Boolean(semanticResolution?.id && semanticResolution?.name);
      const decisionConfidenceTier =
        (specificMediumEvidence && isSpecificUniversalVendorEvidence(universalHint)) || semanticAccountResolved
          ? "high"
          : universalHint.confidence || "high";
      const decision = decideBookkeepingCategorization({
        transaction: bankTxn,
        account,
        evidence: {
          source: specificMediumEvidence
            ? "specific_universal_vendor"
            : semanticAccountResolved
            ? "universal_hint_semantic_coa"
            : "universal_hint",
          confidenceTier: decisionConfidenceTier,
          taxonomyType: meta.taxonomy_type || null,
          isCheck: false,
          meta,
          canonicalAccountResolved: resolvedAccount,
          canonicalAccountKey: canonicalResolution?.canonical?.canonical_account_key || canonicalKey || null,
          canonicalAccountReviewRequired: resolvedAccount !== true,
          canonicalVendorId: vendorEvidence.canonicalVendorId || null,
          canonicalVendorReliable: vendorEvidence.canonicalVendorReliable === true,
          weakVendorEvidence: vendorEvidence.weakVendorEvidence === true,
          merchantEvidenceStrong:
            vendorEvidence.merchantEvidenceStrong === true ||
            Boolean(bankTxn.merchant_entity_id || bankTxn.merchant_name || bankTxn.counterparty_name),
          allowTaxonomyAutoHandle: allowStatementCredit,
          taxonomyAutoHandleReason: allowStatementCredit ? "statement_credit_rewards_income" : null,
          conflictingEvidence: meta.conflicting_categorization_evidence === true,
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
          evidence_tier: specificMediumEvidence ? "specific_consistent" : universalHint.confidence || "high",
          match_type: universalHint.match_type || null,
          matched_value: universalHint.matched_value || null,
          canonical_account_key: canonicalResolution?.canonical?.canonical_account_key || canonicalKey || null,
          canonical_account_name: canonicalResolution?.canonical?.preferred_account_name || null,
          canonical_resolution_status: canonicalResolution?.status || null,
        },
        canonical_account_key: canonicalResolution?.canonical?.canonical_account_key || canonicalKey || null,
        canonical_coa_resolved: exactCanonicalAccountResolved,
        semantic_coa_resolved: semanticAccountResolved,
        semantic_coa_match: semanticResolution?.match || null,
        canonical_account_review_required: resolvedAccount !== true,
        canonical_setup_required: resolvedAccount !== true,
        canonical_setup_required_reason: canonicalResolution?.reason || null,
        canonical_vendor_id: vendorEvidence.canonicalVendorId || null,
        canonical_vendor_reliable: vendorEvidence.canonicalVendorReliable === true,
        merchant_evidence_strong: decision.evidence?.merchantEvidenceStrong === true,
        taxonomy_auto_handle_reason: allowStatementCredit ? "statement_credit_rewards_income" : null,
        evidence_source: decision.evidence_source,
        confidence_tier: decision.confidence_tier,
        original_confidence: universalHint.confidence || null,
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
          final_canonical_account_key: semanticAccountResolved ? null : canonicalResolution?.canonical?.canonical_account_key || canonicalKey || null,
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
        bucketCounts.moved_to_handled += 1;
        rows.push({
          transaction_id: cat.transaction_id,
          promoted: true,
          reason: decision.reason,
          categorization: {
            status: "auto_approved",
            final_qbo_account_id: account.id,
            final_qbo_account_name: account.name,
            final_canonical_account_key: semanticAccountResolved ? null : canonicalResolution?.canonical?.canonical_account_key || canonicalKey || null,
            suggested_qbo_account_id: account.id,
            suggested_qbo_account_name: account.name,
            suggested_canonical_account_key: canonicalResolution?.canonical?.canonical_account_key || canonicalKey || null,
            confidence: universalHint.confidence || "high",
            post_after: postAfter,
            qbo_txn_id: null,
            meta: decisionMeta,
          },
        });
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
        decided_by: categorizationProvenance(cat, "universal_hint"),
        decided_at: cat.decided_at || null,
        meta: {
          ...decisionMeta,
          auto_handled_reason: decision.reason || canonicalResolution?.reason || "canonical_setup_required",
        },
        updated_at: nowIso,
      });
      skipped += 1;
      const blockReason = decision.block_reason || decision.reason || canonicalResolution?.reason || "canonical_setup_required";
      bucketCounts[bucketForResult({ reason: blockReason, bankTxn, account, meta })] += 1;
      rows.push({ transaction_id: cat.transaction_id, promoted: false, reason: blockReason });
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
    const categorizationAccount = accountFromCategorization(cat);
    const activeSuggestedAccount = categorizationAccount.id
      ? await fetchActiveQboAccountById({
          businessId,
          accountId: categorizationAccount.id,
          fallbackName: categorizationAccount.name,
          db,
          dependencies,
        })
      : null;
    let semanticResolution = null;
    const derivedIntent = deriveIntentFromTransaction(bankTxn, meta);
    const semanticIntent = universalHint?.primary_intent || derivedIntent;
    if (
      (!activeSuggestedAccount || isReviewAccount({ accountId: activeSuggestedAccount.id, accountName: activeSuggestedAccount.name })) &&
      semanticIntent &&
      SAFE_SEMANTIC_FALLBACK_INTENTS.has(String(semanticIntent))
    ) {
      semanticResolution = await resolveStrongSemanticCoaAccount({
        businessId,
        intent: semanticIntent,
        dependencies,
      });
    }
    const canonicalResolvedAccount =
      canonicalAccount.account?.id && canonicalAccount.account?.name
        ? canonicalAccount.account
        : null;
    const account = canonicalResolvedAccount || semanticResolution || activeSuggestedAccount || categorizationAccount;
    const canonicalKey = canonicalAccount.canonicalAccountKey || canonicalAccountKey(cat, meta);
    const vendorEvidence = await resolveVendorEvidence({ db, businessId, bankTxn, meta });
    const deterministicMediumEvidence = hasDeterministicMediumSuggestionEvidence({
      bankTxn,
      account,
      meta,
      universalHint,
    });
    const allowStatementCredit = statementCreditRewardsEvidence({ bankTxn, account, meta, universalHint });
    const canonicalAccountResolved =
      canonicalAccount.canonicalAccountResolved === true ||
      Boolean(semanticResolution?.id) ||
      deterministicMediumEvidence === true ||
      allowStatementCredit === true;
    const semanticAccountResolved = Boolean(semanticResolution?.id);
    const source = semanticAccountResolved
      ? "semantic_coa_fallback"
      : normalizeSource(meta.suggestion_source || cat.decided_by || "backlog_reconsideration");
    const confidenceTier = semanticAccountResolved || allowStatementCredit ? "high" : cat.confidence || meta.confidence || "medium";
    const decision = decideBookkeepingCategorization({
      transaction: bankTxn,
      account,
      evidence: {
        source,
        confidenceTier,
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
        canonicalVendorReliable: vendorEvidence.canonicalVendorReliable === true || semanticAccountResolved === true,
        weakVendorEvidence: vendorEvidence.weakVendorEvidence === true,
        merchantEvidenceStrong:
          vendorEvidence.merchantEvidenceStrong === true ||
          deterministicMediumEvidence === true ||
          semanticAccountResolved === true ||
          allowStatementCredit === true ||
          Boolean(bankTxn.merchant_name && meta.suggestion_source === "universal_hint"),
        deterministicMediumEvidence,
        allowTaxonomyAutoHandle: allowStatementCredit,
        taxonomyAutoHandleReason: allowStatementCredit ? "statement_credit_rewards_income" : null,
        conflictingEvidence: meta.conflicting_categorization_evidence === true,
        reason: allowStatementCredit
          ? "statement_credit_rewards_income"
          : semanticAccountResolved
          ? "safe_semantic_coa_fallback"
          : deterministicMediumEvidence
          ? "deterministic_medium_suggestion"
          : undefined,
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
      deterministic_medium_evidence: deterministicMediumEvidence,
      semantic_coa_resolved: Boolean(semanticResolution?.id),
      semantic_intent: semanticIntent || null,
      semantic_intent_source: universalHint?.primary_intent ? "universal_hint" : derivedIntent ? "transaction_evidence" : null,
      semantic_coa_match: semanticResolution?.match || null,
      taxonomy_auto_handle_reason: allowStatementCredit ? "statement_credit_rewards_income" : null,
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
      const blockReason = decision.block_reason || decision.reason;
      bucketCounts[bucketForResult({ reason: blockReason, bankTxn, account, meta })] += 1;
      rows.push({ transaction_id: cat.transaction_id, promoted: false, reason: blockReason });
      updates.push({
        business_id: businessId,
        transaction_id: cat.transaction_id,
        suggested_qbo_account_id: account?.id || cat.suggested_qbo_account_id || null,
        suggested_qbo_account_name: account?.name || cat.suggested_qbo_account_name || null,
        suggested_canonical_account_key: cat.suggested_canonical_account_key || canonicalKey || null,
        final_qbo_account_id: null,
        final_qbo_account_name: null,
        final_canonical_account_key: null,
        confidence: confidenceTier,
        status: cat.status || "needs_review",
        post_after: null,
        decided_by: categorizationProvenance(cat, source || "backlog_reconsideration"),
        decided_at: cat.decided_at || null,
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
      confidence: confidenceTier,
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
    bucketCounts.moved_to_handled += 1;
    rows.push({
      transaction_id: cat.transaction_id,
      promoted: true,
      reason: decision.reason,
      categorization: {
        status: "auto_approved",
        final_qbo_account_id: account.id,
        final_qbo_account_name: account.name,
        final_canonical_account_key: canonicalKey,
        suggested_qbo_account_id: account.id,
        suggested_qbo_account_name: account.name,
        suggested_canonical_account_key: canonicalKey,
        confidence: confidenceTier,
        post_after: postAfter,
        qbo_txn_id: null,
        meta: withCategorizationPolicyVersion({
          ...decisionMeta,
          auto_approve_reason: decisionMeta.auto_approve_reason || "routine_expense_fully_resolved",
          auto_handled_reason: decision.reason,
        }),
      },
    });
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
    bucket_counts: {
      ...bucketCounts,
      still_needs_review: skipped,
    },
    next_cursor: catRows.length === limit ? last : null,
    rows,
  };
}

export default {
  reconsiderNeedsReviewTransactions,
};
