import crypto from "crypto";
import { qboEnvName } from "../../utils/qboEnv.js";
import { canAutoHandle } from "./autoHandlingPolicy.js";
import { computePostAfterForAutoPost, getAutoPostToQuickBooks } from "./autoPostControl.js";
import { getBookkeepingStartDate, isTransactionInActiveBookkeepingScope } from "./bookkeepingScope.js";
import { isCheck } from "./checkDetector.js";
import {
  ACCOUNTANT_REVIEW_REQUIRED,
  AUTO_CREATE_ALLOWED,
  CANONICAL_MAPPING_STATUSES,
  getApprovedEquivalentNames,
  getCanonicalAccountByKey,
  getCanonicalAccountForIntent,
  isApprovedEquivalentName,
  normalizeCanonicalName,
  resolveIntentToCanonicalKey,
} from "./canonicalCoaRegistry.js";

const ACTIVE_RESOLVED_STATUSES = new Set([
  CANONICAL_MAPPING_STATUSES.EXISTING_EXACT,
  CANONICAL_MAPPING_STATUSES.EXISTING_APPROVED_EQUIVALENT,
  CANONICAL_MAPPING_STATUSES.CREATED_BY_BIZZI,
]);

async function getDefaultSupabase() {
  const mod = await import("../supabaseAdmin.js");
  return mod.supabase;
}

async function getDefaultQboClient(businessId) {
  const mod = await import("../../utils/qboClient.js");
  return mod.getQBOClient(businessId);
}

async function getDefaultLatestQuickBooksTokenRow(businessId) {
  const mod = await import("../quickbooksTokenService.js");
  return mod.getLatestQuickBooksTokenRow(businessId);
}

function compactRequestId(input = "") {
  return crypto.createHash("sha256").update(String(input)).digest("hex").slice(0, 40);
}

function normalizeQboType(value = "") {
  return String(value || "").replace(/[\s\-_]+/g, "").toLowerCase();
}

function qboTypeCompatible(canonical = {}, account = {}) {
  const expected = normalizeQboType(canonical.qbo_account_type);
  const actual = normalizeQboType(account.type || account.AccountType || account.account_type);
  if (!expected || !actual) return false;
  if (expected === actual) return true;
  if (expected === "costofgoodssold" && actual === "costofgoodsold") return true;
  return false;
}

function qboAccountCompatibleForApproval(canonical = {}, account = {}) {
  if (!qboTypeCompatible(canonical, account)) return false;
  const expectedSubType = normalizeQboType(canonical.qbo_account_subtype);
  const actualSubType = normalizeQboType(account.subType || account.AccountSubType || account.account_subtype);
  if (!expectedSubType || !actualSubType) return true;
  return expectedSubType === actualSubType;
}

function shapeQboAccount(account = {}) {
  return {
    id: account.id || account.Id || account.qbo_account_id || null,
    name: account.name || account.Name || account.qbo_account_name || null,
    fullyQualifiedName: account.fullyQualifiedName || account.FullyQualifiedName || account.fully_qualified_name || null,
    type: account.type || account.AccountType || account.account_type || null,
    subType: account.subType || account.AccountSubType || account.account_subtype || account.qbo_account_subtype || null,
    active: account.active ?? account.Active ?? true,
    syncToken: account.syncToken || account.SyncToken || account.sync_token || null,
    raw: account.raw || account,
  };
}

function findExactCanonicalAccount(coa = [], canonical = {}) {
  const expected = normalizeCanonicalName(canonical.preferred_account_name);
  if (!expected) return null;
  return (coa || [])
    .map(shapeQboAccount)
    .find((acct) => acct.active !== false && normalizeCanonicalName(acct.name) === expected && qboTypeCompatible(canonical, acct)) || null;
}

function findApprovedEquivalentAccount(coa = [], canonical = {}) {
  const preferred = normalizeCanonicalName(canonical.preferred_account_name);
  const names = getApprovedEquivalentNames(canonical.canonical_account_key)
    .map(normalizeCanonicalName)
    .filter((name) => name && name !== preferred);
  if (!names.length) return null;
  return (coa || [])
    .map(shapeQboAccount)
    .find((acct) => acct.active !== false && names.includes(normalizeCanonicalName(acct.name)) && qboTypeCompatible(canonical, acct)) || null;
}

function findAmbiguousCandidates(coa = [], canonical = {}) {
  const tokenSet = (value = "") =>
    normalizeCanonicalName(value)
      .split(" ")
      .filter((token) => token && !["and", "the", "of", "for"].includes(token));
  const canonicalTokens = tokenSet(canonical.preferred_account_name);
  if (!canonicalTokens.length) return null;
  return (coa || [])
    .map(shapeQboAccount)
    .filter((acct) => acct.active !== false && qboTypeCompatible(canonical, acct))
    .map((acct) => {
      const tokens = tokenSet(acct.name);
      const common = canonicalTokens.filter((token) => tokens.includes(token));
      const score = common.length / Math.max(canonicalTokens.length, tokens.length, 1);
      return { acct, score };
    })
    .filter((entry) => entry.score > 0 && !isApprovedEquivalentName(canonical.canonical_account_key, entry.acct.name))
    .filter((entry) => entry.score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.acct);
}

function findAmbiguousCandidate(coa = [], canonical = {}) {
  return findAmbiguousCandidates(coa, canonical)[0] || null;
}

function findUnreviewedAmbiguousCandidate(coa = [], canonical = {}, reviewedCandidateId = null) {
  const candidates = findAmbiguousCandidates(coa, canonical);
  if (!reviewedCandidateId) return candidates[0] || null;
  return candidates.find((acct) => String(acct.id || "") !== String(reviewedCandidateId)) || null;
}

async function getRealmContext({ businessId, getLatestQuickBooksTokenRow }) {
  const tokenRow = await getLatestQuickBooksTokenRow(businessId);
  return {
    realmId: tokenRow?.realm_id || null,
    qboEnv: tokenRow?.qbo_env || qboEnvName || "production",
  };
}

