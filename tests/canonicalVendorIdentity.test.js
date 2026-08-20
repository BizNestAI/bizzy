import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalizeVendorDisplayName,
  classifyQboVendorProviderError,
  createQboVendorForCanonicalReview,
  ensureCanonicalVendorMappedToQbo,
  getVendorAutoCreateBlockReason,
  getVendorPostingRequirement,
  markCanonicalVendorNotRequiredForTransaction,
  resolveCanonicalVendorForTransaction,
  useExistingQboVendorForCanonical,
} from "../src/services/bookkeeping/canonicalVendorService.js";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_BUSINESS_ID = "22222222-2222-4222-8222-222222222222";
const REALM_ID = "realm-1";

test("same merchant_entity_id across multiple transactions resolves to one canonical vendor", async () => {
  const db = makeDb();
  const first = await resolveCanonicalVendorForTransaction({ db, businessId: BUSINESS_ID, bankTxn: txn({ id: "t1", merchant_entity_id: "ent-apple", merchant_name: "APPLE.COM/BILL" }) });
  const second = await resolveCanonicalVendorForTransaction({ db, businessId: BUSINESS_ID, bankTxn: txn({ id: "t2", merchant_entity_id: "ent-apple", merchant_name: "Apple" }) });
  assert.equal(first.canonicalVendor.id, second.canonicalVendor.id);
  assert.equal(db.rows.bizzi_vendors.length, 1);
});

test("two workers with same merchant_entity_id and same display name create one canonical vendor", async () => {
  const db = makeDb();
  const [first, second] = await Promise.all([
    resolveCanonicalVendorForTransaction({ db, businessId: BUSINESS_ID, bankTxn: txn({ id: "t1", merchant_entity_id: "ent-home-depot", merchant_name: "The Home Depot" }) }),
    resolveCanonicalVendorForTransaction({ db, businessId: BUSINESS_ID, bankTxn: txn({ id: "t2", merchant_entity_id: "ent-home-depot", merchant_name: "The Home Depot" }) }),
  ]);
  assert.equal(first.canonicalVendor.id, second.canonicalVendor.id);
  assert.equal(activeVendors(db).length, 1);
  assert.equal(db.rows.vendor_aliases.filter((row) => row.alias_type === "plaid_merchant_entity_id").length, 1);
});

test("two workers with same merchant_entity_id and different display names reuse the winning canonical vendor", async () => {
  const db = makeDb();
  const [first, second] = await Promise.all([
    resolveCanonicalVendorForTransaction({ db, businessId: BUSINESS_ID, bankTxn: txn({ id: "t1", merchant_entity_id: "ent-home-depot", merchant_name: "THE HOME DEPOT" }) }),
    resolveCanonicalVendorForTransaction({ db, businessId: BUSINESS_ID, bankTxn: txn({ id: "t2", merchant_entity_id: "ent-home-depot", merchant_name: "HOME DEPOT #1234" }) }),
  ]);
  assert.equal(first.canonicalVendor.id, second.canonicalVendor.id);
  assert.equal(activeVendors(db).length, 1);
  assert.equal(db.rows.bizzi_vendors.length, 1);
});

test("three concurrent workers with same merchant_entity_id leave no orphan canonical vendor", async () => {
  const db = makeDb();
  const results = await Promise.all([
    resolveCanonicalVendorForTransaction({ db, businessId: BUSINESS_ID, bankTxn: txn({ id: "t1", merchant_entity_id: "ent-concurrent", merchant_name: "Vendor One" }) }),
    resolveCanonicalVendorForTransaction({ db, businessId: BUSINESS_ID, bankTxn: txn({ id: "t2", merchant_entity_id: "ent-concurrent", merchant_name: "Vendor One Store 42" }) }),
    resolveCanonicalVendorForTransaction({ db, businessId: BUSINESS_ID, bankTxn: txn({ id: "t3", merchant_entity_id: "ent-concurrent", merchant_name: "VENDOR ONE" }) }),
  ]);
  assert.equal(new Set(results.map((result) => result.canonicalVendor.id)).size, 1);
  assert.equal(activeVendors(db).length, 1);
  assert.equal(db.rows.bizzi_vendors.length, 1);
});

test("same vendor across Plaid accounts maps to one canonical vendor when provider identity is stable", async () => {
  const db = makeDb();
  const first = await resolveCanonicalVendorForTransaction({ db, businessId: BUSINESS_ID, bankTxn: txn({ id: "t1", plaid_account_id: "acct-a", merchant_entity_id: "ent-duke", merchant_name: "DUKEENERGY" }) });
  const second = await resolveCanonicalVendorForTransaction({ db, businessId: BUSINESS_ID, bankTxn: txn({ id: "t2", plaid_account_id: "acct-b", merchant_entity_id: "ent-duke", merchant_name: "Duke Energy" }) });
  assert.equal(first.canonicalVendor.id, second.canonicalVendor.id);
});

test("Apple, Amazon, and Duke display variants canonicalize to stable names when evidence supports creation", () => {
  assert.equal(canonicalizeVendorDisplayName("APPLE.COM/BILL"), "Apple");
  assert.equal(canonicalizeVendorDisplayName("AMZN Mktp"), "Amazon");
  assert.equal(canonicalizeVendorDisplayName("DUKEENERGY"), "Duke Energy");
});

test("weak memo similarity does not silently merge or create canonical vendors", async () => {
  const db = makeDb();
  const a = await resolveCanonicalVendorForTransaction({ db, businessId: BUSINESS_ID, bankTxn: txn({ id: "t1", merchant_entity_id: null, merchant_name: null, name: "ACH WEBFLOW PAYMENT" }) });
  const b = await resolveCanonicalVendorForTransaction({ db, businessId: BUSINESS_ID, bankTxn: txn({ id: "t2", merchant_entity_id: null, merchant_name: null, name: "ACH WEBSTER PAYMENT" }) });
  assert.equal(a.needsReview, true);
  assert.equal(b.needsReview, true);
  assert.equal(db.rows.bizzi_vendors.length, 0);
  assert.equal(db.calls.strongAliasClaims, 0);
});

test("different merchant_entity_id values with similar names remain separate", async () => {
  const db = makeDb();
  const first = await resolveCanonicalVendorForTransaction({ db, businessId: BUSINESS_ID, bankTxn: txn({ id: "t1", merchant_entity_id: "ent-home-depot-retail", merchant_name: "Home Depot" }) });
  const second = await resolveCanonicalVendorForTransaction({ db, businessId: BUSINESS_ID, bankTxn: txn({ id: "t2", merchant_entity_id: "ent-home-depot-pro", merchant_name: "Home Depot Pro" }) });
  assert.notEqual(first.canonicalVendor.id, second.canonicalVendor.id);
  assert.equal(activeVendors(db).length, 2);
});

