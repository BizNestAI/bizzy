# Launch Operating Forecast

## Contract and scope

`operating_accounts_launch_v1` uses the latest twelve completed calendar months in
`business_financial_reporting_config.reporting_timezone`. Reporting configuration
must be verified (USD for this launch). It never writes or certifies accounting
period closes. A current authoritative Cash snapshot (current/validated status)
with the exact business, realm and period is required for every month. Staged,
non-current snapshots are not forecast authority. Missing reports block generation;
absence of an account inside a verified report contributes an observed zero.

Signed account totals must exactly reconcile in cents to Ordinary Income, COGS,
Expenses and net income including the separately reconciled Other sections.
Other Income/Expense never enter operating projections. Missing/duplicate stable
QBO account IDs or inconsistent financial-content fingerprints block generation.
Legacy snapshots without stored financial-content metadata get a recomputed
fingerprint; close fingerprints and raw hashes are never substituted for it.

Account identity is `(QBO account ID, P&L section)`, not account name. All accounts
have twelve observed values. Months before the first account observation in a verified report are excluded
from averaging denominators; explicit zero account rows establish earlier history. `limited_history` makes this assumption explicit.
`creation_verified: false` records that this is not evidence of the account's actual creation date.

Rules apply in order:

1. Inactive: last three observed months equal zero; project zero.
2. Recurring: at least five active last-six months, latest active, and **every**
   active last-six value within 10% of their signed median (median rounded half away from zero to cents before comparison; tolerance uses its absolute magnitude). Project the median of
   the latest three active values. Active means nonzero; credits remain signed.
3. Variable: at least three active last-six months; blend 50% last-three average,
   30% last-six average, 20% last-twelve average, shortening each denominator only
   for months before its first report observation. Observed zeros after first activity remain included.
4. Intermittent: average observations from its first report observation onward, including zeros.

Money is converted from decimal text to safe integer cents. Weighted averages
round once, half away from zero; intermediate averages are not rounded. Unsafe
integer operations fail rather than silently approximate. Forecasts are flat for
all twelve persisted months after the historical window. Existing expense fields
store **COGS plus operating expenses**. Other Income/Other Expense are reconciled
independently when summary components are present, retained in `excluded_sections`,
and identified as deliberately excluded. Missing/invalid timezone falls back to a
blocked result, never to the server/browser timezone.

## Existing storage and metadata

No new tables or columns. `forecast_runs.data_quality` has schema
`operating_accounts_v1`, `accounts[]` (stable ID, section, classification, observed
months, recent values, complete calculation series, projected cents, limited-history
flag), monthly COGS/operating-expense split, limitations, generation reason,
timezone and source guards. `model_config` records thresholds/weights. A future
change to these rules must change configuration and/or model version.

The input fingerprint hashes business, Cash basis, chronological historical
window, exact snapshot IDs and recomputed financial-content fingerprints, model
version and model configuration. The content fingerprint also covers provider
identity, currency, totals and signed accounts. Equivalent input reuses a completed
version. A separate versioned `financial_input_hash` omits snapshot UUIDs so an
equivalent provider refresh also reuses the existing version, retaining its original
exact-source lineage. Only financial-content or required-window changes produce
a replacement, bounded by the daily routine cap.

Graph, table and cards use the same cent-normalized rows. The UI renders only
persisted month identities; it never rolls labels over old values. Missing inputs
return previous coverage with explicit blocking periods and reasons.

## Integrity migration

`20261104120000_operating_forecast_launch.sql` introduces three service-only RPCs:

- `claim_operating_forecast`: business advisory lock, lease expiry, identical-input
  reuse, cross-fingerprint serialization, routine daily cap.
- `complete_operating_forecast`: same lock, source row locks and amount/account
  guards, existing transactional twelve-month finalizer, latest predecessor
  override carry-forward and replacement linkage.
- `edit_operating_forecast_overrides`: same lock, atomic sparse patches/reset,
  canonical latest-run targeting and coverage validation.

