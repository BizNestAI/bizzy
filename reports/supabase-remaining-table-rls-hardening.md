# Supabase Remaining Table RLS Hardening

Status: READY FOR STAGING REVIEW

This report covers only the ordinary table/RLS-policy layer requested in Security Prompt 6J. It does not remediate views, RPCs, SECURITY DEFINER functions, default privileges, broad sequence cleanup, or storage.

## Migration

Proposed migration:

`supabase/migrations/20260814_harden_uncertified_public_tables_rls.sql`

The migration is additive and was not executed by Codex.

## Classification Summary

| Category | Count |
| --- | ---: |
| BUSINESS_TENANT_BROWSER | 3 |
| USER_PRIVATE_BROWSER | 3 |
| SERVER_ONLY | 25 |
| GLOBAL_REFERENCE_READ_ONLY | 1 |
| INTENTIONALLY_PUBLIC | 0 |
| OBSOLETE/UNUSED | 0 |
| UNKNOWN_REQUIRES_DECISION | 0 |

## Table Matrix

| Table | Classification | Tenant/User Key | Browser Allowed | Browser Denied | Resulting Model |
| --- | --- | --- | --- | --- | --- |
| account_breakdown | SERVER_ONLY | business_id | none | SELECT, INSERT, UPDATE, DELETE | service_role only |
| affordability_assessments | SERVER_ONLY | business_id + user_id | none | SELECT, INSERT, UPDATE, DELETE | service_role only |
| balance_sheet_history | SERVER_ONLY | business_id | none | SELECT, INSERT, UPDATE, DELETE | service_role only |
| billing_customers | SERVER_ONLY | user_id | none | SELECT, INSERT, UPDATE, DELETE | service_role only |
| bizzy_deadlines | SERVER_ONLY | business_id + user_id | none | SELECT, INSERT, UPDATE, DELETE | service_role only |
| bizzy_headlines | SERVER_ONLY | business_id + user_id | none | SELECT, INSERT, UPDATE, DELETE | service_role only |
| bookkeeping_health | SERVER_ONLY | business_id | none | SELECT, INSERT, UPDATE, DELETE | service_role only |
| calendar_events | SERVER_ONLY | business_id + user_id | none | SELECT, INSERT, UPDATE, DELETE | service_role only |
| categorization_rules | SERVER_ONLY | business_id | none | SELECT, INSERT, UPDATE, DELETE | service_role only |
| expense_totals_monthly | BUSINESS_TENANT_BROWSER | business_id | SELECT | INSERT, UPDATE, DELETE | `bizzi_current_user_is_business_member(business_id)` |
| gpt_messages_backup | SERVER_ONLY | user_id | none | SELECT, INSERT, UPDATE, DELETE | service_role only |
| insight_preferences | USER_PRIVATE_BROWSER | user_id | SELECT, INSERT, UPDATE | DELETE, other-user access | `user_id = auth.uid()` |
| insight_reads | SERVER_ONLY | user_id | none | SELECT, INSERT, UPDATE, DELETE | service_role only |
| integration_connections | SERVER_ONLY | business_id | none | SELECT, INSERT, UPDATE, DELETE | service_role only |
| investment_accounts | SERVER_ONLY | user_id | none | SELECT, INSERT, UPDATE, DELETE | service_role only |
| investment_balances | SERVER_ONLY | user_id | none | SELECT, INSERT, UPDATE, DELETE | service_role only |
| monthly_forecast | SERVER_ONLY | business_id + user_id | none | SELECT, INSERT, UPDATE, DELETE | service_role only; removes `business_id = auth.uid()` policy |
| notifications | USER_PRIVATE_BROWSER | user_id + business_id | SELECT, INSERT, UPDATE | DELETE, other-user/tenant access | `user_id = auth.uid()` and member/null business; trigger prevents user/business reassignment |
| plaid_accounts | SERVER_ONLY | business_id | none | SELECT, INSERT, UPDATE, DELETE | service_role only |
| plaid_qbo_account_mappings | SERVER_ONLY | business_id | none | SELECT, INSERT, UPDATE, DELETE | service_role only |
| positions | SERVER_ONLY | user_id | none | SELECT, INSERT, UPDATE, DELETE | service_role only |
| profiles | USER_PRIVATE_BROWSER | id | SELECT, INSERT, UPDATE | DELETE, other-user access | `id = auth.uid()` |
| qbo_posted_transactions | SERVER_ONLY | business_id | none | SELECT, INSERT, UPDATE, DELETE | service_role only |
| review_sources | SERVER_ONLY | business_id | none | SELECT, INSERT, UPDATE, DELETE | service_role only |
| subscriptions | SERVER_ONLY | business_id + user_id | none | SELECT, INSERT, UPDATE, DELETE | service_role only |
| transaction_categorizations | SERVER_ONLY | business_id | none | SELECT, INSERT, UPDATE, DELETE | service_role only |
| vendor_rules | SERVER_ONLY | business_id | none | SELECT, INSERT, UPDATE, DELETE | service_role only |
| cashflow_forecast | SERVER_ONLY | business_id + user_id | none | SELECT, INSERT, UPDATE, DELETE | service_role only; permissive insert policy removed |
| gpt_messages | SERVER_ONLY | business_id + user_id + thread_id | none | SELECT, INSERT, UPDATE, DELETE | service_role only; permissive insert policy removed |
| insights | BUSINESS_TENANT_BROWSER | business_id | SELECT | INSERT, UPDATE, DELETE | `bizzi_current_user_is_business_member(business_id)` |
| tax_deadlines | BUSINESS_TENANT_BROWSER | nullable business_id | SELECT | INSERT, UPDATE, DELETE | `business_id IS NULL OR bizzi_current_user_is_business_member(business_id)` |
| tax_state_rates | GLOBAL_REFERENCE_READ_ONLY | none | authenticated SELECT | anonymous SELECT, INSERT, UPDATE, DELETE | authenticated read-only reference |

