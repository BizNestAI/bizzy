// src/api/ar/ar.qbo.js
import fetch from "node-fetch";
import { supabase } from "../../services/supabaseAdmin.js";
import { getQuickBooksAccessToken } from "../../services/quickbooksTokenService.js";
import { qboEnvName, qbApiBase } from "../../utils/qboEnv.js";

function buildDateParams({ startDate, endDate }) {
  const params = new URLSearchParams();
  if (startDate && endDate) {
    params.set("start_date", startDate);
    params.set("end_date", endDate);
  } else {
    params.set("date_macro", "This Fiscal Year");
  }
  return params;
}

async function getRealmAndToken(business_id) {
  const { data: tokenRow, error } = await supabase
    .from("quickbooks_tokens")
    .select("realm_id, qbo_env")
    .eq("business_id", business_id)
    .eq("qbo_env", qboEnvName)
    .eq("is_active", true)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message || "Failed to read quickbooks_tokens");
  if (!tokenRow?.realm_id) throw new Error("quickbooks_not_connected");

  const realmId = tokenRow.realm_id;
  const accessToken = await getQuickBooksAccessToken(business_id);
  return { realmId, accessToken };
}

/**
 * Fetch AR Aging Detail (AgedReceivablesDetail) from QBO Reports API.
 */
export async function fetchARAgingDetail({ business_id, startDate = null, endDate = null, aging_method = null }) {
  if (!business_id) throw new Error("business_id is required");

  const { realmId, accessToken } = await getRealmAndToken(business_id);

  const params = buildDateParams({ startDate, endDate });
  params.set("minorversion", "75");
  params.set("accounting_method", "Accrual");
  if (aging_method) params.set("aging_method", aging_method);

  const url = `${qbApiBase}/v3/company/${realmId}/reports/AgedReceivablesDetail?${params.toString()}`;

  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`[qbo ar] report failed ${resp.status}: ${text}`);
  }

  const reportJson = await resp.json();
  return { reportJson, realmId };
}

export async function queryInvoicesByDocNumbers({ business_id, docNumbers = [] }) {
  if (!business_id) throw new Error("business_id is required");
  const deduped = Array.from(new Set((docNumbers || []).filter(Boolean)));
  if (!deduped.length) return [];

  const { realmId, accessToken } = await getRealmAndToken(business_id);
  const chunks = [];
  for (let i = 0; i < deduped.length; i += 75) {
    chunks.push(deduped.slice(i, i + 75));
  }

  const allInvoices = [];
  for (const chunk of chunks) {
    const escaped = chunk.map((d) => `'${String(d).replace(/'/g, "''")}'`).join(",");
    const query = `select Id, DocNumber, CustomerRef, TxnDate, DueDate, TotalAmt, Balance, CurrencyRef from Invoice where DocNumber in (${escaped})`;
    const params = new URLSearchParams({ query, minorversion: "75" });
    const url = `${qbApiBase}/v3/company/${realmId}/query?${params.toString()}`;

    const resp = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`[qbo ar] invoice query failed ${resp.status}: ${text}`);
    }

    const json = await resp.json();
    const invoices = json?.QueryResponse?.Invoice || [];
    allInvoices.push(...invoices);
  }

  console.info("[qbo ar] invoice query result", { requested: deduped.length, returned: allInvoices.length });
  return allInvoices;
}

export async function queryOpenInvoices({ business_id }) {
  if (!business_id) throw new Error("business_id is required");
  const { realmId, accessToken } = await getRealmAndToken(business_id);

  let startPosition = 1;
  const pageSize = 1000;
  const invoices = [];

  while (true) {
    const query = `select Id, DocNumber, CustomerRef, TxnDate, DueDate, TotalAmt, Balance, CurrencyRef from Invoice where Balance > '0' STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`;
    const params = new URLSearchParams({ query, minorversion: "75" });
    const url = `${qbApiBase}/v3/company/${realmId}/query?${params.toString()}`;

    const resp = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`[qbo ar] open invoice query failed ${resp.status}: ${text}`);
    }

    const json = await resp.json();
    const page = json?.QueryResponse?.Invoice || [];
    invoices.push(...page);
    if (!Array.isArray(page) || page.length < pageSize) break;
    startPosition += pageSize;
  }

  console.info("[qbo ar] open invoice query result", { returned: invoices.length });
  return { invoices, realmId };
}

