export function normalizeQboGlAccountKey(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildQboGlAccountEvidence({
  categorization = {},
  qboPostedTransaction = {},
  qboAccount = {},
} = {}) {
  const accountId = firstNonEmpty(
    categorization.final_qbo_account_id,
    categorization.suggested_qbo_account_id,
    qboAccount.qbo_account_id,
    qboAccount.Id,
    qboAccount.id,
    extractAccountRef(qboPostedTransaction)?.value
  );
  const accountName = firstNonEmpty(
    categorization.final_qbo_account_name,
    categorization.suggested_qbo_account_name,
    qboAccount.qbo_account_name,
    qboAccount.Name,
    qboAccount.name,
    extractAccountRef(qboPostedTransaction)?.name
  );
  const accountType = firstNonEmpty(
    categorization.qbo_account_type,
    categorization.final_qbo_account_type,
    categorization.suggested_qbo_account_type,
    categorization.meta?.qbo_account_type,
    categorization.meta?.final_qbo_account_type,
    categorization.meta?.suggested_qbo_account_type,
    qboAccount.qbo_account_type,
    qboAccount.AccountType,
    qboAccount.type,
    qboPostedTransaction.payload?.AccountRef?.type,
    qboPostedTransaction.response?.AccountRef?.type
  );
  const accountSubtype = firstNonEmpty(
    categorization.qbo_account_subtype,
    categorization.final_qbo_account_subtype,
    categorization.suggested_qbo_account_subtype,
    categorization.meta?.qbo_account_subtype,
    categorization.meta?.final_qbo_account_subtype,
    categorization.meta?.suggested_qbo_account_subtype,
    qboAccount.qbo_account_subtype,
    qboAccount.AccountSubType,
    qboAccount.subType,
    qboAccount.subtype
  );

  return {
    qboAccountId: accountId || null,
    qboAccountName: accountName || null,
    qboAccountType: accountType || null,
    qboAccountSubtype: accountSubtype || null,
    normalizedQboAccountName: normalizeQboGlAccountKey(accountName),
    normalizedQboAccountType: normalizeQboGlAccountKey(accountType),
    normalizedQboAccountSubtype: normalizeQboGlAccountKey(accountSubtype),
  };
}

function extractAccountRef(row = {}) {
  return row.payload?.AccountRef ||
    row.response?.AccountRef ||
    row.payload?.Purchase?.AccountRef ||
    row.response?.Purchase?.AccountRef ||
    null;
}

function firstNonEmpty(...values) {
  return values.find((value) => String(value ?? "").trim().length > 0);
}
