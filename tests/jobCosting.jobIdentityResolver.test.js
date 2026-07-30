import assert from "node:assert/strict";
import { describe, test } from "node:test";

process.env.SUPABASE_URL ||= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const {
  buildCandidatePayload,
  buildManualJobInsertPayload,
  buildMappingPayloadFromCandidate,
  isProductOnlyDocument,
  normalizeAddressKey,
  resolveJobIdentity,
} = await import("../src/services/jobCosting/jobIdentityResolver.js");

const businessId = "11111111-1111-4111-8111-111111111111";

function invoice(overrides = {}) {
  return {
    business_id: businessId,
    source_system: "quickbooks",
    source_document_type: "invoice",
    external_document_id: "inv-1",
    document_number: "INV-1001",
    document_date: "2026-07-10",
    customer_id: "customer-1",
    customer_ref: { value: "qbo-customer-1", name: "Maya Johnson" },
    total_amount: 7200,
    realm_id: "realm-1",
    qbo_env: "sandbox",
    status: "open",
    shipping_address: { line1: "12 Main Street", city: "Austin", country_subdivision_code: "TX", postal_code: "78701" },
    line_summaries: [{ description: "Deck rebuild progress invoice", amount: 7200 }],
    customer_memo: "Johnson deck rebuild progress billing",
    ...overrides,
  };
}

const subCustomer = {
  qbo_customer_id: "qbo-sub-1",
  customer_id: "customer-1",
  is_sub_customer: true,
  display_name: "Johnson Deck Rebuild",
  realm_id: "realm-1",
  qbo_env: "sandbox",
};

