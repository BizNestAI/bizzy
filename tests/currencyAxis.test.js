import test from "node:test";
import assert from "node:assert/strict";

import { buildCurrencyAxis, formatCurrencyTick } from "../src/utils/currencyAxis.js";

test("$1,175 revenue uses a small live-data axis instead of a $60K mock scale", () => {
  const axis = buildCurrencyAxis([1175], { includeZero: true, minAtZero: true, tickCount: 5 });

  assert.equal(axis.domain[0], 0);
  assert.ok(axis.domain[1] <= 1500);
  assert.ok(axis.domain[1] > 1175);
  assert.ok(axis.ticks.includes(0));
  assert.ok(axis.ticks.some((tick) => tick >= 1175));
});

test("$982 net profit produces distinct readable tick labels", () => {
  const axis = buildCurrencyAxis([982.1], { includeZero: true, minAtZero: true, tickCount: 5 });
  const labels = axis.ticks.map(formatCurrencyTick);

  assert.equal(axis.domain[0], 0);
  assert.ok(axis.domain[1] <= 1500);
  assert.equal(new Set(labels).size, labels.length);
  assert.ok(labels.includes("$1K") || labels.includes("$1.5K"));
});

test("negative and mixed net profit extends below zero and includes zero", () => {
  const axis = buildCurrencyAxis([-500, 982.1], { includeZero: true, minAtZero: false, tickCount: 5 });

  assert.ok(axis.domain[0] < 0);
  assert.ok(axis.domain[1] > 0);
  assert.ok(axis.ticks.includes(0));
});

test("currency tick formatter adapts to scale and sign", () => {
  assert.equal(formatCurrencyTick(250), "$250");
  assert.equal(formatCurrencyTick(1250), "$1.25K");
  assert.equal(formatCurrencyTick(15000), "$15K");
  assert.equal(formatCurrencyTick(1200000), "$1.2M");
  assert.equal(formatCurrencyTick(-500), "-$500");
});
