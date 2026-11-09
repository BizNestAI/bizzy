# Local recovery status and residual repair

This phase builds on `complete_plaid_sync_admission`; it does not replace its atomic checkpoint authority. No production access, remote migration, live Plaid call, worker start, QBO call, deployment or historical backlog repair was performed. The audit-era 119 rows are context, never a target constant.

## Files changed in this phase

- `src/services/plaid/plaidAccountRecoveryStatus.js`: four-dimensional projection, aggregate status reader, institution totals, worker/entitlement eligibility interpretation.
- `src/services/plaid/plaidResidualRecoveryService.js`: preview by default; explicit, scoped execution against a persisted preview manifest; safe error codes only.
- `src/services/plaid/plaidIntegrationService.js`: adds the new contract to legacy `/status`, correct per-institution counts, per-account imported dates, truthful legacy sync-health fields, aggregate-backed account/mapping population.
- `src/services/plaid/plaidReplacementRecoveryService.js`: excludes residual manifests from replacement-card history/preview selection; rejects residual admission/release through ordinary replacement-card operations; removes unproven automatic retry claims from the legacy projection.
- `src/api/integrations/plaid.routes.js`: tenant-derived status endpoint and owner/integration-admin residual operation.
- `src/api/bookkeeping/routes/bookkeeping.accounts.routes.js`: replaces the unpaginated transaction-date scan with the aggregate contract; separates attempt and checkpoint metadata.
- `supabase/migrations/20261109190000_plaid_account_recovery_observability.sql`: aggregate/read/classification/preview/apply functions and residual hold guards. No new table or column, no financial-data backfill.
- `tests/integration/plaidPersistence.database.test.js`: extends the existing disposable PostgreSQL/PostgREST harness and its production-shaped fixture.

Earlier repair files, prior reports and unrelated working-tree edits remain intact.

## Final API contract

`GET /api/integrations/plaid/recovery-status` is authenticated and derives the business from the existing tenant authorization context. It accepts no caller-selected business. Its response includes:

```json
{
  "ok": true,
  "contract_version": 1,
  "qbo_env": "production",
  "observed_at": "<database timestamp>",
  "accounts_count": 4,
  "institutions_count": 4,
  "syncing_accounts_count": 3,
  "accounts": [{
    "id": "<Plaid account ID>",
    "mapped_to_qbo": true,
    "recovery_status": {
      "account_id": "<Plaid account ID>",
      "bank_connection": {},
      "transaction_import": {},
      "categorization_automation": {},
      "quickbooks_posting": {}
    }
  }],
  "institutions": [{
    "institution_id": "<institution ID>",
    "accounts_count": 1,
    "syncing_accounts_count": 1,
    "accounts": []
  }]
}
```

Example totals above illustrate the shape only. Every total is calculated from the current account population, not those example values. Institutions group accounts across retained Items by institution ID, falling back to Item identity. `syncing_accounts_count` means connection-eligible accounts, including a connected account whose institution is temporarily unavailable; it does **not** count healthy imports, completed categorizations or successful QBO writes.

Each dimension returns:

```json
{
  "state": "failed",
  "reason_code": "internal_transaction_persistence_failure",
  "last_attempt_at": "<timestamp or null>",
  "last_success_at": "<timestamp or null>",
  "error_at": "<timestamp or null>",
  "next_retry_at": null,
  "affected_count": 3,
  "recommended_action": "inspect_import",
  "customer_copy": "Transaction import needs attention",
  "diagnostic": {"stage": "transaction_persistence", "code": "23502"}
}
```

Null timestamps mean unavailable evidence, not “never happened.” Customer copy is separate from bounded identifier-only diagnostic codes. Raw cursors, database row DETAIL, credentials and transaction descriptions are not returned. Import failure counts refer to known persisted orphan records; they do not estimate unseen provider transactions.

