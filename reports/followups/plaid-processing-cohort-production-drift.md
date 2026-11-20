# Follow-up: production Plaid cohort progress/immutability drift

Status: open, separate from the three stale-Pending migrations. No external issue
or production repair was created. Catalog evidence is stored under
`tests/fixtures/stalePendingProduction/catalog.json`, captured 2026-11-19 17:26 UTC.

Production has no `protect_plaid_processing_cohort()` or
`record_plaid_processing_outcome()` and no corresponding triggers. The original
full persistence test, `processing cohort persists atomically, reports exact run
outcomes and is immutable`, remains unchanged and fails when progress returns no
cohort run. No missing object is restored or bundled into the release fixture.

Scope disposition: not a stale-Pending release prerequisite. Neither the three
release SQL files nor their 88-function captured dependency closure reference
these absent functions. The complete statement-confirmation, manual-category
release, scheduling, posting, alias/settlement, rollback and concurrency scenarios
execute successfully with them absent. Ordinary bank persistence and the four
operator-reconciliation permission regressions also pass with them absent.

The gap affects the separate progress/outcome/immutability contract. This does
not assert that the broader production workflow is healthy. Investigate the
schema/application contract and migration-history drift as a separate project;
choose a forward change only after explicit authorization and its own validation.

Reproduce without changing the test:
`node --test tests/integration/plaidPersistence.database.test.js`

Expected current production-shaped result: one failing subtest (plus its failing
parent), classified as this known pre-existing condition. Do not weaken the
assertion, add a hidden skip, or install historical cohort SQL to obtain green.
