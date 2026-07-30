import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const migration = readFileSync(
  new URL("../supabase/migrations/20260729_job_costing_rls_realm_integrity.sql", import.meta.url),
  "utf8",
);

const auditedTables = [
  "customers",
  "customer_external_links",
  "qbo_customers",
  "job_external_links",
  "job_revenue_documents",
  "job_payment_records",
  "job_payment_allocations",
  "job_revenue_evidence",
  "job_candidates",
  "job_identity_mappings",
  "qbo_projects",
  "qbo_projects_capabilities",
  "qbo_webhook_events",
  "qbo_entity_sync_runs",
  "qbo_cdc_cursors",
  "qbo_job_costing_backfill_runs",
  "qbo_job_costing_daily_sync_state",
  "job_transaction_assignments",
  "assignment_history",
  "job_assignment_suggestions",
  "job_assignment_instruction_history",
  "job_costing_realm_integrity_conflicts",
];

describe("job costing RLS and QBO realm integrity migration", () => {
  test("audits every Jobs/QBO table and uses existing business ownership helper", () => {
    for (const table of auditedTables) {
      assert.match(migration, new RegExp(`'${table}'`), `${table} is included in the RLS audit loop`);
    }
    assert.match(migration, /enable row level security/i);
    assert.match(migration, /public\.tax_user_owns_business\(business_id\)/);
    assert.match(migration, /for select to authenticated/i);
    assert.match(migration, /for insert to authenticated/i);
    assert.match(migration, /for update to authenticated/i);
    assert.match(migration, /for delete to authenticated/i);
    assert.doesNotMatch(migration, /force row level security/i);
  });

  test("records collision findings before replacing uniqueness constraints", () => {
    assert.match(migration, /job_costing_realm_integrity_conflicts/);
    assert.match(migration, /duplicate_count/);
    assert.match(migration, /sample_ids/);
    assert.match(migration, /not exists \(select 1 from public\.job_costing_realm_integrity_conflicts/i);
  });

  test("QBO external identity uniqueness includes realm_id", () => {
    const expectedKeys = [
      "customer_external_links_realm_unique unique (business_id, realm_id, source_system, source_entity_type, external_entity_id)",
      "job_external_links_realm_unique unique (business_id, realm_id, source_system, source_entity_type, external_entity_id)",
      "job_revenue_documents_realm_unique unique (business_id, realm_id, source_system, source_document_type, external_document_id)",
      "job_payment_records_realm_unique unique (business_id, realm_id, source_system, external_payment_id)",
      "job_candidates_source_realm_unique unique (business_id, realm_id, source_system, source_entity_type, source_entity_id)",
      "job_identity_mappings (business_id, realm_id, source_system, mapping_type, source_entity_id)",
      "job_revenue_evidence (business_id, realm_id, qbo_txn_type, qbo_txn_id",
      "qbo_webhook_events (realm_id, qbo_env, entity_type, entity_id, operation, event_timestamp)",
    ];
    for (const key of expectedKeys) {
      assert.ok(migration.includes(key), `${key} is present`);
    }
  });

  test("new QBO rows must carry realm_id while legacy rows can be remediated later", () => {
    assert.match(migration, /customer_external_links_qbo_realm_required/);
    assert.match(migration, /job_external_links_qbo_realm_required/);
    assert.match(migration, /job_revenue_documents_qbo_realm_required/);
    assert.match(migration, /job_payment_records_qbo_realm_required/);
    assert.match(migration, /job_candidates_qbo_realm_required/);
    assert.match(migration, /job_identity_mappings_qbo_realm_required/);
    assert.match(migration, /job_revenue_evidence_qbo_realm_required/);
    assert.match(migration, /not valid/i);
  });
});
