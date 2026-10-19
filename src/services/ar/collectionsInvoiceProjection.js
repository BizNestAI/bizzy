export const COLLECTION_DRAFT_TEMPLATE_VERSION = "collections-template-v2";
export const CUSTOMER_NAME_UNAVAILABLE = "Customer name unavailable";

const text = (value) => String(value ?? "").trim();

export function normalizeDateOnly(value) {
  const raw = text(value);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const valid = new Date(Date.UTC(year, month - 1, day));
  if (valid.getUTCFullYear() !== year || valid.getUTCMonth() !== month - 1 || valid.getUTCDate() !== day) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

export function formatDateOnly(value, options = {}) {
  const normalized = normalizeDateOnly(value);
  if (!normalized) return "";
  const [year, month, day] = normalized.split("-").map(Number);
  return new Intl.DateTimeFormat(options.locale || "en-US", {
    month: options.month || "long",
    day: "numeric",
    ...(options.year === false ? {} : { year: "numeric" }),
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day, 12)));
}

export function daysPastDueDateOnly(dueDate, today = new Date(), timeZone = "America/New_York") {
  const due = normalizeDateOnly(dueDate);
  if (!due) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(today);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const current = `${values.year}-${values.month}-${values.day}`;
  const toEpochDay = (date) => {
    const [year, month, day] = date.split("-").map(Number);
    return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
  };
  return Math.max(0, toEpochDay(current) - toEpochDay(due));
}

function sourceCustomer(customer = {}) {
  return customer.source_snapshot && typeof customer.source_snapshot === "object"
    ? customer.source_snapshot
    : {};
}

function safeCandidate(value, forbidden) {
  const candidate = text(value);
  return candidate && !forbidden.has(candidate.toLowerCase()) ? candidate : "";
}

export function extractQboInvoiceCustomerIdentity(invoice = {}) {
  const customerRef = invoice?.CustomerRef || invoice?.customer_ref || null;
  return {
    customer_id: text(customerRef?.value) || null,
    customer_ref_name: text(customerRef?.name) || null,
  };
}

export function projectCollectionsInvoice(row = {}, customer = null) {
  const invoiceId = text(row.qbo_invoice_id || row.invoice_id || row.id) || null;
  const invoiceNumber = text(row.doc_number || row.invoice_number) || null;
  const customerId = text(row.qbo_customer_id || row.customer_id) || null;
  const raw = sourceCustomer(customer || {});
  const forbidden = new Set([invoiceId, invoiceNumber, customerId].filter(Boolean).map((value) => value.toLowerCase()));
  const companyName = safeCandidate(customer?.company_name || raw.CompanyName, forbidden);
  const displayName = safeCandidate(customer?.display_name || raw.DisplayName, forbidden);
  const fullyQualifiedName = safeCandidate(customer?.fully_qualified_name || raw.FullyQualifiedName, forbidden);
  const givenName = safeCandidate(customer?.given_name || raw.GivenName, forbidden);
  const familyName = safeCandidate(customer?.family_name || raw.FamilyName, forbidden);
  const joinedName = [givenName, familyName].filter(Boolean).join(" ");
  const customerRecordName = companyName || displayName || fullyQualifiedName || joinedName;
  const customerRefName = safeCandidate(
    row.customer_ref_name || row.customer_ref?.name || row.CustomerRef?.name,
    forbidden
  );
  const persistedName = safeCandidate(row.parent_customer_name || row.client_name, forbidden);
  const resolvedName = customerRecordName || customerRefName || persistedName;
  const email = text(customer?.email || raw.PrimaryEmailAddr?.Address) || null;
  const identitySource = customerRecordName
    ? "qbo_customer"
    : customerRefName || persistedName
      ? "qbo_invoice_customer_ref"
      : "unresolved";

  return {
    ...row,
    invoice_id: invoiceId,
    invoice_number: invoiceNumber,
    customer_id: customerId,
    customer_ref_name: customerRefName || null,
    customer_display_name: resolvedName || CUSTOMER_NAME_UNAVAILABLE,
    customer_company_name: companyName || null,
    customer_given_name: givenName || null,
    customer_family_name: familyName || null,
    customer_email: email,
    customer_email_present: Boolean(email),
    customer_identity_status: resolvedName ? "resolved" : "unresolved",
    customer_identity_source: identitySource,
    invoice_date: normalizeDateOnly(row.invoice_date),
    due_date: normalizeDateOnly(row.due_date),
    days_overdue: daysPastDueDateOnly(row.due_date) ?? Number(row.days_overdue || 0),
    customer: {
      id: customerId,
      display_name: resolvedName || CUSTOMER_NAME_UNAVAILABLE,
      company_name: companyName || null,
      given_name: givenName || null,
      family_name: familyName || null,
      email,
      identity_status: resolvedName ? "resolved" : "unresolved",
      identity_source: identitySource,
    },
  };
}

export function collectionSalutation(invoice = {}) {
  const projected = projectCollectionsInvoice(invoice);
  const given = text(invoice.customer_given_name || invoice.customer?.given_name);
  if (given) return `Hi ${given},`;
  const fallback = text(
    invoice.customer_company_name || invoice.customer?.company_name ||
    invoice.customer_display_name || invoice.customer?.display_name || projected.customer_display_name
  );
  return fallback && fallback !== CUSTOMER_NAME_UNAVAILABLE ? `Hi ${fallback},` : "Hello,";
}

export function isCollectionDraftStale(followup = {}, invoice = {}) {
  if (followup.ai_prompt_version !== COLLECTION_DRAFT_TEMPLATE_VERSION) return true;
  if (text(followup.qbo_customer_id) !== text(invoice.customer_id || invoice.qbo_customer_id)) return true;
  if (normalizeDateOnly(followup.due_date) !== normalizeDateOnly(invoice.due_date)) return true;
  const invoiceNumber = text(invoice.invoice_number || invoice.doc_number);
  return Boolean(invoiceNumber && new RegExp(`^Hi\\s+${invoiceNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*,`, "im").test(text(followup.body)));
}