| Dimension | States / important reasons | Precedence and authority |
|---|---|---|
| `bank_connection` | `connected`, `attention_required`, `institution_unavailable`, `disconnected`; reauthentication, explicit account attention, missing Item, closed historical account | Explicit disconnect/history wins. Credential errors require retained provider/Item evidence; a verified outage requires a provider-fetch failure with an explicit institution-outage code. Database errors never become bank outages. A completed checkpoint supersedes older Item/run errors for projection. Closed historical accounts have no reconnect CTA. |
| `transaction_import` | `current`, `delayed`, `processing`, `failed`, `paused`; internal persistence failure, retained-cursor replay, provider fetch failure, checkpoint overdue | Latest attempt and completed checkpoint are queried independently. Disconnected accounts are paused and do not inherit their connected sibling's success timestamp. Freshness defaults to 26 hours after the account's completed checkpoint, never from max transaction date. Internal failure exposes `replay.required=true`; an admission lease/dead-letter conflict has reason `retained_cursor_replay_required`. |
| `categorization_automation` | `active`, `processing`, `needs_review`, `failed`, `blocked`; missing admission, active/stale lease, dead letter, user review, disabled worker or missing paid entitlement | Missing required evidence and unresolved operational blockers take precedence over ordinary queue/review counts. Terminal decisions do not become automation failures solely because a historical ordinary queue request is absent. Active and stale processing leases are distinct; the stale threshold matches the existing worker's ten-minute contract. |
| `quickbooks_posting` | `active`, `held`, `reconciling`, `QBO_reconnect_required`, `failed`, `unknown` | Current auth failure takes precedence over receipt reconciliation, then holds/policy/mapping/failure conditions. All independent blockers remain in `blockers`. A newer active credential connection or successful posting supersedes an old auth error, without deleting its receipt. Token presence alone does not prove live provider validity. |

Import also exposes `persisted_active_count`, first/latest active transaction dates, `last_transaction_persisted_at`, `last_transaction_mutation_at`, `last_transaction_observed_at`, `last_completed_checkpoint_at`, `item_last_completed_checkpoint_at`, `partial_persistence_after_checkpoint` and `replay`. A fresh max date never overrides a failed checkpoint. “Partial persistence” is evidence of committed account activity after the prior checkpoint, not an invented provider-received count.

Categorization includes:

```json
{
  "missing": {
    "categorization": 3,
    "processing_admission": 5,
    "required_processing_admission": 3,
    "both": 3
  },
  "conflicts": {
    "active_processing_leases": 0,
    "stale_processing_leases": 0,
    "unresolved_dead_letters": 0
  }
}
```

The unrestricted missing-request count includes older completed decisions with no ordinary queue record; the required-admission count is the operational subset. These example counts are not hard-coded. Import extent and all counts use aggregate SQL over the entire scoped account, not an API-limited transaction list or recovery-selected account.

Import retry times are always null: the existing daily poller does not persist a per-Item future appointment. Categorization exposes a retry time only for actual failed work with a future `process_after`/`blocked_until`, remaining attempts, no due work or lease/dead-letter blocker, a verified paid entitlement and an enabled processing worker. Worker enablement is configuration evidence, not a heartbeat or guarantee of future execution. Posting retry times remain null because full row-level retry eligibility is not proven by a timestamp alone. No new customer copy says “retrying automatically.”

Legacy `GET /api/integrations/plaid/status` includes `account_recovery` and each account's `recovery_status`; institutions now have both count properties the current frontend expects. Books `/api/bookkeeping/accounts` also includes `account_recovery`, individual statuses and aggregate-backed imported ranges. Existing frontend fallback logic does not understand every new state; consuming the new contract in the UI is a required next phase, not a completed part of this change.

## Replay and residual repair

Primary recovery remains an independently authorized retained-cursor replay through the existing sync architecture. A failed import retains its cursor. The later successful replay creates missing categories and durable requests atomically for the rows it actually receives. Nothing in this phase starts replay, contacts Plaid or resets a cursor.

