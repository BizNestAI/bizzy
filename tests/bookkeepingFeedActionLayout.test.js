import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../src/components/Accounting/BookkeepingFeed.jsx", import.meta.url),
  "utf8",
);

test("Books Review handled actions reserve enough width and keep labels on one line", () => {
  assert.match(source, /BASE_COL_WIDTHS = \[36, 90, 220, 160, 245, 105, 180\]/);
  assert.match(source, /gap-1\.5 whitespace-nowrap/);
  assert.match(source, /shrink-0[^"\n]*whitespace-nowrap[^"\n]*leading-none/);
  assert.match(source, /postingActionLabel/);
});

test("customer Books Review does not expose Admin Monthly Review navigation", () => {
  const linkIndex = source.indexOf("Open Monthly Review Posting Review");
  const accessGuardIndex = source.lastIndexOf("adminBookkeepingAccess ? (", linkIndex);

  assert.ok(linkIndex > -1);
  assert.ok(accessGuardIndex > -1);
  assert.ok(linkIndex - accessGuardIndex < 500);
});
