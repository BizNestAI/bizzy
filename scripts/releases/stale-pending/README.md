# Isolated stale-Pending release runner

**Scoped local readiness: GO. Production rollout remains separately authorized.**
This directory is a local, reviewable release artifact. Nothing here has been
applied remotely. The broad migration-history reconciliation is separate.

## Execution source and integrity

`supabase/migrations` contains exactly five SQL files:

1. `20260808174146_remote_schema.sql` — exact fetched recorded payload.
2. `20261111220000_auto_post_handled_admission.sql` — exact fetched recorded payload
   (six blank lines differ from repository HEAD; SQL semantics are unchanged).
3. `20261117230000_stale_pending_admin_resolution.sql` — corrected, unapplied.
4. `20261118220000_stale_pending_global_admin_availability.sql` — unchanged.
5. `20261118230000_stale_pending_permanent_admin_capability.sql` — unchanged.

The two historical files are matching ledger records, **not a bootstrap of
production and not SQL to replay**. The migration plan must list only the final
three files. `manifest.json` pins every payload hash. Regenerate copies locally
with `node scripts/prepareStalePendingReleaseRunner.js`, then review the manifest.
Tests execute the release copies, never the main migration directory. The module
prerequisites are a static schema-only disposable fixture, not historical replay.

## Fresh evidence and limits — 2026-11-19

The operator supplied the complete JSON result captured at
`2026-11-19T17:26:45.359903+00:00` from the read-only catalog query. The JSON is
untruncated and internally consistent: 222 public relations, 3,674 columns,
329 function definitions, 108 triggers, 985 constraints, 808 indexes, 173 policies,
782 dependency entries and six default ACL records. The ledger still has exactly
the two recorded versions. The ten previously captured function definitions,
owners, ACLs, security modes and settings are unchanged.

The query identifies `database=postgres`, not a Supabase project reference.
Project attribution to `zwufvvrmjbymgyjntdzk` is supplied by the operator; confirm
the dashboard project before rollout. The source attachment hash is preserved
under `provenance` in `catalog.json`.

`scope.json` lists every incorporated definition: 45 relevant relations, 88
functions and 37 triggers. `scripts/buildStalePendingCatalogFixture.js` derives
`prerequisites.sql` from the captured definitions plus a dependency closure.
The local integration test compares all scoped columns, constraints, indexes,
RLS policies, triggers and relation metadata to the source, and separately
compares all 88 function definitions/ACLs/configurations/owners. No historical SQL
is replayed. The supplement below supplies exact auth.uid and role/schema
security metadata; only auth.users remains an id-only seed boundary.

The production vehicle trigger body is now included. It takes a blocking,
business-wide `:vehicle-election` advisory lock. The new account fence precedes
it by trigger name. Tests verify the resolution timeout and stable-key retry when
that legacy lock is held, and immediate account-busy failure for the inverse
legacy order. The existing business lock remains unchanged; ordinary legacy
writers without timeouts can still wait on it. The lifecycle audit trigger is
included and tested to persist the manual release/Handled event.

## Supplemental effective privileges — 2026-11-19

The operator supplement was captured at `2026-11-19T18:26:41.365168+00:00`.
Its 3,674 columns/types and 222 relation kinds match the earlier public catalog.
It supplies column ACLs/ordinals, 16 role records, 21 membership edges, three schema
ACLs, sequence metadata, the exact auth.uid() definition, enums/extensions and
named default ACL owners. Both snapshots are retained with source hashes. Project
attribution remains the operator's; neither SQL result encodes a project ref.

The generator now reproduces all captured role flags and filtered settings,
including NOSUPERUSER/BYPASSRLS postgres; SET/INHERIT/ADMIN membership flags and
grantors; column/schema ACLs; default privileges; auth.uid(); and physical column
positions including business_profiles' dropped-column gaps. ACL list order is
normalized in comparisons; no privilege/grantor/grant-option is discarded.
The equality test verifies these against the supplied supplement.

The exact missing executor grant is UPDATE(posting_hold_batch_id) on
transaction_categorizations. UPDATE(meta) and table-wide UPDATE remain forbidden.
All four previous reconciliation permission regressions now pass. They were
fixture omissions, not regressions introduced by the three migrations and not
proof of a broken production reconciliation workflow.

