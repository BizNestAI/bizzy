# Election-backed Vehicle Expense label correction

This finding supersedes the earlier READY assessment for the missing election-validation invariant. The correction is locally validated; production remains unchanged.

Read-only audit: 2026-11-03T20:58:13.512Z; business cffc2183-e77c-4148-a206-d5192e090925; tax year 2026. Both vehicle and election SELECTs succeeded and returned zero rows. There is no persisted vehicle-method election to authorize these labels.

## Exact cause and cell trace

Historical selected-transaction confirmations stored vehicle_standard_mileage_no_separate_gas on 20 Gas rows without creating a vehicle or election. June contains 11 such rows; July contains nine. The six historically protected unresolved rows are separate: three in May and three in June. All 26 retain user_override=true, cpa_override=false and are protected from bulk automation. Protection is not evidence of an election.

The latest persisted projection is 80f07a04-d951-40be-9c84-b2545109a709, generated 2026-11-03T16:31:53.673Z with identity-contract-v2.4-vehicle-deductions. Its vehicleDeductions.vehicles is empty. Its cells contain no reviewedTreatmentLabel or standardMileageTransactionCount, so the exact covered-by-mileage text is not stored in that projection. The persisted May/June/July reviewed counts are 3/14/9: the earlier lifecycle treated six historic protection flags as review. A live overlay fixes those six but still accepted the remaining 20 user-confirmed treatment strings. The label helper and fallback matrix isStandardMileageGasRow inferred mileage coverage from treatment text without resolving an election. Current source also allowed the server aggregate to persist that inferred label. The screenshot’s June/July labels and pending gross amounts match that live-state path. There is no election backfill to justify them. No migration-created vehicle/election exists in the audited business; historical source is user, not a migration.

Trace: transaction_tax_classifications.tax_treatment/status/metadata → listDeductionTransactions/toTransactionRow and mapDeductionTransactionRow → buildTaxDeductionsLifecycleProjection → buildIdentityMatrix/aggregateMonth → buildPersistedWorkspaceMatrix/PersistedMatrixCell (or fallback isStandardMileageGasRow) → cell and annual summary. Detail labels use vehicleTreatmentProvenanceLabel. Both the lifecycle and label previously omitted the persisted-election join.

| Month | Gas rows | Historical mileage rows | Protected unresolved six | Corrected pending gross | Corrected reviewed count |
|---|---:|---:|---:|---:|---:|
| 2026-05 | 6 | 0 | 3 | $2,287.42 | 0 |
| 2026-06 | 26 | 11 | 3 | $403.21 | 0 |
| 2026-07 | 29 | 9 | 0 | $484.11 | 0 |
| 2026-08 | 14 | 0 | 0 | $279.51 | 0 |
| 2026-09 | 13 | 0 | 0 | $308.03 | 0 |
| 2026-10 | 8 | 0 | 0 | $172.19 | 0 |

## Affected row evidence

Common fields for every row below: tax year 2026; vehicle ID null; persisted method election ID null; persisted election method null; user_override=true; cpa_override=false; protected=true by existing authority logic. No separate persisted protected column was inferred. All have zero separate deductible amount. Actor H is cf497e57-baac-4c0a-b6f4-f145c18a9b72, the historical human override actor. R is automated recovery_scan run be98b36f-91e1-4d99-aa0f-04869ce063f2 with no recorded human actor; the stale override_actor on those six is not the recovery actor. Dates/times are UTC.

