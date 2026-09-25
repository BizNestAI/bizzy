import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  normalizeCurrencyAmountDraft,
  sanitizeCurrencyAmountDraft,
} from "../src/components/Accounting/currencyAmountDraft.js";

const source = readFileSync(new URL("../src/components/Accounting/SplitTransactionModal.jsx", import.meta.url), "utf8");
const feedSource = readFileSync(new URL("../src/components/Accounting/BookkeepingFeed.jsx", import.meta.url), "utf8");
const mirrorSource = readFileSync(new URL("../src/components/Accounting/BookkeepingTransactionMirrorTable.jsx", import.meta.url), "utf8");

test("split amount drafts preserve normal intermediate decimal input", () => {
  assert.equal(sanitizeCurrencyAmountDraft(""), "");
  assert.equal(sanitizeCurrencyAmountDraft("."), ".");
  assert.equal(sanitizeCurrencyAmountDraft("4."), "4.");
  assert.equal(sanitizeCurrencyAmountDraft("4.5"), "4.5");
  assert.equal(sanitizeCurrencyAmountDraft("4.56"), "4.56");
});

test("split amount drafts accept pasted currency and reject extra punctuation", () => {
  assert.equal(sanitizeCurrencyAmountDraft("$1,234.56"), "1234.56");
  assert.equal(sanitizeCurrencyAmountDraft("12..345"), "12.34");
  assert.equal(sanitizeCurrencyAmountDraft("abc 50"), "50");
});

test("split amounts normalize to cents only after editing finishes", () => {
  assert.equal(normalizeCurrencyAmountDraft("4"), "4.00");
  assert.equal(normalizeCurrencyAmountDraft("4."), "4.00");
  assert.equal(normalizeCurrencyAmountDraft("4.5"), "4.50");
  assert.equal(normalizeCurrencyAmountDraft(""), "");
});

test("amount input keeps a local text draft, selects existing content, and uses decimal keyboard", () => {
  assert.match(source, /type="text"/);
  assert.match(source, /inputMode="decimal"/);
  assert.match(source, /onFocus=\{\(event\) => event\.currentTarget\.select\(\)\}/);
  assert.match(source, /const \[draft, setDraft\]/);
  assert.match(source, /onBlur=\{handleBlur\}/);
});

test("canceling an edited split uses the dark in-app discard dialog", () => {
  assert.doesNotMatch(source, /window\.confirm\("Discard this split\?"\)/);
  assert.match(source, /role="alertdialog"/);
  assert.match(source, />Discard this split\?</);
  assert.match(source, />Continue editing</);
  assert.match(source, />Discard split</);
  assert.match(source, /if \(showDiscardConfirm\)[\s\S]*setShowDiscardConfirm\(false\)/);
});

test("discarding a split restores normal categorization and its COA control", () => {
  assert.match(source, /onCancel/);
  assert.match(source, /cancelAndClose\(\)/);
  assert.match(feedSource, /onCancel=\{\(\) => \{[\s\S]*changeResolution\(entry\.txn, "categorize_new"\)/);
  assert.match(mirrorSource, /onCancel=\{\(\) => \{[\s\S]*changeResolution\("categorize_new"\)/);
});

test("split modal uses the compact professional layout", () => {
  assert.match(source, /w-\[min\(760px,calc\(100vw-32px\)\)\]/);
  assert.match(source, /grid-cols-\[minmax\(130px,\.9fr\)_minmax\(200px,1\.4fr\)_112px_36px\]/);
  assert.match(source, /className="h-9 w-full min-w-0/);
});
