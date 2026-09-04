/* global process */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const MIGRATION = "supabase/migrations/20260924_tax_profile_first_save_contract.sql";

test("tax profile first-save migration makes unknown optional facts nullable without backfilling values", () => {
  const sql = fs.readFileSync(path.join(process.cwd(), MIGRATION), "utf8");
  const nullableColumns = [
    "federal_withholding_ytd",
    "state_withholding_ytd",
    "health_insurance_deduction_ytd",
    "retirement_contributions_ytd",
    "hsa_contributions_ytd",
    "reserve_buffer_percent",
  ];

  for (const column of nullableColumns) {
    assert.match(sql, new RegExp(`alter column ${column} drop default`, "i"));
    assert.match(sql, new RegExp(`alter column ${column} drop not null`, "i"));
    assert.match(sql, new RegExp(`comment on column public\\.tax_profiles\\.${column}`, "i"));
  }

  assert.doesNotMatch(sql, /\bupdate\s+public\.tax_profiles\b/i);
  assert.doesNotMatch(sql, /\bdelete\s+from\s+public\.tax_profiles\b/i);
  assert.doesNotMatch(sql, /\bdrop\s+table\b/i);
  assert.match(sql, /notify\s+pgrst,\s*'reload schema'/i);
});
