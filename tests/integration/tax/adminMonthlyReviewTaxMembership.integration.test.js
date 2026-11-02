import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import process from "node:process";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";
import express from "express";
import { reclassifyBookkeepingTransaction } from "../../../src/services/bookkeeping/bookkeepingReclassificationService.js";
import { processTaxBookkeepingChangeOutbox } from "../../../src/services/tax/processTaxBookkeepingChangeOutbox.js";
import { synchronizeTaxDataChange } from "../../../src/services/tax/taxChangeEvents.js";
import { processPendingTaxClassificationRuns } from "../../../src/services/tax/taxClassificationWorker.service.js";
import { processTaxWorkspaceProjectionRequests } from "../../../src/services/tax/processTaxWorkspaceProjectionRequests.js";
import { getLatestTaxWorkspaceProjection, TAX_WORKSPACE_FORMULA_VERSION } from "../../../src/services/tax/taxWorkspaceProjection.service.js";
import { computeTaxTransactionFingerprint, getTaxClassificationSourceSnapshot } from "../../../src/services/tax/taxPostedTransaction.repository.js";
import taxWorkspaceRouter from "../../../src/api/tax/taxWorkspace.routes.js";

const enabled = process.env.TAX_MEMBERSHIP_DB_INTEGRATION_ENABLED === "true";
const url = process.env.TEST_SUPABASE_URL;
const serviceKey = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;

