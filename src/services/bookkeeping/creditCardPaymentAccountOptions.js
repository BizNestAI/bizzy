function normalizePaymentAccountType(value = "") {
  return String(value || "").replace(/[\s_-]+/g, "").toLowerCase();
}

function formatMappedPaymentAccountLabel(row = {}) {
  const name = row.qboAccountName || row.qbo_account_name || row.plaidAccountName || row.plaid_name || "Payment account";
  const maskValue = row.plaidMask || row.mask || "";
  const mask = maskValue ? String(maskValue).slice(-4) : "";
  return mask ? `${name} • ${mask}` : name;
}

export function buildPaymentAccountDestinationOptions(rows = [], businessId = null) {
  const seen = new Set();
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => {
      const plaidType = normalizePaymentAccountType(row.plaidType || row.plaid_type);
      const qboType = normalizePaymentAccountType(row.qboAccountType || row.qbo_account_type);
      const expectedQboType = plaidType === "credit" ? "creditcard" : plaidType === "depository" ? "bank" : "";
      return (
        (row?.mapped === true || row?.mappingStatus === "mapped" || row?.mapping_status === "mapped") &&
        row?.isActive !== false &&
        row?.is_active !== false &&
        row?.isEligible !== false &&
        Boolean(expectedQboType) &&
        qboType === expectedQboType &&
        (row.qboAccountId || row.qbo_account_id)
      );
    })
    .map((row) => {
      const id = String(row.qboAccountId || row.qbo_account_id);
      const plaidAccountId = row.plaidAccountId || row.plaid_account_id || null;
      const key = `${plaidAccountId || "plaid"}:${id}`;
      if (seen.has(key)) return null;
      seen.add(key);
      const type = normalizePaymentAccountType(row.qboAccountType || row.qbo_account_type) === "creditcard"
        ? "CreditCard"
        : "Bank";
      return {
        id,
        name: formatMappedPaymentAccountLabel(row),
        type,
        accountType: type,
        account_type: type,
        subType: row.qboAccountSubtype || row.qbo_account_subtype || row.plaidSubtype || row.plaid_subtype || type,
        mappingId: row.mappingId || row.mapping_id || key,
        plaidAccountId,
        qboAccountId: id,
        qboAccountName: row.qboAccountName || row.qbo_account_name || null,
        institutionName: row.institutionName || row.institution_name || null,
        mask: row.plaidMask || row.mask || null,
        mappingStatus: row.mappingStatus || row.mapping_status || "mapped",
        active: true,
        eligible: row.isEligible !== false,
        businessId,
      };
    })
    .filter(Boolean);
}

export function buildCreditCardPaymentDestinationOptions(rows = [], businessId = null) {
  return buildPaymentAccountDestinationOptions(rows, businessId).filter((account) => account.type === "CreditCard");
}
