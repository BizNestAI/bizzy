import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

const supabaseClientSource = read("src/services/supabaseClient.js");
const authContextSource = read("src/context/AuthContext.jsx");
const loginSource = read("src/pages/UserAdmin/Login.jsx");
const bootstrapSource = read("src/auth/bootstrapAuthToken.js");
const authenticatedFetchSource = read("src/services/api/authenticatedFetch.js");

test("browser Supabase client keeps auth sessions in sessionStorage instead of localStorage", () => {
  assert.match(supabaseClientSource, /persistSession:\s*true/);
  assert.match(supabaseClientSource, /detectSessionInUrl:\s*true/);
  assert.match(supabaseClientSource, /window\.sessionStorage/);
  assert.doesNotMatch(supabaseClientSource, /window\.localStorage/);
});

test("login does not persist raw auth tokens or user ids to localStorage", () => {
  assert.doesNotMatch(loginSource, /localStorage\.setItem\("access_token"/);
  assert.doesNotMatch(loginSource, /localStorage\.setItem\("user_id"/);
  assert.match(loginSource, /clearStoredAuthAndBusinessState/);
});

test("stale auth and business storage is cleared when no session exists", () => {
  assert.match(authContextSource, /clearStoredAuthAndBusinessState/);
  assert.match(authContextSource, /if \(!data\?\.session\) \{/);
  assert.match(authContextSource, /clearStoredAuthAndBusinessState\(\);/);
});

test("legacy auth bootstrap cannot reintroduce persisted browser tokens", () => {
  assert.match(bootstrapSource, /persistSession:\s*true/);
  assert.match(bootstrapSource, /window\.sessionStorage/);
  assert.match(bootstrapSource, /localStorage\.removeItem\('access_token'\)/);
  assert.doesNotMatch(bootstrapSource, /localStorage\.setItem\('access_token'/);
});

test("backend API auth still reads the current Supabase session token", () => {
  assert.match(authenticatedFetchSource, /supabase\.auth\.getSession\(\)/);
  assert.match(authenticatedFetchSource, /Authorization", `Bearer \$\{session\.access_token\}`/);
  assert.doesNotMatch(authenticatedFetchSource, /localStorage\.getItem\(["']access_token["']\)/);
});
