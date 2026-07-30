# Tax Architecture

## Canonical Live Path

Frontend:

- `TaxDashboard` -> `useTaxOverview` -> `taxApiClient` -> `GET /api/tax/overview`
- `DeductionsWorkspace` -> `useTaxDeductions` -> canonical deductions endpoints
- `TaxTransactionReviewDrawer` -> classification review and override endpoints
- `TaxPlanningPanel` -> payment and reserve endpoints
- Confidence and explanation drawers -> canonical calculation run endpoints

Backend:

- `GET /api/tax/overview` -> canonical Tax Orchestrator
- canonical calculation -> immutable `tax_calculation_runs`
- DTO output -> overview, deductions, reserve, confidence, explanations, and changes

Event-driven recalculation:

- Canonical mutations emit safe tax data change events.
- Events are normalized by `src/services/tax/events/*`.
- Compatible bursts coalesce into `tax_recalculation_requests`.
- `startTaxRecalculationWorker()` claims due requests and calls `runCanonicalTaxCalculation`.
- The orchestrator reuses fingerprints and immutable runs, so duplicate events do not create duplicate completed runs.
- Completed runs are compared to the previous run before downstream material-change signals are emitted.

Scheduled recalculation:

- `startTaxScheduler()` runs daily and weekly tax scheduler ticks when enabled.
- Daily and weekly schedulers are producers into `tax_recalculation_requests`; they do not calculate tax inline for every business.
- `scheduled_job_locks` prevents duplicate daily/weekly execution across app instances.
- `tax_scheduler_runs` records safe job summaries: scanned businesses, eligible businesses, queued requests, skips, reused runs, and failures.
- Eligibility treats incomplete setup, unsupported entities, missing posted transactions, fresh runs, and running calculations as skip reasons, not system failures.
- Deadline and reserve scans read canonical run/deadline/reserve data only. Missing reserve accounts remain `null`/setup incomplete, never `$0`.
- Weekly jobs verify broader source quality and queue canonical calculations, but run fingerprints still prevent duplicate completed runs when inputs have not changed.

Insights:

- canonical run and material business context -> Contractor CFO engine -> global `InsightsRail`
- Tax pages do not inject page-specific hero insights or Agenda widgets.
- Tax insight context is loaded from persisted canonical runs, run comparisons, readiness, payments, safe harbor, reserve, deadlines, confidence, source freshness, and canonical transaction tax classifications.
- Contractor CFO tax rules live in `src/services/insights/rules/taxInsightRules.js`; they do not call the Tax Orchestrator, legacy `monthly_metrics`, `tax_config`, or snapshot generators.
- Tax insights use stable dedupe keys and cooldowns. Cleared tax conditions are marked `resolved` and hidden by the global InsightsRail list path.

## Data Semantics

- `null` means unknown, unavailable, not configured, or not requested.
- `0` means a known zero.
- `[]` means a known empty collection.
- Missing sections mean the section was not requested or is not supported by that endpoint.

## Demo Mode

Demo tax data is allowed only through explicit demo mode or demo business/account state. Live API failures must render errors or partial/setup states and must not silently switch to demo data.

## Recalculation Events

Supported event sources include posted QBO transaction success, tax classification confirmation/override/exclusion/restore, profile changes, profile memory changes, tax payment changes, reserve account changes, sync completions, forecast changes, tax rule updates, manual requests, year rollover, and engine version changes.

Calculation-run writes, reserve snapshots, and generated insights are not recalculation triggers. This prevents recursive loops.

## Legacy Data Migration

Legacy `tax_snapshots` remain historical read-only artifacts. They are not used as current estimates, canonical trends, or authoritative calculation runs. Authenticated legacy history endpoints may expose them with a legacy/unverified label, while new exports should use immutable canonical run IDs.

Legacy `tax_payments` are normalized into canonical payment fields through idempotent migration records. Ambiguous rows are preserved as `other`/`needs_review`, shown in payment history, and excluded from applied payment totals until the type is confirmed. Migration tooling is dry-run by default and stores rollback metadata in `tax_legacy_migration_records`.

## Accuracy And QA

Tax quality checks live in `src/services/tax/quality/*`.

- `validateTaxRuleCoverage` validates verified/supported federal, state, deduction, entity, and filing-status scope. Unverified, legacy, conflicting, expired, or missing critical rules fail requested production scope.
- `runBusinessTaxQa` is read-only and evaluates staging/real businesses from canonical persisted data. It reports posted-source coverage, dollar-weighted classification exposure, classification integrity, bucket reconciliation, taxable-income reconciliation, tax-component reconciliation, payments, reserve, confidence, and material issues.
- QA reports preserve null semantics: unknown reserve/payment/safe-harbor values remain unknown and do not become zero.
- Contractor QA fixtures are deterministic scenario definitions, not proof of live correctness.

CLI commands:

- `npm run tax:validate-rules -- --year=2026 --states=NC,SC,FL --entities=sole_proprietor,s_corporation`
- `npm run tax:qa-business -- --business-id=<uuid> --year=2026`

## Active Frontend Modules

- Dashboard: `src/pages/Tax/TaxDashboard.jsx`
- Deductions: `src/pages/Tax/DeductionsPage.jsx` and `src/components/Tax/Deductions/*`
- Setup: `src/components/Tax/Setup/*`
- Planning: `src/components/Tax/Planning/*`
- Review: `src/components/Tax/Deductions/TaxTransactionReviewDrawer.jsx`
- Confidence/explanations: `src/components/Tax/Confidence/*`, `src/components/Tax/Warnings/*`, `src/components/Tax/Explanations/*`

## Unsupported Or Deferred Scope

The UI must surface backend `unsupportedItems` and `supportedButDeferred` instead of inventing amounts. Examples include QBI calculation, complex credits, local taxes, and multi-state allocations when the backend marks them deferred.

## Pack 3 State Semantics

The canonical State Tax Engine separates state tax into individual income-tax, entity/business-tax, total liability, and provisional reserve components.

- `verified_zero` individual income tax means a known `$0` broad individual earned-income-tax component.
- `partial` total state liability means at least one material state component remains unresolved; known zero plus unknown must not become `$0`.
- `provisionalReserve` is reserve guidance only. It is not tax liability, does not create safe harbor, and does not create payment deadlines.
- The nine 2026 no-broad-individual-earned-income-tax states are `AK`, `FL`, `NV`, `NH`, `SD`, `TN`, `TX`, `WA`, and `WY`.
- Entity caveats remain separate: examples include Texas franchise tax, Tennessee franchise/excise tax, Washington B&O tax, New Hampshire BPT/BET, and South Dakota contractor excise tax.

State rule precedence is exact verified row, entity exact with filing null, filing exact with entity null, state-general null/null, permitted lower support tier with confidence downgrade, then unavailable liability plus provisional reserve if configured.
