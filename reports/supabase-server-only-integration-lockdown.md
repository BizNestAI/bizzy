# Supabase Server-Only Integration Lockdown

Date: 2026-08-09

Scope: server-only provider credential, OAuth state, webhook, sync, and backfill tables.

This is a pre-execution report. No Supabase connection was made and the migration was not applied.

## Source Inputs

- `supabase/live_schema_snapshot.sql`
- `reports/supabase-rls-security-audit.md`
- `reports/supabase-rls-remediation-plan.md`
- `reports/supabase-two-tenant-runtime-security-test.md`
- Current application source code

## Migration Created

`supabase/migrations/20260812_lock_down_server_only_integrations.sql`

The migration is additive. It does not alter unrelated financial/tenant tables and does not change existing customer data.

## Server-Only Tables Classified

| Table | Reason | Frontend direct dependency | Backend/service-role dependency | Background/worker dependency | Current issue from snapshot/report | Target state |
| --- | --- | --- | --- | --- | --- | --- |
| `quickbooks_tokens` | QBO access/refresh tokens and realm binding | None current; prior onboarding fallback removed | QBO OAuth, refresh, sync, AR/accounting/GPT status | QBO job costing sync, forecast | RLS disabled; `anon/authenticated=ALL`; runtime direct read/update/delete failures | Service-role only |
| `plaid_items` | Plaid access token, item cursor/status | None current; prior onboarding fallback removed | Plaid exchange/status/sync/disconnect | Plaid sync, reconciliation | RLS disabled; `anon/authenticated=ALL`; runtime direct read/insert/update/delete failures | Service-role only |
| `linked_financial_items` | Legacy Plaid encrypted token linkage | None found | Investments Plaid service | None found | RLS disabled; `anon/authenticated=ALL`; runtime direct read/insert/update/delete failures | Service-role only |
| `oauth_connection_states` | QBO OAuth state hash, binding, replay/expiry metadata | None found | QBO OAuth state service | None found | RLS enabled but broad grants | Service-role only |
| `email_accounts` | Gmail account integration metadata; paired with token secret storage in server code | None found in browser roots | Gmail account listing/OAuth/disconnect services | None found | RLS enabled but broad grants and browser policies | Service-role only |
| `bank_sync_runs` | Plaid/bank sync run state | None found in browser roots | Plaid sync/reconciliation/bookkeeping APIs | Plaid sync/reconciliation | RLS disabled; `anon/authenticated=ALL` | Service-role only |
| `qbo_backfill_jobs` | QBO backfill operational state | None found | QBO backfill job service | QBO backfill | RLS disabled; `anon/authenticated=ALL` | Service-role only |
| `qbo_cdc_cursors` | QBO CDC cursor state | None found in browser roots | QBO job costing sync service | QBO job costing sync | Broad grants and authenticated policies | Service-role only |
| `qbo_entity_sync_runs` | QBO entity sync run state | None found in browser roots | QBO job costing sync service | QBO job costing sync | Broad grants and authenticated policies | Service-role only |
| `qbo_job_costing_backfill_runs` | QBO job costing backfill state | None found in browser roots | QBO ongoing sync service | QBO job costing backfill | Broad grants and authenticated policies | Service-role only |
| `qbo_job_costing_daily_sync_state` | QBO daily sync scheduler state | None found in browser roots | QBO ongoing sync service | QBO job costing daily sync | Broad grants and authenticated policies | Service-role only |
| `qbo_webhook_events` | QBO webhook processing/event state | None found in browser roots | QBO webhook/sync service | QBO webhook worker | Broad grants and authenticated policies | Service-role only |

`email_account_secrets` is referenced by server code but was not present in `supabase/live_schema_snapshot.sql`; no migration statement was generated for a non-existent live public table.

## SQL Changes

For every table above, the migration:

- enables RLS as defense in depth;
- revokes all table privileges from `PUBLIC`;
- revokes all table privileges from `anon`;
- revokes all table privileges from `authenticated`;
- grants `ALL` to `service_role`;
- creates no browser-facing RLS policies.

It also removes old browser-facing policies from:

- `email_accounts`
- `qbo_cdc_cursors`
- `qbo_entity_sync_runs`
- `qbo_job_costing_backfill_runs`
- `qbo_job_costing_daily_sync_state`
- `qbo_webhook_events`

## Application Compatibility

### QuickBooks

- QBO status uses backend APIs protected by canonical auth/tenant middleware.
- QBO OAuth callback persists tokens through trusted backend/service-role code.
- QBO token refresh and sync code use server-side Supabase clients.
- QBO background jobs retain access through `service_role`.

### Plaid

- Plaid status uses backend APIs protected by canonical auth/tenant middleware.
- Plaid public-token exchange persists credentials through trusted backend/service-role code.
- Plaid sync and disconnect use server-side token lookup/decryption.
- Plaid background sync/reconciliation retain access through `service_role`.

### Gmail / Email OAuth

- `email_accounts` direct browser access is not required by current browser roots.
- Gmail token material is handled server-side through Google service helpers.
- `email_account_secrets` should be audited separately if/when present in the live schema.

## Browser-Visible Response Safety

Existing focused tests already cover:

- QBO/Plaid integration status responses do not expose provider credential fields.
- Plaid exchange responses do not return Plaid access tokens.
- QBO browser responses do not include QBO credentials or authorization codes.

This migration does not add views, RPCs, or policies exposing encrypted token columns/ciphertext.

## Tests Added

`tests/serverOnlyIntegrationLockdown.security.test.js`

The tests assert:

- every target table has RLS enabled in the migration;
- `PUBLIC`, `anon`, and `authenticated` table privileges are revoked;
- only `service_role` keeps direct table access;
- no browser-readable policies are created;
- known legacy policies are dropped;
- frontend browser roots do not directly query the locked tables.

## Runtime Validation Required

After applying this migration to staging, rerun the real two-tenant RLS attack harness and explicitly verify:

- ordinary authenticated users cannot read/mutate credential or provider state tables;
- anonymous users cannot read/mutate credential or provider state tables;
- QBO status/connect/callback/refresh/sync still work through backend APIs;
- Plaid status/link-token/exchange/sync/disconnect still work through backend APIs;
- Gmail account listing/connect/disconnect still work through backend APIs if that feature is active.

## Remaining Risks / Deferred Work

- This prompt does not lock down customer financial tables such as `bank_transactions`, `invoices`, or `ar_open_items`.
- This prompt does not globally change default privileges.
- This prompt does not audit or lock down every QBO data mirror table, such as `qbo_customers`, `qbo_projects`, or `qbo_posted_transactions`; those are tenant data and belong in a later tenant-table RLS phase.
- `email_account_secrets` is referenced in code but absent from the live schema snapshot; confirm whether it exists in another schema or is pending migration.
