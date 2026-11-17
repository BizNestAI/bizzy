# Handled auto-post admission — local completion, November 16, 2026

The narrower implementation is ready for another read-only deployment review. This is not deployment approval. Six pre-existing broader-suite failures remain classified below. No production access, provider calls, live workers, live workflows, production migrations, historical cleanup, commits, pushes or deployments occurred.

## Current behavior and database footprint

The existing additive migration is supabase/migrations/20261111220000_auto_post_handled_admission.sql. It creates exactly five functions, zero columns, zero tables and zero triggers. It adds no advisory locks or broad writer serialization.

| Function | Purpose | Application access |
| --- | --- | --- |
| auto_post_technical_block | Current technical checks for admission and worker execution | Private helper |
| auto_post_admission_meta | Four recent admission entries, saturating counters and a 4,096-byte namespace budget in existing transaction metadata | Private helper |
| admit_handled_auto_post | Explicit bounded enable, scoped new-decision/settlement admission, preview and approved repair | service_role only |
| approve_bookkeeping_with_admission | Canonical approval adapter preserving existing schedules and preventing failed approvals from inventing schedules | service_role only |
| check_auto_post_technical_integrity | Current execution identity, lease, payload and technical checks, including both payment-pair legs | service_role only |

The migration does not invoke admission, update business policies, backfill transactions or start work. It preserves the existing approval RPC and installed posting-job/lifecycle machinery. The disposable suite applied it without any earlier admission implementation, verified no added triggers or admission column, and demonstrated that old-style categorization writes under an existing On policy remain unscheduled. Applying the migration alone is inert for scheduling and existing application write behavior. It also installs grants and sends a PostgREST schema-cache reload notification.

The versioned backend explicitly invokes admission. The v2 Off → On operation locks its business policy row, evaluates at most 2,000 rows and conditionally updates rows in one transaction. Ordinary categorization/job write locks still exist; predicate writers are not fenced. An over-limit request returns a terminal result without changing policy or schedules. Policy/effective-date changes and evaluated admission writes commit together or roll back together.

Only approved, auto_approved and literal legacy handled are admission-authority statuses. Eligible handled rows receive the worker-compatible approved alias with prior status recorded. Existing non-null deadlines are preserved. New eligible schedules use the database-generated enable/new-decision anchor plus the configured grace period, normally 24 hours. Repair uses an explicit fresh approved anchor. Admission makes no provider calls.

Failed rows are excluded from automatic business-wide enable admission and cannot be scheduled through explicit admission, preview, repair or failed canonical approval. An explicitly selected failed row reports failed_requires_existing_retry_workflow. Neither decided_at, metadata, a previous-status claim nor lifecycle events authorize it. Needs Review remains unauthorized.

Existing posting-job retry/recovery is separate from admission. A failed row already entering that lifecycle may execute only with the existing posting lock and a valid current provider/pair claim; admission never creates its retry schedule. An unresolved prior attempted write blocks execution. A conclusively rejected older attempt can be recognized as closed only through durable no-write receipt evidence bound to that exact prior claim, owner and request, plus its subsequent failed-attempt record; that old attempt is never accepted as the current execution attempt. An older rejection cannot clear a newer ambiguous attempt. Unknown outcomes clear stale no-write summaries. Legacy unbound attempted evidence remains blocked for existing recovery rather than receiving invented authorization.

Canonical final categorization and unresolved-to-authorized application persistence enroll new ordinary decisions. The approval adapter preserves schedules under the approval operation's existing row locks. Settlement registration takes explicit identities observed in the canonical Plaid merge, retains replay provenance and creates bounded pending markers before the sync checkpoint. Specialized workflows remain separate. Deployment alone does not enumerate or modify the historical cohort.

## Corrections to the completion-audit blockers

1. Removed lifecycle-based failed authorization from the admission gate and removed failed from its business-wide candidate/update sets. Explicit failed previews return a specific reason. Adversarial database cases cover bare failed rows, decided_at, forged metadata, directly service-role-inserted lifecycle evidence and previous approved/handled claims. Failed canonical approvals cannot supply a new deadline. Positive auto-approved/Handled admission still passes.

2. Added shared current-attempt evidence built after the durable claim. It carries owner, request, exact claimed_at and categorization generation. Its timestamp cannot precede the claim; PostgreSQL sub-millisecond precision is preserved when the claim timestamp wins. The worker no longer reuses its pre-claim timestamp for attempted evidence. Conclusive rejection records bind the same claim/owner/request evidence and rejection time, preventing a stale receipt flag from laundering a later ambiguous attempt.

