export const ADMIN_BOOKKEEPING_WRITE_CAPABILITY = "admin_bookkeeping_write";

const WRITE_RULES = Object.freeze([
  ["PUT", /^\/api\/bookkeeping\/transactions\/([^/]+)\/resolution$/, "save_resolution"],
  ["PUT", /^\/api\/bookkeeping\/transactions\/([^/]+)\/credit-card-inflow-resolution$/, "save_credit_card_resolution"],
  ["POST", /^\/api\/bookkeeping\/approve$/, "approve_categorization"],
  ["POST", /^\/api\/bookkeeping\/undo$/, "undo_bookkeeping_decision"],
  ["POST", /^\/api\/bookkeeping\/credit-card-payments\/reject$/, "reject_credit_card_payment_suggestion"],
  ["POST", /^\/api\/bookkeeping\/credit-card-payments\/mark$/, "mark_credit_card_payment"],
  ["POST", /^\/api\/bookkeeping\/credit-card-payments\/([^/]+)\/discover-match$/, "discover_credit_card_match"],
  ["POST", /^\/api\/bookkeeping\/credit-card-payments\/([^/]+)\/confirm-match$/, "confirm_credit_card_match"],
  ["POST", /^\/api\/bookkeeping\/incoming-deposit-matches\/([^/]+)\/refresh$/, "refresh_existing_qbo_match"],
  ["POST", /^\/api\/bookkeeping\/incoming-deposit-matches\/([^/]+)\/record-new-income$/, "approve_deposit_as_new_income"],
  ["POST", /^\/api\/bookkeeping\/incoming-deposit-matches\/([^/]+)\/([^/]+)\/confirm$/, "confirm_existing_qbo_match"],
  ["POST", /^\/api\/bookkeeping\/incoming-deposit-matches\/([^/]+)\/([^/]+)\/reject$/, "reject_existing_qbo_match"],
  ["POST", /^\/api\/bookkeeping\/incoming-deposit-matches\/([^/]+)\/([^/]+)\/undo$/, "undo_existing_qbo_match"],
  ["POST", /^\/api\/bookkeeping\/transactions\/([^/]+)\/exclude$/, "exclude_transaction"],
  ["POST", /^\/api\/bookkeeping\/posting\/transactions\/([^/]+)$/, "retry_failed_qbo_posting"],
  ["POST", /^\/api\/bookkeeping\/vendor-rules\/from-transaction$/, "create_vendor_rule_from_approval"],
  ["POST", /^\/api\/bookkeeping\/clarifications\/submit$/, "complete_operator_request"],
  ["POST", /^\/api\/bookkeeping\/processing\/retry$/, "retry_bookkeeping_processing"],
  ["POST", /^\/api\/job-costing\/assignment-impact-preview$/, "preview_job_transaction_assignment"],
  ["POST", /^\/api\/job-costing\/assignments$/, "assign_transaction_to_job"],
]);

export function adminBookkeepingRequestPath(req = {}) {
  const original = String(req.originalUrl || "").split("?")[0];
  if (original) return original.replace(/\/+$/, "") || "/";
  return `${req.baseUrl || ""}${req.path || req.url || ""}`.split("?")[0].replace(/\/+$/, "") || "/";
}

export function matchAdminBookkeepingWrite(req = {}) {
  const method = String(req.method || "").toUpperCase();
  const path = adminBookkeepingRequestPath(req);
  for (const [allowedMethod, pattern, action] of WRITE_RULES) {
    if (method !== allowedMethod) continue;
    const match = path.match(pattern);
    if (!match) continue;
    return { action, method, path, transactionId: match[1] || req.body?.transaction_id || req.body?.txnId || null };
  }
  return null;
}

export function hasAdminBookkeepingWriteCapability(context = {}) {
  return Array.isArray(context.capabilities) && context.capabilities.includes(ADMIN_BOOKKEEPING_WRITE_CAPABILITY);
}

export const ADMIN_BOOKKEEPING_WRITE_INVENTORY = Object.freeze({
  permitted: WRITE_RULES.map(([method, pattern, action]) => ({ method, pattern: pattern.source, action })),
  prohibited: [
    "chat_and_ai", "billing_and_subscriptions", "memberships_and_roles", "quickbooks_connections",
    "plaid_connections", "tokens_and_secrets", "destructive_business_operations", "security_settings",
    "cross_business_switching", "manual_posting", "auto_post_configuration", "qbo_account_creation",
  ],
});
