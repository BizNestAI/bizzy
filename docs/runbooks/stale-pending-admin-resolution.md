# Permanent stale Pending admin resolution

## Availability and authorization

Every existing and future customer business is covered automatically. There are no feature variables, global enable switches, business allowlists, provisioning records or enabled capability responses. Availability is verified internal-admin authority plus current transaction eligibility.

Admin Monthly Review exposes `Move to Needs Review` to active internal `owner_admin` staff. Customer Books exposes the same shared action only through a verified opaque Open Bookkeeping Access session with bookkeeping write authority. Both routes recheck the same internal-staff table and call `confirmPendingSettled` / `resolve_stale_pending_admin`. The actor remains the internal staff user, never the customer being viewed. Ordinary customer tokens, including customer business owners/admins, receive 403. Customer roles, URL parameters, banners and local storage do not grant authority.

The shared control loads current evidence before showing an active action. Recent rows retain Pending with “Available after seven days”. Conflicts, ambiguous/probable replacements, archival/removal and accounting evidence suppress manual promotion; Monthly Review can open the existing replacement review. Missing eligibility checks fail closed. Success refreshes Pending/Needs Review counts and rows; Books invalidates scoped cached pages.

## Unchanged resolution lifecycle

1. An internal admin explicitly attests: “I confirmed this transaction appears as settled on the bank or card statement.” The server enforces seven-day age, statement date/amount and business/account/environment/realm scope.
2. The guarded operation preserves provider `pending=true` and raw provenance, records durable statement evidence and `statement_review_override`, and enters Needs Review. Suggestions remain suggestions. Final GL approval, scheduling authority and `post_after` are cleared.
3. A human selects/approves the category. `release_statement_pending_review` rechecks duplicate/replacement/accounting evidence and the active QBO chart/realm before recording audited `statement_review_released` and Handled. Confirmation alone cannot authorize posting.
4. The existing scheduling policy/grace period and guarded intent/worker execution control posting. Approval, scheduling and each final financial mutator retain fresh server checks.
5. A deliberate Undo revokes release and advances the review epoch. Posted receipts cannot be reopened by this path.

Same-identity provider settlement retains the canonical UUID and compatible release. A distinct unique settled counterpart becomes a source alias with no independent approval/intent/posting opportunity. Explicit lineage or compatible amount, direction, merchant identity and bounded dates are required. Ambiguous or material conflicts hold for separate reconciliation. Durable intents/receipts must record an external outcome already in flight; an external request cannot be recalled after transmission.

## Serialization and compatibility

Account keys include business, Plaid environment and physical account. Existing account/advisory serialization, sorted multi-account locks, row locks, bounded timeouts and known-aborted SQL retries remain. Permanent account fencing also covers concurrent first confirmation. Stable operation keys and persisted actor/payload-bound replay remain authoritative after later state changes.

Plaid persistence always attempts the existing serialized RPC. Only an explicitly missing-schema error permits the legacy persistence fallback; business conflicts and uncertain outcomes do not. Summary reads retain a missing-schema fallback to authoritative bounded-feed membership. These are schema-compatibility adapters, not availability switches. Missing mutation prerequisites fail closed.

## Migration evidence and handling

The user confirmed that `20261118220000_stale_pending_global_admin_availability.sql` was applied to production. It and the historical lifecycle migration remain unchanged. Repository commit history alone could not certify application status, and no production inspection was performed in this task.

A new forward migration is required: `20261118230000_stale_pending_permanent_admin_capability.sql`. It:

- Removes only availability guards from the existing resolution/manual-release routines, preserving signatures, owners, ACLs and all eligibility/accounting/audit checks.
- Makes the existing account fences unconditional, as when the former availability switch was enabled.
- Removes the obsolete capability RPC, feature predicate and business allowlist table.
- Renames the old feature table to `statement_pending_posting_containment` and removes its `enabled` column, preserving any existing financial containment hold.
- Retains the read-only accounting eligibility check for the server, and leaves audit/events, transaction states, aliases, approvals, schedules and receipts untouched.

The migration runs atomically with two-second lock and sixty-second per-statement limits, refuses unknown/missing function contracts, is safely rerunnable, and notifies PostgREST at the end. No production migration was executed for this task.

## Financial containment and rollback

