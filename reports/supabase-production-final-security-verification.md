# Production Supabase Final Security Verification

Scope: Security Prompt 6N-A. This is a read-only verification of the post-hardening production public schema exported to `supabase/live_schema_snapshot.sql`.

No Supabase connection was made. No SQL was executed. No code, migrations, policies, grants, or production data were modified.

## Verdict

**PRODUCTION PUBLIC DATABASE/RLS VERDICT: PASS**

The post-hardening production snapshot matches the expected remediation shape for the public database/RLS layer. The previously confirmed cross-tenant table/RLS vulnerabilities are no longer visible in the production schema, and the staging runtime harness baseline remains `570 passed / 0 failed`.

Storage remains **DEFERRED BEFORE LAUNCH** because staging previously had zero Storage buckets and zero Storage policies. That does not invalidate the public-schema database/RLS certification.

## Sources Reviewed

- `supabase/live_schema_snapshot.sql`
- Security migrations through `20260816_harden_default_privileges_sequences_schema.sql`
- `reports/supabase-two-tenant-runtime-security-test.md`
- Prior reports from 6A through 6L
- Current frontend/backend Supabase usage by static source search

## Production Snapshot Inventory

| Area | Result |
| --- | --- |
| Public tables | 138 |
| Public views | 7 |
| Public functions | 44 |
| SECURITY DEFINER functions | 14 |
| RLS-enabled tables | 136 |
| RLS-disabled tables | 2 |
| RLS policies | 157 |
| Explicit browser sequence grants | 0 |
| Explicit browser function grants | 3 authenticated-only RLS helpers |
| PUBLIC function grants | 0 |
| anon function grants | 0 |

RLS-disabled tables:

| Table | Classification | Finding |
| --- | --- | --- |
| `prices_cache` | global market/reference cache | RLS disabled with anon/authenticated table grants; not tenant/customer data. |
| `securities` | global market/reference catalog | RLS disabled with anon/authenticated table grants; not tenant/customer data. |

## Area Classification

| Area | Classification | Verification |
| --- | --- | --- |
| Authentication foundation | VERIFIED_SAFE_BY_RUNTIME | `user_profiles` has own-user policies; staging attack harness passed own/other/anonymous checks. |
| Business membership/ownership | VERIFIED_SAFE_BY_RUNTIME | `business_profiles` and `user_business_link` now use membership/management helpers, deny anonymous access, deny membership self-insert, and include immutable ownership triggers. |
| Tenant financial data | VERIFIED_SAFE_BY_RUNTIME | Harness covered core and expanded tenant tables; production snapshot has no permissive `true` policies or `business_id = auth.uid()` matches. |
| User-private data | VERIFIED_SAFE_BY_RUNTIME / SAFE_BY_STATIC_REVIEW | `user_profiles`, `profiles`, `notifications`, `insight_preferences`, `bizzy_memory`, and `gpt_usage` use `auth.uid()`-based policies where browser-accessible. |
| QBO/Plaid/OAuth/email credential tables | SAFE_BY_STATIC_REVIEW | RLS enabled, no browser grants, no browser policies, service-role access retained. |
| Views | VERIFIED_SAFE_BY_RUNTIME / SAFE_BY_STATIC_REVIEW | All 7 public views are `security_invoker=true` and have service-role-only grants in the production snapshot. |
| RPCs/functions | VERIFIED_SAFE_BY_RUNTIME / SAFE_BY_STATIC_REVIEW | No PUBLIC/anon EXECUTE grants; authenticated EXECUTE remains only on the reviewed RLS helpers. |
| SECURITY DEFINER functions | SAFE_BY_STATIC_REVIEW | All 14 SECURITY DEFINER functions set `search_path` to `pg_catalog, public`; internal/admin functions are service-role only. |
| Default privileges | SAFE_BY_STATIC_REVIEW | Future postgres-created public tables/functions/sequences grant to `postgres` and `service_role` only. |
| Sequences | SAFE_BY_STATIC_REVIEW | Explicit sequence grants are service-role only; no anon/authenticated/PUBLIC sequence grants found. |
| Public schema privileges | SAFE_BY_STATIC_REVIEW | Browser roles have `USAGE` on schema `public`; no `CREATE` grant was found. |
| Anonymous access | SAFE_BY_STATIC_REVIEW | No anon policies or anon function grants found; anon table grants on RLS-protected tables do not produce row access without policies. |
| Direct frontend Supabase usage | SAFE_BY_STATIC_REVIEW | Frontend still reads allowed foundation/user/document surfaces; server-only credential table access is not exposed as direct browser access. |
| Storage | DEFERRED_OPERATIONAL | Prior Storage audit found no staging buckets or policies. Future buckets require bucket policies and runtime tests before launch. |

