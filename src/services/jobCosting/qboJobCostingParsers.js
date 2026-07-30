const QBO_DOCUMENT_TYPE_MAP = {
  Invoice: "invoice",
  Estimate: "estimate",
  SalesReceipt: "sales_receipt",
  CreditMemo: "credit_memo",
};

const LINKED_TXN_TYPE_MAP = {
  Invoice: "invoice",
  Estimate: "estimate",
  Payment: "payment",
  SalesReceipt: "sales_receipt",
  CreditMemo: "credit_memo",
  Deposit: "deposit",
  JournalEntry: "journal_entry",
};

export function toNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function toDateOnly(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10) || null;
  return date.toISOString().slice(0, 10);
}

export function normalizeQboRef(ref) {
  if (!ref) return null;
  if (typeof ref === "string" || typeof ref === "number") {
    return { value: String(ref), name: null };
  }
  const value = ref.value ?? ref.Value ?? ref.Id ?? ref.id ?? null;
  if (!value) return null;
  return {
    value: String(value),
    name: ref.name ?? ref.Name ?? null,
  };
}

export function normalizeQboAddress(address) {
  if (!address || typeof address !== "object") return null;
  return {
    line1: address.Line1 ?? null,
    line2: address.Line2 ?? null,
    line3: address.Line3 ?? null,
    city: address.City ?? null,
    country_subdivision_code: address.CountrySubDivisionCode ?? null,
    postal_code: address.PostalCode ?? null,
    country: address.Country ?? null,
    lat: address.Lat ?? null,
    long: address.Long ?? null,
  };
}

export function normalizeQboEmail(email) {
  if (!email) return null;
  return typeof email === "string" ? email : email.Address ?? null;
}

export function normalizeQboPhone(phone) {
  if (!phone) return null;
  return typeof phone === "string" ? phone : phone.FreeFormNumber ?? null;
}

export function mapQboDocumentType(type) {
  return QBO_DOCUMENT_TYPE_MAP[type] || LINKED_TXN_TYPE_MAP[type] || String(type || "").toLowerCase();
}

export function parseCustomerRef(entity = {}) {
  return normalizeQboRef(entity.CustomerRef);
}

export function parseParentRef(customer = {}) {
  return normalizeQboRef(customer.ParentRef);
}

export function parseProjectRef(entity = {}) {
  const direct = normalizeQboRef(entity.ProjectRef);
  if (direct) return direct;

  const projectLine = (entity.Line || []).find((line) => normalizeQboRef(line?.ProjectRef));
  return projectLine ? normalizeQboRef(projectLine.ProjectRef) : null;
}

export function parseLinkedTxnArray(value) {
  if (!value) return [];
  const rows = Array.isArray(value) ? value : [value];
  return rows
    .map((txn) => {
      const txnId = txn.TxnId ?? txn.txnId ?? txn.Id ?? null;
      if (!txnId) return null;
      return {
        linked_transaction_id: String(txnId),
        linked_transaction_type: mapQboDocumentType(txn.TxnType ?? txn.txnType ?? ""),
        linked_transaction_line_id: txn.TxnLineId ? String(txn.TxnLineId) : null,
        raw: txn,
      };
    })
    .filter(Boolean);
}

export function parseDocumentLinkedTxns(document = {}) {
  const entityLinks = parseLinkedTxnArray(document.LinkedTxn);
  const lineLinks = (document.Line || []).flatMap((line) =>
    parseLinkedTxnArray(line.LinkedTxn).map((linked) => ({
      ...linked,
      source_line_id: line.Id ? String(line.Id) : null,
      source_line_amount: toNumber(line.Amount, null),
    })),
  );
  return [...entityLinks, ...lineLinks];
}

export function parsePaymentLineLinkedTxns(payment = {}) {
  return (payment.Line || []).flatMap((line) => {
    const amount = toNumber(line.Amount, 0);
    const lineId = line.Id ? String(line.Id) : null;
    const links = parseLinkedTxnArray(line.LinkedTxn);
    if (!links.length && amount !== 0) {
      return [{
        payment_line_id: lineId,
        amount,
        linked_transaction_id: null,
        linked_transaction_type: null,
        linked_transaction_line_id: null,
        raw: line,
      }];
    }
    return links.map((linked) => ({
      payment_line_id: lineId,
      amount,
      ...linked,
      raw: { line, linked_txn: linked.raw },
    }));
  });
}

