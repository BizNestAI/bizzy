import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import process from "node:process";
import test from "node:test";
import { generateCollectionDraft } from "../src/services/ar/collectionMessageDraft.js";
import {
  COLLECTION_DRAFT_TEMPLATE_VERSION,
  CUSTOMER_NAME_UNAVAILABLE,
  collectionSalutation,
  daysPastDueDateOnly,
  extractQboInvoiceCustomerIdentity,
  formatDateOnly,
  isCollectionDraftStale,
  projectCollectionsInvoice,
} from "../src/services/ar/collectionsInvoiceProjection.js";

const invoice = {
  qbo_invoice_id: "invoice-id-1009",
  doc_number: "1009",
  qbo_customer_id: "customer-42",
  qbo_realm_id: "realm-a",
  balance: 400,
  due_date: "2025-01-18",
};

test("canonical customer projection preserves invoice identity and authoritative customer fields separately", () => {
  const company = projectCollectionsInvoice(invoice, {
    qbo_customer_id: "customer-42",
    company_name: "Acme Plumbing LLC",
    display_name: "Acme Plumbing",
    fully_qualified_name: "Acme Plumbing:Main",
    source_snapshot: { GivenName: "Jordan", FamilyName: "Smith" },
  });
  assert.equal(company.invoice_id, "invoice-id-1009");
  assert.equal(company.invoice_number, "1009");
  assert.equal(company.customer_id, "customer-42");
  assert.equal(company.customer_display_name, "Acme Plumbing LLC");
  assert.equal(company.customer_given_name, "Jordan");
  assert.equal(company.customer_family_name, "Smith");
  assert.equal(company.customer_identity_source, "qbo_customer");

  const display = projectCollectionsInvoice(invoice, { display_name: "Acme Display", source_snapshot: {} });
  assert.equal(display.customer_display_name, "Acme Display");
  const person = projectCollectionsInvoice(invoice, { source_snapshot: { GivenName: "Jordan", FamilyName: "Smith" } });
  assert.equal(person.customer_display_name, "Jordan Smith");
});

test("invoice identifiers are never accepted as customer identity", () => {
  for (const badName of ["1009", "invoice-id-1009", "customer-42"]) {
    const projected = projectCollectionsInvoice({ ...invoice, client_name: badName });
    assert.equal(projected.customer_display_name, CUSTOMER_NAME_UNAVAILABLE);
    assert.equal(projected.customer_identity_status, "unresolved");
    assert.equal(collectionSalutation(projected), "Hello,");
  }
});

test("full QBO invoice CustomerRef hydrates canonical identity without a customer-cache row", () => {
  for (const source of [
    { Id: "invoice-1107", DocNumber: "1107", CustomerRef: { value: "customer-a", name: "Projection and Video LLC" } },
    { Id: "invoice-1108", DocNumber: "1108", CustomerRef: { value: "customer-b", name: "Snowball" } },
  ]) {
    const identity = extractQboInvoiceCustomerIdentity(source);
    const projected = projectCollectionsInvoice({
      qbo_invoice_id: source.Id,
      doc_number: source.DocNumber,
      qbo_customer_id: identity.customer_id,
      customer_ref_name: identity.customer_ref_name,
    });
    assert.equal(projected.customer_id, source.CustomerRef.value);
    assert.equal(projected.customer_ref_name, source.CustomerRef.name);
    assert.equal(projected.customer_display_name, source.CustomerRef.name);
    assert.equal(projected.customer_identity_status, "resolved");
    assert.equal(projected.customer_identity_source, "qbo_invoice_customer_ref");
    assert.equal(projected.customer_email_present, false);
    assert.match(generateCollectionDraft(projected, 1).body, new RegExp(`^Hi ${source.CustomerRef.name},`));
  }
});

