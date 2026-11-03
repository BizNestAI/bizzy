import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";
import express from "express";
import { SignJWT, jwtVerify } from "jose";
import { vehicleDatabase } from "./fixtures/vehicleDatabase.js";

const container = process.env.TAX_VEHICLE_TEST_CONTAINER;
const B = "11111111-1111-4111-8111-111111111111", U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T = "00000000-0000-4000-8000-000000000001";
const literal = (value) => value == null ? "null" : typeof value === "number" ? String(value) : `'${(typeof value === "object" ? JSON.stringify(value) : String(value)).replaceAll("'", "''")}'${typeof value === "object" ? "::jsonb" : ""}`;
function databaseAdapter(db) {
  const query = (text) => {
    const result = db.sql(text, "service_role");
    if (result.status) {
      const match = result.stderr.match(/ERROR:\s+([A-Z0-9]{5}):\s+([^\n]+)/);
      return { data: null, error: { code: match?.[1] || "database_error", message: match?.[2] || result.stderr } };
    }
    return { data: result.stdout.trim() ? JSON.parse(result.stdout.trim()) : null, error: null };
  };
  return {
    rpc(name, args) {
      assert.ok(["preview_tax_vehicle_command", "apply_tax_vehicle_command", "replace_tax_vehicle_mileage_entries"].includes(name));
      return query(`select public.${name}(${Object.values(args).map(literal).join(",")});`);
    },
    from(table) {
      assert.ok(["business_profiles", "user_business_link", "tax_vehicles", "tax_vehicle_method_elections", "tax_vehicle_mileage_inputs", "tax_vehicle_mileage_rates"].includes(table));
      const filters = [];
      const chain = { select() { return this; }, limit() { return this; }, eq(column, value) { assert.match(column, /^[a-z_]+$/); filters.push(`${column}=${literal(value)}`); return this; },
        then(resolve) { return Promise.resolve(query(`select coalesce(jsonb_agg(t),'[]'::jsonb) from public.${table} t where ${filters.length ? filters.join(" and ") : "true"};`)).then(resolve); },
        maybeSingle() { return query(`select to_jsonb(t) from public.${table} t where ${filters.join(" and ")} limit 1;`); } };
      return chain;
    },
  };
}
test("authenticated HTTP vehicle corrections enforce tenant, projection, RLS, history and canonical amounts", { skip: !container }, async () => {
  const db = vehicleDatabase();
  let server;
  let reset;
  try {
    process.env.NODE_ENV = "test";
    process.env.SUPABASE_URL = "http://127.0.0.1:54321";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "local-test-only-not-a-production-key";
    const auth = await import("../src/api/gpt/middlewares/requireAuth.js");
    const secret = new TextEncoder().encode("local-vehicle-http-test-signing-key-0001");
    auth.__setRequireAuthTestDeps({ verifyToken: async (token) => (await jwtVerify(token, secret, { issuer: "local-vehicle-test" })).payload });
    reset = () => auth.__setRequireAuthTestDeps(null);
    const { default: router } = await import("../src/api/tax/taxVehicleDeduction.routes.js");
    const app = express(); app.use(express.json()); app.locals.supabase = databaseAdapter(db);
    app.use("/api/tax", auth.requireAuth, router);
    server = await new Promise((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
    const owner = await new SignJWT({ role: "authenticated" }).setSubject(U).setIssuer("local-vehicle-test").setExpirationTime("5m").setProtectedHeader({ alg: "HS256" }).sign(secret);
    const other = await new SignJWT({ role: "authenticated" }).setSubject("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").setIssuer("local-vehicle-test").setExpirationTime("5m").setProtectedHeader({ alg: "HS256" }).sign(secret);
    const call = async (route, body, token = owner, key = "vehicle-http-command-0001") => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/tax/vehicle-commands/${route}?businessId=${B}&year=2026`, {
        method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), "Idempotency-Key": key }, body: JSON.stringify(body),
      });
      return { status: response.status, ...(await response.json()) };
    };
    const choices = { action: "exclude", reason: "Explicit synthetic correction", transactionIds: [T], projectionId: "33333333-3333-4333-8333-333333333333", sourceFingerprint: "a".repeat(64) };
    assert.equal((await call("preview", choices, null)).status, 401);
    assert.equal((await call("preview", choices, "invalid-signed-token")).status, 401);
    assert.equal((await call("preview", choices, other)).status, 403);
    assert.equal((await call("preview", { ...choices, sourceFingerprint: "b".repeat(64) })).status, 409);
    assert.equal((await call("preview", { ...choices, transactionIds: ["ffffffff-ffff-4fff-8fff-ffffffffffff"] })).status, 403);
    assert.equal(Number(db.check(db.sql("select count(*) from public.tax_vehicle_command_previews;")).stdout.trim()), 0, "denied requests create no previews");
    let preview = await call("preview", choices);
    assert.equal(preview.status, 200, JSON.stringify(preview));
    const payload = { previewId: preview.data.previewId, rows: [{ deductibleAmount: 999999 }], transactionIds: ["malicious"], deductibleAmount: 999999 };
    let saved = await call("apply", payload);
    assert.equal(saved.status, 200, JSON.stringify(saved));
    assert.equal(saved.data.appliedCount, 1);
    assert.deepEqual((await call("apply", payload)).data, saved.data);
    const audit = JSON.parse(db.check(db.sql(`select to_jsonb(h) from public.tax_classification_overrides h where transaction_id='${T}';`)).stdout.trim());
    assert.equal(audit.overridden_by, U); assert.equal(audit.previous_values.classification_status, "needs_review");
    assert.equal(audit.new_values.tax_treatment, "vehicle_manual_excluded");
    preview = await call("preview", { ...choices, action: "assign", primaryVehicle: true });
    assert.equal(preview.status, 200, JSON.stringify(preview));
    saved = await call("apply", { previewId: preview.data.previewId }, owner, "vehicle-http-reassign-0002");
    assert.equal(saved.status, 200, JSON.stringify(saved));
    const v = saved.data.vehicleId;
    for (const businessUsePercent of [0, -1, 101, "", "80.123", 100]) {
      const rejected = await call("preview", { ...choices, action: "amend", transactionIds: [], vehicleId: v, method: "actual_expenses", businessUsePercent, ownershipType: "owned", confirmYearRecalculation: true });
      assert.equal(rejected.status, 422, `invalid or unconfirmed percentage ${businessUsePercent}`);
    }
    preview = await call("preview", { ...choices, action: "amend", transactionIds: [], vehicleId: v, method: "actual_expenses", businessUsePercent: 80, ownershipType: "owned", confirmYearRecalculation: true, calculatedTotal: 999999 });
    assert.equal(preview.status, 200, JSON.stringify(preview));
    assert.equal(preview.data.afterDeduction, 54.4, "server uses $68 from canonical row, not client totals");
    saved = await call("apply", { previewId: preview.data.previewId }, owner, "vehicle-http-actual-0003");
    assert.equal(saved.status, 200); assert.equal(saved.data.deductibleAmount, 54.4);
    // A new transaction is membership evidence: the old preview must fail wholly.
    preview = await call("preview", { ...choices, action: "exclude" });
    db.check(db.sql(`update public.transaction_tax_classifications set reason='Concurrent update' where transaction_id='${T}';`));
    const before = db.check(db.sql("select count(*) from public.tax_classification_overrides;")).stdout;
    const denied = await call("apply", { previewId: preview.data.previewId }, owner, "vehicle-http-stale-0004");
    assert.equal(denied.status, 409, JSON.stringify(denied));
    assert.equal(db.check(db.sql("select count(*) from public.tax_classification_overrides;")).stdout, before);
    assert.notEqual(db.sql("select * from public.tax_vehicle_command_previews;", "authenticated").status, 0);
    assert.notEqual(db.sql("select public.apply_tax_vehicle_command(null,null,null,null,null);", "authenticated").status, 0);
    const policies = JSON.parse(db.check(db.sql("select json_agg(roles) from pg_policies where tablename in ('tax_vehicle_command_previews','tax_vehicle_transaction_assignments');")).stdout.trim());
    assert.ok(policies.every((roles) => roles.length === 1 && roles[0] === "service_role"));
    // Exercise real authenticated mileage preview/apply against SQL snapshots.
    db.check(db.sql(`insert into public.tax_vehicles(id,business_id,display_name,ownership_type) values('44444444-4444-4444-8444-444444444444','${B}','Monthly HTTP vehicle','owned');
      insert into public.tax_vehicle_method_elections(id,business_id,vehicle_id,tax_year,method,status,effective_start,effective_end,source,authority,contract_version,elected_by) values('55555555-5555-4555-8555-555555555555','${B}','44444444-4444-4444-8444-444444444444',2026,'standard_mileage','active','2026-01-01','2026-12-31','tax_workspace_question','customer','vehicle-election-v1','${U}');`));
    const mileageCall = async (route, body, token = owner) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/tax/vehicle-mileage/${route}?businessId=${B}&year=2026`, {
        method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(5000) });
      return {status:response.status,...await response.json()};
    };
    const mileageInput={vehicleId:'44444444-4444-4444-8444-444444444444',expectedElectionId:'55555555-5555-4555-8555-555555555555',substantiationStatus:'supported',entries:[{periodStart:'2026-01-01',periodEnd:'2026-01-31',businessMiles:1000},{periodStart:'2026-07-01',periodEnd:'2026-07-31',businessMiles:12000}]};
    assert.equal((await mileageCall('preview',mileageInput,null)).status,401);
    assert.equal((await mileageCall('preview',mileageInput,other)).status,403);
    const mileagePreview=await mileageCall('preview',mileageInput);assert.equal(mileagePreview.status,200,JSON.stringify(mileagePreview));assert.equal(mileagePreview.data.totalDeduction,9845);assert.equal(mileagePreview.data.monthlyAllocation.status,'complete');
    const expectedPreview={electionId:mileagePreview.data.electionId,periods:mileagePreview.data.periods,totalDeduction:9845};
    const mileageSaved=await mileageCall('apply',{...mileageInput,expectedPreview});assert.equal(mileageSaved.status,200,JSON.stringify(mileageSaved));assert.equal(mileageSaved.data.totalDeduction,9845);
    const mileageReplay=await mileageCall('apply',{...mileageInput,expectedPreview});assert.deepEqual(mileageReplay.data.entryIds,mileageSaved.data.entryIds);
    const snapshotBefore=db.check(db.sql('select count(*) from public.tax_vehicle_mileage_inputs;')).stdout;
    assert.equal((await mileageCall('apply',{...mileageInput,expectedPreview:{...expectedPreview,totalDeduction:999999}})).status,409);
    assert.equal((await mileageCall('apply',{...mileageInput,expectedElectionId:'66666666-6666-4666-8666-666666666666'})).status,409);
    assert.equal((await mileageCall('apply',{...mileageInput,entries:[{...mileageInput.entries[0],businessMiles:-1}]})).status,422);
    assert.equal((await mileageCall('apply',mileageInput,other)).status,403);
    assert.equal(db.check(db.sql('select count(*) from public.tax_vehicle_mileage_inputs;')).stdout,snapshotBefore);
  } finally {
    reset?.();
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    db.cleanup();
  }
});
