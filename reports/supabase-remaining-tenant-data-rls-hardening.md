# Supabase Remaining Tenant Data RLS Hardening

Date: 2026-08-09

Scope: Prompt 6H. This report covers only the seven tables still failing the staging two-tenant RLS attack harness after authorization-foundation and server-only integration lockdown:

- `bank_transactions`
- `ar_open_items`
- `invoices`
- `financial_metrics`
- `tax_snapshots`
- `bizzy_memory`
- `gpt_usage`

No Supabase connection was made and no migration was executed.

## Current Runtime Context

Latest staging attack result before this phase:

- 142 total
- 88 pass
- 54 fail

The remaining failures were fully accounted for by the seven tables in scope:

- `tax_snapshots`: 8 failures
- `invoices`: 8 failures
- `financial_metrics`: 8 failures
- `bizzy_memory`: 8 failures
- `bank_transactions`: 8 failures
- `ar_open_items`: 8 failures
- `gpt_usage`: 6 failures

## Proposed Migration

Created:

`supabase/migrations/20260813_harden_remaining_tenant_data_rls.sql`

The migration:

- enables RLS on all seven tables
- revokes all direct access from `PUBLIC` and `anon`
- revokes broad `authenticated` access
- grants authenticated users `SELECT` only where direct browser read compatibility exists or the runtime harness expects own-tenant reads
- retains `service_role` full access for trusted backend, sync, cron, tax, AR, and GPT usage write paths
- removes permissive `bizzy_memory` and `gpt_usage` policies
- creates no `USING (true)` or `WITH CHECK (true)` policies
- does not compare `business_id` to `auth.uid()`
- revokes browser access to related AR views `ar_aging` and `ar_aging_v2`
- revokes browser execution of `match_bizzy_memory` and `match_memories`
- revokes browser access to `tax_snapshots_id_seq`

## Table Matrix

| Table | Tenant key | Current issue | Browser allowed after migration | Browser denied after migration | Authorization rule | Backend compatibility |
|---|---:|---|---|---|---|---|
| `bank_transactions` | `business_id` | RLS disabled with broad anon/auth grants | `SELECT` | `INSERT`, `UPDATE`, `DELETE` | `public.bizzi_current_user_is_business_member(business_id)` | `service_role` writes retained for Plaid sync, bookkeeping, jobs, tax, admin review |
| `ar_open_items` | `business_id`; `user_id` is metadata | RLS disabled with broad anon/auth grants | `SELECT` | `INSERT`, `UPDATE`, `DELETE` | `public.bizzi_current_user_is_business_member(business_id)` | `service_role` writes retained for AR/QBO sync and collections APIs |
| `invoices` | `business_id` | RLS disabled with broad anon/auth grants | `SELECT` | `INSERT`, `UPDATE`, `DELETE` | `public.bizzi_current_user_is_business_member(business_id)` | `service_role` writes retained for billing/QBO/insight paths |
| `financial_metrics` | `business_id` | RLS disabled with broad anon/auth grants | `SELECT` | `INSERT`, `UPDATE`, `DELETE` | `public.bizzi_current_user_is_business_member(business_id)` | `service_role` upserts retained for accounting, QBO sync, tax, insights |
| `tax_snapshots` | `business_id` | RLS disabled with broad anon/auth grants and sequence grants | `SELECT` | `INSERT`, `UPDATE`, `DELETE`, sequence usage | `public.bizzi_current_user_is_business_member(business_id)` | `service_role` writes retained for tax snapshot generation/history |
| `bizzy_memory` | `user_id` | RLS enabled but policies used `USING (true)` / `WITH CHECK (true)` | `SELECT` | `INSERT`, `UPDATE`, `DELETE` | `user_id = auth.uid()` | server-side GPT brain continues through `service_role` |
| `gpt_usage` | `user_id` | RLS enabled with duplicate safe SELECT policies plus permissive ALL policy | `SELECT` | `INSERT`, `UPDATE`, `DELETE` | `user_id = auth.uid()` | server-side GPT usage read/upsert continues through `service_role` |

## Browser Access Findings

Direct browser reads found:

- `src/components/Accounting/NetProfitChart.jsx` reads `financial_metrics`
- `src/components/Accounting/RevenueChart.jsx` reads `financial_metrics`
- `src/hooks/useBizzyChat.js` reads `gpt_usage`

No direct browser writes were found in browser roots for any of the seven tables.

## Backend / Service-Role Usage

Write-heavy usage is backend/internal:

- `bank_transactions`: Plaid sync, bookkeeping, reconciliation, jobs, tax, admin monthly review
- `ar_open_items`: AR controller/service and QBO AR sync
- `invoices`: billing/QBO/insights generators
- `financial_metrics`: accounting metrics, QBO sync, tax, insights, GPT context
- `tax_snapshots`: tax snapshot generation and legacy history
- `bizzy_memory`: server-side GPT memory storage/retrieval
- `gpt_usage`: server-side GPT usage enforcement/increment

Because `service_role` access is retained, these backend paths remain compatible from an RLS/grants perspective.

## Related Bypass Paths

Two AR views expose data derived from scoped tables:

- `ar_aging` from `invoices`
- `ar_aging_v2` from `ar_open_items`

The migration revokes `PUBLIC`, `anon`, and `authenticated` access to both views and keeps `service_role` access.

Two memory RPCs expose `bizzy_memory`:

- `match_bizzy_memory`
- `match_memories`

The migration revokes browser execution and keeps `service_role` execution. The current server-side GPT brain uses these RPCs through the backend service-role client.

## Expected Staging Runtime Result

After applying the migration in staging and rerunning `scripts/runStagingTwoTenantRlsAttackTest.js`, expected behavior for the seven tables:

- own-tenant/user `SELECT`: allowed
- cross-tenant/user `SELECT`: denied/no rows
- cross-tenant/user `INSERT`: denied
- cross-tenant/user `UPDATE`: denied/no mutation
- cross-tenant/user `DELETE`: denied/no mutation
- anonymous access: denied

Direct browser writes to these tables are intentionally denied. If future product workflows need browser-side writes, they should either move behind authenticated backend APIs or receive narrowly scoped RLS policies after review.

## Tests

Added:

`tests/remainingTenantDataRlsMigration.security.test.js`

Focused result:

`node --test tests/remainingTenantDataRlsMigration.security.test.js`

Result:

- 8 passed
- 0 failed

## Deferred Items

- Full runtime certification requires applying the migration to staging and rerunning `scripts/runStagingTwoTenantRlsAttackTest.js`.
- Other tenant tables from the 6B plan remain for later RLS phases.
- Additional view hardening beyond `ar_aging` and `ar_aging_v2` remains in the planned view-security phase.
