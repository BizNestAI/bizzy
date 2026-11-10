# Discover reconnect through shared Plaid recovery

Local implementation only. No production inspection, actual Link token, real Discover reconnect, live transaction import, worker start, Plaid/QBO network request, remote migration or deployment was performed. Provider responses and transactions in tests are synthetic; the database harness blocks external fetches.

Discover's retained `ITEM_LOGIN_REQUIRED` is a reason to offer secure Update Mode. The audit-era October 12 date is not a recovery boundary or completeness proof. Nothing here attributes the failure to the Discover/Capital One transition.

## Reuse and refactor matrix

| Component | Treatment | Reason |
|---|---|---|
| Existing Update Mode token endpoint and Settings Plaid Link | Reuse, minimal Settings result/resume changes | Existing Item access token, no new public-token exchange. Cancellation makes no completion request. |
| `inspectUpdatedItemAccounts` | Delegate to new small reconnect orchestrator | Zero new accounts now means possible successful reauthentication, not replacement recovery. |
| Normal `runSyncForItem` and atomic `complete_plaid_sync_admission` | Reuse | Retained cursor, categorization invariant and durable processing requests remain the checkpoint authority. No QBO posting calls. |
| Physical accounts, replacement candidates, lineage confirmation | Reuse and require internal operator | Masks/names/dates/amounts do not prove continuity. Explicit confirmation preserves existing physical/QBO ledger identity. |
| Recovery batches/rows, normalization, candidate classifier, population validation | Generalize in existing service | Shared reason/context and exact bounded provider history; no institution-specific stack or duplicated tables. |
| Recovery admission RPC | Extend existing implementation | New reviewed cohorts get durable ordinary requests under holds, fresh evidence checks and no cursor movement. Legacy completed data is not rewritten. |
| Reviewed reconciliation manifests, attestation, private executor and trigger guards | Generalize existing implementation | Same exact-reviewed release for residual and newly imported historical cohorts. Private helper privilege design is unchanged. |
| Residual-orphan workflow | Preserve | It still repairs already-stored missing-admission rows after qualifying replay; it never imports unseen history. |
| Four-dimensional status | Extend | Bank verification, replay, categorization and posting policy/holds remain independent. |
| Chase historical batch and UI history | Preserve saved evidence; remove shared fallback | Existing completed boundary/count/mappings remain. No new recovery infers August 27. The old one-off Chase rebuild RPC still has its recorded fixed batch/business/Item/date scope; it is compatibility support, never a generic Discover path. |

The one concrete collection incompatibility is that cursor-differential replay cannot recover an independently proven historical gap once the retained cursor has caught up. The existing recovery preview therefore gains a bounded `/transactions/get` collector. Everything after collection uses the existing normalized rows/classifier, batch structures, admission and reviewed release engine.

## Customer flow and identity branching

1. Owner requests the existing Item's Update Mode token. This creates no durable database state and never calls public-token exchange or creates another Item.
2. Closing/cancelling/expiring Link invokes no completion request. Failed provider verification also leaves durable state untouched.
3. On success, the backend verifies the retained Item ID and its current account IDs through mocked-in-tests `accountsGet`. Client metadata cannot assert identity continuity.
4. If the active provider account set is unchanged, store a verified replay marker and replay the retained cursor with the normal synchronizer. No replacement candidates, historical preview, replacement batch or QBO mapping change is created. A previously completed Chase recovery remains exactly as recorded.
5. Link completion never clears a reconnect condition. A trigger runs inside the existing durable admission transaction only after its completed sync-run write. It checks verification timing and cursor hashes, records the checkpoint and clears eligible account attention. Item-error clearing remains in normal durable admission. A failed replay retains its cursor and failed run, stays reconnect-in-progress, and can resume without opening Link again. Verified waiting replays can also use existing scheduled sync retries; no scheduler or worker was added.
6. Changed/additional/missing account identity stops ingestion and records pending candidates without resetting existing decisions. Sync lease acquisition is blocked until an operator confirms lineage through the existing recovery path. No automatic mapping or physical-account inference occurs. Later reinspection honors an already confirmed same-physical-account lineage without reopening the decision or changing retained prior-account history/mappings/state.
7. An explicit provider `ITEM_NOT_FOUND`, a returned different Item ID, malformed identity or ambiguous account evidence stops the flow for identity review. No new Item or mapping is created. `ITEM_NOT_FOUND` is treated as a conservative stop, not proof that a particular institution migration occurred. Other provider errors fail closed. A new-Item connection/lineage UX is deliberately not automated by this workflow.
8. After a successful replay, absence of independent gap evidence means finish without historical import. `replay_completed_no_proven_gap` means no proven gap, not proven completeness.

