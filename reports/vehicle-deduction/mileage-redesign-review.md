# Standard Mileage card and monthly matrix review

1. Previous data flow and conflicting sources

The old full-width vehicle-treatment editor preceded an always-expanded Mileage Deduction form. The form required a Preview deduction click, displayed ISO rate dates and snapshot mechanics, and saved full dated mileage snapshots through previewVehicleMileage/saveVehicleMileage and replace_tax_vehicle_mileage_entries. The workspace already composed the annual headline as postedTransactionDeductionAmount + vehicleMileageDeductionAmount. It did not provide authoritative Gas context or a monthly mileage source to the matrix. Expense rows and mileage were separate sources; Gas spending cannot legitimately supply a monthly allocation for half-year mileage. The previous election-evidence fix is preserved: protected/manual history never establishes a vehicle election.

2. Authoritative population and calculation contracts

Gas context contract matrix-gas-context-v1 is built server-side from the exact lifecycle matrixEntries used by buildIdentityMatrix, after canonical posted-transaction membership and election evidence reconciliation. It selects the normalized Gas GL account, deduplicated by existing canonical membership. It does not filter out protected, reviewed or unresolved rows. Its total IDs are a subset of the same server-only matrix manifest; Gas context identity lists are removed from the public DTO. The gross expense cents use the matrix convention: negative signed bookkeeping amounts become positive expense, refunds retain their negative effect. There is no separate frontend population or query.

Rate-period context uses the same effectiveStart/effectiveEnd boundaries returned from the persisted active rate catalog used by mileage preview. Total Gas, covered-by-Standard-Mileage, other confirmed, pending confirmation, and current-vehicle covered counts are distinct. Coverage requires actual confirmed election evidence plus a resolved Standard Mileage treatment. Other vehicles, Actual Expenses, manual decisions and unresolved rows are not silently attributed to Primary vehicle. The card explains current-vehicle coverage separately from pending rows across the books. Detail-modal membership remains the projection category/month/authority manifest. Gas question membership remains its semantic question subset, not all Gas activity: in the historical fixture, 96 full-matrix Gas rows include the distinct 76-row question (70 actionable + six protected unresolved) and 20 legacy protected rows. No question, preview fingerprint, scope manifest or source identity protection was changed.

Only miles and persisted rate rows enter mileage arithmetic. Inputs accept nonnegative decimal miles with at most two decimal places, up to 1,000,000 annual miles and 366 dated entries; malformed, unsafe, excessive, negative and overlapping inputs fail. Integer mile/rate units round each entry to cents exactly like SQL numeric round(miles*rate,2). Annual amount sums those rounded entry amounts; miles sum integer hundredths. Monthly mode derives each half-year total from its month fields, so no duplicate submitted period total can disagree. Blank monthly fields explicitly mean zero, but at least one month must be supplied in each monthly group. Period-only mode submits one dated entry per rate period. Monthly mode submits calendar-month entries using the same existing snapshot RPC; no new tables or migrations are required.

A saved entry wholly within a calendar month is evidence for that month. Multi-month entries remain unallocated; there is no spending/date/count-based distribution. The public mileage workflow exposes monthlyAllocation {status, months, allocatedDeductionAmount, unallocatedDeductionAmount}. Complete monthly breakdowns reconcile exactly to the annual mileage deduction. Mixed period/month detail exposes partial allocation and the unallocated annual remainder. Each month is rounded separately; the UI explains sums of monthly deductions rather than suggesting an aggregated product rounds identically.

The matrix retains deductibleAmount as transaction-only treatment. Dedicated mileageDeductionAmount/mileageSource/mileageLabel fields show saved mileage beside expense treatment without changing transaction counts or identity manifests. Vehicle category YTD includes mileageAnnualDeductionAmount once, even when its monthly allocation is unavailable. The headline continues to add vehicleMileageDeductionAmount once. Validation reconciles allocated monthly mileage plus unallocated mileage to the annual mileage total, independently of expense deductions. Standard Mileage Gas stays at zero separate deduction. Actual Expenses workflows expose no mileage editor or mileage adjustment and retain their existing controlled method action.

Live preview is local and cannot change workspace/matrix/headline state. A debounced, bounded server preview binds every mileage input, support/finalization choice, rate identity, election ID and workspace identity; stale/aborted responses cannot enable Save. Save requires valid entries, record confirmation, matching server period/rate/amount calculation and current identity. The server recalculates before applying and compares the submitted expected preview to authoritative election/period/rate amounts; mismatches fail before writing. The existing atomic snapshot RPC preserves idempotent replay, history, finalization and method serialization. The hook refreshes the complete authoritative workspace after saving, and reports a saved-but-refresh-failed outcome honestly. Method edits still use the controlled preview/apply command with eligibility, immutable history and stale-state checks.

3. UX

Mileage cards use native details/summary, collapsed by default, with keyboard activation, visible focus, saved-state summary, localized miles/currency and a chevron supplied by the browser. Summary shows Mileage deduction · Standard mileage, vehicle, Mileage needed / Estimate saved / Finalized, and saved miles/amount when present. Expanded content contains the compact Change vehicle method action, Gas context, friendly January–June / July–December rate labels, immediate live calculations and optional monthly breakdown fields. Year-end options are separately collapsed, with a short explanation of locking and future review. Technical snapshot text, raw ISO rate labels and the Preview deduction button were removed. Actual Expenses retains a compact controlled method action without rendering a mileage card. Layout stacks on mobile.

