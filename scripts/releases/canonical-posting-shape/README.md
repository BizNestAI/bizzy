# Canonical posting-shape isolated release package

**HOLD — local corrections and package validation only.**
The operator has not yet authorized a linked dry run; that hold remains in force.
No production mutation, linking, linked dry run, provider call, RPE action, worker change,
deployment, commit, push or history reconciliation is part of this preparation.

The only pending file permitted is:
`20261123230000_canonical_posting_shape_authority.sql`.
Never use the main migration directory, `--include-all`, migration repair, reset,
pull, historical replay or manual ledger edits for this release.

## Inputs, integrity and work directories

The original fixture ledger capture is dated **2026-11-19T17:26:45.359903+00:00**.
It contains exactly `20260808174146` and `20261111220000`. Later local release
manifests and installed functions are NOT evidence that later ledger rows exist.
`captured-ledger.json` is marked fixture-only and cannot authorize a linked plan.
Project attribution in that export is supplied by the operator, not independently
encoded by PostgreSQL. The expected project is `zwufvvrmjbymgyjntdzk`.

Prepared local fixture workdir: `/private/tmp/bizzi-canonical-posting-shape-fixture`.
It has two captured historical version markers and only the canonical migration
pending. Historical marker files contain comments only, not historical SQL to
replay. The manifest explains this explicitly; the package does not pretend they
are exact historical applied payloads. CLI planning uses the exact version set.
The pending payload is byte-for-byte pinned to the main source by SHA-256.

The production-target isolated workdir `/private/tmp/bizzi-canonical-posting-shape`
is now prepared from `current-ledger.json`, supplied by the operator on November 23.
It contains exactly these seven recorded version markers:

- `20260808174146` — remote_schema
- `20261111220000` — auto_post_handled_admission
- `20261117230000` — stale_pending_admin_resolution
- `20261118220000` — stale_pending_global_admin_availability
- `20261118230000` — stale_pending_permanent_admin_capability
- `20261120220000` — stale_pending_durable_account_scope
- `20261120233000` — handled_exclusion_posting_safety

Only `20261123230000` is pending. The JSON retains the supplied rows exactly;
its timestamp is message receipt, explicitly distinguished from an unprovided
SQL execution timestamp. Project attribution comes from the operator. The
manifest explicitly records `linked_planning_authorized: false`. New approval
is required before changing that authorization metadata and running any linked plan.
Reconfirm ledger freshness before later planning/application; packaging alone
cannot prove that the remote ledger has remained unchanged.

A version collision, newer recorded version, stale capture/receipt, unknown project,
unexpected SQL file, changed source/config/hash or any extra pending version aborts.

Local fixture preparation:

```sh
node scripts/prepareCanonicalPostingReleaseRunner.js --ledger scripts/releases/canonical-posting-shape/captured-ledger.json --output /private/tmp/bizzi-canonical-posting-shape-fixture --fixture-only
node scripts/prepareCanonicalPostingReleaseFixture.js
node --test tests/canonicalPostingReleaseRunner.test.js tests/stalePendingReleaseRunner.test.js
node --test tests/integration/canonicalPostingReleasePlan.database.test.js tests/integration/stalePendingReleasePlan.database.test.js
node --test tests/integration/canonicalPostingRelease.database.test.js
node --test tests/integration/autoPostAdmission.database.test.js
```

Preparation from the newly supplied ledger (local only):

```sh
node scripts/prepareCanonicalPostingReleaseRunner.js --ledger scripts/releases/canonical-posting-shape/current-ledger.json --output /private/tmp/bizzi-canonical-posting-shape
```

The seven-row ledger was also tested with the real CLI against a disposable,
read-only localhost database (NOT the linked project):

```sh
CANONICAL_RELEASE_LEDGER=scripts/releases/canonical-posting-shape/current-ledger.json CANONICAL_RELEASE_WORKDIR=/private/tmp/bizzi-canonical-posting-shape node --test tests/integration/canonicalPostingReleasePlan.database.test.js
```

No credential discovery or authentication bootstrap is implemented. The planner
has NO apply/link/repair/history-write mode. A changed CLI version must be reviewed
and tested; the pinned CLI is **2.122.1**, invoked only as `npx --yes supabase@2.122.1`. The local CLI test uses a
localhost-only URL and a disposable database enforced `default_transaction_read_only=on`.

