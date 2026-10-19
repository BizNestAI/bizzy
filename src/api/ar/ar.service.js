// src/api/ar/ar.service.js
import { supabase } from "../../services/supabaseAdmin.js";
import { qboEnvName } from "../../utils/qboEnv.js";
import {
  fetchARAgingDetail,
  queryInvoicesByDocNumbers,
  fetchCustomersByIds,
  queryPaymentsForInvoiceIds,
  fetchInvoiceById,
  queryOpenInvoices,
} from "./ar.qbo.js";
import {
  CUSTOMER_NAME_UNAVAILABLE,
  daysPastDueDateOnly,
  extractQboInvoiceCustomerIdentity,
  normalizeDateOnly,
  projectCollectionsInvoice,
} from "../../services/ar/collectionsInvoiceProjection.js";

const toDateOnly = normalizeDateOnly;
const toNumber = (v) => {
  if (v === null || v === undefined) return null;
  const num = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(num) ? num : null;
};

function computeDaysOverdue(dueDate) {
  return daysPastDueDateOnly(dueDate);
}

export function parseARAgingDetailToOpenItems(reportJson = {}) {
  const rows = reportJson?.Rows?.Row || [];
  const columns = reportJson?.Columns?.Column || [];
  const columnIndex = (...patterns) => columns.findIndex((column) => {
    const label = `${column?.ColTitle || ""} ${column?.ColType || ""}`.trim();
    return patterns.some((pattern) => pattern.test(label));
  });
  const customerIndex = columnIndex(/^customer\b/i, /customer.*name/i);
  const typeIndex = columnIndex(/transaction.*type/i, /^type\b/i);
  const dateIndex = columnIndex(/^date\b/i, /tx_date/i);
  const docNumberIndex = columnIndex(/^num(?:ber)?\b/i, /doc.*num/i);
  const dueDateIndex = columnIndex(/due.*date/i);
  const openBalanceIndex = columnIndex(/open.*balance/i);
  let flatCount = 0;
  const items = [];

  const walk = (nodes, context = {}) => {
    if (!Array.isArray(nodes)) return;
    nodes.forEach((node) => {
      if (node?.type === "Section") {
        const headerColumns = node?.Header?.ColData || [];
        const indexedCustomer = customerIndex >= 0 ? headerColumns[customerIndex] : null;
        const customerCell = indexedCustomer?.value
          ? indexedCustomer
          : headerColumns.find((column) => column?.value) || null;
        walk(node.Rows?.Row, customerCell ? {
          client_name: customerCell.value || null,
          qbo_customer_id: customerCell.id || null,
        } : context);
        return;
      }

      if (node?.type === "Data") {
        flatCount += 1;
        const cols = node?.ColData || [];
        const at = (index, fallback) => cols[index >= 0 ? index : fallback] || null;
        const customerCell = at(customerIndex, 0);
        const doc_number = at(docNumberIndex, 3)?.value || null;
        const candidateName = context.client_name || customerCell?.value || null;
        const client_name = candidateName && String(candidateName) !== String(doc_number)
          ? candidateName
          : null;
        const invoice_date = toDateOnly(at(dateIndex, 2)?.value || null);
        const due_date = toDateOnly(at(dueDateIndex, 4)?.value || null);
        const balanceRaw = at(openBalanceIndex, cols.length - 1)?.value || null;
        const balance = toNumber(balanceRaw) || 0;

        items.push({
          client_name,
          customer_ref_name: client_name,
          qbo_customer_id: context.qbo_customer_id || (client_name ? customerCell?.id : null) || null,
          doc_number,
          due_date,
          invoice_date,
          balance,
          transaction_type: at(typeIndex, 1)?.value || null,
          currency: reportJson?.Header?.Currency || null,
          // qbo_invoice_id may not be present in this report; resolve later
          qbo_invoice_id: null,
        });
        return;
      }

      if (node?.Rows?.Row) {
        walk(node.Rows.Row, context);
      }
    });
  };

  walk(rows, {});
  console.info("[ar] Parsed AR aging detail", {
    sections: rows.length,
    items: items.length,
    rawRows: flatCount,
  });
  return items;
}

