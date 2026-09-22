const RECONCILIATION_SORT_KEYS = new Set(["date", "transaction", "bank_account", "amount", "category", "pipeline_status"]);

export function sortMonthlyReconciliationRows(rows = [], sortBy = "date", sortDirection = "desc") {
  const key = RECONCILIATION_SORT_KEYS.has(sortBy) ? sortBy : "date";
  const direction = String(sortDirection).toLowerCase() === "asc" ? 1 : -1;
  const valueFor = (row) => {
    if (key === "transaction") return row?.merchant || row?.payee || row?.description || "";
    if (key === "bank_account") return row?.bank_account || row?.plaid_account_id || "";
    if (key === "amount") return Number(row?.amount) || 0;
    if (key === "category") return row?.category_name || row?.bizzi_gl_account || "";
    if (key === "pipeline_status") return row?.pipeline_status_label || row?.pipeline_status?.label || row?.status || "";
    return row?.txn_date || row?.date || "";
  };
  return [...rows].sort((a, b) => {
    const left = valueFor(a);
    const right = valueFor(b);
    const comparison = typeof left === "number"
      ? left - right
      : String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
    if (comparison !== 0) return comparison * direction;
    const dateComparison = String(b?.txn_date || b?.date || "").localeCompare(String(a?.txn_date || a?.date || ""));
    return dateComparison || String(a?.id || "").localeCompare(String(b?.id || ""));
  });
}

