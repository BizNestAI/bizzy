export function removeSupersededPendingPlaidRows(rows = []) {
  const settledPendingRefs = new Set(
    (rows || [])
      .filter((row) => row?.pending !== true && row?.pending_transaction_id)
      .map((row) => String(row.pending_transaction_id))
  );

  return (rows || []).filter((row) => {
    if (row?.pending === true && row?.plaid_transaction_id && settledPendingRefs.has(String(row.plaid_transaction_id))) {
      return false;
    }
    return true;
  });
}

export default {
  removeSupersededPendingPlaidRows,
};
