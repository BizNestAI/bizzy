import { createHash } from "node:crypto";
import { qboEnvName } from "../../utils/qboEnv.js";
import { computePostAfterForAutoPost, getAutoPostToQuickBooks } from "./autoPostControl.js";

const BLOCKED_TAXONOMY_TYPES = new Set([
  "transfer",
  "transfer_internal",
  "cc_payment",
  "owner_draw",
  "owner_contribution",
  "refund",
]);

const GENERIC_OR_BLOCKED_NAME_PATTERNS = [
  /\b(payment|transfer|deposit|refund|reversal|chargeback)\b/i,
  /\b(interest|bank fee|monthly fee|service fee)\b/i,
  /\b(payroll|paychex|adp payroll|gusto payroll)\b/i,
  /\bach\s+(debit|credit|payment)?\b/i,
  /\b(zelle|venmo cashout|cash app)\b/i,
  /\b(check|check paid|check withdrawal)\b/i,
];

const MERCHANT_SYNONYMS = [
  { canonical: "Apple", patterns: [/^apple$/, /^apple bill$/, /^apple com bill$/, /^apple services$/] },
  { canonical: "Amazon", patterns: [/^amazon$/, /^amazon com$/, /^amazon marketplace$/, /^amzn mktp$/, /^amzn marketplace$/] },
  { canonical: "Duke Energy", patterns: [/^duke energy$/, /^dukeenergy$/, /^duke energy corp$/] },
];

const STRONG_CANONICAL_CLAIM_ALIAS_TYPES = new Set([
  "plaid_merchant_entity_id",
  "qbo_vendor_id",
]);

export const QBO_VENDOR_MAPPING_VALIDATION_TTL_MS = 10 * 60 * 1000;

const AUTH_ERROR_CODES = new Set([
  "quickbooks_needs_reconnect",
  "qbo_client_unavailable:no_active_token_row",
  "invalid_grant",
  "authentication_failed",
  "unauthorized",
]);

function firstProviderFault(err = {}) {
  const fault = err?.Fault || err?.fault || err?.response?.Fault || err?.response?.fault;
  const errors = fault?.Error || fault?.error || fault?.errors;
  if (Array.isArray(errors)) return errors[0] || null;
  return errors || null;
}

function safeProviderMessage(err = {}) {
  const fault = firstProviderFault(err);
  return String(
    fault?.Message ||
      fault?.message ||
      fault?.Detail ||
      fault?.detail ||
      err?.message ||
      err?.code ||
      "provider_error"
  ).slice(0, 240);
}