Residual preview requires proof of a completed run from the new admission architecture (`admitted_count` metadata) whose input cursor hash matches a prior internal failed run. The account must have been connected before that replay. The latest attempt must be a completed checkpoint, and no residual target may have been inserted after that checkpoint. An old unrelated successful poll is insufficient proof. If evidence is insufficient, the dry-run reports current classifications with `ready=false`; it does not create a manifest or alter financial records.

`POST /api/integrations/plaid/accounts/:plaidAccountId/residual-recovery`

- `{}` defaults to preview. Only literal `execute: true` enables execution.
- `{"execute":true,"batch_id":"<fresh preview UUID>"}` applies that exact preview.
- Owner role, integration-admin capability, mutation rate limit and tenant-derived business are required. Actor identity comes from authentication, never the body. The service-role RPCs are not available to browser roles.

A ready preview stores **only workflow evidence** in the existing `plaid_recovery_batches` and `plaid_recovery_batch_rows` tables. It is a dry-run with respect to bank transactions, categories, processing requests and QBO records; it is not a promise of zero database writes. Manifests are tagged `summary.workflow_kind = residual_orphan` and excluded from replacement-card preview/history selection. Their payloads contain local transaction IDs, classification and evidence hashes, not provider payloads/descriptions.

The initial target is exactly: same business + Plaid environment + account, active bank transaction, no categorization, no ordinary durable processing request. Classification includes the entire scoped account for conflict accounting, while execution admits only eligible members of that initial target.

Classifications, in precedence order: protected/removed transaction; active processing lease; stale processing lease; unresolved dead letter; existing match; existing posting intent/receipt; completed decision/exclusion; pending transaction; possible QBO duplicate; manual review required; protected workflow (including inflow, checks, known loan/transfer/payroll/refund/payment patterns or manual/CSV source); existing categorization; existing admission; eligible residual orphan. Known pending, processing and unknown QBO intents are protected without contacting QBO. Absence of a local duplicate signal is **not** proof of absence in the external ledger.

## Exact execution gates

1. Explicit execute, authenticated actor, exact business/environment/account/manifest ownership.
2. Ready manifest no older than five minutes. Current account/transaction/category/request/receipt evidence fingerprint must match; changed evidence requires a fresh preview, never a forced override.
3. Valid successful replay evidence and current eligible connection; a later failed/running attempt blocks repair.
4. Business auto-post must be **disabled**, checked while locking the business row. In addition, every repaired category receives the manifest's durable posting hold.
5. Ordinary Item sync must have no active lease. The Item/account and exact bank cohort are locked; category/request/receipt ownership and uniqueness constraints protect concurrent admission. A conflict aborts the transaction.
6. Insert only missing categories and processing requests for the eligible cohort. No reset/update of existing decisions, leases, dead letters, requests, intents, receipts, bank rows, mappings, provenance or cursors. Categories start `needs_review` with no posting schedule and no safe-auto-post grant. The existing asynchronous processing worker is not awakened inline.
7. Categories, requests, held batch state and after-reconciliation commit together. Repeating an applied manifest returns `idempotent=true`, `newly_applied_count=0`; a different stale manifest is rejected.
8. Database triggers prohibit clearing/changing a residual category hold or releasing/repurposing its batch. The ordinary replacement-card release path also rejects it. This phase deliberately provides **no residual hold-release workflow**. Categorization/reconciliation may proceed under the hold; enabling the global toggle cannot remove it.

Preview responses contain `dry_run`, `ready`, optional `batch_id`/expiry, posting protection and `before`. Execution returns `before`, `after`, `newly_applied_count`, idempotency and batch ID. Each reconciliation is account-scoped and includes current initial-target/eligible counts, scoped initial-target IDs/classifications, classification counts, replay/checkpoint references and an evidence fingerprint. The displayed cohort can be smaller than the original audit backlog or zero. Fingerprints conservatively cover all account evidence; unrelated account activity can require refreshing a preview.