4. Files and migrations

Added src/components/Tax/BusinessMileagePanel.jsx and src/services/tax/taxVehicleMileagePresentation.js. Updated TaxDashboard.jsx, VehicleTreatmentEditor.jsx, useTaxDeductions.js, taxApiClient.js, taxVehicleDeduction.service.js, taxWorkspaceProjection.service.js and vehicleMileageRates.js. Added taxMileagePresentation.test.js, taxMileagePanel.mounted.test.js and taxMileageSnapshots.postgres.test.js; extended taxVehicleDeductionWorkflow, taxGasPreviewDashboard.mounted and taxVehicleCommands.http tests. No migration files changed or applied. Projection formula advances to identity-contract-v2.7-monthly-mileage while preserving the existing projection ID/source-fingerprint behavior of read-only overlays.

5. Before/after regressions and validation

The three initial regressions failed before implementation (0/3): authoritative Gas context absent; monthly source absent; standalone-row/manual-preview UX still present. They pass after correction. New mounted coverage exercises collapsed saved summaries, native accessible disclosure/focus, controlled method action, live local preview without saving, records/server validation gating, monthly totals, stale response rejection across projection changes, Actual Expenses exclusion and matrix mileage adjustments with zero fake transactions. Existing Gas membership, protected-six, election-label, preview/recovery/cancellation and method amendment security regressions remain passing. Previously implemented snapshot/tenant/idempotency behavior was preserved and extended, not claimed as a newly failing defect.

Final focused run: 208/208 pass in 4.31 seconds, 45-second parent timeout. Subsequent final card/rate-identity changes: six targeted UI/presentation tests pass in 1.23 seconds with a 20-second limit. PostgreSQL suite: 5/5 pass in 11.66 seconds, 60-second limit, including the new monthly snapshot test, prior 76/70/six SQL fixtures and HTTP/RLS coverage. Extended real authenticated HTTP mileage preview/save/retry/stale/invalid/unauthorized test passes in 12.07 seconds with a 45-second limit. Changed-file ESLint, production build and git diff --check pass. Build retains existing dynamic-import/chunk-size warnings. No unbounded broad suite was run.

SQL validation uses the existing disposable local PostgreSQL 17 database loader with selected production-shaped domain DDL, RLS/grants, prerequisite migrations and repeat amendment migration application. HTTP runs the real Express middleware/routes with locally verified JWTs and actual SQL, not live production auth. No production requests or writes were needed for this task.

Logs: /tmp/bizzi-mileage-before.log, /tmp/bizzi-mileage-final-focused.log, /tmp/bizzi-mileage-last-ui.log, /tmp/bizzi-mileage-database.log, /tmp/bizzi-mileage-http.log, /tmp/bizzi-mileage-final-lint.log, /tmp/bizzi-mileage-final-build.log.

6. Exact reconciliation evidence

The existing sanitized read-only audit fixture, not a fresh production observation, contains:

| Gas population | Count | Gross expense |
|---|---:|---:|
| 2026 | 96 | $3,934.47 |
| January–June | 32 | $2,690.63 |
| July–December | 64 | $1,243.84 |

32 + 64 = 96; $2,690.63 + $1,243.84 = $3,934.47. Total Gas IDs equal the Gas subset of the matrix manifest. No protected or unresolved rows are omitted.

The primary monthly acceptance example is January 1,000 miles at $0.725 = $725 and July 12,000 miles at $0.760 = $9,120: 13,000 annual miles and $9,845. The matrix January/July adjustments, mileage workflow/card, authoritative preview and headline composition agree. The same miles supplied only as half-year totals produce the same annual amount but zero fabricated monthly allocations. A rounding fixture with 0.2 miles in each of January/February produces $0.15 + $0.15 = $0.30, exactly matching SQL per-entry rounding. The real SQL acceptance adds that February 0.2-mile entry to the main example, producing $9,845.15; retries return identical entry IDs and leave twelve stored mileage entries, seventy-six original bank transactions and every original classification byte-for-byte unchanged, including the protected six. Unauthorized, stale-election and stale-rate/amount requests do not add history or partially write.

7. Remaining limitations

Historical period-only snapshots lack monthly evidence and stay unallocated until the user supplies monthly mileage. Existing eligibility limitations, independent tax verification limits and protection of CPA decisions remain. The local HTTP harness is not a live identity-provider/production deployment test. There is no browser screenshot/visual regression claim; mounted DOM tests verify interactive controls and rendering, while native disclosure provides browser keyboard semantics. Existing unrelated repository failures were not rerun or fixed. No fresh production data audit was performed for this presentation task.

8. Deployment order

Under separate authorization: deploy the matching backend API/projection-worker modules first, then the frontend. No SQL migration is required for this change; use the already documented schema prerequisite order only if a target environment lacks the existing snapshot/amendment functions. Refresh/rebuild cached workspaces under v2.7-monthly-mileage and reload clients so Gas context, workflow, matrix and headline use one response generation. Preserve the immutable identity/source-fingerprint contract. Verify in staging that monthly save and retry publish one amount and that switching to Actual Expenses removes the mileage source atomically. Do not rewrite historic Gas or guess monthly mileage during rollout.

9. Verdict: READY for review and staging validation

Implementation and focused local validation are complete. No commit, push, deployment, production migration, production write or migration-file edit occurred. Existing unrelated work and the nested dirty worktree remain preserved.