The only existing restrictions relaxed are nonnegative forecast/override checks
(which cannot represent signed credits), and the legacy completed-run index
predicate (the launch fingerprint includes content/configuration that the old
index omitted). Legacy uniqueness remains; the existing active-input unique index
protects launch fingerprints. There is no historical data rewrite.

Completion reads the latest predecessor overrides **under the same database lock
as edits**, rather than trusting an earlier application revision. An edit before
completion is copied; an edit after completion is forwarded to the latest run for
matching calendar months. A stale edit outside current coverage fails atomically.
Sparse patches preserve untouched fields; null resets one metric. Original row
creator, creation timestamp and reason survive carry-forward. Existing ambiguous
all-cell overrides are conservatively retained. The schema supports row-level,
not independent per-metric author history; append-only audit is post-launch.

The current version is the most recently completed launch/legacy run. Completion
is serialized, so no separate active-pointer schema is needed for launch.

## Daily and manual lifecycle

The existing forecast timer now awaits refresh of all twelve completed source
reports before evaluating the model. It does not depend on the separate Health
cron's start time. Source work has explicit concurrency one per forecast worker,
250 ms pacing between reports, three attempts per report for 429/5xx responses,
and 30-second report-request timeouts. Retry-After is honored; delays over one
minute defer the evaluation rather than retrying early. A 0–30 second startup
jitter and a process-local non-overlap guard avoid synchronized/reentrant runs.
Run exactly one enabled forecast worker; other replicas disable background work.
Partial failures log the refreshed, failed and remaining months and never invoke
generation. No unchanged-history cache replaces the twelve provider report reads. A provider refresh failure aborts evaluation. Source identity is
rechecked before completion, and SQL rechecks eligibility and guards under locks.
A concurrent source promotion causes safe failure/retry on the next evaluation.

Daily generation is capped at one routine completed version per business/day in
its reporting timezone; a newly required horizon bypasses the same-horizon cap.
Manual, historical-backfill and completed-month approval calls bypass the routine
cap, but still reuse identical fingerprints. Manual Refresh evaluates currently
persisted QuickBooks inputs; it does not force another provider sync. The daily
job refreshes them. There is no durable queue; a process restart may delay work
until the next scheduled run. Logs expose generated/unchanged/missing_history/
stale_source/failed, rather than claiming every ensure call refreshed a forecast.

## Launch validation and deployment

Do not run this migration remotely as part of development. The local database
test creates and drops its own database in an explicitly selected local container:

```
OPERATING_FORECAST_LOCAL_DB=1 node --test tests/operatingForecastDatabase.test.js
```

The default test run skips this database test. It exercises actual migrations/RPCs,
claim serialization, source-change rejection, sparse saves, atomic failures, signed
credits, edit/completion concurrency, late edits, reset, idempotency and grants.
Its dependency schema is minimal; it is not staging schema-parity validation.

Release order:

1. Establish staging schema parity, including V1 tables, source account identity,
   financial reporting configuration, existing finalizer and new RPC migration.
2. Validate source completeness and fingerprints without modifying close approval.
3. Run authenticated staging GET/generate/save/reset and Admin View denial tests.
4. Exercise daily source refresh with real staging QBO credentials and measure the
   twelve-report cost/latency; verify provider limits and worker uptime.
5. Review signed account explanations and production-shaped replay. Confirm
   preservation across rollover, source corrections and concurrent edits.
6. Apply the reviewed migration before deploying launch service/UI writers.
7. Enable a canary, observe truthful refresh outcomes, then expand.

Rollback order: stop launch writers/timer first, roll back application routing/UI,
and preserve forecast versions/assumptions. Drop the three new RPCs only after no
launch callers remain. Do not restore nonnegative checks over signed rows or
restore the old unscoped unique index over launch versions: that can fail or demand
data loss. A full DDL reversal requires a separately reviewed archival/preflight
operation. Application rollback does not require deleting financial evidence.

## Explicitly post-launch

