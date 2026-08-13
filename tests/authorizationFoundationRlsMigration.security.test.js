import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const migration = readFileSync(
  join(root, "supabase/migrations/20260811_harden_authorization_foundation_rls.sql"),
  "utf8"
);

function policyBlock(policyName) {
  const match = migration.match(
    new RegExp(`CREATE POLICY ${policyName}[\\s\\S]*?;`, "i")
  );
  assert.ok(match, `missing policy ${policyName}`);
  return match[0];
}

test("authorization foundation migration drops known permissive policies", () => {
  assert.match(migration, /DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON public\.business_profiles/);
  assert.match(migration, /DROP POLICY IF EXISTS "User can manage their own business profile" ON public\.business_profiles/);
  assert.match(migration, /DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON public\.user_business_link/);
  assert.match(migration, /DROP POLICY IF EXISTS "Allow owner to select their business link" ON public\.user_business_link/);
  assert.doesNotMatch(migration, /USING\s*\(\s*true\s*\)/i);
  assert.doesNotMatch(migration, /WITH CHECK\s*\(\s*true\s*\)/i);
});

test("anon cannot directly access authorization foundation tables after migration", () => {
  assert.match(migration, /REVOKE ALL ON TABLE public\.business_profiles FROM anon/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.user_business_link FROM anon/);
  assert.doesNotMatch(migration, /GRANT\s+(?:ALL|SELECT|INSERT|UPDATE|DELETE)[^;]*public\.business_profiles[^;]*TO anon/i);
  assert.doesNotMatch(migration, /GRANT\s+(?:ALL|SELECT|INSERT|UPDATE|DELETE)[^;]*public\.user_business_link[^;]*TO anon/i);
});

test("authenticated business profile access is read/update only and RLS constrained", () => {
  assert.match(migration, /REVOKE ALL ON TABLE public\.business_profiles FROM authenticated/);
  assert.match(migration, /GRANT SELECT, UPDATE ON TABLE public\.business_profiles TO authenticated/);
  assert.doesNotMatch(migration, /GRANT\s+(?:ALL|INSERT|DELETE)[^;]*public\.business_profiles[^;]*TO authenticated/i);

  const select = policyBlock("business_profiles_member_select");
  assert.match(select, /FOR SELECT/i);
  assert.match(select, /TO authenticated/i);
  assert.match(select, /USING \(public\.bizzi_current_user_is_business_member\(id\)\)/);

  const update = policyBlock("business_profiles_manager_update");
  assert.match(update, /FOR UPDATE/i);
  assert.match(update, /USING \(public\.bizzi_current_user_can_manage_business\(id\)\)/);
  assert.match(update, /WITH CHECK \(public\.bizzi_current_user_can_manage_business\(id\)\)/);
});

test("business profile ownership identity is immutable", () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.prevent_business_profile_identity_reassignment\(\)/);
  assert.match(migration, /NEW\.id IS DISTINCT FROM OLD\.id/);
  assert.match(migration, /BUSINESS_PROFILE_ID_IMMUTABLE/);
  assert.match(migration, /NEW\.user_id IS DISTINCT FROM OLD\.user_id/);
  assert.match(migration, /BUSINESS_PROFILE_OWNER_IMMUTABLE/);
  assert.match(migration, /BEFORE UPDATE OF id, user_id ON public\.business_profiles/);
});

test("authenticated membership writes are removed and membership reads are scoped", () => {
  assert.match(migration, /REVOKE ALL ON TABLE public\.user_business_link FROM authenticated/);
  assert.match(migration, /GRANT SELECT ON TABLE public\.user_business_link TO authenticated/);
  assert.doesNotMatch(migration, /GRANT\s+(?:ALL|INSERT|UPDATE|DELETE)[^;]*public\.user_business_link[^;]*TO authenticated/i);
  assert.doesNotMatch(migration, /CREATE POLICY [^;]+ON public\.user_business_link[\s\S]*?FOR INSERT[\s\S]*?TO authenticated/i);
  assert.doesNotMatch(migration, /CREATE POLICY [^;]+ON public\.user_business_link[\s\S]*?FOR UPDATE[\s\S]*?TO authenticated/i);
  assert.doesNotMatch(migration, /CREATE POLICY [^;]+ON public\.user_business_link[\s\S]*?FOR DELETE[\s\S]*?TO authenticated/i);

  const select = policyBlock("user_business_link_self_or_manager_select");
  assert.match(select, /FOR SELECT/i);
  assert.match(select, /user_id = auth\.uid\(\)/);
  assert.match(select, /public\.bizzi_current_user_can_manage_business\(business_id\)/);
});

test("membership identity and role cannot be reassigned by direct row update", () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.prevent_user_business_link_identity_reassignment\(\)/);
  assert.match(migration, /NEW\.user_id IS DISTINCT FROM OLD\.user_id/);
  assert.match(migration, /NEW\.business_id IS DISTINCT FROM OLD\.business_id/);
  assert.match(migration, /NEW\.role IS DISTINCT FROM OLD\.role/);
  assert.match(migration, /USER_BUSINESS_LINK_ROLE_IMMUTABLE/);
  assert.match(migration, /BEFORE UPDATE OF id, user_id, business_id, role ON public\.user_business_link/);
});

test("membership helper functions use SECURITY DEFINER with hardened search_path and auth.uid authority", () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.bizzi_current_user_is_business_member\(\s*p_business_id uuid\s*\)/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.bizzi_current_user_can_manage_business\(\s*p_business_id uuid\s*\)/);
  assert.match(migration, /SECURITY DEFINER/);
  assert.match(migration, /SET search_path = pg_catalog, public/);
  assert.match(migration, /FROM public\.business_profiles AS bp/);
  assert.match(migration, /FROM public\.user_business_link AS ubl/);
  assert.match(migration, /ubl\.role IN \('owner', 'admin'\)/);
  assert.match(migration, /bp\.user_id = auth\.uid\(\)/);
  assert.match(migration, /ubl\.user_id = auth\.uid\(\)/);
  assert.doesNotMatch(migration, /p_user_id uuid/);
  assert.doesNotMatch(migration, /bizzi_current_user_is_business_member\(uuid,\s*uuid\)/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.bizzi_current_user_is_business_member\(uuid\) FROM anon/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.bizzi_current_user_can_manage_business\(uuid\) FROM anon/);
});

test("service role access needed by trusted onboarding RPC is retained", () => {
  assert.match(migration, /GRANT ALL ON TABLE public\.business_profiles TO service_role/);
  assert.match(migration, /GRANT ALL ON TABLE public\.user_business_link TO service_role/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.bizzi_current_user_is_business_member\(uuid\) TO service_role/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.bizzi_current_user_can_manage_business\(uuid\) TO service_role/);
});

test("migration does not alter user profile policies or old migration history", () => {
  assert.doesNotMatch(migration, /ALTER TABLE public\.user_profiles/i);
  assert.doesNotMatch(migration, /DROP POLICY [^;]+ON public\.user_profiles/i);
  assert.doesNotMatch(migration, /CREATE POLICY [^;]+ON public\.user_profiles/i);
});
