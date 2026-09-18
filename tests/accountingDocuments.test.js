import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCOUNTING_DOCUMENT_MAX_FILE_BYTES,
  buildAccountingMonthFolders,
  getAccountingDocumentYears,
  validateAccountingDocumentFile,
} from "../src/services/bizzyDocs/accountingDocuments.js";

test("accounting document years start at 2026 and extend through the current year", () => {
  assert.deepEqual(getAccountingDocumentYears(2026), [2026]);
  assert.deepEqual(getAccountingDocumentYears(2028), [2026, 2027, 2028]);
});

test("accounting document folders always render exactly twelve months", () => {
  const folders = buildAccountingMonthFolders([]);
  assert.equal(folders.length, 12);
  assert.equal(folders[0].name, "January");
  assert.equal(folders[11].name, "December");
  assert.ok(folders.every((folder) => folder.count === 0));
});

test("accounting document folders count uploaded docs by month", () => {
  const folders = buildAccountingMonthFolders([
    { month: 8 },
    { content: { accounting_document: { month: 8 } } },
    { accounting_month: 9 },
  ]);
  assert.equal(folders[7].count, 2);
  assert.equal(folders[8].count, 1);
});

test("accounting document upload validation accepts supported files", () => {
  assert.equal(validateAccountingDocumentFile({ name: "statement.PDF", size: 1024 }), "");
  assert.equal(validateAccountingDocumentFile({ name: "statement.xlsx", size: ACCOUNTING_DOCUMENT_MAX_FILE_BYTES }), "");
});

test("accounting document upload validation rejects unsupported and oversized files", () => {
  assert.match(validateAccountingDocumentFile({ name: "notes.docx", size: 1024 }), /Unsupported file type/);
  assert.match(validateAccountingDocumentFile({ name: "statement.pdf", size: ACCOUNTING_DOCUMENT_MAX_FILE_BYTES + 1 }), /too large/);
});