| Transaction ID | Transaction date | Treatment / status | Current source | Last row update | Last treatment actor | Historical human override timestamp |
|---|---|---|---|---|---|---|
| 21d5b965-0701-410d-bac4-0b2064235117 | 2026-05-22 | vehicle_expense / needs_review | rule_engine | 2026-11-02T02:01:32.333701+00:00 | R | 2026-09-10T18:01:02.010965+00:00 |
| 72fb0233-f82a-4506-bcc0-e21f98c59fff | 2026-05-24 | vehicle_expense / needs_review | rule_engine | 2026-11-02T02:01:31.617755+00:00 | R | 2026-09-10T18:01:02.010965+00:00 |
| ac898a63-f822-4335-9b5b-2a39a39ccd20 | 2026-05-28 | vehicle_expense / needs_review | rule_engine | 2026-11-02T02:01:30.832108+00:00 | R | 2026-09-10T18:01:02.010965+00:00 |
| 6e6f319a-beac-482e-9914-3c2939369f2b | 2026-06-02 | standard_mileage_no_separate_gas / user_confirmed | user | 2026-09-10T18:05:11.643788+00:00 | H | 2026-09-10T18:05:11.643788+00:00 |
| 12cbf7ae-579e-41d9-b18d-d6a288897341 | 2026-06-04 | standard_mileage_no_separate_gas / user_confirmed | user | 2026-09-10T18:05:11.643788+00:00 | H | 2026-09-10T18:05:11.643788+00:00 |
| a83a8cd1-278f-4072-bdb7-08a395a15a9f | 2026-06-08 | standard_mileage_no_separate_gas / user_confirmed | user | 2026-09-10T18:05:11.643788+00:00 | H | 2026-09-10T18:05:11.643788+00:00 |
| 94e332f2-8821-4d55-8b02-08c19aebd6ec | 2026-06-09 | vehicle_expense / needs_review | rule_engine | 2026-11-02T02:01:29.987602+00:00 | R | 2026-09-10T18:01:28.956131+00:00 |
| c28e99d8-e584-4b80-8be3-c6bfc5da872c | 2026-06-09 | standard_mileage_no_separate_gas / user_confirmed | user | 2026-09-10T18:05:11.643788+00:00 | H | 2026-09-10T18:05:11.643788+00:00 |
| 6c5b65f0-d82e-4731-bedd-5c5df5c1fcd6 | 2026-06-10 | standard_mileage_no_separate_gas / user_confirmed | user | 2026-09-10T18:05:11.643788+00:00 | H | 2026-09-10T18:05:11.643788+00:00 |
| 8c920c84-804a-4002-9c4b-b92e19a79559 | 2026-06-12 | standard_mileage_no_separate_gas / user_confirmed | user | 2026-09-10T18:05:11.643788+00:00 | H | 2026-09-10T18:05:11.643788+00:00 |
| 04f17007-e33c-458e-ba52-351691801604 | 2026-06-15 | vehicle_expense / needs_review | rule_engine | 2026-11-02T02:01:29.248786+00:00 | R | 2026-09-10T18:01:28.956131+00:00 |
| a8767901-fb1d-4126-860d-6a5a41e80632 | 2026-06-18 | standard_mileage_no_separate_gas / user_confirmed | user | 2026-09-10T18:05:11.643788+00:00 | H | 2026-09-10T18:05:11.643788+00:00 |
| 045cccfd-31e1-4f27-993c-d3f528758130 | 2026-06-21 | standard_mileage_no_separate_gas / user_confirmed | user | 2026-09-10T18:05:11.643788+00:00 | H | 2026-09-10T18:05:11.643788+00:00 |
| a8951e75-33ea-441e-84f8-cdc1cca17a60 | 2026-06-21 | standard_mileage_no_separate_gas / user_confirmed | user | 2026-09-10T18:05:11.643788+00:00 | H | 2026-09-10T18:05:11.643788+00:00 |
| 6ce25de9-1700-4b38-8fb2-a1a514ecb0d9 | 2026-06-23 | vehicle_expense / needs_review | rule_engine | 2026-11-02T02:01:28.516007+00:00 | R | 2026-09-10T18:01:28.956131+00:00 |
| 0145bdd8-76c5-4ab1-8660-2d00817f2c59 | 2026-06-25 | standard_mileage_no_separate_gas / user_confirmed | user | 2026-09-10T18:05:11.643788+00:00 | H | 2026-09-10T18:05:11.643788+00:00 |
| d05a535a-bd47-44a3-a0c1-09d21e3b3cd6 | 2026-06-28 | standard_mileage_no_separate_gas / user_confirmed | user | 2026-09-10T18:05:11.643788+00:00 | H | 2026-09-10T18:05:11.643788+00:00 |
| 8e158d56-0adf-4521-ab52-17757030da22 | 2026-07-01 | standard_mileage_no_separate_gas / user_confirmed | user | 2026-09-10T18:04:12.589133+00:00 | H | 2026-09-10T18:04:12.589133+00:00 |
| 602e5fe2-8f8e-4519-9cee-5796aa72069b | 2026-07-02 | standard_mileage_no_separate_gas / user_confirmed | user | 2026-09-10T18:04:12.589133+00:00 | H | 2026-09-10T18:04:12.589133+00:00 |
| 58e9eedb-7132-4b25-8213-0329689fab0d | 2026-07-06 | standard_mileage_no_separate_gas / user_confirmed | user | 2026-09-10T18:04:12.589133+00:00 | H | 2026-09-10T18:04:12.589133+00:00 |
| 5c28fcc2-4ee8-4164-9d27-bbe660c7fd67 | 2026-07-12 | standard_mileage_no_separate_gas / user_confirmed | user | 2026-09-10T18:04:12.589133+00:00 | H | 2026-09-10T18:04:12.589133+00:00 |
| bc8035c5-c01c-40f8-8a8d-deb837d934c8 | 2026-07-13 | standard_mileage_no_separate_gas / user_confirmed | user | 2026-09-10T18:04:12.589133+00:00 | H | 2026-09-10T18:04:12.589133+00:00 |
| 0256d748-b907-459d-b80c-252fa0e2a381 | 2026-07-17 | standard_mileage_no_separate_gas / user_confirmed | user | 2026-09-10T18:04:12.589133+00:00 | H | 2026-09-10T18:04:12.589133+00:00 |
| 43af7b82-85d0-4c77-be2c-60c650b359dd | 2026-07-24 | standard_mileage_no_separate_gas / user_confirmed | user | 2026-09-10T18:04:12.589133+00:00 | H | 2026-09-10T18:04:12.589133+00:00 |
| 3ab732ad-5c34-4c91-91c8-3989f1808dec | 2026-07-29 | standard_mileage_no_separate_gas / user_confirmed | user | 2026-09-10T18:04:12.589133+00:00 | H | 2026-09-10T18:04:12.589133+00:00 |
| b354c3a2-0b73-44db-9056-7205bad0f125 | 2026-07-30 | standard_mileage_no_separate_gas / user_confirmed | user | 2026-09-10T18:04:12.589133+00:00 | H | 2026-09-10T18:04:12.589133+00:00 |