async function logMappingEvent({ supabase, businessId, realmId, qboEnv, canonical, account = null, eventType, source = "resolver", transactionId = null, intent = null, reason = null, metadata = {} }) {
  try {
    await supabase.from("qbo_account_mapping_events").insert({
      business_id: businessId,
      realm_id: realmId || null,
      qbo_env: qboEnv || qboEnvName || "production",
      canonical_account_key: canonical?.canonical_account_key || null,
      qbo_account_id: account?.id || null,
      qbo_account_name: account?.name || null,
      event_type: eventType,
      source,
      transaction_id: transactionId || null,
      intent_key: intent || null,
      actor: metadata?.actor || "bizzi",
      reason,
      metadata,
    });
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[canonical-coa] event log skipped", err?.message || err);
    }
  }
}

async function upsertQboCache({ supabase, businessId, realmId, qboEnv, accounts = [] }) {
  const nowIso = new Date().toISOString();
  const rows = (accounts || [])
    .map(shapeQboAccount)
    .filter((acct) => acct.id && acct.name)
    .map((acct) => ({
      business_id: businessId,
      realm_id: realmId,
      qbo_env: qboEnv,
      qbo_account_id: String(acct.id),
      name: acct.name,
      fully_qualified_name: acct.fullyQualifiedName || null,
      account_type: acct.type || null,
      account_subtype: acct.subType || null,
      active: acct.active !== false,
      sync_token: acct.syncToken || null,
      raw: acct.raw || {},
      last_synced_at: nowIso,
      updated_at: nowIso,
    }));
  if (!rows.length || !realmId) return;
  try {
    await supabase.from("qbo_accounts_cache").upsert(rows, {
      onConflict: "business_id,qbo_env,realm_id,qbo_account_id",
    });
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[canonical-coa] cache upsert skipped", err?.message || err);
    }
  }
}

async function fetchLiveQboAccounts({ businessId, getQBOClient }) {
  const qbo = await getQBOClient(businessId);
  if (!qbo) return { qbo: null, accounts: [] };
  const data = await new Promise((resolve, reject) => {
    qbo.findAccounts({ Active: true }, (err, res) => {
      if (err) return reject(err);
      resolve(res);
    });
  });
  const accounts = Array.isArray(data?.QueryResponse?.Account) ? data.QueryResponse.Account : [];
  return {
    qbo,
    accounts: accounts
      .filter((acct) => acct.AccountType && !/header/i.test(acct.Classification || ""))
      .map(shapeQboAccount),
  };
}