export async function syncOpenItems({ businessId, force = false, windowDays = null }) {
  let realmId = null;
  let reportJson = null;
  let items = [];

  try {
    const res = await fetchARAgingDetail({
      business_id: businessId,
      startDate: null,
      endDate: null,
      aging_method: null,
    });
    realmId = res.realmId;
    reportJson = res.reportJson;
    items = parseARAgingDetailToOpenItems(reportJson);
  } catch (err) {
    const msg = err?.message || "";
    const denied =
      msg.includes("Permission Denied") ||
      msg.includes('"code":"5020"') ||
      msg.includes("report failed 400");
    if (!denied) throw err;
    console.warn("[ar] Reports API denied; falling back to Invoice Query", msg);
    const { invoices, realmId: realmFromQuery } = await queryOpenInvoices({ business_id: businessId });
    realmId = realmFromQuery;
    items = (invoices || []).map((inv) => {
      const customerIdentity = extractQboInvoiceCustomerIdentity(inv);
      const invoice_date = toDateOnly(inv.TxnDate);
      const due_date = toDateOnly(inv.DueDate);
      const total_amount = toNumber(inv.TotalAmt);
      const balance = toNumber(inv.Balance) ?? 0;
      const status = (() => {
        if (balance === 0) return "paid";
        if (total_amount != null && balance < total_amount) return "partial";
        const overdue = computeDaysOverdue(due_date);
        if (overdue && overdue > 0) return "overdue";
        return "unpaid";
      })();
      return {
        client_name: customerIdentity.customer_ref_name || CUSTOMER_NAME_UNAVAILABLE,
        customer_ref_name: customerIdentity.customer_ref_name,
        doc_number: inv.DocNumber || null,
        qbo_invoice_id: inv.Id || null,
        qbo_customer_id: customerIdentity.customer_id,
        invoice_date,
        due_date,
        total_amount,
        balance,
        currency: inv?.CurrencyRef?.value || null,
        status,
        days_overdue: computeDaysOverdue(due_date),
      };
    });
  }

  const docNumbersNeedingLookup = Array.from(
    new Set(items.filter((i) => !i.qbo_invoice_id && i.doc_number).map((i) => i.doc_number))
  );

  let invoiceMap = {};
  if (docNumbersNeedingLookup.length) {
    try {
      const invoices = await queryInvoicesByDocNumbers({
        business_id: businessId,
        docNumbers: docNumbersNeedingLookup,
      });
      invoiceMap = Object.fromEntries(
        invoices
          .filter((inv) => inv?.DocNumber)
          .map((inv) => [String(inv.DocNumber), inv])
      );
    } catch (err) {
      console.warn("[ar] invoice docNumber lookup failed", err?.message || err);
    }
  }

  let resolvedIds = 0;

  const upsertRows = items.map((item) => {
    const matched = item.doc_number ? invoiceMap[item.doc_number] : null;
    const matchedCustomer = extractQboInvoiceCustomerIdentity(matched);
    const qbo_invoice_id = matched?.Id || item.qbo_invoice_id || null;
    if (matched?.Id) resolvedIds += 1;

    const invoice_date = matched?.TxnDate ? toDateOnly(matched.TxnDate) : item.invoice_date;
    const due_date = matched?.DueDate ? toDateOnly(matched.DueDate) : item.due_date;
    const total_amount = toNumber(matched?.TotalAmt);
    const balance = toNumber(matched?.Balance) ?? item.balance;
    const currency =
      matched?.CurrencyRef?.value ||
      matched?.CurrencyRef?.name ||
      item.currency ||
      reportJson?.Header?.Currency ||
      null;

    const status = (() => {
      if (balance === 0) return "paid";
      if (total_amount != null && balance < total_amount) return "partial";
      const overdue = computeDaysOverdue(due_date);
      if (overdue && overdue > 0) return "overdue";
      return "unpaid";
    })();

    const days_overdue = computeDaysOverdue(due_date);
    return {
      business_id: businessId,
      source: "qbo",
      qbo_env: qboEnvName,
      qbo_realm_id: realmId,
      qbo_invoice_id,
      qbo_customer_id: matchedCustomer.customer_id || item.qbo_customer_id || null,
      client_name:
        matchedCustomer.customer_ref_name ||
        item.customer_ref_name ||
        item.client_name ||
        CUSTOMER_NAME_UNAVAILABLE,
      doc_number: item.doc_number,
      total_amount,
      balance,
      due_date,
      invoice_date,
      status,
      days_overdue,
      last_synced_at: new Date().toISOString(),
      currency,
    };
  });

  const customerIds = Array.from(
    new Set(upsertRows.map((row) => row.qbo_customer_id).filter(Boolean))
  );

  let customerMap = {};
  let parentMap = {};
  if (customerIds.length) {
    try {
      const customers = await fetchCustomersByIds({ business_id: businessId, customerIds });
      customerMap = Object.fromEntries(customers.map((c) => [String(c.Id), c]));

      const parentIds = Array.from(
        new Set(
          customers
            .map((c) => c?.ParentRef?.value)
            .filter(Boolean)
            .filter((pid) => !customerMap[pid])
        )
      );

      if (parentIds.length) {
        const parents = await fetchCustomersByIds({ business_id: businessId, customerIds: parentIds });
        parentMap = Object.fromEntries(parents.map((p) => [String(p.Id), p]));
      }

      console.info("[ar] Customer enrichment", {
        customers: customers.length,
        parentFetched: Object.keys(parentMap).length,
        jobsDetected: customers.filter((c) => c?.ParentRef?.value).length,
      });
    } catch (err) {
      console.warn("[ar] customer enrichment failed", err?.message || err);
    }
  }

  const enrichedRows = upsertRows.map((row) => {
    const customer = row.qbo_customer_id ? customerMap[row.qbo_customer_id] : null;
    const is_job = !!customer?.ParentRef?.value;
    const parent_qbo_customer_id = is_job ? customer?.ParentRef?.value || null : null;
      const parentCustomer =
        parent_qbo_customer_id && (customerMap[parent_qbo_customer_id] || parentMap[parent_qbo_customer_id]);
      const parent_customer_name = parentCustomer?.CompanyName || parentCustomer?.DisplayName || null;
      const customerPersonName = [customer?.GivenName, customer?.FamilyName].filter(Boolean).join(" ");
      const client_name =
        customer?.CompanyName ||
        customer?.DisplayName ||
        customer?.FullyQualifiedName ||
        customerPersonName ||
        parent_customer_name ||
        row.client_name ||
        CUSTOMER_NAME_UNAVAILABLE;
      return {
      ...row,
      client_name,
      is_job,
      parent_qbo_customer_id,
      parent_customer_name,
    };
  });

  // Payment enrichment (last payment date)
  const invoiceIds = Array.from(new Set(enrichedRows.map((row) => row.qbo_invoice_id).filter(Boolean)));
  let paymentMap = {};
  if (invoiceIds.length) {
    try {
      paymentMap = await queryPaymentsForInvoiceIds({ business_id: businessId, invoiceIds });
    } catch (err) {
      console.warn("[ar] payment enrichment failed", err?.message || err);
    }
  }

  const withPayments = enrichedRows.map((row) => ({
    ...row,
    last_payment_at: row.qbo_invoice_id ? paymentMap[row.qbo_invoice_id] || null : null,
  }));

  // Filter out items where we still don't have an invoice id to keep conflicts stable
  const upsertPayload = withPayments.filter((row) => row.qbo_invoice_id);
  const missingNames = upsertPayload.filter((r) => !r.client_name);
  if (missingNames.length) {
    console.warn("[ar] missing client_name rows", missingNames.slice(0, 5));
    upsertPayload.forEach((r) => {
      if (!r.client_name) r.client_name = "(Unknown customer)";
    });
  }

  const currentOpenInvoiceIds = new Set(
    upsertPayload.filter((row) => (row.balance || 0) > 0).map((row) => row.qbo_invoice_id)
  );

  console.info("[ar] Upserting AR open items", {
    businessId,
    count: upsertPayload.length,
    qbo_env: qboEnvName,
    realmId,
    resolvedIds,
  });

  const { data, error } = await supabase
    .from("ar_open_items")
    .upsert(upsertPayload, {
      onConflict: "business_id,source,qbo_env,qbo_invoice_id",
    })
    .select("id");

  if (error) throw new Error(error.message || "Failed to upsert ar_open_items");
  const lastSyncedAt = new Date().toISOString();

  let deleted = 0;
  let skippedDeletion = false;

  if (currentOpenInvoiceIds.size === 0 && !force) {
    skippedDeletion = true;
    console.warn("[ar] Skipping deletion because no open invoice IDs were parsed (possible upstream issue)");
  } else {
    const staleFilterIds = Array.from(currentOpenInvoiceIds);
    if (staleFilterIds.length > 0) {
      const inList = `(${staleFilterIds.map((id) => `"${id}"`).join(",")})`;
      const staleDelete = await supabase
        .from("ar_open_items")
        .delete()
        .eq("business_id", businessId)
        .eq("source", "qbo")
        .eq("qbo_env", qboEnvName)
        .not("qbo_invoice_id", "in", inList)
        .select("id");
      if (staleDelete.error) {
        console.warn("[ar] failed deleting stale AR items", staleDelete.error.message || staleDelete.error);
      } else {
        deleted += staleDelete.data?.length || 0;
      }
    } else if (force) {
      const staleDelete = await supabase
        .from("ar_open_items")
        .delete()
        .eq("business_id", businessId)
        .eq("source", "qbo")
        .eq("qbo_env", qboEnvName)
        .select("id");
      if (staleDelete.error) {
        console.warn("[ar] failed deleting stale AR items (force)", staleDelete.error.message || staleDelete.error);
      } else {
        deleted += staleDelete.data?.length || 0;
      }
    }

    const paidDelete = await supabase
      .from("ar_open_items")
      .delete()
      .eq("business_id", businessId)
      .eq("source", "qbo")
      .eq("qbo_env", qboEnvName)
      .or("balance.lte.0,status.eq.paid")
      .select("id");
    if (paidDelete.error) {
      console.warn("[ar] failed deleting paid/zero-balance AR items", paidDelete.error.message || paidDelete.error);
    } else {
      deleted += paidDelete.data?.length || 0;
    }
  }

  const { count: remaining = null } = await supabase
    .from("ar_open_items")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .eq("source", "qbo")
    .eq("qbo_env", qboEnvName);

  return {
    synced: true,
    upserted: data?.length || 0,
    resolved_ids: resolvedIds,
    deleted,
    remaining: remaining ?? null,
    skipped: skippedDeletion ? 1 : 0,
    errors: [],
    last_synced_at: lastSyncedAt,
    meta: { business_id: businessId, force, window_days: windowDays, realmId },
  };
}