## Authorization Foundation

`business_profiles`:

- RLS enabled.
- `authenticated` has `SELECT, UPDATE`.
- No anon grant.
- SELECT requires `public.bizzi_current_user_is_business_member(id)`.
- UPDATE requires `public.bizzi_current_user_can_manage_business(id)` for both `USING` and `WITH CHECK`.
- `prevent_business_profile_identity_reassignment()` blocks `id` and `user_id` reassignment.

`user_business_link`:

- RLS enabled.
- `authenticated` has `SELECT` only.
- No anon grant.
- No authenticated INSERT/UPDATE/DELETE grant remains.
- SELECT limited to the current user's own membership row or business managers.
- `prevent_user_business_link_identity_reassignment()` blocks `id`, `user_id`, `business_id`, and `role` reassignment.

The service-role-only onboarding RPC `create_initial_business_for_user(...)` remains present, SECURITY DEFINER, search-path hardened, and service-role executable.

## Credential / Server-Only Tables

The following credential/integration tables are production server-only by effective grants:

| Table | RLS | Browser grants | Policies | Service role |
| --- | --- | --- | --- | --- |
| `quickbooks_tokens` | enabled | none | none | retained |
| `plaid_items` | enabled | none | none | retained |
| `linked_financial_items` | enabled | none | none | retained |
| `oauth_connection_states` | enabled | none | none | retained |
| `email_accounts` | enabled | none | none | retained |
| `qbo_cdc_cursors` | enabled | none | none | retained |
| `qbo_entity_sync_runs` | enabled | none | none | retained |
| `qbo_job_costing_backfill_runs` | enabled | none | none | retained |
| `qbo_job_costing_daily_sync_state` | enabled | none | none | retained |
| `qbo_webhook_events` | enabled | none | none | retained |
| `integration_connections` | enabled | none | none | retained |
| `plaid_accounts` | enabled | none | none | retained |
| `plaid_qbo_account_mappings` | enabled | none | none | retained |
| `qbo_posted_transactions` | enabled | none | none | retained |

## RLS Policy Quality

Static search of the production snapshot found:

- `USING (true)`: none.
- `WITH CHECK (true)`: none.
- `business_id = auth.uid()` or reverse comparison: none.
- Remaining business-scoped policies use membership/ownership helpers or equivalent business/user scoping.
- Remaining user-private policies use `auth.uid()` against user identity fields.

## Grants

Positive findings:

- No `PUBLIC` table grants were found.
- No `PUBLIC` or `anon` function grants were found.
- Credential/server-only integration tables have no anon/authenticated table grants.
- Explicit sequence grants are service-role only.

Residual defense-in-depth note:

- Several RLS-enabled tables still retain broad `anon`/`authenticated` table grants. Where no anon policy exists, RLS prevents anonymous row access. This is not a confirmed data exposure in the production snapshot, but future cleanup can further reduce table grants to match each classification exactly.
- The two RLS-disabled reference/cache tables, `prices_cache` and `securities`, retain anon/authenticated `ALL` grants. They appear to contain global security/price reference data, not tenant/customer records. Treat write access to these global caches as a least-privilege follow-up if browser writes are not intentional.

## Default Privileges, Schema, and Sequences

Default privileges now grant future public objects created by `postgres` only to:

- `postgres`
- `service_role`

No default privileges to `PUBLIC`, `anon`, or `authenticated` were found for tables, functions, or sequences.

Schema grants:

- `USAGE` on `public` exists for `anon`, `authenticated`, and `service_role`.
- No browser `CREATE` on `public` was found.

Sequences:

- Explicit grants found only for `service_role`: `expense_category_map_id_seq`, `expense_totals_monthly_id_seq`, and `tax_snapshots_id_seq`.
- No anon/authenticated/PUBLIC sequence grants found.

## Views

Public views in the production snapshot:

- `ar_aging`
- `ar_aging_v2`
- `billing_customer_overview`
- `expense_categories`
- `insights_history`
- `jobs_profitability`
- `positions_view`

