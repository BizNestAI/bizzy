# Tax Legacy Deprecation

## Prompt 29 Inventory

Active canonical runtime:

- `TaxDashboard` consumes `useTaxOverview`.
- `DeductionsPage` renders `DeductionsWorkspace`.
- Tax planning uses payment and reserve API client methods.
- Transaction review uses classification/review/override API methods.
- Confidence and explanation UI uses canonical run endpoints.
- Global alerts use `InsightsRail`; Tax pages do not inject page-specific rails.

Deprecated compatibility retained:

- `POST /api/tax/calculate-tax-liability` remains for legacy consumers and delegates to canonical calculation logic.
- `src/hooks/useTaxLiability.js` adapts canonical overview data for older Tax components.
- `src/hooks/useDeductionsMatrix.js` remains a compatibility facade over canonical deductions.
- `src/components/Tax/TaxMonthlySnapshot.jsx` is a non-fetching deprecated shell.
- `src/hooks/useTaxInsights.js` is a non-fetching deprecated shell; live Tax alerts belong in the global `InsightsRail`.

Retired runtime routes:

- `POST /api/tax/generate-monthly-tax-snapshot`
- `POST /api/tax/generate-tax-insights`
- `GET /api/tax/snapshots/export`
- `GET /api/tax/snapshots/share`

These routes now return `410` with canonical replacements. They no longer import or execute monthly_metrics/tax_config based calculation services.

Historical files retained but isolated:

- `src/services/tax/generateMonthlyTaxSnapshot.js`
- `src/services/tax/generateTaxInsights.js`
- `src/api/tax/generateMonthlyTaxSnapshot.js`
- `src/api/tax/generateTaxInsights.js`
- `src/api/tax/snapshotExport.js`
- `src/api/tax/snapshotShare.js`

They are not mounted by the Tax router. Remove after historical exports/migrations are fully replaced by canonical run exports.

## Removed Couplings

- Active Tax pages have no `AgendaWidget`, `RightExtrasContext`, or `getHeroInsight("tax")` coupling.
- Tax deadlines render from canonical Tax data and planning UI, not Calendar widgets.
- Live Tax failures do not return mock data.
- Active Tax frontend code does not manually scan `localStorage` for Supabase tokens.

## Event-Driven Recalculation

Prompt 30 added canonical recalculation events and `tax_recalculation_requests`.

Active event path:

- service mutation -> `emitTaxDataChanged`
- canonical event normalization -> `handleTaxRecalculationEvent`
- debounce/coalescing request row -> `processPendingTaxRecalculationRequests`
- `runCanonicalTaxCalculation`
- immutable run comparison
- `tax_calculation_materially_changed` for downstream insights when material

Page refresh and `GET /api/tax/overview` are not event sources. Legacy snapshot and monthly_metrics/tax_config services are not used by this path.

## Environment Safety

`src/services/tax/taxEnvironmentSafety.js` blocks production startup when implicit Tax mock or legacy monthly fallback flags are enabled. Setup gaps should produce canonical partial/setup states, not fake defaults.

## Legacy Removal Plan

1. Keep legacy liability compatibility until all consumers call canonical overview/calculation endpoints.
2. Replace any remaining historical snapshot export needs with run-based export/explanation endpoints.
3. Delete isolated monthly snapshot and old tax insight service files after migration verification.
4. Remove deprecated Tax frontend shells after all old imports are gone from downstream branches.

## Prompt 33 Legacy Migration Policy

Legacy snapshots:

- `tax_calculation_runs` remain authoritative for current and future Tax output.
- Existing `tax_snapshots` rows are preserved as historical artifacts and are not converted into authoritative completed canonical runs.
- The migration records legacy snapshots as read-only or `needs_review`; it does not recompute historical tax with current-year rules.
- Read-only history is available through authenticated legacy snapshot history routes. Exports are labeled legacy/unverified and are never mixed into current canonical trends.
- New snapshot generation/export/share routes remain retired with `410` canonical replacement responses.

Legacy payments:

- Known payment types are mapped to canonical payment types only when the legacy row provides a clear signal.
- Unknown or ambiguous payment types are preserved as `payment_type = other` with `status = needs_review`.
- `other` and `needs_review` payments appear in payment history but are not applied to canonical paid/withheld totals, safe-harbor coverage, or remaining-liability calculations until confirmed by a supported policy.
- Duplicate-looking payments are flagged by deterministic fingerprint. The migration does not delete either record.
- Extension payments, balance-due payments, credits, refunds applied, withholding, and estimated payments remain separate canonical buckets.

Migration commands:

- `npm run tax:audit-legacy` reports legacy snapshot/payment inventory without mutation.
- `npm run tax:migrate-legacy-snapshots` dry-runs snapshot migration records; pass `-- --apply` to write idempotent records.
- `npm run tax:migrate-legacy-payments` dry-runs payment normalization; pass `-- --apply` to update payment rows and write migration records.
- `npm run tax:rollback-legacy-payments` dry-runs rollback from migration metadata; pass `-- --apply` to restore prior payment fields where recorded.

All migration commands support `--businessId`, `--taxYear`, `--batchSize`, and `--migrationVersion`. Dry-run is the default.

Rollback:

- Original `tax_snapshots` rows are never deleted.
- Payment migration records store bounded before/after metadata so migrated payment fields can be restored where practical.
- Rollback marks migration records `rolled_back`; it does not hard-delete payments or snapshots.

Manual review buckets:

- Malformed snapshots, missing business/year/month, duplicate snapshot periods, and snapshots without identifiable totals.
- Payments with missing jurisdiction, missing state for state payments, missing tax year, nonpositive amounts, invalid quarters, duplicate fingerprints, or unknown legacy type/source.

## Pack 3 Legacy State Tables

`public.tax_state_rates` is retained temporarily for historical compatibility only. Canonical live calculation must not read it, must not use it as a generic flat-rate fallback, and must not let it override `state_tax_rule_configs`.

The legacy wrapper in `src/services/tax/stateTaxRules.js` returns unsupported when an explicit compatibility policy is not present. Tests assert that the canonical State Tax Engine and state rule repository do not import or query `tax_state_rates`.
