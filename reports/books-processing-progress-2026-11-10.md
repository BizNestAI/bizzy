# Books durable processing progress — local implementation

No production access, provider calls, deployment, push, remote migration, posting, recovery execution or hold release occurred. Only disposable local Docker/Postgres/PostgREST resources were used for database validation. Unrelated `.claude/worktrees/elated-black-b3db40` work was preserved.

## Root cause

The prior Books banner consumed a business-wide queue summary rather than an account/import cohort. `processingRunKey` grouped requests using source plus last-enqueued/process-after/created timestamps; these mutable queue fields were not a durable import identity. The endpoint only exposed a current run while active requests existed. Books inferred success when active_count became zero, called every outcome “categorized,” briefly showed a completion message, then removed it. It did not refetch account cards, tab counts or the current page. A disappearing banner therefore did not mean the loaded feed had refreshed.

This is a source-level explanation of the observed failure, validated with synthetic fixtures; no production run was inspected in this task.

## Durable source and local migration

Existing ordinary sync checkpoints retained admitted_count, but not immutable transaction membership. New local migration `20261110190000_plaid_processing_cohort_observability.sql` adds observability to the existing admission RPC:

- The same admission transaction records its exact active transaction IDs, account IDs, request identities/generations and terminal-at-admission category evidence in `bank_sync_runs.meta.processing_cohort`.
- Account membership is captured even for zero-work accounts.
- A guard prevents membership/account/version changes and replacement/removal of recorded outcomes.
- A queue completion observer appends the terminal categorization snapshot for the matching request generation to `meta.processing_outcomes`, in the same database transaction as completion. Later manual decisions or queue reuse cannot rewrite that run's result.
- Initial terminal requests use their admission-time snapshot. Nonterminal rows contribute only after durable completion evidence exists. Failed/blocked requests remain separate from successful processed outcomes.

No new table or provider call is introduced. Original lease, categorization invariant, processing admission, cursor commit, decision, posting and hold code is retained; only observability metadata and guards are added. The original four Books/Plaid migrations are unchanged. The new migration was applied only to a disposable database, never remotely. It would require separate production approval before deploying this feature.

For already-admitted reviewed recovery batches, existing admitted batch rows provide exact membership; progress checks that the queue request still belongs to that batch. Without a recorded ordinary-sync cohort, historical transaction membership cannot be truthfully reconstructed. This implementation does not fabricate or backfill one. If legacy evidence was superseded, it reports unavailable/blocked evidence rather than using a later run's outcomes.

## Read-only endpoint and scope

`GET /api/bookkeeping/processing/progress?account_id=…&run_id=…` is mounted under existing authentication/tenant middleware. Its controller accepts only the middleware-resolved `req.business.id`, never a header/body/query business fallback. Account ownership, run lookup, recovery rows, requests and categorizations all use that business scope. Results expose only run/account identity, aggregate counts, lifecycle/timestamps and fixed safe messages; no transaction IDs, descriptions, cursors, credentials, queue locks or raw errors are returned.

The total is the fixed account cohort; processed and outcome counts derive from durable terminal evidence for those IDs. Categorization labels reuse the existing lifecycle classifier. Excluded/matched/Needs Review outcomes are not called automatically categorized. Other existing resolved decisions have a separate “already resolved” category.

Discovery works without navigation state or browser storage. It selects the latest account-scoped unfinished cohort before a newer zero-work/completed checkpoint, with deterministic time/ID ordering. Polls pin the run ID. Recently completed results remain discoverable for 24 hours. Reviewed recovery candidates are separately identified; concurrent runs are never merged. Admission metadata is re-read after queue rows to avoid falsely declaring a completion-race snapshot missing.

## Polling and user refresh

A shared pure view model drives progress, completion, blocked state and refresh eligibility. Lightweight serialized polling runs every 2.5 seconds, slowing to 10 seconds after two minutes. It aborts/ignores stale requests on unmount or scope change, preserves last known counts on temporary failure, rejects older/regressive responses and stops on completion or a blocked state. Returning focus to a mounted tab can perform a new durable discovery without continuous terminal polling.