test("real Admin reclassification trigger and persistent workers move one stable identity from Lyft/Uber to Gas", { skip: !enabled }, async (t) => {
  assert.match(String(url), /^http:\/\/(127\.0\.0\.1|localhost):\d+$/);
  assert.ok(serviceKey);
  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const ids = { user: randomUUID(), business: randomUUID(), transaction: randomUUID(), plaidItem: randomUUID(), plaidAccount: randomUUID() };
  const email = `tax-membership-${ids.business}@example.test`;
  const created = await db.auth.admin.createUser({ id: ids.user, email, password: `T!${randomUUID()}a9`, email_confirm: true });
  if (created.error) throw created.error;
  ids.user = created.data.user.id;
  t.after(async () => {
    await db.from("tax_workspace_projection_requests").delete().eq("business_id", ids.business);
    await db.from("tax_workspace_projections").delete().eq("business_id", ids.business);
    await db.from("tax_bookkeeping_change_outbox").delete().eq("business_id", ids.business);
    await db.from("tax_classification_run_items").delete().eq("business_id", ids.business);
    await db.from("tax_classification_runs").delete().eq("business_id", ids.business);
    await db.from("transaction_tax_classifications").delete().eq("business_id", ids.business);
    await db.from("tax_profiles").delete().eq("business_id", ids.business);
    await db.from("qbo_posted_transactions").delete().eq("business_id", ids.business);
    await db.from("transaction_categorizations").delete().eq("business_id", ids.business);
    await db.from("qbo_accounts_cache").delete().eq("business_id", ids.business);
    await db.from("bank_transactions").delete().eq("business_id", ids.business);
    await db.from("plaid_accounts").delete().eq("business_id", ids.business);
    await db.from("plaid_items").delete().eq("business_id", ids.business);
    await db.from("business_billing").delete().eq("business_id", ids.business);
    await db.from("user_business_link").delete().eq("business_id", ids.business);
    await db.from("business_profiles").delete().eq("id", ids.business);
    await db.from("user_profiles").delete().eq("id", ids.user);
    await db.auth.admin.deleteUser(ids.user);
  });

  await insert(db, "user_profiles", { id: ids.user, email, role: "owner" });
  await insert(db, "business_profiles", { id: ids.business, user_id: ids.user, business_name: "Synthetic Tax Membership", industry: "Consulting", state: "GA", team_size: 1, onboarding_status: "completed", bookkeeping_start_date: "2026-01-01", quickbooks_connected: true, plaid_connected: true });
  await insert(db, "user_business_link", { user_id: ids.user, business_id: ids.business, role: "owner" });
  await insert(db, "business_billing", { business_id: ids.business, subscription_status: "active", subscription_status_test: "active" });
  await insert(db, "qbo_accounts_cache", [
    { business_id: ids.business, realm_id: "synthetic-realm", qbo_env: "production", qbo_account_id: "lyft-account-a", name: "Lyft/Uber", account_type: "Expense", account_subtype: "Auto", active: true, raw: {} },
    { business_id: ids.business, realm_id: "synthetic-realm", qbo_env: "production", qbo_account_id: "gas-account-b", name: "Gas", account_type: "Expense", account_subtype: "Auto", active: true, raw: {} },
  ]);
  await insert(db, "plaid_items", { id: ids.plaidItem, business_id: ids.business, user_id: ids.user, plaid_item_id: `item-${ids.plaidItem}`, plaid_access_token: "synthetic-token", status: "connected", sync_in_progress: false, is_active: true });
  await insert(db, "plaid_accounts", { id: ids.plaidAccount, business_id: ids.business, plaid_item_id: ids.plaidItem, plaid_account_id: `account-${ids.plaidAccount}`, name: "Synthetic Card", type: "credit", subtype: "credit card", is_active: true, connected_at: "2026-01-01T00:00:00Z", relink_candidate_ids: [] });
  await insert(db, "bank_transactions", {
    id: ids.transaction, business_id: ids.business, plaid_item_id: ids.plaidItem, plaid_account_id: ids.plaidAccount, plaid_transaction_id: `synthetic-${ids.transaction}`,
    pending: false, date: "2026-10-06", name: "Synthetic QuikTrip", merchant_name: "Synthetic QuikTrip",
    amount: 6.33, signed_amount: -6.33, direction: "OUTFLOW", iso_currency_code: "USD",
    is_archived: false, accounting_review_required: false, raw: {},
  });
  await insert(db, "qbo_posted_transactions", {
    business_id: ids.business, transaction_id: ids.transaction, qbo_env: "production", realm_id: "synthetic-realm",
    qbo_txn_type: "Purchase", qbo_txn_id: "qbo-purchase-t", status: "posted", posted_at: "2026-10-06T12:00:00Z",
  });
  await insert(db, "transaction_categorizations", {
    business_id: ids.business, transaction_id: ids.transaction, status: "posted",
    final_qbo_account_id: "lyft-account-a", final_qbo_account_name: "Lyft/Uber",
    qbo_txn_id: "qbo-purchase-t", qbo_txn_type: "Purchase", txn_date: "2026-10-06",
    txn_name: "Synthetic QuikTrip", signed_amount: -6.33, meta: {},
  });
  await insert(db, "tax_profiles", {
    business_id: ids.business, tax_year: 2026, entity_type: "sole_proprietor",
    primary_tax_state: "GA", accounting_method: "cash", profile_status: "active", source: "system",
  });
  await insert(db, "transaction_tax_classifications", {
    business_id: ids.business, transaction_id: ids.transaction, tax_year: 2026, transaction_date: "2026-10-06",
    source_qbo_txn_id: "qbo-purchase-t", source_qbo_txn_type: "Purchase",
    source_qbo_account_id: "lyft-account-a", source_qbo_account_name: "Lyft/Uber",
    tax_category: "travel_transportation", deductibility_status: "needs_review", deductible_percent: 0,
    book_amount: 6.33, deductible_amount: 0, nondeductible_amount: 6.33, capitalizable_amount: 0,
    tax_treatment: {}, classification_status: "needs_review", source: "rule_engine",
    reason: "Synthetic initial Lyft/Uber review", metadata: {}, rule_code: "transportation_review_gl_v2", rule_version: "bizzi-gl-2026-v2",
  });

  const p1Payload = syntheticProjection({ ids, accountId: "lyft-account-a", accountName: "Lyft/Uber", sourceFingerprint: "1".repeat(64) });
  const p1 = await persistProjection(db, ids.business, p1Payload);
  assert.ok(p1.id);

  let result;
  try {
    result = await reclassifyBookkeepingTransaction({
    businessId: ids.business, transactionId: ids.transaction, targetQboAccountId: "gas-account-b",
    actor: ids.user, db,
    validateQboAccount: async () => ({ ok: true, account: { id: "gas-account-b", name: "Gas", type: "Expense", subType: "Auto" } }),
    getQBOClient: async () => ({
      getPurchase: (_id, cb) => cb(null, { Purchase: { Id: "qbo-purchase-t", SyncToken: "1", Line: [{ Id: "1", Amount: 6.33, DetailType: "AccountBasedExpenseLineDetail", AccountBasedExpenseLineDetail: { AccountRef: { value: "lyft-account-a", name: "Lyft/Uber" } } }] } }),
      updatePurchase: (_payload, cb) => cb(null, { Purchase: { Id: "qbo-purchase-t", SyncToken: "2" } }),
    }),
    });
  } catch (error) {
    assert.fail(`${error?.message}: ${JSON.stringify(error?.details || error?.cause || null)}`);
  }
  assert.ok(["queued", "pending"].includes(result.tax_workspace_update.status));
  const categorization = await one(db.from("transaction_categorizations").select("final_qbo_account_id,final_qbo_account_name").eq("business_id", ids.business).eq("transaction_id", ids.transaction));
  assert.deepEqual(categorization, { final_qbo_account_id: "gas-account-b", final_qbo_account_name: "Gas" });
  const outbox = await rows(db.from("tax_bookkeeping_change_outbox").select("*").eq("business_id", ids.business).eq("transaction_id", ids.transaction));
  assert.equal(outbox.length, 1, "the PostgreSQL trigger must create exactly one durable event");
  assert.equal(outbox[0].tax_year, 2026);
  assert.match(outbox[0].event_key, new RegExp(`^bookkeeping-tax:${ids.business}:${ids.transaction}:`));

  let synchronizationError = null;
  await processTaxBookkeepingChangeOutbox({
    supabase: db,
    workerId: "integration-outbox",
    synchronize: async (args) => {
      try { return await synchronizeTaxDataChange(args); }
      catch (error) { synchronizationError = error; throw error; }
    },
  });
  const replayed = await one(db.from("tax_bookkeeping_change_outbox").select("status,attempt_count,last_error_code").eq("id", outbox[0].id));
  assert.equal(replayed.status, "completed", synchronizationError?.message || replayed.last_error_code || "outbox row did not complete");
  const sourceSnapshot = await getTaxClassificationSourceSnapshot({ supabase: db, businessId: ids.business, taxYear: 2026 });
  assert.deepEqual(sourceSnapshot.transactionIds, [ids.transaction], JSON.stringify(sourceSnapshot));
  const runItemsBeforeWorker = await rows(db.from("tax_classification_run_items").select("stable_transaction_id,source_fingerprint,lifecycle_state").eq("business_id", ids.business));
  assert.equal(runItemsBeforeWorker.length, 1, JSON.stringify(runItemsBeforeWorker));
  assert.equal(runItemsBeforeWorker[0].lifecycle_state, "queued", JSON.stringify(runItemsBeforeWorker));
  assert.equal(runItemsBeforeWorker[0].source_fingerprint, sourceSnapshot.rows[0].sourceFingerprint, JSON.stringify({ runItemsBeforeWorker, sourceFingerprint: sourceSnapshot.rows[0].sourceFingerprint }));
  const classificationRunResult = await processPendingTaxClassificationRuns({ supabase: db, workerId: "integration-classification", runBatchSize: 5, transactionBatchSize: 50 });
  assert.equal(classificationRunResult.failed, 0, JSON.stringify(classificationRunResult));
  assert.equal(classificationRunResult.completed + classificationRunResult.reviewRequired, 1, JSON.stringify(classificationRunResult));
  const runItemsAfterWorker = await rows(db.from("tax_classification_run_items").select("stable_transaction_id,source_fingerprint,lifecycle_state,safe_reason_code").eq("business_id", ids.business));
  const sourceSnapshotAfterWorker = await getTaxClassificationSourceSnapshot({ supabase: db, businessId: ids.business, taxYear: 2026 });
  assert.equal(runItemsAfterWorker[0].lifecycle_state, "completed", JSON.stringify({ runItemsAfterWorker, sourceFingerprintBefore: sourceSnapshot.rows[0].sourceFingerprint, sourceFingerprintAfter: sourceSnapshotAfterWorker.rows[0]?.sourceFingerprint }));
  const classification = await one(db.from("transaction_tax_classifications").select("source_qbo_account_id,source_qbo_account_name,tax_category,classification_status").eq("business_id", ids.business).eq("transaction_id", ids.transaction).eq("tax_year", 2026));
  assert.equal(classification.source_qbo_account_id, "gas-account-b");
  assert.equal(classification.source_qbo_account_name, "Gas");
  assert.equal(classification.tax_category, "vehicle_expense");
  await processTaxWorkspaceProjectionRequests({ supabase: db, workerId: "integration-workspace", batchSize: 5 });
  const p2 = await getLatestTaxWorkspaceProjection({ supabase: db, businessId: ids.business, taxYear: 2026 });
  assert.notEqual(p2.id, p1.id);
  assert.equal(p2.formula_version, TAX_WORKSPACE_FORMULA_VERSION);
  assert.equal(p2.projection_data.formulaVersion, TAX_WORKSPACE_FORMULA_VERSION);
  assert.deepEqual(p1.projection_data.identityEvidence.questionGroups[p1Payload.questionGroups[0].id], [ids.transaction]);
  const memberships = p2.projection_data.identityEvidence.questionGroups || {};
  const gasGroups = p2.projection_data.questionGroups.filter((group) => group.qboAccountId === "gas-account-b");
  const lyftGroups = p2.projection_data.questionGroups.filter((group) => group.qboAccountId === "lyft-account-a");
  assert.equal(lyftGroups.length, 0);
  assert.equal(gasGroups.length, 1, JSON.stringify(p2.projection_data));
  assert.deepEqual(memberships[gasGroups[0].id], [ids.transaction]);
  assert.equal(new Set(Object.values(memberships).flat()).size, 1);

  await processTaxBookkeepingChangeOutbox({ supabase: db, workerId: "integration-outbox-replay" });
  await processPendingTaxClassificationRuns({ supabase: db, workerId: "integration-classification-replay", runBatchSize: 5, transactionBatchSize: 50 });
  await processTaxWorkspaceProjectionRequests({ supabase: db, workerId: "integration-workspace-replay", batchSize: 5 });
  const projections = await rows(db.from("tax_workspace_projections").select("id,source_fingerprint").eq("business_id", ids.business).eq("tax_year", 2026));
  assert.equal(projections.filter((row) => row.source_fingerprint === p2.source_fingerprint).length, 1);
});

