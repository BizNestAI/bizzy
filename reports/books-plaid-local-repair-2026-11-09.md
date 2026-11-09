# Local Books/Plaid persistence repair — November 9, 2026

## Proven root cause

The original sparse posted-review payload, sent through Supabase JS to real PostgREST and PostgreSQL 17, fails with **SQLSTATE `23502`, table `public.bank_transactions`, column `business_id`, NOT NULL**. The target row already exists and has a posted categorization. PostgreSQL still validates the insert candidate of an upsert; the existing primary key does not make an incomplete insert a valid update.

The repaired business-scoped `UPDATE ... WHERE business_id = ... AND id = ...` succeeds against the same schema and rejects an attempt using the other synthetic business. The mixed-batch test exercises a real material change on a posted transaction through the actual sync implementation.

This proves the defective code path and its precise local failure. Historical production logs did not retain the violating column, so it does **not** retroactively prove that every production `23502` had this same cause. Production was not accessed during this repair. The prior 119-row production backlog was neither changed nor enqueued.

## Changes

- `src/services/plaid/plaidSyncService.js`: uses business-scoped updates for existing bank rows, posted-material-change review, removed-row archive and posted-removed review. Only complete new-row payloads retain insert/upsert semantics. Checks previously ignored exclusion-lifecycle errors. Resolves identities in chunks and checks completeness before admission; preserves pending-source identity on replay. Calls one atomic admission/checkpoint RPC, removes inline processing wake, reports business-wide sync failures truthfully and keeps failure diagnostics scoped to the owning lease.
- `src/services/plaid/plaidSyncPersistence.js`: scoped update authority with exact target-count checks, atomic admission client and redacted operation/table/column/constraint/stage/reason diagnostics. Raw database DETAIL, descriptions, credentials and cursors are discarded. New-transaction and update predicates are identified separately.
- `supabase/migrations/20261109173000_plaid_durable_sync_admission.sql`: adds the service-role-only `complete_plaid_sync_admission` RPC and updates the existing categorization invariant function to insert missing records without resetting established decisions, matches, exclusions, receipts or archive state. Admission, Item cursor/success state, account success timestamps and completed-run evidence commit together. No new tables or columns and no data backfill.
- `tests/integration/plaidPersistence.database.test.js`: real disposable PostgreSQL/PostgREST suite exercising the actual sync implementation, with synthetic Plaid events and external HTTP blocked. Database posting triggers are included, but no processing or QBO posting worker is started.
- `tests/plaidSyncCategorizationPersistence.test.js`, `tests/plaidCanonicalization.test.js`, `tests/plaidReplacementCardRecovery.test.js`, `tests/backgroundBookkeepingProcessing.test.js`: updated the focused regression contracts for scoped updates, asynchronous processing and the new database checkpoint authority; added diagnostic redaction checks.

The legacy business-wide normalization pass was removed from the sync success path: it also used sparse ID upserts, swallowed failures and rewrote unrelated historical rows. Incoming provider rows are still normalized before persistence. Historical normalization, if needed, must be a separately reviewed repair rather than an implicit side effect of syncing one Item.

## Durability and preservation

Bank mutation chunks can still commit independently. That is deliberate: if a later chunk fails, the durable run remains failed and the original Item cursor is retained for replay. A successful run now requires completed categorization and durable processing admission. There is no longer a successful cursor commit followed by a best-effort, swallowed enqueue failure.

The admission RPC locks and verifies business, Item, environment, original cursor, active Item, lease owner/expiry and running attempt. Scope/lease conflicts fail closed. A database constraint failure rolls back categorization, queue admission, timestamps, cursor and completed status together. The outer sync records a separate durable failed run with redacted stage/constraint evidence. If even diagnostic writes fail, the already-created run stays incomplete; logs report evidence failure, and the cursor remains retained.

