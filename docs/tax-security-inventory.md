# Tax Security Inventory

This inventory documents the intended production controls for the Tax module. It does not include secrets.

## Policy Model

- Business ownership is verified through `business_profiles.id` and `business_profiles.user_id = auth.uid()`.
- Backend routes use `assertTaxBusinessAccess` before service-role reads or writes.
- Supabase RLS is hardened by `20260714_tax_security_rls_hardening.sql`.
- Business-scoped user data is readable only for owned businesses.
- User writes are closed at RLS for audited/immutable Tax tables; mutations go through authenticated backend services or service-role RPCs.
- Global rule tables are read-only to authenticated users where product-safe; writes are service-role/admin only.

## Table Inventory

| Table | Owner | Sensitivity | Scope | User Accessible | Service Role Only | RLS | Policies | Export Exposure | Audit / Retention |
|---|---|---:|---|---|---|---|---|---|---|
| `tax_profiles` | Tax setup | High | business | read own | writes via backend | enabled | select own business | no direct export | retained per business |
| `tax_profile_memory` | Tax setup | High | business | read own | writes via backend | enabled | select own business | CPA package bounded | effective-dated history |
| `tax_rule_configs` | Tax admin | Medium | global | safe read | writes service/admin | enabled | authenticated read | rule support only | versioned |
| `state_tax_rule_configs` | Tax admin | Medium | global/state | safe read | writes service/admin | enabled | authenticated read | rule support only | versioned |
| `tax_deduction_rules` | Tax admin/user overrides | Medium/High | global or business | read global/own | writes via backend | enabled | global read or own business | CPA package summaries | versioned |
| `transaction_tax_classifications` | Deductions/review | High | business | read own | writes via backend/RPC | enabled | select own business | deductions export | override-protected |
| `tax_classification_overrides` | Review audit | High | business | read own | append via RPC | enabled | select own business | transaction history | immutable audit |
| `tax_adjustments` | Tax adjustments | High | business | read own | writes via backend | enabled | select own business | explanations only | retained |
| `tax_calculation_runs` | Canonical engine | High | business | read own | mutations backend/RPC | enabled | select own business | canonical run exports | immutable/superseded |
| `tax_calculation_components` | Explanations | High | business | read own | append during finalize | enabled | select own business | bounded explanations | immutable with run |
| `tax_calculation_run_links` | Run audit | Medium | business | read own | backend only | enabled | select own business | no direct export | immutable links |
| `tax_payments` | Planning | High | business | read own | writes via backend | enabled | select own business | planning/export | void, not hard-delete |
| `tax_deadlines` | Planning/rules | Medium | global/business | safe read | writes backend/admin | enabled | global read or own business | displayed only | versioned |
| `tax_reserve_accounts` | Reserve | High | business | read own masked | writes via backend | enabled | select own business | no full account numbers | explicit primary |
| `tax_reserve_snapshots` | Reserve history | High | business | read own | append backend only | enabled | select own business | explanations/QA | immutable snapshots |
| `tax_review_tasks` | Review workflow | Medium | business | read own | backend only | enabled | select own business | review UI | retained until resolved |
| `tax_projection_scenarios` | Scenarios | High | business | read own | backend only | enabled | select own business | scenario UI | retained |
| `tax_recalculation_requests` | Internal queue | Medium | business | no normal UI | worker/service | enabled | select own if exposed | diagnostics only | retry/dead-letter |
| `tax_scheduler_runs` | Internal scheduler | Low/Medium | business/system | diagnostics | worker/service | enabled | select own if business scoped | admin diagnostics | retained summary |
| `tax_snapshots` | Legacy history | High | business | read own legacy | read-only legacy | enabled | select own business | legacy labeled export | historical only |
| `tax_legacy_migration_records` | Migration audit | Medium | business | no normal UI | migration/admin | enabled | select own if exposed | admin only | retained audit |

## Source Tables Used By Tax

Tax reads `bank_transactions`, `transaction_categorizations`, `qbo_posted_transactions`, `business_profiles`, `cashflow_forecast`, and `insights` through business-scoped services. Raw Plaid/QBO payloads must not be exposed through Tax DTOs, explanations, drawers, or exports.

## Route Inventory

All mounted `/api/tax/*` routes are behind the application `requireAuth` middleware and Tax router security middleware.

| Route Area | Auth | Business Auth | Service Role Boundary | Export Exposure | Notes |
|---|---|---|---|---|---|
| Overview/calculations | required | `assertTaxBusinessAccess` | backend only | run/export detail | run IDs resolved under business |
| Profile/memory | required | `assertTaxBusinessAccess` | backend only | none | user writes through API |
| Deductions | required | `assertTaxBusinessAccess` | backend only | CSV/CPA package | CSV must neutralize formulas |
| Classification review/override | required | `assertTaxBusinessAccess` | RPC/service | history only | immutable override audit |
| Payments | required | `assertTaxBusinessAccess` | backend only | planning history | void over delete |
| Reserve | required | `assertTaxBusinessAccess` | backend only | masked account metadata | no full account numbers |
| Confidence/explanations/components | required | `assertTaxBusinessAccess` | backend only | bounded source refs | no raw payloads |
| Recalculation diagnostics | required | `assertTaxBusinessAccess` | backend only | diagnostics | no queue secrets |
| Scheduler routes | internal secret | internal only | service worker | none | ordinary users denied |
| Legacy snapshot history | required | `assertTaxBusinessAccess` | read-only | labeled legacy | not authoritative |
| Deprecated snapshot/insight routes | required by app router | 410 only | no legacy service call | none | canonical replacements returned |

## Logging And Observability

Tax logs must use safe structured fields: `requestId`, `businessId`, `userId`, `runId`, `eventId`, `route`, `duration`, `outcome`, and `errorCode`. Do not log tokens, raw bank/QBO payloads, service-role keys, full account numbers, or stack traces to users.

## Immutability And Retention

- Completed canonical runs and components are immutable; supersession creates links instead of rewriting history.
- Override history is append-only.
- Reserve snapshots are append-only.
- Payments are voided where supported; hard delete is not part of the normal UI.
- Legacy snapshots are preserved read-only until the documented retention policy says otherwise.