test("authenticated Tax Refresh recovers a historical Gas reclassification without an outbox row", { skip: !enabled }, async (t) => {
  assert.match(String(url), /^http:\/\/(127\.0\.0\.1|localhost):\d+$/);
  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const ids = { user: randomUUID(), business: randomUUID(), transaction: randomUUID(), plaidItem: randomUUID(), plaidAccount: randomUUID() };
  const email = `tax-refresh-${ids.business}@example.test`;
  const created = await db.auth.admin.createUser({ email, password: `T!${randomUUID()}a9`, email_confirm: true });
  if (created.error) throw created.error;
  ids.user = created.data.user.id;
  t.after(() => cleanupFixture(db, ids));

  await insert(db, "user_profiles", { id: ids.user, email, role: "owner" });
  await insert(db, "business_profiles", { id: ids.business, user_id: ids.user, business_name: "Historical Refresh", industry: "Consulting", state: "GA", team_size: 1, onboarding_status: "completed", bookkeeping_start_date: "2026-01-01", quickbooks_connected: true, plaid_connected: true });
  await insert(db, "user_business_link", { user_id: ids.user, business_id: ids.business, role: "owner" });
  await insert(db, "business_billing", { business_id: ids.business, subscription_status: "active", subscription_status_test: "active" });
  await insert(db, "qbo_accounts_cache", [
    { business_id: ids.business, realm_id: "historical-realm", qbo_env: "production", qbo_account_id: "lyft-account-a", name: "Lyft/Uber", account_type: "Expense", account_subtype: "Auto", active: true, raw: {} },
    { business_id: ids.business, realm_id: "historical-realm", qbo_env: "production", qbo_account_id: "gas-account-b", name: "Gas", account_type: "Expense", account_subtype: "Auto", active: true, raw: {} },
  ]);
  await insert(db, "plaid_items", { id: ids.plaidItem, business_id: ids.business, user_id: ids.user, plaid_item_id: `item-${ids.plaidItem}`, plaid_access_token: "synthetic-token", status: "connected", sync_in_progress: false, is_active: true });
  await insert(db, "plaid_accounts", { id: ids.plaidAccount, business_id: ids.business, plaid_item_id: ids.plaidItem, plaid_account_id: `account-${ids.plaidAccount}`, name: "Synthetic Card", type: "credit", subtype: "credit card", is_active: true, connected_at: "2026-01-01T00:00:00Z", relink_candidate_ids: [] });
  await insert(db, "bank_transactions", { id: ids.transaction, business_id: ids.business, plaid_item_id: ids.plaidItem, plaid_account_id: ids.plaidAccount, plaid_transaction_id: `historical-${ids.transaction}`, pending: false, date: "2026-10-06", name: "Historical QuikTrip", merchant_name: "Historical QuikTrip", amount: 6.33, signed_amount: -6.33, direction: "OUTFLOW", iso_currency_code: "USD", is_archived: false, accounting_review_required: false, raw: {} });
  await insert(db, "qbo_posted_transactions", { business_id: ids.business, transaction_id: ids.transaction, qbo_env: "production", realm_id: "historical-realm", qbo_txn_type: "Purchase", qbo_txn_id: "historical-qbo-t", status: "posted", posted_at: "2026-10-06T12:00:00Z" });
  await insert(db, "transaction_categorizations", { business_id: ids.business, transaction_id: ids.transaction, status: "posted", final_qbo_account_id: "gas-account-b", final_qbo_account_name: "Gas", qbo_txn_id: "historical-qbo-t", qbo_txn_type: "Purchase", txn_date: "2026-10-06", txn_name: "Historical QuikTrip", signed_amount: -6.33, meta: {} });
  await insert(db, "tax_profiles", { business_id: ids.business, tax_year: 2026, entity_type: "sole_proprietor", primary_tax_state: "GA", accounting_method: "cash", profile_status: "active", source: "system" });
  const historicalLyftFingerprint = computeTaxTransactionFingerprint({
    transactionId: ids.transaction,
    transactionDate: "2026-10-06",
    signedAmount: -6.33,
    direction: "OUTFLOW",
    qboTxnId: "historical-qbo-t",
    qboTxnType: "Purchase",
    qboAccountId: "lyft-account-a",
    qboAccountName: "Lyft/Uber",
    bookkeepingCategory: "Lyft/Uber",
  });
  await insert(db, "transaction_tax_classifications", { business_id: ids.business, transaction_id: ids.transaction, tax_year: 2026, transaction_date: "2026-10-06", source_qbo_txn_id: "historical-qbo-t", source_qbo_txn_type: "Purchase", source_qbo_account_id: "lyft-account-a", source_qbo_account_name: "Lyft/Uber", tax_category: "travel_transportation", deductibility_status: "needs_review", deductible_percent: 0, book_amount: 6.33, deductible_amount: 0, nondeductible_amount: 6.33, capitalizable_amount: 0, tax_treatment: {}, classification_status: "needs_review", source: "rule_engine", reason: "Pre-outbox stale classification", metadata: { transaction_source_fingerprint: historicalLyftFingerprint }, rule_code: "transportation_review_gl_v2", rule_version: "bizzi-gl-2026-v2" });
  const p1 = await persistProjection(db, ids.business, syntheticProjection({ ids, accountId: "lyft-account-a", accountName: "Lyft/Uber", sourceFingerprint: "2".repeat(64) }));
  assert.equal((await rows(db.from("tax_bookkeeping_change_outbox").select("id").eq("business_id", ids.business))).length, 0);

  const http = await startTaxWorkspaceHttp({ db, userId: ids.user });
  t.after(() => http.close());
  const refreshUrl = `${http.origin}/api/tax/workspace/refresh?businessId=${ids.business}`;
  const refreshResponses = await Promise.all([postJson(refreshUrl, { businessId: ids.business, year: 2026 }), postJson(refreshUrl, { businessId: ids.business, year: 2026 })]);
  refreshResponses.forEach(({ response, body }) => { assert.equal(response.status, 200); assert.equal(body.data.status, "queued"); assert.match(body.data.sourceRevision, /^sha256:/); });
  const runs = await rows(db.from("tax_classification_runs").select("id,status,metadata").eq("business_id", ids.business).eq("tax_year", 2026));
  assert.equal(runs.length, 1);
  assert.equal((await rows(db.from("tax_workspace_projection_requests").select("id").eq("business_id", ids.business))).length, 0, "workspace publication must wait for classification");

  const classified = await processPendingTaxClassificationRuns({ supabase: db, workerId: "historical-refresh-classification", runBatchSize: 5, transactionBatchSize: 50 });
  assert.equal(classified.failed, 0, JSON.stringify(classified));
  const classification = await one(db.from("transaction_tax_classifications").select("source_qbo_account_id,source_qbo_account_name,tax_category").eq("business_id", ids.business).eq("transaction_id", ids.transaction).eq("tax_year", 2026));
  assert.deepEqual(classification, { source_qbo_account_id: "gas-account-b", source_qbo_account_name: "Gas", tax_category: "vehicle_expense" });
  await processTaxWorkspaceProjectionRequests({ supabase: db, workerId: "historical-refresh-workspace", batchSize: 5 });
  const p2 = await getLatestTaxWorkspaceProjection({ supabase: db, businessId: ids.business, taxYear: 2026 });
  assert.notEqual(p2.id, p1.id);
  const gasGroup = p2.projection_data.questionGroups.find((group) => group.qboAccountId === "gas-account-b");
  assert.ok(gasGroup);
  assert.equal(p2.projection_data.questionGroups.some((group) => group.qboAccountId === "lyft-account-a"), false);
  assert.deepEqual(p2.projection_data.identityEvidence.questionGroups[gasGroup.id], [ids.transaction]);
  assert.equal(p2.projection_data.evaluatedTransactionCount, 1);
  assert.deepEqual(p1.projection_data.identityEvidence.questionGroups["business_use:lyft-account-a"], [ids.transaction]);

  const workspace = await getJson(`${http.origin}/api/tax/workspace?businessId=${ids.business}&year=2026&projectionVersion=tax-workspace-v2`);
  assert.equal(workspace.response.status, 200);
  assert.equal(workspace.body.data.projectionId, p2.id);
  const matrixRow = p2.projection_data.matrix.find((row) => row.identityManifest?.includes(ids.transaction));
  const month = Object.entries(matrixRow.months).find(([, value]) => value.identityManifest?.includes(ids.transaction))?.[0];
  const detailParams = new URLSearchParams({ businessId: ids.business, year: "2026", projectionVersion: "tax-workspace-v2", projectionId: p2.id, categoryKey: matrixRow.categoryKey, month, authority: "needs_input" });
  const p2Detail = await getJson(`${http.origin}/api/tax/workspace/matrix-cell?${detailParams}`);
  assert.equal(p2Detail.response.status, 200);
  detailParams.set("projectionId", p1.id);
  const p1Detail = await getJson(`${http.origin}/api/tax/workspace/matrix-cell?${detailParams}`);
  assert.equal(p1Detail.response.status, 409);
});