All are defined with `security_invoker=true` and granted only to `service_role`. Browser callers cannot use these views directly, so they cannot bypass base-table RLS.

## RPC / Function Security

Authenticated-callable helpers:

- `tax_user_owns_business(uuid)`
- `bizzi_current_user_is_business_member(uuid)`
- `bizzi_current_user_can_manage_business(uuid)`

These are read-only helpers, use `auth.uid()`, accept only a business UUID, do not accept caller-supplied user identity, and disclose only a boolean authorization result.

All SECURITY DEFINER functions in the snapshot set:

`search_path = pg_catalog, public`

Internal/admin functions, background locks, billing refresh functions, onboarding RPC, trigger helpers, memory match RPCs, and tax/accounting RPCs are not browser-callable in the production snapshot.

## Frontend Database Boundary

Static frontend/backend search found current direct browser usage aligned with hardened grants for:

- `business_profiles`
- `user_business_link`
- `user_profiles` / `profiles`
- document metadata and permitted user/business surfaces

Server-only credential/integration tables are accessed through backend, cron, service, or API paths, not as direct browser-authorized tables. QBO/Plaid/OAuth/email credential tables have no browser grants in production.

Storage usage remains a separate unresolved launch item because document/report components use Supabase Storage paths and signed/download flows, but staging Storage had no buckets or policies to certify.

## Original Finding Comparison

| Original severity | Original count | Production post-hardening status |
| --- | ---: | --- |
| CRITICAL | 38 | Remediated for public table/RLS, credential-table, authorization-foundation, view/RPC/function, default privilege, schema, and sequence findings visible in the snapshot and covered by staging runtime tests. |
| HIGH | 6 | Remediated for the tested database isolation surfaces; no remaining high-risk permissive policies were found. |
| MEDIUM | 92 | Remediated or reduced to defense-in-depth follow-up where broad grants remain behind restrictive RLS. Storage remains deferred operational work. |
| LOW | 2 | `prices_cache` and `securities` remain RLS-disabled global reference/cache tables with browser grants; not tenant/customer data, but write privileges should be reviewed for least privilege. |

## Required Answers

- Can authenticated User A directly read unrelated Business B data from any known production public table? **NO**, based on the production snapshot and staging runtime baseline.
- Can User A directly mutate unrelated Business B data? **NO**, based on the production snapshot and staging runtime baseline.
- Can User A attach themselves to Business B? **NO**; `user_business_link` has no authenticated INSERT grant.
- Can User A elevate themselves to owner/admin of Business B? **NO**; membership writes are not browser-granted and role reassignment is trigger-blocked.
- Can anonymous users read private customer data? **NO**; no anon policies were found and private tables are RLS-protected or server-only.
- Can browser roles directly access Plaid/QBO/OAuth/email credentials? **NO**.
- Do any unsafe permissive RLS policies remain? **NO**.
- Do any RLS-disabled private tables remain with browser grants? **NO**. The remaining RLS-disabled tables are global reference/cache tables.
- Can any view bypass intended isolation? **NO**; views are `security_invoker=true` and service-role only.
- Can any browser-callable RPC bypass intended isolation? **NO known browser-callable RPC can do so**; only the reviewed boolean RLS helpers remain authenticated-callable.
- Are SECURITY DEFINER functions appropriately hardened? **YES**; all have hardened search paths and non-helper internal functions are service-role only.
- Are default privileges safe for future objects? **YES**.
- Are schema and sequence privileges least-privilege? **YES for schema CREATE and sequences**; table grants still have defense-in-depth cleanup opportunities behind RLS.
- Does current frontend Supabase usage remain compatible with the hardened production permissions? **YES for public database/RLS surfaces reviewed**.
- Is there any known production public-database vulnerability that should block customer onboarding? **NO**.
- Is the production Supabase public database/RLS layer ready for launch? **YES, with Storage still deferred before launch.**

## Remaining Launch Items

1. Storage must be created/copied into staging, policy-hardened, and runtime-tested before launch.
2. Consider a future least-privilege cleanup for broad table grants that remain behind restrictive RLS, especially write grants on global reference/cache tables if browser writes are not intentional.
3. Production runtime attack testing was not executed in this prompt; this certification is based on the production schema snapshot plus the already-passing staging runtime harness.

