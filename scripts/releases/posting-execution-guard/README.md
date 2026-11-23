# Posting execution guard forward correction — LOCAL ONLY

Pending migration: `20261124000000_restore_posting_execution_taxonomy_guard.sql`.
Project: `zwufvvrmjbymgyjntdzk`. CLI: exactly `2.122.1`.

Changes one branch of the installed `auto_post_technical_block` definition:
empty taxonomy and `split_transaction` retain canonical validation; other
workflows require a worker context, recognized direction, and taxonomy exactly
`loan_payment`, `statement_credit`, or `cc_payment`. Null directions fail closed.
All remaining installed safeguards and function properties are preserved.
Unknown prerequisite/body contracts abort atomically. No backfill or new policy.

The operator-confirmed ledger contains eight applied versions. Its local receipt
time is not an independently captured production SQL timestamp. Historical files
are comment-only ledger markers, never a schema bootstrap. Only the new file is
pending. The earlier canonical migration is already applied and must not be replayed.

Local preparation and verification (from repository root):

```sh
node scripts/postingExecutionGuardRelease.js prepare --output /private/tmp/bizzi-posting-execution-guard
node scripts/postingExecutionGuardRelease.js verify --workdir /private/tmp/bizzi-posting-execution-guard
```

Later review against a disposable localhost database containing those eight ledger
rows, with database `default_transaction_read_only=on` and no production URL:

```sh
node scripts/postingExecutionGuardRelease.js plan --workdir /private/tmp/bizzi-posting-execution-guard --local-db-url "$LOCAL_READ_ONLY_DB_URL"
```

A later separately authorized linked planning command would be:

```sh
node scripts/postingExecutionGuardRelease.js plan --workdir /private/tmp/bizzi-posting-execution-guard --link-from /private/tmp/bizzi-handled-exclusion
```

DO NOT run that linked command now. It requires freshly reviewed ledger evidence,
explicit linked planning authorization in the package, existing securely configured
`SUPABASE_DB_PASSWORD`, and `BIZZI_CANONICAL_READ_ONLY_PLANNING=1`. Never paste secrets
into chat or command arguments. Current `linked_planning_authorized=false` stays in
force. No planner mode can apply, link, repair, reset, pull or change remote history.
Any extra migration, source/hash/config change, wrong project/version, stale ledger,
missing credential/read-only attestation, or unknown SQL contract aborts. Never use
the main migration chain, `--include-all`, or historical replay. No production action,
provider call, RPE repair, worker change, commit, push or deployment is authorized.

## Local validation

Migration SHA-256: `ec53709d44550eae8f1c68e11c6aa65dc8fa7ede782ca012b7b4fa690e57e82c`.

- Canonical PostgreSQL, including four new execution-guard regressions: 41 passed.
- Captured-schema compatibility, security-property preservation, injected-failure
  rollback, unknown-contract rejection and idempotence: 6 passed.
- Existing exclusion and stale-pending PostgreSQL suites: 50 passed.
- Dedicated-workflow/canonical/approval/split application tests: 83 passed.
- Runner/parser checks, including existing runner regressions: 14 passed.
- Actual CLI 2.122.1 read-only localhost plan: 1 passed; eight recorded markers,
  only the new forward migration pending; no local DDL or ledger writes by planning.
- Frontend build, targeted lint and diff checks passed.

No existing migration or application runtime JavaScript was edited. Commit
`fc97560` remains unchanged. Only disposable local test fixtures were exercised;
no production connection, linked plan, operational RPE action or provider call,
commit, push, deployment or worker resumption occurred.
