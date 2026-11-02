let taxDecisionToastSequence = 0;

export function showTaxDecisionSuccess(message, operationId = null) {
  if (typeof window === "undefined" || !message) return;
  taxDecisionToastSequence += 1;
  window.dispatchEvent(new CustomEvent("bizzy:toast", {
    detail: {
      severity: "success",
      title: message,
      timeout: 4000,
      dedupeKey: operationId
        ? `tax-decision:${operationId}`
        : `tax-decision:${taxDecisionToastSequence}`,
    },
  }));
}

export function showTaxDecisionInfo(message, operationId = null) {
  if (typeof window === "undefined" || !message) return;
  taxDecisionToastSequence += 1;
  window.dispatchEvent(new CustomEvent("bizzy:toast", {
    detail: {
      severity: "info",
      title: message,
      timeout: 4000,
      dedupeKey: operationId
        ? `tax-question-update:${operationId}`
        : `tax-question-update:${taxDecisionToastSequence}`,
    },
  }));
}
