# Supabase RLS Compatibility Prep

Planning/fix scope: application compatibility only. No Supabase connection was made. No RLS policy, grant, default privilege, migration, or production data was changed.

## Verdict

APPLICATION RLS COMPATIBILITY PREP: PASS WITH BLOCKERS

The immediate server-only integration status blockers were removed from browser code. The remaining blockers are intentional and belong to the next authorization-foundation migration: `business_profiles` and `user_business_link` are still created from browser code and therefore cannot be locked down safely until the onboarding authority is moved or tightly constrained.

## Compatibility Blockers Verified

| table | before | after | source | behavior |
| --- | --- | --- | --- | --- |
| `quickbooks_tokens` | Browser fallback read | Removed | `src/hooks/useOnboardingStatus.js` | QBO status now uses `/auth/status`; localStorage is only a UI continuity fallback if the API fails. |
| `plaid_items` | Browser fallback read | Removed | `src/hooks/useOnboardingStatus.js` | Plaid status now uses `/api/integrations/plaid/status`; localStorage is only a UI continuity fallback if the API fails. |
| `linked_financial_items` | No frontend-root direct read found | No frontend-root direct read found | n/a | Server-side investment/Plaid code only. |
| `oauth_connection_states` | No frontend-root direct read found | No frontend-root direct read found | n/a | QBO OAuth state service only. |
| `email_accounts` / `email_account_secrets` | No frontend-root direct read found | No frontend-root direct read found | n/a | Google server-side service only. |

## Changes Made

- Removed direct browser fallback query to `quickbooks_tokens` from `useOnboardingStatus`.
- Removed direct browser fallback query to `plaid_items` from `useOnboardingStatus`.
- Tightened Plaid integration route tenant resolution so route code uses only `req.business.id` / verified auth context, not body/query/header tenant values.
- Reduced QBO status response metadata: status still queries `quickbooks_tokens` server-side, but browser receives `realm_id_present` instead of raw `realm_id`, and no `scope`.
- Updated integration manager to consume `realm_id_present`.

## Backend Status API Security

| endpoint | auth | tenant auth | trusted tenant source | response credential exposure |
| --- | --- | --- | --- | --- |
| `GET /auth/status` | `requireAuth` | `requireBusinessAccess()` | `req.business.id` | No access token, refresh token, encrypted token, client secret, auth code, raw realm ID, or scope. |
| `GET /api/integrations/plaid/status` | server mount `requireAuth` | server mount `requireBusinessContext` | `req.business.id` | No Plaid access token, encrypted credential, public token, processor token, or secret. |

## Signup / Onboarding Flow

1. `src/services/authService.js` creates the Supabase Auth user through the browser Supabase client.
2. Auth metadata includes first name, last name, and full name.
3. Live schema contains `handle_confirmed_auth_user_profile()` as a `SECURITY DEFINER` trigger function that inserts/updates `public.user_profiles` after email confirmation.
4. `src/services/businessService.js` also browser-upserts `user_profiles` through `ensureUserProfile(user)`.
5. `src/pages/UserAdmin/BusinessWizard.jsx` reads existing `business_profiles` by `user_id`.
6. On first setup, `BusinessWizard` calls `createBusinessProfile(payload)`, which browser-inserts into `business_profiles` with `user_id: user.id`.
7. After business creation, `BusinessWizard` browser-inserts `user_business_link` with `{ user_id: user.id, business_id, role: 'owner' }`.
8. Existing business setup updates `business_profiles` from the browser.

Current permissive RLS is still required for browser creation of `business_profiles` and initial `user_business_link`. Do not lock those tables before the next migration either moves the flow server-side or adds strict first-owner creation policies.

## Recommended Future Onboarding Authority

Recommended model: OPTION C, authenticated backend API.

The browser should call a protected backend onboarding endpoint. The backend should use `requireAuth`, derive `user_id` from `req.auth.userId`, create/update `business_profiles.user_id = req.auth.userId`, and create the first `user_business_link` owner row for that newly created business only. This avoids allowing a browser to self-attach to an arbitrary existing business or self-promote role.

Option A can work with carefully written `WITH CHECK` policies, but it is easier to get wrong because business creation and initial membership creation are a coupled authority transition. Option B can also work with a hardened RPC, but still requires careful `SECURITY DEFINER`, `search_path`, and `EXECUTE` management.

## Remaining Frontend Supabase `.from()` Inventory

| classification | tables / files | status |
| --- | --- | --- |
| `BLOCKS_RLS_LOCKDOWN` | `business_profiles`: `useOnboardingStatus`, `SettingsHome`, `BusinessWizard`, `Login`; `user_business_link`: `BusinessSwitcher`, `BusinessWizard`, `Login`; `user_profiles`: `ProtectedRoute`, `Login`, `businessService`, `profileService` | Must be handled in authorization-foundation migration. |
| `SHOULD_EVENTUALLY_MOVE_BACKEND` | `financial_metrics`, `expense_totals_monthly`, `report_metadata`, `financial_monthly_review_stamps`, `marketing_profile` | Can remain temporarily, but RLS must be correct before grant cleanup. |
| `SAFE_TO_KEEP_DIRECT_AFTER_RLS` | `post_gallery`, `notifications`, `gpt_usage` | User-private direct access is acceptable only after strict `auth.uid()` policies. |
| `UNKNOWN` | `financial-reports` storage/table-like access in `PNLArchiveViewer` | Needs review with storage policies and object naming. |
| `REMOVED` | `quickbooks_tokens`, `plaid_items` | No frontend-root direct query remains. |

Post-change frontend-root scan found no direct browser query to:

- `quickbooks_tokens`
- `plaid_items`
- `linked_financial_items`
- `oauth_connection_states`
- `email_accounts`
- `email_account_secrets`

## Remaining Blockers For 6D

1. Add a backend onboarding endpoint or hardened RPC for business creation and first owner membership.
2. Stop relying on browser-provided `role: 'owner'` for initial `user_business_link`.
3. Decide whether browser updates to `business_profiles` remain direct with strict owner/admin RLS or move behind backend APIs.
4. Tighten `user_profiles` / `profiles` policies after confirming the auth trigger and browser bootstrap path.
5. Re-review storage access for docs/P&L report files.

## Tests

Added:

- `tests/rlsCompatibilityPrep.security.test.js`

Commands run:

```bash
node --test tests/rlsCompatibilityPrep.security.test.js
node --test tests/plaidSecurity.test.js tests/qboSecurity.test.js tests/privateRouteMounts.security.test.js
npm test
```

Results:

- Compatibility prep tests: 7/7 passed
- Existing Plaid/QBO/private route security tests: 35/35 passed
- Full `npm test`: 606 passed, 3 failed, 3 skipped

The 3 full-suite failures reproduce independently in legacy UI tests and are not caused by this RLS compatibility prep:

- `tests/sidebarNavigationUi.test.js`: `sidebar orders Jobs above Tax` fails because the test cannot find the Jobs tab.
- `tests/taxConfidenceExplanationUi.test.js`: `dashboard keeps confidence breakdown in the trajectory header pill and links tax surfaces to the workpaper route` fails because it expects `ViewCalculationButton`.
- `tests/taxWorkpaperUi.test.js`: `workpaper rows recursively expand and show full traceability detail on hover` fails because the current implementation uses `createPortal`.
