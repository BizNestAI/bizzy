# Local residual reconciliation and reviewed hold release

Implemented on top of the existing retained-cursor replay, atomic admission and residual-repair workflow. No production access, remote migration, actual customer replay/recovery, worker start, live Plaid/QBO request, deployment or production hold change occurred. All execution evidence below comes from synthetic data in disposable PostgreSQL/PostgREST containers.

## Files changed in this phase

- `supabase/migrations/20261109210000_plaid_residual_reconciliation.sql`: operator scope validation; current evidence classification; expiring reconciliation manifests; exact reviewed release; private hold executor; guarded trigger updates; account status counts including archived holds.
- `src/services/plaid/plaidResidualReconciliationService.js`: preview by default, explicit release parameters, sanitized errors and safe changed-evidence IDs.
- `src/api/integrations/plaidResidualReconciliation.controller.js`: binds actor/business to verified request context and account/batch to the route. Body identity fields are ignored.
- `src/api/integrations/plaid.routes.js`: internal-staff-only reconciliation endpoint; existing customer residual admission remains separate.
- `src/services/plaid/plaidRecoveryContract.js`: shared classification names, five-minute reconciliation TTL and bounded configurable import freshness (default 26 hours).
- `src/services/plaid/plaidAccountRecoveryStatus.js`: customer missing-request counts use the required subset; exposes last checked; residual holds retain status precedence/counts through partial release without exposing attestations.
- `tests/integration/plaidPersistence.database.test.js`: expands the existing production-shaped ephemeral database fixture and lifecycle tests. Removes its blanket function grant so private-helper permissions are genuinely tested.
- `tests/plaidResidualReconciliationContract.test.js`: configuration, customer counts, literal execute/default preview and error redaction contracts.

Previous repair files/reports and unrelated working-tree edits are preserved. No Books UI release action was added.

## Endpoint and RPC contract

`POST /api/integrations/plaid/accounts/:plaidAccountId/residual-recovery/:batchId/reconciliation`

The route requires authenticated tenant context, the existing mutation rate limiter and active internal staff authorization (`operator`, `accountant` or `owner_admin`). Ordinary business owners/integration admins without internal staff membership cannot use it. Business and actor come from verified `req.business`, `req.auth` and `req.internalStaff`, never body fields. Existing read-only admin-view sessions are not elevated or added to mutation allowlists; the operator must have an already authorized tenant context.

Preview body: `{}`. A nonliteral execution value such as `"true"` also remains preview. Preview performs no financial/admission mutation; it records or reuses an evidence manifest in the existing residual batch summary.

Explicit confirmation body:

```json
{
  "execute": true,
  "manifest_id": "<preview UUID>",
  "reviewed_transaction_ids": ["<exact reviewed UUID>"] ,
  "live_qbo_attestation": {
    "performed": true,
    "ledger": "quickbooks_live",
    "outcome": "no_unrepresented_duplicate",
    "reviewed_at": "<timestamp after this preview was created>"
  }
}
```

There is no release-all default. Every selected row must be currently releasable; including a blocked row rejects the entire confirmation. To release a safe subset, explicitly select that subset. Rows not selected remain held.

Public backend RPCs (both service-role only):

- `preview_plaid_residual_reconciliation(p_business_id, p_plaid_env, p_account_id, p_batch_id, p_actor_id)`
- `release_plaid_residual_reconciliation(p_business_id, p_plaid_env, p_account_id, p_batch_id, p_actor_id, p_manifest_id, p_reviewed_ids, p_attestation, p_execute default false)`

Direct release RPC calls without literal execution also default to preview. Scope/classification/snapshot helpers are not browser authorities. The narrowly privileged hold-clear helper is **not executable by service_role**; only the vetted outer RPC's database owner can invoke it.