Vendor decomposition, cross-company ML, industry models, seasonality, AR/AP timing,
true cash flow, current-month ATD, annual/quarterly commitment inference, account
editing/storage tables, append-only assumption audit, durable event queues and
extensive vintage backtesting are deferred. AI does not supply authoritative numbers.
Legacy tax/chat consumers still read legacy forecast tables and are deliberately
not migrated. Accuracy reads launch system baselines (not post-hoc edits), selects the latest eligible pre-month vintage in the business timezone, and compares matching cent-accurate operating
results; it is not a full backtesting platform.

## Final pre-staging hardening review

### Staging prerequisite order

This is the forecast prerequisite subsequence, not permission to skip unrelated
migrations in the staging ledger. Base schema must already provide `business_profiles`,
`bank_transactions`, `user_business_link`, `quickbooks_tokens`, `qbo_backfill_jobs`,
`financial_metrics`, `account_breakdown`, `expense_totals_monthly`, `gpt_messages`
(including `business_id`), Supabase auth roles/functions and `pgcrypto`. Their full
original CREATE schema is not present in this migration history; restore/verify
that base from the authoritative schema before applying feature migrations.

Apply missing migrations in ledger order, verifying each dependency first:

1. `20260602_financial_monthly_review_stamps.sql`
2. `20260603_monthly_review_console.sql`
3. `20260604_monthly_review_phase_3_4.sql`
4. `20260910_monthly_review_qbo_pnl_snapshots.sql`
5. `20260911_monthly_review_qbo_pnl_atomic_promotion.sql`
6. `20260913_monthly_review_qbo_pnl_validated_status.sql`
7. `20260915_qbo_health_backfill_job_progress.sql` (tracked source import)
8. `20260919_forecast_v1_authority.sql`
9. `20260920_accounting_period_close_authority.sql`
10. `20261101113000_business_evidence_package_authority.sql` (reporting config and basis-aware promotion)
11. `20261101114000_monthly_review_close_function_volatility_repair.sql`
12. `20261101115000_monthly_review_close_and_report_fingerprint_repair.sql`
13. `20261101116000_reporting_configuration_qbo_preferences_source.sql`
14. `20261101117000_automatic_financial_reporting_initialization.sql`
15. `20261104120000_operating_forecast_launch.sql`

The launch migration is transactional, rerunnable, does not rewrite existing
forecast rows, and adds a scoped one-generating-claim index. A parity check must
confirm `forecast_runs_active_input_unique`, composite tenant FKs, and the old
transactional finalizer, not merely table existence. Local tests apply launch
migration twice to both clean and representative populated V1 schemas; checksums
prove preservation of the existing rows. These tests use the real snapshot-table
migration but stub unrelated base app/auth configuration; they do not replace a
full staging migration rehearsal.

#### Read-only staging evidence (November 4, 2026)

Zero-row GET requests are used, not SDK HEAD calls: empty HEAD error responses
were misleading. The configured staging project is distinct from primary.
`PGRST205` means unavailable in the exposed schema/cache; it does not prove the
physical catalog lacks the object. The following require parity repair/verification:

- `forecast_runs`, `forecast_months`, `forecast_overrides`
- `monthly_review_qbo_pnl_snapshots`, `monthly_review_qbo_pnl_accounts`, `monthly_review_qbo_pnl_transactions`
- `accounting_period_closes`
- `business_financial_reporting_config`, `business_financial_reporting_config_audit`

The other seven probed prerequisites are accessible via zero-row GET:
`financial_monthly_review_stamps`, `monthly_review_runs`, `monthly_review_audit_events`,
`qbo_backfill_jobs`, `financial_metrics`, `account_breakdown`, `expense_totals_monthly`.
The staging OpenAPI document does not expose any of the three launch RPCs,
`finalize_forecast_v1_run`, `promote_monthly_review_qbo_pnl_snapshot`, or
`initialize_business_financial_reporting_config`. Verify their creation/grants and
schema-cache exposure in the ordered migration rehearsal; no remote migration or generation was executed.
Do not infer RPC absence from an unavailable OpenAPI document. Use authorized
read-only PostgreSQL catalog inspection to establish signatures, volatility,
`search_path`, owners and execution ACLs. Then verify PostgREST schema reload and
backend-only execution. Customers must have no direct execution grant on launch
RPCs or direct access to forecast/source tables.

