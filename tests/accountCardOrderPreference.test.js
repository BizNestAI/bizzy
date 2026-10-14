import test from "node:test";
import assert from "node:assert/strict";

import {
  getAccountCardOrderKey,
  moveAccountCard,
  orderAccountCards,
} from "../src/services/bookkeeping/accountCardOrderPreference.js";

const cards = [
  { _key: "checking", name: "Checking" },
  { _key: "chase", name: "Chase" },
  { _key: "amex", name: "Amex" },
];

test("orders account cards without changing their data", () => {
  const ordered = orderAccountCards(cards, ["amex", "checking", "chase"]);
  assert.deepEqual(ordered.map((card) => card._key), ["amex", "checking", "chase"]);
  assert.equal(ordered[0], cards[2]);
  assert.equal(ordered[1], cards[0]);
});

test("appends newly synced accounts and ignores stale preferences", () => {
  const ordered = orderAccountCards(cards, ["removed", "chase"]);
  assert.deepEqual(ordered.map((card) => card._key), ["chase", "checking", "amex"]);
});

test("moving a card returns only a new display order", () => {
  const order = moveAccountCard(cards, "amex", "checking");
  assert.deepEqual(order, ["amex", "checking", "chase"]);
  assert.deepEqual(cards.map((card) => card._key), ["checking", "chase", "amex"]);
});

test("preference storage is isolated by business and user", () => {
  assert.notEqual(
    getAccountCardOrderKey({ businessId: "business-a", userId: "user-a" }),
    getAccountCardOrderKey({ businessId: "business-a", userId: "user-b" })
  );
  assert.notEqual(
    getAccountCardOrderKey({ businessId: "business-a", userId: "user-a" }),
    getAccountCardOrderKey({ businessId: "business-b", userId: "user-a" })
  );
});
