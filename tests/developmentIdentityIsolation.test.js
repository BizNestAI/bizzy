import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

function runtimeFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) return runtimeFiles(absolute);
    return /\.(?:js|jsx|mjs|cjs)$/.test(entry.name) ? [absolute] : [];
  });
}

test("production runtime never references development identity environment fallbacks", () => {
  const src = fileURLToPath(new URL("../src", import.meta.url));
  const offenders = runtimeFiles(src).filter((file) => /DEV_(?:USER|BUSINESS)_ID/.test(fs.readFileSync(file, "utf8")));
  assert.deepEqual(offenders.map((file) => path.relative(ROOT, file)), []);
});
