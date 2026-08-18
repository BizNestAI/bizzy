import crypto from "crypto";
import { qboEnvName } from "../../utils/qboEnv.js";
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

function findAmbiguousCandidate(coa = [], canonical = {}) {
  const tokenSet = (value = "") =>
    normalizeCanonicalName(value)
      .split(" ")
      .filter((token) => token && !["and", "the", "of", "for"].includes(token));
  const canonicalTokens = tokenSet(canonical.preferred_account_name);
  if (!canonicalTokens.length) return null;
  const candidates = (coa || [])
    .map(shapeQboAccount)
    .filter((acct) => acct.active !== false && qboTypeCompatible(canonical, acct))
    .map((acct) => {
      const tokens = tokenSet(acct.name);
      const common = canonicalTokens.filter((token) => tokens.includes(token));
      const score = common.length / Math.max(canonicalTokens.length, tokens.length, 1);
      return { acct, score };
    })
    .filter((entry) => entry.score > 0 && !isApprovedEquivalentName(canonical.canonical_account_key, entry.acct.name))
    .sort((a, b) => b.score - a.score);
  return candidates[0]?.score >= 0.5 ? candidates[0].acct : null;
}

async function getRealmContext({ businessId, supabase, getLatestQuickBooksTokenRow }) {
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

export async function resolveCanonicalQboAccount({
  businessId,
  intent = null,
  canonicalAccountKey = null,
  transactionId = null,
  source = "resolver",
  allowCreate = true,
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

  const { realmId, qboEnv } = await getRealmContext({ businessId, supabase, getLatestQuickBooksTokenRow });
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

  const ambiguous = findAmbiguousCandidate(accounts, canonical);
  if (ambiguous) {
    return markNeedsReview({ supabase, businessId, realmId, qboEnv, canonical, transactionId, intent, reason: "ambiguous_candidate_requires_review", candidate: ambiguous, source });
  }

  if (canonical.auto_create_policy !== AUTO_CREATE_ALLOWED || canonical.review_required === true || allowCreate !== true) {
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
    const preCreateAmbiguous = findAmbiguousCandidate(accounts, canonical);
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
  return { rows, history: events };
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
  fetchCanonicalAccountMappingsForBusiness,
};
