# Isolated pending-summary release — PREPARATION ONLY

Project: `zwufvvrmjbymgyjntdzk`. Supabase CLI: **2.122.1**.
Isolated directory: `/private/tmp/bizzi-monthly-pending-summary`.
Only pending payload: `20261124010000_bound_monthly_pending_summary_candidates.sql`.
SHA-256: `0d7ae4b1ec7c93a0d0953bb68bd9aeaea8126c7d5e333c49800d8425a532f1ae`.

The nine historical versions are operator-attested through `20261124000000`.
Their files are comment-only ledger markers, NOT historical migration SQL. Never
bootstrap, reset or replay this directory. No fresh production connection was made
for packaging. The receipt timestamp is not a remote SQL capture timestamp.
Linked planning remains unauthorized and is disabled in the manifest.

From the repository root:

```sh
node scripts/monthlyPendingSummaryRelease.js prepare --output /private/tmp/bizzi-monthly-pending-summary
node scripts/monthlyPendingSummaryRelease.js verify --workdir /private/tmp/bizzi-monthly-pending-summary
```

Do not use the repository migration tree, an unpinned CLI, `--include-all`, repair,
pull, reset, or an apply command. This wrapper exposes only local prepare/verify.
No linked dry run or application is authorized by this package.

Before any separately authorized application, obtain a fresh read-only ledger
export and compare all nine versions/names with `ledger.json`. Run
`operations/capture-properties.sql` read-only and retain its single JSON object.
Missing baseline or unexpected ledger/function body means stop. The migration
itself aborts atomically on an unknown function body or changed function properties.

After separately authorized application, run the supplied verification file using
an existing secure read-only connection, with the pre-application metadata JSON:

```sh
psql "$BIZZI_READ_ONLY_DB_URL" -X -v ON_ERROR_STOP=1 \
  -v expected_properties="$BIZZI_PENDING_SUMMARY_BASELINE_JSON" \
  -f /private/tmp/bizzi-monthly-pending-summary/operations/verify.sql
```

Set these variables securely outside chat; do not put credentials in repository
files or logs. The baseline contains function metadata, not credentials. The SQL
uses a READ ONLY transaction and a session-local timeout capped at eight seconds
(or a stricter existing timeout), then rolls back. It changes no persistent
configuration or data. All checks must be true; any missing row, mismatch or
timeout is a failed verification. Population counts may legitimately change from
the diagnostic snapshot; verify their scope and contract, not historical totals.

No providers, approval actions, RPE operations, worker changes, application,
deployment, commit or push are part of preparation or verification.
