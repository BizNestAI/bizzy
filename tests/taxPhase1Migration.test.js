/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260923_tax_phase1_contract_repair.sql"),
  "utf8"
);

test("Tax Phase 1 migration adds conservative requires_review classification contract", () => {
  assert.match(migration, /alter table(?: if exists)? public\.transaction_tax_classifications\s+add column if not exists requires_review boolean/i);
  assert.match(migration, /set default true/i);
  assert.match(migration, /set not null/i);
  assert.match(migration, /where requires_review is null/i);
  assert.doesNotMatch(migration, /insert\s+into\s+public\.transaction_tax_classifications/i);
  assert.doesNotMatch(migration, /delete\s+from\s+public\.transaction_tax_classifications/i);
});
