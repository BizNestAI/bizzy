# Tax question discoverability audit and correction

Verdict: **READY for review of the local implementation.** Production is unchanged. Release requires the prepared additive migration, compatible server/browser code, and a refreshed authoritative workspace projection. No production migration, deployment, commit, push, or data write was performed. Existing uncommitted Settings changes and the nested worktree were preserved.

## Exact production-shaped flow and causes

The read-only audit captured 715 classification rows, the latest complete persisted workspace, and the bank/bookkeeping rows for the affected 55 IDs. The full data flow was established before implementation edits. The sanitized aggregate evidence is in [composition.json](composition.json); raw transaction and vendor descriptions are excluded from the repository.

`GET /api/tax/workspace?projectionVersion=tax-workspace-v2` loads the latest complete `tax_workspace_projections` row scoped to the authorized business and tax year. `reconcileTaxWorkspaceProjection` reads `listTaxWorkspaceClassificationSnapshot`, overlays current `transaction_tax_classifications` on that persisted identity population, maps each classification through `mapDeductionTransactionRow`, then runs `buildTaxDeductionsLifecycleProjection` and `buildPayload`/`buildIdentityMatrix`. Matrix `aggregateMonth` counts unresolved or review-required rows in Needs Input and sums the same members’ gross expense amounts. The browser renders that matrix and its exact category/month identity sets.

The same lifecycle projection constructs `activeDecisionGroups`; `buildPayload` publishes its actionable groups and count, and the Questions tab renders `ProjectedQuestionGroups`. These are computed groups, **not a separate table of previously answered questions**. Preview records are created only when opening a question; they authorize a later save, rather than discover which questions exist.

**Rent omission:** `taxDecisionTypeForRow` explicitly returned null for rent category/rule/account evidence. Rent was also excluded from standard-rule estimates. The five review-required Rent rows therefore contributed $8,922.93 to pending matrix cells but could not enter a supported customer decision group.

**Unresolved omission:** the mapper represented persisted `tax_category=unclassified` / `classification_status=needs_review` as an Unresolved/unclassified display row. Lifecycle classification treated that as bookkeeping evidence; the fixed supported decision list included vehicle, utilities, and meals/travel business-purpose decisions, with no generic category question. All 50 were omitted even though `requires_review=true`.

The audited persisted projection had zero question groups. Missing question IDs, protected flags, historical answers, and a different counter query did not explain these 55 omissions. The omissions are reproducible from the current rows and the old grouping rules, independent of stale cache state. The matrix was not deriving question membership from a separate record table.

**False Supplies detail:** `detailReviewContextForSelection` independently fell back to `category_confirmation`; `detailResolutionHeading` and the save label hardcoded Supplies. Its select could inject the current `Unresolved` value, and manual override/rule paths lacked a final-category guard. A temporary category could thus be promoted to confirmed state. The separate Supplies row is unrelated; it is not evidence that these 50 expenses were Supplies.

## Composition of all 50 Unresolved expenses

All 50 total **$5,619.50**. Every row has current tax class `unclassified`, source `rule_engine`, confidence **20 / low**, status `needs_review`, and `requires_review=true`. All have `user_override=false` and `cpa_override=false`; no protected manual provenance or prior actionable question group/semantic type explains their omission. None has a persisted tax-category suggestion. The reason is “No reliable tax deduction rule matched this posted transaction.” `no_matching_tax_rule` in the aggregate is an audit reason label, not an invented persisted rule code.

**They are not all Supplies.** The four May expenses are posted to **Entertainment**, total **$113.07**, and have no persisted Supplies suggestion. The Supplies-suggestion regression deliberately uses synthetic explicit tax suggestions; it does not relabel these actual May rows. Bookkeeping suggestions are not promoted to tax suggestions.

### By month

| Group | Count | Gross |
|---|---:|---:|
| 2026-05 | 4 | $113.07 |
| 2026-06 | 16 | $2,360.81 |
| 2026-07 | 8 | $948.65 |
| 2026-08 | 5 | $634.80 |
| 2026-09 | 11 | $752.08 |
| 2026-10 | 6 | $810.09 |

### By posted QuickBooks account

| Group | Count | Gross |
|---|---:|---:|
| Auto:Gas | 1 | $12.44 |
| Barber | 1 | $49.37 |
| Business Licensing Fees | 1 | $202.00 |
| CC Fees | 1 | $40.00 |
| CC Interest | 3 | $70.34 |
| Charitable Contributions | 4 | $111.25 |
| Clothing | 7 | $1,399.33 |
| Entertainment | 25 | $1,016.33 |
| Gifts | 1 | $18.39 |
| Uncategorized Expense | 6 | $2,700.05 |