The local bootstrap uses supabase_admin, then runtime/migrations execute as the
captured non-superuser postgres. PostgREST connects as authenticator and switches
to service_role/authenticated/anon through captured SET permissions. Synthetic
auth.users seeds are created separately by the local bootstrap principal; runtime
roles are not granted invented auth-table privileges. auth.users itself remains
an id-only local boundary, with no production users/credentials copied.

Only required uuid-ossp 1.1 (extensions schema) and pg_trgm 1.6 (public schema) are
installed. No scoped relation/function requires a sequence, deadline_status,
vector, vault or stats extension; their supplemental definitions/settings remain
metadata and are not installed merely to make broad tests pass.

The absent cohort functions/triggers remain absent. Their broad test remains
unchanged and failing. Neither the three migrations nor the captured function
closure references those objects; the whole intended lifecycle passes without
them. This pre-existing condition is explicitly outside release acceptance.
Separate follow-up: `reports/followups/plaid-processing-cohort-production-drift.md`.

## Compatibility review

- Stage 1 now requires all eight existing feed/classifier/scheduler/approval/
  intent/lock signatures, the original classification view and pending-state
  constraint. Missing prerequisites abort its transaction. Unknown adapter body
  or scheduler contracts abort rather than silently omit the guard.
- The canonical FK requires bank `(business_id,id)` uniqueness. Column, foreign
  key, table and field contracts used by SQL bodies must match the physical
  database; the fresh catalog export is still required to verify all of them.
- New private tables have RLS enabled and browser grants revoked. Legacy grants
  remain intact in this compatibility chain. Private admin RPCs are service-role
  only; server routes must independently verify internal staff/access-session
  authority and retain the internal actor. Customer membership is insufficient.
- Stage 2 depends on stage 1 and only changes availability/helper grants.
- Stage 3 requires the earlier lifecycle table/functions and known function-body
  text. It fails atomically on unknown drift. It removes feature/allowlist gates,
  preserves financial containment and does not remove posting protections.
- Each stage retains its own BEGIN/COMMIT and lock/statement timeouts; PostgREST
  notification remains inside the transaction after required objects exist.
- Before-use rollback restores the actual captured timestamptz function through
  the installation snapshot, with existing ACLs intact. It refuses after use.
  After use, containment retains all guards and now upserts its singleton, so
  containment also works if the optional configuration row is absent.

## Local verification

Run from repository root, with local Docker available:

```sh
node --test tests/stalePendingReleaseRunner.test.js
node --test tests/integration/stalePendingReleasePlan.database.test.js
node --test tests/integration/stalePendingResolution.database.test.js
node --test tests/integration/plaidPersistence.database.test.js
node --test tests/stalePendingAdminSurfaces.test.js tests/stalePendingResolutionContract.test.js tests/adminBookkeepingAccess.test.js tests/pendingTransactionResolutionWorkflow.test.js tests/plaidSyncCategorizationPersistence.test.js
npm run build
npx eslint scripts/prepareStalePendingReleaseRunner.js tests/stalePendingReleaseRunner.test.js tests/helpers/stalePendingResolutionDatabaseSchema.js tests/integration/stalePendingReleasePlan.database.test.js tests/integration/stalePendingResolution.database.test.js tests/integration/plaidPersistence.database.test.js
git diff --check
```

The CLI-plan test connects only to a disposable localhost database with the exact
two supplied ledger records. It runs the real installed CLI's dry-run and proves
that precisely three release versions are listed, no release objects are created,
and the ledger still has two rows. This proves planning against that ledger; it
is not a remote production dry-run and cannot establish current remote drift.

The application lifecycle is unchanged: statement confirmation preserves provider
pending truth and moves to Needs Review with suggestions only. Manual category
approval plus fresh checks creates audited release/Handled authority. Scheduling
and final posting each retain fresh guards. Confirmation alone, and even acquiring
an ordinary legacy lease, grants no final GL category, schedule or posting release.
The tests use fake QBO results; no provider is invoked.

## Proposed later rollout — NOT AUTHORIZED OR EXECUTED

Local catalog equivalence, trigger composition and lock-order checks pass. Before
a separately authorized rollout, verify production-state compatibility, reviewed
rollback, current target/ledger, DDL authority, and operational drain checks.
The local database is owned by postgres to model pg_database_owner; the exports
do not identify database ownership. Verify effective CREATE on public for the
actual migration principal during that operational preflight.
Pin the CLI version used in validation. The repository-installed CLI uses `--linked`
(the separate global CLI may use `--remote`); do not mix command syntaxes blindly.