## Correction

Server reads now attach persisted election evidence from active vehicle/election records. Review and labels require matching business, tax year, vehicle, effective transaction date, active/finalized status, non-superseded election, elected actor/time, and the matching method. Treatment text and manual/protected flags cannot satisfy this check. Ambiguous duplicate elections fail closed. Client-supplied evidence is replaced by server table reads. This evidence survives the transaction mapper and posted-row join. Missing live vehicle classification scope cannot inherit reviewed state through the sparse projection fallback.

Both live and persisted matrix paths use this rule. New server summaries carry confirmed mileage-member evidence. Old vehicle summaries without the new evidence contract become pending in the renderer. The projection formula advances to identity-contract-v2.6-election-evidence. No classifications, override flags, history, or elections were rewritten. Manual exclusions remain explicit decisions; CPA protection remains intact even when missing method evidence makes the displayed treatment pending.

## Tests and deployment implications

The first two new regressions failed before the source correction (0/2), then passed. They replay all 26 historical protected rows, explicitly including the six, and assert zero reviewed counts/deductions and no mileage cell label. Additional tests validate exact scope, actor/time, effective dates, draft/superseded/mismatched elections, server replacement of untrusted evidence, live read-only overlay counts, unchanged historical records and failure of unverifiable sparse fallback. Mounted renderer tests prove old cached summaries cannot show the label and a genuinely confirmed election can. Positive fixtures were updated to include election evidence rather than retaining the invalid treatment-only assumption.

Validation: bounded focused run 200/200 (3.53 seconds; 45-second limit), followed by election-evidence 4/4 including the added live-overlay/sparse case. Focused PostgreSQL/authenticated HTTP tests 3/3 (8.62 seconds; 60-second limit), changed-file lint and production build passed. Existing Vite chunk warnings remain. Logs: /tmp/bizzi-election-before.log, /tmp/bizzi-election-final.log, /tmp/bizzi-election-evidence.log, /tmp/bizzi-election-database.log, /tmp/bizzi-election-lint.log, /tmp/bizzi-election-build.log. No unbounded broad suite was run.

No new SQL migration is required by this correction. A separately authorized rollout must deploy the matching server projection/detail/worker code and renderer, then refresh/invalidate older projections and client caches under the new formula contract. GET overlay recalculates from live election tables and preserves persisted identity/fingerprint; it does not repair production data. Do not manufacture a Primary vehicle/election or backfill historical flags into one. A future election must be explicitly confirmed through the existing controlled workflow. Previously prepared workflow migrations remain subject to their documented prerequisite order; none was applied in this task.

No commit, push, deploy, migration or production write was performed. Existing changes and the dirty nested worktree remain preserved.
