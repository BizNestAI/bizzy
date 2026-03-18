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

const toDateOnly = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const toNumber = (v) => {
  if (v === null || v === undefined) return null;
  const num = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(num) ? num : null;
};

function computeDaysOverdue(dueDate) {
  if (!dueDate) return null;
  const due = new Date(dueDate);
  if (Number.isNaN(due.getTime())) return null;
  const now = new Date();
  const diffMs = now.setHours(0, 0, 0, 0) - due.setHours(0, 0, 0, 0);
  return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
}

export function parseARAgingDetailToOpenItems(reportJson = {}) {
  const rows = reportJson?.Rows?.Row || [];
  let flatCount = 0;
  const items = [];

  const walk = (nodes, context = {}) => {
    if (!Array.isArray(nodes)) return;
    nodes.forEach((node) => {
      if (node?.type === "Section" && node?.Header?.ColData?.[0]?.value) {
        const client = node.Header.ColData[0].value;
        walk(node.Rows?.Row, { client_name: client });
        return;
      }

      if (node?.type === "Data") {
        flatCount += 1;
        const cols = node?.ColData || [];
        // Common column ordering from QBO AgedReceivablesDetail:
        // 0 Customer, 1 Type, 2 Date, 3 Num, 4 Due Date, 5 Aging bucket(s), last = Open Balance
        const client_name = context.client_name || cols[0]?.value || null;
        const doc_number = cols[3]?.value || null;
        const invoice_date = toDateOnly(cols[2]?.value || null);
        const due_date = toDateOnly(cols[4]?.value || null);
        const balanceRaw = cols[cols.length - 1]?.value || null;
        const balance = toNumber(balanceRaw) || 0;

        items.push({
          client_name,
          doc_number,
          due_date,
          invoice_date,
          balance,
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
        client_name: null,
        doc_number: inv.DocNumber || null,
        qbo_invoice_id: inv.Id || null,
        qbo_customer_id: inv?.CustomerRef?.value || null,
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
      qbo_customer_id: matched?.CustomerRef?.value || null,
      client_name:
        item.client_name ||
        matched?.CustomerRef?.name ||
        matched?.CustomerRef?.value ||
        item.doc_number ||
        "(Unknown customer)",
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
      const parent_customer_name = parentCustomer?.DisplayName || null;
      const client_name = row.client_name || customer?.DisplayName || parentCustomer?.DisplayName || "(Unknown customer)";
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

  return { rows: data || [] };
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
