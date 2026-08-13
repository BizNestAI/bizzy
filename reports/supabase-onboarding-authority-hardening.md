# Supabase Onboarding Authority Hardening

Scope: application and migration preparation only. No Supabase connection was made. No migration was executed. No RLS policy, existing grant/default privilege, or production data was changed.

## Verdict

ONBOARDING AUTHORITY HARDENING: PASS WITH BLOCKERS

The initial business creation and first owner membership path has moved from browser-controlled Supabase writes to authenticated backend authority. The remaining blocker before final RLS lockdown is operational: apply the new narrow RPC migration in staging/production, run the ownership-integrity diagnostic, then replace the permissive `business_profiles` and `user_business_link` policies in Security Prompt 6E.

## Previous Onboarding Architecture

1. Browser signup used Supabase Auth.
2. `handle_confirmed_auth_user_profile()` created/updated `user_profiles` after email confirmation.
3. `BusinessWizard.jsx` called `ensureUserProfile(user)` from the browser.
4. Browser inserted `business_profiles` through `createBusinessProfile(profile)`, including `user_id: user.id`.
5. Browser inserted `user_business_link` with `{ user_id, business_id, role: "owner" }`.

Security issue: browser code supplied ownership and membership authority. The live snapshot showed this depended on permissive policies:

- `business_profiles`: `Enable insert for authenticated users only` with `WITH CHECK (true)`.
- `business_profiles`: `User can manage their own business profile` with `USING (true)`.
- `user_business_link`: `Enable insert for authenticated users only` with `WITH CHECK (true)`.

## New Onboarding Architecture

Frontend:

- `BusinessWizard.jsx` still collects the same business profile fields.
- Initial creation now calls `createInitialBusinessProfile()`.
- `createInitialBusinessProfile()` calls authenticated backend endpoint `POST /api/onboarding/business`.
- Browser no longer inserts `business_profiles` for initial ownership creation.
- Browser no longer inserts `user_business_link` for first owner membership.
- Browser no longer sends `user_id` during business create/update from the wizard.

Backend:

- `POST /api/onboarding/business` requires `requireAuth`.
- It does not require `requireBusinessAccess`, because this is the pre-business onboarding step.
- Identity authority is `req.auth.userId`.
- Business profile fields are explicitly allowlisted.
- `user_id`, `business_id`, `owner_id`, `created_by`, and `role` from the browser are ignored.
- The backend calls service-role-only RPC `public.create_initial_business_for_user(...)`.

Database migration prepared, not executed:

- `supabase/migrations/20260808_initial_business_onboarding_authority.sql`
- Adds `public.create_initial_business_for_user(...)`.
- Uses `SECURITY DEFINER`.
- Uses `SET search_path = pg_catalog, public`.
- Revokes execute from `PUBLIC`, `anon`, and `authenticated`.
- Grants execute only to `service_role`.

## Authority Source

The authoritative user is the Supabase-authenticated backend identity:

`Authorization bearer token -> requireAuth -> req.auth.userId -> RPC p_user_id`

The browser may supply business profile content only. It cannot supply ownership, membership, role, or target business authority.

## Transaction Mechanism

The RPC executes inside a single PostgreSQL function invocation. It:

1. Validates required identity and business fields.
2. Acquires a transaction-scoped advisory lock for `p_user_id`.
3. Upserts `user_profiles`.
4. Checks whether the user already owns any `business_profiles` row.
5. Raises `INITIAL_BUSINESS_ALREADY_EXISTS` without mutating existing businesses when one or more owned businesses already exist.
6. Creates a new `business_profiles` row only when the user owns zero businesses.
7. Creates the owner `user_business_link` for the newly created business.
8. Returns safe business metadata only.

This avoids partial state between business creation and owner membership creation after the migration is applied.

## Idempotency Behavior

The RPC uses `pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 0))` to serialize initial onboarding by user. If the user already has one or more owned business profiles, the RPC raises `INITIAL_BUSINESS_ALREADY_EXISTS` and does not update or reuse any existing business.

Concurrent duplicate submissions behave deterministically:

