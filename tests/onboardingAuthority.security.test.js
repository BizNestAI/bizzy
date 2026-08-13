import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

import {
  createInitialBusinessForAuthenticatedUser,
  INITIAL_BUSINESS_ALREADY_EXISTS,
  sanitizeInitialBusinessPayload,
} from "../src/api/onboarding/onboardingBusiness.service.js";

const root = process.cwd();

function read(rel) {
  return readFileSync(join(root, rel), "utf8");
}

function walk(dir, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    if (["node_modules", ".git", "dist", "build", "coverage"].includes(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, files);
    else if (/\.(js|jsx|ts|tsx)$/.test(entry)) files.push(full);
  }
  return files;
}

const browserRoots = ["src/components", "src/pages", "src/hooks", "src/auth"];
const browserSource = browserRoots
  .flatMap((dir) => walk(join(root, dir)))
  .map((file) => `\n// ${relative(root, file)}\n${readFileSync(file, "utf8")}`)
  .join("\n") + `\n// src/services/businessService.js\n${read("src/services/businessService.js")}`;

test("unauthenticated business creation fails before privileged RPC", async () => {
  let called = false;
  const supabase = {
    rpc: async () => {
      called = true;
      return { data: null, error: null };
    },
  };

  await assert.rejects(
    createInitialBusinessForAuthenticatedUser({
      supabase,
      auth: null,
      body: validBusinessBody(),
    }),
    /Authentication required/
  );
  assert.equal(called, false);
});

test("authenticated user creates business and owner membership from req.auth identity only", async () => {
  const calls = [];
  const supabase = {
    rpc: async (fn, args) => {
      calls.push({ fn, args });
      return {
        data: [{
          id: "business-a",
          user_id: "user-a",
          business_name: args.p_business_name,
          industry: args.p_industry,
          team_size: args.p_team_size,
          annual_revenue: args.p_annual_revenue,
          state: args.p_state,
          services_offered: args.p_services_offered,
          billing_model: args.p_billing_model,
          founded_year: args.p_founded_year,
          top_challenge: args.p_top_challenge,
          membership_role: "owner",
        }],
        error: null,
      };
    },
  };

  const result = await createInitialBusinessForAuthenticatedUser({
    supabase,
    auth: { userId: "user-a", email: "a@example.test" },
    body: {
      ...validBusinessBody(),
      user_id: "user-b",
      business_id: "business-b",
      role: "admin",
      owner_id: "user-b",
      created_by: "user-b",
    },
  });

  assert.equal(result.user_id, "user-a");
  assert.equal(result.id, "business-a");
  assert.equal(result.membership_role, "owner");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fn, "create_initial_business_for_user");
  assert.equal(calls[0].args.p_user_id, "user-a");
  assert.equal(calls[0].args.p_email, "a@example.test");
  assert.equal(Object.hasOwn(calls[0].args, "user_id"), false);
  assert.equal(Object.hasOwn(calls[0].args, "business_id"), false);
  assert.equal(Object.hasOwn(calls[0].args, "role"), false);
  assert.equal(Object.hasOwn(calls[0].args, "owner_id"), false);
});

test("browser supplied user_id, business_id, and role are removed from sanitized onboarding payload", () => {
  const sanitized = sanitizeInitialBusinessPayload({
    ...validBusinessBody(),
    user_id: "user-b",
    business_id: "business-b",
    role: "owner",
  });

  assert.deepEqual(Object.keys(sanitized).sort(), [
    "annual_revenue",
    "billing_model",
    "business_name",
    "founded_year",
    "industry",
    "services_offered",
    "state",
    "team_size",
    "top_challenge",
  ].sort());
  assert.equal(Object.hasOwn(sanitized, "user_id"), false);
  assert.equal(Object.hasOwn(sanitized, "business_id"), false);
  assert.equal(Object.hasOwn(sanitized, "role"), false);
});

test("RPC result cannot claim a business owned by a different user", async () => {
  const supabase = {
    rpc: async () => ({
      data: [{ id: "business-b", user_id: "user-b", membership_role: "owner" }],
      error: null,
    }),
  };

  await assert.rejects(
    createInitialBusinessForAuthenticatedUser({
      supabase,
      auth: { userId: "user-a", email: "a@example.test" },
      body: validBusinessBody(),
    }),
    /invalid ownership/
  );
});

test("existing owned business returns deterministic conflict and does not reuse or update it", async () => {
  const supabase = {
    rpc: async () => ({
      data: null,
      error: { message: "INITIAL_BUSINESS_ALREADY_EXISTS" },
    }),
  };

  await assert.rejects(
    createInitialBusinessForAuthenticatedUser({
      supabase,
      auth: { userId: "user-a", email: "a@example.test" },
      body: validBusinessBody(),
    }),
    (err) => {
      assert.equal(err.code, INITIAL_BUSINESS_ALREADY_EXISTS);
      assert.equal(err.status, 409);
      return true;
    }
  );
});