The linked command below is documented for a later, separately authorized planning
step. **Do not run it under the operator's present instruction.** It additionally
requires explicit linked-planning authorization recorded in the manifest, an already configured database password and an explicit read-only planning
attestation; it will not initialize a login role, search keychains, or log secrets.
The existing link must match the expected project. It copies only connection
metadata into the isolated workdir and requests read-only session options.

```sh
BIZZI_CANONICAL_READ_ONLY_PLANNING=1 node scripts/planCanonicalPostingRelease.js --workdir /private/tmp/bizzi-canonical-posting-shape --link-from /private/tmp/bizzi-handled-exclusion
```

`SUPABASE_DB_PASSWORD` must already be configured securely in the process environment;
never put its value in command arguments or reports. The operator must confirm the
configured connection is authorized for read-only planning. The command always uses
`db push --dry-run --linked --workdir <isolated directory>` internally, never apply.
It writes sanitized `dry-run.txt` and `plan.json`. The parsed SQL filename set must
be exactly the one file above; nonzero CLI exit, no plan or any extra file aborts.
No automatic retry with broader flags is available.

## Local compatibility scope

`prepareCanonicalPostingReleaseFixture.js` extends the existing captured catalog
fixture with the captured `transaction_splits` and RPE audit table definitions.
The generated schema preserves the captured column types, constraints, owners,
role flags/memberships, ACLs, RLS, functions, triggers, settings and auth.uid.
Auth users remain id-only synthetic seed boundaries; no production rows or tokens
are copied. The fixture is local, not evidence of today's complete production schema.

The compatibility fixture starts from that schema-only capture and applies exactly
five explicit LOCAL module transitions: stale-pending resolution, availability,
permanent capability, durable account scope and handled-exclusion safety. These
model the known installed modules. Neither the baseline remote_schema migration
nor the historical admission migration is replayed. These fixture transitions
are NOT pending production release files and are never put in the new runner's
migration directory. `fixture-manifest.json` pins their inputs and scope.

The compatibility test applies the exact isolated pending copy as captured
non-superuser `postgres`. It compares every pre-existing public function's owner,
ACL, configuration, security mode and signature, plus unchanged definitions except
the four reviewed adapters: `auto_post_technical_block`, `admit_handled_auto_post`,
`approve_bookkeeping_with_admission`, and `sync_bookkeeping_posting_job`. Existing triggers remain unchanged. It
checks new RPC/browser grants, canonical compiler/binding and all retained
statement-pending/exclusion fences; a synthetic confirmed loan split compiles and
schedules without a top-level GL account. Deliberate failure after DDL proves the
whole migration transaction rolls back functions, grants and triggers.

Atomic rollback means failure BEFORE the migration's COMMIT. A failed separate
post-commit verification cannot undo an already committed migration. Keep writers
paused and investigate; do not remove safety guards or repair history automatically.

## Read-only verification and release gates

1. `capture-ledger.sql`: fresh complete ledger metadata before packaging.
2. `capture-functions.sql`: pre-application function owner/ACL/config/body baseline.
3. `verify.sql`: post-application ledger row, eleven exact new signatures, browser
   denial/service grants, compiler/split/RPE markers, enabled triggers, retained
   guard signatures, NOT NULL actor preservation, and fence metadata comparison.
4. `scheduled-preflight.sql`: every scheduled transaction, with shape, technical,
   binding, receipt/claim and dedicated-workflow review outcomes. Every non-PASS
   row requires resolution or explicit separate review before worker resumption.
5. `inspect-car-loan.sql`: current schedule/job, claim, intent, attempt, receipt,
   confirmed material and QBO-posted state; no raw provider payloads.
6. `legacy-records.sql`: dispositions and latest approval-event timestamps for the
   six audited records, scoped to Pat's Test Account.

Every script is enclosed in `BEGIN READ ONLY` / `ROLLBACK`. None invokes RPE,
creates a claim, binds data, schedules a transaction or calls a provider. Require
all expected verification rows, true checks, two enabled new triggers, the single
new ledger row and matching baseline properties. Missing rows are failures.
Only the four listed existing function bodies may change; their original
owners/ACLs/configuration and later installed fences must remain intact.

