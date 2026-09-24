function normalizeKey(value = "") {
  return String(value || "").replace(/[\s_-]+/g, "").toLowerCase();
}

export function normalizePaymentAccountClass({ plaidType, plaidSubtype, qboAccountType } = {}) {
  const plaid = normalizeKey(plaidType);
  const subtype = normalizeKey(plaidSubtype);
  const qbo = normalizeKey(qboAccountType);
  if (plaid === "depository" || ["checking", "savings", "moneymarket", "cd"].includes(subtype) || qbo === "bank") return "depository";
  if (plaid === "credit" || subtype.includes("credit") || qbo === "creditcard") return "credit_card";
  return null;
}

function formatLabel(row = {}) {
  const name = row.qboAccountName || row.qbo_account_name || row.plaidAccountName || row.plaid_name || "Payment account";
  const maskValue = row.plaidMask || row.mask || "";
  const mask = maskValue ? String(maskValue).slice(-4) : "";
  return mask ? `${name} • ${mask}` : name;
}

export function normalizePaymentAccountCapability(row = {}, businessId = null) {
  const connectedAccountId = row.plaidAccountId || row.plaid_account_id || null;
  const qboAccountId = row.qboAccountId || row.qbo_account_id || null;
  const plaidClass = normalizePaymentAccountClass({ plaidType: row.plaidType || row.plaid_type, plaidSubtype: row.plaidSubtype || row.plaid_subtype });
  const qboClass = normalizePaymentAccountClass({ qboAccountType: row.qboAccountType || row.qbo_account_type });
  const accountClass = plaidClass || qboClass;
  const active = row.isActive !== false && row.is_active !== false && row.active !== false;
  const mapped = Boolean(qboAccountId) && (row.mapped === true || row.mappingStatus === "mapped" || row.mapping_status === "mapped");
  // Older persisted mappings can lack qbo_account_type. The connected-account
  // rail remains authoritative; reject only a known contradictory QBO class.
  const typeCompatible = Boolean(accountClass) && (!plaidClass || !qboClass || plaidClass === qboClass);
  const eligible = active && mapped && typeCompatible;
  const type = accountClass === "credit_card" ? "CreditCard" : accountClass === "depository" ? "Bank" : null;
  return {
    id: qboAccountId ? String(qboAccountId) : null,
    name: formatLabel(row),
    type,
    accountType: type,
    account_type: type,
    accountClass,
    connectedAccountId,
    plaidAccountId: connectedAccountId,
    qboAccountId: qboAccountId ? String(qboAccountId) : null,
    qboAccountName: row.qboAccountName || row.qbo_account_name || null,
    subType: row.qboAccountSubtype || row.qbo_account_subtype || row.plaidSubtype || row.plaid_subtype || type,
    mappingId: row.mappingId || row.mapping_id || (connectedAccountId && qboAccountId ? `${connectedAccountId}:${qboAccountId}` : null),
    institutionName: row.institutionName || row.institution_name || null,
    mask: row.plaidMask || row.mask || null,
    mappingStatus: mapped ? "mapped" : "unmapped",
    active,
    mapped,
    eligible,
    paymentMatchEligible: eligible,
    businessId: row.businessId || row.business_id || businessId,
  };
}

export function buildPaymentAccountDestinationOptions(rows = [], businessId = null) {
  const seen = new Set();
  return (Array.isArray(rows) ? rows : [])
    .map((row) => normalizePaymentAccountCapability(row, businessId))
    .filter((account) => {
      if (!account.paymentMatchEligible || !account.id || !account.type) return false;
      const key = `${account.connectedAccountId || "connected"}:${account.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function buildPaymentAccountCandidates(rows = [], { businessId = null, sourceConnectedAccountId = null, sourceQboAccountId = null, sourceClass = null } = {}) {
  const targetClass = sourceClass === "depository" ? "credit_card" : sourceClass === "credit_card" ? "depository" : null;
  return buildPaymentAccountDestinationOptions(rows, businessId).filter((account) => (
    (!targetClass || account.accountClass === targetClass) &&
    String(account.connectedAccountId || "") !== String(sourceConnectedAccountId || "") &&
    String(account.qboAccountId || "") !== String(sourceQboAccountId || "")
  ));
}

export function buildCreditCardPaymentDestinationOptions(rows = [], businessId = null) {
  return buildPaymentAccountDestinationOptions(rows, businessId).filter((account) => account.accountClass === "credit_card");
}
