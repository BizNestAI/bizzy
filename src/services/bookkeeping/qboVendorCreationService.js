import {
  canonicalizeVendorDisplayName,
  ensureCanonicalVendorMappedToQbo,
  getVendorAutoCreateBlockReason,
  normalizeVendorText,
} from "./canonicalVendorService.js";

export function normalizeVendorName(name = "") {
  return normalizeVendorText(name);
}

export function isVendorCreationEligible({ bankTxn = {}, payeeResolution = {}, taxonomyMeta = {} }) {
  const candidate =
    payeeResolution?.counterpartyName ||
    bankTxn.counterparty_name ||
    bankTxn.merchant_name ||
    bankTxn.name ||
    "";
  const reason = getVendorAutoCreateBlockReason({ bankTxn, taxonomyMeta, candidateName: candidate });
  return reason ? { ok: false, reason } : { ok: true };
}

export async function ensureQboVendorForTransaction({
  businessId,
  bankTxn = {},
  payeeResolution = {},
  taxonomyMeta = {},
  source = "suggest",
  createdBy = "bizzi",
  qboClient = null,
  tokenRow = null,
}) {
  const result = await ensureCanonicalVendorMappedToQbo({
    businessId,
    bankTxn,
    payeeResolution,
    taxonomyMeta,
    source,
    createdBy,
    qboClient,
    tokenRow,
  });

  if (result?.vendor_name) return result;
  const candidate =
    result?.canonicalVendor?.display_name ||
    payeeResolution?.counterpartyName ||
    bankTxn.counterparty_name ||
    bankTxn.merchant_name ||
    bankTxn.name ||
    "";
  return {
    ...result,
    vendor_name: candidate ? canonicalizeVendorDisplayName(candidate) : undefined,
  };
}

export default {
  normalizeVendorName,
  isVendorCreationEligible,
  ensureQboVendorForTransaction,
};