- Request 1 acquires the lock, sees zero businesses, creates the business and owner membership, and commits.
- Request 2 waits, then sees the new owned business and receives `INITIAL_BUSINESS_ALREADY_EXISTS`.
- Request 2 creates nothing and mutates nothing.

This is for initial onboarding only. Future additional-business creation should use a separate explicit flow.

## Browser Writes Removed

Removed for initial onboarding:

- `business_profiles.insert(...)` from browser service code.
- `user_business_link.insert(...)` from `BusinessWizard.jsx`.
- Browser-supplied `role: "owner"` for first membership.
- Browser-supplied `user_id` in wizard business payloads.

Still present intentionally:

- `business_profiles.update(...)` remains in `businessService.js` for existing business profile edits. Security Prompt 6E should tighten RLS so only authorized owner/admin users can update allowed business profile fields and cannot change `user_id`.
- `user_profiles.upsert(...)` remains for bootstrap compatibility alongside the confirmed-user trigger.
- Browser reads of `business_profiles` and `user_business_link` remain for login/onboarding/business switching and need strict RLS, not server-only removal.

## Service-Role Behavior

The service-role client is used only on the backend route after `requireAuth`. The route does not expose service-role keys or import server-only modules into browser roots. Browser input is allowlisted and never controls table names, columns, user IDs, business IDs, or roles.

## Existing User Diagnostic

Added read-only diagnostic:

- `scripts/auditBusinessOwnershipIntegrity.sql`

It reports only safe identifiers and membership consistency status:

- business ID
- profile owner user ID
- membership user ID
- membership role
- consistency status

It does not query customer financial data and was not executed.

## Policies Now Safe To Tighten In 6E

After the RPC migration is applied and the frontend/backend deployment is live, onboarding no longer requires these permissive policies:

`business_profiles`

- `Enable insert for authenticated users only` with `WITH CHECK (true)`.
- `User can manage their own business profile` with `USING (true)`.

`user_business_link`

- `Enable insert for authenticated users only` with `WITH CHECK (true)`.

Replacement direction for 6E:

- `business_profiles` read: owner or explicit `user_business_link` member.
- `business_profiles` insert: no browser direct insert for initial onboarding; either server-only or strict future additional-business flow.
- `business_profiles` update: owner/admin only; `user_id` immutable.
- `user_business_link` select: member can view own memberships; owner/admin can view/manage business memberships.
- `user_business_link` insert/update/delete: owner/admin or server-side onboarding authority only; no self-add to arbitrary business; role immutable except authorized admin action.

## Remaining Blockers Before 6E

1. Apply `20260808_initial_business_onboarding_authority.sql` in staging, then production after review.
2. Deploy backend/frontend that uses `/api/onboarding/business`.
3. Run the read-only ownership-integrity diagnostic and remediate any existing missing owner memberships separately.
4. Decide final direct-browser update policy for `business_profiles` existing-business edits.
5. Keep `user_profiles` / `profiles` bootstrap under review; `user_profiles.upsert` still exists for compatibility.

## Tests

Added:

- `tests/onboardingAuthority.security.test.js`

Commands run:

```bash
node --test tests/onboardingAuthority.security.test.js
node --test tests/rlsCompatibilityPrep.security.test.js
node --test tests/authTenant.middleware.test.js tests/privateRouteMounts.security.test.js
node --test tests/plaidSecurity.test.js tests/qboSecurity.test.js tests/privateRouteMounts.security.test.js
npm test
```

Results:

- Onboarding authority tests: 9/9 passed.
- RLS compatibility prep tests: 7/7 passed.
- Auth tenant/private route tests: 18/18 passed.
- Plaid/QBO/private route tests: 35/35 passed.
- Full `npm test`: 615 passed, 3 failed, 3 skipped.

The 3 full-suite failures are the same legacy UI failures previously reproduced outside this prompt and are not caused by the onboarding authority changes:

- `tests/sidebarNavigationUi.test.js`: `sidebar orders Jobs above Tax`.
- `tests/taxConfidenceExplanationUi.test.js`: `dashboard keeps confidence breakdown in the trajectory header pill and links tax surfaces to the workpaper route`.
- `tests/taxWorkpaperUi.test.js`: `workpaper rows recursively expand and show full traceability detail on hover`.
