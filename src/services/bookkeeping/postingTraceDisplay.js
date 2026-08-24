export function formatPlaidAccountDisplayLabel(account = {}) {
  const base = String(account.name || account.official_name || formatFinancialAccountType(account) || "Financial account").trim();
  const mask = account.mask ? String(account.mask).trim() : "";
  if (!mask) return base;
  if (new RegExp(`${escapeRegExp(mask)}$`).test(base)) return base;
  return `${base} ••••${mask}`;
}

export function deriveTraceReconciliationStatus({ lifecycle, reconciliationItem } = {}) {
  const itemStatus = String(reconciliationItem?.status || "").toLowerCase();
  const itemReason = String(
    reconciliationItem?.reason ||
      reconciliationItem?.note ||
      reconciliationItem?.details?.reason_code ||
      reconciliationItem?.details?.issue_type ||
      reconciliationItem?.details?.status ||
      ""
  ).toLowerCase();
  const marker = `${itemStatus} ${itemReason}`;

  if (itemStatus === "matched" || itemStatus === "reconciled" || reconciliationItem?.reconciled_at) {
    return { key: "matched", label: "Matched", tone: "good", exception: false, source: "reconciliation_items" };
  }
  if (/duplicate/.test(marker)) {
    return { key: "duplicate", label: "Duplicate", tone: "danger", exception: true, source: "reconciliation_items" };
  }
  if (/missing_in_qbo|missing qbo|posting_gap/.test(marker)) {
    return { key: "missing_in_qbo", label: "Missing in QBO", tone: "danger", exception: true, source: "reconciliation_items" };
  }
  if (/mismatch|amount_mismatch|account_mismatch|qbo_id_mismatch/.test(marker)) {
    return { key: "mismatch", label: "Mismatch", tone: "danger", exception: true, source: "reconciliation_items" };
  }
  if (/failed_post|provider_error|reconciliation_error|conflict|unmatched|exception|error/.test(marker)) {
    return { key: "needs_investigation", label: "Needs investigation", tone: "warning", exception: true, source: "reconciliation_items" };
  }

  if (lifecycle?.key === "posted") {
    return { key: "awaiting_reconciliation", label: "Awaiting reconciliation", tone: "neutral", exception: false, source: "qbo_lifecycle" };
  }
  if (["handled_not_posted", "queued", "failed"].includes(lifecycle?.key)) {
    return { key: "awaiting_qbo", label: "Awaiting QBO", tone: lifecycle?.key === "failed" ? "warning" : "neutral", exception: false, source: "qbo_lifecycle" };
  }
  return { key: "not_yet_eligible", label: "Not yet eligible", tone: "neutral", exception: false, source: "qbo_lifecycle" };
}

function formatFinancialAccountType(account = {}) {
  const type = String(account.type || "").replace(/[_-]+/g, " ").trim();
  const subtype = String(account.subtype || "").replace(/[_-]+/g, " ").trim();
  const normalized = `${type} ${subtype}`.toLowerCase();
  if (normalized.includes("credit card")) return "Credit Card";
  if (normalized.includes("checking")) return "Checking";
  if (normalized.includes("savings")) return "Savings";
  if (subtype) return titleCase(subtype);
  if (type) return titleCase(type);
  return "Financial account";
}

function titleCase(value) {
  return String(value || "").replace(/\b\w/g, (char) => char.toUpperCase());
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