test("exact existing QBO Vendor is reused instead of creating", async () => {
  const db = makeDb();
  const qbo = makeQbo({ vendors: [{ Id: "v-apple", DisplayName: "Apple", Active: true }] });
  const result = await ensureCanonicalVendorMappedToQbo({
    db,
    getQBOClientFn: async () => qbo,
    getLatestQuickBooksTokenRowFn: async () => ({ realm_id: REALM_ID, qbo_env: "production" }),
    businessId: BUSINESS_ID,
    bankTxn: txn({ merchant_entity_id: "ent-apple", merchant_name: "APPLE.COM/BILL" }),
  });
  assert.equal(result.created, false);
  assert.equal(result.qbo_entity_id, "v-apple");
  assert.equal(qbo.created.length, 0);
});

test("stale or deleted canonical QBO mapping requires review instead of trusting local entity id", async () => {
  const db = makeDb();
  const canonical = await resolveCanonicalVendorForTransaction({ db, businessId: BUSINESS_ID, bankTxn: txn({ id: "t-map", merchant_entity_id: "ent-stale", merchant_name: "Stale Vendor" }) });
  db.rows.business_qbo_vendor_mappings.push({
    id: "map-1",
    business_id: BUSINESS_ID,
    realm_id: REALM_ID,
    qbo_env: "production",
    canonical_vendor_id: canonical.canonicalVendor.id,
    qbo_vendor_id: "v-deleted",
    qbo_display_name: "Stale Vendor",
    status: "active",
    mapping_source: "creation_intent",
  });
  const qbo = makeQbo();
  const result = await ensureCanonicalVendorMappedToQbo({
    db,
    getQBOClientFn: async () => qbo,
    getLatestQuickBooksTokenRowFn: async () => ({ realm_id: REALM_ID, qbo_env: "production" }),
    businessId: BUSINESS_ID,
    bankTxn: txn({
      id: "t-stale",
      merchant_entity_id: "ent-stale",
      merchant_name: "Stale Vendor",
      qbo_entity_type: "vendor",
      qbo_entity_id: "v-local-stale",
    }),
  });
  assert.equal(result.needsReview, true);
  assert.equal(result.reason, "vendor_mapping_invalid");
  assert.equal(qbo.created.length, 0);
  assert.equal(db.rows.business_qbo_vendor_mappings[0].status, "needs_review");
});

test("recent active QBO Vendor mapping uses fast path without full entity refresh", async () => {
  const db = makeDb();
  const canonical = await resolveCanonicalVendorForTransaction({ db, businessId: BUSINESS_ID, bankTxn: txn({ id: "t-fast-1", merchant_entity_id: "ent-fast", merchant_name: "Fast Vendor" }) });
  db.rows.business_qbo_vendor_mappings.push({
    id: "map-fast",
    business_id: BUSINESS_ID,
    realm_id: REALM_ID,
    qbo_env: "production",
    canonical_vendor_id: canonical.canonicalVendor.id,
    qbo_vendor_id: "v-fast",
    qbo_display_name: "Fast Vendor",
    status: "active",
    mapping_source: "resolver",
    last_validated_at: new Date().toISOString(),
  });
  const qbo = makeQbo({ vendors: [] });
  const result = await ensureCanonicalVendorMappedToQbo({
    db,
    getQBOClientFn: async () => qbo,
    getLatestQuickBooksTokenRowFn: async () => ({ realm_id: REALM_ID, qbo_env: "production" }),
    businessId: BUSINESS_ID,
    bankTxn: txn({ id: "t-fast-2", merchant_entity_id: "ent-fast", merchant_name: "Fast Vendor" }),
  });

  assert.equal(result.reason, "canonical_mapping_recent");
  assert.equal(result.vendor_validation_mode, "cache_hit");
  assert.equal(result.qbo_entity_id, "v-fast");
  assert.equal(qbo.calls.findVendors, 0);
  assert.equal(qbo.calls.findCustomers, 0);
  assert.equal(qbo.calls.findEmployees, 0);
});

test("stale active QBO Vendor mapping still performs full validation", async () => {
  const db = makeDb();
  const canonical = await resolveCanonicalVendorForTransaction({ db, businessId: BUSINESS_ID, bankTxn: txn({ id: "t-stale-fast-1", merchant_entity_id: "ent-stale-fast", merchant_name: "Stale Fast Vendor" }) });
  db.rows.business_qbo_vendor_mappings.push({
    id: "map-stale-fast",
    business_id: BUSINESS_ID,
    realm_id: REALM_ID,
    qbo_env: "production",
    canonical_vendor_id: canonical.canonicalVendor.id,
    qbo_vendor_id: "v-stale-fast",
    qbo_display_name: "Stale Fast Vendor",
    status: "active",
    mapping_source: "resolver",
    last_validated_at: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
  });
  const qbo = makeQbo({ vendors: [{ Id: "v-stale-fast", DisplayName: "Stale Fast Vendor", Active: true }] });
  const result = await ensureCanonicalVendorMappedToQbo({
    db,
    getQBOClientFn: async () => qbo,
    getLatestQuickBooksTokenRowFn: async () => ({ realm_id: REALM_ID, qbo_env: "production" }),
    businessId: BUSINESS_ID,
    bankTxn: txn({ id: "t-stale-fast-2", merchant_entity_id: "ent-stale-fast", merchant_name: "Stale Fast Vendor" }),
  });

  assert.equal(result.reason, "canonical_mapping");
  assert.equal(result.vendor_validation_mode, "fresh_validation");
  assert.equal(qbo.calls.findVendors, 2);
  assert.equal(qbo.calls.findCustomers, 1);
  assert.equal(qbo.calls.findEmployees, 1);
  assert.ok(Date.now() - Date.parse(db.rows.business_qbo_vendor_mappings[0].last_validated_at) < 60_000);
});

test("temporary QBO vendor lookup failure returns safely without creating a duplicate vendor", async () => {
  const db = makeDb();
  const qbo = makeQbo({ failFindVendors: true });
  await assert.rejects(
    async () => ensureCanonicalVendorMappedToQbo({
      db,
      getQBOClientFn: async () => qbo,
      getLatestQuickBooksTokenRowFn: async () => ({ realm_id: REALM_ID, qbo_env: "production" }),
      businessId: BUSINESS_ID,
      bankTxn: txn({ merchant_entity_id: "ent-lookup", merchant_name: "Lookup Vendor" }),
    }),
    (err) => {
      assert.equal(err.message, "vendor_qbo_lookup_failed");
      assert.equal(err.vendorDiagnostics.stage, "qbo_vendor_lookup");
      assert.equal(err.vendorDiagnostics.retryable, true);
      return true;
    }
  );
  assert.equal(qbo.created.length, 0);
});