### Environment and authentication

Configure backend `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (or its existing
service-key alias) for staging, and frontend Supabase URL/anon key and API base
for the same environment. Never put a service key in VITE variables.

QuickBooks requires `QB_ENVIRONMENT` and its matching `QB_SANDBOX_CLIENT_ID`,
`QB_SANDBOX_CLIENT_SECRET`, `QB_SANDBOX_REDIRECT_URI`, or `QB_PROD_*` equivalents.
The existing guard rejects sandbox with `NODE_ENV=production`: use a supported
staging combination and an isolated authorized QBO realm; do not bypass the guard.
The QBO connection must be active in the same environment, with verified USD
reporting configuration, confirmed canonical timezone and twelve reconciled full
Cash reports. Seed recurring rent/software, COGS, signed credits, Other sections,
a genuine no-activity month, and a separately incomplete history test business.

Only one replica enables forecast workers. `DISABLE_BACKGROUND_WORKERS` and
`DISABLE_FORECAST_CRON` must be false/unset there and true as appropriate elsewhere.
`FORECAST_CRON_HOUR/MINUTE` are server-local scheduling settings; business month
selection and daily caps use the verified business timezone. Independently manage
`DISABLE_QBO_FINANCIAL_HEALTH_CRON` and `QBO_FINANCIAL_HEALTH_CRON_HOUR/MINUTE`.
Keep all authentication bypass flags disabled. Tests need real signed customer
sessions, business membership, paid-compute entitlement and an authorized read-only
Admin View session. No impersonated user ID substitutes for bearer authentication.

### Provider load

Normal forecast work is 12 P&L calls per business/day: **360 for 30 businesses,
600 for 50**. Bounded retry upper bounds are 36/business, **1,080 / 1,800** if every
report succeeds on its third attempt. A permanent error stops the remaining
reports. The separate default Health cron adds two P&Ls/business: normal combined
report counts are **420 / 700**. Token refresh and non-report requests are additional.
Multiple enabled worker replicas multiply these counts; jitter is not a distributed
provider lock. One designated worker is a launch operational prerequisite.

### Legacy consumer isolation

The following remain unchanged and continue reading legacy tables:

- Tax: `tax/projection/taxForecastSource.service.js` (both tables), `tax/reserve/taxReserveEngine.js` and its existing ` 2.js` duplicate (`cashflow_forecast`).
- Tax event source metadata: `tax/events/adapters/forecastTaxEventAdapter.js`.
- Chat: `api/gpt/orchestration/chatContextService.js`; intents `forecast_generate`, `affordability_check`, `fin_overview` (`cashflow_forecast`).
- Other legacy readers: `services/insights/contractorCfoEngine.js` (both tables), `api/accounting/scenario.js`, `api/accounting/affordabilityCheck.js`, and admin `buildForecastEvidence` (`cashflow_forecast`).
- Legacy writer: `api/accounting/generateCashFlowForecast.js` (`cashflow_forecast`).

Only the forecast API, daily forecast cron, backfill completion and post-close
forecast callback invoke the new service. The old V1 module remains unchanged;
the new service imports only its error type. The only other `forecast_months`
reader is forecast accuracy, now explicitly filtered to the launch model and
combined operating-cost semantics. No launch CSV/export path exists. No Tax/chat
consumer has been migrated. Source checks compare unchanged files and the legacy
admin evidence function against HEAD.

### Authenticated staging test sequence

1. Review migration ledger/catalog and restore base/feature schema parity; never
   apply the launch migration alone over a missing V1/source schema.
2. Verify anonymous/direct customer RPC denial and authenticated API tenant isolation.
3. Verify missing/invalid timezone/history returns understandable blocked metadata.
4. Import/reconcile twelve full Cash months; confirm current partial month exclusion.
5. Generate twice: one completed version, identical canonical amounts and lineage.
6. Save one metric, reset it, then regenerate changed sources; confirm sparse
   assumptions, creator/timestamps, calendar identity and untouched baselines.
7. Exercise simultaneous refresh/edit, nonexpired/expired leases, provider 429,
   partial refresh and source correction during completion. Check no partial run
   becomes available and log outcomes distinguish failure/staleness from reuse.
8. Advance a test clock across business-local month rollover. Verify real persisted
   coverage, no relabeling, missing-month warning and fresh horizon after source import.
9. Inspect desktop/mobile/input accessibility and chart/table/card arithmetic with
   cents, signed credits and combined COGS. Component tests stub chart DOM; this
   browser step remains required.
10. Verify accuracy uses matching operating definitions, signed values, safe zero
    percentages and the latest eligible system baseline vintage; legacy consumers
    retain their existing data sources.

Rollback: stop forecast/background writers, revert application routing/UI, retain
all runs/overrides and relaxed signed-value support. Drop launch RPCs and its
one-generating-claim index only after callers stop. Do not blindly restore the old
unique index/nonnegative checks over launch/signed data. Any full DDL reversal
requires separately reviewed preflight/archive handling; never delete assumptions
to make rollback constraints pass.

### Validation evidence

Before hardening: 115 focused tests passed. Final hardening adds actual React
interaction tests (transport/demo/chart DOM mocked), source-failure and retry
checks, signed/zero recurrence boundaries, stable-account series checks, operating
accuracy vintage/timezone checks, and end-to-end service generation checks. The
production-shaped baseline remains revenue $2,025.74, combined operating costs
$4,505.64, operating net -$2,479.90. These are fixture replay results, not a remote
forecast generation. Four Monthly Review phase-1 failures were independently
reproduced with every inspected source loaded from unchanged HEAD; unrelated
source/tests were not repaired.

### Final implementation file inventory

- `docs/operating-forecast-launch.md`
- `package-lock.json`
- `package.json`
- `src/api/accounting/forecast.js`
- `src/api/accounting/forecastAccuracy.js`
- `src/api/admin/monthlyReview.routes.js`
- `src/components/Accounting/ForecastEditorChart.jsx`
- `src/components/Accounting/ForecastVsActualChart.jsx`
- `src/jobs/forecast.cron.js`
- `src/pages/accounting/Forecasts.jsx`
- `src/services/accounting/operatingForecastAccuracy.js`
- `src/services/accounting/operatingForecastModel.js`
- `src/services/accounting/operatingForecastRefresh.js`
- `src/services/accounting/operatingForecastService.js`
- `src/services/bookkeeping/qboMonthlyPnlIngestionService.js`
- `src/services/qboBackfillRunner.js`
- `src/utils/forecast/money.js`
- `src/utils/forecast/operatingForecastDisplay.js`
- `supabase/migrations/20261104120000_operating_forecast_launch.sql`
- `tests/fixtures/operatingForecast.js`
- `tests/forecastV1Service.test.js`
- `tests/operatingForecastComponent.test.js`
- `tests/operatingForecastDatabase.test.js`
- `tests/operatingForecastLaunch.test.js`
- `tests/operatingForecastRefresh.test.js`
- `tests/operatingForecastService.test.js`

Final local results: **131 focused tests passed**, including six real React editor
interaction tests; **two database scenarios passed**, each applying the launch
migration twice and verifying preservation of existing data. Changed-file lint,
production build and whitespace checks passed. Temporary databases were removed.
No migration, forecast generation or write was performed remotely. Staging access
was restricted to zero-row GETs and OpenAPI metadata.

Implementation verdict: **READY FOR STAGING migration rehearsal**. Authenticated
staging application tests and production readiness remain gated on the verified
missing/unexposed schema and RPC prerequisites above.
