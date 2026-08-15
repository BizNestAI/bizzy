import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

test("auth token refresh does not republish unchanged user session to remount the app", () => {
  const source = readFileSync(join(root, "src/context/AuthContext.jsx"), "utf8");

  assert.match(source, /event === "TOKEN_REFRESHED" && sameUser/);
  assert.match(source, /return prevSession/);
});

test("protected route preserves mounted dashboard while rechecking an already allowed user", () => {
  const source = readFileSync(join(root, "src/components/UserAdmin/ProtectedRoute.jsx"), "utf8");

  assert.match(source, /verifiedUserKeyRef/);
  assert.match(source, /accessState\.allowed && verifiedUserKeyRef\.current === userKey/);
  assert.match(source, /prev\.allowed[\s\S]*checking: true/);
  assert.match(source, /accessState\.checking && !accessState\.allowed/);
});

test("tab visibility guard does not navigate or reload on tab restore", () => {
  const source = readFileSync(join(root, "src/utils/tabVisibilityMotionGuard.js"), "utf8");

  assert.match(source, /visibilitychange/);
  assert.doesNotMatch(source, /location\.reload|window\.location|navigate\(/);
});