test("Instantly vendor gate classifies QBO auth failures without provider create", async () => {
  const db = makeDb();
  await assert.rejects(
    async () => ensureCanonicalVendorMappedToQbo({
      db,
      getQBOClientFn: async () => {
        const err = new Error("quickbooks_needs_reconnect");
        err.status = 401;
        throw err;
      },
      getLatestQuickBooksTokenRowFn: async () => ({ realm_id: REALM_ID, qbo_env: "production" }),
      businessId: BUSINESS_ID,
      bankTxn: txn({ id: "t-instantly-auth", merchant_entity_id: "ent-instantly", merchant_name: "INSTANTLY" }),
    }),
    (err) => {
      assert.equal(err.message, "vendor_qbo_auth_required");
      assert.equal(err.vendorDiagnostics.stage, "qbo_client_acquisition");
      assert.equal(err.vendorDiagnostics.reconnect_required, true);
      return true;
    }
  );
});

test("Vendor provider diagnostics keep safe metadata only", () => {
  const err = Object.assign(new Error("Duplicate Name Exists Error"), {
    status: 400,
    Fault: { Error: [{ code: "6240", Message: "Duplicate Name Exists Error" }] },
    access_token: "should-not-be-copied",
    refresh_token: "should-not-be-copied",
  });
  const diagnostics = classifyQboVendorProviderError(err, "qbo_vendor_create");
  assert.deepEqual(Object.keys(diagnostics).sort(), [
    "code",
    "http_status",
    "message",
    "provider_code",
    "reconnect_required",
    "retryable",
    "stage",
  ]);
  assert.equal(diagnostics.code, "vendor_qbo_name_conflict");
  assert.equal(diagnostics.provider_code, "6240");
  assert.equal(JSON.stringify(diagnostics).includes("should-not-be-copied"), false);
});

test("Instantly exact existing Vendor is mapped and no new Vendor is created", async () => {
  const db = makeDb();
  const qbo = makeQbo({ vendors: [{ Id: "v-instantly", DisplayName: "Instantly", Active: true }] });
  const result = await ensureCanonicalVendorMappedToQbo({
    db,
    getQBOClientFn: async () => qbo,
    getLatestQuickBooksTokenRowFn: async () => ({ realm_id: REALM_ID, qbo_env: "production" }),
    businessId: BUSINESS_ID,
    bankTxn: txn({ id: "t-instantly-existing", merchant_entity_id: "ent-instantly", merchant_name: "INSTANTLY" }),
  });
  assert.equal(result.reason, "existing_qbo_vendor_reused");
  assert.equal(result.qbo_entity_id, "v-instantly");
  assert.equal(qbo.created.length, 0);
  assert.equal(db.calls.activeMappingUpserts, 1);
  assert.equal(db.rows.business_qbo_vendor_mappings.length, 1);
  assert.equal(db.rows.business_qbo_vendor_mappings[0].status, "active");
});

test("Instantly missing Vendor creates exactly once and maps the first transaction", async () => {
  const db = makeDb();
  const qbo = makeQbo();
  const common = {
    db,
    getQBOClientFn: async () => qbo,
    getLatestQuickBooksTokenRowFn: async () => ({ realm_id: REALM_ID, qbo_env: "production" }),
    businessId: BUSINESS_ID,
  };
  const first = await ensureCanonicalVendorMappedToQbo({ ...common, bankTxn: txn({ id: "t-instantly-create", merchant_entity_id: "ent-instantly-create", merchant_name: "INSTANTLY" }) });
  const second = await ensureCanonicalVendorMappedToQbo({ ...common, bankTxn: txn({ id: "t-instantly-create-2", merchant_entity_id: "ent-instantly-create", merchant_name: "INSTANTLY" }) });
  assert.equal(first.reason, "qbo_vendor_created");
  assert.equal(second.qbo_entity_id, first.qbo_entity_id);
  assert.equal(qbo.created.length, 1);
  assert.equal(db.calls.activeMappingUpserts, 1);
});