3. Both ordinary and paired worker boundaries carry business/transaction/environment identity, current generation, cancellation state, posting-lock start/key and execution owner/request. The database requires current durable matches, an active categorization lock and an exact unexpired provider/pair claim. Payment-pair dispatch acquires both existing narrow categorization locks and validates both legs. Changed generation, cancellation, expired/replaced lock, foreign request/owner, replaced claim, different business/transaction/realm/environment and ambiguous attempts fail closed before a stub mutator can run.

4. Provider-mutator guards remain at the actual create boundary, including nested SDK methods and callback clients. A guard rejection is marked as a known pre-provider failure, so the Purchase/Deposit/Transfer adapters do not manufacture an ambiguous provider outcome from a local validation failure.

5. Added the read-only business-authorized scope-preview GET endpoint. The client exposes it and sends the retained admission_preview hash/time in the single versioned PATCH. The enable confirmation can optionally select a starting date, displays preview eligibility/blocker counts and requires that preview before confirmation. Changed/expired manifests leave the persisted policy truthful, clear the UI's stale preview and request a fresh preview. Failure/retry responses retain current policy fields. The v2 confirmation count excludes failed and includes literal handled; it does not use the legacy backlog query.

6. Added narrowly bounded retries for known-aborted 40001/40P01 canonical approval transactions, complementing admission's existing retries. No transport retry, universal writer retry or broad serialization was introduced.

7. Repaired local database testing without opening provider access. Both database suites use internal Docker networks. A local loopback tunnel through docker exec replaces Docker Desktop port publishing, so PostgREST remains reachable even when internal-network ports are not published. PostgreSQL and PostgREST use already-cached images with --pull=never.

8. Replaced the old implementation report with this report and compared against a separate clean detached HEAD worktree, leaving the user's dirty nested worktree untouched.

## Execution boundary and explicit scope

The automatic-posting worker paths covered by the guard are ordinary bank-outflow purchases, bank-inflow deposits, credit-card charges, credit-card credits/refunds/statement credits, unpaired credit-card-payment writes, paired-payment transfers, loan-payment purchases and split purchases. Manual/retry entry points reaching these worker paths retain the same final gate. Vendor creation through the worker's wrapped client is also guarded.

Current checks cover ownership and lease identity; posted/matched/excluded/archive state; pending bank activity; active cached source/final mapping and connection identity; deterministic duplicate evidence; unresolved provider outcomes; recovery holds; finalized/locked accounting periods; posting payload fields; current policy; intents, attempts and receipts. The new generation/cancellation/lock checks run again immediately before a guarded mutation.

Already-posted reclassification uses a separate contract and client. It was not expanded into this remediation and is not claimed to use this new-worker execution gate.

Database validation and an external provider call cannot be one atomic transaction. A state change after the final database check but before provider acceptance remains a distributed-systems limitation. Existing provider request idempotency and receipt reconciliation remain necessary. Scheduling uses cached connection/account information; it performs no live provider authentication or duplicate attestation.

## Admin repair, controls and polling

Admin preview and repair are explicitly allowlisted through Admin View and still require active authorized internal staff. Preview is read-only and does not require the write capability or paid mutation. Repair requires the write capability and the existing paid entitlement. The route/database tests exercise real middleware and staff/entitlement lookups with authenticated session fixtures; production session-token resolution itself remains covered separately by existing tenant/auth tests.

Both operations enforce business isolation and reject mixed/foreign IDs. Input is capped at 200 IDs. Repair requires approved:true, an explicit fresh repair anchor, the exact preview hash/time and unchanged row evidence. The manifest is actor-bound and expires after five minutes. Identical approved retries preserve the deadline. Expired historical activity receives a fresh full grace period. Repair schedules only: no posting wakeup or providers.

DISABLE_BACKGROUND_WORKERS=true wins over overrides. Nonproduction defaults off through the canonical startup decision. The Books-specific disable flag is also respected. A disabled worker is not started or reported as awakened. Wakeup is optional; periodic processing remains the fallback.

Ordinary due posting runs before admission fallback. Fallback is capped at 100 marked rows, two businesses and approximately three seconds per sweep. It scans new enrolled metadata, not unmarked legacy backlog. Browser admission refresh has six attempts with 2.5, 5, 10, 20, 30 and 30 second delays, pauses when hidden and stops for complete/terminal/Off/disabled-worker states. No fixed five-second admission polling was added.

## Validation completed

