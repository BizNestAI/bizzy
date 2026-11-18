# Stale Pending: confirmation, manual release and deployment

## Admin action availability on both surfaces

Monthly Review and Books opened through authenticated Open Bookkeeping Access use the shared `StalePendingAction` control. The action loads current server eligibility, displays `Move to Needs Review` only for eligible stale rows, and requires statement attestation/date/amount. Recent rows retain Pending with an “Available after seven days” explanation. Replacement candidates never offer manual promotion; Monthly Review can open the existing replacement review.

The missing controls had two local causes: Monthly Review required both application/database business allowlists, while Books never received an action callback and always rendered passive Pending. No current deployment or production flags were inspected for this change, so a current deployment mismatch has not been verified or excluded.

Books uses `/api/bookkeeping/transactions/:transactionId/pending-resolution` and its `confirm-settled` child route. Its server boundary requires a verified opaque Bookkeeping Access session and an active internal `owner_admin`, rechecked through the same internal-staff authorization as Monthly Review. The actor comes from that verified staff row, not the customer being viewed. Ordinary customer tokens, including business owners/admins, receive 403; customer roles, banners, request actors and local storage cannot authorize a resolution. Successful confirmation refreshes Monthly Review counts and both feeds; Books clears scoped feed caches and reloads its current rows/counts so Needs Review cannot retain a stale cached page.

The availability-only `20261118220000_stale_pending_global_admin_availability.sql` must follow the existing lifecycle migration. It replaces only the feature predicate and grants the server the existing read-only accounting eligibility check. It retains the existing global switch values, lifecycle, guards, audit/idempotency operations and containment. This file was prepared locally and not applied. Old allowlist tables are retained for compatibility but no longer gate new actions after this migration. Every existing/future business is covered when the global gates are enabled; no business backfill or provisioning hook is needed.

Validation of this UI/authorization change: 6 new behavioral/security tests and 136 focused/regression tests passed. The new tests exercise real loopback HTTP authorization with a synthetic database and the rendered shared React action, including confirmation attestation, internal actor preservation, three unrelated/new business scopes, replacement/recent/conflict holds, replay month preservation and feed/cache refresh. Build, targeted new backend/test lint and diff checks passed. Existing modified UI files have unchanged HEAD lint counts; repository-wide lint remains 1,678 errors/190 warnings. Two additional legacy Admin View source assertions fail against unchanged `ForecastEditorChart.jsx` on HEAD (`admin_view_optional` and `readOnly || !hasEdits`). No production access, Keychain access, SQL migration execution, live resolution or provider invocation was used for this change.

This is an unapplied, local implementation. No production repair, provider call or rollout is part of this change.

## Release lifecycle

Only an active internal `owner_admin` may confirm a source authorization against a bank/card statement or link an operator-verified settled counterpart. Confirmation requires a seven-day UTC age, explicit attestation, statement date and amount, business/physical-account/Plaid-environment/QBO-realm verification, and absence of removed, archived, duplicate, replacement, accounting, matching or posting evidence.

Confirmation keeps the provider's stored `pending` flag and raw payload. It records version 2 statement evidence and sets `statement_review_override`. The source enters Needs Review with suggestions preserved, final GL fields cleared, no schedule, and no automatic approval. It cannot post at this stage.

The normal manual categorization service routes confirmed rows through `release_statement_pending_review`. The active `owner_admin`, business owner or authorized owner/admin member supplies a category; the database verifies the GL account against the same active QBO realm/environment and rechecks all conflict evidence under the account fence. Release is audited in both the resolution events and existing approval events. It sets `statement_review_released`, `approved`/Handled, final GL authority and no immediate schedule. The existing auto-post policy and grace period then decide scheduling. Ordinary manual posting remains available through the existing preview/intent/execution workflow.

A workflow projection exposes provider_pending separately from workflow pending. Stored provider truth is never flipped to authorize posting. Approval, scheduling, intent claiming, attempts and every final financial mutator have server-side checks; a caller-supplied UI/meta flag does not grant authority.

A deliberate Undo clears category authority, revokes release, and advances the review epoch so the next manual decision has a distinct persistent key. Already-posted decisions cannot be reopened by this path.