async function insert(db, table, value) { const { error } = await db.from(table).insert(value); if (error) throw error; }
async function rows(query) { const { data, error } = await query; if (error) throw error; return data || []; }
async function one(query) { const { data, error } = await query.single(); if (error) throw error; return data; }

async function cleanupFixture(db, ids) {
  await db.from("tax_workspace_projection_requests").delete().eq("business_id", ids.business);
  await db.from("tax_workspace_projections").delete().eq("business_id", ids.business);
  await db.from("tax_bookkeeping_change_outbox").delete().eq("business_id", ids.business);
  await db.from("tax_classification_run_items").delete().eq("business_id", ids.business);
  await db.from("tax_classification_runs").delete().eq("business_id", ids.business);
  await db.from("transaction_tax_classifications").delete().eq("business_id", ids.business);
  await db.from("tax_profiles").delete().eq("business_id", ids.business);
  await db.from("qbo_posted_transactions").delete().eq("business_id", ids.business);
  await db.from("transaction_categorizations").delete().eq("business_id", ids.business);
  await db.from("qbo_accounts_cache").delete().eq("business_id", ids.business);
  await db.from("bank_transactions").delete().eq("business_id", ids.business);
  await db.from("plaid_accounts").delete().eq("business_id", ids.business);
  await db.from("plaid_items").delete().eq("business_id", ids.business);
  await db.from("business_billing").delete().eq("business_id", ids.business);
  await db.from("user_business_link").delete().eq("business_id", ids.business);
  await db.from("business_profiles").delete().eq("id", ids.business);
  await db.from("user_profiles").delete().eq("id", ids.user);
  await db.auth.admin.deleteUser(ids.user);
}

