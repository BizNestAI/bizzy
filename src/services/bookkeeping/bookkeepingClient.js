import { apiUrl, safeFetch } from "../../utils/safeFetch";

function withBizHeaders(businessId, headers = {}) {
  const h = new Headers(headers);
  if (businessId) h.set("x-business-id", businessId);
  return h;
}

export async function getAccounts(businessId) {
  return safeFetch(apiUrl("/api/bookkeeping/accounts"), {
    method: "GET",
    headers: withBizHeaders(businessId),
  });
}

export async function getTransactions(businessId, params = {}) {
  const search = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") search.set(k, v);
  });
  const qs = search.toString() ? `?${search.toString()}` : "";
  const res = await safeFetch(apiUrl(`/api/bookkeeping/transactions${qs}`), {
    method: "GET",
    headers: withBizHeaders(businessId),
  });
  if (Array.isArray(res)) return res;
  return res?.rows || res?.items || [];
}

export async function getQboCoa(businessId) {
  return safeFetch(apiUrl("/api/bookkeeping/qbo/coa"), {
    method: "GET",
    headers: withBizHeaders(businessId),
  });
}

export async function approveTransactions(businessId, items = []) {
  const payload = { business_id: businessId, items };
  if (process.env.NODE_ENV !== "production") {
    console.log("[bookkeepingClient] approve payload", payload);
  }
  const res = await safeFetch(apiUrl("/api/bookkeeping/approve"), {
    method: "POST",
    headers: withBizHeaders(businessId, { "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  if (process.env.NODE_ENV !== "production") {
    console.log("[bookkeepingClient] approve response", res);
  }
  if (res && res.ok === false) {
    throw new Error(res.message || res.error || "approve_failed");
  }
  return res;
}

export async function undoTransaction(businessId, txnId) {
  const payload = { business_id: businessId, txnId };
  if (process.env.NODE_ENV !== "production") {
    console.log("[bookkeepingClient] undo payload", payload);
  }
  const res = await safeFetch(apiUrl("/api/bookkeeping/undo"), {
    method: "POST",
    headers: withBizHeaders(businessId, { "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  if (process.env.NODE_ENV !== "production") {
    console.log("[bookkeepingClient] undo response", res);
  }
  if (res && res.ok === false) {
    throw new Error(res.message || res.error || "undo_failed");
  }
  return res;
}

export async function updateHandledTransaction(businessId, transactionId, payload = {}) {
  const body = {
    ...payload,
    business_id: businessId,
  };
  if (process.env.NODE_ENV !== "production") {
    console.log("[bookkeepingClient] grace edit payload", { transactionId, body });
  }
  const res = await safeFetch(apiUrl(`/api/bookkeeping/transactions/${transactionId}`), {
    method: "PATCH",
    headers: withBizHeaders(businessId, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (process.env.NODE_ENV !== "production") {
    console.log("[bookkeepingClient] grace edit response", res);
  }
  if (res && res.ok === false) {
    throw new Error(res.message || res.error || "grace_edit_failed");
  }
  return res;
}

export async function suggestTransactions(businessId, payload = {}) {
  const body = {
    business_id: businessId,
    ...payload,
  };
  if (process.env.NODE_ENV !== "production") {
    console.info("[bookkeepingClient] suggest payload", body);
  }
  let res;
  try {
    res = await safeFetch(apiUrl("/api/bookkeeping/suggest"), {
      method: "POST",
      headers: withBizHeaders(businessId, { "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.error("[bookkeepingClient] suggest failed", {
        status: err?.status || null,
        url: err?.url || null,
        body: err?.body || null,
        message: err?.message || String(err),
      });
    }
    throw err;
  }
  if (process.env.NODE_ENV !== "production") {
    console.info("[bookkeepingClient] suggest response", res);
  }
  if (res && res.ok === false) {
    throw new Error(res.message || res.error || "suggest_failed");
  }
  return res;
}

export async function enrichCounterparties(businessId, payload = {}) {
  const body = {
    business_id: businessId,
    ...payload,
  };
  if (process.env.NODE_ENV !== "production") {
    console.info("[bookkeepingClient] enrich-counterparties payload", body);
  }
  const res = await safeFetch(apiUrl("/api/bookkeeping/enrich-counterparties"), {
    method: "POST",
    headers: withBizHeaders(businessId, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (process.env.NODE_ENV !== "production") {
    console.info("[bookkeepingClient] enrich-counterparties response", res);
  }
  if (res && res.ok === false) {
    throw new Error(res.message || res.error || "enrich_counterparties_failed");
  }
  return res;
}

export async function triggerPlaidSync(businessId) {
  return safeFetch(apiUrl("/api/integrations/plaid/sync"), {
    method: "POST",
    headers: withBizHeaders(businessId, { "Content-Type": "application/json" }),
    body: JSON.stringify({ business_id: businessId }),
  });
}

export async function disconnectPlaidItem(businessId, plaidItemId) {
  return safeFetch(apiUrl("/api/integrations/plaid/disconnect-item"), {
    method: "POST",
    headers: withBizHeaders(businessId, { "Content-Type": "application/json" }),
    body: JSON.stringify({ business_id: businessId, plaid_item_id: plaidItemId }),
  });
}

export async function getMappingStatus(businessId) {
  return safeFetch(apiUrl("/api/bookkeeping/mapping-status"), {
    method: "GET",
    headers: withBizHeaders(businessId),
  });
}

export async function getAccountMappings(businessId) {
  return safeFetch(apiUrl("/api/bookkeeping/account-mappings"), {
    method: "GET",
    headers: withBizHeaders(businessId),
  });
}

export async function updateAccountMapping(businessId, payload = {}) {
  const res = await safeFetch(apiUrl("/api/bookkeeping/account-mappings"), {
    method: "POST",
    headers: withBizHeaders(businessId, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      plaid_account_id: payload.plaid_account_id || payload.plaidAccountId,
      qbo_account_id: payload.qbo_account_id || payload.qboAccountId,
      qbo_account_name: payload.qbo_account_name || payload.qboAccountName,
      qbo_account_type: payload.qbo_account_type || payload.qboAccountType,
    }),
  });
  if (res && res.ok === false) {
    throw new Error(res.message || res.error || "account_mapping_update_failed");
  }
  return res;
}

export async function getReconciliationStatus(businessId, opts = {}) {
  const search = new URLSearchParams();
  if (opts.details) search.set("details", "1");
  const qs = search.toString() ? `?${search.toString()}` : "";
  return safeFetch(apiUrl(`/api/bookkeeping/reconciliation-status${qs}`), {
    method: "GET",
    headers: withBizHeaders(businessId),
  });
}

export async function runReconciliationStatus(businessId) {
  return safeFetch(apiUrl("/api/bookkeeping/reconciliation-status/run"), {
    method: "POST",
    headers: withBizHeaders(businessId, { "Content-Type": "application/json" }),
  });
}

export async function getReconciledTransactions(businessId, params = {}) {
  const search = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") search.set(k, v);
  });
  const qs = search.toString() ? `?${search.toString()}` : "";
  return safeFetch(apiUrl(`/api/bookkeeping/reconciled-transactions${qs}`), {
    method: "GET",
    headers: withBizHeaders(businessId),
  });
}

export async function runReconciliations(businessId, body = {}) {
  return safeFetch(apiUrl("/api/bookkeeping/reconciliations/run"), {
    method: "POST",
    headers: withBizHeaders(businessId, { "Content-Type": "application/json" }),
    body: JSON.stringify(body || {}),
  });
}

export async function getReconciliationsStatus(businessId) {
  return safeFetch(apiUrl("/api/bookkeeping/reconciliations/status"), {
    method: "GET",
    headers: withBizHeaders(businessId),
  });
}

export async function getReconciliationsTransactions(businessId, params = {}) {
  const search = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") search.set(k, String(v));
  });
  const qs = search.toString() ? `?${search.toString()}` : "";
  return safeFetch(apiUrl(`/api/bookkeeping/reconciliations/transactions${qs}`), {
    method: "GET",
    headers: withBizHeaders(businessId),
  });
}

export async function getReconciliationsRuns(businessId, params = {}) {
  const search = new URLSearchParams();
  if (params.limit) search.set("limit", String(params.limit));
  const qs = search.toString() ? `?${search.toString()}` : "";
  return safeFetch(apiUrl(`/api/bookkeeping/reconciliations/runs${qs}`), {
    method: "GET",
    headers: withBizHeaders(businessId),
  });
}

export async function getClarificationRequests(businessId, params = {}) {
  const search = new URLSearchParams();
  if (params.limit) search.set("limit", String(params.limit));
  const qs = search.toString() ? `?${search.toString()}` : "";
  return safeFetch(apiUrl(`/api/bookkeeping/clarifications${qs}`), {
    method: "GET",
    headers: withBizHeaders(businessId),
  });
}

export async function submitClarificationAnswers(businessId, payload = {}) {
  const body = {
    business_id: businessId,
    answers: payload.answers || [],
  };
  const res = await safeFetch(apiUrl(`/api/bookkeeping/clarifications/submit`), {
    method: "POST",
    headers: withBizHeaders(businessId, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (res && res.ok === false) {
    throw new Error(res.message || res.error || "clarifications_submit_failed");
  }
  return res;
}

export async function snoozeClarifications(businessId, payload = {}) {
  const body = {
    business_id: businessId,
    request_ids: payload.request_ids || payload.ids || [],
    hours: payload.hours || 24,
  };
  const res = await safeFetch(apiUrl(`/api/bookkeeping/clarifications/snooze`), {
    method: "POST",
    headers: withBizHeaders(businessId, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (res && res.ok === false) {
    throw new Error(res.message || res.error || "clarifications_snooze_failed");
  }
  return res;
}

export async function getPlaidStatus(businessId) {
  return safeFetch(apiUrl("/api/integrations/plaid/status"), {
    method: "GET",
    headers: withBizHeaders(businessId),
  });
}

export async function disconnectPlaid(businessId, payload = {}) {
  const body = {
    business_id: businessId,
  };
  if (payload?.deleteData) body.deleteData = true;
  return safeFetch(apiUrl("/api/integrations/plaid/disconnect"), {
    method: "POST",
    headers: withBizHeaders(businessId, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
}

export async function createPlaidLinkToken(businessId) {
  return safeFetch(apiUrl("/api/integrations/plaid/link-token"), {
    method: "POST",
    headers: withBizHeaders(businessId, { "Content-Type": "application/json" }),
    body: JSON.stringify({ business_id: businessId }),
  });
}

export async function exchangePlaidPublicToken(businessId, public_token, metadata = null) {
  return safeFetch(apiUrl("/api/integrations/plaid/exchange"), {
    method: "POST",
    headers: withBizHeaders(businessId, { "Content-Type": "application/json" }),
    body: JSON.stringify({ business_id: businessId, public_token, metadata }),
  });
}

export async function getQboCoaCreations(businessId, params = {}) {
  const search = new URLSearchParams();
  if (params.limit) search.set("limit", String(params.limit));
  const qs = search.toString() ? `?${search.toString()}` : "";
  return safeFetch(apiUrl(`/api/bookkeeping/qbo/coa-creations${qs}`), {
    method: "GET",
    headers: withBizHeaders(businessId),
  });
}

export async function getQboPaymentAccounts(businessId) {
  return safeFetch(apiUrl("/api/bookkeeping/qbo/payment-accounts"), {
    method: "GET",
    headers: withBizHeaders(businessId),
  });
}

export async function ensureQboPaymentAccount(businessId, plaidAccountId) {
  return safeFetch(apiUrl("/api/bookkeeping/qbo/payment-accounts/ensure"), {
    method: "POST",
    headers: withBizHeaders(businessId, { "Content-Type": "application/json" }),
    body: JSON.stringify({ plaid_account_id: plaidAccountId }),
  });
}

export async function createQboCoaAccount(businessId, body = {}) {
  return safeFetch(apiUrl("/api/bookkeeping/qbo/coa-create"), {
    method: "POST",
    headers: withBizHeaders(businessId, { "Content-Type": "application/json" }),
    body: JSON.stringify(body || {}),
  });
}

export async function getQboVendorCreations(businessId, params = {}) {
  const search = new URLSearchParams();
  if (params.limit) search.set("limit", String(params.limit));
  const qs = search.toString() ? `?${search.toString()}` : "";
  return safeFetch(apiUrl(`/api/bookkeeping/qbo/vendor-creations${qs}`), {
    method: "GET",
    headers: withBizHeaders(businessId),
  });
}

export default {
  getAccounts,
  getTransactions,
  getQboCoa,
  approveTransactions,
  undoTransaction,
  updateHandledTransaction,
  suggestTransactions,
  enrichCounterparties,
  triggerPlaidSync,
  getAccountMappings,
  updateAccountMapping,
  getMappingStatus,
  getReconciliationStatus,
  runReconciliationStatus,
  getReconciledTransactions,
  runReconciliations,
  getReconciliationsStatus,
  getReconciliationsTransactions,
  getReconciliationsRuns,
  getPlaidStatus,
  createPlaidLinkToken,
  exchangePlaidPublicToken,
  disconnectPlaid,
  getQboCoaCreations,
  createQboCoaAccount,
  getQboPaymentAccounts,
  ensureQboPaymentAccount,
  getQboVendorCreations,
};
