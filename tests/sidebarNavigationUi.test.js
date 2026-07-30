import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";

test("sidebar orders Jobs above Tax", () => {
  const sidebar = fs.readFileSync("src/components/UserAdmin/Sidebar.jsx", "utf8");
  const jobsIndex = sidebar.indexOf("{ label: 'Jobs', path: '/dashboard/leads-jobs' }");
  const taxIndex = sidebar.indexOf("{ label: 'Tax', path: '/dashboard/tax' }");
  assert.ok(jobsIndex > -1, "Jobs tab should exist");
  assert.ok(taxIndex > -1, "Tax tab should exist");
  assert.ok(jobsIndex < taxIndex, "Jobs should be listed before Tax");
});