## Later provider evidence

Same-identity settlement reuses the canonical UUID and retains release when compatible. Original authorization truth remains in durable statement evidence; any subsequent pending flag change comes from an actual provider observation.

A separate unique verified settled counterpart is archived as a source alias with a business-scoped canonical UUID. It has no independent approval, intent or posting path. The canonical source can be released after review or retain its existing release/schedule/receipt. Explicit lineage or exact compatible amount/direction/merchant identity and bounded dates is required; account/date alone is insufficient. Multiple candidates or independently accounted counterparts remain held without erasing their decisions or receipts. Repeated unlinked settlements are not all guessed to be one transaction.

Material changes create `statement_review_conflict`. No automatic release or retry exists for a genuine conflict; it needs separate reconciliation. A conflicting observation before the provider boundary prevents the write. Once an external request has crossed that boundary, it cannot be recalled: its durable intent and receipt must be completed/reconciled, and the alias cannot create a second request. Database guards deliberately permit recording an already-observed outcome, including during containment.

## Lock order, bounds and retries

The account key includes business, Plaid environment and physical-account UUID (provider account fallback for ordinary legacy rows). New resolution/release/ingestion RPCs acquire sorted account fences before shared row locks. The migration adapts existing approval, scheduler and posting-claim/lock entry points to the same order, retaining their signatures, owners and grants. Legacy direct row writes use a nonblocking advisory fence; contention aborts the entire statement with SQLSTATE 40001 instead of waiting in an inverse lock order.

Relevant RPCs have two-second lock and fifteen-second statement timeout settings; migration DDL uses two-second/sixty-second bounds. Confirm the installed PostgREST/function timeout configuration in the authorized rollout preflight. NOWAIT account acquisition itself never waits. Bounded adapters retry only returned, known-aborted SQL errors (40001/40P01/55P03/57014), up to three attempts. Transport failures may have committed and are surfaced for replay using the same persisted key.

No transaction spans external HTTP I/O. The existing durable posting lease/idempotency identity is the fence across that boundary; final current-state checks run before each financial mutator.

## Default-off feature gates

New actions require BOTH:

- Backend `STALE_PENDING_RESOLUTION_ENABLED=true` (defaults off).
- Database `statement_pending_feature.enabled=true` with no containment.

Only privileged administrative/migration principals can write the database gate. The service role cannot self-enable it. Client retirement remains an operational rollout requirement; the database does not discover deployment versions. There is no per-business enablement requirement. Disabling either new-action gate prevents fresh confirmations/releases. Completed actor/payload-bound resolution/release retries remain replayable. Existing resolved rows retain their protections, and already-released rows may continue normal guarded posting. Containment separately stops their new posting boundaries while permitting outcome recording.

## Compatibility migration and rollout sequence

1. Apply `20261117230000_stale_pending_admin_resolution.sql` in its explicit transaction. It is rerunnable, captures original changed definitions/constraint for rollback, expands prior allowed values, and notifies PostgREST only at the end. There is no data backfill or legacy grant revocation.
2. Deploy Railway backend and every ingestion/posting worker with the backend gate OFF. New application ordinary persistence and Monthly Review counts work on the old schema too: optional missing RPCs have scoped legacy fallbacks. Do not activate while any old process remains.
3. Deploy the Vercel frontend with the same feature disabled. Smoke-test ordinary feeds, ingestion, approval and existing posting. Verify retained legacy RPC grants and new private entry-point permissions, function ownership, timeout settings, migration state, and schema-cache availability. Capture baseline queues/errors/lock waits.
4. After compatible clients are verified, apply the availability-only migration and enable the global database/backend gates under separate rollout authorization. Internal admins can then act across every business. Select an explicitly authorized canary transaction for Confirm → manually categorize → Handled → scheduled → posted. Check original pending truth, audit events, GL account/realm, canonical UUID, and exactly one receipt. Monitor before further operator use.
5. After old clients/processes are confirmed retired and rollback checkpoints accepted, the separately staged `supabase/manual/stale_pending_legacy_cleanup.sql` may revoke the two legacy resolution grants. It is intentionally outside automatic migrations and requires a session retirement attestation.