describe("job identity resolver", () => {
  test("creates a pending invoice candidate without authoritative identity", () => {
    const result = resolveJobIdentity({ businessId, document: invoice() });
    assert.equal(result.decision, "candidate");
    assert.equal(result.candidatePayload.source_entity_type, "invoice");
    assert.equal(result.candidatePayload.invoice_estimate_amount, 7200);
    assert.match(result.reasons.join(" "), /invoice_without_authoritative_project_identity/);
  });

  test("creates an estimate candidate before invoicing", () => {
    const result = resolveJobIdentity({
      businessId,
      document: invoice({
        source_document_type: "estimate",
        external_document_id: "est-1",
        total_amount: 8500,
      }),
    });
    assert.equal(result.decision, "candidate");
    assert.equal(result.candidatePayload.candidate_type, "job_from_estimate");
    assert.match(result.reasons.join(" "), /estimate_can_seed_job_before_invoice/);
  });

  test("invoice with sub-customer becomes high-confidence candidate without silent auto-create", () => {
    const result = resolveJobIdentity({ businessId, document: invoice(), qboCustomer: subCustomer });
    assert.equal(result.decision, "candidate");
    assert.equal(result.candidatePayload.qbo_subcustomer_id, "qbo-sub-1");
    assert.equal(result.confidenceLevel, "high");
  });

  test("authoritative project identity maps only through confirmed mapping", () => {
    const result = resolveJobIdentity({
      businessId,
      document: invoice({ project_ref: { value: "project-9", name: "QBO Project 9" } }),
      learnedMappings: [{
        active: true,
        source_system: "quickbooks",
        mapping_type: "qbo_project",
        source_entity_id: "project-9",
        job_id: "job-9",
      }],
    });
    assert.equal(result.decision, "existing_job");
    assert.equal(result.jobId, "job-9");
    assert.equal(result.confidenceScore, 100);
  });

  test("progress invoice attaches to existing job through linked estimate or invoice", () => {
    const result = resolveJobIdentity({
      businessId,
      document: invoice({ linked_txn: [{ linked_transaction_id: "est-22", linked_transaction_type: "estimate" }] }),
      linkedDocuments: [{ external_document_id: "est-22", source_document_type: "estimate", job_id: "job-22" }],
    });
    assert.equal(result.decision, "existing_job");
    assert.equal(result.jobId, "job-22");
  });

  test("recurring invoice is lowered to manual review", () => {
    const result = resolveJobIdentity({
      businessId,
      document: invoice({ customer_memo: "Monthly recurring maintenance service plan" }),
    });
    assert.equal(result.decision, "manual_review");
    assert.equal(result.confidenceLevel, "low");
  });

  test("product-only invoice is suppressed", () => {
    const document = invoice({
      line_summaries: [
        { description: "Hardware materials", amount: 100 },
        { description: "Deck supplies", amount: 200 },
      ],
    });
    assert.equal(isProductOnlyDocument(document), true);
    const result = resolveJobIdentity({ businessId, document });
    assert.equal(result.decision, "ignored");
    assert.deepEqual(result.reasons, ["product_only_document"]);
  });

  test("credit memo and zero invoices do not create candidates", () => {
    assert.equal(resolveJobIdentity({ businessId, document: invoice({ source_document_type: "credit_memo" }) }).decision, "ignored");
    assert.equal(resolveJobIdentity({ businessId, document: invoice({ total_amount: 0 }) }).decision, "ignored");
  });

  test("does not match existing jobs by equal amount only", () => {
    const result = resolveJobIdentity({
      businessId,
      document: invoice({ shipping_address: null, customer_ref: { value: "other", name: "Other Customer" } }),
      jobs: [{ id: "job-equal", job_name: "Unrelated", contract_amount: 7200 }],
    });
    assert.notEqual(result.decision, "existing_job");
    assert.equal(result.possibleJobMatches.length, 0);
  });

  test("candidate source identity is stable for duplicate protection", () => {
    const candidate = buildCandidatePayload({ businessId, document: invoice() });
    assert.equal(candidate.source_system, "quickbooks");
    assert.equal(candidate.source_entity_type, "invoice");
    assert.equal(candidate.source_entity_id, "inv-1");
    assert.equal(candidate.realm_id, "realm-1");
    assert.equal(candidate.qbo_env, "sandbox");
  });

  test("learned mappings are constrained to the matching QBO realm", () => {
    const result = resolveJobIdentity({
      businessId,
      document: invoice({ realm_id: "realm-2", project_ref: { value: "project-9", name: "QBO Project 9" } }),
      learnedMappings: [{
        active: true,
        source_system: "quickbooks",
        mapping_type: "qbo_project",
        source_entity_id: "project-9",
        realm_id: "realm-1",
        job_id: "job-wrong-realm",
      }],
    });
    assert.notEqual(result.decision, "existing_job");
  });

  test("linked document matches are constrained to the matching QBO realm", () => {
    const result = resolveJobIdentity({
      businessId,
      document: invoice({ realm_id: "realm-2", linked_txn: [{ linked_transaction_id: "est-22", linked_transaction_type: "estimate" }] }),
      linkedDocuments: [{ external_document_id: "est-22", source_document_type: "estimate", realm_id: "realm-1", job_id: "job-wrong-realm" }],
    });
    assert.notEqual(result.decision, "existing_job");
  });

  test("manual add job supports Bizzi-only jobs without QuickBooks", () => {
    const payload = buildManualJobInsertPayload({
      businessId,
      userId: "user-1",
      payload: {
        job_name: "Manual Bathroom Remodel",
        customer_name: "Jordan Brown",
        revenueBasis: "contract_value",
      },
    });
    assert.equal(payload.user_id, "user-1");
    assert.equal(payload.job_name, "Manual Bathroom Remodel");
    assert.equal(payload.source_type, "manual");
    assert.equal(payload.creation_method, "manual_add_job");
  });

  test("learned mapping payload persists deterministic sub-customer rules", () => {
    const candidate = buildCandidatePayload({ businessId, document: invoice(), qboCustomer: subCustomer });
    const mapping = buildMappingPayloadFromCandidate({
      businessId,
      candidate,
      jobId: "job-1",
      mappingType: "qbo_subcustomer",
      now: new Date("2026-07-24T12:00:00.000Z"),
    });
    assert.equal(mapping.source_entity_id, "qbo-sub-1");
    assert.equal(mapping.realm_id, "realm-1");
    assert.equal(mapping.confidence_source, "user_confirmed");
  });

  test("service address normalization supports deterministic address mapping", () => {
    assert.equal(
      normalizeAddressKey({ line1: "12 Main Street", city: "Austin", country_subdivision_code: "TX", postal_code: "78701" }),
      "12 main st|austin|tx|78701",
    );
  });
});