All commands ran locally. Broad/focused tests used an OS sandbox denying network access. Database tests allowed only Docker Unix sockets and loopback test HTTP; the database containers had no external route. The Plaid client was supplied as a synthetic stub. The financial-write boundary was a stub, not a QBO SDK connection. No live workers were started.

| Validation | Result |
| --- | --- |
| New focused suite | 25/25 pass |
| Complete admission PostgreSQL suite | 18/18 subtests pass; 19/19 including TAP parent |
| Complete existing Plaid/PostgREST suite | 29/29 subtests pass; 30/30 including TAP parent |
| Relevant worker/posting/UI/client/auth selection, clean HEAD | 331 pass, 6 fail, 337 total |
| Same selection, current tree | 331 pass, 6 fail, 337 total |
| JavaScript syntax | 25 changed .js files pass |
| Targeted lint / JSX parsing | All 26 changed JS/JSX files: zero errors/warnings |
| SQL | Parsed/installed and executed on disposable PostgreSQL 17 |
| Production build | Pass, 8,580 modules; build.write=false and filesystem writes denied |
| git diff --check | Pass |

The admission suite covers migration-only inertness; canonical deadline preservation; the positive Handled cohort; failed adversarial cases; mixed blockers; concurrent enables; transaction rollback; exact repair manifests; effective-date atomicity; 100 Off/On cycles; bounded evidence; explicit settlement admission; current intent/pair leases; post-preflight cancellation/generation changes; claim → attempted evidence → final gate → stub mutation → success; foreign/stale/replaced identities; ordinary writers remaining unfenced; the 2,000-row cap; service grants; actual local scope/client and Admin preview/repair routes; truthful retry state; canonical pending-to-posted merge and deadline-preserving replay.

The existing Plaid suite separately validates pending-to-posted identity, persistence/checkpoint isolation, recovery scopes, large cohorts and provider/receipt protections. Its extracted schema builder is unchanged from HEAD apart from its function name/location. Existing assertions were retained. The schedule-display policy change now asserts the exact resulting not_scheduled key/label instead of only asserting absence of the old confidence blocker.

The production build retains three informational static/dynamic import warnings for RevenueChart, NetProfitChart and ExpenseBreakdownChart. No build output was written into the repository.

## Exact HEAD comparison and remaining failures

Baseline: 6a3626561c3cb2037505aaee12dbc712dde7ee74 in /private/tmp/bizzi-admission-head-20261116. The worktree remains clean. Both runs used identical synthetic Supabase/QBO/Plaid credentials, NODE_ENV=test and disabled background workers. No production credentials were needed.

The same 29 existing test files ran on both trees. Full normalized assertion/error blocks, file inventories and totals are retained in:

- /private/tmp/bizzi-admission-head-broader.json
- /private/tmp/bizzi-admission-current-broader.json
- /private/tmp/bizzi-admission-comparison-summary.json
- /private/tmp/bizzi-admission-compare.mjs

Normalization removes worktree roots, timing values and diagnostic stack line numbers. It does not erase assertion values or changed source dumps. Two complete normalized failure blocks are identical. Four source-assertion blocks differ because they dump the whole changed source file; their actual failing regex/diagnostic and operator are identical. This comparison does not rely on equal failure counts alone. There is no current-only failure in this selection.

| Exact remaining failure name | HEAD and current finding |
| --- | --- |
| Auto-post UI keeps customer scope lightweight and operator backlog review separate | Both fail the missing scope_copy?.headline source assertion. Later future-only copy assertions are also obsolete for the explicitly approved existing-Handled policy. The source assertion was not weakened. |
| same-lineage pending-to-posted replacement preserves the internal id | Both expect a literal null fallback that HEAD already does not use. Current code preserves pending_source_transaction_id on replay. The source assertion was retained; both real database suites verify identity preservation. |
| parent cannot report success without a durable child operation result | Identical normalized block: actual pre_provider_posting_failure, expected qbo_posting_failed. Existing semantic mismatch; not introduced or changed here. |
| approval route validates and resolves rows before QBO-capable command processing | Identical normalized block: schemaIndex > 0 && schemaIndex < resolveIndex is false. Its bounded source-window ordering assertion already fails on HEAD; it was not weakened or reordered for this task. |
| Monthly Review QBO labels distinguish Handled from Posted and scheduled queue state | Both reject post_error appearing near hasQboTxn in the existing duplicate-check branch. The offending branch is unchanged; source dumps differ elsewhere. |
| Books Review feed renders backend QBO schedule fields without deriving post_after in React | Both match Date.now() + 250 in the pre-existing account-click suppression timer, not a posting deadline calculation. Assertion retained. |