Financial containment is a posting safeguard, not capability availability. The private `statement_pending_posting_containment` table does not require a row for normal operation and has no business-specific records. An existing `contained=true` hold survives migration. While held, eligible statement confirmation may still enter Needs Review, but manual financial release, scheduling and new posting boundaries remain blocked. Already-observed terminal outcomes remain recordable.

After first use, `supabase/rollback/stale_pending_containment.sql` preserves alias/receipt/audit protections and stops new financial boundaries. Do not restore old constraints over new states or remove guards to force release.

Before first use only, `supabase/rollback/stale_pending_before_use.sql` refuses any v2 use, revokes the resolution/release/serialized-write RPC permissions before removing guards, and restores installation-time function/view/constraint snapshots. Roll back incompatible applications first. Permission revocation is a rollback safeguard; there is no runtime feature toggle. The legacy-grant cleanup script retains its explicit old-process retirement attestation and no business allowlist requirement.

## Exact deployment order — instructions only

1. Under separate rollout authorization, verify the applied prerequisite ledger and installed function/ACL contracts. Do not replay already-applied migrations or use a blanket migration push across unrelated history.
2. Establish a controlled drain of mutation requests, provider-ingestion writers, categorization/matching workers and posting workers. Wait for in-flight SQL/provider leases to settle and inspect locks/unknown outcomes; do not delete or repair live work to force a drain.
3. Apply only `20261118230000_stale_pending_permanent_admin_capability.sql` atomically and record its ledger entry through the approved migration procedure.
4. Verify all five guarded routine definitions, original signatures/owners/ACLs, account fences, retained containment value, absent feature/capability/allowlist objects, audit counts, and PostgREST cache visibility. On failure, stop; transaction rollback retains the old schema.
5. Deploy Railway backend and every embedded/separate ingestion/posting worker from one reviewed release artifact. Verify every replica SHA, startup health and retirement of every old process.
6. Deploy the matching Vercel frontend and verify the production version. Old cached clients may hide the action until refreshed; no configuration activation is required.
7. Resume ordinary workflows and smoke-test reads, admin eligibility, Open Bookkeeping Access identity, and customer-owner/admin 403s. Test recent/conflict/replacement rows remain passive. Any live confirmation or posting smoke test needs separately authorized synthetic/canary selection; none is authorized or performed by this task.
8. Monitor RPC/permission errors, lock waits/timeouts, eligibility errors, queues, financial holds and canonical receipt uniqueness. Abort operator use and contain financial execution for duplicate identities, unexpected release/schedules, actor mismatches or ambiguous external outcomes. Do not revert schema protections over already-resolved rows.
9. Later, after all old callers are retired, the separately reviewed legacy-grant cleanup may run. No business enrollment or feature activation step exists.

## Changed-file inventory for permanence

Local validation: 25 PostgreSQL lifecycle/migration/rollback tests, 31 PostgreSQL/PostgREST Plaid persistence tests, 115 focused security/lifecycle regressions and 6 rendered UI/HTTP authorization tests passed. Tests cover absent former variables/configuration records, multiple/new businesses, customer 403s, unchanged manual release/scheduling/posting, preserved audits, migration failure atomicity, reruns and financial containment. Providers are synthetic stubs. Build and diff checks passed. Changed API/services/tests pass targeted lint; Monthly Review retains its identical HEAD baseline of 11 errors/5 warnings, with no new diagnostics. Build retains the existing large-chunk warning. No production, Keychain, live provider, commit, push or deployment access occurred.

- `.env.example`.
- `src/api/admin/monthlyReview.routes.js`; `src/pages/Admin/MonthlyReviewConsole.jsx`.
- `src/services/bookkeeping/statementPendingAuthority.js`, `pendingTransactionResolutionService.js`, `finalCategorizationPersistenceService.js`, `pendingResolutionCompatibility.js`.
- `src/services/plaid/plaidSyncPersistence.js`, `plaidSyncService.js`.
- New `supabase/migrations/20261118230000_stale_pending_permanent_admin_capability.sql`.
- `supabase/rollback/stale_pending_before_use.sql`, `stale_pending_containment.sql`; `supabase/manual/stale_pending_legacy_cleanup.sql`.
- `tests/stalePendingAdminSurfaces.test.js`, `stalePendingResolutionContract.test.js`; `tests/helpers/stalePendingResolutionDatabaseSchema.js`; `tests/integration/stalePendingResolution.database.test.js`, `plaidPersistence.database.test.js`.
- This runbook. The unrelated dirty `.claude` worktree was not changed.