The scheduled report is conservative. Dedicated workflows and controlled retries
are separate review cases, not generic inflows. A provider-free PASS is necessary
but does not replace live lease, receipt, duplicate and final financial-write
checks. Those still run in the worker. Do not resume on an unexplained non-PASS.

## Legacy records: audited state, not a fresh production assertion

All actions below are proposed only; none has been performed.

| Record | Audited authority | Required disposition before workers resume |
|---|---|---|
| Schwab +$1,633.24, `3c5876f9-c9f5-4d34-b408-7625396515d6` | Manual Income approval, no amount/source identity | Fresh manual approval; RPE cannot infer missing historical identity. Reconfirm that this is income, not owner activity or a transfer. |
| Snowball +$150, `666ed205-cf2d-4210-b3d4-a3ffcda513d7` | Manual Income approval, no amount/source identity | Fresh manual approval with current actor/business/amount/direction/source/account identity. |
| Conde +$35, `37139225-ca7a-4b4f-a2eb-353b2c7ef46d` | Bound depository expense-refund attestation | No repair if unchanged and preflight passes; retain Entertainment. Do not infer refund treatment from the description alone. |
| Conde +$110, `b42fcb9a-a4de-4655-98a8-265fb17c6636` | Bound depository expense-refund attestation | Same: no repair if unchanged and preflight passes. |
| Lucky Strike +$4.99, `44c425c5-f2bc-4149-8474-8f1893861d03` | Bound card-refund attestation and merchant-refund resolution | No repair if unchanged and preflight passes; preserve the supported Credit=true card-credit shape. |
| Car-loan split `b3e8c006-c250-4b50-9524-24d3508d31d2` / split `e19928f1-49eb-414d-9ba0-e29223c0e0a3` | Confirmed $467.55 liability + $50 expense, no legacy binding | Validate/bind the existing schedule ONLY if preview says `bind_existing_schedule`; preserve even an overdue deadline exactly. An `already_valid` result requires no mutation. Do not add a top-level GL account. |

An absent single-line binding is not alone a blocker for a valid legacy refund:
its bound refund attestation supplies the required authority. RPE binding is
optional for those three refunds, not a reason to reschedule them.

The split's audited deadline was **2026-11-23 22:56:28.607 UTC (5:56:28 PM EST)**.
Run the read-only `inspect-car-loan.sql` before any later repair; the captured audit
is not a current production assertion. Both future and overdue persisted schedules
use the new `inspect_existing_split_schedule` / `bind_existing_split_schedule`
workflow. Preview distinguishes `bind_existing_schedule`, `already_valid`, a genuinely
unscheduled `eligible_to_schedule`, and blocked records. Never confirm a preview
that would reschedule this loan. The binding RPC requires an active internal actor,
current shape/row identity, confirmed balanced material and a safe existing job;
it serializes bank → categorization → job → split → intent/attempt locks behind
the existing account fence, makes no provider call or posting claim, and checks
that the entire job row and `post_after` are unchanged. Stale/conflicting/posted/
processing/ambiguous/attempted/revoked/unbalanced records fail closed.

For Schwab, Snowball and ANY older income approval without current amount/source
identity, use the legitimate existing Undo/return-to-Needs-Review workflow, then
fresh manual approval of the correct account. The database-owned `review_reopened_at`
epoch and authoritative current identity generate a new decision key and audit event;
retries of that same attempt remain idempotent. Actor/business/transaction/amount/
direction/date/Plaid account/source QBO mapping/selected account/environment/realm
are bound. The installed approval adapter validates the epoch and identity under
its bank/categorization locks before the old event replay shortcut. No event is
deleted or rewritten, and no deliberately incorrect intermediate category is needed.
Check the new event and identity and rerun canonical preflight before resuming.
These production approval actions have NOT been performed here.