## Migration and rollout implications

Apply the earlier `20261109173000_plaid_durable_sync_admission.sql` before this phase's `20261109190000_plaid_account_recovery_observability.sql`. The new migration adds service-role-only functions and two hold-protection triggers; it does not create a table, add a column, run a backlog repair or call a provider. It depends on the existing processing, QBO intent/token, mapping, recovery, connection and categorization schema. Compare installed definitions against those prerequisites before any separately authorized deployment; no remote catalog was accessed here.

The additional schema must precede the matching backend. Missing aggregate RPCs fail the status endpoint as unavailable rather than returning fabricated healthy state. Keep sync, categorization and posting operationally gated during any future rollout, following the previous repair report. A residual cohort remains held until a future explicit reconciliation/release implementation is reviewed. Do not blanket-push all repository migrations or assume the current frontend safely renders new backend states.

## Validation

The existing ephemeral PostgreSQL 17/PostgREST harness is reused. It loads real snapshot DDL and relevant migrations, uses only synthetic data and a synthetic Plaid client, blocks external fetches and never starts a processing/posting worker. Its containers/networks/anonymous volumes are removed afterward. No permanent staging environment is required.

Database scenarios cover:

- original sparse-update reproduction and durable-admission regressions from the previous phase;
- status precedence, partial persistence versus checkpoint, later success clearing projection while failed history remains;
- provider reauthentication/outage versus independent QBO auth/holds/pending/unknown receipts and user review;
- retained-cursor replay admitting some stranded rows before residual preview;
- preview gates, current classifications, explicit posting-disable gate, held admission and idempotent execution;
- stale/expired preview rejection, new receipt conflicts, tenant/actor isolation;
- active processing and dead-letter conflicts without request resets;
- new-row admission above 1,000 transactions and a separate **1,002-row residual repair** with complete held admission and zero QBO records;
- real eligible future categorization retries versus unverified dispatch, disconnected sibling checkpoints and institution counts;
- legacy adapter counts, replacement-card hold-release denial and browser-role RPC denial.

Final results:

- `node --test tests/integration/plaidPersistence.database.test.js`: **18/18 pass** (17 scenarios plus the parent suite), including prior persistence regressions and the new recovery/status tests.
- Focused canonicalization, categorization-persistence, connection-state, replacement-recovery and background-processing tests: **86/86 pass**, with synthetic loopback environment settings.
- ESLint for every JavaScript file changed in this phase: **passes**.
- `npm run build`: **passes**, with existing bundle-size warnings.
- `git diff --check`: **passes**.

Repository-wide lint has known unrelated failures documented in the preceding repair report; this phase did not alter lint configuration or attempt unrelated cleanup.

## Decisions before UI work

- Adopt the four-dimensional contract instead of legacy fallback labels. Map `recommended_action` to role-appropriate controls; replay/internal diagnostics belong in operator flows, not a customer bank-reconnect CTA.
- Confirm the default 26-hour checkpoint freshness SLA and account-specific presentation (“latest transaction” versus “last checked”). Do not describe a max transaction date as complete historical coverage.
- Decide neutral/attention tones for intentional disconnects, ordinary user review, provider outages and disabled posting. Bank connection eligibility and mapping must not become green indicators for downstream health.
- Design the owner preview/confirmation experience, stale-preview refresh, cohort reconciliation and a separately authorized residual hold release. The current guards intentionally prevent release through existing replacement-card actions.
- Decide how to expose missing-request counts for legitimate historical completed decisions versus required admission, and whether to add durable worker heartbeat/row-level posting retry evidence later. No new scheduling platform is introduced here.
- External QBO continuity/duplicate reconciliation remains a separate authorized operation. This implementation does not determine which recovered transactions should be posted.