test("frontend no longer directly creates business ownership or initial owner membership", () => {
  const businessService = read("src/services/businessService.js");
  const wizard = read("src/pages/UserAdmin/BusinessWizard.jsx");

  assert.doesNotMatch(businessService, /\.from\(['"]business_profiles['"]\)[\s\S]*?\.insert/);
  assert.doesNotMatch(wizard, /\.from\(['"]business_profiles['"]\)[\s\S]*?\.insert/);
  assert.doesNotMatch(wizard, /\.from\(['"]user_business_link['"]\)[\s\S]*?\.insert/);
  assert.doesNotMatch(wizard, /role:\s*['"]owner['"]/);
  assert.doesNotMatch(wizard, /user_id:\s*user\.id/);
  assert.match(businessService, /\/api\/onboarding\/business/);
  assert.match(businessService, /wrapped\.code = err\?\.code/);
  assert.match(wizard, /businessError\?\.code === 'INITIAL_BUSINESS_ALREADY_EXISTS'/);
});

test("onboarding backend route requires auth and does not require pre-existing business tenant", () => {
  const route = read("src/api/onboarding/onboarding.routes.js");
  const server = read("src/server.js");

  assert.match(route, /router\.post\("\/business", requireAuth,/);
  assert.doesNotMatch(route, /requireBusinessAccess|requireBusinessContext/);
  assert.match(server, /app\.use\("\/api\/onboarding", onboardingRouter\)/);
});

test("onboarding RPC is service-role only, versioned in migration, and serializes retries", () => {
  const migration = read("supabase/migrations/20260808_initial_business_onboarding_authority.sql");

  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.create_initial_business_for_user/);
  assert.match(migration, /SECURITY DEFINER/);
  assert.match(migration, /SET search_path = pg_catalog, public/);
  assert.match(migration, /pg_catalog\.pg_advisory_xact_lock\(pg_catalog\.hashtextextended/);
  assert.match(migration, /INITIAL_BUSINESS_ALREADY_EXISTS/);
  assert.match(migration, /IF EXISTS[\s\S]*public\.business_profiles/);
  assert.doesNotMatch(migration, /LIMIT\s+1/i);
  assert.doesNotMatch(migration, /UPDATE public\.business_profiles/i);
  assert.match(migration, /INSERT INTO public\.business_profiles/);
  assert.match(migration, /IF NOT EXISTS[\s\S]*public\.user_business_link/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.create_initial_business_for_user[\s\S]*FROM authenticated/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.create_initial_business_for_user[\s\S]*FROM anon/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.create_initial_business_for_user[\s\S]*TO service_role/);
});

test("onboarding RPC fix avoids PL/pgSQL output-column ambiguity", () => {
  const migration = read("supabase/migrations/20260809_fix_initial_business_onboarding_ambiguous_columns.sql");

  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.create_initial_business_for_user/);
  assert.match(migration, /RETURNS TABLE \([\s\S]*\bid uuid\b/);
  assert.match(migration, /ON CONFLICT ON CONSTRAINT users_pkey/);
  assert.doesNotMatch(migration, /ON CONFLICT\s*\(\s*id\s*\)/);
  assert.match(migration, /INSERT INTO public\.business_profiles AS new_bp/);
  assert.match(migration, /RETURNING new_bp\.id INTO v_business_id/);
  assert.match(migration, /FROM public\.business_profiles AS created_bp/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.create_initial_business_for_user[\s\S]*FROM authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.create_initial_business_for_user[\s\S]*TO service_role/);
});

test("onboarding RPC coalesce fix avoids invalid pg_catalog special-form qualification", () => {
  const migration = read("supabase/migrations/20260810_fix_initial_business_onboarding_coalesce.sql");

  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.create_initial_business_for_user/);
  assert.match(migration, /ON CONFLICT ON CONSTRAINT users_pkey/);
  assert.doesNotMatch(migration, /ON CONFLICT\s*\(\s*id\s*\)/);
  assert.doesNotMatch(migration, /pg_catalog\.COALESCE/i);
  assert.match(migration, /SET email = COALESCE\(up\.email, EXCLUDED\.email\)/);
  assert.match(migration, /NULLIF\(pg_catalog\.BTRIM\(COALESCE\(p_annual_revenue, ''\)\), ''\)/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.create_initial_business_for_user[\s\S]*FROM authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.create_initial_business_for_user[\s\S]*TO service_role/);
});

test("browser import roots do not import service-role Supabase admin module", () => {
  assert.doesNotMatch(
    browserSource,
    /from\s+["'][^"']*supabaseAdmin(?:\.js)?["']/,
    "frontend root imports supabaseAdmin"
  );
});

function validBusinessBody() {
  return {
    business_name: "A Plumbing",
    industry: "Plumbing",
    team_size: "3",
    annual_revenue: "$100-250k",
    state: "NC",
    services_offered: "Repairs",
    billing_model: "Per project",
    founded_year: "2020",
    top_challenge: "Cash flow",
  };
}
