import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";

test("tax API client wraps audited classification review and override routes", () => {
  const client = fs.readFileSync("src/services/tax/taxApiClient.js", "utf8");
  assert.match(client, /getTaxClassificationHistory/);
  assert.match(client, /confirmTaxClassification/);
  assert.match(client, /rejectTaxClassification/);
  assert.match(client, /overrideTaxClassification/);
  assert.match(client, /excludeTaxClassification/);
  assert.match(client, /restoreTaxClassification/);
  assert.match(client, /bulkUpdateTaxClassifications/);
  assert.match(client, /\/api\/tax\/classifications\/\$\{encodeURIComponent\(transactionId\)\}\/confirm/);
  assert.match(client, /\/api\/tax\/classifications\/\$\{encodeURIComponent\(transactionId\)\}\/reject/);
  assert.match(client, /\/api\/tax\/classifications\/\$\{encodeURIComponent\(transactionId\)\}\/exclude/);
  assert.match(client, /\/api\/tax\/classifications\/\$\{encodeURIComponent\(transactionId\)\}\/restore/);
  assert.match(client, /\/api\/tax\/classifications\/bulk-update/);
});

test("standalone deductions review workspace components have been removed", () => {
  const files = [
    "src/components/Tax/Deductions/TaxTransactionReviewDrawer.jsx",
    "src/components/Tax/Deductions/TaxTreatmentEditor.jsx",
    "src/components/Tax/Deductions/TaxReviewActions.jsx",
    "src/components/Tax/Deductions/DeductionsWorkspace.jsx",
  ];
  for (const file of files) {
    assert.equal(fs.existsSync(file), false, file);
  }
});
