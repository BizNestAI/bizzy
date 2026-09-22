import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { sortMonthlyReconciliationRows } from "../src/services/bookkeeping/reconciliationAuditSort.js";

const root = fileURLToPath(new URL("..", import.meta.url));

test("reconciliation audit sorts bank accounts before pagination with stable date ordering", () => {
  const rows = [
    { id: "2", bank_account: "Checking •••2222", txn_date: "2026-08-03", amount: -2 },
    { id: "1", bank_account: "Blue Cash •••1008", txn_date: "2026-08-01", amount: -1 },
    { id: "3", bank_account: "Blue Cash •••1008", txn_date: "2026-08-04", amount: -3 },
  ];

  assert.deepEqual(
    sortMonthlyReconciliationRows(rows, "bank_account", "asc").map((row) => row.id),
    ["3", "1", "2"]
  );
  assert.deepEqual(rows.map((row) => row.id), ["2", "1", "3"]);
});

test("reconciliation audit exposes accessible sortable headers and sends server sort parameters", () => {
  const table = readFileSync(join(root, "src/components/Accounting/ReconciliationAuditTable.jsx"), "utf8");
  const page = readFileSync(join(root, "src/pages/accounting/Reconciliations.jsx"), "utf8");
  const route = readFileSync(join(root, "src/api/bookkeeping/routes/bookkeeping.reconciliations.routes.js"), "utf8");
  const service = readFileSync(join(root, "src/services/bookkeeping/monthlyReconciliationPipelineService.js"), "utf8");

  for (const key of ["date", "transaction", "bank_account", "amount", "category", "pipeline_status"]) {
    assert.match(table, new RegExp(`sortKey=\\"${key}\\"`));
  }
  assert.match(table, /aria-sort=/);
  assert.match(table, /focus-visible:ring-2/);
  assert.match(page, /sort_by:\s*auditSort\.key/);
  assert.match(page, /sort_direction:\s*auditSort\.direction/);
  assert.match(route, /sort_by:\s*sortBy/);
  assert.match(service, /sortMonthlyReconciliationRows\([\s\S]*?applyPipelineFilters/);
});
