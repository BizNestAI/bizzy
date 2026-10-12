export function hasActualProviderWriteBoundary(operation = {}, transactionId = null) {
  return (operation.event_timeline || []).some((entry) =>
    ["qbo_write_started", "provider_http_request_started"].includes(String(entry?.event || "")) &&
    (!transactionId || !entry?.transaction_id || String(entry.transaction_id) === String(transactionId))
  );
}

export default hasActualProviderWriteBoundary;