### By current final bookkeeping category

| Group | Count | Gross |
|---|---:|---:|
| Auto:Gas | 1 | $12.44 |
| Barber | 1 | $49.37 |
| Business Licensing Fees | 1 | $202.00 |
| CC Fees | 1 | $40.00 |
| CC Interest | 3 | $70.34 |
| Charitable Contributions | 4 | $111.25 |
| Clothing | 7 | $1,399.33 |
| Entertainment | 25 | $1,016.33 |
| Gifts | 1 | $18.39 |
| No final categorization; QBO posted account retained | 5 | $2,587.75 |
| Uncategorized Expense | 1 | $112.30 |

### By pseudonymous vendor

| Group | Count | Gross |
|---|---:|---:|
| vendor-164d2280c6 | 1 | $20.00 |
| vendor-1f2a94881e | 1 | $29.00 |
| vendor-297c6f0f5d | 2 | $271.88 |
| vendor-2d67c3bed1 | 2 | $657.44 |
| vendor-40f6a7f94e | 1 | $6.00 |
| vendor-44b4b37456 | 2 | $40.00 |
| vendor-496ad96fc6 | 1 | $112.30 |
| vendor-4e610cb673 | 1 | $49.37 |
| vendor-524d93677f | 1 | $26.62 |
| vendor-56e63222a2 | 1 | $19.49 |
| vendor-5d37b8d033 | 2 | $43.72 |
| vendor-6229d16742 | 1 | $47.63 |
| vendor-63241d4de9 | 4 | $148.07 |
| vendor-635550ae59 | 2 | $49.76 |
| vendor-669cb41ea1 | 1 | $412.92 |
| vendor-725b557644 | 1 | $105.58 |
| vendor-7757816a30 | 4 | $2,070.20 |
| vendor-8ac7f427ea | 1 | $100.97 |
| vendor-8d2f4abcba | 1 | $12.44 |
| vendor-8e084b0b5b | 1 | $40.00 |
| vendor-9a17173768 | 1 | $202.00 |
| vendor-9aed23da1e | 1 | $40.00 |
| vendor-a1593ecc5a | 1 | $39.66 |
| vendor-b451c8d3bb | 1 | $517.55 |
| vendor-b919f9cdbf | 2 | $20.00 |
| vendor-d38b5cbb7c | 1 | $160.88 |
| vendor-d8be65912c | 1 | $18.39 |
| vendor-dccf94b4ab | 1 | $72.00 |
| vendor-e147ddf44b | 1 | $30.90 |
| vendor-e9a791c18e | 4 | $27.57 |
| vendor-ea6f1bcf66 | 1 | $55.77 |
| vendor-eaa7d5ed94 | 1 | $45.47 |
| vendor-f4c0daf3cb | 1 | $72.00 |
| vendor-f53d3ba2fd | 1 | $51.25 |
| vendor-fbf7063ca1 | 1 | $2.67 |

Vendor identifiers are deterministic hashes for grouping only. The JSON evidence also includes all requested tax-class, suggestion, source, confidence, reason/status, input-required, provenance and question-group dimensions, each reconciling to 50 / $5,619.50. Five rows have no final bookkeeping categorization ($2,587.75); their posted QuickBooks account remains known. This does not invent a tax classification.

## Correction and authoritative reconciliation contract

- Add `rent_treatment` and generic `category_confirmation` decisions. Preserve all existing vehicle, business-use and mileage answer paths.
- Include persisted review-required Unresolved classifications in the question lifecycle. Group by business/year, current category, GL account, reliable explicit tax suggestion and compatible reason. Reliable tax suggestions use the documented metadata contract `tax_category_suggestion: {taxCategory, confidence}` with a supported category and confidence >=80%; absent suggestions produce “Choose a tax category.”
- Render count, gross expense amount, current GL account, and why input is needed. Suggested classifications remain Unresolved until an explicit complete answer is saved.
- Rent asks what was rented and whether the payment covers this tax year. Only confirmed current-year business-premises/equipment rental can use the simple expense answer. Vehicle, home-office, prepaid, asset or uncertain treatment remains pending and links to All transactions.
- Remove the independent generic matrix-detail save; link it to the authoritative classification questions. Do not infer Supplies from a fallback component.
- Reject temporary final categories in manual confirmation/batch overrides, future-rule construction, and an additive SQL trigger. They remain legal as pending workflow state.
- New service-only category RPCs validate the preview actor/business/year, exact current membership, amount/account/treatment/customer facts/authority, source eligibility and latest projection identity; lock, record immutable override history and update every selected row in one database transaction. No GL-wide future rule is created from heterogeneous Unresolved expenses.
- Keep the existing route’s post-command authoritative workspace materialization and the hook’s reconciliation gate. Matrix and Questions are published from one resulting payload. Classification commit and subsequent projection materialization are not a single database transaction: the existing route/recovery protocol handles a refresh failure without claiming the decision failed or blindly replaying it.

