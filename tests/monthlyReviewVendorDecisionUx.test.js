/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(process.cwd(), "src/pages/Admin/MonthlyReviewConsole.jsx"), "utf8");

test("successful Vendor Activity decisions remove the attention row immediately", () => {
  assert.match(source, /const result = await safeFetch\(path, \{ method: "POST", body \}\);[\s\S]*setDetail\(\(current\) => patchResolvedCanonicalVendor\(current, row, action, result\)\)/);
  assert.match(source, /needs_attention: withoutVendor\(vendorData\.needs_attention\)/);
  assert.match(source, /needs_review: withoutVendor\(vendorData\.needs_review\)/);
  assert.match(source, /if \(mappedExisting\) mapped\.unshift\(resolved\);[\s\S]*else created\.unshift\(resolved\)/);
});

test("Vendor Activity completion no longer waits for broad Monthly Review reloads", () => {
  const handler = source.slice(source.indexOf("const resolveCanonicalVendorDecision"), source.indexOf("const approveOperatorResponse"));
  assert.doesNotMatch(handler, /await loadDetail\(\)/);
  assert.doesNotMatch(handler, /await loadSourceLedger\(\)/);
  assert.doesNotMatch(handler, /await loadBusinesses\(\)/);
  assert.match(handler, /void loadSourceLedger\(\)/);
});

test("failed vendor decisions stay visible and show an error", () => {
  const handler = source.slice(source.indexOf("const resolveCanonicalVendorDecision"), source.indexOf("const approveOperatorResponse"));
  assert.ok(handler.indexOf("setDetail((current) => patchResolvedCanonicalVendor") < handler.indexOf("} catch (e)"));
  assert.match(handler, /setError\(e\?\.body\?\.message \|\| e\?\.message \|\| "Could not resolve canonical vendor decision\."\)/);
  assert.match(handler, /finally \{[\s\S]*setBusyAction\(""\)/);
});