export async function fetchTopOpenItems({ businessId, limit = null }) {
  const query = supabase
    .from("ar_open_items")
    .select("*")
    .eq("business_id", businessId)
    .order("days_overdue", { ascending: false, nullsLast: true })
    .order("balance", { ascending: false, nullsLast: true });

  if (limit && Number.isFinite(limit)) {
    query.limit(limit);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message || "Failed to read ar_open_items");

  const rows = data || [];
  const invoiceIds = [...new Set(rows.map((row) => row.qbo_invoice_id).filter(Boolean))];
  let invoiceIdentityMap = new Map();
  if (invoiceIds.length) {
    const invoiceResult = await supabase
      .from("job_revenue_documents")
      .select("realm_id,external_document_id,customer_ref")
      .eq("business_id", businessId)
      .eq("source_system", "quickbooks")
      .eq("source_document_type", "invoice")
      .in("external_document_id", invoiceIds);
    if (invoiceResult.error) {
      console.warn("[ar] persisted invoice identity lookup failed", invoiceResult.error.message || invoiceResult.error);
    } else {
      invoiceIdentityMap = new Map((invoiceResult.data || []).map((invoice) => [
        `${invoice.realm_id || ""}:${invoice.external_document_id}`,
        invoice.customer_ref || null,
      ]));
    }
  }
  const hydratedRows = rows.map((row) => {
    const customerRef = invoiceIdentityMap.get(`${row.qbo_realm_id || ""}:${row.qbo_invoice_id}`) || null;
    const persistedIdentity = extractQboInvoiceCustomerIdentity({ customer_ref: customerRef });
    return {
      ...row,
      qbo_customer_id: row.qbo_customer_id || persistedIdentity.customer_id,
      customer_ref_name: persistedIdentity.customer_ref_name,
    };
  });
  const customerIds = [...new Set(hydratedRows.map((row) => row.qbo_customer_id).filter(Boolean))];
  let customers = [];
  if (customerIds.length) {
    const customerResult = await supabase
      .from("qbo_customers")
      .select("business_id,realm_id,qbo_customer_id,display_name,company_name,email,fully_qualified_name,source_snapshot")
      .eq("business_id", businessId)
      .in("qbo_customer_id", customerIds);
    if (customerResult.error) throw new Error(customerResult.error.message || "Failed to resolve customer identity");
    customers = customerResult.data || [];
  }
  const customerMap = new Map(customers.map((customer) => [
    `${customer.realm_id || ""}:${customer.qbo_customer_id}`,
    customer,
  ]));
  const projected = hydratedRows.map((row) => projectCollectionsInvoice(
    row,
    customerMap.get(`${row.qbo_realm_id || ""}:${row.qbo_customer_id}`) || null
  ));
  return { rows: projected };
}

export async function fetchInvoiceDetails({ businessId, qboInvoiceId }) {
  const invoice = await fetchInvoiceById({ business_id: businessId, qbo_invoice_id: qboInvoiceId });
  return {
    invoice,
    source: "qbo",
    business_id: businessId,
    qbo_invoice_id: qboInvoiceId,
  };
}