The invariant is: **matrix Needs Input IDs = disjoint actionable question IDs union IDs explicitly linked to another resolution workflow**. Group count equals rendered groups and identity-evidence group count. Question memberships cannot overlap or include reviewed/outside-matrix IDs. Protected, technical, professional-review or capped-out populations remain visible through the linked All transactions workflow, rather than disappearing when grouped questions are empty.

For the affected 55-row fixture, the corrected payload contains **11 actionable groups: 10 generic GL groups for the 50 Unresolved rows, plus one Rent group for five rows**. Exactly 55 unique pending IDs reconcile, with no unexplained remainder. This is a scoped replay of the audited population, not a claim that production has already been rebuilt.

## Files changed

- `src/api/tax/taxClassificationReview.routes.js`
- `src/hooks/tax/useTaxDeductions.js`
- `src/pages/Tax/TaxDashboard.jsx`
- `src/services/tax/taxApiClient.js`
- `src/services/tax/taxClassificationOverride.service.js`
- `src/services/tax/taxDeductionDecisionRule.service.js`
- `src/services/tax/taxDeductionsLifecycleProjection.js`
- `src/services/tax/taxGroupedDecisionPreview.service.js`
- `src/services/tax/taxGroupedDeductionDecision.service.js`
- `src/services/tax/taxQuestionSemanticIdentity.js`
- `src/services/tax/taxWorkspaceProjection.service.js`
- `tests/taxDeductionsLifecycleProjection.test.js`
- `tests/taxGroupedDecisionPreviewContract.test.js`
- `tests/taxVehicleSemanticQuestion.test.js`
- `src/services/tax/taxCategoryResolution.js`
- `supabase/migrations/20261105120000_tax_category_resolution.sql`
- `tests/fixtures/categoryResolutionRows.json`
- `tests/taxCategoryResolution.test.js`
- `tests/taxCategoryResolution.mounted.test.js`
- `tests/taxCategoryResolution.postgres.test.js`
- `reports/tax-question-discoverability/composition.json`
- `reports/tax-question-discoverability/validation.json`

## Before/after validation

The initial three new tests were run before code edits and all failed: Rent question discovery, four reliable Supplies suggestions grouped separately, and rejection of final Unresolved. They pass after the correction. The expanded category suite has seven passing tests, including absent/mixed suggestions, differing reasons, exact counter/membership reconciliation, alternate workflow counts and rent uncertainty.

The focused run: **240/243 pass**, with exactly three baseline failures. All three are existing `taxWorkspacePostAnswerReconciliation` assertions expecting one database read while the deployed vehicle workflow performs five. A read-only HEAD archive, isolated under `/tmp`, reproduces the same three failures (11/14 pass). No working-tree implementation was reverted. The new category contract subset passed 43/43. Six mounted UI tests pass, covering category/rent confirmation plus existing Gas preview/cancellation/recovery, dashboard identity, mileage entry and vehicle treatment controls. Tests have explicit 20–45 second deadlines; no broad unbounded suite was launched.

The isolated PostgreSQL test passes: additive migration installation twice, full preview-to-save flow, immutable history, no inferred future rule, rejection of stale amounts/projections, owner/cross-business/partial/protected changes, no writes on failed attempts, exact result recovery, conflicting retry rejection, reviewed Supplies matrix + removed question, final temporary-category rejection and browser-role denial. Only disposable local test databases were mutated and cleaned up.

Changed implementation/new-test ESLint and the production build pass; the build reports its existing large-chunk advisory. `git diff --check` passes. See [validation.json](validation.json) for the test summary.

## Remaining limitations and release implications

No production mutation was performed. The prepared `20261105120000_tax_category_resolution.sql` is additive and has no data backfill. Release the migration before enabling the new server save path, release compatible UI/server code together, then refresh/materialize the workspace so its published semantic group IDs and memberships authorize previews. The preserved projection-identity contract intentionally rejects an old projection lacking the newly available groups; it must recover through the existing bounded rebuild flow.

Tax suggestions are shown only when explicit supported tax-suggestion evidence exists. These audited rows have none. Specialized vehicle/home-office/prepaid/asset questions require the linked dedicated/professional review path; uncertain users are never forced into a simple deduction. The three baseline read-count tests remain unchanged and failing. No deployed-browser verification or production save was attempted.
