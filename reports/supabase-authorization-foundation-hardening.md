# Supabase Authorization Foundation Hardening

Date: 2026-08-09

Scope: `public.business_profiles` and `public.user_business_link`.

This is a pre-execution report. The migration has not been applied by this prompt.

## Source Inputs

- `supabase/live_schema_snapshot.sql`
- `reports/supabase-rls-security-audit.md`
- `reports/supabase-rls-remediation-plan.md`
- `reports/supabase-two-tenant-runtime-security-test.md`
- Current application source code

## Current Live State Audited

### business_profiles

- RLS: enabled
- Grants in live snapshot: `anon=ALL`, `authenticated=ALL`, `service_role=ALL`
- Dangerous policies:
  - `Enable insert for authenticated users only`: `WITH CHECK (true)`
  - `User can manage their own business profile`: `USING (true)`
- Canonical meaning:
  - `id` is the Bizzi business ID
  - `user_id` is the primary/original owner user ID
- Existing trigger:
  - `trg_business_profiles_billing_identity_summary` after insert/update of `business_name`, `user_id`

### user_business_link

- RLS: enabled
- Grants in live snapshot: `anon=ALL`, `authenticated=ALL`, `service_role=ALL`
- Dangerous policies:
  - `Enable insert for authenticated users only`: `WITH CHECK (true)`
- Existing select policy:
  - `Allow owner to select their business link` only returns owner/self rows and does not support the full tenant membership model.
- Canonical meaning:
  - `user_id + business_id` is explicit business membership
  - `role` stores membership role

## Runtime Failures Addressed

The staging two-tenant runtime test confirmed these failures before this migration:

- User A can select Business B.
- User A can update Business B.
- User A can change `business_profiles.user_id`.
- Anonymous users can select and insert `business_profiles`.
- User A can insert themselves into Business B through `user_business_link`.
- User A can assign themselves owner/admin for Business B.

## Migration Created

`supabase/migrations/20260811_harden_authorization_foundation_rls.sql`

The migration is additive in repo history. It does not modify prior migration files and does not execute against Supabase in this prompt.

## Policies Removed

| Table | Policy |
| --- | --- |
| `business_profiles` | `Enable insert for authenticated users only` |
| `business_profiles` | `User can manage their own business profile` |
| `user_business_link` | `Enable insert for authenticated users only` |
| `user_business_link` | `Allow owner to select their business link` |

## Policies Created

| Table | Policy | Command | Role | Effect |
| --- | --- | --- | --- | --- |
| `business_profiles` | `business_profiles_member_select` | SELECT | authenticated | Allows reading only if `auth.uid()` owns the business or is a member. |
| `business_profiles` | `business_profiles_manager_update` | UPDATE | authenticated | Allows updates only for owner/admin-manageable businesses. |
| `user_business_link` | `user_business_link_self_or_manager_select` | SELECT | authenticated | Allows users to read their own membership rows; owners/admins can read memberships for their businesses. |

No authenticated INSERT, DELETE, or membership-write policies are created.

## Helper Functions

| Function | Security | Purpose |
| --- | --- | --- |
| `public.bizzi_current_user_is_business_member(uuid)` | `SECURITY DEFINER`, `SET search_path = pg_catalog, public` | Central membership/ownership predicate for tenant reads. The user is derived from `auth.uid()`, not caller input. |
| `public.bizzi_current_user_can_manage_business(uuid)` | `SECURITY DEFINER`, `SET search_path = pg_catalog, public` | Owner/admin predicate for business profile updates and membership visibility. The user is derived from `auth.uid()`, not caller input. |

Function `EXECUTE` is revoked from `PUBLIC`/`anon` and granted only to `authenticated` and `service_role`.

## Grants Changed

| Table | Revoked | Granted |
| --- | --- | --- |
| `business_profiles` | all privileges from `PUBLIC`, `anon`, `authenticated` | `SELECT, UPDATE` to `authenticated`; `ALL` to `service_role` |
| `user_business_link` | all privileges from `PUBLIC`, `anon`, `authenticated` | `SELECT` to `authenticated`; `ALL` to `service_role` |

Anonymous users should have zero direct table privileges after migration.

## Integrity Protections Added

| Object | Protection |
| --- | --- |
| `trg_business_profiles_identity_immutable` | Prevents updates to `business_profiles.id` and `business_profiles.user_id`. |
| `trg_user_business_link_identity_immutable` | Prevents updates to `user_business_link.id`, `user_id`, `business_id`, and `role`. |

This denies unsupported ownership transfer, membership reassignment, and role escalation. Future supported ownership/member-management workflows should use a separate reviewed backend/RPC path and migration.

## Application Flows Preserved

- `POST /api/onboarding/business` remains the trusted initial business creation path.
- The service-role-only RPC `public.create_initial_business_for_user(...)` should still create `business_profiles` and the initial owner `user_business_link` row because `service_role` keeps `ALL` table access.
- Frontend business reads should still work for owned/member businesses.
- Frontend `updateBusinessProfile(...)` should still work for owned/admin-manageable businesses, but cannot reassign `id` or `user_id`.
- `BusinessSwitcher` can still read the caller's own membership rows and nested business profile metadata.

## Potentially Affected Flows

- Any unreviewed browser code that attempted direct `business_profiles.insert(...)` will fail. Initial onboarding was already moved to the backend.
- Any unreviewed browser code that attempted direct `user_business_link.insert/update/delete(...)` will fail. No legitimate current frontend membership-management write flow was found.
- Any future membership role-change workflow will need a trusted backend/RPC implementation because direct role updates are denied.

## Expected Staging Runtime Behavior After Migration

| Attack | Expected Result |
| --- | --- |
| Anonymous SELECT `business_profiles` | Denied |
| Anonymous INSERT `business_profiles` | Denied |
| User A SELECT unrelated Business B | Denied/no rows |
| User A UPDATE Business B | Denied/no mutation |
| User A change Business A `user_id` to User B | Denied by immutable trigger |
| User A insert membership into Business B | Denied: no authenticated INSERT grant/policy |
| User A assign themselves owner/admin in Business B | Denied: no authenticated INSERT/UPDATE grant/policy |
| User A add User B to Business A from browser | Denied: no authenticated INSERT grant/policy |
| Service-role onboarding RPC creates first business | Allowed |

## Tests Added

`tests/authorizationFoundationRlsMigration.security.test.js`

The tests are static pre-execution checks against the migration SQL. Runtime two-tenant validation must be rerun after applying this migration to staging.

## Remaining Work

- Apply this migration to staging only after review.
- Rerun real two-tenant Supabase runtime attack tests against staging.
- If staging passes, plan production rollout with backup/rollback and a preflight check for existing duplicate or malformed membership data.
- Continue later RLS phases for financial tables, credential/server-only tables, views, functions, and default privileges.