export function parseDocumentLines(document = {}) {
  return (document.Line || [])
    .filter((line) => line?.DetailType && line.DetailType !== "SubTotalLineDetail")
    .map((line) => {
      const detail =
        line.SalesItemLineDetail ||
        line.DescriptionLineDetail ||
        line.DiscountLineDetail ||
        line.GroupLineDetail ||
        line.AccountBasedExpenseLineDetail ||
        line.ItemBasedExpenseLineDetail ||
        {};
      return {
        line_id: line.Id ? String(line.Id) : null,
        line_num: line.LineNum ?? null,
        description: line.Description ?? null,
        amount: toNumber(line.Amount, 0),
        detail_type: line.DetailType ?? null,
        item_ref: normalizeQboRef(detail.ItemRef),
        account_ref: normalizeQboRef(detail.AccountRef),
        class_ref: normalizeQboRef(detail.ClassRef),
        tax_code_ref: normalizeQboRef(detail.TaxCodeRef),
        quantity: toNumber(detail.Qty, null),
        unit_price: toNumber(detail.UnitPrice, null),
        service_date: toDateOnly(detail.ServiceDate),
        linked_txn: parseLinkedTxnArray(line.LinkedTxn),
        source_snapshot: line,
      };
    });
}

export function inferQboEntityStatus(entity = {}, type = "") {
  const deleted = entity.status === "Deleted" || entity.Status === "Deleted";
  const voided =
    entity.PrivateNote === "Voided" ||
    entity.status === "Voided" ||
    entity.Status === "Voided" ||
    entity.TxnStatus === "Voided";
  if (deleted) return "deleted";
  if (voided) return "voided";
  if (entity.Active === false) return "inactive";
  if (type === "invoice") {
    const total = toNumber(entity.TotalAmt, 0);
    const balance = toNumber(entity.Balance, 0);
    if (total > 0 && balance === 0) return "paid";
    if (balance > 0 && balance < total) return "partially_paid";
    return "open";
  }
  if (type === "estimate") {
    return String(entity.TxnStatus || entity.Status || "active").toLowerCase();
  }
  return "active";
}

export function normalizeQboCustomer(customer = {}, { businessId, realmId, now = new Date() } = {}) {
  const parentRef = parseParentRef(customer);
  const email = normalizeQboEmail(customer.PrimaryEmailAddr);
  const phone = normalizeQboPhone(customer.PrimaryPhone);
  const displayName = customer.DisplayName || customer.FullyQualifiedName || customer.CompanyName || `QBO Customer ${customer.Id}`;
  const updatedAt = customer.MetaData?.LastUpdatedTime || customer.MetaData?.CreateTime || now.toISOString();

  return {
    canonicalCustomer: {
      business_id: businessId,
      display_name: displayName,
      company_name: customer.CompanyName || null,
      email,
      phone,
      billing_address: normalizeQboAddress(customer.BillAddr),
      shipping_address: normalizeQboAddress(customer.ShipAddr),
      status: customer.Active === false ? "inactive" : "active",
      updated_at: now.toISOString(),
    },
    qboCustomer: {
      business_id: businessId,
      realm_id: realmId,
      qbo_customer_id: String(customer.Id),
      qbo_parent_customer_id: parentRef?.value || null,
      is_sub_customer: Boolean(parentRef?.value || customer.Job),
      display_name: displayName,
      fully_qualified_name: customer.FullyQualifiedName || null,
      company_name: customer.CompanyName || null,
      active: customer.Active !== false,
      balance: toNumber(customer.Balance, 0),
      balance_with_jobs: toNumber(customer.BalanceWithJobs, null),
      billing_address: normalizeQboAddress(customer.BillAddr),
      shipping_address: normalizeQboAddress(customer.ShipAddr),
      email,
      phone,
      currency: normalizeQboRef(customer.CurrencyRef)?.value || null,
      sync_token: customer.SyncToken || null,
      source_updated_at: updatedAt,
      sparse: Boolean(customer.sparse),
      source_snapshot: customer,
      last_synced_at: now.toISOString(),
    },
    externalLink: {
      business_id: businessId,
      source_system: "quickbooks",
      source_entity_type: "customer",
      external_entity_id: String(customer.Id),
      external_parent_id: parentRef?.value || null,
      realm_id: realmId,
      sync_token: customer.SyncToken || null,
      source_updated_at: updatedAt,
      last_synced_at: now.toISOString(),
      sync_status: "synced",
      display_name: displayName,
      fully_qualified_name: customer.FullyQualifiedName || null,
      company_name: customer.CompanyName || null,
      active: customer.Active !== false,
      is_sub_customer: Boolean(parentRef?.value || customer.Job),
      potential_job_source: Boolean(parentRef?.value || customer.Job),
      balance: toNumber(customer.Balance, 0),
      balance_with_jobs: toNumber(customer.BalanceWithJobs, null),
      billing_address: normalizeQboAddress(customer.BillAddr),
      shipping_address: normalizeQboAddress(customer.ShipAddr),
      email,
      phone,
      currency: normalizeQboRef(customer.CurrencyRef)?.value || null,
      sparse: Boolean(customer.sparse),
      source_snapshot: customer,
    },
  };
}