function providerStatus(err = {}) {
  const raw = err?.statusCode || err?.status || err?.response?.status || err?.response?.statusCode || null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function providerCode(err = {}) {
  const fault = firstProviderFault(err);
  const raw = fault?.code || fault?.Code || err?.code || err?.errorCode || err?.intuit_tid || null;
  return raw == null ? null : String(raw).slice(0, 80);
}

export function classifyQboVendorProviderError(err = {}, stage = "unknown") {
  if (err?.vendorDiagnostics) return err.vendorDiagnostics;
  const message = safeProviderMessage(err);
  const lower = message.toLowerCase();
  const status = providerStatus(err);
  const code = providerCode(err);
  const codeLower = String(code || "").toLowerCase();

  let normalizedCode = stage === "qbo_vendor_create" ? "vendor_qbo_create_unknown" : "vendor_provider_unavailable";
  let retryable = true;
  let reconnectRequired = false;

  if (AUTH_ERROR_CODES.has(lower) || AUTH_ERROR_CODES.has(codeLower) || status === 401 || status === 403 || /invalid_grant|unauthori[sz]ed|reconnect|authentication/.test(lower)) {
    normalizedCode = "vendor_qbo_auth_required";
    retryable = false;
    reconnectRequired = true;
  } else if (status === 429 || /rate limit|too many requests|throttle/.test(lower)) {
    normalizedCode = "vendor_qbo_rate_limited";
  } else if (/timeout|timed out|etimedout|econnreset|socket hang up|network/i.test(message)) {
    normalizedCode = "vendor_qbo_timeout";
  } else if (/duplicate name|name already exists|6240|displayname.*exists|display name.*exists/i.test(message) || code === "6240") {
    normalizedCode = "vendor_qbo_name_conflict";
    retryable = false;
  } else if (status === 400 || /validation|business validation|invalid.*vendor|malformed/i.test(message)) {
    normalizedCode = "vendor_qbo_validation_failed";
    retryable = false;
  } else if (/not_supported|not supported/i.test(message)) {
    normalizedCode = stage === "qbo_vendor_create" ? "vendor_qbo_create_unsupported" : "vendor_provider_unavailable";
    retryable = false;
  } else if (/missing_id|create_missing_id/i.test(message)) {
    normalizedCode = stage === "qbo_vendor_create" ? "vendor_qbo_create_unknown" : "vendor_provider_unavailable";
    retryable = false;
  } else if (stage === "qbo_vendor_lookup" || stage === "qbo_vendor_mapping_revalidation" || stage === "qbo_vendor_create_recovery" || stage === "qbo_customer_lookup" || stage === "qbo_employee_lookup" || /findvendors|findcustomers|findemployees|qbo_find/i.test(lower)) {
    normalizedCode = "vendor_qbo_lookup_failed";
  } else if (stage === "canonical_vendor_db" || stage === "qbo_vendor_creation_intent" || /postgrest|supabase|rpc|duplicate key|violates/i.test(lower)) {
    normalizedCode = "vendor_db_error";
  }

  return {
    stage,
    code: normalizedCode,
    provider_code: code,
    http_status: status,
    retryable,
    reconnect_required: reconnectRequired,
    message,
  };
}

export class QboVendorProviderError extends Error {
  constructor(stage, err) {
    const diagnostics = classifyQboVendorProviderError(err, stage);
    super(diagnostics.code);
    this.name = "QboVendorProviderError";
    this.cause = err;
    this.vendorDiagnostics = diagnostics;
    this.retryable = diagnostics.retryable;
    this.reconnectRequired = diagnostics.reconnect_required;
  }
}

async function withVendorProviderStage(stage, fn) {
  try {
    return await fn();
  } catch (err) {
    throw err?.vendorDiagnostics ? err : new QboVendorProviderError(stage, err);
  }
}

function looksLikeTaxonomyLandmineMemo(txn = {}) {
  const memo = normalizeVendorText([txn.name, txn.merchant_name, txn.counterparty_name].filter(Boolean).join(" "));
  const pfcPrimary = String(txn.personal_finance_category?.primary || "").toUpperCase();
  const primary = String(txn.category_primary || "").toUpperCase();
  return (
    memo.includes("transfer") ||
    memo.includes("xfer") ||
    memo.includes("credit card payment") ||
    memo.includes("card payment") ||
    memo.includes("payment thank you") ||
    memo.includes("autopay") ||
    memo.includes("auto pay") ||
    memo.includes("online payment") ||
    memo.includes("refund") ||
    memo.includes("chargeback") ||
    memo.includes("reversal") ||
    memo.includes("owner draw") ||
    memo.includes("owner contribution") ||
    memo.includes("capital contribution") ||
    memo.includes("venmo cashout") ||
    memo.includes("paypal transfer") ||
    pfcPrimary.startsWith("TRANSFER") ||
    primary.startsWith("TRANSFER")
  );
}

async function getDefaultDb() {
  const mod = await import("../supabaseAdmin.js");
  return mod.supabase;
}

async function defaultGetQBOClient(businessId) {
  const mod = await import("../../utils/qboClient.js");
  return mod.getQBOClient(businessId);
}

async function defaultGetLatestQuickBooksTokenRow(businessId) {
  const mod = await import("../quickbooksTokenService.js");
  return mod.getLatestQuickBooksTokenRow(businessId);
}

function nowIso() {
  return new Date().toISOString();
}

function isRecentTimestamp(value, ttlMs = QBO_VENDOR_MAPPING_VALIDATION_TTL_MS) {
  if (!value) return false;
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts >= 0 && Date.now() - ts <= ttlMs;
}

export function normalizeVendorText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function canonicalizeVendorDisplayName(value = "") {
  const normalized = normalizeVendorText(value);
  if (!normalized) return "";
  for (const entry of MERCHANT_SYNONYMS) {
    if (entry.patterns.some((re) => re.test(normalized))) return entry.canonical;
  }
  return normalized
    .split(" ")
    .map((token) => {
      if (/^(llc|inc|co|usa|us|com)$/.test(token)) return token.toUpperCase();
      return token.charAt(0).toUpperCase() + token.slice(1);
    })
    .join(" ");
}

function stableRequestId({ businessId, realmId, canonicalVendorId }) {
  const hash = createHash("sha256")
    .update(`${businessId}:${realmId}:${canonicalVendorId}:qbo-vendor`)
    .digest("hex")
    .slice(0, 32);
  return `bzz-vnd-${hash}`.slice(0, 50);
}

function isOutflow(txn = {}) {
  const dir = String(txn.direction || "").toUpperCase();
  if (dir === "OUTFLOW") return true;
  if (dir === "INFLOW") return false;
  const signed = Number(txn.signed_amount);
  if (Number.isFinite(signed)) return signed < 0;
  const amount = Number(txn.amount);
  if (Number.isFinite(amount)) return amount < 0;
  return false;
}

function cleanMemoPrefix(txn = {}, length = 20) {
  const memo = [txn.name, txn.merchant_name, txn.counterparty_name].filter(Boolean).join(" ");
  const cleaned = normalizeVendorText(
    memo.replace(/^(POS|DEBIT|CREDIT|ACH|ACH DEBIT|ACH CREDIT|SQ \*|VENMO PAYMENT|PP\*|PURCHASE)\s+/i, "")
  );
  return cleaned ? cleaned.slice(0, length) : "";
}

function hasBlockedName(candidate = "") {
  if (!candidate) return true;
  return GENERIC_OR_BLOCKED_NAME_PATTERNS.some((re) => re.test(candidate));
}

export function getVendorAutoCreateBlockReason({ bankTxn = {}, taxonomyMeta = {}, candidateName = "" }) {
  const taxonomy = String(taxonomyMeta?.taxonomy_type || taxonomyMeta?.meta?.taxonomy_type || "").toLowerCase();
  if (!isOutflow(bankTxn)) return "not_outflow";
  if (BLOCKED_TAXONOMY_TYPES.has(taxonomy)) return "blocked_taxonomy";
  if (looksLikeTaxonomyLandmineMemo(bankTxn)) return "blocked_taxonomy_memo";
  if (bankTxn.check_number && !bankTxn.counterparty_name && !bankTxn.merchant_name) return "check_without_confirmed_payee";
  const pfcPrimary = String(bankTxn.personal_finance_category?.primary || "").toUpperCase();
  const catPrimary = String(bankTxn.category_primary || "").toUpperCase();
  if (pfcPrimary.startsWith("TRANSFER") || catPrimary.startsWith("TRANSFER")) return "transfer";
  if (/PAYROLL|WAGES|SALARY/.test(`${pfcPrimary} ${catPrimary}`)) return "payroll_ambiguous";
  if (hasBlockedName(candidateName)) return "unclear_or_non_vendor_name";
  return null;
}

export function getVendorPostingRequirement({ bankTxn = {}, taxonomyMeta = {}, qboTxnType = null } = {}) {
  if (!["Purchase", "CreditCardCharge"].includes(qboTxnType)) {
    return { required: false, reason: "qbo_transaction_type_does_not_use_vendor" };
  }
  const candidateName = bankTxn.counterparty_name || bankTxn.merchant_name || bankTxn.name || "";
  const blockReason = getVendorAutoCreateBlockReason({ bankTxn, taxonomyMeta, candidateName });
  if (blockReason) return { required: false, reason: blockReason };
  const hasReliableSignal = Boolean(bankTxn.merchant_entity_id || bankTxn.merchant_name || bankTxn.counterparty_name);
  if (!hasReliableSignal) return { required: false, reason: "no_reliable_vendor_identity" };
  return { required: true, reason: "normal_identifiable_merchant_outflow" };
}

function collectEvidence(bankTxn = {}, payeeResolution = {}) {
  const displayCandidate =
    payeeResolution?.counterpartyName ||
    bankTxn.counterparty_name ||
    bankTxn.merchant_name ||
    "";
  const evidence = [];
  if (bankTxn.merchant_entity_id) {
    evidence.push({
      alias_type: "plaid_merchant_entity_id",
      alias_value: String(bankTxn.merchant_entity_id),
      normalized_alias_value: String(bankTxn.merchant_entity_id),
      confidence: "high",
      is_strong_evidence: true,
      is_approved: true,
    });
  }
  if (bankTxn.merchant_name) {
    evidence.push({
      alias_type: "plaid_merchant_name",
      alias_value: bankTxn.merchant_name,
      normalized_alias_value: normalizeVendorText(bankTxn.merchant_name),
      confidence: bankTxn.merchant_entity_id ? "high" : "medium",
      is_strong_evidence: Boolean(bankTxn.merchant_entity_id),
      is_approved: Boolean(bankTxn.merchant_entity_id),
    });
  }
  if (bankTxn.counterparty_name) {
    evidence.push({
      alias_type: "plaid_counterparty_name",
      alias_value: bankTxn.counterparty_name,
      normalized_alias_value: normalizeVendorText(bankTxn.counterparty_name),
      confidence: "medium",
      is_strong_evidence: false,
      is_approved: false,
    });
  }
  const normalizedText = normalizeVendorText(displayCandidate);
  if (normalizedText) {
    evidence.push({
      alias_type: "normalized_merchant_text",
      alias_value: displayCandidate,
      normalized_alias_value: normalizedText,
      confidence: bankTxn.merchant_entity_id ? "high" : "medium",
      is_strong_evidence: Boolean(bankTxn.merchant_entity_id),
      is_approved: Boolean(bankTxn.merchant_entity_id),
    });
  }
  return { displayCandidate, evidence };
}

function primaryEvidenceFor(evidence = []) {
  return (
    evidence.find((e) => e.alias_type === "plaid_merchant_entity_id") ||
    evidence.find((e) => e.alias_type === "qbo_vendor_id") ||
    evidence.find((e) => e.is_approved) ||
    evidence.find((e) => e.alias_type === "plaid_merchant_name") ||
    evidence[0] ||
    null
  );
}

function strongClaimAliasFor(evidence = []) {
  return evidence.find((alias) =>
    alias?.is_strong_evidence === true &&
    alias?.is_approved === true &&
    STRONG_CANONICAL_CLAIM_ALIAS_TYPES.has(alias.alias_type) &&
    alias.normalized_alias_value
  ) || null;
}

async function insertEvent(db, payload) {
  try {
    await db.from("vendor_mapping_events").insert({
      actor: "bizzi",
      source: "resolver",
      qbo_env: qboEnvName || "production",
      created_at: nowIso(),
      ...payload,
    });
  } catch {
    // Audit events are best-effort; mapping tables remain authoritative.
  }
}

async function findVendorByAlias(db, businessId, aliases = []) {
  for (const alias of aliases) {
    if (!alias?.normalized_alias_value) continue;
    const { data, error } = await db
      .from("vendor_aliases")
      .select("canonical_vendor_id,bizzi_vendors!vendor_aliases_business_vendor_fk(*)")
      .eq("business_id", businessId)
      .eq("alias_type", alias.alias_type)
      .eq("normalized_alias_value", alias.normalized_alias_value)
      .maybeSingle();
    if (error) throw error;
    if (data?.bizzi_vendors || data?.canonical_vendor_id) return data.bizzi_vendors || { id: data.canonical_vendor_id };
  }
  return null;
}

async function findVendorByNormalizedName(db, businessId, displayName) {
  const normalized = normalizeVendorText(canonicalizeVendorDisplayName(displayName));
  if (!normalized) return null;
  const { data, error } = await db
    .from("bizzi_vendors")
    .select("*")
    .eq("business_id", businessId)
    .eq("normalized_display_name", normalized)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function upsertAlias(db, { businessId, vendorId, alias, transactionId, source = "resolver" }) {
  if (!businessId || !vendorId || !alias?.alias_value || !alias?.normalized_alias_value) return;
  const payload = {
    business_id: businessId,
    canonical_vendor_id: vendorId,
    alias_type: alias.alias_type,
    alias_value: alias.alias_value,
    normalized_alias_value: alias.normalized_alias_value,
    source,
    confidence: alias.confidence || "medium",
    is_strong_evidence: alias.is_strong_evidence === true,
    is_approved: alias.is_approved === true,
    first_transaction_id: transactionId || null,
    metadata: alias.metadata || {},
    updated_at: nowIso(),
  };
  await db.from("vendor_aliases").upsert(payload, {
    onConflict: "business_id,alias_type,normalized_alias_value",
  });
}

async function createCanonicalVendor(db, { businessId, displayName, evidence, transactionId }) {
  const canonicalName = canonicalizeVendorDisplayName(displayName);
  const normalized = normalizeVendorText(canonicalName);
  const primary = primaryEvidenceFor(evidence);
  const payload = {
    business_id: businessId,
    display_name: canonicalName,
    normalized_display_name: normalized,
    status: "active",
    primary_evidence_type: primary?.alias_type || "manual",
    primary_evidence_value: primary?.alias_value || null,
    primary_source: "resolver",
    confidence: primary?.confidence || "medium",
    metadata: { first_transaction_id: transactionId || null },
  };
  const { data, error } = await db.from("bizzi_vendors").insert(payload).select("*").maybeSingle();
  if (error) throw error;
  await insertEvent(db, {
    business_id: businessId,
    canonical_vendor_id: data?.id,
    transaction_id: transactionId || null,
    event_type: "canonical_vendor_created",
    reason: "resolver_created_canonical_vendor",
    metadata: { display_name: canonicalName },
  });
  return data;
}

async function claimCanonicalVendorByStrongAlias(db, { businessId, displayName, evidence, transactionId }) {
  const strongAlias = strongClaimAliasFor(evidence);
  if (!strongAlias) return null;
  const canonicalName = canonicalizeVendorDisplayName(displayName);
  const normalized = normalizeVendorText(canonicalName);
  const primary = primaryEvidenceFor(evidence) || strongAlias;
  const { data, error } = await db.rpc("claim_canonical_vendor_by_strong_alias", {
    p_business_id: businessId,
    p_alias_type: strongAlias.alias_type,
    p_alias_value: strongAlias.alias_value,
    p_normalized_alias_value: strongAlias.normalized_alias_value,
    p_display_name: canonicalName,
    p_normalized_display_name: normalized,
    p_primary_evidence_type: primary.alias_type || strongAlias.alias_type,
    p_primary_evidence_value: primary.alias_value || strongAlias.alias_value,
    p_primary_source: "resolver",
    p_confidence: primary.confidence || strongAlias.confidence || "high",
    p_transaction_id: transactionId || null,
    p_alias_source: "resolver",
    p_alias_confidence: strongAlias.confidence || "high",
    p_alias_metadata: strongAlias.metadata || {},
    p_vendor_metadata: { first_transaction_id: transactionId || null },
  });
  if (error) throw error;
  const canonicalVendor = data?.canonical_vendor || data?.canonicalVendor || null;
  if (!canonicalVendor?.id) throw new Error("strong_alias_claim_missing_canonical_vendor");
  return {
    canonicalVendor,
    created: data?.created === true,
    reason: data?.created ? "created_from_strong_alias_claim" : "strong_alias_claim_reused",
    strongAlias,
  };
}

async function persistTransactionVendor(db, { businessId, transactionId, canonicalVendorId, qboVendorId = null }) {
  if (!businessId || !transactionId) return;
  const payload = { canonical_vendor_id: canonicalVendorId || null };
  if (qboVendorId) {
    payload.qbo_entity_type = "vendor";
    payload.qbo_entity_id = qboVendorId;
  }
  await db.from("bank_transactions").update(payload).eq("business_id", businessId).eq("id", transactionId);
}

export async function resolveCanonicalVendorForTransaction({
  db = null,
  businessId,
  bankTxn = {},
  payeeResolution = {},
  taxonomyMeta = {},
}) {
  db = db || await getDefaultDb();
  if (!businessId || !bankTxn?.id) return { ok: false, reason: "missing_inputs" };
  const { displayCandidate, evidence } = collectEvidence(bankTxn, payeeResolution);
  if (bankTxn.canonical_vendor_id) {
    return { ok: true, canonicalVendor: { id: bankTxn.canonical_vendor_id }, reason: "transaction_canonical_vendor" };
  }
  if ((bankTxn.qbo_entity_type || "").toLowerCase() === "vendor" && bankTxn.qbo_entity_id) {
    const qboAlias = {
      alias_type: "qbo_vendor_id",
      alias_value: String(bankTxn.qbo_entity_id),
      normalized_alias_value: String(bankTxn.qbo_entity_id),
      confidence: "high",
      is_strong_evidence: true,
      is_approved: true,
    };
    evidence.unshift(qboAlias);
  }

  const blockReason = getVendorAutoCreateBlockReason({ bankTxn, taxonomyMeta, candidateName: displayCandidate || bankTxn.name || "" });
  if (blockReason) return { ok: true, skipped: true, needsReview: true, reason: blockReason, evidence };

  const existing = await findVendorByAlias(db, businessId, evidence);
  if (existing?.id) {
    for (const alias of evidence) {
      await upsertAlias(db, { businessId, vendorId: existing.id, alias, transactionId: bankTxn.id });
    }
    await persistTransactionVendor(db, { businessId, transactionId: bankTxn.id, canonicalVendorId: existing.id });
    return { ok: true, canonicalVendor: existing, reason: "alias_match", evidence };
  }

  if (!evidence.some((e) => e.is_strong_evidence || e.is_approved)) {
    const memoPrefix = cleanMemoPrefix(bankTxn);
    return { ok: true, skipped: true, needsReview: true, reason: "weak_memo_evidence", evidence, memoPrefix };
  }

  const strongClaim = await claimCanonicalVendorByStrongAlias(db, {
    businessId,
    displayName: displayCandidate,
    evidence,
    transactionId: bankTxn.id,
  });
  if (strongClaim?.canonicalVendor?.id) {
    for (const alias of evidence) {
      await upsertAlias(db, { businessId, vendorId: strongClaim.canonicalVendor.id, alias, transactionId: bankTxn.id });
    }
    await persistTransactionVendor(db, { businessId, transactionId: bankTxn.id, canonicalVendorId: strongClaim.canonicalVendor.id });
    return { ok: true, canonicalVendor: strongClaim.canonicalVendor, created: strongClaim.created, reason: strongClaim.reason, evidence };
  }

  const byName = await findVendorByNormalizedName(db, businessId, displayCandidate);
  if (byName?.id) {
    for (const alias of evidence) {
      await upsertAlias(db, { businessId, vendorId: byName.id, alias, transactionId: bankTxn.id });
    }
    await persistTransactionVendor(db, { businessId, transactionId: bankTxn.id, canonicalVendorId: byName.id });
    return { ok: true, canonicalVendor: byName, reason: "canonical_name_match", evidence };
  }

  const created = await createCanonicalVendor(db, {
    businessId,
    displayName: displayCandidate,
    evidence,
    transactionId: bankTxn.id,
  });
  for (const alias of evidence) {
    await upsertAlias(db, { businessId, vendorId: created.id, alias, transactionId: bankTxn.id });
  }
  await persistTransactionVendor(db, { businessId, transactionId: bankTxn.id, canonicalVendorId: created.id });
  return { ok: true, canonicalVendor: created, created: true, reason: "created_from_strong_evidence", evidence };
}

function displayNameOfQboEntity(entity = {}) {
  return entity.DisplayName || entity.CompanyName || entity.FullyQualifiedName || entity.Name || entity.GivenName || null;
}

function mapQboEntities(list = [], type) {
  return (list || [])
    .map((entity) => ({
      id: entity.Id || entity.id || null,
      displayName: displayNameOfQboEntity(entity),
      normalizedDisplayName: normalizeVendorText(displayNameOfQboEntity(entity)),
      active: entity.Active !== false,
      type,
      raw: entity,
    }))
    .filter((entity) => entity.id && entity.displayName);
}

async function qboFind(qbo, method, query, stage) {
  if (!qbo || typeof qbo[method] !== "function") {
    throw new QboVendorProviderError(stage, new Error(`${method}_not_supported`));
  }
  const data = await withVendorProviderStage(stage, () => new Promise((resolve, reject) => {
    qbo[method](query, (err, res) => (err ? reject(err) : resolve(res)));
  }));
  const key = method === "findVendors" ? "Vendor" : method === "findCustomers" ? "Customer" : "Employee";
  return Array.isArray(data?.QueryResponse?.[key]) ? data.QueryResponse[key] : [];
}

export async function refreshQboVendorNameList({
  db = null,
  businessId,
  realmId,
  qboEnv = qboEnvName || "production",
  qbo,
  vendorStage = "qbo_vendor_lookup",
  customerStage = "qbo_customer_lookup",
  employeeStage = "qbo_employee_lookup",
} = {}) {
  db = db || await getDefaultDb();
  const [vendorsActive, vendorsInactive, customers, employees] = await Promise.all([
    qboFind(qbo, "findVendors", { Active: true }, vendorStage),
    qboFind(qbo, "findVendors", { Active: false }, vendorStage),
    qboFind(qbo, "findCustomers", { Active: true }, customerStage),
    qboFind(qbo, "findEmployees", { Active: true }, employeeStage),
  ]);
  const entities = [
    ...mapQboEntities(vendorsActive, "vendor"),
    ...mapQboEntities(vendorsInactive, "vendor"),
    ...mapQboEntities(customers, "customer"),
    ...mapQboEntities(employees, "employee"),
  ];
  for (const entity of entities) {
    await db.from("qbo_vendor_name_cache").upsert(
      {
        business_id: businessId,
        realm_id: realmId,
        qbo_env: qboEnv,
        qbo_entity_type: entity.type,
        qbo_entity_id: entity.id,
        display_name: entity.displayName,
        normalized_display_name: entity.normalizedDisplayName,
        active: entity.active,
        raw: entity.raw || {},
        last_synced_at: nowIso(),
      },
      { onConflict: "business_id,qbo_env,realm_id,qbo_entity_type,qbo_entity_id" }
    );
  }
  return entities;
}

function classifyQboNameMatch({ entities = [], desiredDisplayName = "" }) {
  const desiredNorm = normalizeVendorText(desiredDisplayName);
  const exact = entities.filter((entity) => entity.normalizedDisplayName === desiredNorm);
  const exactVendors = exact.filter((entity) => entity.type === "vendor");
  if (exactVendors.length === 1) return { decision: "reuse_exact_vendor", vendor: exactVendors[0] };
  if (exactVendors.length > 1) return { decision: "ambiguous", candidates: exactVendors };
  if (exact.length) return { decision: "display_name_conflict", candidates: exact };

  const desiredTokens = new Set(desiredNorm.split(" ").filter(Boolean));
  const plausible = entities.filter((entity) => {
    if (entity.type !== "vendor") return false;
    if (entity.normalizedDisplayName.includes(desiredNorm) || desiredNorm.includes(entity.normalizedDisplayName)) return true;
    const tokens = entity.normalizedDisplayName.split(" ").filter(Boolean);
    const overlap = tokens.filter((token) => desiredTokens.has(token)).length;
    return tokens.length && desiredTokens.size && overlap / Math.max(tokens.length, desiredTokens.size) >= 0.8;
  });
  if (plausible.length === 1) return { decision: "probable_requires_review", candidates: plausible };
  if (plausible.length > 1) return { decision: "ambiguous", candidates: plausible };
  return { decision: "create" };
}

async function findActiveMapping(db, { businessId, realmId, qboEnv, canonicalVendorId }) {
  const { data, error } = await db
    .from("business_qbo_vendor_mappings")
    .select("*")
    .eq("business_id", businessId)
    .eq("realm_id", realmId)
    .eq("qbo_env", qboEnv)
    .eq("canonical_vendor_id", canonicalVendorId)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

function getRecentActiveMappingVendor(mapping) {
  if (!mapping?.qbo_vendor_id || mapping.status !== "active") return null;
  if (!isRecentTimestamp(mapping.last_validated_at)) return null;
  if (mapping.disabled_at) return null;
  const metadata = mapping.metadata || {};
  if (metadata.validation_failed === true || metadata.provider_error === true || metadata.requires_revalidation === true) return null;
  return {
    id: String(mapping.qbo_vendor_id),
    displayName: mapping.qbo_display_name,
    active: true,
    type: "vendor",
    source: "recent_mapping",
  };
}

function findUsableCachedVendor(entities = [], qboVendorId) {
  if (!qboVendorId) return null;
  return entities.find((entity) =>
    entity.type === "vendor" &&
    String(entity.id) === String(qboVendorId) &&
    entity.active !== false
  ) || null;
}

async function markMappingNeedsReview(db, { businessId, realmId, qboEnv, canonicalVendorId, qboVendorId, reason, transactionId }) {
  await db
    .from("business_qbo_vendor_mappings")
    .update({
      status: "needs_review",
      disabled_at: nowIso(),
      metadata: { reason },
      updated_at: nowIso(),
    })
    .eq("business_id", businessId)
    .eq("realm_id", realmId)
    .eq("qbo_env", qboEnv)
    .eq("canonical_vendor_id", canonicalVendorId)
    .eq("status", "active");
  await insertEvent(db, {
    business_id: businessId,
    realm_id: realmId,
    qbo_env: qboEnv,
    canonical_vendor_id: canonicalVendorId,
    qbo_vendor_id: qboVendorId || null,
    transaction_id: transactionId || null,
    event_type: "conflict_detected",
    reason,
  });
}

async function markMappingValidated(db, { businessId, realmId, qboEnv, canonicalVendorId }) {
  const validatedAt = nowIso();
  await db
    .from("business_qbo_vendor_mappings")
    .update({
      last_validated_at: validatedAt,
      updated_at: validatedAt,
    })
    .eq("business_id", businessId)
    .eq("realm_id", realmId)
    .eq("qbo_env", qboEnv)
    .eq("canonical_vendor_id", canonicalVendorId)
    .eq("status", "active");
  return validatedAt;
}

async function upsertMapping(db, { businessId, realmId, qboEnv, canonicalVendorId, qboVendorId, qboDisplayName, source, transactionId }) {
  const payload = {
    p_business_id: businessId,
    p_realm_id: realmId,
    p_qbo_env: qboEnv,
    p_canonical_vendor_id: canonicalVendorId,
    p_qbo_vendor_id: String(qboVendorId),
    p_qbo_display_name: qboDisplayName,
    p_mapping_source: source,
    p_created_by: "bizzi",
    p_mapped_by: null,
    p_first_transaction_id: transactionId || null,
    p_metadata: {},
  };
  const { data, error } = await db.rpc("upsert_active_qbo_vendor_mapping", payload);
  if (error) throw new QboVendorProviderError("canonical_vendor_db", error);
  await upsertAlias(db, {
    businessId,
    vendorId: canonicalVendorId,
    alias: {
      alias_type: "qbo_vendor_id",
      alias_value: String(qboVendorId),
      normalized_alias_value: String(qboVendorId),
      confidence: "high",
      is_strong_evidence: true,
      is_approved: true,
    },
    transactionId,
    source,
  });
  await upsertAlias(db, {
    businessId,
    vendorId: canonicalVendorId,
    alias: {
      alias_type: "qbo_display_name",
      alias_value: qboDisplayName,
      normalized_alias_value: normalizeVendorText(qboDisplayName),
      confidence: "high",
      is_strong_evidence: true,
      is_approved: true,
    },
    transactionId,
    source,
  });
  return data || {
    business_id: businessId,
    realm_id: realmId,
    qbo_env: qboEnv,
    canonical_vendor_id: canonicalVendorId,
    qbo_vendor_id: String(qboVendorId),
    qbo_display_name: qboDisplayName,
    status: "active",
    mapping_source: source,
    first_transaction_id: transactionId || null,
  };
}

async function hydrateCanonicalVendor(db, { businessId, canonicalVendor }) {
  if (!canonicalVendor?.id || canonicalVendor?.display_name) return canonicalVendor;
  const { data, error } = await db
    .from("bizzi_vendors")
    .select("id,business_id,display_name,normalized_display_name,status,primary_evidence_type,confidence")
    .eq("business_id", businessId)
    .eq("id", canonicalVendor.id)
    .maybeSingle();
  if (error) throw error;
  return data || canonicalVendor;
}

export async function requireCanonicalVendorForBusiness({
  db = null,
  businessId,
  canonicalVendorId,
  allowedStatuses = ["active", "needs_review"],
} = {}) {
  db = db || await getDefaultDb();
  if (!businessId || !canonicalVendorId) throw new Error("canonical_vendor_not_found");
  const { data, error } = await db
    .from("bizzi_vendors")
    .select("id,business_id,display_name,normalized_display_name,status,primary_evidence_type,confidence")
    .eq("business_id", businessId)
    .eq("id", canonicalVendorId)
    .maybeSingle();
  if (error) throw error;
  if (!data?.id || !allowedStatuses.includes(data.status)) {
    throw new Error("canonical_vendor_not_found");
  }
  return data;
}

async function reconsiderVendorBlockedTransactions(db, { businessId, canonicalVendorId }) {
  if (!businessId || !canonicalVendorId) return { updated: 0 };
  const autoPostEnabled = await getAutoPostToQuickBooks(db, businessId).catch(() => false);
  const postAfter = computePostAfterForAutoPost(autoPostEnabled, 24);
  const payload = {
    status: "approved",
    post_error: null,
    post_after: postAfter,
    updated_at: nowIso(),
  };
  const { data, error } = await db
    .from("transaction_categorizations")
    .update(payload)
    .eq("business_id", businessId)
    .eq("status", "needs_review")
    .filter("meta->>vendor_review_canonical_vendor_id", "eq", canonicalVendorId)
    .select("transaction_id");
  if (error) throw error;
  return { updated: Array.isArray(data) ? data.length : 0, post_after: postAfter };
}

export async function fetchCanonicalVendorActivityForBusiness({ db = null, businessId, limit = 50 }) {
  db = db || await getDefaultDb();
  if (!businessId) throw new Error("missing_business_id");
  const max = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const [{ data: vendors, error: vendorErr }, { data: mappings, error: mappingErr }, { data: intents, error: intentErr }, { data: events, error: eventErr }, { data: aliases, error: aliasErr }] = await Promise.all([
    db.from("bizzi_vendors").select("id,business_id,display_name,status,primary_evidence_type,confidence,created_at,updated_at").eq("business_id", businessId).order("updated_at", { ascending: false }).limit(max),
    db.from("business_qbo_vendor_mappings").select("canonical_vendor_id,realm_id,qbo_env,qbo_vendor_id,qbo_display_name,status,mapping_source,metadata,mapped_at,created_at").eq("business_id", businessId),
    db.from("qbo_vendor_creation_intents").select("canonical_vendor_id,realm_id,qbo_env,status,qbo_vendor_id,qbo_display_name,last_error,updated_at,created_at").eq("business_id", businessId),
    db.from("vendor_mapping_events").select("id,canonical_vendor_id,qbo_vendor_id,qbo_display_name,event_type,reason,metadata,transaction_id,created_at").eq("business_id", businessId).order("created_at", { ascending: false }).limit(max),
    db.from("vendor_aliases").select("canonical_vendor_id,alias_type,alias_value,normalized_alias_value,is_strong_evidence,is_approved,confidence,created_at").eq("business_id", businessId).order("created_at", { ascending: false }).limit(max * 4),
  ]);
  if (vendorErr) throw vendorErr;
  if (mappingErr) throw mappingErr;
  if (intentErr) throw intentErr;
  if (eventErr) throw eventErr;
  if (aliasErr) throw aliasErr;

  const mappingByVendor = new Map((mappings || []).filter((row) => row.status === "active").map((row) => [row.canonical_vendor_id, row]));
  const reviewMappingByVendor = new Map((mappings || []).filter((row) => row.status === "needs_review").map((row) => [row.canonical_vendor_id, row]));
  const intentByVendor = new Map((intents || []).map((row) => [row.canonical_vendor_id, row]));
  const aliasesByVendor = new Map();
  for (const alias of aliases || []) {
    if (!aliasesByVendor.has(alias.canonical_vendor_id)) aliasesByVendor.set(alias.canonical_vendor_id, []);
    aliasesByVendor.get(alias.canonical_vendor_id).push(alias);
  }
  const latestReviewEventByVendor = new Map();
  for (const event of events || []) {
    if (!event.canonical_vendor_id) continue;
    if (["conflict_detected", "needs_review", "creation_unknown", "creation_failed"].includes(event.event_type) && !latestReviewEventByVendor.has(event.canonical_vendor_id)) {
      latestReviewEventByVendor.set(event.canonical_vendor_id, event);
    }
  }

  const rows = (vendors || []).map((vendor) => {
    const mapping = mappingByVendor.get(vendor.id) || null;
    const reviewMapping = reviewMappingByVendor.get(vendor.id) || null;
    const intent = intentByVendor.get(vendor.id) || null;
    const reviewEvent = latestReviewEventByVendor.get(vendor.id) || null;
    const vendorAliases = aliasesByVendor.get(vendor.id) || [];
    const needsReview = Boolean(reviewEvent || reviewMapping || intent?.status === "needs_review");
    const createdByBizzi = mapping?.mapping_source === "creation_intent" || intent?.status === "created";
    const latestEvent = (events || []).find((event) => event.canonical_vendor_id === vendor.id) || null;
    const creationEvent = (events || []).find((event) => event.canonical_vendor_id === vendor.id && event.event_type === "qbo_vendor_created") || null;
    const mappingEvent = (events || []).find((event) => event.canonical_vendor_id === vendor.id && ["existing_qbo_vendor_reused", "manual_link", "override"].includes(event.event_type)) || null;
    return {
      canonical_vendor_id: vendor.id,
      display_name: vendor.display_name,
      status: needsReview ? "needs_review" : mapping ? (createdByBizzi ? "created_by_bizzi" : "mapped_existing") : vendor.status,
      status_label: needsReview ? "Needs Review" : mapping ? (createdByBizzi ? "Created by Bizzi" : "Mapped to existing") : "Canonical Vendor",
      qbo_vendor_id: mapping?.qbo_vendor_id || reviewMapping?.qbo_vendor_id || intent?.qbo_vendor_id || null,
      qbo_display_name: mapping?.qbo_display_name || reviewMapping?.qbo_display_name || intent?.qbo_display_name || null,
      realm_id: mapping?.realm_id || reviewMapping?.realm_id || intent?.realm_id || null,
      qbo_env: mapping?.qbo_env || reviewMapping?.qbo_env || intent?.qbo_env || qboEnvName || "production",
      primary_evidence_type: vendor.primary_evidence_type,
      confidence: vendor.confidence,
      alias_count: vendorAliases.length,
      strong_alias_count: vendorAliases.filter((alias) => alias.is_strong_evidence).length,
      aliases: vendorAliases
        .map((alias) => alias.alias_value || alias.normalized_alias_value)
        .filter(Boolean)
        .slice(0, 5),
      review_reason: reviewEvent?.reason || intent?.last_error?.reason || reviewMapping?.metadata?.reason || null,
      exception_type: reviewEvent?.event_type || intent?.last_error?.code || reviewMapping?.metadata?.reason || null,
      candidate_qbo_vendor_id: reviewEvent?.metadata?.candidates?.[0]?.id || null,
      candidate_qbo_vendor_name: reviewEvent?.metadata?.candidates?.[0]?.displayName || null,
      transaction_id: reviewEvent?.transaction_id || null,
      activity_at: creationEvent?.created_at || mappingEvent?.created_at || mapping?.mapped_at || intent?.updated_at || latestEvent?.created_at || vendor.updated_at || vendor.created_at || null,
      mapped_at: mapping?.mapped_at || mappingEvent?.created_at || null,
      created_at: creationEvent?.created_at || intent?.created_at || vendor.created_at || null,
      activity_event_type: creationEvent?.event_type || mappingEvent?.event_type || latestEvent?.event_type || null,
      updated_at: vendor.updated_at || vendor.created_at || null,
    };
  });

  const summary = {
    created_by_bizzi_count: rows.filter((row) => row.status === "created_by_bizzi").length,
    mapped_existing_count: rows.filter((row) => row.status === "mapped_existing").length,
    new_aliases_learned_count: (aliases || []).length,
    needs_review_count: rows.filter((row) => row.status === "needs_review").length,
  };
  return { rows, summary, recent_history: events || [] };
}

export async function useExistingQboVendorForCanonical({
  db = null,
  getQBOClientFn = defaultGetQBOClient,
  getLatestQuickBooksTokenRowFn = defaultGetLatestQuickBooksTokenRow,
  businessId,
  canonicalVendorId,
  qboVendorId,
  actor = "user",
  source = "manual",
}) {
  db = db || await getDefaultDb();
  if (!businessId || !canonicalVendorId || !qboVendorId) throw new Error("missing_vendor_mapping_inputs");
  await requireCanonicalVendorForBusiness({ db, businessId, canonicalVendorId });
  const tokenRow = await getLatestQuickBooksTokenRowFn(businessId);
  const realmId = tokenRow?.realm_id || null;
  const qboEnv = tokenRow?.qbo_env || qboEnvName || "production";
  if (!realmId) throw new Error("qbo_client_unavailable:no_active_token_row");
  const qbo = await getQBOClientFn(businessId);
  if (!qbo) throw new Error("qbo_client_unavailable");
  const entities = await refreshQboVendorNameList({ db, businessId, realmId, qboEnv, qbo });
  const selected = entities.find((entity) => String(entity.id) === String(qboVendorId));
  if (!selected) throw new Error("qbo_vendor_not_found");
  if (selected.type !== "vendor" || selected.active === false) throw new Error("qbo_vendor_not_usable");
  const mapping = await upsertMapping(db, {
    businessId,
    realmId,
    qboEnv,
    canonicalVendorId,
    qboVendorId: selected.id,
    qboDisplayName: selected.displayName,
    source: "manual",
    transactionId: null,
  });
  await insertEvent(db, {
    business_id: businessId,
    realm_id: realmId,
    qbo_env: qboEnv,
    canonical_vendor_id: canonicalVendorId,
    qbo_vendor_id: selected.id,
    qbo_display_name: selected.displayName,
    event_type: "manual_link",
    source,
    actor,
    reason: "manual_existing_vendor_selected",
  });
  const reconsideration = await reconsiderVendorBlockedTransactions(db, { businessId, canonicalVendorId });
  return { ok: true, mapping, reconsideration };
}

export async function createQboVendorForCanonicalReview({
  db = null,
  getQBOClientFn = defaultGetQBOClient,
  getLatestQuickBooksTokenRowFn = defaultGetLatestQuickBooksTokenRow,
  businessId,
  canonicalVendorId,
  transactionId = null,
  actor = "user",
  source = "manual",
}) {
  db = db || await getDefaultDb();
  if (!businessId || !canonicalVendorId) throw new Error("missing_canonical_vendor_id");
  await requireCanonicalVendorForBusiness({ db, businessId, canonicalVendorId });
  let bankTxn = { id: transactionId || `manual-${canonicalVendorId}`, canonical_vendor_id: canonicalVendorId };
  if (transactionId) {
    const { data, error } = await db
      .from("bank_transactions")
      .select("id,business_id,plaid_account_id,plaid_transaction_id,date,name,merchant_name,merchant_entity_id,counterparties,direction,counterparty_name,counterparty_source,counterparty_confidence,canonical_vendor_id,qbo_entity_type,qbo_entity_id,amount,signed_amount,category_primary,personal_finance_category,check_number")
      .eq("business_id", businessId)
      .eq("id", transactionId)
      .maybeSingle();
    if (error) throw error;
    if (!data?.id) throw new Error("transaction_not_found");
    if (data.canonical_vendor_id && data.canonical_vendor_id !== canonicalVendorId) {
      throw new Error("transaction_canonical_vendor_mismatch");
    }
    bankTxn = { ...data, canonical_vendor_id: canonicalVendorId };
  }
  const result = await ensureCanonicalVendorMappedToQbo({
    db,
    getQBOClientFn,
    getLatestQuickBooksTokenRowFn,
    businessId,
    bankTxn,
    payeeResolution: {},
    taxonomyMeta: {},
    source,
    createdBy: actor,
  });
  if (!result?.qbo_entity_id) return { ...result, ok: false };
  const reconsideration = await reconsiderVendorBlockedTransactions(db, { businessId, canonicalVendorId });
  return { ...result, ok: true, reconsideration };
}

export async function markCanonicalVendorNotRequiredForTransaction({ db = null, businessId, canonicalVendorId, transactionId, actor = "user", source = "manual" }) {
  db = db || await getDefaultDb();
  if (!businessId || !canonicalVendorId || !transactionId) throw new Error("missing_no_vendor_inputs");
  await requireCanonicalVendorForBusiness({ db, businessId, canonicalVendorId });
  const { data: txn, error } = await db
    .from("bank_transactions")
    .select("id,business_id,name,merchant_name,counterparty_name,merchant_entity_id,canonical_vendor_id,direction,amount,signed_amount,category_primary,personal_finance_category,check_number")
    .eq("business_id", businessId)
    .eq("id", transactionId)
    .maybeSingle();
  if (error) throw error;
  if (!txn?.id) throw new Error("transaction_not_found");
  const { data: existingCategorization, error: catReadError } = await db
    .from("transaction_categorizations")
    .select("meta")
    .eq("business_id", businessId)
    .eq("transaction_id", transactionId)
    .maybeSingle();
  if (catReadError) throw catReadError;
  const linkedCanonicalVendorId = txn.canonical_vendor_id || existingCategorization?.meta?.vendor_review_canonical_vendor_id || null;
  if (linkedCanonicalVendorId !== canonicalVendorId) {
    throw new Error("transaction_canonical_vendor_mismatch");
  }
  const requirement = getVendorPostingRequirement({ bankTxn: txn || {}, taxonomyMeta: {}, qboTxnType: "Purchase" });
  if (requirement.required) throw new Error("vendor_required_for_transaction");
  const now = nowIso();
  await db
    .from("transaction_categorizations")
    .update({
      post_error: null,
      updated_at: now,
      meta: {
        ...(existingCategorization?.meta || {}),
        vendor_not_required: true,
        vendor_not_required_reason: requirement.reason,
        vendor_not_required_actor: actor,
      },
    })
    .eq("business_id", businessId)
    .eq("transaction_id", transactionId);
  await insertEvent(db, {
    business_id: businessId,
    canonical_vendor_id: canonicalVendorId,
    transaction_id: transactionId,
    event_type: "override",
    source,
    actor,
    reason: "no_vendor_needed",
    metadata: { requirement_reason: requirement.reason },
  });
  return { ok: true, requirement };
}

async function markIntent(db, { businessId, realmId, qboEnv, canonicalVendorId, status, qboVendorId = null, qboDisplayName = null, responseSummary = null, lastError = null }) {
  await db
    .from("qbo_vendor_creation_intents")
    .update({
      status,
      qbo_vendor_id: qboVendorId,
      qbo_display_name: qboDisplayName,
      response_summary: responseSummary,
      last_error: lastError,
      lease_expires_at: null,
      updated_at: nowIso(),
    })
    .eq("business_id", businessId)
    .eq("realm_id", realmId)
    .eq("qbo_env", qboEnv)
    .eq("canonical_vendor_id", canonicalVendorId);
}

async function createQboVendorWithRequestId(qbo, { displayName, requestId }) {
  const payload = {
    requestId,
    DisplayName: displayName,
    CompanyName: displayName,
    PrintOnCheckName: displayName,
    Active: true,
  };
  const fn = qbo?.vendor && typeof qbo.vendor.create === "function" ? qbo.vendor.create : qbo?.createVendor;
  if (!fn) throw new QboVendorProviderError("qbo_vendor_create", new Error("qbo_vendor_create_not_supported"));
  const data = await withVendorProviderStage("qbo_vendor_create", () => new Promise((resolve, reject) => {
    fn.call(qbo, payload, (err, res) => (err ? reject(err) : resolve(res)));
  }));
  const vendor = data?.Vendor || data?.vendor || data || null;
  if (!vendor?.Id && !vendor?.id) throw new QboVendorProviderError("qbo_vendor_create", new Error("qbo_vendor_create_missing_id"));
  return {
    id: vendor.Id || vendor.id,
    displayName: vendor.DisplayName || vendor.CompanyName || displayName,
    raw: vendor,
  };
}

export async function ensureCanonicalVendorMappedToQbo({
  db = null,
  getQBOClientFn = defaultGetQBOClient,
  getLatestQuickBooksTokenRowFn = defaultGetLatestQuickBooksTokenRow,
  qboClient = null,
  tokenRow: providedTokenRow = null,
  businessId,
  bankTxn = {},
  payeeResolution = {},
  taxonomyMeta = {},
  source = "posting",
  createdBy = "bizzi",
}) {
  db = db || await getDefaultDb();
  const resolved = await resolveCanonicalVendorForTransaction({ db, businessId, bankTxn, payeeResolution, taxonomyMeta });
  if (!resolved?.canonicalVendor?.id) return resolved;
  resolved.canonicalVendor = await hydrateCanonicalVendor(db, { businessId, canonicalVendor: resolved.canonicalVendor });

  const tokenRow = providedTokenRow || await getLatestQuickBooksTokenRowFn(businessId);
  const realmId = tokenRow?.realm_id || null;
  const qboEnv = tokenRow?.qbo_env || qboEnvName || "production";
  if (!realmId) return { ok: false, skipped: true, reason: "qbo_client_unavailable:no_active_token_row", canonicalVendor: resolved.canonicalVendor };

  const existingMapping = await findActiveMapping(db, {
    businessId,
    realmId,
    qboEnv,
    canonicalVendorId: resolved.canonicalVendor.id,
  });
  if (existingMapping?.qbo_vendor_id) {
    const recentVendor = getRecentActiveMappingVendor(existingMapping);
    if (recentVendor) {
      await persistTransactionVendor(db, {
        businessId,
        transactionId: bankTxn.id,
        canonicalVendorId: resolved.canonicalVendor.id,
        qboVendorId: recentVendor.id,
      });
      return {
        ok: true,
        created: false,
        reason: "canonical_mapping_recent",
        vendor_validation_mode: "cache_hit",
        canonical_vendor_id: resolved.canonicalVendor.id,
        qbo_entity_type: "vendor",
        qbo_entity_id: recentVendor.id,
        vendor_name: recentVendor.displayName || existingMapping.qbo_display_name,
      };
    }
  }
  const qbo = qboClient || await withVendorProviderStage("qbo_client_acquisition", () => getQBOClientFn(businessId));
  if (!qbo) return { ok: false, skipped: true, reason: "qbo_client_unavailable", canonicalVendor: resolved.canonicalVendor };
  if (existingMapping?.qbo_vendor_id) {
    const entities = await refreshQboVendorNameList({ db, businessId, realmId, qboEnv, qbo, vendorStage: "qbo_vendor_mapping_revalidation" });
    const usable = findUsableCachedVendor(entities, existingMapping.qbo_vendor_id);
    if (!usable) {
      await markMappingNeedsReview(db, {
        businessId,
        realmId,
        qboEnv,
        canonicalVendorId: resolved.canonicalVendor.id,
        qboVendorId: existingMapping.qbo_vendor_id,
        reason: "vendor_mapping_invalid",
        transactionId: bankTxn.id,
      });
      return {
        ok: true,
        skipped: true,
        needsReview: true,
        reason: "vendor_mapping_invalid",
        canonical_vendor_id: resolved.canonicalVendor.id,
      };
    }
    await markMappingValidated(db, {
      businessId,
      realmId,
      qboEnv,
      canonicalVendorId: resolved.canonicalVendor.id,
    });
    await persistTransactionVendor(db, {
      businessId,
      transactionId: bankTxn.id,
      canonicalVendorId: resolved.canonicalVendor.id,
      qboVendorId: usable.id,
    });
    return {
      ok: true,
      created: false,
      reason: "canonical_mapping",
      vendor_validation_mode: "fresh_validation",
      canonical_vendor_id: resolved.canonicalVendor.id,
      qbo_entity_type: "vendor",
      qbo_entity_id: usable.id,
      vendor_name: usable.displayName || existingMapping.qbo_display_name,
    };
  }

  const desiredDisplayName = (resolved.canonicalVendor.display_name || canonicalizeVendorDisplayName(payeeResolution?.counterpartyName || bankTxn.merchant_name || bankTxn.counterparty_name || "")).slice(0, 41);
  let entities = await refreshQboVendorNameList({ db, businessId, realmId, qboEnv, qbo });
  let match = classifyQboNameMatch({ entities, desiredDisplayName });
  if (match.decision === "reuse_exact_vendor") {
    const mapping = await upsertMapping(db, {
      businessId,
      realmId,
      qboEnv,
      canonicalVendorId: resolved.canonicalVendor.id,
      qboVendorId: match.vendor.id,
      qboDisplayName: match.vendor.displayName,
      source: "resolver",
      transactionId: bankTxn.id,
    });
    await insertEvent(db, {
      business_id: businessId,
      realm_id: realmId,
      qbo_env: qboEnv,
      canonical_vendor_id: resolved.canonicalVendor.id,
      qbo_vendor_id: match.vendor.id,
      qbo_display_name: match.vendor.displayName,
      transaction_id: bankTxn.id,
      event_type: "existing_qbo_vendor_reused",
      reason: "exact_display_name",
    });
    await persistTransactionVendor(db, { businessId, transactionId: bankTxn.id, canonicalVendorId: resolved.canonicalVendor.id, qboVendorId: mapping.qbo_vendor_id });
    return { ok: true, created: false, reason: "existing_qbo_vendor_reused", vendor_validation_mode: "fresh_validation", canonical_vendor_id: resolved.canonicalVendor.id, qbo_entity_type: "vendor", qbo_entity_id: mapping.qbo_vendor_id, vendor_name: mapping.qbo_display_name };
  }
  if (match.decision !== "create") {
    await insertEvent(db, {
      business_id: businessId,
      realm_id: realmId,
      qbo_env: qboEnv,
      canonical_vendor_id: resolved.canonicalVendor.id,
      transaction_id: bankTxn.id,
      event_type: "conflict_detected",
      reason: match.decision,
      metadata: { candidates: match.candidates || [], desired_display_name: desiredDisplayName },
    });
    return { ok: true, skipped: true, needsReview: true, reason: match.decision, canonical_vendor_id: resolved.canonicalVendor.id };
  }

  const requestId = stableRequestId({ businessId, realmId, canonicalVendorId: resolved.canonicalVendor.id });
  const payloadSummary = { desired_display_name: desiredDisplayName, source, created_by: createdBy };
  const claim = await withVendorProviderStage("qbo_vendor_creation_intent", () => db.rpc("claim_qbo_vendor_creation_intent", {
    p_business_id: businessId,
    p_realm_id: realmId,
    p_qbo_env: qboEnv,
    p_canonical_vendor_id: resolved.canonicalVendor.id,
    p_desired_display_name: desiredDisplayName,
    p_request_id: requestId,
    p_first_transaction_id: bankTxn.id || null,
    p_payload_summary: payloadSummary,
  }));
  if (claim.error) throw new QboVendorProviderError("qbo_vendor_creation_intent", claim.error);
  const claimData = claim.data || {};
  if (claimData.already_mapped && claimData.intent?.qbo_vendor_id) {
    await persistTransactionVendor(db, { businessId, transactionId: bankTxn.id, canonicalVendorId: resolved.canonicalVendor.id, qboVendorId: claimData.intent.qbo_vendor_id });
    return { ok: true, created: false, reason: "creation_intent_already_mapped", canonical_vendor_id: resolved.canonicalVendor.id, qbo_entity_type: "vendor", qbo_entity_id: claimData.intent.qbo_vendor_id, vendor_name: claimData.intent.qbo_display_name };
  }
  if (!claimData.claimed) {
    return { ok: true, skipped: true, deferred: true, reason: "vendor_creation_in_progress", canonical_vendor_id: resolved.canonicalVendor.id };
  }

  entities = await refreshQboVendorNameList({ db, businessId, realmId, qboEnv, qbo, vendorStage: "qbo_vendor_create_recovery" });
  match = classifyQboNameMatch({ entities, desiredDisplayName });
  if (match.decision === "reuse_exact_vendor") {
    const mapping = await upsertMapping(db, { businessId, realmId, qboEnv, canonicalVendorId: resolved.canonicalVendor.id, qboVendorId: match.vendor.id, qboDisplayName: match.vendor.displayName, source: "creation_intent", transactionId: bankTxn.id });
    await markIntent(db, { businessId, realmId, qboEnv, canonicalVendorId: resolved.canonicalVendor.id, status: "mapped_existing", qboVendorId: mapping.qbo_vendor_id, qboDisplayName: mapping.qbo_display_name, responseSummary: { reason: "found_on_recheck" } });
    await persistTransactionVendor(db, { businessId, transactionId: bankTxn.id, canonicalVendorId: resolved.canonicalVendor.id, qboVendorId: mapping.qbo_vendor_id });
    return { ok: true, created: false, reason: "existing_qbo_vendor_reused_after_claim", vendor_validation_mode: "fresh_validation", canonical_vendor_id: resolved.canonicalVendor.id, qbo_entity_type: "vendor", qbo_entity_id: mapping.qbo_vendor_id, vendor_name: mapping.qbo_display_name };
  }
  if (match.decision !== "create") {
    await markIntent(db, { businessId, realmId, qboEnv, canonicalVendorId: resolved.canonicalVendor.id, status: "needs_review", lastError: { reason: match.decision, candidates: match.candidates || [] } });
    await insertEvent(db, { business_id: businessId, realm_id: realmId, qbo_env: qboEnv, canonical_vendor_id: resolved.canonicalVendor.id, transaction_id: bankTxn.id, event_type: "conflict_detected", reason: match.decision, metadata: { candidates: match.candidates || [] } });
    return { ok: true, skipped: true, needsReview: true, reason: match.decision, canonical_vendor_id: resolved.canonicalVendor.id };
  }

  try {
    const created = await createQboVendorWithRequestId(qbo, { displayName: desiredDisplayName, requestId });
    const mapping = await upsertMapping(db, { businessId, realmId, qboEnv, canonicalVendorId: resolved.canonicalVendor.id, qboVendorId: created.id, qboDisplayName: created.displayName, source: "creation_intent", transactionId: bankTxn.id });
    await markIntent(db, { businessId, realmId, qboEnv, canonicalVendorId: resolved.canonicalVendor.id, status: "created", qboVendorId: created.id, qboDisplayName: created.displayName, responseSummary: { qbo_vendor_id: created.id, display_name: created.displayName } });
    await db.from("qbo_vendor_creations").upsert(
      {
        business_id: businessId,
        qbo_entity_type: "vendor",
        qbo_entity_id: created.id,
        vendor_name: created.displayName,
        created_by: createdBy,
        source,
        source_transaction_id: bankTxn.id || null,
        meta: { reason: "created_for_canonical_vendor", canonical_vendor_id: resolved.canonicalVendor.id, request_id: requestId, realm_id: realmId, qbo_env: qboEnv },
      },
      { onConflict: "business_id,qbo_entity_type,qbo_entity_id" }
    );
    await insertEvent(db, { business_id: businessId, realm_id: realmId, qbo_env: qboEnv, canonical_vendor_id: resolved.canonicalVendor.id, qbo_vendor_id: created.id, qbo_display_name: created.displayName, transaction_id: bankTxn.id, event_type: "qbo_vendor_created", reason: "created_for_canonical_vendor", metadata: { request_id: requestId } });
    await persistTransactionVendor(db, { businessId, transactionId: bankTxn.id, canonicalVendorId: resolved.canonicalVendor.id, qboVendorId: mapping.qbo_vendor_id });
    return { ok: true, created: true, reason: "qbo_vendor_created", canonical_vendor_id: resolved.canonicalVendor.id, qbo_entity_type: "vendor", qbo_entity_id: mapping.qbo_vendor_id, vendor_name: mapping.qbo_display_name };
  } catch (err) {
    const diagnostics = classifyQboVendorProviderError(err, "qbo_vendor_create");
    await markIntent(db, { businessId, realmId, qboEnv, canonicalVendorId: resolved.canonicalVendor.id, status: diagnostics.retryable ? "unknown" : "needs_review", lastError: diagnostics });
    await insertEvent(db, {
      business_id: businessId,
      realm_id: realmId,
      qbo_env: qboEnv,
      canonical_vendor_id: resolved.canonicalVendor.id,
      transaction_id: bankTxn.id,
      event_type: diagnostics.retryable ? "creation_unknown" : "creation_failed",
      reason: diagnostics.code || "vendor_qbo_create_unknown",
      metadata: {
        stage: diagnostics.stage,
        provider_code: diagnostics.provider_code,
        http_status: diagnostics.http_status,
        reconnect_required: diagnostics.reconnect_required,
      },
    });
    return { ok: false, unknown: diagnostics.retryable, needsReview: !diagnostics.retryable, reason: diagnostics.code || "vendor_qbo_create_unknown", error: diagnostics.code, vendorDiagnostics: diagnostics, canonical_vendor_id: resolved.canonicalVendor.id };
  }
}