export async function fetchInvoiceById({ business_id, qbo_invoice_id }) {
  if (!business_id) throw new Error("business_id is required");
  if (!qbo_invoice_id) throw new Error("qbo_invoice_id is required");
  const { realmId, accessToken } = await getRealmAndToken(business_id);

  const url = `${qbApiBase}/v3/company/${realmId}/invoice/${qbo_invoice_id}?minorversion=75`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`[qbo ar] invoice fetch failed ${resp.status}: ${text}`);
  }

  const json = await resp.json();
  return json?.Invoice || null;
}

export async function fetchCustomersByIds({ business_id, customerIds = [] }) {
  if (!business_id) throw new Error("business_id is required");
  const deduped = Array.from(new Set((customerIds || []).filter(Boolean)));
  if (!deduped.length) return [];

  const { realmId, accessToken } = await getRealmAndToken(business_id);
  const chunks = [];
  for (let i = 0; i < deduped.length; i += 75) {
    chunks.push(deduped.slice(i, i + 75));
  }

  const allCustomers = [];
  for (const chunk of chunks) {
    const escaped = chunk.map((d) => `'${String(d).replace(/'/g, "''")}'`).join(",");
    const query = `select Id, DisplayName, ParentRef, PrimaryEmailAddr, PrimaryPhone, BillAddr from Customer where Id in (${escaped})`;
    const params = new URLSearchParams({ query, minorversion: "75" });
    const url = `${qbApiBase}/v3/company/${realmId}/query?${params.toString()}`;

    const resp = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`[qbo ar] customer query failed ${resp.status}: ${text}`);
    }

    const json = await resp.json();
    const customers = json?.QueryResponse?.Customer || [];
    allCustomers.push(...customers);
  }

  console.info("[qbo ar] customer query result", { requested: deduped.length, returned: allCustomers.length });
  return allCustomers;
}

export async function queryPaymentsForInvoiceIds({ business_id, invoiceIds = [], lookbackDays = 365 }) {
  if (!business_id) throw new Error("business_id is required");
  const ids = Array.from(new Set((invoiceIds || []).filter(Boolean)));
  if (!ids.length) return {};

  const { realmId, accessToken } = await getRealmAndToken(business_id);
  const startDate = (() => {
    const d = new Date();
    d.setDate(d.getDate() - (lookbackDays || 365));
    return d.toISOString().slice(0, 10);
  })();

  let startPosition = 1;
  const pageSize = 1000;
  const payments = [];

  while (true) {
    const query = `select Id, TxnDate, TotalAmt, Line from Payment where TxnDate >= '${startDate}' STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`;
    const params = new URLSearchParams({ query, minorversion: "75" });
    const url = `${qbApiBase}/v3/company/${realmId}/query?${params.toString()}`;

    const resp = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`[qbo ar] payment query failed ${resp.status}: ${text}`);
    }

    const json = await resp.json();
    const page = json?.QueryResponse?.Payment || [];
    payments.push(...page);

    if (!Array.isArray(page) || page.length < pageSize) break;
    startPosition += pageSize;
  }

  const matched = {};
  let linkCount = 0;

  payments.forEach((p) => {
    const lines = Array.isArray(p?.Line) ? p.Line : [];
    const txnDate = p?.TxnDate ? new Date(p.TxnDate).toISOString().slice(0, 10) : null;
    lines.forEach((line) => {
      const linked = Array.isArray(line?.LinkedTxn) ? line.LinkedTxn : [];
      linked.forEach((lt) => {
        if (lt?.TxnId && ids.includes(lt.TxnId)) {
          linkCount += 1;
          const prev = matched[lt.TxnId];
          if (!prev || (txnDate && txnDate > prev)) {
            matched[lt.TxnId] = txnDate;
          }
        }
      });
    });
  });

  console.info("[qbo ar] payment scan", {
    requestedInvoices: ids.length,
    payments: payments.length,
    linksFound: linkCount,
    matchedInvoices: Object.keys(matched).length,
  });

  return matched;
}
