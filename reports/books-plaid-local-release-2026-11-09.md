# Immutable local Books/Plaid release

This manifest identifies the complete four-phase implementation in the release commit's tree. It records local source-control preparation, not deployment approval. No push, production access, remote migration, service/configuration change, live Plaid token/reconnect/synchronization, processing/posting worker or QBO call occurred during release preparation. Database tests use disposable local PostgreSQL/PostgREST and injected synthetic providers.

## Commit boundary

Parent: `b2cac95c65f32250bb96ffc979a4d73e2cbc5fcb`.

The first three phases were already committed in `2f48f42`, with the managed-role correction in `b2cac95`. This release adds the pending Discover reconnect changes and this manifest in one new ordinary commit. Earlier commits and unrelated committed history are not rewritten or squashed. All four migrations and all phase-owned files below are present in the new commit's tree, including files already inherited unchanged from its parent. The new commit SHA is returned after creation; embedding its own SHA here would change that SHA.

No unrelated working-tree change is included. The dirty `.claude/worktrees/elated-black-b3db40` worktree and its three modified files remain outside this commit. Ignored environment files, local connection metadata, node_modules, generated dist output and temporary test logs are excluded.

## Exact files changed by the new commit

- `reports/books-plaid-discover-reconnect-2026-11-09.md`
- `reports/books-plaid-local-release-2026-11-09.md`
- `src/api/integrations/plaid.routes.js`
- `src/pages/Settings/SettingsHome.jsx`
- `src/services/plaid/plaidAccountRecoveryStatus.js`
- `src/services/plaid/plaidIntegrationService.js`
- `src/services/plaid/plaidReconnectService.js`
- `src/services/plaid/plaidReplacementRecoveryService.js`
- `src/services/plaid/plaidSyncService.js`
- `supabase/migrations/20261109230000_plaid_reconnect_shared_recovery.sql`
- `tests/integration/plaidPersistence.database.test.js`
- `tests/plaidReconnect.test.js`
- `tests/plaidReplacementCardRecovery.test.js`
- `tests/plaidSyncCategorizationPersistence.test.js`

## Complete four-phase implementation inventory

The following **28 phase-owned files** are included in the release tree; this release manifest is an additional file. Files inherited unchanged from earlier commits do not appear again in the new commit's delta.

- `reports/books-plaid-discover-reconnect-2026-11-09.md`
- `reports/books-plaid-local-repair-2026-11-09.md`
- `reports/books-plaid-recovery-status-and-residual-repair-2026-11-09.md`
- `reports/books-plaid-residual-reconciliation-2026-11-09.md`
- `src/api/bookkeeping/routes/bookkeeping.accounts.routes.js`
- `src/api/integrations/plaid.routes.js`
- `src/api/integrations/plaidResidualReconciliation.controller.js`
- `src/pages/Settings/SettingsHome.jsx`
- `src/services/plaid/plaidAccountRecoveryStatus.js`
- `src/services/plaid/plaidIntegrationService.js`
- `src/services/plaid/plaidReconnectService.js`
- `src/services/plaid/plaidRecoveryContract.js`
- `src/services/plaid/plaidReplacementRecoveryService.js`
- `src/services/plaid/plaidResidualReconciliationService.js`
- `src/services/plaid/plaidResidualRecoveryService.js`
- `src/services/plaid/plaidSyncPersistence.js`
- `src/services/plaid/plaidSyncService.js`
- `supabase/migrations/20261109173000_plaid_durable_sync_admission.sql`
- `supabase/migrations/20261109190000_plaid_account_recovery_observability.sql`
- `supabase/migrations/20261109210000_plaid_residual_reconciliation.sql`
- `supabase/migrations/20261109230000_plaid_reconnect_shared_recovery.sql`
- `tests/backgroundBookkeepingProcessing.test.js`
- `tests/integration/plaidPersistence.database.test.js`
- `tests/plaidCanonicalization.test.js`
- `tests/plaidReconnect.test.js`
- `tests/plaidReplacementCardRecovery.test.js`
- `tests/plaidResidualReconciliationContract.test.js`
- `tests/plaidSyncCategorizationPersistence.test.js`