Preview returns manifest ID, actor/business/environment/account/batch, creation/expiry timestamps and `before` with row/held/releasable counts, retained classification counts, safe transaction UUIDs and evidence hashes. Repeated unchanged previews by the same operator reuse the unexpired manifest. Release returns exact released IDs, actor, timestamp, batch/manifest identity, before/after counts and rows, `newly_released_count` and idempotency. An identical repeated confirmation returns the stored audit result with `idempotent=true` and zero newly released rows. A changed selection or attestation cannot reuse a consumed confirmation; obtain another preview.

## Reconciliation classifications

All rows in the successfully admitted residual manifest are inspected, including removed/archived bank rows and rows released by an earlier reviewed confirmation.

| Classification | Treatment |
|---|---|
| `categorization_processing` | Pending/failed ordinary processing has not settled; retain hold. |
| `categorization_lease_active` | Processing lease is within the existing ten-minute lease window; retain. |
| `categorization_lease_stale` | Processing is stale/unverified; retain and resolve through the existing processing workflow. |
| `unresolved_dead_letter` | Retain; this workflow never resets or edits dead letters. |
| `needs_user_review` | Retain until the existing review workflow records a completed decision. A user marker/timestamp alone is insufficient if review remains reopened/unhandled. |
| `excluded_or_personal` | Already represented by a terminal exclusion/personal decision; explicit reviewed cleanup may remove the hold without changing the decision. |
| `matched_existing_qbo` | Preserve the existing match and its evidence; reviewed cleanup cannot convert it into a new posting candidate. |
| `handled_without_posting` | No post is scheduled. Explicit reviewed release requires live-QBO attestation because it could otherwise become a later new posting candidate. |
| `existing_posted_receipt` | Preserve posted category/receipt/request identity; reviewed cleanup does not repost or reopen it. |
| `pending_qbo_receipt` | Pending/processing intent is unresolved; retain. |
| `unknown_qbo_receipt` | Ambiguous external outcome; retain until separately reconciled. |
| `failed_qbo_attempt` | Failed/ambiguous posting evidence or a conflicting posting job remains; retain. |
| `possible_qbo_duplicate` | Local duplicate indicators or ambiguous matching evidence exist; retain. |
| `protected_workflow` | Pending/removed/archived/review-flagged bank activity, existing schedule, special workflow/transfer/payment/check or other protected evidence; retain. |
| `safe_for_reviewed_release` | Categorization settled and no known blocker; selected operator review plus live-QBO attestation are still required. This is **not** a posting eligibility grant. |
| `evidence_changed` | Missing/inconsistent cohort evidence or a stale confirmation fingerprint; no release. |

Operational conflicts and uncertain receipts take precedence over terminal cleanup. A row's `held`, `releasable` and `requires_live_qbo_attestation` fields distinguish classification from permission. Terminal states remain terminal; unheld rows are not release candidates again.

Current evidence includes bank rows, categories/review and exclusion metadata, processing requests/leases, all posting attempts, posting jobs, QBO intents/receipts, incoming-deposit matches/items/history, credit-card pairs/events and original recovery row evidence. Batch/account/Item/cursor-hash/policy evidence is also bound to the manifest. No credential, raw cursor or full provider payload is returned; full row material is hashed inside the database.

## Exact release gates

1. Active internal operator identity in both the existing authorization middleware and database staff table; verified tenant and exact environment/account/batch scope.
2. Parent batch tagged `residual_orphan`, successfully applied (`applied_at`, `applied_count`, exact cohort count) through the existing workflow, retaining its protective parent hold.
3. An operator-owned persisted manifest, bound to every scope identifier, no older than **five minutes**. The hard TTL is checked against creation as well as stored expiry.
4. Explicit execution and a nonempty, canonicalized exact reviewed ID set. No implicit all-row selection or reset.
5. Lock business, Item, account, parent manifest/cohort and relevant financial/processing/matching evidence in fixed order. Business auto-post must still be **false**; any outstanding Plaid sync lease/in-progress state blocks release.
6. Current evidence fingerprint must equal the reviewed manifest. Changed bank/category/request/lease/dead-letter/match/intent/receipt/posting-job/recovery evidence aborts with a safe `evidence_changed` response. A fresh preview is required.
7. Every selected row must remain held by that exact parent and have an allowed current classification. Blocked rows cannot be forced through by an attestation.
8. A potential new QBO posting candidate requires explicit live-ledger attestation after preview creation. Only enumerated safe fields are accepted; credentials, free-text provider payloads and extra keys are rejected. The actor and exact selected scope are stored separately from the supplied metadata. This is an authenticated operator declaration of an out-of-band live review, **not** a claim that this local task called QBO or independently verified the declaration.
9. Clear only `posting_hold_batch_id` for the approved IDs. Preserve categories/decisions, metadata and safe-auto-post flags, `post_after`, requests, leases, dead letters, bank rows, matches, posting jobs, intents and receipts. Only the existing normal category `updated_at` timestamp may also advance.
10. Recompute after-state and verify non-hold evidence is unchanged and auto-post is still disabled. Hold changes and durable audit result commit together; any unexpected side effect aborts the whole transaction.