test("Instantly Vendor create conflict is classified for review and does not map a Vendor", async () => {
  const db = makeDb();
  const qbo = makeQbo({ failCreateWith: Object.assign(new Error("Duplicate Name Exists Error"), { status: 400, Fault: { Error: [{ code: "6240", Message: "Duplicate Name Exists Error" }] } }) });
  const result = await ensureCanonicalVendorMappedToQbo({
    db,
    getQBOClientFn: async () => qbo,
    getLatestQuickBooksTokenRowFn: async () => ({ realm_id: REALM_ID, qbo_env: "production" }),
    businessId: BUSINESS_ID,
    bankTxn: txn({ id: "t-instantly-conflict", merchant_entity_id: "ent-instantly-conflict", merchant_name: "INSTANTLY" }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.needsReview, true);
  assert.equal(result.reason, "vendor_qbo_name_conflict");
  assert.equal(result.vendorDiagnostics.stage, "qbo_vendor_create");
  assert.equal(db.rows.business_qbo_vendor_mappings.length, 0);
});

test("active QBO Vendor mapping RPC inserts, updates, and preserves inactive history", async () => {
  const db = makeDb();
  const canonical = await resolveCanonicalVendorForTransaction({ db, businessId: BUSINESS_ID, bankTxn: txn({ id: "t-map-rpc", merchant_entity_id: "ent-map-rpc", merchant_name: "Map Rpc" }) });
  db.rows.business_qbo_vendor_mappings.push({
    id: "inactive-map",
    business_id: BUSINESS_ID,
    realm_id: REALM_ID,
    qbo_env: "production",
    canonical_vendor_id: canonical.canonicalVendor.id,
    qbo_vendor_id: "v-old",
    qbo_display_name: "Old Vendor",
    status: "disabled",
    mapping_source: "manual",
  });

  const first = await db.rpc("upsert_active_qbo_vendor_mapping", {
    p_business_id: BUSINESS_ID,
    p_realm_id: REALM_ID,
    p_qbo_env: "production",
    p_canonical_vendor_id: canonical.canonicalVendor.id,
    p_qbo_vendor_id: "v-new",
    p_qbo_display_name: "New Vendor",
    p_mapping_source: "resolver",
  });
  assert.ifError(first.error);
  assert.equal(first.data.qbo_vendor_id, "v-new");
  assert.equal(db.rows.business_qbo_vendor_mappings.filter((row) => row.status === "disabled").length, 1);
  assert.equal(db.rows.business_qbo_vendor_mappings.filter((row) => row.status === "active").length, 1);

  const second = await db.rpc("upsert_active_qbo_vendor_mapping", {
    p_business_id: BUSINESS_ID,
    p_realm_id: REALM_ID,
    p_qbo_env: "production",
    p_canonical_vendor_id: canonical.canonicalVendor.id,
    p_qbo_vendor_id: "v-updated",
    p_qbo_display_name: "Updated Vendor",
    p_mapping_source: "creation_intent",
    p_first_transaction_id: "t-second",
  });
  assert.ifError(second.error);
  assert.equal(second.data.id, first.data.id);
  assert.equal(second.data.qbo_vendor_id, "v-updated");
  assert.equal(db.rows.business_qbo_vendor_mappings.filter((row) => row.status === "active").length, 1);
});

test("active QBO Vendor mapping RPC rejects cross-business canonical vendor ownership", async () => {
  const db = makeDb();
  const other = await resolveCanonicalVendorForTransaction({
    db,
    businessId: OTHER_BUSINESS_ID,
    bankTxn: txn({ id: "other-map-rpc", business_id: OTHER_BUSINESS_ID, merchant_entity_id: "other-map-rpc", merchant_name: "Other Vendor" }),
  });
  const result = await db.rpc("upsert_active_qbo_vendor_mapping", {
    p_business_id: BUSINESS_ID,
    p_realm_id: REALM_ID,
    p_qbo_env: "production",
    p_canonical_vendor_id: other.canonicalVendor.id,
    p_qbo_vendor_id: "v-other",
    p_qbo_display_name: "Other Vendor",
    p_mapping_source: "resolver",
  });
  assert.equal(result.error?.message, "canonical_vendor_not_found");
  assert.equal(db.rows.business_qbo_vendor_mappings.length, 0);
});

test("Vendor mapping DB failure is classified before QBO transaction create can run", async () => {
  const db = makeDb({ failActiveMappingUpsert: Object.assign(new Error("there is no unique or exclusion constraint matching the ON CONFLICT specification"), { code: "42P10" }) });
  const qbo = makeQbo({ vendors: [{ Id: "v-instantly", DisplayName: "Instantly", Active: true }] });
  await assert.rejects(
    async () => ensureCanonicalVendorMappedToQbo({
      db,
      getQBOClientFn: async () => qbo,
      getLatestQuickBooksTokenRowFn: async () => ({ realm_id: REALM_ID, qbo_env: "production" }),
      businessId: BUSINESS_ID,
      bankTxn: txn({ id: "t-instantly-db-fail", merchant_entity_id: "ent-instantly-db-fail", merchant_name: "INSTANTLY" }),
    }),
    (err) => {
      assert.equal(err.message, "vendor_db_error");
      assert.equal(err.vendorDiagnostics.stage, "canonical_vendor_db");
      assert.equal(err.vendorDiagnostics.provider_code, "42P10");
      return true;
    }
  );
  assert.equal(qbo.created.length, 0);
  assert.equal(db.rows.business_qbo_vendor_mappings.length, 0);
});

test("vendor posting requirement applies only to normal identifiable merchant outflows", () => {
  assert.equal(getVendorPostingRequirement({ bankTxn: txn({ merchant_entity_id: "ent-1", merchant_name: "Apple" }), qboTxnType: "Purchase" }).required, true);
  assert.equal(getVendorPostingRequirement({ bankTxn: txn({ merchant_entity_id: "ent-1", merchant_name: "Apple" }), qboTxnType: "CreditCardCharge" }).required, true);
  assert.equal(getVendorPostingRequirement({ bankTxn: txn({ direction: "INFLOW", merchant_name: "Client" }), qboTxnType: "Deposit" }).required, false);
  assert.equal(getVendorPostingRequirement({ bankTxn: txn({ merchant_name: "Visa Payment" }), taxonomyMeta: { taxonomy_type: "cc_payment" }, qboTxnType: "CreditCardPayment" }).required, false);
  assert.equal(getVendorPostingRequirement({ bankTxn: txn({ merchant_name: "Owner Draw" }), taxonomyMeta: { taxonomy_type: "owner_draw" }, qboTxnType: "Purchase" }).required, false);
});

test("businesses with the same provider merchant id remain tenant-scoped", async () => {
  const db = makeDb();
  const first = await resolveCanonicalVendorForTransaction({ db, businessId: BUSINESS_ID, bankTxn: txn({ id: "t1", merchant_entity_id: "ent-shared", merchant_name: "Shared Vendor" }) });
  const second = await resolveCanonicalVendorForTransaction({ db, businessId: OTHER_BUSINESS_ID, bankTxn: txn({ id: "t2", business_id: OTHER_BUSINESS_ID, merchant_entity_id: "ent-shared", merchant_name: "Shared Vendor" }) });
  assert.notEqual(first.canonicalVendor.id, second.canonicalVendor.id);
  assert.equal(activeVendors(db).length, 2);
});

test("manual vendor mapping action validates selected QBO entity is a usable Vendor", async () => {
  const db = makeDb();
  const canonical = await resolveCanonicalVendorForTransaction({ db, businessId: BUSINESS_ID, bankTxn: txn({ id: "manual-vendor", merchant_entity_id: "ent-manual", merchant_name: "Apple" }) });
  const qbo = makeQbo({ customers: [{ Id: "c-1", DisplayName: "Apple", Active: true }] });
  await assert.rejects(
    useExistingQboVendorForCanonical({
      db,
      getQBOClientFn: async () => qbo,
      getLatestQuickBooksTokenRowFn: async () => ({ realm_id: REALM_ID, qbo_env: "production" }),
      businessId: BUSINESS_ID,
      canonicalVendorId: canonical.canonicalVendor.id,
      qboVendorId: "c-1",
    }),
    /qbo_vendor_not_usable/
  );
});

test("manual Use Existing Vendor mapping persists through active mapping RPC", async () => {
  const db = makeDb();
  const canonical = await resolveCanonicalVendorForTransaction({ db, businessId: BUSINESS_ID, bankTxn: txn({ id: "manual-vendor-success", merchant_entity_id: "ent-manual-success", merchant_name: "Manual Vendor" }) });
  const qbo = makeQbo({ vendors: [{ Id: "v-manual", DisplayName: "Manual Vendor", Active: true }] });
  const result = await useExistingQboVendorForCanonical({
    db,
    getQBOClientFn: async () => qbo,
    getLatestQuickBooksTokenRowFn: async () => ({ realm_id: REALM_ID, qbo_env: "production" }),
    businessId: BUSINESS_ID,
    canonicalVendorId: canonical.canonicalVendor.id,
    qboVendorId: "v-manual",
  });
  assert.equal(result.ok, true);
  assert.equal(result.mapping.qbo_vendor_id, "v-manual");
  assert.equal(db.calls.activeMappingUpserts, 1);
  assert.equal(db.rows.business_qbo_vendor_mappings.length, 1);
});

test("Business A cannot use Business B canonical vendor in Use Existing review action", async () => {
  const db = makeDb();
  const other = await resolveCanonicalVendorForTransaction({
    db,
    businessId: OTHER_BUSINESS_ID,
    bankTxn: txn({ id: "other-use-existing", business_id: OTHER_BUSINESS_ID, merchant_entity_id: "other-ent-use-existing", merchant_name: "Other Vendor" }),
  });
  const qbo = makeQbo({ vendors: [{ Id: "v-ok", DisplayName: "Other Vendor", Active: true }] });
  let qboCalls = 0;

  await assert.rejects(
    useExistingQboVendorForCanonical({
      db,
      getQBOClientFn: async () => {
        qboCalls += 1;
        return qbo;
      },
      getLatestQuickBooksTokenRowFn: async () => ({ realm_id: REALM_ID, qbo_env: "production" }),
      businessId: BUSINESS_ID,
      canonicalVendorId: other.canonicalVendor.id,
      qboVendorId: "v-ok",
    }),
    /canonical_vendor_not_found/
  );
  assert.equal(qboCalls, 0);
  assert.equal(db.rows.business_qbo_vendor_mappings.length, 0);
  assert.equal(db.rows.vendor_mapping_events.filter((row) => row.business_id === BUSINESS_ID).length, 0);
});

test("Business A cannot create a QBO Vendor using Business B canonical vendor id", async () => {
  const db = makeDb();
  const other = await resolveCanonicalVendorForTransaction({
    db,
    businessId: OTHER_BUSINESS_ID,
    bankTxn: txn({ id: "other-create", business_id: OTHER_BUSINESS_ID, merchant_entity_id: "other-ent-create", merchant_name: "Other Create" }),
  });
  let qboCalls = 0;

  await assert.rejects(
    createQboVendorForCanonicalReview({
      db,
      getQBOClientFn: async () => {
        qboCalls += 1;
        return makeQbo();
      },
      getLatestQuickBooksTokenRowFn: async () => ({ realm_id: REALM_ID, qbo_env: "production" }),
      businessId: BUSINESS_ID,
      canonicalVendorId: other.canonicalVendor.id,
    }),
    /canonical_vendor_not_found/
  );
  assert.equal(qboCalls, 0);
  assert.equal(db.rows.qbo_vendor_creation_intents.length, 0);
  assert.equal(db.rows.business_qbo_vendor_mappings.length, 0);
});

test("Business A cannot mark no-vendor-needed using Business B canonical vendor id", async () => {
  const db = makeDb();
  const other = await resolveCanonicalVendorForTransaction({
    db,
    businessId: OTHER_BUSINESS_ID,
    bankTxn: txn({ id: "other-no-vendor", business_id: OTHER_BUSINESS_ID, merchant_entity_id: "other-ent-no-vendor", merchant_name: "Other No Vendor" }),
  });
  db.rows.bank_transactions.push(txn({ id: "fee-a", merchant_entity_id: null, merchant_name: null, counterparty_name: null, name: "Monthly bank fee", category_primary: "BANK_FEES" }));
  db.rows.transaction_categorizations.push({ business_id: BUSINESS_ID, transaction_id: "fee-a", status: "needs_review", meta: { vendor_review_canonical_vendor_id: other.canonicalVendor.id } });

  await assert.rejects(
    markCanonicalVendorNotRequiredForTransaction({
      db,
      businessId: BUSINESS_ID,
      canonicalVendorId: other.canonicalVendor.id,
      transactionId: "fee-a",
    }),
    /canonical_vendor_not_found/
  );
  assert.equal(db.rows.vendor_mapping_events.filter((row) => row.business_id === BUSINESS_ID).length, 0);
  assert.equal(db.rows.transaction_categorizations[0].status, "needs_review");
  assert.equal(db.rows.transaction_categorizations[0].meta.vendor_not_required, undefined);
});

test("same-business no-vendor-needed action validates transaction association and succeeds only for vendorless classes", async () => {
  const db = makeDb();
  const canonical = await resolveCanonicalVendorForTransaction({ db, businessId: BUSINESS_ID, bankTxn: txn({ id: "same-no-vendor", merchant_entity_id: "same-ent-no-vendor", merchant_name: "Same Vendor" }) });
  db.rows.bank_transactions.push(txn({
    id: "fee-a",
    canonical_vendor_id: canonical.canonicalVendor.id,
    merchant_entity_id: null,
    merchant_name: null,
    counterparty_name: null,
    name: "Monthly bank fee",
    category_primary: "BANK_FEES",
  }));
  db.rows.transaction_categorizations.push({ business_id: BUSINESS_ID, transaction_id: "fee-a", status: "needs_review", meta: { vendor_review_canonical_vendor_id: canonical.canonicalVendor.id } });

  const result = await markCanonicalVendorNotRequiredForTransaction({
    db,
    businessId: BUSINESS_ID,
    canonicalVendorId: canonical.canonicalVendor.id,
    transactionId: "fee-a",
  });
  assert.equal(result.ok, true);
  assert.equal(db.rows.transaction_categorizations[0].meta.vendor_not_required, true);
  assert.equal(db.rows.vendor_mapping_events.some((row) => row.event_type === "override" && row.business_id === BUSINESS_ID), true);
});

test("QBO Customer or Employee DisplayName conflict prevents uncontrolled Vendor create", async () => {
  const db = makeDb();
  const qbo = makeQbo({ customers: [{ Id: "c-1", DisplayName: "Apple", Active: true }] });
  const result = await ensureCanonicalVendorMappedToQbo({
    db,
    getQBOClientFn: async () => qbo,
    getLatestQuickBooksTokenRowFn: async () => ({ realm_id: REALM_ID, qbo_env: "production" }),
    businessId: BUSINESS_ID,
    bankTxn: txn({ merchant_entity_id: "ent-apple", merchant_name: "Apple" }),
  });
  assert.equal(result.needsReview, true);
  assert.equal(result.reason, "display_name_conflict");
  assert.equal(qbo.created.length, 0);
});

test("multiple plausible Vendors require review", async () => {
  const db = makeDb();
  const qbo = makeQbo({
    vendors: [
      { Id: "v-1", DisplayName: "Amazon Marketplace", Active: true },
      { Id: "v-2", DisplayName: "Amazon Business", Active: true },
    ],
  });
  const result = await ensureCanonicalVendorMappedToQbo({
    db,
    getQBOClientFn: async () => qbo,
    getLatestQuickBooksTokenRowFn: async () => ({ realm_id: REALM_ID, qbo_env: "production" }),
    businessId: BUSINESS_ID,
    bankTxn: txn({ merchant_entity_id: "ent-amazon", merchant_name: "Amazon" }),
  });
  assert.equal(result.needsReview, true);
  assert.equal(result.reason, "ambiguous");
  assert.equal(qbo.created.length, 0);
});

test("two workers are serialized by durable vendor creation intent", async () => {
  const db = makeDb();
  const qbo = makeQbo();
  const common = {
    db,
    getQBOClientFn: async () => qbo,
    getLatestQuickBooksTokenRowFn: async () => ({ realm_id: REALM_ID, qbo_env: "production" }),
    businessId: BUSINESS_ID,
  };
  const first = await ensureCanonicalVendorMappedToQbo({ ...common, bankTxn: txn({ id: "t1", merchant_entity_id: "ent-new", merchant_name: "New SaaS" }) });
  const second = await ensureCanonicalVendorMappedToQbo({ ...common, bankTxn: txn({ id: "t2", merchant_entity_id: "ent-new", merchant_name: "New SaaS" }) });
  assert.equal(first.qbo_entity_id, second.qbo_entity_id);
  assert.equal(qbo.created.length, 1);
});

test("same strong merchant with different names keeps one QBO mapping and one creation intent", async () => {
  const db = makeDb();
  const qbo = makeQbo();
  const common = {
    db,
    getQBOClientFn: async () => qbo,
    getLatestQuickBooksTokenRowFn: async () => ({ realm_id: REALM_ID, qbo_env: "production" }),
    businessId: BUSINESS_ID,
  };
  const first = await ensureCanonicalVendorMappedToQbo({ ...common, bankTxn: txn({ id: "t1", merchant_entity_id: "ent-qbo-race", merchant_name: "THE HOME DEPOT" }) });
  const second = await ensureCanonicalVendorMappedToQbo({ ...common, bankTxn: txn({ id: "t2", merchant_entity_id: "ent-qbo-race", merchant_name: "HOME DEPOT #1234" }) });
  assert.equal(first.canonical_vendor_id, second.canonical_vendor_id);
  assert.equal(first.qbo_entity_id, second.qbo_entity_id);
  assert.equal(activeVendors(db).length, 1);
  assert.equal(db.rows.business_qbo_vendor_mappings.length, 1);
  assert.equal(db.rows.qbo_vendor_creation_intents.length, 1);
  assert.equal(qbo.created.length, 1);
});

test("provider timeout is recovered by re-query before a second create", async () => {
  const db = makeDb();
  const qbo = makeQbo({ failCreateOnceAfterPersisting: true });
  const common = {
    db,
    getQBOClientFn: async () => qbo,
    getLatestQuickBooksTokenRowFn: async () => ({ realm_id: REALM_ID, qbo_env: "production" }),
    businessId: BUSINESS_ID,
  };
  const first = await ensureCanonicalVendorMappedToQbo({ ...common, bankTxn: txn({ id: "t1", merchant_entity_id: "ent-timeout", merchant_name: "Timeout SaaS" }) });
  assert.equal(first.unknown, true);
  const second = await ensureCanonicalVendorMappedToQbo({ ...common, bankTxn: txn({ id: "t2", merchant_entity_id: "ent-timeout", merchant_name: "Timeout SaaS" }) });
  assert.equal(second.created, false);
  assert.equal(second.qbo_entity_id, "v-1");
  assert.equal(qbo.created.length, 1);
});

test("repeated call is idempotent and QBO reconnect with same realm preserves mapping", async () => {
  const db = makeDb();
  const qbo = makeQbo();
  const common = {
    db,
    getQBOClientFn: async () => qbo,
    getLatestQuickBooksTokenRowFn: async () => ({ realm_id: REALM_ID, qbo_env: "production" }),
    businessId: BUSINESS_ID,
  };
  const first = await ensureCanonicalVendorMappedToQbo({ ...common, bankTxn: txn({ id: "t1", merchant_entity_id: "ent-repeat", merchant_name: "Repeat SaaS" }) });
  const second = await ensureCanonicalVendorMappedToQbo({ ...common, bankTxn: txn({ id: "t1", merchant_entity_id: "ent-repeat", merchant_name: "Repeat SaaS" }) });
  assert.equal(first.qbo_entity_id, second.qbo_entity_id);
  assert.equal(qbo.created.length, 1);
});

test("Plaid reconnect does not create a second canonical vendor for same stable merchant", async () => {
  const db = makeDb();
  const first = await resolveCanonicalVendorForTransaction({ db, businessId: BUSINESS_ID, bankTxn: txn({ id: "old-plaid", plaid_transaction_id: "old", plaid_account_id: "old-acct", merchant_entity_id: "ent-stable", merchant_name: "Stable Vendor" }) });
  const second = await resolveCanonicalVendorForTransaction({ db, businessId: BUSINESS_ID, bankTxn: txn({ id: "new-plaid", plaid_transaction_id: "new", plaid_account_id: "new-acct", merchant_entity_id: "ent-stable", merchant_name: "Stable Vendor Location 2" }) });
  assert.equal(first.canonicalVendor.id, second.canonicalVendor.id);
  assert.equal(activeVendors(db).length, 1);
});

test("blocked taxonomy classes do not auto-create vendors", () => {
  for (const taxonomy_type of ["transfer_internal", "cc_payment", "owner_draw", "owner_contribution", "refund"]) {
    assert.ok(getVendorAutoCreateBlockReason({ bankTxn: txn({ merchant_name: "Vendor" }), taxonomyMeta: { taxonomy_type }, candidateName: "Vendor" }));
  }
  assert.ok(getVendorAutoCreateBlockReason({ bankTxn: txn({ merchant_name: null, name: "CHECK 1001" }), candidateName: "CHECK 1001" }));
  assert.ok(getVendorAutoCreateBlockReason({ bankTxn: txn({ direction: "INFLOW", merchant_name: "Client" }), candidateName: "Client" }));
});

function txn(overrides = {}) {
  return {
    id: "t1",
    business_id: BUSINESS_ID,
    plaid_account_id: "acct-1",
    plaid_transaction_id: "plaid-1",
    name: "CARD PURCHASE Vendor",
    merchant_name: "Vendor",
    merchant_entity_id: "ent-vendor",
    counterparty_name: null,
    direction: "OUTFLOW",
    amount: -25,
    signed_amount: -25,
    category_primary: "GENERAL_MERCHANDISE",
    personal_finance_category: null,
    qbo_entity_type: null,
    qbo_entity_id: null,
    canonical_vendor_id: null,
    ...overrides,
  };
}

function makeQbo({ vendors = [], customers = [], employees = [], failCreateOnceAfterPersisting = false, failFindVendors = false, failCreateWith = null } = {}) {
  const state = {
    vendors: [...vendors],
    customers: [...customers],
    employees: [...employees],
    created: [],
    calls: { findVendors: 0, findCustomers: 0, findEmployees: 0 },
    failCreateOnceAfterPersisting,
    failFindVendors,
    failCreateWith,
  };
  return {
    get created() {
      return state.created;
    },
    get calls() {
      return state.calls;
    },
    findVendors(query, cb) {
      state.calls.findVendors += 1;
      if (state.failFindVendors) {
        cb(new Error("qbo_find_failed"));
        return;
      }
      const active = query?.Active;
      const list = state.vendors.filter((v) => active === undefined || v.Active !== !active);
      cb(null, { QueryResponse: { Vendor: list } });
    },
    findCustomers(query, cb) {
      state.calls.findCustomers += 1;
      const active = query?.Active;
      const list = state.customers.filter((v) => active === undefined || v.Active !== !active);
      cb(null, { QueryResponse: { Customer: list } });
    },
    findEmployees(query, cb) {
      state.calls.findEmployees += 1;
      const active = query?.Active;
      const list = state.employees.filter((v) => active === undefined || v.Active !== !active);
      cb(null, { QueryResponse: { Employee: list } });
    },
    vendor: {
      create(payload, cb) {
        if (state.failCreateWith) {
          cb(state.failCreateWith);
          return;
        }
        const row = { Id: `v-${state.vendors.length + 1}`, DisplayName: payload.DisplayName, Active: true };
        state.vendors.push(row);
        state.created.push({ payload, row });
        if (state.failCreateOnceAfterPersisting) {
          state.failCreateOnceAfterPersisting = false;
          cb(new Error("timeout"));
          return;
        }
        cb(null, { Vendor: row });
      },
    },
  };
}

function makeDb({ failActiveMappingUpsert = null } = {}) {
  const rows = {
    bizzi_vendors: [],
    vendor_aliases: [],
    business_qbo_vendor_mappings: [],
    qbo_vendor_name_cache: [],
    qbo_vendor_creation_intents: [],
    vendor_mapping_events: [],
    bank_transactions: [],
    transaction_categorizations: [],
    qbo_vendor_creations: [],
  };
  const calls = {
    strongAliasClaims: 0,
    activeMappingUpserts: 0,
  };
  let seq = 1;
  const nextId = () => `id-${seq++}`;
  return {
    rows,
    calls,
    from(table) {
      return new Query(rows, table, nextId);
    },
    async rpc(name, params) {
      if (name === "claim_canonical_vendor_by_strong_alias") {
        calls.strongAliasClaims += 1;
        const existingAlias = rows.vendor_aliases.find((row) =>
          row.business_id === params.p_business_id &&
          row.alias_type === params.p_alias_type &&
          row.normalized_alias_value === params.p_normalized_alias_value &&
          row.is_strong_evidence === true &&
          row.is_approved === true
        );
        if (existingAlias) {
          const vendor = rows.bizzi_vendors.find((row) => row.id === existingAlias.canonical_vendor_id);
          return { data: { claimed: false, created: false, canonical_vendor: vendor, alias: existingAlias }, error: null };
        }
        const existingVendor = rows.bizzi_vendors.find((row) =>
          row.business_id === params.p_business_id &&
          row.normalized_display_name === params.p_normalized_display_name &&
          row.status === "active"
        );
        if (existingVendor) {
          const alias = {
            id: nextId(),
            business_id: params.p_business_id,
            canonical_vendor_id: existingVendor.id,
            alias_type: params.p_alias_type,
            alias_value: params.p_alias_value,
            normalized_alias_value: params.p_normalized_alias_value,
            source: params.p_alias_source,
            confidence: params.p_alias_confidence,
            is_strong_evidence: true,
            is_approved: true,
            first_transaction_id: params.p_transaction_id,
            metadata: params.p_alias_metadata || {},
          };
          rows.vendor_aliases.push(alias);
          return { data: { claimed: true, created: false, canonical_vendor: existingVendor, alias }, error: null };
        }
        const vendor = {
          id: nextId(),
          business_id: params.p_business_id,
          display_name: params.p_display_name,
          normalized_display_name: params.p_normalized_display_name,
          status: "active",
          primary_evidence_type: params.p_primary_evidence_type,
          primary_evidence_value: params.p_primary_evidence_value,
          primary_source: params.p_primary_source,
          confidence: params.p_confidence,
          metadata: params.p_vendor_metadata || {},
        };
        rows.bizzi_vendors.push(vendor);
        const alias = {
          id: nextId(),
          business_id: params.p_business_id,
          canonical_vendor_id: vendor.id,
          alias_type: params.p_alias_type,
          alias_value: params.p_alias_value,
          normalized_alias_value: params.p_normalized_alias_value,
          source: params.p_alias_source,
          confidence: params.p_alias_confidence,
          is_strong_evidence: true,
          is_approved: true,
          first_transaction_id: params.p_transaction_id,
          metadata: params.p_alias_metadata || {},
        };
        rows.vendor_aliases.push(alias);
        rows.vendor_mapping_events.push({
          id: nextId(),
          business_id: params.p_business_id,
          canonical_vendor_id: vendor.id,
          event_type: "canonical_vendor_created",
          reason: "strong_alias_claim_created_canonical_vendor",
        });
        return { data: { claimed: true, created: true, canonical_vendor: vendor, alias }, error: null };
      }
      if (name === "upsert_active_qbo_vendor_mapping") {
        calls.activeMappingUpserts += 1;
        if (failActiveMappingUpsert) return { data: null, error: failActiveMappingUpsert };
        const vendor = rows.bizzi_vendors.find((row) =>
          row.business_id === params.p_business_id &&
          row.id === params.p_canonical_vendor_id &&
          ["active", "needs_review"].includes(row.status)
        );
        if (!vendor) return { data: null, error: new Error("canonical_vendor_not_found") };
        const qboEnv = params.p_qbo_env || "production";
        const qboConflict = rows.business_qbo_vendor_mappings.find((row) =>
          row.business_id === params.p_business_id &&
          row.qbo_env === qboEnv &&
          row.realm_id === params.p_realm_id &&
          row.status === "active" &&
          row.qbo_vendor_id === String(params.p_qbo_vendor_id) &&
          row.canonical_vendor_id !== params.p_canonical_vendor_id
        );
        if (qboConflict) {
          return { data: null, error: Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" }) };
        }
        let row = rows.business_qbo_vendor_mappings.find((candidate) =>
          candidate.business_id === params.p_business_id &&
          candidate.qbo_env === qboEnv &&
          candidate.realm_id === params.p_realm_id &&
          candidate.canonical_vendor_id === params.p_canonical_vendor_id &&
          candidate.status === "active"
        );
        if (row) {
          Object.assign(row, {
            qbo_vendor_id: String(params.p_qbo_vendor_id),
            qbo_display_name: params.p_qbo_display_name,
            mapping_source: params.p_mapping_source || "resolver",
            mapped_by: params.p_mapped_by || null,
            mapped_at: params.p_now || new Date().toISOString(),
            last_validated_at: params.p_now || new Date().toISOString(),
            first_transaction_id: row.first_transaction_id || params.p_first_transaction_id || null,
            metadata: { ...(row.metadata || {}), ...(params.p_metadata || {}) },
          });
        } else {
          row = {
            id: nextId(),
            business_id: params.p_business_id,
            realm_id: params.p_realm_id,
            qbo_env: qboEnv,
            canonical_vendor_id: params.p_canonical_vendor_id,
            qbo_vendor_id: String(params.p_qbo_vendor_id),
            qbo_display_name: params.p_qbo_display_name,
            status: "active",
            mapping_source: params.p_mapping_source || "resolver",
            created_by: params.p_created_by || "bizzi",
            mapped_by: params.p_mapped_by || null,
            mapped_at: params.p_now || new Date().toISOString(),
            last_validated_at: params.p_now || new Date().toISOString(),
            first_transaction_id: params.p_first_transaction_id || null,
            metadata: params.p_metadata || {},
          };
          rows.business_qbo_vendor_mappings.push(row);
        }
        return { data: row, error: null };
      }
      if (name !== "claim_qbo_vendor_creation_intent") return { data: null, error: new Error("unknown_rpc") };
      const existing = rows.qbo_vendor_creation_intents.find((row) =>
        row.business_id === params.p_business_id &&
        row.realm_id === params.p_realm_id &&
        row.qbo_env === params.p_qbo_env &&
        row.canonical_vendor_id === params.p_canonical_vendor_id
      );
      if (existing?.status && ["created", "mapped_existing"].includes(existing.status) && existing.qbo_vendor_id) {
        return { data: { claimed: false, already_mapped: true, intent: existing }, error: null };
      }
      if (existing?.status === "processing") {
        return { data: { claimed: false, already_mapped: false, intent: existing }, error: null };
      }
      if (existing) {
        existing.status = "processing";
        existing.attempt_count += 1;
        return { data: { claimed: true, already_mapped: false, intent: existing }, error: null };
      }
      const row = {
        id: nextId(),
        business_id: params.p_business_id,
        realm_id: params.p_realm_id,
        qbo_env: params.p_qbo_env,
        canonical_vendor_id: params.p_canonical_vendor_id,
        desired_display_name: params.p_desired_display_name,
        request_id: params.p_request_id,
        status: "processing",
        attempt_count: 1,
      };
      rows.qbo_vendor_creation_intents.push(row);
      return { data: { claimed: true, already_mapped: false, intent: row }, error: null };
    },
  };
}

function activeVendors(db) {
  return db.rows.bizzi_vendors.filter((row) => row.status === "active");
}

class Query {
  constructor(rows, table, nextId) {
    this.rows = rows;
    this.table = table;
    this.nextId = nextId;
    this.filters = [];
    this.payload = null;
    this.action = "select";
    this.conflict = null;
  }
  select() {
    return this;
  }
  eq(key, value) {
    this.filters.push({ key, value });
    return this;
  }
  filter(key, op, value) {
    this.filters.push({ key, value, op });
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }
  insert(payload) {
    this.action = "insert";
    this.payload = payload;
    return this;
  }
  update(payload) {
    this.action = "update";
    this.payload = payload;
    return this;
  }
  upsert(payload, options = {}) {
    this.action = "upsert";
    this.payload = payload;
    this.conflict = options.onConflict;
    return this;
  }
  maybeSingle() {
    return this.then((result) => ({ data: Array.isArray(result.data) ? result.data[0] || null : result.data, error: result.error }));
  }
  then(resolve, reject) {
    return Promise.resolve(this.execute()).then(resolve, reject);
  }
  execute() {
    if (this.action === "insert") {
      const payloads = Array.isArray(this.payload) ? this.payload : [this.payload];
      const inserted = payloads.map((payload) => {
        const row = { id: payload.id || this.nextId(), ...payload };
        this.rows[this.table].push(row);
        return hydrate(this.rows, this.table, row);
      });
      return { data: Array.isArray(this.payload) ? inserted : inserted[0], error: null };
    }
    if (this.action === "update") {
      const matched = this.rows[this.table].filter((row) => matches(row, this.filters));
      matched.forEach((row) => Object.assign(row, this.payload));
      return { data: matched.map((row) => hydrate(this.rows, this.table, row)), error: null };
    }
    if (this.action === "upsert") {
      const payloads = Array.isArray(this.payload) ? this.payload : [this.payload];
      const out = payloads.map((payload) => {
        const keys = String(this.conflict || "id").split(",").map((key) => key.trim());
        let row = this.rows[this.table].find((candidate) => keys.every((key) => candidate[key] === payload[key]));
        if (row) Object.assign(row, payload);
        else {
          row = { id: payload.id || this.nextId(), ...payload };
          this.rows[this.table].push(row);
        }
        return hydrate(this.rows, this.table, row);
      });
      return { data: Array.isArray(this.payload) ? out : out[0], error: null };
    }
    const selected = this.rows[this.table].filter((row) => matches(row, this.filters)).map((row) => hydrate(this.rows, this.table, row));
    return { data: selected, error: null };
  }
}

function matches(row, filters) {
  return filters.every((filter) => {
    if (filter.key.startsWith("meta->>")) {
      const key = filter.key.slice("meta->>".length);
      return String(row.meta?.[key] || "") === String(filter.value);
    }
    return row[filter.key] === filter.value;
  });
}

function hydrate(rows, table, row) {
  if (table !== "vendor_aliases") return row;
  return {
    ...row,
    bizzi_vendors: rows.bizzi_vendors.find((vendor) => vendor.id === row.canonical_vendor_id) || null,
  };
}
