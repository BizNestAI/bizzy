import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  TAX_ACTION_OWNERS,
  taxActionOwnerForRow,
} from "../src/services/tax/taxDeductionsLifecycleProjection.js";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("exact run membership migration is service-only, immutable, and count-conserving", () => {
  const sql = read("supabase/migrations/20261102120000_tax_classification_run_items_and_operator_authority.sql");
  assert.match(sql, /unique \(run_id, stable_transaction_id\)/i);
  assert.match(sql, /run total must equal exact membership/i);
  assert.match(sql, /membership is immutable/i);
  assert.match(sql, /force row level security/i);
  assert.match(sql, /revoke all on table public\.tax_classification_run_items from public, anon, authenticated/i);
  assert.match(sql, /grant select, insert, update on table public\.tax_classification_run_items to service_role/i);
  assert.match(sql, /bizzi_operator/i);
});

test("action ownership separates stable-GL mapping gaps from bookkeeping gaps", () => {
  const base = {
    id: "txn-1", status: "unclassified", taxScopeDisposition: "expense_cogs_in_matrix",
    qboAccountType: "Expense", raw: { metadata: { fallback_reason: "no_matching_deduction_rule" } },
  };
  assert.equal(taxActionOwnerForRow({ ...base, qboAccountId: "qbo-gl-1" }), TAX_ACTION_OWNERS.BIZZI_TAX_MAPPING_REQUIRED);
  assert.equal(taxActionOwnerForRow({ ...base, qboAccountId: null }), TAX_ACTION_OWNERS.BOOKKEEPING_REVIEW_REQUIRED);
});

test("durable retry evidence is required for system retry ownership", () => {
  const base = { id: "txn-1", qboAccountId: "gl-1", qboAccountType: "Expense", taxScopeDisposition: "expense_cogs_in_matrix" };
  assert.equal(taxActionOwnerForRow({ ...base, runItem: { lifecycle_state: "retry_scheduled", next_retry_at: "2026-10-22T12:00:00Z" } }), TAX_ACTION_OWNERS.SYSTEM_RETRY);
  assert.notEqual(taxActionOwnerForRow({ ...base, runItem: { lifecycle_state: "retry_scheduled" } }), TAX_ACTION_OWNERS.SYSTEM_RETRY);
  assert.equal(taxActionOwnerForRow({ ...base, runItem: { lifecycle_state: "failed_terminal" } }), TAX_ACTION_OWNERS.TERMINAL_SYSTEM_FAILURE);
});

test("legacy customer UX omits fabricated exact counts and MRP stays separately authorized", () => {
  const dashboard = read("src/pages/Tax/TaxDashboard.jsx");
  const routes = read("src/api/admin/monthlyReview.routes.js");
  assert.match(dashboard, /job\.hasExactMembership === true/);
  assert.match(dashboard, /Some recently posted transactions are still being evaluated/);
  assert.match(dashboard, /View \{total\} transaction/);
  assert.match(routes, /router\.use\(requireInternalRole\(MONTHLY_REVIEW_STAFF_ROLES\)\)/);
  assert.match(routes, /tax-classification-review\/reconcile/);
  assert.match(routes, /business_context_conflict/);
});

test("forward operator repair is service-only, atomic, idempotent, and preserves distinct authority", () => {
  const sql = read("supabase/migrations/20261103120000_atomic_bizzi_operator_tax_decision.sql");
  assert.match(sql, /apply_bizzi_operator_tax_decision/);
  assert.match(sql, /security definer[\s\S]*set search_path = public/i);
  assert.match(sql, /p_actor_authority is distinct from 'bizzi_operator'/);
  assert.match(sql, /classification_status = v_target_status, source = 'bizzi_operator'/);
  assert.match(sql, /classification_status in \('cpa_confirmed', 'accountant_reviewed'\)/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /payload_fingerprint is distinct from p_payload_fingerprint/);
  assert.match(sql, /revoke all on function public\.apply_bizzi_operator_tax_decision[\s\S]*from public, anon, authenticated/);
  assert.match(sql, /revoke all on table public\.tax_classification_run_items from service_role;[\s\S]*grant select, insert, update/);
});

test("MRP derives operator authority server-side and exposes preview/status without Admin View writes", () => {
  const routes = read("src/api/admin/monthlyReview.routes.js");
  const service = read("src/services/tax/taxClassificationOperator.service.js");
  assert.match(routes, /tax-classification-review\/preview/);
  assert.match(routes, /tax-classification-review\/apply/);
  assert.match(routes, /tax-classification-review\/operations\/:idempotencyKey/);
  assert.match(routes, /actorUserId: req\.internalStaff\.userId/);
  assert.doesNotMatch(routes, /p_actor_authority:\s*req\./);
  assert.match(service, /p_actor_authority: "bizzi_operator"/);
  assert.match(service, /professionalConfirmedRowsExcluded/);
  assert.match(service, /customerFactConflicts/);
  assert.match(service, /scopeFingerprint !== input\.scope_fingerprint/);
});

test("operator and customer UIs expose the launch-safe confirmation and Updating details", () => {
  const mrp = read("src/pages/Admin/MonthlyReviewConsole.jsx");
  const dashboard = read("src/pages/Tax/TaxDashboard.jsx");
  assert.match(mrp, /Apply Tax treatment to \$\{editor\.preview\.count\} transactions/);
  assert.match(mrp, /Checking whether your changes were saved/);
  assert.match(mrp, /Open exact Books Review item/);
  assert.match(dashboard, />Last checked</);
  assert.match(dashboard, />Next step</);
  assert.match(dashboard, /Retry scheduled/);
  assert.match(dashboard, /Bizzi is reviewing this/);
});