Releasing a hold does not set a posting schedule, enable auto-post, enqueue anything, wake a worker or invoke QBO. It does not authorize a future QBO entry. Posting activation remains a separate reviewed operation.

## Trigger and privilege changes

No new tables or data backfills are introduced. Existing `plaid_recovery_batches.summary.residual_reconciliations` stores manifests, immutable confirmations, safe attestations and before/after audit results keyed by UUID. The original admission evidence remains intact. Completed manifests are retained; refreshing a stale manifest does not delete history.

The migration creates a non-login, non-inheriting `plaid_residual_hold_executor` with no elevated server privileges. It has only the read access needed for guards and column-level UPDATE permission on `transaction_categorizations.posting_hold_batch_id`, with narrow RLS policies. No browser/service role is a member. Temporary schema CREATE and role SET/INHERIT grants used for ownership transfer are removed immediately. The migration owner retains ADMIN-only role-management authority (no inherited helper privileges and no SET permission) for future reviewed migrations.

Only the private clear helper runs as this role, and service_role cannot call it directly. The hold trigger runs as invoker and requires that role **and** a manifest authorization for the exact business/batch/row in the current transaction. Ordinary SQL updates, spoofed session state and replacement-card release remain blocked. Parent residual batches keep their original protective hold flag/status even after all row holds are reconciled; current row counts and the reconciliation audit report completion.

The existing review/posting-state trigger gets one narrow early return for the privileged hold-only update. This prevents hold removal from recalculating completed review/posting decisions. Its behavior for ordinary categorization/review writes is unchanged. Existing posting-job trigger columns exclude this hold-only mutation, and tests verify no job/receipt/request or schedule changes.

The status aggregate is updated so archived rows with residual holds or unresolved receipts remain visible in held/reconciling counts. Import dates/counts remain active-transaction-only. This avoids a removed transaction silently disappearing from recovery attention.

This migration requires the preceding admission/recovery migrations, internal staff authority, posting/matching tables and sufficient migration-role privileges for creating the constrained role and transferring helper ownership. Local PostgreSQL 17 proves runtime permissions/RLS; no managed production catalog/privilege check was performed. Review those privileges before any separately authorized deployment. Apply only the explicit new migration after its predecessors; do not blanket-push repository history.

## Customer status and presentation contract

- While any residual row remains held, `quickbooks_posting` is `held` or `reconciling`, with the exact remaining held count in `affected_count` and `held_count`. Other blockers, including QBO authentication failure, remain separately visible.
- Categorization remains independent: queued/processing, review, active or failed status can change while QBO holds persist.
- Partial release reduces held counts by the exact released count. Full reviewed cleanup still shows posting held by business policy while global auto-post remains disabled; it never implies posting became active.
- Operator manifests, confirmation identity and attestation details are not included in customer-facing status.
- Import freshness defaults to **26 hours**, configurable through `PLAID_IMPORT_FRESHNESS_HOURS` within 1–168 hours; invalid values fall back to 26. The contract continues returning latest active transaction date and completed checkpoint, with `last_checked_at` as an explicit alias.
- Customer `missing.processing_admission` now uses `required_processing_admission`, not unrestricted historical missing-request counts. No heartbeat or new scheduling infrastructure was added.