## Permissive Policies Removed

- `gpt_messages`: `Allow Inserts for Logged-In Users`
- `cashflow_forecast`: `Allow insert from server only`
- `cashflow_forecast`: `Allow user to read own forecasts`
- `monthly_forecast`: `Can read their forecast`
- `notifications`: `Users can access their own notifications`
- `profiles`: `Users can access their own profile`
- `insights`: `insights_select_any`
- `tax_deadlines`: `tax_deadlines_read`
- `tax_deadlines`: `Users can access deadlines for their business`
- `tax_state_rates`: `tax_state_rates_read`

No `USING (true)`, `WITH CHECK (true)`, or `business_id = auth.uid()` pattern is introduced by the migration.

## Frontend Compatibility

Direct browser Supabase usage found in this table set:

- `expense_totals_monthly`: direct SELECT fallback in `src/components/Accounting/ExpenseBreakdownChart.jsx`
- `notifications`: direct SELECT/UPDATE/INSERT through `src/services/notificationService.js`, imported by `src/components/UserAdmin/NotificationsDropdown.jsx`

The migration preserves these with strict RLS. Other target tables are treated as backend/service-role owned because current code paths use backend APIs or server services.

## Runtime Harness Additions

`scripts/runStagingTwoTenantRlsAttackTest.js` was extended with attack cases for all newly remediated tables:

- server-only own/cross/anonymous direct access denied
- business-readable own SELECT allowed and cross-tenant SELECT denied
- business-readable browser INSERT/UPDATE/DELETE denied
- user-private own SELECT/UPDATE allowed and cross-user SELECT/INSERT/UPDATE/DELETE denied
- authenticated global reference SELECT allowed; anonymous and writes denied

The harness was not executed by Codex because it connects to staging Supabase and mutates dedicated test rows. It should be run after applying the migration to staging.

## Expected Staging Behavior

After applying the migration:

- anonymous users should not directly read or write any table in this phase
- authenticated users should not directly access server-only tables
- authenticated users should only read `expense_totals_monthly`, `insights`, and business-specific `tax_deadlines` for businesses they belong to
- authenticated users may read global `tax_deadlines` rows where `business_id IS NULL`
- authenticated users may read `tax_state_rates`, but may not write it
- authenticated users may manage only their own `notifications`, `profiles`, and `insight_preferences`
- backend/service-role operations should continue to work

## Remaining Scope Outside This Prompt

Still deferred:

- public views
- RPCs and SECURITY DEFINER functions
- default privileges
- broad sequence cleanup beyond `expense_totals_monthly_id_seq`
- storage policies
- full `npm test`
- real staging runtime execution of the extended harness