Active progress never invokes a feed loader. Zero processed work says “Preparing…”; subsequent progress uses “Processed/Processing,” with separate automatic, review, matched, excluded and failed/blocked counts. Completion replaces the progress indicator with a compact persistent notice and an explicit Refresh feed action. Partial failures remain visible with a safe reason and pending automatic-retry status where supported.

Refresh calls the existing canonical account-card, tab-count and selected transaction loaders, preserving account/filter/page scope. It updates the displayed refresh timestamp and dismisses successful completion only if all three loaders report success. Failure leaves the notice actionable. Scope guards discard account/tab refresh responses after a business/account switch. No browser reload, category decision or posting operation is used. Current filters remain selected; the button guides users to remaining review work without automatically moving rows.

## Exact files changed

- `src/api/bookkeeping/processingProgress.controller.js`
- `src/api/bookkeeping/routes/bookkeeping.processing.routes.js`
- `src/components/Accounting/ProcessingProgressNotice.jsx`
- `src/hooks/useProcessingRunProgress.js`
- `src/pages/accounting/BookkeepingCleanup.jsx`
- `src/services/bookkeeping/bookkeepingClient.js`
- `src/services/bookkeeping/processingRunProgress.js`
- `src/utils/processingProgressView.js`
- `supabase/migrations/20261110190000_plaid_processing_cohort_observability.sql`
- `tests/processingRunProgress.test.js`
- `tests/processingProgressUi.test.js`
- `tests/bookkeepingProcessingStatusUx.test.js`
- `tests/booksReviewLoadingUx.test.js`
- `tests/integration/plaidPersistence.database.test.js`
- `reports/books-processing-progress-2026-11-10.md`

## Validation

- Focused status, polling, component, previous UI and Plaid recovery/reconnect/persistence regressions: **151/151 passed**. This includes all 95 previous Plaid regressions, the previous 26 status/UI cases, two legacy processing read-only contract tests, and 28 new progress cases.
- Disposable production-shaped Postgres/PostgREST suite: **30/30 passed**, including the new 20-member cohort, 17 auto/3 review terminal snapshots, later manual decision preservation, immutable manifest rejection and tenant denial. Existing persistence, admission rollback, identity, reviewed hold release and reconnect cases remain intact.
- Changed-file ESLint: passed with no warnings.
- Production build: passed with the existing large-chunk warning.
- Whitespace/diff validation: passed.

A broader 57-case Books source-assertion suite has **51 passing and six pre-existing failures**, reproduced with the same test set on an isolated untouched HEAD checkout. They concern date-reset source shape, pending-to-posted implementation source shape, inconsistent-empty-page source shape, failed-refresh/toast source shape, undo source shape and database-bounded loader source shape. None was introduced or weakened by this feature. Source assertions specifically tied to the replaced processing banner were updated to the new scoped/read-only implementation, retaining the read-only and feed-stability guarantees.

## Limitations and operational implications

- No real-browser visual or keyboard smoke test was performed. React component/hook tests cover refresh, completion, scope changes and cancellation.
- Old ordinary sync runs without a manifest cannot receive a reconstructed exact denominator; no historical backfill is attempted. Older reviewed recovery requests whose generation changed are blocked rather than guessed.
- The new JSON observability metadata grows with cohort size. Completion recording serializes updates to a shared run row; large-cohort throughput and discovery history volume warrant staging measurement. No production performance claim is made.
- Outcome snapshots describe that processing run, not subsequent user decisions; Refresh feed loads the current ledger. An older run's initial Needs Review count can therefore differ from the current feed after intervening decisions.
- The new local migration must precede the endpoint/frontend in any separately authorized rollout. Do not replay the four already-installed Books/Plaid migrations or include unrelated historical migration cleanup.
