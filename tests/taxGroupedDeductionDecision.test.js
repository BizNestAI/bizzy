import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  applyGroupedTaxDeductionDecision,
  getGroupedTaxDeductionDecisionOperation,
} from "../src/services/tax/taxGroupedDeductionDecision.service.js";
import { buildGroupedDeductionDecisionFingerprint } from "../src/services/tax/taxGroupedDeductionDecisionFingerprint.js";
import { buildTaxDeductionsLifecycleProjection } from "../src/services/tax/taxDeductionsLifecycleProjection.js";
import { isSemanticallyEqualClassification } from "../src/services/tax/taxClassification.repository.js";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const YEAR = 2026;
const MEALS_SCOPE = {
  taxCategory: "business_meals",
  qboAccountId: "qbo-meals",
  decisionType: "confirm_business_purpose",
};

test("a 287-row Meals decision performs one bounded write and returns its exact target identity set", async () => {
  const rows = Array.from({ length: 287 }, (_, index) => mealsClassification(index + 1));
  const supabase = makeGroupedDecisionSupabase(rows);
  const ids = rows.map((row) => row.transaction_id);
  const result = await applyGroupedTaxDeductionDecision({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: YEAR,
    actor: { userId: "user-1", role: "user", source: "user" },
    input: groupedInput(ids),
  });

  assert.equal(supabase.readCount, 1, "the target rows are loaded once");
  assert.equal(supabase.rpcCount, 1, "one transactional RPC owns all 287 rows");
  assert.equal(supabase.writeExecutions, 1);
  assert.equal(result.appliedCount, 287);
  assert.deepEqual(result.targetTransactionIds, ids);
  assert.equal(result.classifications.length, 287);
  assert.equal(result.rule.accountName, "Meals");
});

test("a synthetic 300-row decision remains one bounded command", async () => {
  const rows = Array.from({ length: 300 }, (_, index) => mealsClassification(index + 1));
  const supabase = makeGroupedDecisionSupabase(rows);
  const startedAt = performance.now();
  const result = await applyGroupedTaxDeductionDecision({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: YEAR,
    actor: { userId: "user-1", role: "user", source: "user" },
    input: groupedInput(rows.map((row) => row.transaction_id)),
  });

  assert.equal(result.appliedCount, 300);
  assert.equal(supabase.rpcCount, 1);
  assert.ok(performance.now() - startedAt < 1_000, "synthetic command assembly should stay bounded");
});

test("a failed grouped command has no client-side rule or classification side effect", async () => {
  const rows = [mealsClassification(1), mealsClassification(2)];
  const supabase = makeGroupedDecisionSupabase(rows, { failWrite: true });
  const before = structuredClone(rows);

  await assert.rejects(
    () => applyGroupedTaxDeductionDecision({
      supabase,
      businessId: BUSINESS_ID,
      taxYear: YEAR,
      actor: { userId: "user-1", role: "user", source: "user" },
      input: groupedInput(rows.map((row) => row.transaction_id)),
    }),
    (error) => error.code === "tax_data_unavailable"
  );

  assert.equal(supabase.rpcCount, 1);
  assert.equal(supabase.writeExecutions, 0);
  assert.deepEqual(rows, before);
});

test("personal exceptions remain outside the atomic business write while one account default is saved", async () => {
  const rows = [mealsClassification(1), mealsClassification(2), mealsClassification(3)];
  const ids = rows.map((row) => row.transaction_id);
  const supabase = makeGroupedDecisionSupabase(rows);
  const input = groupedInput(ids);
  input.personalExceptionIds = [ids[1]];
  input.targetTransactionIds = [ids[0], ids[2]];
  input.scopeFingerprint = buildGroupedDeductionDecisionFingerprint({ businessId: BUSINESS_ID, taxYear: YEAR, ...MEALS_SCOPE, transactionIds: input.targetTransactionIds, expectedPopulationTransactionIds: ids, personalExceptionIds: input.personalExceptionIds, changes: input.changes, reason: input.reason });
  const result = await applyGroupedTaxDeductionDecision({ supabase, businessId: BUSINESS_ID, taxYear: YEAR, actor: { userId: "user-1", source: "user" }, input });
  assert.equal(supabase.rpcCount, 1);
  assert.equal(supabase.writeExecutions, 1);
  assert.equal(result.appliedCount, 2);
  assert.equal(result.targetTransactionIds.includes(ids[1]), false);
  assert.equal(result.rule.accountName, "Meals");
});

