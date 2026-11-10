# Local Plaid status UI refinement

Local frontend presentation only. No production access, provider calls, configuration changes, migrations, recovery execution, hold release, deployment, push or commit occurred. The unrelated dirty `.claude/worktrees/elated-black-b3db40` was preserved.

## Exact changed files

- `src/utils/plaidStatusView.js`
- `src/components/Plaid/PlaidStatusSummary.jsx`
- `src/components/Plaid/RecoveryHistoryRow.jsx`
- `src/components/Plaid/DisconnectConfirmation.jsx`
- `src/pages/Settings/SettingsHome.jsx`
- `src/pages/accounting/BookkeepingCleanup.jsx`
- `tests/plaidStatusView.test.js`
- `tests/plaidStatusComponents.test.js`
- `tests/plaidReplacementCardRecovery.test.js`
- `tests/plaidSyncCategorizationPersistence.test.js`
- `reports/books-plaid-status-ui-refinement-2026-11-10.md`

## Contract and classification

No API contract or backend behavior changed. The shared pure view helper consumes existing authenticated `recovery_status`, `sync_health`, recovery batch/orchestration, mapping blockers and connection enums. It does not infer health from timestamps, names or transaction volume.

Primary counts deduplicate by institution ID, falling back to Item ID. Attention outranks recovery, temporary unavailability and health across an institution's Items/accounts; normalized disconnection remains explicit per entity. Reauthentication, account identity/lineage review, failed/blocked import or recovery, held imported recovery awaiting review, and explicit missing mapping require attention. In-progress recovery is separate, including when a broad recovery_required flag remains true. Explicit automatic retry is not attention unless an explicit user-action blocker overrides it. Delayed/unavailable states do not claim a durable retry appointment. Missing evidence stays unavailable; missing identifiers fall back to the API's institution/account totals when available. Loading/error text never shows a fabricated zero.

Posting is independently derived from QuickBooks hold/blocker evidence and auto-post policy. A known positive hold count takes precedence over auto-post-off wording. Absent hold evidence produces no no-hold claim. Unknown policy stays unknown; effective dates are not borrowed from bank-sync timestamps.

## UI changes

Settings replaces static connected totals with state counts, removes the blanket green integration badge, shrinks healthy sync detail, omits unavailable import dates and removes repeated disconnect/hold boilerplate. Institution reconnect stays the primary existing update-mode action. Account rows suppress inherited attention while retaining explicit identity, account-connection, coverage and mapping problems. An all-attention institution list is no longer mistaken for an empty/disconnected integration.

Only released completed recovery collapses into a compact history row with count/date/disposition and the existing local details toggle. Held imported recovery remains prominent. Details do not initiate provider requests. Counts/dates absent from the contract are omitted rather than invented.

Books consumes the same sync helper and shows actual QuickBooks posting policy/holds instead of “Active books start not set.” Auto-post policy initially remains unknown until fetched. Neither sync/recovery/processing nor posting semantics changed.

Disconnect remains the existing operation, presented as secondary and gated by a named Headless UI confirmation dialog. It states synchronization stops, history/categorizations remain and reconnect is the normal reauthentication path. Headless UI supplies modal keyboard/focus handling; account cancellation/success additionally restores focus to its persistent account row. Rows wrap on narrow screens and long names can wrap.

## Validation

- 26 new focused tests: 19 pure-view cases and 7 component/integration-wiring cases.
- 95 existing reconnect, recovery, persistence, account-state and background-processing regressions retained and passing.
- Total: **121/121 passed**, with synthetic environment configuration and no live provider calls.
- Changed-file ESLint: passed.
- Production build: passed; existing large-chunk warning remains.
- `git diff --check`: passed.

Component tests compile actual shared JSX and the actual Books AccountCard. Existing source assertions were updated to follow extracted history/status components and requested wording changes; persistence, cursor, admission and identity protections were retained. No database tests are needed for this frontend-only change; no migrations changed.

Remaining UX validation: a real-browser narrow-screen and keyboard/focus smoke test was not performed. The helper uses “temporarily unavailable” rather than claiming an automatic retry appointment where the contract cannot prove one. No further product decision is required for the implemented local defaults.