The other five audit failures were the durable merchant approval worker tests: accepted-operation resume, immutable selected IDs, targeted operation claim, decision_saved resume, and active/expired lease handling. All five pass on both trees with identical synthetic configuration. Their original missing-Supabase-environment errors also matched exactly when both trees were run without those variables.

These six pre-existing failures remain visible for deployment review. No blanket green-suite claim is made, and no deployment approval is inferred. No existing source assertion was relaxed merely to make this selection pass. No existing test was removed.

## Safe rollout and rollback

Do not deploy as part of this task.

Recommended reviewed rollout:

1. Apply only the additive admission migration. Old backend behavior remains unchanged and no cohort is enrolled.
2. Pause/drain posting workers before backend cutover. Drain old API instances as well; do not rely on mixed old/new writers or workers to protect newly admitted rows.
3. Deploy all backend/worker instances with the new entry points and execution gate available. Verify canonical disable controls before enabling workers. Deployment itself does not invoke backlog admission.
4. Deploy the frontend only after the backend is ready. Legacy frontend calls retain their legacy contract; v2 scope preview/confirmation requires the new backend.
5. Resume normal periodic processing under the reviewed worker configuration. Separately authorize any historical repair using a fresh exact preview/anchor. Do not toggle Off/On to substitute for approved repair.

Rollback:

1. Pause/drain posting first.
2. Roll frontend and backend back together. Leave the unused additive functions installed; old backend does not call them.
3. Reconcile the explicitly admitted cohort and durable schedules/intents/receipts before resuming older workers. Application rollback does not undo schedules already committed.
4. Reverse schedules only through a separately approved, business-scoped exact manifest where still appropriate. Do not delete provider receipts or infer that a provider write can be undone locally. Do not drop functions while new callers remain.

Known residual risks are the six pre-existing test failures above, the normal final-check/provider race, cached rather than live provider facts, and ordinary PostgreSQL contention. New admission and canonical approval RPCs retry known-aborted serialization/deadlock transactions at most three times; other failures remain explicit. No universal deadlock-free guarantee is claimed. Larger-than-2,000 cohorts require separately reviewed bounded operations rather than automatic historical enrollment. A further read-only deployment review is appropriate before any rollout approval.

## Persisted modified/untracked inventory

18 modified regular files:

- src/api/_shared/adminBookkeepingAudit.js
- src/api/_shared/entitlementAuth.js
- src/api/_shared/tenantAuth.js
- src/api/bookkeeping/routes/bookkeeping.posting.routes.js
- src/jobs/backgroundWorkerStartup.js
- src/jobs/booksPost.cron.js
- src/pages/accounting/BookkeepingCleanup.jsx
- src/services/adminBookkeepingAccess.js
- src/services/bookkeeping/autoPostControl.js
- src/services/bookkeeping/bookkeepingClient.js
- src/services/bookkeeping/bookkeepingLifecycleState.js
- src/services/bookkeeping/bookkeepingTransactionFeedService.js
- src/services/bookkeeping/finalCategorizationPersistenceService.js
- src/services/bookkeeping/qboPostingLifecycle.js
- src/services/plaid/plaidSyncService.js
- tests/integration/plaidPersistence.database.test.js
- tests/monthlyReviewReclassificationService.test.js
- tests/qboPostingScheduleDisplay.test.js

10 untracked files:

- reports/auto-post-handled-admission-2026-11-11.md
- src/services/bookkeeping/autoPostAdmission.js
- src/services/bookkeeping/postingExecutionIntegrity.js
- src/utils/autoPostAdmissionView.js
- supabase/migrations/20261111220000_auto_post_handled_admission.sql
- tests/autoPostAdmission.test.js
- tests/helpers/autoPostAdmissionRoutes.js
- tests/helpers/localPostgrest.js
- tests/helpers/plaidDatabaseSchema.js
- tests/integration/autoPostAdmission.database.test.js

The unrelated dirty gitlink .claude/worktrees/elated-black-b3db40 is preserved at f9137e2ff871ffd0bd55af3200cc9a7c1b7a548c. Its three modified files remain src/api/accounting/bookkeeping.routes.js, src/api/gpt/brain/generateBizzyResponse.js and src/components/Bizzy/ChatCanvas.jsx. There are no staged changes or tracked deletions. Ignored local configuration, dependencies and prior build artifacts were not cleaned or changed by this implementation.