The existing production audit Markdown/JSON in ancestry are contextual evidence, not new release changes. The unchanged account-connection-state test is also exercised by the focused command as a compatibility dependency.

## Exact migration order and SHA-256

| Order | Migration | SHA-256 |
|---|---|---|
| 1 | `20261109173000_plaid_durable_sync_admission.sql` | `dc248f095ec48e08da8e191ad1f23eb27bac422916eae7b00f65da99d707bbb7` |
| 2 | `20261109190000_plaid_account_recovery_observability.sql` | `50c07e32ba4089b923309276919709b5cd15f0037819c2de5fff7099eded151a` |
| 3 | `20261109210000_plaid_residual_reconciliation.sql` | `2cb8cb8fe13f76a427b1c58edc4a9900c43068bd2eeccb3eb5c8f94b677c6d8e` |
| 4 | `20261109230000_plaid_reconnect_shared_recovery.sql` | `c589b059f9ce41543f4b4a9d486972e8abdc713af9d87d8108c36e30966440eb` |

The database harness reads each exact file once in the order shown. Before and after validation, file hashes are checked against these values. The corrected residual migration does not regrant ADMIN to its creator; helper ACL cleanup precedes relinquishing temporary SET/INHERIT access. The non-superuser regression reproduces the original grant failure and verifies the corrected ownership/privilege sequence. No remote schema is certified by this local check.

## Validation for this release

- Disposable database suite: **29/29 passed**, approximately 69 seconds.
- Focused regressions: **95/95 passed**.
- ESLint on all **20 phase-owned JavaScript/JSX/test files**: passed.
- Production build: passed, with the existing bundle-size warning.
- Working/staged diff checks, path allowlist, sensitive-data review and post-commit tree verification are release gates.

Commands:

`node --test tests/integration/plaidPersistence.database.test.js`

`SUPABASE_URL=http://127.0.0.1:1 SUPABASE_SERVICE_ROLE_KEY=synthetic NODE_ENV=test node --test tests/plaidSyncCategorizationPersistence.test.js tests/plaidCanonicalization.test.js tests/plaidReplacementCardRecovery.test.js tests/plaidAccountConnectionStateContract.test.js tests/backgroundBookkeepingProcessing.test.js tests/plaidResidualReconciliationContract.test.js tests/plaidReconnect.test.js`

`node_modules/.bin/eslint` with the complete phase-owned JavaScript/JSX/test list above; `npm run build`; `git diff --check`; `git diff --cached --check`.

The database suite contains 28 scenarios plus its parent, yielding **29 tests**. It includes persistence rollback and partial commits; durable admission/idempotency; scoped identities; retained cursor/checkpoints; residual recovery; reviewed exact hold release; role isolation; historical Chase preservation; Discover reauthentication and changed/new identity stops; historical gap recovery and overlap protection; and cohorts over 1,000 rows. External fetches are blocked. No bookkeeping/posting worker is started.

Only changed-file lint is a release gate in this task. The earlier full-repository lint result remains 1,877 existing findings; no unrelated lint fixes were attempted.

## Sensitive-data and preservation review

All candidate changes and the full phase-owned files are scanned for literal local credential values, private keys, real Plaid access-token shapes and secret-token patterns. Staged file contents and the staged diff are reviewed again before commit. Tests contain deliberately synthetic credentials, cursors, merchant labels and provider events; these are not live provider or transaction data. Runtime variable references and redaction tests are retained.

No environment/configuration file, generated bundle, dependency directory, test log, database dump or temporary artifact is staged. Previously committed implementation files retain their exact contents except for the explicit pending reconnect changes. The unrelated worktree's HEAD, status and diff fingerprint are checked again after commit.

## Deployment remains separately blocked

This commit supplies an immutable local release identity. It does not resolve the earlier production preflight's missing migration-ledger/catalog/role/backup verification, Railway replica and maintenance-setting inventory, or complete interactive/manual posting freeze. No deployment, recovery execution, queue release or external posting is authorized by this commit.
