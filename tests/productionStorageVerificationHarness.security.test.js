import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const harness = read("scripts/runProductionStorageSecurityVerification.js");

function read(rel) {
  return readFileSync(join(root, rel), "utf8");
}

test("production storage harness requires explicit enablement and synthetic tenants", () => {
  assert.match(harness, /PRODUCTION_STORAGE_SECURITY_TEST_ENABLED/);
  assert.match(harness, /Refusing to run production Storage verification/);
  for (const name of [
    "PRODUCTION_STORAGE_TEST_USER_A_EMAIL",
    "PRODUCTION_STORAGE_TEST_USER_A_PASSWORD",
    "PRODUCTION_STORAGE_TEST_USER_A_ID",
    "PRODUCTION_STORAGE_TEST_BUSINESS_A_ID",
    "PRODUCTION_STORAGE_TEST_USER_B_EMAIL",
    "PRODUCTION_STORAGE_TEST_USER_B_PASSWORD",
    "PRODUCTION_STORAGE_TEST_USER_B_ID",
    "PRODUCTION_STORAGE_TEST_BUSINESS_B_ID",
  ]) {
    assert.match(harness, new RegExp(name));
  }
});

test("production storage harness constrains mutations to generated security-test paths", () => {
  assert.match(harness, /const SECURITY_MARKER = "__security_test__";/);
  assert.match(harness, /assertSafePath\(path\)/);
  assert.match(harness, /Refusing unsafe Storage mutation path without run marker/);
  assert.match(harness, /cleanup\(admin\)/);
  assert.doesNotMatch(harness, /admin\.auth\.admin\.createUser/);
  assert.doesNotMatch(harness, /admin\.auth\.admin\.deleteUser/);
  assert.doesNotMatch(harness, /\.from\("business_profiles"\)\.insert/);
  assert.doesNotMatch(harness, /\.from\("business_profiles"\)\.delete/);
});

test("production storage harness tests all required buckets and attacker operations", () => {
  for (const bucket of ["bizzy-docs", "financial-reports", "bid-attachments"]) {
    assert.match(harness, new RegExp(`id:\\s*"${bucket}"`));
  }
  for (const operation of [
    "attemptList",
    "attemptDownload",
    "attemptSignedUrl",
    "attemptUpload",
    "attemptOverwrite",
    "attemptDelete",
  ]) {
    assert.match(harness, new RegExp(`async function ${operation}\\b`));
  }
  assert.match(harness, /foreign signed URL request/);
  assert.match(harness, /anonymous download denied/);
});