test("failure injection at every atomic database stage produces no partial client result", async () => {
  for (const stage of ["rule", "override_history", "classification", "review_task", "operation_result"]) {
    const rows = [mealsClassification(1), mealsClassification(2)];
    const before = structuredClone(rows);
    const supabase = makeGroupedDecisionSupabase(rows, { failStage: stage });
    await assert.rejects(
      () => applyGroupedTaxDeductionDecision({
        supabase,
        businessId: BUSINESS_ID,
        taxYear: YEAR,
        actor: { userId: "user-1", source: "user" },
        input: groupedInput(rows.map((row) => row.transaction_id)),
      }),
      (error) => error.code === "tax_data_unavailable",
      stage,
    );
    assert.equal(supabase.writeExecutions, 0, stage);
    assert.deepEqual(rows, before, stage);
  }
});

test("repeated delivery with one idempotency key returns the stored result without duplicate writes", async () => {
  const rows = [mealsClassification(1), mealsClassification(2)];
  const supabase = makeGroupedDecisionSupabase(rows);
  const input = groupedInput(rows.map((row) => row.transaction_id));

  const first = await applyGroupedTaxDeductionDecision({
    supabase, businessId: BUSINESS_ID, taxYear: YEAR, actor: { userId: "user-1", source: "user" }, input,
  });
  const second = await applyGroupedTaxDeductionDecision({
    supabase, businessId: BUSINESS_ID, taxYear: YEAR, actor: { userId: "user-1", source: "user" }, input,
  });
  const operation = await getGroupedTaxDeductionDecisionOperation({
    supabase, businessId: BUSINESS_ID, taxYear: YEAR, idempotencyKey: input.idempotencyKey,
  });

  assert.equal(supabase.rpcCount, 2, "the database, not the browser, is the idempotency authority");
  assert.equal(supabase.writeExecutions, 1);
  assert.equal(second.operationId, first.operationId);
  assert.equal(operation.status, "completed");
  assert.equal(operation.result.appliedCount, 2);
});

test("a stale or cross-category target fails before the transactional write", async () => {
  const meals = mealsClassification(1);
  const utilities = { ...mealsClassification(2), tax_category: "utilities", source_qbo_account_id: "qbo-utilities" };
  const supabase = makeGroupedDecisionSupabase([meals, utilities]);
  const ids = [meals.transaction_id, utilities.transaction_id];

  await assert.rejects(
    () => applyGroupedTaxDeductionDecision({
      supabase,
      businessId: BUSINESS_ID,
      taxYear: YEAR,
      actor: { userId: "user-1", source: "user" },
      input: groupedInput(ids),
    }),
    (error) => error.code === "scope_treatment_changed"
  );
  assert.equal(supabase.rpcCount, 0);
  assert.equal(supabase.writeExecutions, 0);
});

test("a client cannot shrink the authoritative expected population by recalculating a fingerprint", async () => {
  const rows = [mealsClassification(1), mealsClassification(2)];
  const ids = rows.map((row) => row.transaction_id);
  const input = groupedInput([ids[0]], { expectedPopulationTransactionIds: [ids[0]] });
  const supabase = makeGroupedDecisionSupabase(rows);

  await assert.rejects(
    () => applyGroupedTaxDeductionDecision({
      supabase,
      businessId: BUSINESS_ID,
      taxYear: YEAR,
      actor: { userId: "user-1", source: "user" },
      input,
    }),
    (error) => error.code === "scope_membership_changed",
  );
  assert.equal(supabase.rpcCount, 0);
  assert.equal(supabase.writeExecutions, 0);
});

test("decision fingerprints are stable across transaction ordering", () => {
  const changes = defaultChanges();
  const forward = buildGroupedDeductionDecisionFingerprint({ businessId: BUSINESS_ID, taxYear: YEAR, ...MEALS_SCOPE, transactionIds: ["meal-2", "meal-1"], expectedPopulationTransactionIds: ["meal-2", "meal-1"], changes, reason: "same" });
  const reverse = buildGroupedDeductionDecisionFingerprint({ businessId: BUSINESS_ID, taxYear: YEAR, ...MEALS_SCOPE, transactionIds: ["meal-1", "meal-2"], expectedPopulationTransactionIds: ["meal-1", "meal-2"], changes, reason: "same" });
  assert.equal(forward, reverse);
});

