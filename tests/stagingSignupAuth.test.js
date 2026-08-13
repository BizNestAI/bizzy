import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getAuthRedirectTo,
  normalizeSupabaseProjectUrl,
} from "../src/services/authUrlConfig.js";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

test("staging Supabase URL normalization strips copied REST/Auth API suffixes", () => {
  assert.equal(
    normalizeSupabaseProjectUrl("https://staging-project.supabase.co/rest/v1"),
    "https://staging-project.supabase.co"
  );
  assert.equal(
    normalizeSupabaseProjectUrl("https://staging-project.supabase.co/auth/v1/"),
    "https://staging-project.supabase.co"
  );
});

test("normalized signup endpoint uses Supabase Auth path, not REST path", () => {
  const projectUrl = normalizeSupabaseProjectUrl(
    "https://staging-project.supabase.co/rest/v1"
  );

  assert.equal(
    `${projectUrl}/auth/v1/signup`,
    "https://staging-project.supabase.co/auth/v1/signup"
  );
});

test("signup confirmation redirect is an absolute local frontend URL", () => {
  assert.equal(
    getAuthRedirectTo("/auth/confirm", "http://localhost:5173"),
    "http://localhost:5173/auth/confirm"
  );
});

test("frontend signup preflight points at the mounted backend route", () => {
  const authService = read("src/services/authService.js");
  const route = read("src/api/auth/signupConfirmation.routes.js");
  const server = read("src/server.js");

  assert.match(authService, /apiFetch\(['"]\/api\/auth\/signup-confirmation['"]/);
  assert.match(route, /router\.post\(['"]\/signup-confirmation['"]/);
  assert.match(server, /app\.use\(['"]\/api\/auth['"],\s*signupConfirmationRouter\)/);
});

test("signup uses the same absolute redirect for preflight and Supabase emailRedirectTo", () => {
  const authService = read("src/services/authService.js");

  assert.match(authService, /const redirectTo = getAuthRedirectTo\(['"]\/auth\/confirm['"]\)/);
  assert.match(authService, /getSignupConfirmationStatus\(\s*normalizedEmail,\s*redirectTo\s*\)/);
  assert.match(authService, /emailRedirectTo: redirectTo/);
});
