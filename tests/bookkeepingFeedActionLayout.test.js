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

test("Handled posting status stays within its column without truncating timestamps or reasons", () => {
  assert.match(source, /QBO_COL_WIDTH = 152/);
  assert.match(source, /QBO_MIN_COL_WIDTH = 152/);
  assert.match(source, /title=\{\[qboSchedule\.label, qboSchedule\.detail\]/);
  assert.match(source, /min-w-0 max-w-full[^`]*whitespace-normal/);
  assert.match(source, /overflow-hidden px-3 py-1 text-center/);
  assert.match(source, /minWidth: totalGridWidth \+ FEED_ROW_PADDING/);
  assert.match(source, /break-words \[overflow-wrap:anywhere\]/);
  assert.doesNotMatch(source, /<span className="truncate">\{qboSchedule\.label\}<\/span>/);
});

test("customer Books Review does not expose Admin Monthly Review navigation", () => {
  const linkIndex = source.indexOf("Open Monthly Review Posting Review");
  const accessGuardIndex = source.lastIndexOf("adminBookkeepingAccess ? (", linkIndex);

  assert.ok(linkIndex > -1);
  assert.ok(accessGuardIndex > -1);
  assert.ok(linkIndex - accessGuardIndex < 500);
});