test("a no-op periodic classification sweep does not bump the row version", () => {
  const existing = mealsClassification(1);
  const next = {
    ...existing,
    updated_at: "2026-10-23T18:00:00.000Z",
    metadata: { ...existing.metadata, classified_at: "2026-10-23T18:00:00.000Z", classificationRunId: "periodic-sweep-2" },
  };
  assert.equal(isSemanticallyEqualClassification(existing, next), true);
  next.deductible_amount = 9;
  assert.equal(isSemanticallyEqualClassification(existing, next), false, "a material amount change remains visible");
});

test("same idempotency key with a different treatment fingerprint conflicts instead of replaying", async () => {
  const rows = [mealsClassification(1), mealsClassification(2)];
  const ids = rows.map((row) => row.transaction_id);
  const supabase = makeGroupedDecisionSupabase(rows);
  const first = groupedInput(ids);
  const changed = groupedInput(ids, {
    changes: {
      taxCategory: "business_meals",
      deductibilityStatus: "partially_deductible",
      deductiblePercent: 25,
      taxTreatment: "business_meals_business_purpose_confirmed",
    },
  });

  await applyGroupedTaxDeductionDecision({ supabase, businessId: BUSINESS_ID, taxYear: YEAR, actor: { userId: "user-1", source: "user" }, input: first });
  await assert.rejects(
    () => applyGroupedTaxDeductionDecision({ supabase, businessId: BUSINESS_ID, taxYear: YEAR, actor: { userId: "user-1", source: "user" }, input: changed }),
    (error) => error.code === "idempotency_payload_conflict",
  );
  assert.equal(supabase.writeExecutions, 1);
});

test("concurrent delivery of the same idempotency key has one durable write", async () => {
  const rows = [mealsClassification(1), mealsClassification(2)];
  const supabase = makeGroupedDecisionSupabase(rows);
  const input = groupedInput(rows.map((row) => row.transaction_id));
  const [first, second] = await Promise.all([
    applyGroupedTaxDeductionDecision({ supabase, businessId: BUSINESS_ID, taxYear: YEAR, actor: { userId: "user-1", source: "user" }, input }),
    applyGroupedTaxDeductionDecision({ supabase, businessId: BUSINESS_ID, taxYear: YEAR, actor: { userId: "user-1", source: "user" }, input }),
  ]);
  assert.equal(supabase.writeExecutions, 1);
  assert.equal(first.operationId, second.operationId);
});

test("the 303 Meals population conserves 287 actionable and 16 already reviewed stable IDs", () => {
  const actionable = Array.from({ length: 287 }, (_, index) => lifecycleMealRow(index + 1));
  const reviewed = Array.from({ length: 16 }, (_, index) => lifecycleMealRow(index + 288, {
    classificationStatus: "user_confirmed",
    status: "user_confirmed",
    requiresReview: false,
    userOverride: true,
  }));
  const projection = buildTaxDeductionsLifecycleProjection({
    rows: [...actionable, ...reviewed], businessId: BUSINESS_ID, taxYear: YEAR,
  });
  const group = projection.activeDecisionGroups[0];

  assert.equal(group.categoryTransactionCount, 303);
  assert.equal(group.actionableTransactionCount, 287);
  assert.equal(group.alreadyResolvedCount, 16);
  assert.equal(group.explicitlyExcludedCount, 0);
  assert.equal(group.populationConservation.isConserved, true);
  assert.equal(new Set(group.stableTransactionIds.category).size, 303);
});

test("the client patches returned scoped rows and then reloads the authoritative Tax workspace", () => {
  const hook = readFileSync("src/hooks/tax/useTaxDeductions.js", "utf8");
  const dashboard = readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(hook, /function patchTaxPageWithGroupedDecision/);
  assert.match(hook, /setTransactions\(patchPage\);[\s\S]*setAllTransactions\(patchPage\);[\s\S]*setClassificationRows\(patchPage\);/);
  assert.match(dashboard, /confirmGroupedDeductionDecision/);
  assert.match(dashboard, /previewGroupedDeductionDecision/);
  assert.doesNotMatch(dashboard, /for \(let index = 0; index < ids\.length; index \+= 100\)/);
  assert.match(hook, /confirmGroupedDeductionDecision:[\s\S]*load\(\{ signal, refresh: true \}\)/);
  assert.doesNotMatch(hook, /refreshAuthoritativeQuestionSummary/);
  assert.match(dashboard, /previewId: serverPreview\.previewId/);
});