export function normalizeQboRevenueDocument(document = {}, qboType, { businessId, realmId, customerId = null, jobId = null, now = new Date() } = {}) {
  const documentType = mapQboDocumentType(qboType);
  const customerRef = parseCustomerRef(document);
  const projectRef = parseProjectRef(document);
  const linkedTxn = parseDocumentLinkedTxns(document);
  const lines = parseDocumentLines(document);
  const updatedAt = document.MetaData?.LastUpdatedTime || document.MetaData?.CreateTime || now.toISOString();

  return {
    business_id: businessId,
    job_id: jobId,
    customer_id: customerId,
    source_system: "quickbooks",
    source_document_type: documentType,
    external_document_id: String(document.Id),
    document_number: document.DocNumber || null,
    document_date: toDateOnly(document.TxnDate),
    due_date: toDateOnly(document.DueDate),
    expiration_date: toDateOnly(document.ExpirationDate),
    total_amount: toNumber(document.TotalAmt, 0),
    open_balance: toNumber(document.Balance, 0),
    status: inferQboEntityStatus(document, documentType),
    currency: normalizeQboRef(document.CurrencyRef)?.value || null,
    realm_id: realmId,
    sync_token: document.SyncToken || null,
    exchange_rate: toNumber(document.ExchangeRate, null),
    customer_ref: customerRef,
    project_ref: projectRef,
    linked_txn: linkedTxn,
    line_summaries: lines,
    billing_address: normalizeQboAddress(document.BillAddr),
    shipping_address: normalizeQboAddress(document.ShipAddr),
    email_status: document.EmailStatus || null,
    print_status: document.PrintStatus || null,
    private_note: document.PrivateNote || null,
    customer_memo: document.CustomerMemo?.value || document.CustomerMemo || null,
    source_snapshot: { realm_id: realmId, qbo_type: qboType, document },
    source_updated_at: updatedAt,
    sync_status: "synced",
    updated_at: now.toISOString(),
  };
}

export function normalizeQboPaymentRecord(payment = {}, { businessId, realmId, customerId = null, now = new Date() } = {}) {
  const lineAllocations = parsePaymentLineLinkedTxns(payment);
  const updatedAt = payment.MetaData?.LastUpdatedTime || payment.MetaData?.CreateTime || now.toISOString();
  return {
    business_id: businessId,
    customer_id: customerId,
    source_system: "quickbooks",
    external_payment_id: String(payment.Id),
    payment_date: toDateOnly(payment.TxnDate),
    total_amount: toNumber(payment.TotalAmt, 0),
    unapplied_amount: toNumber(payment.UnappliedAmt, 0),
    deposit_ref: normalizeQboRef(payment.DepositToAccountRef),
    currency: normalizeQboRef(payment.CurrencyRef)?.value || null,
    realm_id: realmId,
    sync_token: payment.SyncToken || null,
    status: inferQboEntityStatus(payment, "payment"),
    private_note: payment.PrivateNote || null,
    linked_txn: parseLinkedTxnArray(payment.LinkedTxn),
    line_allocations: lineAllocations,
    source_snapshot: payment,
    source_updated_at: updatedAt,
    sync_status: "synced",
    updated_at: now.toISOString(),
  };
}

export function buildPaymentAllocationsFromPayment({ paymentRecordId, payment, documentByExternalKey = new Map(), now = new Date() }) {
  const lineAllocations = parsePaymentLineLinkedTxns(payment);
  const allocations = [];
  const orphans = [];

  lineAllocations.forEach((allocation) => {
    const type = allocation.linked_transaction_type;
    const externalId = allocation.linked_transaction_id;
    if (!externalId || !type) {
      orphans.push({ ...allocation, reason: "unapplied_payment_line" });
      return;
    }
    const key = `${type}:${externalId}`;
    const document = documentByExternalKey.get(key);
    if (!document?.id) {
      orphans.push({ ...allocation, reason: "missing_revenue_document", lookup_key: key });
      return;
    }
    allocations.push({
      payment_record_id: paymentRecordId,
      revenue_document_id: document.id,
      applied_amount: toNumber(allocation.amount, 0),
      linked_transaction_type: type,
      linked_transaction_id: externalId,
      external_revenue_document_id: externalId,
      external_revenue_document_type: type,
      allocation_source: "quickbooks_linked_txn",
      snapshot_version: payment.SyncToken || null,
      source_snapshot: allocation.raw,
      updated_at: now.toISOString(),
    });
  });

  return { allocations, orphans };
}