Actual split lifecycle: the captured CHECK permits only `confirmed`, `posted`, and
`voided`; `draft` INSERT is rejected. Frontend draft edits remain local. The new
trigger snapshots exact material and confirming authority on direct confirmed
insertion or an actual non-confirmed → confirmed transition, strips premature
snapshots on unconfirmed insertion, and refuses confirmed material/authority edits.
Legacy confirmed rows lacking `approved_material` are validated against their
persisted confirmation and balanced lines before binding; binding pins current
material without inventing a historical approval. Active posting claims remain fenced.

## Exact later deployment sequence — not executed

1. Operator pauses/drains ALL posting writers/workers, scheduling/RPE and financial
   mutation requests. Let in-flight provider responses persist safely before
   freezing receipt writers; require no unexplained active leases or ambiguous
   receipts. Capture baseline function metadata and the fresh ledger. Reads may
   continue. This agent does not pause/resume anything.
2. Verify target identity, reviewed payload hashes and the exact single-file plan.
   A separately authorized operator applies ONLY the isolated canonical migration
   through the normal migration mechanism. Never run the main chain or change
   existing ledger rows. No production apply command is supplied by this planner.
3. Run `verify.sql`, compare baseline attributes and retained fences, confirm the
   one new ledger row and schema reload. On any error, retain the writer drain.
4. Deploy the compatible backend and posting-worker code, with workers still
   paused; confirm no old process remains eligible to write.
5. Deploy the frontend and verify that persisted schedules and split summaries
   render correctly in customer Books and verified business-scoped Admin View.
6. Inspect `scheduled-preflight.sql` and `legacy-records.sql`; perform only separately
   authorized supported approval/binding repairs. Require genuinely new income
   evidence, unchanged split deadlines and correct refund/transfer/income treatment.
   Require all current identity and non-rescheduling checks above before proceeding.
7. Smoke-test customer and verified Admin View authorization, scope, previews,
   status, Undo/Exclude/matching boundaries and failure containment using approved
   canaries. Live provider writes need their own explicit operational approval;
   no live posting is performed as part of this package preparation.
8. Operator resumes workers ONLY after every database, evidence, scope and smoke
   check passes. Retain all existing scheduling, idempotency and execution guards.

Abort for stale/unknown ledger, target mismatch, missing prerequisites or owner
privileges, unexpected CLI version/flags/files, changed hashes, plan expansion,
SQL/lock errors, unknown adapter body, altered grants/owners/settings/fences,
missing/false verification rows, unresolved scheduled preflight, ambiguous provider
receipt, unproven income renewal, overdue split binding that changes its deadline,
or failed customer/Admin View isolation. Never broaden privileges or waive a
blocker merely to complete the release.

## Recorded local results — 2026-11-23

- Focused application suite: **77/77 passed**.
- Additional refund/automatic posting/split/Admin View regressions: **164/167 passed**.
  Three source-text assertions also fail against HEAD: ForecastEditorChart readOnly
  expression, auto-post scope-copy headline, and worker bank-select field adjacency.
  These unrelated existing assertions were not weakened to claim a clean broad suite.
- Focused real PostgreSQL: **37/37 passed**, including real concurrent intent claims.
- Existing exclusion/stale-pending PostgreSQL: **50/50 passed**.
- Captured non-superuser schema compatibility/atomic rollback/verification: **5/5 passed**.
- Runner/parser and existing runner checks: **11/11 passed**.
- Exact CLI **2.122.1**, read-only localhost seven-ledger plan: **1/1 passed**;
  only `20261123230000_canonical_posting_shape_authority.sql`, no DDL or ledger change.
- Frontend build and diff checks passed. Targeted service/runner/test lint passed.
  Admin MonthlyReviewConsole has the same **11 lint errors and 5 warnings** as HEAD;
  this correction adds labels only and does not fix unrelated console lint debt.
- No linked plan, production access, provider call, production RPE action, deploy,
  worker change, commit or push occurred. RPE tests use synthetic disposable local data.

Migration SHA-256:
`e7bd150341308e587db080e5f30dc956d181c66696802e180c34a96e2484f079`.

The linked-plan gate stays `linked_planning_authorized: false`. Package source,
SQL reports, historical markers and migration hashes are regenerated together.
The release stays **HOLD** under the operator's instruction, regardless of local
validation. Before any later rollout, obtain fresh production status/ledger evidence,
separate release authorization and successful database/evidence/scope gates.