async function fetchStoredMapping({ supabase, businessId, realmId, qboEnv, canonicalKey }) {
  const { data, error } = await supabase
    .from("business_canonical_qbo_account_mappings")
    .select("*")
    .eq("business_id", businessId)
    .eq("realm_id", realmId)
    .eq("qbo_env", qboEnv)
    .eq("canonical_account_key", canonicalKey)
    .in("status", Array.from(ACTIVE_RESOLVED_STATUSES))
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function upsertMapping({ supabase, businessId, realmId, qboEnv, canonical, account, status, source = "resolver", transactionId = null, intent = null, metadata = {} }) {
  const nowIso = new Date().toISOString();
  const row = {
    business_id: businessId,
    realm_id: realmId,
    qbo_env: qboEnv,
    canonical_account_key: canonical.canonical_account_key,
    qbo_account_id: account?.id ? String(account.id) : null,
    qbo_account_name: account?.name || null,
    qbo_account_type: account?.type || canonical.qbo_account_type || null,
    qbo_account_subtype: account?.subType || canonical.qbo_account_subtype || null,
    status,
    mapping_source: source,
    created_by: metadata?.created_by || "bizzi",
    mapped_by: metadata?.mapped_by || "bizzi",
    mapped_at: nowIso,
    first_transaction_id: transactionId || null,
    first_intent_key: intent || null,
    metadata,
    updated_at: nowIso,
  };
  const { data, error } = await supabase
    .from("business_canonical_qbo_account_mappings")
    .upsert(row, { onConflict: "business_id,qbo_env,realm_id,canonical_account_key" })
    .select("*")
    .maybeSingle();
  if (error) throw error;
  await logMappingEvent({
    supabase,
    businessId,
    realmId,
    qboEnv,
    canonical,
    account,
    eventType: status,
    source,
    transactionId,
    intent,
    reason: metadata?.reason || status,
    metadata,
  });
  return data || row;
}

async function markNeedsReview({ supabase, businessId, realmId, qboEnv, canonical, transactionId = null, intent = null, reason, candidate = null, source = "resolver" }) {
  const nowIso = new Date().toISOString();
  const candidateMetadata = candidate
    ? {
        candidate_id: candidate.id || null,
        candidate_name: candidate.name || null,
        candidate_type: candidate.type || null,
        candidate_subtype: candidate.subType || null,
      }
    : { candidate_name: null };
  const row = {
    business_id: businessId,
    realm_id: realmId,
    qbo_env: qboEnv,
    canonical_account_key: canonical.canonical_account_key,
    qbo_account_id: candidate?.id || null,
    qbo_account_name: candidate?.name || null,
    qbo_account_type: candidate?.type || canonical.qbo_account_type || null,
    qbo_account_subtype: candidate?.subType || canonical.qbo_account_subtype || null,
    status: CANONICAL_MAPPING_STATUSES.NEEDS_REVIEW,
    mapping_source: source,
    review_reason: reason,
    first_transaction_id: transactionId || null,
    first_intent_key: intent || null,
    metadata: { reason, ...candidateMetadata },
    updated_at: nowIso,
  };
  try {
    await supabase.from("business_canonical_qbo_account_mappings").upsert(row, {
      onConflict: "business_id,qbo_env,realm_id,canonical_account_key",
    });
  } catch {
    // A resolved mapping may already exist under the partial unique index; resolution remains read-only.
  }
  await logMappingEvent({
    supabase,
    businessId,
    realmId,
    qboEnv,
    canonical,
    account: candidate,
    eventType: CANONICAL_MAPPING_STATUSES.NEEDS_REVIEW,
    source,
    transactionId,
    intent,
    reason,
    metadata: candidateMetadata,
  });
  return {
    ok: false,
    status: CANONICAL_MAPPING_STATUSES.NEEDS_REVIEW,
    canonical,
    account: candidate,
    reason,
    review_required: true,
  };
}

async function claimCreationIntent({ supabase, businessId, realmId, qboEnv, canonical, requestId, transactionId, intent }) {
  const { data, error } = await supabase.rpc("claim_qbo_account_creation_intent", {
    p_business_id: businessId,
    p_realm_id: realmId,
    p_qbo_env: qboEnv,
    p_canonical_account_key: canonical.canonical_account_key,
    p_request_id: requestId,
    p_payload_summary: {
      Name: canonical.preferred_account_name,
      AccountType: canonical.qbo_account_type,
      AccountSubType: canonical.qbo_account_subtype || null,
    },
    p_transaction_id: transactionId || null,
    p_intent_key: intent || null,
  });
  if (error) throw error;
  return data || {};
}

async function recordCreationIntentOutcome({ supabase, businessId, realmId, qboEnv, canonical, status, account = null, error = null, response = null }) {
  const patch = {
    status,
    qbo_account_id: account?.id || null,
    qbo_account_name: account?.name || null,
    response_summary: response || (account ? { id: account.id, name: account.name, type: account.type } : null),
    last_error: error ? { message: error?.message || String(error) } : null,
    lease_expires_at: null,
    updated_at: new Date().toISOString(),
  };
  await supabase
    .from("qbo_account_creation_intents")
    .update(patch)
    .eq("business_id", businessId)
    .eq("realm_id", realmId)
    .eq("qbo_env", qboEnv)
    .eq("canonical_account_key", canonical.canonical_account_key);
}

async function createQboAccountFromCanonical({ qbo, canonical, requestId }) {
  const payload = {
    requestId,
    Name: canonical.preferred_account_name,
    AccountType: canonical.qbo_account_type,
    ...(canonical.qbo_account_subtype ? { AccountSubType: canonical.qbo_account_subtype } : {}),
  };
  const fn = qbo?.account && typeof qbo.account.create === "function" ? qbo.account.create : qbo?.createAccount;
  if (!fn) throw new Error("qbo_create_not_supported");
  const data = await new Promise((resolve, reject) => {
    fn.call(qbo, payload, (err, res) => {
      if (err) return reject(err);
      resolve(res);
    });
  });
  const acct = data?.Account || data?.account || data || null;
  if (!acct?.Id && !acct?.id) throw new Error("qbo_create_missing_id");
  return shapeQboAccount(acct);
}

function buildRecommendation({ mapping = {}, candidateUsage = {} } = {}) {
  const reason = String(mapping.review_reason || mapping.metadata?.reason || "");
  const usageCount = Number(candidateUsage.transaction_count || 0);
  if (reason === "ambiguous_candidate_requires_review" && usageCount > 0) {
    return {
      action: "use_existing",
      label: "Use Existing Account",
      reason: "Candidate has prior usage; using it avoids fragmenting historical reporting.",
    };
  }
  if (reason === "ambiguous_candidate_requires_review") {
    return {
      action: "create_bizzi_preferred",
      label: "Create Bizzi Preferred Account",
      reason: "Candidate has no visible prior usage; the Bizzi account gives cleaner reporting.",
    };
  }
  return {
    action: "review",
    label: "Review Required",
    reason: "Account policy requires a human decision before resolving this mapping.",
  };
}

async function fetchAffectedCanonicalTransactions({ supabase, businessId, canonicalKey }) {
  const ids = new Set();
  try {
    const { data, error } = await supabase
      .from("qbo_account_mapping_events")
      .select("transaction_id")
      .eq("business_id", businessId)
      .eq("canonical_account_key", canonicalKey)
      .eq("event_type", CANONICAL_MAPPING_STATUSES.NEEDS_REVIEW);
    if (error) throw error;
    (data || []).forEach((row) => {
      if (row.transaction_id) ids.add(row.transaction_id);
    });
  } catch {
    // Event evidence is best-effort for display; mappings remain authoritative.
  }
  return Array.from(ids);
}

async function fetchCandidateUsageEvidence({ supabase, businessId, account = null }) {
  if (!account?.id && !account?.name) {
    return {
      qbo_account_id: null,
      qbo_account_name: null,
      qbo_account_type: null,
      qbo_account_subtype: null,
      transaction_count: 0,
      earliest_transaction_date: null,
      latest_transaction_date: null,
    };
  }
  let rows = [];
  try {
    const { data, error } = await supabase
      .from("transaction_categorizations")
      .select("transaction_id,suggested_qbo_account_id,suggested_qbo_account_name,final_qbo_account_id,final_qbo_account_name")
      .eq("business_id", businessId);
    if (error) throw error;
    rows = (data || []).filter((row) => {
      const id = String(account.id || "");
      const name = normalizeCanonicalName(account.name || "");
      return (
        (id && (String(row.final_qbo_account_id || "") === id || String(row.suggested_qbo_account_id || "") === id)) ||
        (name && (normalizeCanonicalName(row.final_qbo_account_name || "") === name || normalizeCanonicalName(row.suggested_qbo_account_name || "") === name))
      );
    });
  } catch {
    rows = [];
  }
  const transactionIds = rows.map((row) => row.transaction_id).filter(Boolean);
  let dates = [];
  if (transactionIds.length) {
    try {
      const { data, error } = await supabase
        .from("bank_transactions")
        .select("id,date")
        .eq("business_id", businessId)
        .in("id", transactionIds);
      if (error) throw error;
      dates = (data || []).map((row) => row.date).filter(Boolean).sort();
    } catch {
      dates = [];
    }
  }
  return {
    qbo_account_id: account.id || null,
    qbo_account_name: account.name || null,
    qbo_account_type: account.type || null,
    qbo_account_subtype: account.subType || null,
    transaction_count: transactionIds.length,
    earliest_transaction_date: dates[0] || null,
    latest_transaction_date: dates[dates.length - 1] || null,
  };
}

async function buildReviewDecision({ supabase, businessId, mapping }) {
  const canonical = getCanonicalAccountByKey(mapping.canonical_account_key) || {};
  const candidate = mapping.qbo_account_id || mapping.qbo_account_name
    ? {
        id: mapping.qbo_account_id || mapping.metadata?.candidate_id || null,
        name: mapping.qbo_account_name || mapping.metadata?.candidate_name || null,
        type: mapping.qbo_account_type || mapping.metadata?.candidate_type || null,
        subType: mapping.qbo_account_subtype || mapping.metadata?.candidate_subtype || null,
      }
    : null;
  const [affectedTransactionIds, candidateUsage] = await Promise.all([
    fetchAffectedCanonicalTransactions({ supabase, businessId, canonicalKey: mapping.canonical_account_key }),
    fetchCandidateUsageEvidence({ supabase, businessId, account: candidate }),
  ]);
  return {
    mapping_id: mapping.id || null,
    business_id: mapping.business_id,
    realm_id: mapping.realm_id,
    qbo_env: mapping.qbo_env,
    canonical_account_key: mapping.canonical_account_key,
    bizzi_account_name: canonical.preferred_account_name || mapping.canonical_account_key,
    status: mapping.status,
    review_reason: mapping.review_reason || mapping.metadata?.reason || null,
    candidate_qbo_account_id: candidate?.id || null,
    candidate_qbo_account_name: candidate?.name || null,
    candidate_qbo_account_type: candidate?.type || canonical.qbo_account_type || null,
    candidate_qbo_account_subtype: candidate?.subType || canonical.qbo_account_subtype || null,
    affected_transaction_count: affectedTransactionIds.length || (mapping.first_transaction_id ? 1 : 0),
    affected_transaction_ids: affectedTransactionIds,
    candidate_usage: candidateUsage,
    recommendation: buildRecommendation({ mapping, candidateUsage }),
    updated_at: mapping.updated_at || mapping.created_at || null,
  };
}

async function reconsiderAffectedTransactionsAfterMapping({ supabase, businessId, canonicalKey, account, actor = "bizzi", action }) {
  const affectedTransactionIds = await fetchAffectedCanonicalTransactions({ supabase, businessId, canonicalKey });
  if (!affectedTransactionIds.length || !account?.id) return { count: 0, transaction_ids: [] };
  let rows = [];
  try {
    const { data, error } = await supabase
      .from("transaction_categorizations")
      .select("*")
      .eq("business_id", businessId)
      .in("transaction_id", affectedTransactionIds);
    if (error) throw error;
    rows = data || [];
  } catch {
    return { count: 0, transaction_ids: affectedTransactionIds };
  }
  let transactions = [];
  try {
    const { data, error } = await supabase
      .from("bank_transactions")
      .select("*")
      .eq("business_id", businessId)
      .in("id", affectedTransactionIds);
    if (error) throw error;
    transactions = data || [];
  } catch {
    transactions = [];
  }
  const txnById = new Map((transactions || []).map((txn) => [String(txn.id), txn]));
  let bookkeepingStartDate = null;
  let autoPostEnabled = false;
  try {
    const [startDate, autoPost] = await Promise.all([
      getBookkeepingStartDate(supabase, businessId),
      getAutoPostToQuickBooks(supabase, businessId),
    ]);
    bookkeepingStartDate = startDate;
    autoPostEnabled = autoPost === true;
  } catch {
    bookkeepingStartDate = null;
    autoPostEnabled = false;
  }
  const nowIso = new Date().toISOString();
  const unresolvedStatuses = new Set(["", "needs_review", "uncategorized"]);
  const patches = rows
    .filter((row) => unresolvedStatuses.has(String(row.status || "").toLowerCase()))
    .map((row) => {
      const txn = txnById.get(String(row.transaction_id)) || { id: row.transaction_id };
      const checkHit = isCheck(txn);
      const baseMeta = {
        ...(row.meta || {}),
        canonical_mapping_resolved_at: nowIso,
        canonical_mapping_resolution_action: action,
        canonical_mapping_resolved_by: actor,
        canonical_account_key: canonicalKey,
        canonical_reconsideration_requested: false,
      };
      let decision = null;
      if (!isTransactionInActiveBookkeepingScope(txn, bookkeepingStartDate)) {
        decision = {
          eligible: false,
          confidence: row.confidence || "low",
          source: baseMeta.suggestion_source || "canonical_mapping_reconsideration",
          reason: "transaction_before_bookkeeping_start_date",
        };
      } else {
        decision = canAutoHandle(
          txn,
          {
            source: baseMeta.suggestion_source || "canonical_mapping_reconsideration",
            confidence: row.confidence || baseMeta.universal_hint?.confidence || "low",
            accountId: String(account.id),
            accountName: account.name || row.suggested_qbo_account_name || null,
            taxonomyType: baseMeta.taxonomy_type || null,
            isCheck: checkHit.is_check === true,
            meta: baseMeta,
            reason: "canonical_mapping_resolved",
            safeToAutoHandle: baseMeta.safe_to_auto_handle === true,
            verifiedCcPayment:
              baseMeta.taxonomy_type === "cc_payment" &&
              baseMeta.cc_payment_mapping_confidence === "high" &&
              baseMeta.cc_payment_bank_qbo_account_id &&
              baseMeta.cc_payment_cc_qbo_account_id,
            allowTaxonomyAutoHandle: baseMeta.allow_taxonomy_auto_handle === true,
            weakRule: baseMeta.weak_rule === true,
          },
          {}
        );
      }
      const autoApproved = decision?.eligible === true;
      const nextMeta = {
        ...baseMeta,
        safe_to_auto_handle: autoApproved,
        canonical_reconsideration_processed_at: nowIso,
        canonical_reconsideration_result: {
          status: autoApproved ? "auto_approved" : "needs_review",
          reason: decision?.reason || "review_required",
          action,
          actor,
          at: nowIso,
        },
        auto_handle_decision: {
          eligible: autoApproved,
          confidence: decision?.confidence || row.confidence || "low",
          source: decision?.source || baseMeta.suggestion_source || "canonical_mapping_reconsideration",
          reason: decision?.reason || "review_required",
          at: nowIso,
        },
      };
      return {
        ...row,
        suggested_qbo_account_id: String(account.id),
        suggested_qbo_account_name: account.name || row.suggested_qbo_account_name || null,
        suggested_canonical_account_key: canonicalKey,
        final_qbo_account_id: autoApproved ? String(account.id) : null,
        final_qbo_account_name: autoApproved ? account.name || null : null,
        final_canonical_account_key: autoApproved ? canonicalKey : null,
        confidence: row.confidence || decision?.confidence || null,
        status: autoApproved ? "auto_approved" : "needs_review",
        meta: nextMeta,
        post_after: autoApproved ? computePostAfterForAutoPost(autoPostEnabled) : null,
        decided_by: autoApproved ? "bizzi" : row.decided_by || null,
        decided_at: autoApproved ? nowIso : row.decided_at || null,
        updated_at: nowIso,
      };
    });
  if (!patches.length) return { count: 0, transaction_ids: affectedTransactionIds };
  try {
    const { data, error } = await supabase
      .from("transaction_categorizations")
      .upsert(patches, { onConflict: "business_id,transaction_id" })
      .select("transaction_id");
    if (error) throw error;
    return { count: patches.length, transaction_ids: affectedTransactionIds, rows: data || [] };
  } catch {
    return { count: 0, transaction_ids: affectedTransactionIds };
  }
}

export async function resolveCanonicalQboAccount({
  businessId,
  intent = null,
  canonicalAccountKey = null,
  transactionId = null,
  source = "resolver",
  allowCreate = false,
  approvedCreateDespiteCandidateId = null,
  dependencies = {},
} = {}) {
  const supabase = dependencies.supabase || await getDefaultSupabase();
  const getQBOClient = dependencies.getQBOClient || getDefaultQboClient;
  const getLatestQuickBooksTokenRow = dependencies.getLatestQuickBooksTokenRow || getDefaultLatestQuickBooksTokenRow;
  if (!businessId) throw new Error("missing_business_id");

  const key = canonicalAccountKey || resolveIntentToCanonicalKey(intent);
  const canonical = canonicalAccountKey ? getCanonicalAccountByKey(key) : getCanonicalAccountForIntent(intent);
  if (!canonical || canonical.is_active === false) {
    return { ok: false, status: CANONICAL_MAPPING_STATUSES.NEEDS_REVIEW, reason: "unknown_canonical_account", review_required: true };
  }
  const internalMappingAuthority = ["monthly_review", "internal_monthly_review", "internal_admin"].includes(String(source || "").toLowerCase());

  const { realmId, qboEnv } = await getRealmContext({ businessId, getLatestQuickBooksTokenRow });
  if (!realmId) {
    return { ok: false, status: CANONICAL_MAPPING_STATUSES.NEEDS_REVIEW, canonical, reason: "missing_qbo_realm_id", review_required: true };
  }

  const stored = await fetchStoredMapping({ supabase, businessId, realmId, qboEnv, canonicalKey: canonical.canonical_account_key });
  if (stored?.qbo_account_id) {
    return {
      ok: true,
      status: stored.status,
      canonical,
      account: {
        id: stored.qbo_account_id,
        name: stored.qbo_account_name,
        type: stored.qbo_account_type,
        subType: stored.qbo_account_subtype,
      },
      mapping: stored,
      created: stored.status === CANONICAL_MAPPING_STATUSES.CREATED_BY_BIZZI,
      review_required: false,
    };
  }

  let qbo = null;
  let accounts = [];
  try {
    const live = await fetchLiveQboAccounts({ businessId, getQBOClient });
    qbo = live.qbo;
    accounts = live.accounts;
    await upsertQboCache({ supabase, businessId, realmId, qboEnv, accounts });
  } catch (err) {
    return markNeedsReview({ supabase, businessId, realmId, qboEnv, canonical, transactionId, intent, reason: err?.message || "qbo_coa_unavailable", source });
  }

  const exact = findExactCanonicalAccount(accounts, canonical);
  if (exact) {
    if (internalMappingAuthority !== true) {
      return markNeedsReview({
        supabase,
        businessId,
        realmId,
        qboEnv,
        canonical,
        transactionId,
        intent,
        reason: "canonical_mapping_requires_internal_approval",
        candidate: exact,
        source,
      });
    }
    await upsertMapping({
      supabase,
      businessId,
      realmId,
      qboEnv,
      canonical,
      account: exact,
      status: CANONICAL_MAPPING_STATUSES.EXISTING_EXACT,
      source,
      transactionId,
      intent,
      metadata: { reason: "exact_canonical_name" },
    });
    return { ok: true, status: CANONICAL_MAPPING_STATUSES.EXISTING_EXACT, canonical, account: exact, created: false, review_required: false };
  }

  const equivalent = findApprovedEquivalentAccount(accounts, canonical);
  if (equivalent) {
    if (internalMappingAuthority !== true) {
      return markNeedsReview({
        supabase,
        businessId,
        realmId,
        qboEnv,
        canonical,
        transactionId,
        intent,
        reason: "canonical_mapping_requires_internal_approval",
        candidate: equivalent,
        source,
      });
    }
    await upsertMapping({
      supabase,
      businessId,
      realmId,
      qboEnv,
      canonical,
      account: equivalent,
      status: CANONICAL_MAPPING_STATUSES.EXISTING_APPROVED_EQUIVALENT,
      source,
      transactionId,
      intent,
      metadata: { reason: "approved_equivalent_name" },
    });
    return { ok: true, status: CANONICAL_MAPPING_STATUSES.EXISTING_APPROVED_EQUIVALENT, canonical, account: equivalent, created: false, review_required: false };
  }

  const ambiguous = findUnreviewedAmbiguousCandidate(accounts, canonical, approvedCreateDespiteCandidateId);
  if (ambiguous) {
    return markNeedsReview({ supabase, businessId, realmId, qboEnv, canonical, transactionId, intent, reason: "ambiguous_candidate_requires_review", candidate: ambiguous, source });
  }

  const creationAuthorizedByInternalAccountant =
    allowCreate === true &&
    internalMappingAuthority === true;

  if (canonical.auto_create_policy !== AUTO_CREATE_ALLOWED || canonical.review_required === true || creationAuthorizedByInternalAccountant !== true) {
    return markNeedsReview({ supabase, businessId, realmId, qboEnv, canonical, transactionId, intent, reason: "canonical_account_requires_review", candidate: ambiguous, source });
  }

  const requestId = compactRequestId(`${businessId}|${realmId}|${qboEnv}|${canonical.canonical_account_key}|qbo-account-v1`);
  let claim = null;
  try {
    claim = await claimCreationIntent({ supabase, businessId, realmId, qboEnv, canonical, requestId, transactionId, intent });
  } catch (err) {
    return markNeedsReview({ supabase, businessId, realmId, qboEnv, canonical, transactionId, intent, reason: `creation_claim_failed:${err?.message || "unknown"}`, source });
  }

  const claimedIntent = claim?.intent || null;
  if (claim?.already_resolved && claimedIntent?.qbo_account_id) {
    return {
      ok: true,
      status: claimedIntent.status === "created" ? CANONICAL_MAPPING_STATUSES.CREATED_BY_BIZZI : CANONICAL_MAPPING_STATUSES.EXISTING_EXACT,
      canonical,
      account: {
        id: claimedIntent.qbo_account_id,
        name: claimedIntent.qbo_account_name,
        type: canonical.qbo_account_type,
        subType: canonical.qbo_account_subtype,
      },
      created: claimedIntent.status === "created",
      review_required: false,
    };
  }
  if (!claim?.claimed) {
    const refreshedExact = findExactCanonicalAccount(accounts, canonical);
    if (refreshedExact) {
      await recordCreationIntentOutcome({ supabase, businessId, realmId, qboEnv, canonical, status: "mapped_existing", account: refreshedExact });
      await upsertMapping({ supabase, businessId, realmId, qboEnv, canonical, account: refreshedExact, status: CANONICAL_MAPPING_STATUSES.EXISTING_EXACT, source: "creation_intent", transactionId, intent, metadata: { reason: "resolved_while_waiting" } });
      return { ok: true, status: CANONICAL_MAPPING_STATUSES.EXISTING_EXACT, canonical, account: refreshedExact, created: false, review_required: false };
    }
    return markNeedsReview({ supabase, businessId, realmId, qboEnv, canonical, transactionId, intent, reason: "creation_already_in_progress", source });
  }

  try {
    const preCreateLive = await fetchLiveQboAccounts({ businessId, getQBOClient });
    qbo = preCreateLive.qbo || qbo;
    accounts = preCreateLive.accounts || accounts;
    await upsertQboCache({ supabase, businessId, realmId, qboEnv, accounts });
    const preCreateExact = findExactCanonicalAccount(accounts, canonical);
    const preCreateEquivalent = findApprovedEquivalentAccount(accounts, canonical);
    const preCreateMatch = preCreateExact || preCreateEquivalent;
    if (preCreateMatch) {
      const status = preCreateExact ? CANONICAL_MAPPING_STATUSES.EXISTING_EXACT : CANONICAL_MAPPING_STATUSES.EXISTING_APPROVED_EQUIVALENT;
      await recordCreationIntentOutcome({ supabase, businessId, realmId, qboEnv, canonical, status: "mapped_existing", account: preCreateMatch });
      await upsertMapping({ supabase, businessId, realmId, qboEnv, canonical, account: preCreateMatch, status, source: "creation_intent", transactionId, intent, metadata: { reason: "matched_before_create" } });
      return { ok: true, status, canonical, account: preCreateMatch, created: false, review_required: false };
    }
    const preCreateAmbiguous = findUnreviewedAmbiguousCandidate(accounts, canonical, approvedCreateDespiteCandidateId);
    if (preCreateAmbiguous) {
      await recordCreationIntentOutcome({ supabase, businessId, realmId, qboEnv, canonical, status: "needs_review", account: preCreateAmbiguous });
      return markNeedsReview({
        supabase,
        businessId,
        realmId,
        qboEnv,
        canonical,
        transactionId,
        intent,
        reason: "ambiguous_candidate_requires_review",
        candidate: preCreateAmbiguous,
        source,
      });
    }

    const created = await createQboAccountFromCanonical({ qbo, canonical, requestId });
    await recordCreationIntentOutcome({ supabase, businessId, realmId, qboEnv, canonical, status: "created", account: created });
    await upsertQboCache({ supabase, businessId, realmId, qboEnv, accounts: [created] });
    await upsertMapping({
      supabase,
      businessId,
      realmId,
      qboEnv,
      canonical,
      account: created,
      status: CANONICAL_MAPPING_STATUSES.CREATED_BY_BIZZI,
      source: "creation_intent",
      transactionId,
      intent,
      metadata: { reason: "safe_auto_create", request_id: requestId },
    });
    try {
      await supabase.from("qbo_coa_creations").upsert(
        {
          business_id: businessId,
          qbo_account_id: created.id,
          qbo_account_name: created.name,
          account_type: created.type || canonical.qbo_account_type,
          created_by: "bizzi",
          source,
          meta: {
            canonical_account_key: canonical.canonical_account_key,
            intent,
            transaction_id: transactionId || null,
            request_id: requestId,
            account_subtype: created.subType || canonical.qbo_account_subtype || null,
          },
        },
        { onConflict: "business_id,qbo_account_id" }
      );
    } catch {
      // Historical qbo_coa_creations is best-effort; canonical mapping events are authoritative.
    }
    return { ok: true, status: CANONICAL_MAPPING_STATUSES.CREATED_BY_BIZZI, canonical, account: created, created: true, review_required: false };
  } catch (err) {
    const reconciledLive = await fetchLiveQboAccounts({ businessId, getQBOClient }).catch(() => null);
    const reconciledAccounts = reconciledLive?.accounts || [];
    const reconciled = findExactCanonicalAccount(reconciledAccounts, canonical) || findApprovedEquivalentAccount(reconciledAccounts, canonical);
    if (reconciled) {
      const status = normalizeCanonicalName(reconciled.name) === normalizeCanonicalName(canonical.preferred_account_name)
        ? CANONICAL_MAPPING_STATUSES.EXISTING_EXACT
        : CANONICAL_MAPPING_STATUSES.EXISTING_APPROVED_EQUIVALENT;
      await recordCreationIntentOutcome({ supabase, businessId, realmId, qboEnv, canonical, status: "mapped_existing", account: reconciled });
      await upsertMapping({ supabase, businessId, realmId, qboEnv, canonical, account: reconciled, status, source: "creation_intent", transactionId, intent, metadata: { reason: "reconciled_after_create_error" } });
      return { ok: true, status, canonical, account: reconciled, created: false, review_required: false };
    }
    await recordCreationIntentOutcome({ supabase, businessId, realmId, qboEnv, canonical, status: "unknown", error: err }).catch(() => null);
    await logMappingEvent({ supabase, businessId, realmId, qboEnv, canonical, eventType: "creation_unknown", source, transactionId, intent, reason: err?.message || "qbo_create_unknown", metadata: { request_id: requestId } });
    return markNeedsReview({ supabase, businessId, realmId, qboEnv, canonical, transactionId, intent, reason: `qbo_create_unknown:${err?.message || "unknown"}`, source });
  }
}

export async function validateCanonicalQboAccountForPromotion({
  businessId,
  intent = null,
  canonicalAccountKey = null,
  transactionId = null,
  source = "promotion_revalidation",
  allowCreate = false,
  dependencies = {},
} = {}) {
  const getQBOClient = dependencies.getQBOClient || getDefaultQboClient;
  if (!businessId) throw new Error("missing_business_id");

  const resolved = await resolveCanonicalQboAccount({
    businessId,
    intent,
    canonicalAccountKey,
    transactionId,
    source,
    allowCreate,
    dependencies,
  });
  if (!resolved?.ok || resolved.review_required === true || !resolved?.canonical || !resolved?.account?.id) {
    return {
      ok: false,
      status: resolved?.status || CANONICAL_MAPPING_STATUSES.NEEDS_REVIEW,
      reason: resolved?.reason || "canonical_account_not_resolved",
      canonical: resolved?.canonical || null,
      account: resolved?.account || null,
      review_required: true,
    };
  }

  let liveAccounts = [];
  try {
    const live = await fetchLiveQboAccounts({ businessId, getQBOClient });
    liveAccounts = live.accounts || [];
  } catch (err) {
    return {
      ok: false,
      status: CANONICAL_MAPPING_STATUSES.NEEDS_REVIEW,
      reason: err?.message || "qbo_coa_revalidation_failed",
      canonical: resolved.canonical,
      account: resolved.account,
      review_required: true,
    };
  }

  const liveAccount = liveAccounts.find((account) => String(account.id) === String(resolved.account.id));
  if (!liveAccount || liveAccount.active === false) {
    return {
      ok: false,
      status: CANONICAL_MAPPING_STATUSES.NEEDS_REVIEW,
      reason: "canonical_qbo_account_missing_or_inactive",
      canonical: resolved.canonical,
      account: resolved.account,
      review_required: true,
    };
  }
  if (!qboAccountCompatibleForApproval(resolved.canonical, liveAccount)) {
    return {
      ok: false,
      status: CANONICAL_MAPPING_STATUSES.NEEDS_REVIEW,
      reason: "canonical_qbo_account_type_incompatible",
      canonical: resolved.canonical,
      account: liveAccount,
      review_required: true,
    };
  }

  return {
    ...resolved,
    ok: true,
    account: liveAccount,
    review_required: false,
    revalidated: true,
  };
}

export async function fetchCanonicalAccountMappingsForBusiness({ businessId, month = null, dependencies = {} } = {}) {
  const supabase = dependencies.supabase || await getDefaultSupabase();
  if (!businessId) return { rows: [], history: [] };
  let mappings = [];
  let events = [];
  try {
    const { data, error } = await supabase
      .from("business_canonical_qbo_account_mappings")
      .select("*")
      .eq("business_id", businessId)
      .order("updated_at", { ascending: false });
    if (error) throw error;
    mappings = data || [];
  } catch {
    mappings = [];
  }
  try {
    let query = supabase
      .from("qbo_account_mapping_events")
      .select("*")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (month) {
      const [year, rawMonth] = String(month).split("-").map(Number);
      if (Number.isFinite(year) && Number.isFinite(rawMonth)) {
        const start = new Date(Date.UTC(year, rawMonth - 1, 1)).toISOString();
        const end = new Date(Date.UTC(year, rawMonth, 1)).toISOString();
        query = query.gte("created_at", start).lt("created_at", end);
      }
    }
    const { data, error } = await query;
    if (error) throw error;
    events = data || [];
  } catch {
    events = [];
  }

  const usage = await fetchCanonicalUsage({ supabase, businessId });
  const rows = mappings.map((mapping) => {
    const canonical = getCanonicalAccountByKey(mapping.canonical_account_key) || {};
    return {
      canonical_account_key: mapping.canonical_account_key,
      bizzi_account_name: canonical.preferred_account_name || mapping.canonical_account_key,
      qbo_account_id: mapping.qbo_account_id || null,
      qbo_account_name: mapping.qbo_account_name || null,
      status: mapping.status,
      account_type: mapping.qbo_account_type || canonical.qbo_account_type || null,
      account_subtype: mapping.qbo_account_subtype || canonical.qbo_account_subtype || null,
      mapped_at: mapping.mapped_at || mapping.updated_at || mapping.created_at || null,
      created_at: mapping.created_at || null,
      review_reason: mapping.review_reason || mapping.metadata?.reason || null,
      usage_count: usage.get(mapping.canonical_account_key) || 0,
    };
  });
  const reviewMappings = mappings.filter((mapping) => mapping.status === CANONICAL_MAPPING_STATUSES.NEEDS_REVIEW);
  const decisions = await Promise.all(reviewMappings.map((mapping) => buildReviewDecision({ supabase, businessId, mapping })));
  return { rows, history: events, decisions };
}

export async function approveExistingQboAccountForCanonical({ businessId, canonicalAccountKey, qboAccountId, actor = "bizzi", source = "manual", dependencies = {} } = {}) {
  const supabase = dependencies.supabase || await getDefaultSupabase();
  const getQBOClient = dependencies.getQBOClient || getDefaultQboClient;
  const getLatestQuickBooksTokenRow = dependencies.getLatestQuickBooksTokenRow || getDefaultLatestQuickBooksTokenRow;
  if (!businessId) throw new Error("missing_business_id");
  const canonical = getCanonicalAccountByKey(canonicalAccountKey);
  if (!canonical || canonical.is_active === false) throw new Error("unknown_canonical_account");
  const { realmId, qboEnv } = await getRealmContext({ businessId, getLatestQuickBooksTokenRow });
  if (!realmId) throw new Error("missing_qbo_realm_id");
  const live = await fetchLiveQboAccounts({ businessId, getQBOClient });
  await upsertQboCache({ supabase, businessId, realmId, qboEnv, accounts: live.accounts });
  const account = (live.accounts || []).map(shapeQboAccount).find((acct) => String(acct.id || "") === String(qboAccountId || "") && acct.active !== false);
  if (!account) throw new Error("qbo_candidate_not_found");
  if (!qboAccountCompatibleForApproval(canonical, account)) throw new Error("qbo_candidate_type_incompatible");
  const previous = await supabase
    .from("business_canonical_qbo_account_mappings")
    .select("*")
    .eq("business_id", businessId)
    .eq("realm_id", realmId)
    .eq("qbo_env", qboEnv)
    .eq("canonical_account_key", canonical.canonical_account_key)
    .maybeSingle();
  const previousRow = previous?.data || null;
  const evidence = await fetchCandidateUsageEvidence({ supabase, businessId, account });
  const mapping = await upsertMapping({
    supabase,
    businessId,
    realmId,
    qboEnv,
    canonical,
    account,
    status: CANONICAL_MAPPING_STATUSES.EXISTING_APPROVED_EQUIVALENT,
    source,
    metadata: {
      reason: "human_approved_equivalent",
      action: "use_existing",
      actor,
      mapped_by: actor,
      previous_status: previousRow?.status || null,
      previous_qbo_account_id: previousRow?.qbo_account_id || null,
      evidence,
    },
  });
  const reconsideration = await reconsiderAffectedTransactionsAfterMapping({
    supabase,
    businessId,
    canonicalKey: canonical.canonical_account_key,
    account,
    actor,
    action: "use_existing",
  });
  return { ok: true, action: "use_existing", mapping, account, evidence, reconsideration };
}

export async function createPreferredQboAccountForCanonical({ businessId, canonicalAccountKey, reviewedCandidateQboAccountId = null, actor = "bizzi", source = "manual", dependencies = {} } = {}) {
  const result = await resolveCanonicalQboAccount({
    businessId,
    canonicalAccountKey,
    source,
    allowCreate: true,
    approvedCreateDespiteCandidateId: reviewedCandidateQboAccountId,
    dependencies,
  });
  if (!result?.ok || !result?.account?.id) return { ok: false, ...result };
  const supabase = dependencies.supabase || await getDefaultSupabase();
  const reconsideration = await reconsiderAffectedTransactionsAfterMapping({
    supabase,
    businessId,
    canonicalKey: result.canonical?.canonical_account_key || canonicalAccountKey,
    account: result.account,
    actor,
    action: "create_bizzi_preferred",
  });
  return { ok: true, action: "create_bizzi_preferred", ...result, reconsideration };
}

async function fetchCanonicalUsage({ supabase, businessId }) {
  const usage = new Map();
  try {
    const { data, error } = await supabase
      .from("transaction_categorizations")
      .select("suggested_canonical_account_key,final_canonical_account_key")
      .eq("business_id", businessId);
    if (error) throw error;
    (data || []).forEach((row) => {
      const key = row.final_canonical_account_key || row.suggested_canonical_account_key || null;
      if (!key) return;
      usage.set(key, (usage.get(key) || 0) + 1);
    });
  } catch {
    return usage;
  }
  return usage;
}

export default {
  resolveCanonicalQboAccount,
  validateCanonicalQboAccountForPromotion,
  fetchCanonicalAccountMappingsForBusiness,
  approveExistingQboAccountForCanonical,
  createPreferredQboAccountForCanonical,
};