1. Verify schema/catalog/ledger again. Drain bookkeeping mutation requests,
   internal-admin resolution requests, all Plaid/categorization writers, scheduling,
   matching, receipt/intent writers and posting workers; let in-flight provider
   responses persist. Confirm no old process is still writing. Abort on active
   leases, long transactions or unresolved receipts that prevent a safe drain.
2. Prepare and review runner hashes locally. Link only the isolated workdir using
   approved existing authentication, without putting passwords in arguments.
3. Plan against production; abort unless exactly the three release files appear.
4. Apply the isolated chain only after separate approval. The files remain three
   independent transactions; stage failure stops further execution. Check installed
   signatures/ACLs/triggers/constraints after each stage. Never compensate by replaying
   historical migrations or changing ledger records in this release.
5. On stage failure, retain the drain and investigate. Before any resolution use,
   the reviewed before-use rollback can restore snapshot definitions; after use,
   use financial containment instead of removing identity/posting guards.
6. Deploy reviewed compatible backend and every worker if needed; prove all old
   processes retired. Deploy compatible frontend if needed. Resume ordinary writes
   in a controlled order after database verification and PostgREST schema reload.
7. Smoke-test ordinary feeds/categorization/scheduling and the verified internal
   admin surfaces. Ordinary customers/owners/admins must receive 403. A real
   resolution canary requires separate authorization. There is no feature-enable
   or per-business allowlist step: capability is permanent for verified staff.
8. Monitor lock failures, SQL/RPC errors, alias/conflict events, duplicate receipts,
   queue age and posting retries. Abort new operations on unexpected authorization,
   identity, classification or posting behavior; drain and contain after first use.
9. Legacy-grant cleanup is a later independent change, after old processes are gone.

Proposed commands, from repository root, only after separate authorization:

```sh
node scripts/prepareStalePendingReleaseRunner.js
node --test tests/stalePendingReleaseRunner.test.js
node_modules/.bin/supabase link --project-ref zwufvvrmjbymgyjntdzk --workdir scripts/releases/stale-pending
node_modules/.bin/supabase db push --dry-run --linked --workdir scripts/releases/stale-pending
# STOP: review exact three-file plan, drain status, hashes, catalog and rollback.
node_modules/.bin/supabase db push --linked --workdir scripts/releases/stale-pending
```

For separately authorized rollback/containment, with a securely configured libpq
service and after checking before-use/after-use eligibility respectively:

```sh
psql 'service=bizzi-production' -X -v ON_ERROR_STOP=1 -f supabase/rollback/stale_pending_before_use.sql
# AFTER USE: retain guards; use containment instead of before-use rollback.
psql 'service=bizzi-production' -X -v ON_ERROR_STOP=1 -f supabase/rollback/stale_pending_containment.sql
```

No Railway/Vercel deployment, worker drain/restart, remote linking, migration apply,
history repair, live resolution or provider request was performed in this task.

## Recorded local results — supplemented fixture

- Three-stage upgrade, catalog/privilege equivalence, lifecycle/manual release,
  guards, concurrency/timeouts, rollback/containment: 33 checks pass.
- Full persistence suite: 30 passing subtests, one unchanged failing cohort test
  (plus the parent failure). All four previous permission regressions pass under
  the captured effective roles. Settlement/identity and PostgREST checks pass.
- The single cohort failure is a documented, tested nondependency, not a required
  historical repair for this release. No assertion or test was weakened/skipped.
- Actual CLI dry-run lists exactly 20261117230000, 20261118220000, 20261118230000;
  two original ledger records remain unchanged and no release DDL executes.
- All 45 focused authorization/UI/contract checks, build, targeted lint and diff checks pass.
  The build retains its existing large-chunk warning.
- Verdict: GO for this strictly local, three-migration readiness assessment.
  This does not execute or authorize production rollout commands. Verify current
  target identity, ledger, worker/request drain, DDL privileges and lock baseline
  before a separately authorized rollout. Monitor legacy vehicle-lock contention
  and posting/alias/receipt guards; retain the documented containment checkpoints.