Existing worker disable controls can be used for a future coordinated drain; none are changed here. Before any rollout, verify actual deployed definitions, schema owners/ACLs, allowed-state counts, active provider/posting leases, and migration ledger. Local snapshots cannot certify production drift. Stop enablement for unexpected holds, RPC/permission errors, duplicate canonical paths, deadlocks, timeout increases or checkpoint failures.

## Forward rollback and containment

Before first use, disable application gates and roll back application versions as appropriate, then run `supabase/rollback/stale_pending_before_use.sql`. It atomically refuses if any v2 row/alias/event exists, removes the new guards, and restores captured original functions, classification view and constraint without copying historical backfills. Private additive columns/helpers/snapshot tables remain inert under containment; existing ACLs are retained.

After first use, use `supabase/rollback/stale_pending_containment.sql`: stop new actions and new financial boundaries while retaining alias, intent, receipt and audit protections. Do not restore the old constraint over new values or remove guards to force release. Resolve any in-flight external outcome before a separately reviewed forward fix.

Both paths are tested locally, including a deliberate mid-migration error proving atomic DDL/constraint/permission rollback. Tests use synthetic PostgreSQL fixtures and stub providers. No SQL file here has been applied remotely.

## Local readiness assessment

**GO WITH REQUIRED CHANGES to rollout conditions, not authorization to deploy.** Keep the feature disabled until the authorized deployment preflight verifies actual schema/function/ACL drift, existing state values, timeout configuration and retirement of old processes. The compatibility migration intentionally aborts on unsupported function-body drift. Its fixture tests cannot establish the state of a remote database. Explicitly accept or resolve existing repository lint/regression failures before a release checkpoint.

Local validation: 54 PostgreSQL/Plaid persistence tests, 19 existing PostgreSQL scheduler tests, and 122 focused tests passed. After final approval-evidence hardening, all 23 PostgreSQL lifecycle tests and the contract tests passed again. The additional approval regression group passed 23 of 24; its failing `monthlyReviewMerchantApprovalContract` source-order assertion also fails against unchanged HEAD source (`schemaIndex = -1`). Build and diff checks passed. Targeted changed backend/test lint passed. Repository-wide lint reported 1,678 errors and 190 warnings; both changed UI files retain exactly their HEAD error/warning counts. Build retains the existing large-chunk warning.

## Changed-file inventory

- Configuration: `.env.example`.
- Admin API/UI: `src/api/admin/monthlyReview.routes.js`, `src/pages/Admin/MonthlyReviewConsole.jsx`, `src/components/Accounting/BookkeepingTransactionMirrorTable.jsx`.
- Posting worker: `src/jobs/booksPost.cron.js`.
- Bookkeeping services under `src/services/bookkeeping/`: `autoPostAdmission.js`, `bookkeepingApprovalService.js`, `bookkeepingLifecycleClassifier.js`, `bookkeepingTransactionFeedService.js`, `canonicalPostingCompiler.js`, `finalCategorizationPersistenceService.js`, `interactivePostingCommandService.js`, `pendingResolutionCompatibility.js`, `pendingResolutionContract.js`, `pendingResolutionRequest.js`, `pendingTransactionLifecycle.js`, `pendingTransactionResolutionService.js`, `postingExecutionIntegrity.js`, `statementPendingAuthority.js`.
- Plaid persistence: `src/services/plaid/plaidSyncPersistence.js`, `src/services/plaid/plaidSyncService.js`.
- SQL: `supabase/migrations/20261117230000_stale_pending_admin_resolution.sql`, `supabase/rollback/stale_pending_before_use.sql`, `supabase/rollback/stale_pending_containment.sql`, `supabase/manual/stale_pending_legacy_cleanup.sql`.
- Tests: `tests/helpers/stalePendingResolutionDatabaseSchema.js`, `tests/integration/stalePendingResolution.database.test.js`, `tests/integration/plaidPersistence.database.test.js`, `tests/stalePendingResolutionContract.test.js`, `tests/pendingTransactionResolutionWorkflow.test.js`.
- Documentation: this runbook. The unrelated pre-existing dirty `.claude/worktrees/elated-black-b3db40` submodule was not modified by this work.
