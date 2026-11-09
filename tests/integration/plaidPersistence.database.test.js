/* global process, Buffer */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { createClient } from "@supabase/supabase-js";

// Fully synthetic data; no .env loading. Docker resources are unique to this run.
const name = `bizzi-plaid-test-${process.pid}`;
const apiName = `${name}-api`;
const network = `${name}-net`;
const secret = "local-only-plaid-persistence-test-secret-at-least-32";
function docker(args, input) {
  const r = spawnSync("docker", args, { input, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`docker ${args[0]} failed: ${r.stderr}`);
  return r.stdout.trim();
}
function sql(text) {
  return docker(["exec", "-i", name, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-At"], text);
}
const read = (f) => fs.readFileSync(f, "utf8");
function schema() {
  const snapshot = read("supabase/live_schema_snapshot.sql");
  const tables = ["business_profiles", "bank_transactions", "transaction_categorizations", "plaid_items", "plaid_accounts", "bank_sync_runs", "qbo_posted_transactions", "plaid_qbo_account_mappings", "quickbooks_tokens", "business_billing", "bookkeeping_post_attempts"];
  let out = `create role anon; create role authenticated; create role service_role bypassrls login;
    grant usage on schema public to service_role;
    create schema extensions; create extension if not exists "uuid-ossp" schema extensions;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql as 'select null::uuid';
    set check_function_bodies = false;\n`;
  // Exact snapshot DDL, not hand-written permissive replicas. External-module
  // foreign keys are omitted; core ownership/identity FKs are retained.
  for (const t of tables) {
    const ddl = snapshot.match(new RegExp(`CREATE TABLE IF NOT EXISTS "public"\\."${t}" \\([\\s\\S]*?\n\\);`));
    assert.ok(ddl, t); out += `${ddl[0]}\n`;
  }
  for (const m of snapshot.matchAll(/ALTER TABLE ONLY "public"\."([^"]+)"[\s\S]*?;/g)) {
    if (!tables.includes(m[1])) continue;
    const ref = m[0].match(/REFERENCES "public"\."([^"]+)"/);
    if (ref && !tables.includes(ref[1])) continue;
    out += `${m[0]}\n`;
  }
  for (const m of snapshot.matchAll(/CREATE (?:UNIQUE )?INDEX [^;]+;/g)) {
    if (["bank_transactions", "transaction_categorizations"].some(t => m[0].includes(`ON "public"."${t}"`))) out += `${m[0]}\n`;
  }
  for (const f of ["set_updated_at", "tc_sync_txn_fields_from_bank_transactions"]) {
    const m = snapshot.match(new RegExp(`CREATE OR REPLACE FUNCTION "public"\\."${f}"\\([\\s\\S]*?\n\\$\\$;`));
    assert.ok(m, f); out += `${m[0]}\n`;
  }
  for (const m of snapshot.matchAll(/CREATE OR REPLACE TRIGGER [^;]+;/g)) {
    if (["bank_transactions", "transaction_categorizations"].some(t => m[0].includes(`ON "public"."${t}"`))) out += `${m[0]}\n`;
  }
  // The installed posting-job trigger is included; it only records database
  // state. No posting worker is started.
  const classifier = read("supabase/migrations/20261024_posted_matched_primary_feed_separation.sql");
  out += classifier.slice(0, classifier.indexOf("$$;") + 3);
  for (const f of [
    "20260908_internal_staff_users.sql", "20260903_credit_card_payment_pairs.sql", "20260824_add_auto_post_to_quickbooks.sql", "20260509_plaid_env_transaction_source.sql", "20260825_plaid_canonical_identity_phase1.sql",
    "20260826_qbo_posting_idempotency_phase2.sql", "20260830_background_bookkeeping_processing.sql", "20261006_plaid_replacement_card_recovery.sql",
    "20261010_bookkeeping_review_posting_state_separation.sql", "20261013090000_pending_transaction_resolution.sql",
    "20261021_transaction_exclusions.sql", "20261023_exclusion_status_constraint.sql",
    "20261101101000_plaid_replacement_recovery_durable_state.sql", "20261027_handled_posting_jobs_hardening.sql", "20261101111000_plaid_account_connection_state_contract.sql", "20261109173000_plaid_durable_sync_admission.sql", "20261109190000_plaid_account_recovery_observability.sql",
  ]) out += `\n${read(`supabase/migrations/${f}`)}\n`;
  // Matching evidence uses the exact table DDL; unrelated job-revenue indexes
  // and RPCs from that migration are outside this disposable fixture.
  const matchMigration = read("supabase/migrations/20261009_incoming_deposit_qbo_matches.sql");
  for (const table of ["bank_qbo_matches", "bank_qbo_match_items", "bank_qbo_match_history"]) {
    const ddl=matchMigration.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\n\\);`));
    assert.ok(ddl,table); out+=ddl[0]+"\n";
  }
  const pairEvents=read("supabase/migrations/20260922_atomic_credit_card_payment_pair_lifecycle.sql");
  out+=pairEvents.slice(pairEvents.indexOf("create table"),pairEvents.indexOf("create index"));
  out+=read("supabase/migrations/20261109210000_plaid_residual_reconciliation.sql");
  // Do not blanket-grant functions: that would expose the private hold helper.
  out += "alter table public.transaction_categorizations enable row level security; grant all on all tables in schema public to service_role;";
  return out;
}
const pause = () => new Promise(r => setTimeout(r, 150));
let db, runSync, updateRows, diagnostics, getRecoveryStatus, residualRecovery, reconcileResidual;
const business = randomUUID(), otherBusiness = randomUUID();
async function ok(query) { const r = await query; assert.equal(r.error, null, JSON.stringify(r.error)); return r.data; }
const get = (table) => db.from(table).select("*").eq("business_id", business);
async function fixture() {
  const key = randomUUID();
  const [item] = await ok(db.from("plaid_items").insert({ business_id: business, plaid_item_id: key, plaid_env: "production", plaid_access_token: "synthetic", status: "connected", cursor: "synthetic-old" }).select());
  await ok(db.from("plaid_accounts").insert({ business_id: business, plaid_item_id: key, plaid_account_id: key, plaid_env: "production", name: "Synthetic account" }));
  return { item, key };
}
function bank(f, id, more = {}) { return { business_id: business, plaid_item_id: f.key, plaid_account_id: f.key, plaid_env: "production", plaid_transaction_id: id, date: "2026-11-01", name: `synthetic-${id}`, amount: -10, signed_amount: -10, direction: "OUTFLOW", pending: false, ...more }; }
function event(f, id, more = {}) { return { account_id: f.key, transaction_id: id, date: "2026-11-01", name: `synthetic-${id}`, amount: 10, pending: false, ...more }; }
async function sync(f, payload, database = db) {
  const [item] = await ok(get("plaid_items").eq("id", f.item.id));
  return runSync({ transactionsSync: async () => ({ data: { added: [], modified: [], removed: [], next_cursor: "synthetic-next", has_more: false, ...payload } }) }, business, item,
    { db: database, resolveToken: async () => "synthetic-no-provider" });
}
function failRpc(database, rpcName) {
  return { from: (...a) => database.from(...a), rpc: (n, args) => n === rpcName
    ? Promise.resolve({ data: null, error: { code: "P0001", message: "synthetic admission failure" } }) : database.rpc(n, args) };
}

async function appliedReconciliationCohort(count) {
  const f=await fixture(),actor=randomUUID(),tag=randomUUID();
  sql(`insert into auth.users(id) values ('${actor}');`);
  await ok(db.from("internal_staff_users").insert({user_id:actor,role:"operator"}));
  const events=Array.from({length:count+1},(_,i)=>event(f,`review-${tag}-${i}`));
  await assert.rejects(sync(f,{added:events},failRpc(db,"complete_plaid_sync_admission")));
  await sync(f,{added:[events[0]]});
  const args={db,businessId:business,plaidEnv:"production",plaidAccountId:f.key,actorUserId:actor};
  const preview=await residualRecovery(args); await residualRecovery({...args,execute:true,batchId:preview.batch_id});
  const ids=JSON.parse(sql(`select jsonb_agg(payload->>'transaction_id' order by id) from public.plaid_recovery_batch_rows where batch_id='${preview.batch_id}'`));
  return {...f,actor,ids,args:{...args,batchId:preview.batch_id},batchId:preview.batch_id};
}
async function finishSyntheticCategorization(ids) {
  for(let i=0;i<ids.length;i+=200){
    await ok(db.from("transaction_categorizations").update({status:"auto_approved",final_qbo_account_id:"reviewed-destination"}).in("transaction_id",ids.slice(i,i+200)));
    await ok(db.from("bookkeeping_processing_requests").update({status:"completed",attempt_count:1,processed_at:new Date().toISOString()}).in("transaction_id",ids.slice(i,i+200)));
  }
}
function attestation(){return {performed:true,ledger:"quickbooks_live",outcome:"no_unrepresented_duplicate",reviewed_at:new Date().toISOString()};}

test("production-shaped Plaid persistence and durable admission (Postgres + PostgREST)", { timeout: 240000 }, async t => {
  try {
    docker(["network", "create", network]);
    docker(["run", "--pull=never", "--name", name, "--network", network, "-e", "POSTGRES_PASSWORD=local-only", "-d", "postgres:17"]);
    for (let i = 0; i < 100; i++) {
      const r = spawnSync("docker", ["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]);
      if (r.status === 0) break;
      await pause();
    }
    await t.test("managed non-superuser role creator rejects ADMIN regrant; temporary ownership transfer remains restricted", () => {
      sql(`create role managed_migration_fixture login createrole;
        grant create, usage on schema public to managed_migration_fixture with grant option;`);
      const rejected = spawnSync("docker", ["exec", "-i", name, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-At"], {
        input: `set session authorization managed_migration_fixture;
          create role managed_executor_fixture nologin noinherit;
          grant managed_executor_fixture to managed_migration_fixture with admin true, inherit true, set true;`, encoding: "utf8"
      });
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /ADMIN option cannot be granted back to your own grantor/);
      sql(`set session authorization managed_migration_fixture;
        grant managed_executor_fixture to managed_migration_fixture with inherit true, set true;
        grant create, usage on schema public to managed_executor_fixture;
        create function public.managed_role_fixture() returns integer language sql security definer as 'select 1';
        alter function public.managed_role_fixture() owner to managed_executor_fixture;
        revoke create on schema public from managed_executor_fixture;
        revoke all on function public.managed_role_fixture() from public;
        grant execute on function public.managed_role_fixture() to managed_migration_fixture;
        grant managed_executor_fixture to managed_migration_fixture with inherit false, set false;
        reset session authorization;`);
      assert.equal(sql("select pg_has_role('managed_migration_fixture','managed_executor_fixture','USAGE'), pg_has_role('managed_migration_fixture','managed_executor_fixture','SET')"), "f|f");
      assert.equal(sql("set session authorization managed_migration_fixture; select public.managed_role_fixture()" ).split("\n").at(-1), "1");
      sql(`set session authorization managed_migration_fixture;
        revoke all on schema public from managed_executor_fixture;
        reset session authorization;
        drop function public.managed_role_fixture();
        drop owned by managed_executor_fixture; drop role managed_executor_fixture;
        drop owned by managed_migration_fixture; drop role managed_migration_fixture;`);
    });
    sql(schema());
    const port = docker(["run", "--pull=never", "--name", apiName, "--network", network,
      "-p", "127.0.0.1::3000", "-e", `PGRST_DB_URI=postgres://postgres:local-only@${name}:5432/postgres`,
      "-e", "PGRST_DB_SCHEMAS=public", "-e", "PGRST_DB_ANON_ROLE=anon", "-e", `PGRST_JWT_SECRET=${secret}`,
      "-d", "public.ecr.aws/supabase/postgrest:v16.4"]);
    assert.ok(port);
    const address = docker(["port", apiName, "3000/tcp"]);
    const url = `http://${address}`;
    const token = await new SignJWT({ role: "service_role" }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("1h").sign(Buffer.from(secret));
    db = createClient(url, token, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (...args) => globalThis.fetch(...args) } });
    for (let i = 0; i < 100; i++) { try { if ((await fetch(url)).ok) break; } catch { /* starting */ } await pause(); }
    process.env.SUPABASE_URL = url; process.env.SUPABASE_SERVICE_ROLE_KEY = token;
    process.env.PLAID_CLIENT_ID = "synthetic"; process.env.PLAID_SECRET = "synthetic";
    process.env.QB_ENVIRONMENT = "production";
    process.env.PLAID_ENV = "production"; process.env.NODE_ENV = "test";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, ...args) => {
      const target = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      assert.equal(target.origin, url, "External network call forbidden, including QBO/Plaid");
      target.pathname = target.pathname.replace(/^\/rest\/v1(?=\/|$)/, "");
      return originalFetch(input instanceof Request ? new Request(target, input) : target, ...args);
    };
    t.after(() => { globalThis.fetch = originalFetch; });
    ({ runSyncForItem: runSync } = await import("../../src/services/plaid/plaidSyncService.js"));
    ({ updatePlaidBankRows: updateRows, safePlaidPersistenceDiagnostic: diagnostics } = await import("../../src/services/plaid/plaidSyncPersistence.js"));
    ({ getPlaidAccountRecoveryStatus: getRecoveryStatus } = await import("../../src/services/plaid/plaidAccountRecoveryStatus.js"));
    ({ recoverResidualPlaidOrphans: residualRecovery } = await import("../../src/services/plaid/plaidResidualRecoveryService.js"));
    ({ reconcileResidualPlaidBatch: reconcileResidual } = await import("../../src/services/plaid/plaidResidualReconciliationService.js"));
    // business_profiles uses real snapshot requirements/defaults.
    await ok(db.from("business_profiles").insert([business, otherBusiness].map(id => ({ id, business_name: "Synthetic", industry: "Synthetic", team_size: 1, state: "NC", services_offered: "Synthetic" }))));

    await t.test("original posted review upsert reproduces exact 23502; scoped UPDATE succeeds and cannot cross tenants", async () => {
      const f = await fixture(); const [row] = await ok(db.from("bank_transactions").insert(bank(f, "original-posted")).select());
      await ok(db.from("transaction_categorizations").insert({ business_id: business, transaction_id: row.id, status: "posted", qbo_txn_id: "synthetic-receipt" }));
      const patch = { id: row.id, accounting_review_required: true, accounting_review_reason: "plaid_modified_after_qbo_post" };
      const failed = await db.from("bank_transactions").upsert([patch], { onConflict: "id" });
      assert.equal(failed.error?.code, "23502");
      assert.deepEqual({ table: diagnostics(failed.error).table, column: diagnostics(failed.error).column }, { table: "bank_transactions", column: "business_id" });
      console.log("PROVEN REPRODUCTION: bank_transactions.business_id NOT NULL, SQLSTATE 23502");
      await updateRows({ db, businessId: business, rows: [patch], operation: "posted_review_update" });
      await assert.rejects(updateRows({ db, businessId: otherBusiness, rows: [patch], operation: "posted_review_update" }), /target_missing/);
      assert.equal((await ok(get("bank_transactions").eq("id", row.id)))[0].accounting_review_required, true);
    });

    await t.test("mixed new/modified/posted updates preserve decisions, provenance, matches, exclusions and receipts; retry stable", async () => {
      const f = await fixture();
      const [recovery] = await ok(db.from("plaid_recovery_batches").insert({ business_id: business,
        plaid_env: "production", plaid_item_id: f.key, cutoff_date: "2026-10-01", status: "imported_held" }).select());
      const rows = await ok(db.from("bank_transactions").insert(["modify", "posted", "match", "exclude"]
        .map(id => bank(f, id, { plaid_recovery_batch_id: recovery.id }))).select());
      for (const r of rows) await ok(db.from("transaction_categorizations").insert({ business_id: business, transaction_id: r.id,
        status: r.plaid_transaction_id === "posted" ? "posted" : r.plaid_transaction_id === "match" ? "matched" : r.plaid_transaction_id === "exclude" ? "excluded" : "approved",
        decided_by: "user", final_qbo_account_id: "retained-account", meta: { retained_decision: true },
        qbo_txn_id: r.plaid_transaction_id === "posted" ? "retained-receipt" : null,
        excluded_at: r.plaid_transaction_id === "exclude" ? "2026-11-01T00:00:00Z" : null,
        exclusion_snapshot: { decision: "retained" }, posting_hold_batch_id: recovery.id }));
      const posted = rows.find(r => r.plaid_transaction_id === "posted");
      await ok(db.from("qbo_posted_transactions").insert({ business_id: business, transaction_id: posted.id, qbo_txn_type: "Purchase", qbo_txn_id: "retained-receipt", request_id: "retained-request", idempotency_key: "retained-key", payload: { stable_request: "retained" } }));
      const before = await ok(get("transaction_categorizations").in("transaction_id", rows.map(r => r.id)));
      const receipts = await ok(get("qbo_posted_transactions").eq("transaction_id", posted.id));
      const payload = { added: [event(f, "new")], modified: [event(f, "modify", { amount: 11 }), event(f, "posted", { amount: 15 }), event(f, "match"), event(f, "exclude")] };
      assert.equal((await sync(f, payload)).ok, true);
      const after = await ok(get("transaction_categorizations").in("transaction_id", rows.map(r => r.id)));
      for (const b of before) { const a = after.find(r => r.id === b.id); for (const k of ["status", "decided_by", "final_qbo_account_id", "qbo_txn_id", "meta", "excluded_at", "exclusion_snapshot", "posting_hold_batch_id"]) assert.deepEqual(a[k], b[k]); }
      assert.deepEqual(await ok(get("qbo_posted_transactions").eq("transaction_id", posted.id)), receipts);
      const tx = await ok(get("bank_transactions").eq("plaid_item_id", f.key));
      for (const prior of rows) assert.equal(tx.find(r => r.id === prior.id).plaid_recovery_batch_id, recovery.id);
      const cats = await ok(get("transaction_categorizations").in("transaction_id", tx.map(r => r.id)));
      assert.equal(cats.length, tx.length);
      const jobs = await ok(get("bookkeeping_processing_requests").in("transaction_id", tx.map(r => r.id)));
      assert.equal(jobs.length, 5);
      await sync(f, payload);
      assert.equal((await ok(get("bank_transactions").eq("plaid_item_id", f.key))).length, 5);
      assert.deepEqual((await ok(get("bookkeeping_processing_requests").in("transaction_id", tx.map(r => r.id)))).map(r => r.id).sort(), jobs.map(r => r.id).sort());
      assert.deepEqual(await ok(get("qbo_posted_transactions").eq("transaction_id", posted.id)), receipts);
    });

    await t.test("admission failure leaves durable failed run and old cursor; successful replay clears applicable error only", async () => {
      const f = await fixture(); const payload = { added: [event(f, "orphan")] };
      await assert.rejects(sync(f, payload, failRpc(db, "complete_plaid_sync_admission")), /durable_admission_failed/);
      assert.equal((await ok(get("plaid_items").eq("id", f.item.id)))[0].cursor, "synthetic-old");
      const failed = (await ok(get("bank_sync_runs").eq("plaid_item_id", f.key)))[0];
      assert.equal(failed.status, "failed"); assert.equal(failed.meta.failure_stage, "downstream_admission");
      assert.equal((await ok(get("bank_transactions").eq("plaid_item_id", f.key))).length, 1);
      await sync(f, payload);
      const [item] = await ok(get("plaid_items").eq("id", f.item.id)); assert.equal(item.cursor, "synthetic-next"); assert.equal(item.error_code, null);
      assert.equal((await ok(get("bank_sync_runs").eq("id", failed.id)))[0].status, "failed");
      const [tx] = await ok(get("bank_transactions").eq("plaid_item_id", f.key));
      assert.equal((await ok(get("transaction_categorizations").eq("transaction_id", tx.id))).length, 1);
      assert.equal((await ok(get("bookkeeping_processing_requests").eq("transaction_id", tx.id))).length, 1);
    });

    await t.test("real queue constraint failure rolls back category, cursor and completed status atomically", async () => {
      const f = await fixture();
      sql("alter table public.bookkeeping_processing_requests add constraint test_reject_admission check (priority <> 10) not valid;");
      try { await assert.rejects(sync(f, { added: [event(f, "rollback")] }), /durable_admission_failed/); }
      finally { sql("alter table public.bookkeeping_processing_requests drop constraint test_reject_admission;"); }
      const [tx] = await ok(get("bank_transactions").eq("plaid_item_id", f.key));
      assert.equal((await ok(get("transaction_categorizations").eq("transaction_id", tx.id))).length, 0);
      const [run] = await ok(get("bank_sync_runs").eq("plaid_item_id", f.key));
      assert.equal(run.status, "failed"); assert.equal(run.meta.constraint, "test_reject_admission");
      assert.equal((await ok(get("plaid_items").eq("id", f.item.id)))[0].cursor, "synthetic-old");
      await sync(f, { added: [event(f, "rollback")] });
    });

    await t.test("categorization failure prevents admission/checkpoint, and recovery provenance and QBO intent survive retry", async () => {
      const f = await fixture();
      const [batch] = await ok(db.from("plaid_recovery_batches").insert({ business_id: business,
        plaid_env: "production", plaid_item_id: f.key, cutoff_date: "2026-10-01", status: "imported_held" }).select());
      const [tx] = await ok(db.from("bank_transactions").insert(bank(f, "provenance", { plaid_recovery_batch_id: batch.id })).select());
      const [receipt] = await ok(db.from("qbo_posted_transactions").insert({ business_id: business, transaction_id: tx.id,
        status: "unknown", qbo_txn_type: "Purchase", request_id: "preserved-unknown", idempotency_key: "preserved-intent", attempt_count: 2 }).select());
      sql("alter table public.transaction_categorizations add constraint test_reject_category check (status <> 'needs_review') not valid;");
      try { await assert.rejects(sync(f, { modified: [event(f, "provenance")] }), /durable_admission_failed/); }
      finally { sql("alter table public.transaction_categorizations drop constraint test_reject_category;"); }
      const [failed] = await ok(get("bank_sync_runs").eq("plaid_item_id", f.key));
      assert.equal(failed.meta.database_stage, "categorization_persistence");
      assert.equal(failed.meta.constraint, "test_reject_category");
      assert.equal((await ok(get("bookkeeping_processing_requests").eq("transaction_id", tx.id))).length, 0);
      assert.equal((await ok(get("plaid_items").eq("id", f.item.id)))[0].cursor, "synthetic-old");
      await sync(f, { modified: [event(f, "provenance")] });
      assert.deepEqual((await ok(get("qbo_posted_transactions").eq("id", receipt.id)))[0], receipt);
      assert.equal((await ok(get("bank_transactions").eq("id", tx.id)))[0].plaid_recovery_batch_id, batch.id);
      const [job] = await ok(get("bookkeeping_processing_requests").eq("transaction_id", tx.id));
      await ok(db.from("bookkeeping_processing_requests").update({ status: "processing", locked_by: "retained-lease", attempt_count: 3 }).eq("id", job.id));
      await assert.rejects(sync(f, { modified: [event(f, "provenance")] }), /durable_admission_failed/);
      const [after] = await ok(get("bookkeeping_processing_requests").eq("id", job.id));
      assert.equal(after.status, "processing"); assert.equal(after.locked_by, "retained-lease"); assert.equal(after.attempt_count, 3);
      await ok(db.from("bookkeeping_processing_requests").update({ status: "completed", locked_by: null }).eq("id", job.id));
      await sync(f, { modified: [event(f, "provenance")] });
      assert.equal((await ok(get("bookkeeping_processing_requests").eq("id", job.id)))[0].status, "pending");
    });

    await t.test("failure after first committed chunk is replayable without duplicate rows", async () => {
      const f = await fixture();
      const added = Array.from({ length: 202 }, (_, i) => event(f, `chunk-${i}`, { amount: i === 201 ? -9999 : 10 }));
      sql("alter table public.bank_transactions add constraint test_later_chunk check (amount <> 9999) not valid;");
      try { await assert.rejects(sync(f, { added })); }
      finally { sql("alter table public.bank_transactions drop constraint test_later_chunk;"); }
      assert.equal((await ok(get("bank_transactions").eq("plaid_item_id", f.key))).length, 200);
      assert.equal((await ok(get("plaid_items").eq("id", f.item.id)))[0].cursor, "synthetic-old");
      await sync(f, { added });
      const tx = await ok(get("bank_transactions").eq("plaid_item_id", f.key)); assert.equal(tx.length, 202);
      for (const table of ["transaction_categorizations", "bookkeeping_processing_requests"]) assert.equal((await ok(get(table).in("transaction_id", tx.map(r => r.id)))).length, 202);
    });

    await t.test("more than the API row limit still admits every persisted transaction", async () => {
      const f = await fixture();
      const added = Array.from({ length: 1002 }, (_, i) => event(f, `large-${i}`));
      const result = await sync(f, { added });
      assert.equal(result.bookkeeping_enqueued, 1002);
      assert.equal(sql(`select count(*) from public.bank_transactions bt
        join public.transaction_categorizations tc on tc.business_id=bt.business_id and tc.transaction_id=bt.id
        join public.bookkeeping_processing_requests r on r.business_id=bt.business_id and r.transaction_id=bt.id
        where bt.plaid_item_id='${f.key}'`), "1002");
    });

    await t.test("aggregate status separates partial persistence from checkpoint and clears only superseded failure", async () => {
      const f = await fixture();
      const payload = { added: [event(f, "status-orphan")] };
      await assert.rejects(sync(f, payload, failRpc(db, "complete_plaid_sync_admission")));
      const status = async () => (await getRecoveryStatus({ db, businessId: business, plaidEnv: "production" })).accounts.find(a => a.id === f.key).recovery_status;
      const failed = await status();
      assert.equal(failed.bank_connection.state, "connected");
      assert.equal(failed.transaction_import.reason_code, "internal_transaction_persistence_failure");
      assert.equal(failed.transaction_import.replay.required, true);
      assert.equal(failed.transaction_import.partial_persistence_after_checkpoint, true);
      assert.equal(failed.transaction_import.next_retry_at, null);
      assert.equal(failed.categorization_automation.missing.both, 1);
      assert.doesNotMatch(JSON.stringify(failed), /retrying automatically|Sync temporarily unavailable/);
      await sync(f, payload);
      const recovered = await status();
      assert.equal(recovered.transaction_import.state, "current");
      assert.equal(recovered.transaction_import.error_at, null);
      assert.equal(recovered.categorization_automation.missing.both, 0);
      assert.equal((await ok(get("bank_sync_runs").eq("plaid_item_id", f.key).eq("status", "failed"))).length, 1);
      const all = await getRecoveryStatus({ db, businessId: business, plaidEnv: "production" });
      assert.equal(all.accounts_count, all.accounts.length);
      for (const inst of all.institutions) assert.equal(inst.accounts_count, inst.accounts.length);
      const large = all.accounts.find(a => a.recovery_status.transaction_import.persisted_active_count === 1002);
      assert.ok(large); assert.equal(large.recovery_status.transaction_import.latest_active_transaction_date, "2026-11-01");
    });

    await t.test("provider reauthentication/outage, user review, QBO holds/auth and receipt precedence are independent", async () => {
      const f = await fixture();
      const status = async () => (await getRecoveryStatus({ db, businessId: business, plaidEnv: "production" })).accounts.find(a => a.id === f.key).recovery_status;
      await ok(db.from("plaid_items").update({ error_code: "provider_reauthentication_required", updated_at: new Date().toISOString() }).eq("id", f.item.id));
      assert.equal((await status()).bank_connection.reason_code, "plaid_reauthentication_required");
      await ok(db.from("plaid_items").update({ error_code: "provider_api_failure" }).eq("id", f.item.id));
      await ok(db.from("bank_sync_runs").insert({ business_id: business, plaid_item_id: f.key, status: "failed", failure_code: "provider_api_failure", finished_at: new Date().toISOString(), meta: { failure_stage: "provider_fetch", source_error_code: "INSTITUTION_DOWN" } }));
      assert.equal((await status()).bank_connection.reason_code, "verified_provider_outage");
      const [tx] = await ok(db.from("bank_transactions").insert(bank(f, "receipt-status")).select());
      await ok(db.from("transaction_categorizations").insert({ business_id: business, transaction_id: tx.id, status: "needs_review" }));
      await ok(db.from("bookkeeping_processing_requests").insert({ business_id: business, transaction_id: tx.id, status: "completed", processed_at: new Date().toISOString() }));
      const [receipt] = await ok(db.from("qbo_posted_transactions").insert({ business_id: business, transaction_id: tx.id, qbo_txn_type: "Purchase", status: "unknown" }).select());
      const unknown = await status();
      assert.equal(unknown.quickbooks_posting.state, "reconciling");
      assert.equal(unknown.quickbooks_posting.blockers.auto_post_disabled, true);
      assert.equal(unknown.categorization_automation.state, "needs_review");
      await ok(db.from("qbo_posted_transactions").update({ status: "failed", last_error: { code: "invalid_grant" }, last_attempt_at: new Date().toISOString() }).eq("id", receipt.id));
      assert.equal((await status()).quickbooks_posting.state, "QBO_reconnect_required");
      assert.equal((await status()).bank_connection.state, "institution_unavailable");
    });

    await t.test("residual repair requires replay, previews current targets, holds categorization and is idempotent", async () => {
      const f = await fixture(), actor = randomUUID();
      const recover = (args = {}) => residualRecovery({ db, businessId: business, plaidEnv: "production", plaidAccountId: f.key, actorUserId: actor, ...args });
      const beforeReplay = await recover(); assert.equal(beforeReplay.ready, false); assert.equal(beforeReplay.dry_run, true);
      const events = [event(f,"residual-replayed"),event(f,"residual-eligible"),event(f,"residual-pending",{pending:true}),
        event(f,"residual-receipt"),event(f,"residual-loan",{name:"LOAN PAYMENT"}),event(f,"residual-duplicate",{possible_qbo_duplicate:true})];
      await assert.rejects(sync(f, { added: events }, failRpc(db,"complete_plaid_sync_admission")));
      const rows = await ok(get("bank_transactions").eq("plaid_item_id",f.key));
      const receiptRow = rows.find(r=>r.plaid_transaction_id==="residual-receipt");
      const [receipt] = await ok(db.from("qbo_posted_transactions").insert({ business_id:business,transaction_id:receiptRow.id,qbo_txn_type:"Purchase",status:"pending",request_id:"residual-protected" }).select());
      await sync(f,{added:[events[0]]});
      const preview = await recover(); assert.equal(preview.ready,true); assert.equal(preview.before.initial_target_count,5); assert.equal(preview.before.eligible_count,1);
      assert.equal(preview.before.classifications.pending_transaction,1);
      assert.equal(preview.before.classifications.existing_posting_intent_or_receipt,1);
      assert.equal(preview.before.classifications.possible_qbo_duplicate,1);
      assert.equal((await ok(get("transaction_categorizations").in("transaction_id",rows.slice(1).map(r=>r.id)))).length,0);
      await ok(db.from("business_profiles").update({auto_post_to_quickbooks:true}).eq("id",business));
      await assert.rejects(recover({execute:true,batchId:preview.batch_id}),/disable_posting_required/);
      await ok(db.from("business_profiles").update({auto_post_to_quickbooks:false}).eq("id",business));
      const applied = await recover({execute:true,batchId:preview.batch_id});
      assert.equal(applied.newly_applied_count,1); assert.equal(applied.after.initial_target_count,4); assert.equal(applied.after.eligible_count,0);
      const [cat] = await ok(get("transaction_categorizations").eq("posting_hold_batch_id",preview.batch_id));
      assert.equal(cat.status,"needs_review"); assert.equal(cat.post_after,null);
      assert.equal((await ok(get("plaid_recovery_batches").eq("id",preview.batch_id)))[0].posting_hold,true);
      assert.deepEqual((await ok(get("qbo_posted_transactions").eq("id",receipt.id)))[0],receipt);
      assert.equal((await recover({execute:true,batchId:preview.batch_id})).newly_applied_count,0);
      const cleared = await db.from("transaction_categorizations").update({posting_hold_batch_id:null}).eq("id",cat.id);
      assert.equal(cleared.error?.code,"42501");
      const released = await db.from("plaid_recovery_batches").update({posting_hold:false,status:"released"}).eq("id",preview.batch_id);
      assert.equal(released.error?.code,"42501");
      assert.equal((await ok(get("bank_transactions").eq("plaid_item_id",f.key))).length,6);
      await assert.rejects(recover({execute:true,batchId:preview.batch_id,actorUserId:randomUUID()}),/scope_mismatch/);
    });

    await t.test("fresh previews reject new receipt conflicts and expiry without creating admission", async () => {
      const f = await fixture(), actor = randomUUID();
      const events=[event(f,"fresh-replay"),event(f,"fresh-orphan")];
      await assert.rejects(sync(f,{added:events},failRpc(db,"complete_plaid_sync_admission")));
      await sync(f,{added:[events[0]]});
      const args={db,businessId:business,plaidEnv:"production",plaidAccountId:f.key,actorUserId:actor};
      const preview=await residualRecovery(args);
      const [orphan]=await ok(get("bank_transactions").eq("plaid_item_id",f.key).eq("plaid_transaction_id","fresh-orphan"));
      await ok(db.from("qbo_posted_transactions").insert({business_id:business,transaction_id:orphan.id,qbo_txn_type:"Purchase",status:"unknown"}));
      await assert.rejects(residualRecovery({...args,execute:true,batchId:preview.batch_id}),/preview_stale/);
      const [batch]=await ok(get("plaid_recovery_batches").eq("id",preview.batch_id));
      await ok(db.from("plaid_recovery_batches").update({summary:{...batch.summary,preview_at:"2000-01-01T00:00:00Z"}}).eq("id",batch.id));
      await assert.rejects(residualRecovery({...args,execute:true,batchId:batch.id}),/fresh_preview_required/);
      assert.equal((await ok(get("transaction_categorizations").eq("transaction_id",orphan.id))).length,0);
      await assert.rejects(residualRecovery({...args,businessId:otherBusiness}),/account_not_found/);
    });

    await t.test("active processing and dead-letter conflicts block admission and project distinct reasons",async()=>{
      const f=await fixture(); const [tx]=await ok(db.from("bank_transactions").insert(bank(f,"conflict-status")).select());
      await ok(db.from("transaction_categorizations").insert({business_id:business,transaction_id:tx.id,status:"needs_review"}));
      const [job]=await ok(db.from("bookkeeping_processing_requests").insert({business_id:business,transaction_id:tx.id,status:"processing",locked_by:"retained",locked_at:new Date().toISOString()}).select());
      const status=async()=> (await getRecoveryStatus({db,businessId:business,plaidEnv:"production"})).accounts.find(a=>a.id===f.key).recovery_status;
      await assert.rejects(sync(f,{modified:[event(f,"conflict-status")]}));
      assert.equal((await status()).categorization_automation.reason_code,"active_processing_lease");
      const previewArgs={db,businessId:business,plaidEnv:"production",plaidAccountId:f.key,actorUserId:randomUUID()};
      const leasePreview=await residualRecovery(previewArgs);
      assert.equal(leasePreview.before.classifications.active_processing_lease,1);
      assert.equal(leasePreview.before.initial_target_count,0);
      await ok(db.from("bookkeeping_processing_requests").update({status:"dead_letter",error_code:"23514"}).eq("id",job.id));
      await assert.rejects(sync(f,{modified:[event(f,"conflict-status")]}));
      assert.equal((await status()).categorization_automation.reason_code,"unresolved_dead_letter");
      assert.equal((await residualRecovery(previewArgs)).before.classifications.unresolved_dead_letter,1);
      assert.equal((await ok(get("bookkeeping_processing_requests").eq("id",job.id)))[0].locked_by,"retained");
    });

    await t.test("residual preview/apply aggregates and repairs over 1000 rows without automatic posting",async()=>{
      const f=await fixture(),actor=randomUUID();
      const events=Array.from({length:1003},(_,i)=>event(f,`residual-large-${i}`));
      await assert.rejects(sync(f,{added:events},failRpc(db,"complete_plaid_sync_admission")));
      await sync(f,{added:[events[0]]});
      const args={db,businessId:business,plaidEnv:"production",plaidAccountId:f.key,actorUserId:actor};
      const preview=await residualRecovery(args); assert.equal(preview.before.eligible_count,1002); assert.equal(preview.before.initial_targets.length,1002);
      const applied=await residualRecovery({...args,execute:true,batchId:preview.batch_id});
      assert.equal(applied.newly_applied_count,1002); assert.equal(applied.after.initial_target_count,0);
      assert.equal(sql(`select count(*) from public.transaction_categorizations where posting_hold_batch_id='${preview.batch_id}' and post_after is null`),"1002");
      assert.equal(sql(`select count(*) from public.qbo_posted_transactions q join public.bank_transactions bt on bt.id=q.transaction_id where bt.plaid_item_id='${f.key}'`),"0");
      assert.equal((await residualRecovery({...args,execute:true,batchId:preview.batch_id})).newly_applied_count,0);
    });

    await t.test("retry times require durable failed work and proven eligibility; disconnected siblings do not inherit checkpoints",async()=>{
      const f=await fixture();
      await sync(f,{added:[event(f,"retry-status")]});
      const [tx]=await ok(get("bank_transactions").eq("plaid_item_id",f.key));
      const future=new Date(Date.now()+3600000).toISOString();
      await ok(db.from("bookkeeping_processing_requests").update({status:"failed",attempt_count:1,process_after:future,error_code:"23514"}).eq("transaction_id",tx.id));
      const status=async(eligibility={})=>(await getRecoveryStatus({db,businessId:business,plaidEnv:"production",eligibility})).accounts.find(a=>a.id===f.key).recovery_status;
      assert.equal((await status()).categorization_automation.next_retry_at,null);
      assert.equal(Date.parse((await status({paid_entitlement:true,processing_worker_enabled:true})).categorization_automation.next_retry_at),Date.parse(future));
      // Failed categorization remains an error; a scheduled retry is separately
      // exposed only with policy/worker eligibility verified by the caller.
      const sibling=randomUUID();
      await ok(db.from("plaid_accounts").insert({business_id:business,plaid_item_id:f.key,plaid_account_id:sibling,plaid_env:"production",name:"Disconnected sibling",is_active:false,connection_state:"disconnected"}));
      await sync(f,{});
      const all=await getRecoveryStatus({db,businessId:business,plaidEnv:"production"});
      const disconnected=all.accounts.find(a=>a.id===sibling).recovery_status;
      assert.equal(disconnected.transaction_import.state,"paused"); assert.equal(disconnected.transaction_import.last_completed_checkpoint_at,null);
      await ok(db.from("plaid_items").update({institution_id:"shared-test-institution",institution_name:"Shared"}).eq("id",f.item.id));
      const grouped=await getRecoveryStatus({db,businessId:business,plaidEnv:"production"});
      const inst=grouped.institutions.find(i=>i.institution_id==="shared-test-institution");
      assert.equal(inst.accounts_count,2); assert.equal(inst.syncing_accounts_count,1);
    });

    await t.test("legacy status adapter exposes nonzero account totals and cannot release a residual hold",async()=>{
      const {getPlaidStatus}=await import("../../src/services/plaid/plaidIntegrationService.js");
      const legacy=await getPlaidStatus({businessId:business});
      assert.equal(legacy.accounts_count,legacy.account_recovery.accounts_count);
      for(const inst of legacy.institutions) assert.equal(inst.accounts_count,inst.accounts.length);
      const [batch]=await ok(get("plaid_recovery_batches").eq("status","imported_held").eq("summary->>workflow_kind","residual_orphan").limit(1));
      const {releaseReplacementRecoveryHold}=await import("../../src/services/plaid/plaidReplacementRecoveryService.js");
      await assert.rejects(releaseReplacementRecoveryHold({businessId:business,batchId:batch.id,actorUserId:batch.created_by,db}),/Residual recovery holds/);
    });

    await t.test("browser roles cannot invoke recovery authority RPCs",async()=>{
      const browserToken=await new SignJWT({role:"authenticated"}).setProtectedHeader({alg:"HS256"}).setExpirationTime("1h").sign(Buffer.from(secret));
      const browser=createClient(url,browserToken,{auth:{persistSession:false},global:{fetch:(...args)=>globalThis.fetch(...args)}});
      const response=await browser.rpc("get_plaid_account_recovery_facts",{p_business_id:business,p_plaid_env:"production",p_qbo_env:"production"});
      assert.ok(["42501","PGRST202"].includes(response.error?.code));
    });

    await t.test("operator reconciliation smoke: categorization preserves hold and exact release has no posting side effects",async()=>{
      const f=await fixture(),actor=randomUUID();
      sql(`insert into auth.users(id) values ('${actor}');`);
      await ok(db.from("internal_staff_users").insert({user_id:actor,role:"operator"}));
      const events=[event(f,"reconcile-replayed"),event(f,"reconcile-safe")];
      await assert.rejects(sync(f,{added:events},failRpc(db,"complete_plaid_sync_admission")));
      await sync(f,{added:[events[0]]});
      const args={db,businessId:business,plaidEnv:"production",plaidAccountId:f.key,actorUserId:actor};
      const rp=await residualRecovery(args); const admitted=await residualRecovery({...args,execute:true,batchId:rp.batch_id});
      assert.equal(admitted.newly_applied_count,1);
      const [cat]=await ok(get("transaction_categorizations").eq("posting_hold_batch_id",rp.batch_id));
      // Simulate the ordinary asynchronous worker's durable result; no worker is started.
      await ok(db.from("transaction_categorizations").update({status:"auto_approved",final_qbo_account_id:"reviewed-destination"}).eq("id",cat.id));
      await ok(db.from("bookkeeping_processing_requests").update({status:"completed",attempt_count:1,processed_at:new Date().toISOString()}).eq("transaction_id",cat.transaction_id));
      const [beforeCat]=await ok(get("transaction_categorizations").eq("id",cat.id));
      const beforeJobs=await ok(get("bookkeeping_processing_requests").eq("transaction_id",cat.transaction_id));
      const rargs={...args,batchId:rp.batch_id}; const preview=await reconcileResidual(rargs);
      assert.equal(preview.before.held_count,1); assert.equal(preview.before.rows[0].classification,"safe_for_reviewed_release");
      assert.equal((await reconcileResidual(rargs)).manifest_id,preview.manifest_id);
      const confirm={...rargs,execute:true,manifestId:preview.manifest_id,reviewedTransactionIds:[cat.transaction_id]};
      await assert.rejects(reconcileResidual(confirm),/live_qbo_attestation_required/);
      const attestation={performed:true,ledger:"quickbooks_live",outcome:"no_unrepresented_duplicate",reviewed_at:new Date().toISOString()};
      const released=await reconcileResidual({...confirm,liveQboAttestation:attestation});
      assert.equal(released.newly_released_count,1); assert.equal(released.after.held_count,0);
      const [afterCat]=await ok(get("transaction_categorizations").eq("id",cat.id));
      for(const key of Object.keys(beforeCat).filter(k=>!["posting_hold_batch_id","updated_at"].includes(k))) assert.deepEqual(afterCat[key],beforeCat[key],key);
      assert.equal(afterCat.posting_hold_batch_id,null); assert.equal(afterCat.post_after,null);
      assert.deepEqual(await ok(get("bookkeeping_processing_requests").eq("transaction_id",cat.transaction_id)),beforeJobs);
      const replay=await reconcileResidual({...confirm,liveQboAttestation:attestation}); assert.equal(replay.idempotent,true); assert.equal(replay.newly_released_count,0);
      assert.equal((await ok(get("qbo_posted_transactions").eq("transaction_id",cat.transaction_id))).length,0);
      assert.equal((await ok(db.from("business_profiles").select("auto_post_to_quickbooks").eq("id",business)))[0].auto_post_to_quickbooks,false);
      const state=(await getRecoveryStatus({db,businessId:business,plaidEnv:"production"})).accounts.find(a=>a.id===f.key).recovery_status;
      assert.equal(state.quickbooks_posting.state,"held"); assert.equal(state.quickbooks_posting.held_count,0);
      assert.doesNotMatch(JSON.stringify(state),/attestation|residual_reconciliations|confirmed_by/);
    });

    await t.test("exact partial release classifies every held row and preserves blocked evidence and posting state",async()=>{
      const c=await appliedReconciliationCohort(17),ids=c.ids;
      const initial=await reconcileResidual(c.args); assert.equal(initial.before.held_count,17);
      assert.equal(initial.before.classifications.categorization_processing,17);
      await finishSyntheticCategorization(ids);
      const patchCat=(i,patch)=>ok(db.from("transaction_categorizations").update(patch).eq("transaction_id",ids[i]));
      const patchJob=(i,patch)=>ok(db.from("bookkeeping_processing_requests").update(patch).eq("transaction_id",ids[i]));
      for(const [i,status] of [[1,"pending"],[2,"unknown"],[13,"failed"]]) await ok(db.from("qbo_posted_transactions").insert({business_id:business,transaction_id:ids[i],qbo_txn_type:"Purchase",status}));
      await patchJob(3,{status:"processing",locked_at:new Date().toISOString(),locked_by:"active-lease"});
      await patchJob(4,{status:"processing",locked_at:"2000-01-01T00:00:00Z",locked_by:"stale-lease"});
      await patchJob(5,{status:"dead_letter",attempt_count:5,error_code:"23514"});
      for(const i of [6,15]){
        const [cat]=await ok(get("transaction_categorizations").eq("transaction_id",ids[i]));
        await patchCat(i,{status:"needs_review",final_qbo_account_id:null,decided_by:i===15?"user":"bizzi",decided_at:new Date().toISOString(),
          meta:{...cat.meta,review_reopen_authorized:true,review_reopen_reason:"new_human_decision_required"}});
      }
      await patchCat(7,{status:"excluded",excluded_at:new Date().toISOString(),decided_by:"user",decided_at:new Date().toISOString()});
      await patchCat(8,{status:"matched",reconciled_at:new Date().toISOString()});
      await patchCat(9,{status:"posted",qbo_txn_id:"existing-posted",posted_at:new Date().toISOString()});
      await ok(db.from("qbo_posted_transactions").insert({business_id:business,transaction_id:ids[9],qbo_txn_type:"Purchase",status:"posted",qbo_txn_id:"existing-posted"}));
      await patchCat(10,{status:"handled",decided_by:"user",decided_at:new Date().toISOString()});
      const [duplicate]=await ok(get("transaction_categorizations").eq("transaction_id",ids[11]));
      await patchCat(11,{meta:{...duplicate.meta,possible_qbo_duplicate:true}});
      await ok(db.from("bank_transactions").update({transaction_type:"loan",is_archived:true,archived_at:new Date().toISOString()}).eq("id",ids[12]));
      await patchJob(14,{status:"pending"});
      await patchCat(16,{status:"ignored",decided_by:"user",decided_at:new Date().toISOString()});
      const preview=await reconcileResidual(c.args),classes=preview.before.classifications;
      for(const name of ["categorization_processing","categorization_lease_active","categorization_lease_stale","unresolved_dead_letter","needs_user_review",
        "excluded_or_personal","matched_existing_qbo","handled_without_posting","existing_posted_receipt","pending_qbo_receipt","unknown_qbo_receipt","failed_qbo_attempt",
        "possible_qbo_duplicate","protected_workflow","safe_for_reviewed_release"]) assert.ok(classes[name]>0,name);
      const status=async()=> (await getRecoveryStatus({db,businessId:business,plaidEnv:"production"})).accounts.find(a=>a.id===c.key).recovery_status;
      assert.equal((await status()).quickbooks_posting.affected_count,17);
      const selected=[0,7,8,9,10,16].map(i=>ids[i]);
      const confirmation={...c.args,execute:true,manifestId:preview.manifest_id,reviewedTransactionIds:selected};
      await assert.rejects(reconcileResidual(confirmation),/live_qbo_attestation_required/);
      await assert.rejects(reconcileResidual({...confirmation,reviewedTransactionIds:[ids[6]],liveQboAttestation:attestation()}),/selected_row_blocked/);
      await assert.rejects(reconcileResidual({...confirmation,liveQboAttestation:{...attestation(),credentials:"FORBIDDEN"}}),/safe_attestation_required/);
      await ok(db.from("business_profiles").update({auto_post_to_quickbooks:true}).eq("id",business));
      await assert.rejects(reconcileResidual({...confirmation,liveQboAttestation:attestation()}),/disable_posting_required/);
      await ok(db.from("business_profiles").update({auto_post_to_quickbooks:false}).eq("id",business));
      await ok(db.from("plaid_items").update({sync_in_progress:true,sync_lease_owner:"another-sync"}).eq("id",c.item.id));
      await assert.rejects(reconcileResidual({...confirmation,liveQboAttestation:attestation()}),/sync_lease_conflict/);
      await ok(db.from("plaid_items").update({sync_in_progress:false,sync_lease_owner:null}).eq("id",c.item.id));
      const before={};
      for(const table of ["bank_transactions","transaction_categorizations","bookkeeping_processing_requests","qbo_posted_transactions","bookkeeping_posting_jobs"])
        before[table]=await ok(get(table).in(table==="bank_transactions"?"id":"transaction_id",ids).order("id"));
      const result=await reconcileResidual({...confirmation,liveQboAttestation:attestation()});
      assert.equal(result.newly_released_count,6); assert.equal(result.before.held_count,17); assert.equal(result.after.held_count,11);
      const afterCats=await ok(get("transaction_categorizations").in("transaction_id",ids).order("id"));
      for(const cat of afterCats){
        const old=before.transaction_categorizations.find(r=>r.id===cat.id);
        for(const key of Object.keys(old).filter(k=>!["posting_hold_batch_id","updated_at"].includes(k))) assert.deepEqual(cat[key],old[key],key);
        assert.equal(cat.posting_hold_batch_id,selected.includes(cat.transaction_id)?null:c.batchId);
        assert.equal(cat.post_after,null);
      }
      for(const table of ["bank_transactions","bookkeeping_processing_requests","qbo_posted_transactions","bookkeeping_posting_jobs"])
        assert.deepEqual(await ok(get(table).in(table==="bank_transactions"?"id":"transaction_id",ids).order("id")),before[table],table);
      const projected=await status(); assert.equal(projected.quickbooks_posting.state,"reconciling"); assert.equal(projected.quickbooks_posting.held_count,11); assert.equal(projected.quickbooks_posting.affected_count,11);
      assert.doesNotMatch(JSON.stringify(projected),/quickbooks_live|attestation|confirmed_by|approved_ids/);
      const [batch]=await ok(get("plaid_recovery_batches").eq("id",c.batchId));
      const audit=batch.summary.residual_reconciliations[preview.manifest_id];
      assert.equal(audit.confirmed_by,c.actor); assert.equal(audit.attestation.performed,true); assert.equal(audit.result.released_transaction_ids.length,6);
      const direct=await db.from("transaction_categorizations").update({posting_hold_batch_id:null}).eq("transaction_id",ids[11]); assert.equal(direct.error?.code,"42501");
      const helper=await db.rpc("clear_approved_plaid_residual_holds",{p_business_id:business,p_batch_id:c.batchId,p_manifest_id:preview.manifest_id,p_ids:[ids[11]]}); assert.ok(helper.error);
      const {releaseReplacementRecoveryHold}=await import("../../src/services/plaid/plaidReplacementRecoveryService.js");
      await assert.rejects(releaseReplacementRecoveryHold({businessId:business,batchId:c.batchId,actorUserId:c.actor,db}),/Residual recovery holds/);
    });

    await t.test("changed reconciliation evidence and expired manifests reject release atomically",async()=>{
      const c=await appliedReconciliationCohort(1),id=c.ids[0]; await finishSyntheticCategorization(c.ids);
      let matchId,pairId;
      const modifications=[
        ()=>ok(db.from("bank_transactions").update({amount:-11}).eq("id",id)),
        ()=>ok(db.from("transaction_categorizations").update({reason:"updated evidence"}).eq("transaction_id",id)),
        ()=>ok(db.from("bookkeeping_processing_requests").update({priority:20}).eq("transaction_id",id)),
        ()=>ok(db.from("bookkeeping_posting_jobs").update({blocking_code:"changed_blocker"}).eq("transaction_id",id)),
        ()=>ok(db.from("qbo_posted_transactions").insert({business_id:business,transaction_id:id,qbo_txn_type:"Purchase",status:"unknown"})),
        async()=>{const [row]=await ok(get("plaid_recovery_batch_rows").eq("batch_id",c.batchId)); await ok(db.from("plaid_recovery_batch_rows").update({payload:{...row.payload,evidence_changed:true}}).eq("id",row.id));},
        ()=>ok(db.from("bookkeeping_post_attempts").insert({business_id:business,transaction_id:id,status:"failed",error_message:"synthetic_failure"})),
        async()=>{const [m]=await ok(db.from("bank_qbo_matches").insert({business_id:business,bank_transaction_id:id,status:"candidate",match_type:"unavailable",confidence_tier:"unavailable",gross_bank_amount_minor:1000,bank_account_match:"unavailable"}).select()); matchId=m.id;},
        ()=>ok(db.from("bank_qbo_match_items").insert({business_id:business,match_id:matchId,qbo_entity_type:"Payment",qbo_entity_id:"synthetic-existing"})),
        ()=>ok(db.from("bank_qbo_match_history").insert({business_id:business,match_id:matchId,bank_transaction_id:id,action:"synthetic_review"})),
        async()=>{const [pair]=await ok(db.from("credit_card_payment_pairs").insert({business_id:business,checking_transaction_id:id,checking_plaid_account_id:c.key,checking_qbo_account_id:"10",credit_card_qbo_account_id:"19",amount:10,status:"needs_review"}).select());pairId=pair.id;},
        ()=>ok(db.from("credit_card_payment_pair_events").insert({business_id:business,pair_id:pairId,transaction_id:id,event_type:"confirmed",actor:"synthetic_operator"})),
      ];
      for(const mutate of modifications){
        const p=await reconcileResidual(c.args); await mutate();
        await assert.rejects(reconcileResidual({...c.args,execute:true,manifestId:p.manifest_id,reviewedTransactionIds:c.ids,liveQboAttestation:attestation()}),error=>error.code==="plaid_reconciliation_evidence_changed"&&error.details.classification==="evidence_changed");
      }
      const preview=await reconcileResidual(c.args); const [batch]=await ok(get("plaid_recovery_batches").eq("id",c.batchId));
      batch.summary.residual_reconciliations[preview.manifest_id].expires_at="2000-01-01T00:00:00Z";
      await ok(db.from("plaid_recovery_batches").update({summary:batch.summary}).eq("id",batch.id));
      await assert.rejects(reconcileResidual({...c.args,execute:true,manifestId:preview.manifest_id,reviewedTransactionIds:c.ids,liveQboAttestation:attestation()}),/manifest_expired/);
      assert.equal((await ok(get("transaction_categorizations").eq("transaction_id",id)))[0].posting_hold_batch_id,c.batchId);
    });

    await t.test("operator and tenant boundaries, exact account/batch, and browser denial apply to reconciliation",async()=>{
      const c=await appliedReconciliationCohort(1); await finishSyntheticCategorization(c.ids);
      await assert.rejects(reconcileResidual({...c.args,actorUserId:randomUUID()}),/operator_required/);
      for(const change of [{businessId:otherBusiness},{plaidAccountId:randomUUID()},{batchId:randomUUID()},{plaidEnv:"sandbox"}]) await assert.rejects(reconcileResidual({...c.args,...change}),/scope_or_admission_invalid/);
      const p=await reconcileResidual(c.args); const other=await appliedReconciliationCohort(1);
      await assert.rejects(reconcileResidual({...other.args,execute:true,manifestId:p.manifest_id,reviewedTransactionIds:other.ids,liveQboAttestation:attestation()}),/manifest_scope_invalid/);
      const browserToken=await new SignJWT({role:"authenticated"}).setProtectedHeader({alg:"HS256"}).setExpirationTime("1h").sign(Buffer.from(secret));
      const browser=createClient(url,browserToken,{auth:{persistSession:false},global:{fetch:(...args)=>globalThis.fetch(...args)}});
      const response=await browser.rpc("preview_plaid_residual_reconciliation",{p_business_id:business,p_plaid_env:"production",p_account_id:c.key,p_batch_id:c.batchId,p_actor_id:c.actor});
      assert.ok(["42501","PGRST202"].includes(response.error?.code));
      const deniedRelease=await browser.rpc("release_plaid_residual_reconciliation",{p_business_id:business,p_plaid_env:"production",p_account_id:c.key,p_batch_id:c.batchId,p_actor_id:c.actor,p_manifest_id:p.manifest_id,p_reviewed_ids:c.ids,p_execute:true});
      assert.ok(["42501","PGRST202"].includes(deniedRelease.error?.code));
      assert.equal(sql("select has_function_privilege('service_role','public.clear_approved_plaid_residual_holds(uuid,uuid,uuid,uuid[])','EXECUTE')"),"f");
      assert.equal(sql("select pg_has_role('service_role','plaid_residual_hold_executor','MEMBER')"),"f");
      assert.equal(sql("select has_table_privilege('plaid_residual_hold_executor','public.qbo_posted_transactions','UPDATE')"),"f");
      const {resolveInternalStaff}=await import("../../src/api/_shared/internalStaffAuth.js");
      await assert.rejects(resolveInternalStaff({req:{auth:{userId:randomUUID()},body:{role:"operator",actor_id:c.actor}},supabase:db}));
      const {residualReconciliationHandler}=await import("../../src/api/integrations/plaidResidualReconciliation.controller.js");
      let body,code=200; const res={status(n){code=n;return this;},json(v){body=v;return this;}};
      await residualReconciliationHandler({db,plaidEnv:"production"})({auth:{userId:c.actor,businessId:business},business:{id:business},internalStaff:{userId:c.actor},params:{plaidAccountId:c.key,batchId:c.batchId},body:{business_id:otherBusiness,actor_id:other.actor,execute:"true"}},res);
      assert.equal(code,200); assert.equal(body.dry_run,true); assert.equal(body.actor_id,c.actor); assert.equal(body.business_id,business);
    });

    await t.test("over 1000 reviewed releases preserve every receipt/request and never schedule posting",async()=>{
      const c=await appliedReconciliationCohort(1002); await finishSyntheticCategorization(c.ids);
      const p=await reconcileResidual(c.args); assert.equal(p.before.row_count,1002); assert.equal(p.before.releasable_count,1002);
      const a=attestation(); const confirmation={...c.args,execute:true,manifestId:p.manifest_id,reviewedTransactionIds:c.ids,liveQboAttestation:a};
      const result=await reconcileResidual(confirmation); assert.equal(result.newly_released_count,1002); assert.equal(result.after.held_count,0);
      assert.equal((await reconcileResidual(confirmation)).newly_released_count,0);
      assert.equal(sql(`select count(*) from public.transaction_categorizations where transaction_id=any(array[${c.ids.map(id=>`'${id}'::uuid`).join(",")}]) and posting_hold_batch_id is null and post_after is null`),"1002");
      assert.equal(sql(`select count(*) from public.qbo_posted_transactions q join public.bank_transactions bt on bt.id=q.transaction_id where bt.plaid_item_id='${c.key}'`),"0");
      const status=(await getRecoveryStatus({db,businessId:business,plaidEnv:"production"})).accounts.find(a=>a.id===c.key).recovery_status;
      assert.equal(status.quickbooks_posting.state,"held"); assert.equal(status.quickbooks_posting.reason_code,"auto_post_disabled"); assert.equal(status.quickbooks_posting.affected_count,0);
    });

    await t.test("pending-to-posted merge keeps local identity; removed unposted archives; posted removal preserves receipt", async () => {
      const f = await fixture();
      const rows = await ok(db.from("bank_transactions").insert([bank(f, "pending", { pending: true }), bank(f, "remove"), bank(f, "remove-posted")]).select());
      const pending = rows[0];
      for (const r of rows) await ok(db.from("transaction_categorizations").insert({ business_id: business, transaction_id: r.id, status: r === rows[2] ? "posted" : "needs_review", qbo_txn_id: r === rows[2] ? "keep" : null }));
      await sync(f, { added: [event(f, "settled", { pending_transaction_id: "pending" })], removed: [{ transaction_id: "pending" }, { transaction_id: "remove" }, { transaction_id: "remove-posted" }] });
      const tx = await ok(get("bank_transactions").eq("plaid_item_id", f.key)); assert.equal(tx.length, 3);
      const settled = tx.find(r => r.id === pending.id); assert.equal(settled.plaid_transaction_id, "settled"); assert.equal(settled.pending, false); assert.equal(settled.is_archived, false);
      assert.equal(tx.find(r => r.plaid_transaction_id === "remove").is_archived, true);
      const posted = tx.find(r => r.plaid_transaction_id === "remove-posted"); assert.equal(posted.is_archived, false); assert.equal(posted.accounting_review_required, true);
      assert.equal((await ok(get("transaction_categorizations").eq("transaction_id", posted.id)))[0].qbo_txn_id, "keep");
    });
  } finally {
    for (const resource of [apiName, name]) spawnSync("docker", ["rm", "-f", "-v", resource]);
    spawnSync("docker", ["network", "rm", network]);
  }
});