## Shared historical recovery contract

Owner Update Mode remains separate from operator recovery. Existing recovery mutation routes now require active internal staff (`operator`, `accountant`, `owner_admin`) with authorized tenant access. Read-only admin-view sessions are not elevated. Existing customer status/history reads remain available; reconciliation manifests/attestations and evidence references are stripped from customer recovery summaries/row responses.

### Existing APIs reused

- Owner: `POST /api/integrations/plaid/items/:plaidItemId/update-link-token`.
- Owner completion/resume (existing provider-sync entitlement required): `POST /api/integrations/plaid/items/:plaidItemId/repair-complete`. Actor/business come from verified request context. The response contains safe `status`, `recommended_action`, `ingestion_started`, and completed checkpoint ID where applicable; no raw cursor or access token.
- Operator identity: existing `recovery-bootstrap`, `recovery-account`, and `confirm-lineage` routes. Inner and outer lineage SQL functions check internal authority. No owner recovery elevation.
- Operator historical preview: existing `POST .../items/:plaidItemId/recovery-preview`, now accepts `recovery_context` for new previews.
- Operator admission: existing `POST .../items/:plaidItemId/recovery-batches/:batchId/admit`, with exact selected staged row IDs.
- Operator reviewed release: `POST .../accounts/:plaidAccountId/recovery-batches/:batchId/reconciliation`, an alias of the existing residual reconciliation handler/RPC. The residual URL remains compatible.
- Existing unreviewed replacement hold-release path explicitly rejects both residual and new reviewed historical cohorts. Its old compatibility behavior is retained for historical legacy batches only, behind operator authority.

Example preview body (values are operator-selected evidence, not defaults):

```json
{
  "recovery_context": {
    "reason": "reconnect_gap",
    "account_id": "<verified provider account>",
    "start_date": "<inclusive YYYY-MM-DD>",
    "end_date": "<inclusive YYYY-MM-DD>",
    "checkpoint_run_id": "<latest completed durable replay UUID>",
    "gap_evidence": {
      "kind": "statement",
      "reference_sha256": "<64 lowercase hex characters referencing reviewed evidence>"
    }
  }
}
```

Reasons: `replacement_card`, `institution_migration`, `reconnect_gap`. Evidence kinds: `statement`, `provider_history`, `operator_verified_document`. The document reference is a safe digest; it is an authenticated operator assertion of reviewed authoritative evidence, not an independently verified document upload. No full documents, credentials, provider error bodies or transaction descriptions are placed in diagnostics.

Preflight requires disabled business auto-post, no outstanding sync lease, active exact business/environment/Item/account scope, confirmed physical identity and an existing QBO mapping. Reconnect-gap context must name the latest successful durable checkpoint after completed reconnection. Replacement/institution contexts require explicit operator-confirmed lineage, whether just confirmed or already replayed. The exact calendar-valid range is at most 366 days and cannot end in the future. Collection is scoped to one account, checks pagination totals/duplicate IDs/scope, and caps the preview population at 20,000; inconsistent populations stop for a fresh preview.

The existing classifier distinguishes exact existing, locally represented posted evidence, pending-to-posted identity, historical/boundary ambiguity, probable physical-account duplicate (including manual/CSV overlap), and genuinely new candidates. Pending new events stay blocked for normal sync. Any ambiguous or duplicate staged row blocks admission. The local absence of a duplicate is never taken as QBO absence.

Preflight and staging are separate RPCs so provider I/O runs outside database transactions. Atomic staging repeats the preflight and current-evidence fingerprint; changed evidence or a new conflicting lease rejects the preview. Previews expire after five minutes; matching fresh previews are reused, stale unapplied previews are retained as abandoned audit records before replacement. Admission repeats preflight/fingerprint, validates exact row selection, preserves the retained cursor, and commits new bank rows, categorization, ordinary durable processing requests, recovery provenance and posting holds together. Exact retries reuse admission; different selections cannot reuse a consumed confirmation.

