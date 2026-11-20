# Stale Pending account scope and Admin View status correction

Local changes only; production inspection was GET-only. No provider invocation,
resolution, data repair, migration application, history repair or deployment.
The three installed stale-Pending migrations are preserved; this correction is a
new forward SQL-function migration, not a rewrite of applied history.

## Production evidence and exact root cause

Business: cffc2183-e77c-4148-a206-d5192e090925.
Failing bank transaction: 26351efb-1a46-41c2-98b8-417690b15955.
Existing provider account record: 1162bcdc-6e09-42d8-803d-5c3f898bf356.

The bank row and its exact business/Item/environment/provider-account match both
have physical_account_id=NULL. They have matching durable provider identifiers,
production environment and active account/Item records. The account has no relink
ambiguity/candidate IDs. No physical-account or confirmed lineage record maps
this provider account; the business's one existing physical identity belongs to a
different provider account and is never borrowed by business or display name.

The service calls resolve_stale_pending_admin with the canonical bank UUID. The
RPC SELECTs the bank row directly, then rejects a.physical_account_id IS NULL.
This is not a route DTO omission or a wrong property name. The original SQL
mistakenly made an optional physical/relink assignment the only acceptable scope,
even though the existing provider-account row supplies durable exact identity.

The failing row remains provider pending=true, unresolved, active, with updated_at
2026-11-09T05:49:35.023007Z. No resolution event or categorization row exists for
it. The error occurs before resolution DML; PostgreSQL aborts the RPC transaction.
The local regression reproduces the error and proves bank/GL/audit are unchanged.
No production mutation was attempted to obtain this evidence.

The live row is a valid legacy provider-linked row, not an orphan or malformed
account relationship. Its absent physical assignment is not backfilled.

## Narrow correction

20261120220000_stale_pending_durable_account_scope.sql adds one private identity
helper and guarded adapters to existing functions. It creates no columns/tables,
physical identities, account links or repair rows. It derives scope from an exact
unique provider-account record plus business, environment and Item. An existing
verified physical link or explicit confirmed lineage is reused where available;
otherwise the durable provider-account UUID supplies scope. Conflicts, unknown
relationships, pending replacement-account candidates and ambiguous links hold.

Ingestion, candidates, resolution, aliasing and phase checks share this identity.
Existing physical/provider advisory namespaces are retained. Provider relationships
are held FOR SHARE NOWAIT after the account fence and the derived key is rechecked;
known-aborted lock conflicts use existing bounded retry behavior. Confirmation
captures scope evidence; changed scope blocks later release/scheduling/posting.
Completed idempotent replays still return their persisted result before mutable
eligibility checks. Suggestions, provider truth, statement attestation, seven-day
age, manual GL approval and all existing accounting/duplicate guards remain.

Both UI routes continue to use the same service/RPC and bank UUID; account IDs are
never accepted from the client as authority. The shared context query now includes
the provider-account record ID and filters account lookup by business, environment,
Item and provider account.

The four customer status errors are explained by useOnboardingStatus calling the
customer-only /api/onboarding/status endpoint from multiple mounts/events. It
passed Admin View options to a loader that ignored them. The hook now suppresses
fetch/refresh while Admin View is active/loading and discards obsolete responses.
Normal customers still fetch canonical status. Backend requireAuth and chat
restrictions are unchanged; permitted admin billing/integration reads remain.

## Validation

- PostgreSQL reproduces the old 409 without mutation, then exercises legacy and
  physical-linked derivation, ambiguity/wrong-Item denial, manual category/release,
  scheduling, posting, duplicate holds, later settlement/aliasing and concurrency.
- Existing rollback/containment, recent-row, customer, receipt, matched/excluded,
  archived/removed, idempotency and physical-account lifecycle tests remain.
- UI tests mount four consumers in active Admin View, refresh/event them and prove
  zero customer-only status calls; normal customer calls resume after leaving.
- Both admin surfaces use the same canonical transaction/provider context; direct
  customer/owner calls remain forbidden by unchanged authorization tests.
- Full persistence keeps the separately documented pre-existing cohort test
  failing; no cohort schema is restored to conceal that unrelated condition.

Final checks: 39 PostgreSQL lifecycle/scope checks passed; 38 focused UI/security/
contract checks passed. Full persistence: 30 subtests passed, one unchanged cohort
subtest failed (and therefore its parent failed). All permission, settlement,
identity and PostgREST checks passed. The local five-ledger-record CLI dry-run
planned exactly 20261120220000 and executed no migration. Build passed with the
existing large-chunk warning; targeted ESLint and git diff --check passed.

## Deployment sequence — proposed only

1. Review/authorize this new forward migration and application patch. Rerun local
   checks and prepare with node scripts/prepareStalePendingScopeFixRunner.js.
2. Verify production target, all five existing ledger entries, new timestamp unused,
   installed function definitions matching adapter contracts, locks/leases, DDL
   authority and the approved scoped writer/request drain. Do not stop unrelated
   customer-facing services. Use the drain mechanism approved for the successful
   prior rollout; this task does not create or invoke a production drain control.
3. Link only /private/tmp/bizzi-stale-pending-scope-fix to the approved project.
   Run its dry-run; abort unless exactly 20261120220000 is listed. Never deploy from
   the main migration directory or use history repair/historical replay.
4. Under separate authorization apply only that migration from the follow-up
   runner. Unknown function text or any failure aborts its transaction. Verify
   helper ACL, adapters, ledger entry and PostgREST reload before resuming writes.
5. Deploy the reviewed backend/shared-service patch to every backend/worker process
   and verify old processes retire; then deploy the frontend onboarding-hook patch.
   Maintain the approved drain until verification completes. No flag activation.
6. Read-only smoke: both admin evidence routes, account-scope eligibility, ordinary
   feeds and direct-customer 403; inspect worker health. No real resolution canary
   is part of this task. Resume writers in the existing approved controlled order.
7. If containment is needed after resolutions, keep the account/alias guards and
   use the existing financial-containment procedure. Do not restore physical-only
   predicates after legacy provider-scope operations have been used.

Local preparation and later separately authorized CLI commands:

    node scripts/prepareStalePendingScopeFixRunner.js
    node_modules/.bin/supabase link --project-ref zwufvvrmjbymgyjntdzk --workdir /private/tmp/bizzi-stale-pending-scope-fix
    node_modules/.bin/supabase db push --dry-run --linked --workdir /private/tmp/bizzi-stale-pending-scope-fix
    # Apply only after preflight, drain, exact one-file plan and separate authorization.
    node_modules/.bin/supabase db push --linked --workdir /private/tmp/bizzi-stale-pending-scope-fix

## Limits and risks

The guarded DDL adapters require the installed definitions to match reviewed text;
formatting/contract drift fails closed. New account-map contention can return a
retryable NOWAIT error. Changed or ambiguous account mapping deliberately holds
posting and requires review. Production eligibility can still be blocked by real
replacement/receipt/intent evidence; no live confirmation was used to bypass it.
Existing vehicle-lock contention and the unrelated cohort-schema follow-up remain.