Existing processing-request IDs and error history remain intact. Pending/failed work is not reset on duplicate replay. Completed/skipped requests may be reactivated for a new cursor generation using a cursor hash. An active request processing an older generation, or an unresolved nonterminal dead-letter request, blocks checkpoint advancement with `plaid_processing_request_requires_replay`; sync must replay after lease completion/recovery or explicit dead-letter resolution. This avoids silently treating an old in-flight evaluation as admission of new transaction evidence.

Existing categories, matches, exclusions, recovery batch references/holds and QBO intent/receipt payloads survive tested duplicate/mixed replay. Existing pending-finalization/exclusion lifecycle policy is unchanged; the repair does not redefine when a materially finalized authorization requires review. Bank review flags can change without rewriting a posted ledger amount or losing its receipt. The admission RPC itself never updates QBO receipts/intents or invokes a provider.

Processing remains asynchronous through the existing worker. Removing the inline wake means normal categorization can wait until the next worker interval (default five minutes); auto-post remains independently controlled. Account checkpoint timestamps exclude disconnected/non-syncing accounts. Successful admission clears current Item sync error fields while retaining separate failed-run history.

## Database fixture and evidence

The test creates its own uniquely named Docker network and ephemeral containers (`postgres:17`, local PostgREST v16.4), binds the API only to localhost and removes its containers/anonymous volumes afterward. No `.env` is loaded by the test harness; Supabase points to the local fixture before importing the service. The injected Plaid client returns synthetic events. External fetches fail the test, and no worker is started.

Core table DDL, indexes, ownership/identity foreign keys and bank/categorization triggers are extracted from `supabase/live_schema_snapshot.sql`. The fixture applies the repository's Plaid environment, canonical identity, QBO intent/idempotency, processing queue, replacement recovery, review/posting state, pending resolution, exclusion, posting-job and connection-state migrations. It includes the latest relevant primary-feed classifier and the real posting-job trigger. Service-role grants and real NOT NULL/check/unique/FK constraints are active.

Unrelated module tables, external-module foreign keys and billing-profile triggers are excluded; authentication supplies a synthetic users table/function. This is a focused production-shaped fixture, not a certified byte-for-byte copy of the currently installed remote catalog. The initial exploratory whole-snapshot import exposed unrelated extension dependencies, so validation uses the strict focused fixture and `ON_ERROR_STOP=1` instead of accepting a partially restored schema.

Validated commands/results:

1. `node --test tests/integration/plaidPersistence.database.test.js`: **9 tests pass** (parent plus eight database scenarios). Covers original `23502`; mixed new/modified/posted updates; duplicate replay; scope isolation; admission RPC failure; real categorization and queue constraint rollback; preservation of unknown QBO intent/request identity and recovery provenance; processing lease preservation; failure after a 200-row commit; full admission of a **1,002-row** batch; pending→posted stable identity; unposted removal; posted removal protection; later successful error clearance with old failed records preserved.
2. Focused unit/regression command with synthetic loopback Supabase environment: **64 tests pass** across categorization persistence, canonicalization, replacement recovery and connection-state contracts.
3. ESLint on all changed JavaScript/test files: **passes**.
4. `npm run lint`: **fails with 1,877 repository-wide findings (1,687 errors, 190 warnings)** in existing code/configuration. Changed files pass the focused lint command. No unrelated lint cleanup was attempted.
5. `npm run build`: **passes**, with existing bundle-size warnings.
6. `git diff --check`: **passes**.

Additional adjacent lifecycle/worker regressions: **63/66 pass**. Three unrelated pre-existing source-assertion failures remain: pending-tab predicate spelling, credit-card status helper spelling and legacy Reconciled→Matched predicate spelling. Each failing target source file is byte-identical to HEAD, and each same assertion also fails against its HEAD contents. Two assertions requiring the intentionally removed best-effort inline wake were updated to require durable atomic admission and asynchronous processing. No unrelated UI/feed behavior was changed to satisfy stale assertions.

Integration tests explicitly execute database migrations only in their own disposable container. They do not reset an existing Supabase project or invoke a remote migration command. Unit test source assertions complement, rather than substitute for, the database reproduction.

## Schema implications and compatibility risks