test("a confirmed scope conflict stays in the modal and requires a refreshed deliberate confirmation", () => {
  const dashboard = readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /These transactions changed while you were reviewing them\. We refreshed the list\. Please review the updated totals and confirm again\./);
  assert.match(dashboard, /await onScopeChanged\?\.\(\)/);
  assert.match(dashboard, /idempotencyKeyRef\.current = null/);
  assert.match(dashboard, /aria-live="polite"/);
  assert.match(dashboard, /This question no longer needs an answer\./);
  assert.match(dashboard, /changedSummary\.gross/);
  assert.doesNotMatch(dashboard, /onScopeChanged\?\.\(\)[\s\S]{0,200}submit\(\)/);
});

test("the forward-only RPC migration uses one atomic, idempotent set-based command", () => {
  const sql = readFileSync("supabase/migrations/20261101121000_atomic_grouped_tax_deduction_decision.sql", "utf8");
  const routes = readFileSync("src/api/tax/taxClassificationReview.routes.js", "utf8");
  assert.match(sql, /begin;[\s\S]*commit;/i);
  assert.match(sql, /create table if not exists public\.tax_grouped_deduction_decision_operations/i);
  assert.match(sql, /unique \(business_id, idempotency_key\)/i);
  assert.match(sql, /expected_population_transaction_ids/i);
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /for update of c/i);
  assert.match(sql, /insert into public\.tax_classification_overrides/i);
  assert.match(sql, /update public\.transaction_tax_classifications/i);
  assert.match(sql, /resolved_review_tasks/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /security invoker/i);
  assert.match(sql, /revoke all on function[\s\S]*from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function[\s\S]*to service_role/i);
  assert.doesNotMatch(sql, /security definer/i);
  assert.doesNotMatch(sql, /execute\s+(immediate|format)\b/i);
  assert.doesNotMatch(sql, /exception\s+when/i);
  assert.doesNotMatch(sql, /loop\s*$/im);
  assert.doesNotMatch(sql, /(quickbooks|plaid|openai)/i);
  assert.match(routes, /router\.post\("\/deduction-decisions\/apply"[\s\S]*assertTaxMutationAllowed\(req\)/);
  assert.match(routes, /tenantContext\?\.mode === "admin_view"/);
  assert.match(routes, /canonicalMutationBusinessId/);
  assert.match(routes, /requireServerBusinessContext: true/);
});

test("the generated production audit is self-contained and strictly read-only", () => {
  const sql = readFileSync("scripts/manual/auditGroupedTaxDeductionDecision.sql", "utf8");
  assert.match(sql, /meals_rule_scope/);
  assert.match(sql, /meals_population_reconciliation/);
  assert.match(sql, /bookkeeping_detail_reasons/);
  assert.match(sql, /non_meals_incident_mutation/);
  assert.match(sql, /duplicate_or_overlapping_stable_ids/);
  assert.match(sql, /^\s*begin read only;/i);
  assert.match(sql, /commit;\s*$/i);
  assert.doesNotMatch(sql, /^\s*(insert|update|delete|merge|create|alter|drop|grant|revoke|do|lock)\b/im);
  assert.doesNotMatch(sql, /\bfor\s+update\b/i);
});

function groupedInput(transactionIds, { expectedPopulationTransactionIds = transactionIds, changes = defaultChanges(), reason = "Customer confirmed business purpose for matching expense category." } = {}) {
  const idempotencyKey = "grouped-decision-test-command-0001";
  return {
    idempotencyKey,
    scope: MEALS_SCOPE,
    scopeFingerprint: buildGroupedDeductionDecisionFingerprint({
      businessId: BUSINESS_ID,
      taxYear: YEAR,
      ...MEALS_SCOPE,
      transactionIds,
      expectedPopulationTransactionIds,
      changes,
      reason,
    }),
    targetTransactionIds: transactionIds,
    expectedPopulationTransactionIds,
    changes,
    reason,
  };
}

