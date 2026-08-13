# Supabase View/RPC/Function Hardening

Scope: public views, public RPC/function EXECUTE grants, and SECURITY DEFINER search paths after table/RLS remediation through 6J. This report does not certify default privileges, sequences, storage, or production runtime execution.

## Verdict

The proposed migration `supabase/migrations/20260815_harden_views_rpc_functions.sql` is ready for staging review. It keeps the 498/498 table-RLS runtime baseline intact by avoiding table-policy changes.

## Views

| View | Current use | Classification | Target access | Reason |
| --- | --- | --- | --- | --- |
| `ar_aging` | Backend GPT/insights service-role reads | BACKEND_ONLY | service_role only, `security_invoker` | Exposes AR/invoice business data. |
| `ar_aging_v2` | Backend/service-role AR surface | BACKEND_ONLY | service_role only, `security_invoker` | Exposes AR business data. |
| `billing_customer_overview` | Backend billing summary | BACKEND_ONLY | service_role only, `security_invoker` | Contains billing/customer identifiers. |
| `expense_categories` | Backend GPT/insights service-role reads | BACKEND_ONLY | service_role only, `security_invoker` | Aggregates job cost data. |
| `insights_history` | Backend insights routes | BACKEND_ONLY | service_role only, `security_invoker` | Joins tenant insights/read state. |
| `jobs_profitability` | Backend GPT/insights service-role reads | BACKEND_ONLY | service_role only, `security_invoker` | Exposes job financial data. |
| `positions_view` | Backend investment insights | BACKEND_ONLY | service_role only, `security_invoker` | Exposes investment account/position data. |

No browser code was found directly querying these views. Existing code paths use backend/service-role clients.

## Functions And RPCs

| Function | Classification | Browser EXECUTE target | Notes |
| --- | --- | --- | --- |
| `acquire_posting_lock(uuid,text,timestamptz,int,text)` | BACKEND_ONLY_RPC | revoked | Mutates transaction posting lock state. |
| `acquire_posting_lock(uuid,uuid,timestamptz,int,text)` | BACKEND_ONLY_RPC | revoked | Mutates transaction posting lock state. |
| `apply_tax_classification_override(...)` | BACKEND_ONLY_RPC | revoked | Accepts business/transaction/user parameters and mutates tax classifications. |
| `billing_effective_bool(...)` | BACKEND_ONLY_HELPER | revoked | Pure helper used by backend/view logic; no browser RPC dependency. |
| `billing_effective_status(...)` | BACKEND_ONLY_HELPER | revoked | Pure helper used by backend/view logic. |
| `billing_effective_text(...)` | BACKEND_ONLY_HELPER | revoked | Pure helper used by backend/view logic. |
| `billing_effective_timestamptz(...)` | BACKEND_ONLY_HELPER | revoked | Pure helper used by backend/view logic. |
| `bizzy_docs_tsv_update()` | BACKGROUND_INTERNAL | revoked | Trigger-only helper. |
| `bizzi_current_user_is_business_member(uuid)` | RLS_HELPER | authenticated allowed | Uses `auth.uid()` only; required by table policies. |
| `bizzi_current_user_can_manage_business(uuid)` | RLS_HELPER | authenticated allowed | Uses `auth.uid()` only; required by table policies. |
| `claim_contractor_cfo_insight_run(...)` | BACKGROUND_INTERNAL | revoked | SECURITY DEFINER job lock RPC. |
| `claim_scheduled_job_lock(...)` | BACKGROUND_INTERNAL | revoked | SECURITY DEFINER scheduler lock RPC. |
| `claim_tax_recalculation_requests(...)` | BACKGROUND_INTERNAL | revoked | SECURITY DEFINER worker claim RPC. |
| `compute_days_overdue(date)` | BACKEND_ONLY_HELPER | revoked | Pure helper; no browser RPC dependency. |
| `create_initial_business_for_user(...)` | BACKEND_ONLY_RPC | revoked | Service-role-only onboarding authority remains intact. |
| `finalize_tax_calculation_run(...)` | BACKEND_ONLY_RPC | revoked | Accepts tenant/run data and mutates tax run state. |
| `get_tax_deduction_transaction_drilldown(...)` | BACKEND_ONLY_RPC | revoked | Accepts `business_id`; backend already authorizes before service-role use. |
| `gpt_messages_after_delete_trg()` | BACKGROUND_INTERNAL | revoked | Trigger-only helper. |
| `handle_confirmed_auth_user_profile()` | BACKGROUND_INTERNAL | revoked | Auth trigger function; search path hardened. |
| `is_member(uuid,uuid)` | BACKEND_ONLY_LEGACY_HELPER | revoked | Legacy helper accepted arbitrary user/business IDs and is not referenced by current policies. |
| `match_bizzy_memory(...)` | BACKEND_ONLY_RPC | revoked | Vector memory search; server GPT brain uses service-role. |
| `match_memories(...)` | BACKEND_ONLY_RPC | revoked | Vector memory search; server-only. |
| `prevent_business_profile_identity_reassignment()` | BACKGROUND_INTERNAL | revoked | Trigger-only helper. |
| `prevent_completed_tax_run_mutation()` | BACKGROUND_INTERNAL | revoked | Trigger-only helper. |
| `prevent_notification_tenant_reassignment()` | BACKGROUND_INTERNAL | revoked | Trigger-only helper. |
| `prevent_user_business_link_identity_reassignment()` | BACKGROUND_INTERNAL | revoked | Trigger-only helper. |
| `recalc_thread_last_message(uuid)` | BACKEND_ONLY_RPC | revoked | Updates thread metadata by caller-supplied thread ID. |
| `refresh_billing_identity_summary(uuid)` | BACKEND_ONLY_RPC | revoked | SECURITY DEFINER billing summary refresh by business ID. |
| `refresh_billing_identity_summary_from_billing()` | BACKGROUND_INTERNAL | revoked | Trigger helper; search path hardened. |
| `refresh_billing_identity_summary_from_business_profile()` | BACKGROUND_INTERNAL | revoked | Trigger helper; search path hardened. |
| `refresh_billing_identity_summary_from_user_profile()` | BACKGROUND_INTERNAL | revoked | Trigger helper; search path hardened. |
| `set_bid_estimate_line_items_updated_at()` | BACKGROUND_INTERNAL | revoked | Trigger-only helper. |
| `set_bid_estimates_updated_at()` | BACKGROUND_INTERNAL | revoked | Trigger-only helper. |
| `set_job_costing_updated_at()` | BACKGROUND_INTERNAL | revoked | Trigger-only helper. |
| `set_job_financial_updated_at()` | BACKGROUND_INTERNAL | revoked | Trigger-only helper. |
| `set_job_margin_targets_updated_at()` | BACKGROUND_INTERNAL | revoked | Trigger-only helper. |
| `set_job_transaction_assignments_updated_at()` | BACKGROUND_INTERNAL | revoked | Trigger-only helper. |
| `set_updated_at()` | BACKGROUND_INTERNAL | revoked | Trigger-only helper. |
| `set_user_profiles_full_name()` | BACKGROUND_INTERNAL | revoked | Trigger-only helper. |
| `sync_tax_payment_year_fields()` | BACKGROUND_INTERNAL | revoked | Trigger-only helper. |
| `tax_user_owns_business(uuid)` | RLS_HELPER | authenticated allowed | Legacy RLS helper; returns true only for caller-owned business. |
| `tc_sync_txn_fields_from_bank_transactions()` | BACKGROUND_INTERNAL | revoked | Trigger-only helper. |
| `touch_gpt_thread_updated_at()` | BACKGROUND_INTERNAL | revoked | Trigger-only helper. |
| `touch_tax_recalculation_requests_updated_at()` | BACKGROUND_INTERNAL | revoked | Trigger-only helper. |