Only admitted rows join reviewed-release reconciliation; omitted staged rows remain staging evidence and are never treated as imported. New historical cohorts use `summary.workflow_kind = reviewed_recovery` plus reason/context in the same recovery structures. Residual cohorts keep `residual_orphan` and their original entry conditions.

Reviewed release has the existing five-minute manifest, unchanged evidence, exact selected releasable rows, disabled global auto-post, no sync lease, current categorization/matching/receipt protections and live-QBO review attestation for potential new posting candidates. It removes only the approved holds. It does not enable posting, set `post_after`, grant eligibility, enqueue/wake a posting worker or modify decisions/matches/requests/intents/receipts. Categorization can settle asynchronously while holds remain; tests simulate ordinary worker writes without starting a worker.

## Status contract

- `bank_connection`: reconnect-required action `reconnect_securely`; verified-but-uncheckpointed state `reconnect_in_progress` with `wait_for_replay` or `resume_reconnect`; changed identity requires `review_account_identity`; connected only after successful admission/checkpoint.
- `transaction_import`: waiting/replaying/failed/current independently; proven staged historical coverage review uses `gap_review_required` / `review_possible_gap`. Latest active transaction date and last completed checkpoint remain separate.
- `categorization_automation`: existing queued/processing/review/active/failed projection; reconnection does not reset decisions or requests.
- `quickbooks_posting`: existing policy, recovery holds and receipt reconciliation projection; successful Link/replay/release does not enable global auto-post.
- No operator attestations or document-reference hashes in customer status.
- Existing configurable 26-hour freshness, required-admission counts and residual/reconciliation protections are retained.

## Files changed

- `src/services/plaid/plaidReconnectService.js` (new): verified identity branching and normal replay orchestration.
- `src/services/plaid/plaidIntegrationService.js`: delegate inspection; injectable test token resolution; project reconnect-aware legacy Settings sync health.
- `src/services/plaid/plaidReplacementRecoveryService.js`: shared bounded collection/preview; physical identity in classifier; represented/pending classification; saved-boundary status; generic legacy-release/rebuild denial; customer summary redaction.
- `src/services/plaid/plaidSyncService.js`: permit verified waiting replay through existing scheduling, exclude unresolved identity states; select safe persisted reconnect marker internally.
- `src/services/plaid/plaidAccountRecoveryStatus.js`: independent reconnect/replay/gap action projection.
- `src/api/integrations/plaid.routes.js`: verified actor forwarding, internal operator gates, context forwarding and shared reviewed-release alias.
- `src/pages/Settings/SettingsHome.jsx`: current reconnect result/resume handling; remove shared date fallback. No new operator recovery screen or Books release action.
- `supabase/migrations/20261109230000_plaid_reconnect_shared_recovery.sql` (new): one JSONB Item marker, verification/lease/checkpoint functions/triggers, generic evidence/preflight/staging, extended existing admission/lineage/reconciliation/status functions. No new tables or automatic data repair.
- `tests/integration/plaidPersistence.database.test.js`: actual orchestration migration and account/mapping unique indexes in disposable schema; synthetic Discover/identity/gap lifecycles alongside all prior persistence/residual/release tests.
- `tests/plaidReconnect.test.js` (new): behavioral collector/classifier/status/retry tests.
- `tests/plaidReplacementCardRecovery.test.js`, `tests/plaidSyncCategorizationPersistence.test.js`: retire obsolete assertions requiring the fixed date, automatic replacement state and owner-level recovery authority.

## Schema implications and deployment order

This task applies only disposable local DDL. Any deployment is separate authorization/work:

1. Confirm the target catalog and applied migration history, including the actual account/mapping unique indexes, internal staff roles, physical identity, recovery admission/rebuild/review tables and posting protections. Do not infer target state from the prior failed SQL-editor attempt.
2. Apply missing prerequisites in their intended order. The relevant recent sequence is `20261109173000_plaid_durable_sync_admission.sql`, `20261109190000_plaid_account_recovery_observability.sql`, corrected `20261109210000_plaid_residual_reconciliation.sql`, then **`20261109230000_plaid_reconnect_shared_recovery.sql`**. Older replacement-card lineage/admission migrations are also prerequisites. Do not blanket-push repository history.
3. Apply the new migration atomically with a migration role authorized to own/replace existing functions/triggers. It adds no role grants and does not repeat the corrected ADMIN-grant problem. Check PostgREST schema reload and grants. No provider calls occur in DDL.
4. Deploy backend services/routes and the minimal Settings compatibility changes together. New preflight/marker functions must exist before serving the new completion/preview code.
5. Separately authorize and perform an actual owner reconnect. Observe the verified durable checkpoint before calling it healthy. Do not automatically run historical recovery.
6. Only if actual evidence proves an identity change/gap, obtain the corresponding operator review and explicit preview/admission. Reconciliation and any future posting activation are separate decisions.

Compatibility: saved completed Chase batch dates/counts/receipts/mappings are not rewritten. Existing read-only history and legacy function/URL names remain. New preview creation intentionally requires explicit context/evidence instead of the old date-only import path. Recovery mutations intentionally stop accepting ordinary-owner authority. Existing stale legacy UI recovery controls require later operator UX work; they do not gain permission through this phase. The existing legacy Chase rebuild path remains for prior previews, while new reviewed cohorts cannot be sent through its cursor-based rebuild/release shortcuts.

## Validation and remaining decisions

Final validation:

| Check | Result |
|---|---|
| Disposable PostgreSQL 17/PostgREST integration | **29/29 pass** (28 scenarios plus parent), approximately 64 seconds. Includes all prior persistence/residual/reviewed-release tests, the non-superuser role regression and five new reconnect/gap scenarios. |
| Focused existing regressions plus reconnect behavioral tests | **95/95 pass**. |
| ESLint on every changed JavaScript/JSX/test file | **Pass**. |
| Full `npm run lint` | Fails with the existing **1,877 findings**: 1,687 errors and 190 warnings. No blanket fixes were applied. |
| Production `npm run build` | **Pass**, approximately eight seconds, existing bundle-size warnings. |
| `git diff --check` | **Pass**. |

Commands: `node --test tests/integration/plaidPersistence.database.test.js`; focused `node --test` over `plaidSyncCategorizationPersistence`, `plaidCanonicalization`, `plaidReplacementCardRecovery`, `plaidAccountConnectionStateContract`, `backgroundBookkeepingProcessing`, `plaidResidualReconciliationContract` and `plaidReconnect` tests using synthetic localhost environment values.

Database evidence specifically covers unchanged identity/no batch, Update Mode token and cancellation/no completion mutation, failed checkpoint/unhealthy/resume, immutable Chase completed evidence, changed identity/operator denial then explicit confirmation, missing/different Item stop, no automatic remapping, fresh bounded proven-gap preview reuse, tenant/browser/operator denial, admission constraint failure rolling back bank/category/requests, duplicate admission, posting holds, exact reviewed release, safe customer audit redaction, manual/CSV probable overlap, pending-to-posted lineage, represented QBO rows, ambiguous pending events and unchanged ledger/cursor when admission is blocked. Prior tests still exercise cohorts over 1,000 rows and residual/release preservation.

The database harness runs real PostgreSQL 17 + PostgREST, exact relevant schema/index/trigger definitions, browser/internal-role denial and external network blocking; it starts no bookkeeping/posting worker. Live provider behavior, remote catalog, OAuth return timing and provider-history availability have not been verified against Discover.

Remaining work before a broader UI rollout:

- Operator tenant-context/navigation and lineage/gap-evidence/review screens; preserve read-only admin views.
- Evidence-document storage/review procedure and appropriate proof for a specific gap. This implementation stores only an evidence reference and authenticated operator assertion.
- New-Item handoff UX with explicit physical-account/ledger continuity review. Reconnection currently stops safely instead of creating/exchanging a new Item.
- Provider pagination changes that do not change totals cannot be ruled out by `/transactions/get` alone; held review and live-ledger reconciliation remain mandatory before release. Provider history may be incomplete/unavailable even when replay succeeds.
- Large-business evidence fingerprint cost and contention should be evaluated against representative non-production data. The current digest deliberately fails closed on unrelated business evidence changes; it favors safety over operator convenience.
- Posting activation remains separate: recheck current mappings, duplicate/receipt/protected-workflow evidence and policy before any future posting. No action in this implementation grants that authorization.