function defaultChanges() {
  return {
    taxCategory: "business_meals",
    deductibilityStatus: "partially_deductible",
    deductiblePercent: 50,
    taxTreatment: "business_meals_business_purpose_confirmed",
  };
}

function mealsClassification(index) {
  return {
    id: `classification-${index}`,
    business_id: BUSINESS_ID,
    tax_year: YEAR,
    transaction_id: `meal-${index}`,
    transaction_date: "2026-06-15",
    tax_category: "business_meals",
    deductibility_status: "partially_deductible",
    deductible_percent: 50,
    tax_treatment: { type: "business_meals_needs_confirmation" },
    book_amount: -20,
    deductible_amount: 10,
    nondeductible_amount: 10,
    capitalizable_amount: 0,
    classification_status: "needs_review",
    confidence_score: 60,
    confidence_level: "medium",
    requires_review: true,
    user_override: false,
    cpa_override: false,
    source_qbo_account_id: "qbo-meals",
    source_qbo_account_name: "Meals",
    metadata: { direction: "OUTFLOW", source_qbo_account_id: "qbo-meals", source_qbo_account_name: "Meals" },
    updated_at: "2026-10-21T12:00:00.000Z",
  };
}

function lifecycleMealRow(index, overrides = {}) {
  return {
    transactionId: `meal-${index}`,
    qboAccountId: "qbo-meals",
    qboAccountName: "Meals",
    taxCategory: "business_meals",
    taxTreatment: "business_meals_needs_confirmation",
    status: "needs_review",
    classificationStatus: "needs_review",
    requiresReview: true,
    taxScopeDisposition: "expense_cogs_in_matrix",
    amount: 20,
    ...overrides,
  };
}

function makeGroupedDecisionSupabase(rows, { failWrite = false, failStage = null } = {}) {
  const store = {
    rows,
    operations: new Map(),
  };
  return {
    readCount: 0,
    rpcCount: 0,
    writeExecutions: 0,
    from(table) {
      if (table === "tax_grouped_deduction_decision_operations") return operationQuery(store);
      assert.equal(table, "transaction_tax_classifications");
      this.readCount += 1;
      return classificationQuery(store.rows);
    },
    async rpc(name, params) {
      assert.equal(name, "apply_grouped_tax_deduction_decision");
      this.rpcCount += 1;
      const prior = store.operations.get(params.p_idempotency_key);
      if (prior) {
        if (prior.scope_fingerprint !== params.p_scope_fingerprint) {
          return { data: null, error: { code: "40001", message: "idempotency_key_reused" } };
        }
        return { data: prior, error: null };
      }
      if (failWrite || failStage) return { data: null, error: { code: "XX000", message: `forced ${failStage || "write"} failure` } };
      this.writeExecutions += 1;
      const classifications = params.p_items.map((item) => ({
        ...item,
        transaction_id: item.transaction_id,
        classification_status: "user_confirmed",
        requires_review: false,
        user_override: true,
        source: "user",
        updated_at: "2026-10-21T13:00:00.000Z",
      }));
      const result = {
        operation_id: "operation-1",
        status: "completed",
        idempotency_key: params.p_idempotency_key,
        scope_fingerprint: params.p_scope_fingerprint,
        applied_count: classifications.length,
        already_matching_count: 0,
        skipped_count: 0,
        skipped_reasons: [],
        target_transaction_ids: params.p_target_transaction_ids,
        expected_population_transaction_ids: params.p_expected_population_transaction_ids,
        classifications,
        rule: { ...params.p_rule, id: "rule-meals" },
      };
      store.operations.set(params.p_idempotency_key, result);
      return { data: result, error: null };
    },
  };
}

function classificationQuery(rows) {
  const query = {
    select: () => query,
    eq: () => query,
    order: () => query,
    range: () => Promise.resolve({ data: rows, error: null }),
  };
  return query;
}

function operationQuery(store) {
  let key = null;
  const query = {
    select: () => query,
    eq: (field, value) => {
      if (field === "idempotency_key") key = value;
      return query;
    },
    maybeSingle: async () => ({ data: store.operations.get(key) ? { status: "completed", result: store.operations.get(key), id: "operation-1" } : null, error: null }),
  };
  return query;
}