## Test evidence

The existing disposable PostgreSQL 17/PostgREST harness loads the real core DDL, matching table definitions, role authorization, RLS and all relevant triggers. Synthetic worker outcomes are written through ordinary database mutations to prove categorization can settle while holds remain; no processing/posting worker is started. The injected Plaid client and attestations are synthetic, and external fetches are blocked.

Database cases cover the preceding persistence/recovery regressions plus reconciliation preview/idempotency, processing under holds, all classifications, active/stale leases/dead letters, pending/unknown/failed receipts, human review, required/restricted live-QBO attestation, expired and changing evidence, partial/exact release, held blocked/archived rows, repeated release, actor/tenant/account/batch scope, browser denial, private-helper denial, replacement-card release denial, preserved bank/category/request/job/receipt state, no auto-post/schedule changes, customer count/privacy behavior and **1,002 reviewed row releases**.

Validation results:

- Database integration: **24/24 pass** (23 scenarios plus the parent suite).
- Focused existing and new contract regressions: **90/90 pass**.
- Changed JavaScript/test ESLint: **passes**.
- Production build: **passes**, with existing bundle-size warnings.
- `git diff --check`: **passes**.

The harness no longer blanket-grants all function execution to service_role; doing so would invalidate the private-helper security test. Containers, networks and anonymous volumes are cleaned up after each run. No permanent staging environment is required.

## Remaining decisions before Discover and Books UI work

1. Discover connection repair remains separate: verify its current Item/provider condition, use Update Mode where supported, confirm identity continuity and the actual gap, then apply the existing controlled recovery safeguards. This lifecycle does not perform reconnection, history import or ledger reconciliation.
2. Decide how the operator obtains a verified tenant context in the admin experience. This phase does not turn read-only admin-view sessions into write capabilities or add a customer Books release button.
3. Build an operator preview/selection/attestation screen with five-minute expiry, changed-evidence refresh and explicit safe-subset confirmation. Clearly distinguish terminal cleanup from potential later new posting candidates.
4. Define the operational live-ledger review procedure/evidence expectations and operator responsibilities. Attestation is deliberately minimal and contains no external payload; no automatic duplicate conclusion is inferred from missing local indicators.
5. A later, separately authorized posting activation must recheck mappings, scope, protected workflows, current duplicate/receipt evidence and eligibility. This release workflow never supplies that activation.
6. Adapt Books UI to the four-dimensional status contract, required missing-admission counts and latest-transaction versus last-checked semantics. Confirm the configurable SLA and neutral tones for intentional holds/disconnections before customer rollout.

## Managed-role compatibility correction

The original migration explicitly regranted ADMIN to `postgres` twice. A managed, non-superuser role creator can receive SQLSTATE `0LP01` (“ADMIN option cannot be granted back to your own grantor”) from those statements. The earlier superuser-only fixture missed this. The corrected migration adjusts only SET/INHERIT membership options, preserving the automatically supplied creator ADMIN authority. Function ACL cleanup now occurs before temporary inherited ownership is relinquished.

An added disposable PostgreSQL test uses a non-superuser CREATEROLE login: the original ADMIN regrant reproduces the exact error; corrected grants, function ownership transfer, private ACL changes and removal of SET/INHERIT succeed. The role retains explicit helper execution without runtime role inheritance. The existing full lifecycle/privilege regression suite also runs against the corrected migration. This models the relevant managed-role behavior; it does not inspect the remote Supabase role catalog.

For an attempted SQL-editor application, inspect state before retrying: the screenshot alone cannot establish whether any earlier statements committed. In the usual all-statements-in-one-transaction execution, the error rolls back that execution. If statements were run separately, the policies may already exist. Do not drop the executor role or weaken hold guards to retry. The migration is not a general rerunnable script (its CREATE POLICY statements deliberately reject duplicates).