- Deploy the new function before the backend that calls it. Missing RPC/schema incompatibility fails closed with an old cursor and failed attempt; there is no unsafe fallback enqueue/checkpoint path.
- The existing categorization-invariant function now preserves established state instead of unconditionally resetting accounting-review categories. Its signature and service-role grant remain compatible. Callers relying on its former automatic archive/reactivation behavior must use explicit lifecycle mutations instead.
- New admission requires the existing processing queue, recovery/connection columns, lease/run contract and categorization fields. Migration filename presence alone does not establish those installed definitions. Compare the real catalog in staging and then perform a read-only production preflight before deployment.
- Processing/dead-letter conflicts can keep an Item checkpoint behind until the corresponding work is resolved. This is surfaced as retriable evidence rather than hidden loss of an evaluation. This task does not mass-reset old dead-letter jobs or repair stuck worker leases.
- Existing-row updates issue individual scoped requests. Large replays can take longer than batch upserts and may exhaust the existing five-minute sync lease; the admission RPC rejects an expired lease. Measure production-shaped staging latency and use bounded batches/lease renewal if necessary before a large recovery.
- The 1,002-row regression protects new-row admission and exact-identity lookups from API result caps. Broader heuristic date/physical-account candidate searches retain their existing bounds; cross-Item/migration deduplication still needs the separately reviewed recovery workflow from the audit.
- A successful repair can expose weeks of backlog to the asynchronous worker. Do not enable posting without reviewing eligibility, protected workflows, recovery holds, unknown/pending receipts and possible existing QBO entries.

## Exact future deployment order (not performed)

1. Rehearse in staging with the actual installed production-shaped constraints, triggers, function bodies and grants. Validate the reproduction and the checked-in migration, with QBO outbound writes blocked. Verify the target business/environment and retain a rollback snapshot.
2. Before any production rollout, operationally pause bank sync, background categorization and automatic posting (`DISABLE_PLAID_SYNC_CRON=true`, `DISABLE_BOOKKEEPING_PROCESSING_WORKER=true`, `DISABLE_BOOKS_POST_CRON=true`), and prevent manual sync/post actions during the maintenance window. Confirm those settings apply to every backend replica. This is a future authorized operations step, not a change made here.
3. Apply only `20261109173000_plaid_durable_sync_admission.sql` after verifying prerequisites. Do not blanket-push the migration directory. Verify installed function bodies, safe search paths, service-role-only execution and PostgREST schema visibility. The migration performs no row backfill.
4. Deploy the matching backend with workers still paused. Verify deployed SHA and RPC availability. Keep posting paused. A backend rollback must keep sync paused so it cannot reintroduce sparse mutations or the old enqueue-loss window; leaving the new functions installed is safe.
5. After separate production authorization, resume a bounded AMEX/Chase/Truist sync cohort with categorization/posting still paused. Reconcile retained-cursor replay, orphan count, active categorizations, durable requests, failed-run evidence and account success fields. Do not assume every one of the 119 historical rows is returned by the provider replay; independently preview remaining orphan IDs for a separately authorized repair.
6. Review processing/dead-letter conflicts and pending/unknown QBO receipts. Enable background categorization for a reviewed cohort while posting remains disabled. Validate categories, manual decisions, excluded/matched rows, recovery holds and auto-post scope.
7. Only after continuity and live ledger reconciliation, obtain the separately required authorization for external QBO writes and enable posting for the reviewed eligible cohort. Monitor duplicate-prevention/request identity, receipts, retries and lag before expanding. Discover reconnect/history recovery remains a separate operation.

## Remaining uncertainty

The defective sparse-upsert path is proven locally; production attribution cannot be recovered from logs that discarded column metadata. No live sync, production job admission, QBO auth refresh/write, remote migration or deployment was performed. Completeness of bank/provider history and the live QBO ledger, exact current remote schema parity and whether cursor replay alone covers the full 119-row backlog remain unverified. Existing unrelated working-tree changes and the prior audit artifacts were left intact.