test("AR report parsing uses column metadata and scopes parent customer identity to section children", async () => {
  process.env.SUPABASE_URL ||= "http://127.0.0.1:54321";
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= "local-test-key";
  const { parseARAgingDetailToOpenItems } = await import("../src/api/ar/ar.service.js");
  const report = {
    Header: { Currency: "USD" },
    Columns: { Column: [
      { ColTitle: "Date", ColType: "tx_date" },
      { ColTitle: "Transaction Type" },
      { ColTitle: "Num" },
      { ColTitle: "Customer" },
      { ColTitle: "Due Date" },
      { ColTitle: "Open Balance" },
    ] },
    Rows: { Row: [
      {
        type: "Section",
        Header: { ColData: [{}, {}, {}, { value: "Projection and Video LLC", id: "customer-a" }] },
        Rows: { Row: [{ type: "Data", ColData: [
          { value: "2026-09-16" }, { value: "Invoice" }, { value: "1107" }, {},
          { value: "2026-09-16" }, { value: "300.00" },
        ] }] },
      },
      {
        type: "Section",
        Header: { ColData: [{}, {}, {}, { value: "Snowball", id: "customer-b" }] },
        Rows: { Row: [{ type: "Data", ColData: [
          { value: "2026-09-16" }, { value: "Invoice" }, { value: "1108" }, {},
          { value: "2026-10-16" }, { value: "150.00" },
        ] }] },
      },
    ] },
  };
  const rows = parseARAgingDetailToOpenItems(report);
  assert.deepEqual(rows.map((row) => ({
    doc_number: row.doc_number,
    qbo_customer_id: row.qbo_customer_id,
    customer_ref_name: row.customer_ref_name,
  })), [
    { doc_number: "1107", qbo_customer_id: "customer-a", customer_ref_name: "Projection and Video LLC" },
    { doc_number: "1108", qbo_customer_id: "customer-b", customer_ref_name: "Snowball" },
  ]);
});

test("draft salutation prefers given name, then company, then generic while subject keeps invoice number", () => {
  const person = projectCollectionsInvoice(invoice, {
    company_name: "Acme Plumbing",
    display_name: "Acme Plumbing",
    source_snapshot: { GivenName: "Jordan" },
  });
  const personDraft = generateCollectionDraft(person, 1);
  assert.match(personDraft.body, /^Hi Jordan,/);
  assert.equal(personDraft.subject, "Quick reminder: invoice 1009");
  assert.match(personDraft.body, /invoice 1009 for \$400\.00, due January 18, 2025/);

  const company = projectCollectionsInvoice(invoice, { company_name: "Acme Plumbing", source_snapshot: {} });
  assert.match(generateCollectionDraft(company, 1).body, /^Hi Acme Plumbing,/);
  assert.match(generateCollectionDraft(invoice, 1).body, /^Hello,/);
  assert.doesNotMatch(generateCollectionDraft(invoice, 1).body, /^Hi 1009,/);
});

test("date-only formatting and calendar overdue math never shift across UTC, New York, or DST", () => {
  assert.equal(formatDateOnly("2025-01-18"), "January 18, 2025");
  assert.equal(formatDateOnly("2025-03-09"), "March 9, 2025");
  assert.equal(daysPastDueDateOnly("2025-01-18", new Date("2025-01-19T04:30:00Z"), "America/New_York"), 0);
  assert.equal(daysPastDueDateOnly("2025-01-18", new Date("2025-01-19T05:30:00Z"), "America/New_York"), 1);
});

test("legacy or identity-mismatched drafts are stale and corrected current drafts are not", () => {
  const projected = projectCollectionsInvoice(invoice, { company_name: "Acme Plumbing", source_snapshot: {} });
  assert.equal(isCollectionDraftStale({ body: "Hi 1009,", due_date: "2025-01-18" }, projected), true);
  assert.equal(isCollectionDraftStale({
    body: "Hi Acme Plumbing,",
    due_date: "2025-01-18",
    qbo_customer_id: "other-customer",
    ai_prompt_version: COLLECTION_DRAFT_TEMPLATE_VERSION,
  }, projected), true);
  assert.equal(isCollectionDraftStale({
    body: "Hi Acme Plumbing,",
    due_date: "2025-01-18",
    qbo_customer_id: "customer-42",
    ai_prompt_version: COLLECTION_DRAFT_TEMPLATE_VERSION,
  }, projected), false);
});

test("server customer cache join is canonical-business and realm scoped without exposing raw QBO payload", async () => {
  const service = await readFile(new URL("../src/api/ar/ar.service.js", import.meta.url), "utf8");
  const controller = await readFile(new URL("../src/api/ar/ar.controller.js", import.meta.url), "utf8");
  const qbo = await readFile(new URL("../src/api/ar/ar.qbo.js", import.meta.url), "utf8");
  assert.match(service, /\.from\("qbo_customers"\)[\s\S]*\.eq\("business_id", businessId\)/);
  assert.match(service, /\.from\("job_revenue_documents"\)[\s\S]*\.eq\("business_id", businessId\)/);
  assert.match(service, /customerMap\.get\(`\$\{row\.qbo_realm_id \|\| ""\}:\$\{row\.qbo_customer_id\}`\)/);
  assert.doesNotMatch(controller, /source_snapshot/);
  assert.doesNotMatch(controller, /qbo_realm_id:/);
  assert.match(qbo, /select Id, CompanyName, DisplayName, FullyQualifiedName, GivenName, FamilyName, ParentRef/);
});