## Security Definer

The migration hardens search paths for every in-scope SECURITY DEFINER function:

- posting lock functions
- scheduler/worker claim functions
- confirmed-auth profile trigger
- billing refresh functions
- tax ownership helper
- current business membership/management helpers
- initial onboarding RPC

The older broad anon/authenticated EXECUTE grants are removed from internal SECURITY DEFINER functions. Only the reviewed RLS helpers remain authenticated-callable because active RLS policies execute them in authenticated contexts.

## Runtime Harness Additions

`scripts/runStagingTwoTenantRlsAttackTest.js` now adds:

- direct SELECT attempts against all seven views as User A, User B, and anonymous
- own and foreign checks for `bizzi_current_user_is_business_member`
- own and foreign checks for `bizzi_current_user_can_manage_business`
- own and foreign checks for `tax_user_owns_business`
- authenticated and anonymous denied-execution probes for backend-only RPCs

The existing table/RLS expectations were not weakened.

## Remaining Follow-Up

- Runtime validation must be rerun against staging after applying the migration.
- Default privileges, broad future function grants, sequences, and storage remain separate phases.
- Moving RLS helpers out of `public` would reduce RPC discoverability further, but would require policy rewrites and was intentionally deferred to avoid weakening the passing baseline.

## Required Answers

- Can any browser-accessible view leak cross-tenant data? Expected **NO** after migration; all tenant-sensitive views become service-role only.
- Can any RPC accept a known foreign business/user/resource ID and bypass authorization? Expected **NO** for browser roles after migration; backend-only RPCs revoke anon/authenticated EXECUTE, and reviewed RLS helpers use `auth.uid()`.
- Can any ordinary authenticated user execute an internal/admin SECURITY DEFINER function? Expected **NO** after migration.
- Are all SECURITY DEFINER functions using hardened search paths? **YES** for the in-scope functions hardened by this migration.
- Are browser EXECUTE grants minimized? **YES** for this phase; only reviewed RLS helpers remain authenticated-callable.
- Are the existing RLS helper functions safe? **YES** by static review: they derive authority from `auth.uid()` and do not trust caller-supplied user IDs.
- Which views remain browser-accessible and why? **None** in this phase.
- Which RPCs remain browser-accessible and why? `tax_user_owns_business`, `bizzi_current_user_is_business_member`, and `bizzi_current_user_can_manage_business`, because table policies require them under authenticated caller context.
- Which runtime attack cases were added? View SELECT denial, backend-only RPC denial, RLS helper own/foreign truth-value checks, anonymous helper/RPC denial.
- Is the proposed migration safe to apply to staging? **YES**, pending review and normal staging execution.