async function startTaxWorkspaceHttp({ db, userId }) {
  const app = express();
  app.locals.supabase = db;
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: userId }; next(); });
  app.use("/api/tax", taxWorkspaceRouter);
  const server = await new Promise((resolve) => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
  const address = server.address();
  return { origin: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function postJson(url, body) { const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { response, body: await response.json() }; }
async function getJson(url) { const response = await fetch(url); return { response, body: await response.json() }; }

async function persistProjection(db, businessId, payload) {
  const { data, error } = await db.rpc("persist_tax_workspace_projection", {
    p_business_id: businessId, p_tax_year: 2026, p_projection_version: "tax-workspace-v2",
    p_formula_version: payload.formulaVersion, p_source_fingerprint: payload.sourceFingerprint,
    p_completeness: "complete", p_payload: payload, p_generated_at: payload.generatedAt,
  });
  if (error) throw error;
  return data;
}

function syntheticProjection({ ids, accountId, accountName, sourceFingerprint }) {
  const questionId = `business_use:${accountId}`;
  const generatedAt = "2026-11-01T12:00:00.000Z";
  return {
    canonicalBusinessId: ids.business, taxYear: 2026, projectionVersion: "tax-workspace-v2",
    formulaVersion: TAX_WORKSPACE_FORMULA_VERSION, sourceFingerprint, status: "complete", completeness: "complete", generatedAt,
    matrix: [], questionGroups: [{ id: questionId, decisionType: "business_use", qboAccountId: accountId, qboAccountName: accountName, transactionCount: 1, actionableTransactionCount: 1, state: "needs_input" }],
    identityEvidence: { evaluated: [ids.transaction], matrixIncluded: [ids.transaction], outsideDeductions: [], treatments: { estimated: [], reviewed: [], needs_input: [ids.transaction] }, categories: { [accountId]: [ids.transaction] }, months: { "2026-10": [ids.transaction] }, questionGroups: { [questionId]: [ids.transaction] } },
  };
}
