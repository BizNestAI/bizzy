import crypto from "crypto";

export const PLAID_MUTATION_DURING_PAGINATION = "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION";

export function normalizeIdentityText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeAccountName(value) {
  return normalizeIdentityText(value)
    .replace(/\b(checking|savings|credit card|credit|card|account|acct)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeMoney(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return num.toFixed(2);
}

export function normalizeDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function dateDiffDays(a, b) {
  const da = normalizeDate(a);
  const db = normalizeDate(b);
  if (!da || !db) return null;
  const at = Date.parse(`${da}T00:00:00Z`);
  const bt = Date.parse(`${db}T00:00:00Z`);
  if (!Number.isFinite(at) || !Number.isFinite(bt)) return null;
  return Math.abs((at - bt) / 86_400_000);
}

export function buildPhysicalAccountIdentity({ account = {}, item = {}, plaidEnv = null } = {}) {
  const institutionId = item.institution_id || item.institutionId || null;
  const institutionName = item.institution_name || item.institutionName || null;
  const mask = account.mask ? String(account.mask) : null;
  const type = account.type ? String(account.type).toLowerCase() : null;
  const subtype = account.subtype ? String(account.subtype).toLowerCase() : null;
  const normalizedAccountName = normalizeAccountName(account.name || account.official_name || account.officialName || "");
  const strong =
    Boolean(institutionId) &&
    Boolean(mask) &&
    Boolean(type) &&
    Boolean(subtype);

  return {
    business_id: item.business_id || null,
    plaid_env: plaidEnv || item.plaid_env || null,
    institution_id: institutionId,
    institution_name: institutionName,
    account_mask: mask,
    account_type: type,
    account_subtype: subtype,
    normalized_account_name: normalizedAccountName || null,
    confidence: strong ? "high" : "probable",
    strong,
  };
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function buildCanonicalTransactionIdentity(row = {}) {
  const physicalAccountId = row.physical_account_id || null;
  const accountKey = physicalAccountId || row.plaid_account_id || null;
  const postedDate = normalizeDate(row.date);
  const authorizedDate = normalizeDate(row.authorized_date);
  const amount = normalizeMoney(row.signed_amount ?? row.amount);
  const memo = normalizeIdentityText(row.counterparty_name || row.merchant_name || row.name || "");
  const paymentChannel = normalizeIdentityText(row.payment_channel || "");
  const transactionType = normalizeIdentityText(row.transaction_type || "");
  const checkNumber = normalizeIdentityText(row.check_number || "");
  const merchantEntityId = row.merchant_entity_id ? String(row.merchant_entity_id) : "";

  if (!accountKey || !postedDate || amount == null || !memo) {
    return { fingerprint: null, confidence: "none", reason: "insufficient_fields" };
  }

  const exactAnchor = checkNumber;
  const confidence = physicalAccountId && exactAnchor ? "deterministic" : physicalAccountId ? "probable" : "provider";
  const reason = checkNumber
    ? "physical_account_check_number"
    : physicalAccountId
    ? "physical_account_probable"
    : "provider_account_probable";
  const raw = [
    accountKey,
    postedDate,
    authorizedDate || "",
    amount,
    memo,
    paymentChannel,
    transactionType,
    checkNumber,
    merchantEntityId,
  ].join("|");

  return {
    fingerprint: sha256(raw),
    confidence,
    reason,
    raw,
  };
}

export function isDeterministicCanonicalIdentity(identity = {}) {
  return identity.confidence === "deterministic" && Boolean(identity.fingerprint);
}

export function isPlaidMutationDuringPaginationError(error) {
  const code =
    error?.response?.data?.error_code ||
    error?.data?.error_code ||
    error?.error_code ||
    error?.code ||
    "";
  const message = String(error?.message || error?.response?.data?.error_message || "");
  return code === PLAID_MUTATION_DURING_PAGINATION || message.includes(PLAID_MUTATION_DURING_PAGINATION);
}

export function hasMaterialTransactionChange(existing = {}, incoming = {}) {
  if (!existing || !incoming) return false;
  const existingAmount = normalizeMoney(existing.signed_amount ?? existing.amount);
  const incomingAmount = normalizeMoney(incoming.signed_amount ?? incoming.amount);
  return (
    existingAmount !== incomingAmount ||
    normalizeDate(existing.date) !== normalizeDate(incoming.date) ||
    normalizeIdentityText(existing.name || existing.merchant_name || "") !==
      normalizeIdentityText(incoming.name || incoming.merchant_name || "")
  );
}

export function findPendingLifecycleCandidate(incoming = {}, candidates = []) {
  const incomingAmount = normalizeMoney(incoming.signed_amount ?? incoming.amount);
  const incomingMemo = normalizeIdentityText(incoming.merchant_name || incoming.name || "");
  const physicalAccountId = incoming.physical_account_id || null;
  if (!physicalAccountId || incomingAmount == null || !incomingMemo) return null;

  const matches = (candidates || []).filter((candidate) => {
    if (!candidate?.pending) return false;
    if (candidate.physical_account_id !== physicalAccountId) return false;
    const candidateAmount = normalizeMoney(candidate.signed_amount ?? candidate.amount);
    if (candidateAmount == null) return false;
    const candidateMemo = normalizeIdentityText(candidate.merchant_name || candidate.name || "");
    if (candidateMemo !== incomingMemo) return false;
    const sameDirection = Number(candidateAmount) === 0 || Number(incomingAmount) === 0
      ? true
      : Math.sign(Number(candidateAmount)) === Math.sign(Number(incomingAmount));
    if (!sameDirection) return false;
    const exactAmount = candidateAmount === incomingAmount;
    const candidateDates = [candidate.date, candidate.authorized_date].filter(Boolean);
    const incomingDates = [incoming.date, incoming.authorized_date].filter(Boolean);
    const minDiff = Math.min(...candidateDates.flatMap((candidateDate) =>
      incomingDates.map((incomingDate) => dateDiffDays(candidateDate, incomingDate)).filter((diff) => diff != null)
    ));
    if (!Number.isFinite(minDiff)) return false;
    if (exactAmount) return minDiff <= 2;
    const merchantEntityMatches = Boolean(candidate.merchant_entity_id && incoming.merchant_entity_id && String(candidate.merchant_entity_id) === String(incoming.merchant_entity_id));
    const strongNetworkEvidence = merchantEntityMatches || incomingMemo.length >= 8;
    return strongNetworkEvidence && minDiff <= 5;
  });

  return matches.length === 1 ? matches[0] : null;
}

export function findProbableRelinkDuplicateCandidates(incoming = {}, candidates = []) {
  const incomingAmount = normalizeMoney(incoming.signed_amount ?? incoming.amount);
  const incomingMemo = normalizeIdentityText(incoming.merchant_name || incoming.name || "");
  const physicalAccountId = incoming.physical_account_id || null;
  if (!physicalAccountId || incomingAmount == null || !incomingMemo) return [];

  return (candidates || []).filter((candidate) => {
    if (!candidate?.id || candidate.is_archived) return false;
    if (candidate.physical_account_id !== physicalAccountId) return false;
    if (candidate.plaid_transaction_id && incoming.plaid_transaction_id && candidate.plaid_transaction_id === incoming.plaid_transaction_id) return false;
    if (normalizeMoney(candidate.signed_amount ?? candidate.amount) !== incomingAmount) return false;
    const candidateMemo = normalizeIdentityText(candidate.merchant_name || candidate.name || "");
    if (!candidateMemo || candidateMemo !== incomingMemo) return false;
    const candidateDates = new Set([normalizeDate(candidate.date), normalizeDate(candidate.authorized_date)].filter(Boolean));
    const incomingDates = [normalizeDate(incoming.date), normalizeDate(incoming.authorized_date)].filter(Boolean);
    return incomingDates.some((date) => candidateDates.has(date));
  });
}
