import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import process from "node:process";
import test from "node:test";
import { vehicleDatabase } from "./fixtures/vehicleDatabase.js";
const container = process.env.TAX_VEHICLE_TEST_CONTAINER;
test("production-shaped PostgreSQL vehicle amendments are atomic, authoritative and retry safe", { skip: !container }, () => {
  const db = vehicleDatabase();
  try {
    const result = db.check(db.sql(readFileSync("tests/fixtures/vehicleCommands.assert.sql", "utf8")));
    assert.match(result.stderr, /PASS vehicle commands:/);
  } finally { db.cleanup(); }
});

test("original grouped 76/70/six path survives the new database method guards", { skip: !container }, () => {
  const db = vehicleDatabase({ seed: "" });
  try {
    let fixture = readFileSync("tests/fixtures/vehicleDeduction.assert.sql", "utf8");
    fixture = fixture.replace("business_profiles(id) values", "business_profiles(id,user_id,business_name,industry,team_size,state,services_offered) values");
    for (const id of ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"]) fixture = fixture.replace(`('${id}')`, `('${id}','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Synthetic','test',1,'NC','test')`);
    fixture = fixture.replace("bank_transactions(id,business_id)", "bank_transactions(id,business_id,plaid_item_id,plaid_account_id,plaid_transaction_id,date,name,amount)").replace("select gen_random_uuid(),b from generate_series(1,76)", "select gen_random_uuid(),b,'test','test',gen_random_uuid()::text,date '2026-06-15','Synthetic Gas',51 from generate_series(1,76)");
    fixture = fixture.replace("set user_override=true,classification_status", "set source='user',user_override=true,classification_status");
    fixture = fixture.replaceAll('"rule_code":"fixture_vehicle","tax_category":"vehicle_expense"', '"rule_code":"fixture_vehicle","explanation":"Synthetic vehicle decision","version":"test","tax_category":"vehicle_expense"');
    db.check(db.sql(fixture));
  } finally { db.cleanup(); }
});
