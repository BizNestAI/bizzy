# Books/Plaid production diagnostic audit — November 9, 2026

## Executive summary

**Production reads confirm an internal persistence failure for AMEX, Chase and Truist, and a separate Plaid reauthentication failure for Discover.** This audit performed SELECT-only Supabase reads and a GET of backend health. It did not reconnect, sync, import, categorize, post, refresh provider credentials, change remote rows, apply migrations or deploy. Local report artifacts are the only changes made for this audit.

119 existing bank transactions lack categorization rows: AMEX 48, Chase 64, Truist 7. These same 119 rows lack bookkeeping processing requests. Current failed sync runs stop at `transaction_persistence`, PostgreSQL `23502`, before the categorization invariant, cursor commit and downstream enqueue. Transactions can therefore appear in Books while end-to-end sync and automation fail. The customer-facing temporary-provider language is misleading.

The exact violating column for these sync failures is **not retained in the inspected sync records**. A concrete source defect is the sparse `postedReviewUpdates` upsert into `bank_transactions`: it supplies an existing `id` and review fields but omits NOT NULL insert columns including `business_id`. Upsert still has an insert path. This is a strong explanation for imports committing and a subsequent write failing, but identifying it as the exact historical failing statement requires retained server/database diagnostics or a database-backed reproduction. Do not conflate it with the separately confirmed historical `transaction_categorizations.decided_by` NOT NULL failures.

Auto-post is enabled, all four Plaid accounts have mapping rows, zero current categorization rows reference recovery holds, and zero unposted categorizations have `post_after` scheduled. For the 119 rows, the immediate automation break is before queue creation, not a rejected QBO write. QBO credential validity and exact missing QBO ledger entries remain unproven without an authorized, non-refreshing provider read and ledger reconciliation.

## Identity and evidence boundaries

- Backend GET `https://bizzy-production.up.railway.app/healthz`: SHA `82395320cf4d957837650ffb7f9141a2df5d9d73`; production environment; deploy `0254dced-1884-4cd0-bc22-506538697ed0`; build-start field `2026-11-09T16:08:00.642Z`. Checkout HEAD matches. Existing unrelated working-tree edits were left untouched.
- Supabase project: `zwufvvrmjbymgyjntdzk`. Business `cffc2183-e77c-4148-a206-d5192e090925`, **Pat's Test Account**. All four screenshot masks resolve to this business.
- Evidence snapshot: `2026-11-09T17:04:53.525Z`. Reads were sequential/paginated, not a repeatable-read database snapshot; a running production worker can change state during inspection.
- Timestamps below are UTC unless explicitly marked otherwise. Transaction dates are dates, not receipt timestamps.
- All rows of the selected business were paginated in batches of 1,000 for the reconciliation. Counts below are current persisted state, not historical event counts or proof of rule execution. The accompanying JSON contains daily insertion-cohort reconciliation and run groups.
- No raw tokens, provider transaction payloads, or full Plaid Item/account identifiers are included in the report. Cursor fingerprints are SHA-256 hashes; raw cursors were not printed.
- Retained sync history begins October 7. October 1–6 provider attempts cannot be reconstructed from the inspected run table. Historical run records often lack stage/error metadata. Provider receipt counts/max dates, request IDs, credential-expiration reasons, full before/after cursors, every rule evaluation and full webhook history cannot be reconstructed from this evidence. The audit does not invent them.

## Root causes by account

| Institution / account | Institution ID; redacted Item/account | Confirmed current failure | Last successful Item sync | Latest persisted transaction date | Missing categorization / queue |
|---|---|---|---|---|---:|
| AMEX ••1008 | `ins_10`; …eaD0MX / …q5YJ1V | Database persistence, `23502` | Oct 15 05:05:45.813 | Nov 8 | 48 / 48 |
| Chase ••6735 | `ins_56`; …AEwrXe / …wwZyoZ | Database persistence, `23502` | Oct 18 05:07:55.055 | Nov 8 | 64 / 64 |
| Truist ••8626 | `ins_130888`; …9KJAYb / …LLR3xr | Database persistence, `23502` | Nov 4 05:19:18.567 | Nov 5 | 7 / 7 |
| Discover ••9734 | `ins_33`; …Zer6pL / …X593nN | Provider fetch, `ITEM_LOGIN_REQUIRED` | Oct 18 05:07:51.515 | Oct 12 | 0 / 0 |

All four Item `status` fields remain `connected`; the error code is a separate field. All four persisted account connection states are also `connected`. Discover projects to `attention_required` because its Item error is `provider_reauthentication_required`. Thus raw “connected” is not proof of usable credentials or successful imports.

## Account timelines

| Account | Retained run sequence and earliest observed failures | Latest failed run on Nov 9 |
|---|---|---|
| AMEX | 32 old failures Oct 7–8 (`supabase_update_failed`); 30 completed runs Oct 9–15; 7 generic incremental failures Oct 16 05:10:23.787–05:55:11.802; 91 `23502` persistence failures Oct 17 05:13:24.484–Nov 9 | 05:49:33.202–05:49:35.566 |
| Chase | 32 old fetch failures Oct 7–8; 36 completed runs Oct 9–18; 83 `23502` persistence failures beginning Oct 20 05:07:10.915 | 05:49:36.277–05:49:39.027 |
| Truist | 32 old failures Oct 7–8 (`supabase_update_failed`); 52 completed runs Oct 9–Nov 4; 20 `23502` persistence failures beginning Nov 5 05:00:36.035 | 05:49:39.639–05:49:41.134 |
| Discover | 32 old failures Oct 7–8 (`supabase_update_failed`); 36 completed runs Oct 9–18; 83 `ITEM_LOGIN_REQUIRED` provider-fetch failures beginning Oct 20 05:07:08.213 | 05:49:41.690–05:49:42.091 |

The Oct 7–8 failure labels have no retained source-code metadata; they must not automatically be attributed to the later `23502` condition. The AMEX Oct 16 generic failures also precede the first precisely classified persistence failure.

Latest persisted insertion times: AMEX Nov 9 05:04:35.720792; Chase Nov 9 05:04:42.561639; Truist Nov 7 05:04:42.059331; Discover Oct 16 05:10:12.813788. AMEX/Chase/Truist `last_seen_at` continues advancing during failed runs on Nov 9. This supports partially committed replay, not a cleanly completed feed.

Latest retry cursor hashes remain `8a5b757f…` (AMEX), `9739316d…` (Chase), `c01148d4…` (Truist), `ac1d759a…` (Discover). Full hashes and all retained distinct input hashes are in the evidence JSON. Failed records retain input hashes but not next cursors; no before/after cursor claim is possible for every attempt.

Chase recovery: one replacement account candidate was confirmed (created Oct 6 23:51:17.273460). An old preview was abandoned; two rebuild attempts failed. The usable batch admitted **114** rows Oct 8 17:08:06.308867 and was released **Oct 9 18:19:21.557**. Its `posting_hold=false`. Failed/abandoned historical batch records still have `posting_hold=true`, but no current categorization references them. They do not establish an active global hold. No account connection-audit rows were returned; that does not prove identities never changed outside that audit mechanism.

## Pipeline reconciliation

All-history account totals, measured at the snapshot:

| Stage | AMEX | Chase | Truist | Discover |
|---|---:|---:|---:|---:|
| Persisted bank rows, all active | 211 | 547 | 109 | 49 |
| Categorization rows | 163 | 483 | 102 | 49 |
| Missing categorization and processing request | **48** | **64** | **7** | 0 |
| Processing requests, total | 144 | 368 | 102 | 49 |
| Completed requests | 14 | 233 | 51 | 12 |
| Skipped requests | 130 | 7 | 51 | 36 |
| Dead-letter requests | 0 | 127 | 0 | 1 |
| Processing requests currently processing | 0 | 1 | 0 | 0 |
| Categorization status `posted` | 139 | 476 | 56 | 45 |
| QBO posted receipts with status `posted` | 139 | 476 | 56 | 45 |
| Active categorization recovery holds | 0 | 0 | 0 | 0 |
| Unposted categorizations scheduled with `post_after` | 0 | 0 | 0 | 0 |

Processing-request totals include historical rows that predate the incident. Missing a processing request alone does not prove a historical transaction was never categorized: older/manual flows may have categorized it elsewhere. The 119-row incident subset is stronger evidence because both categorization rows and queue requests are absent and its onset matches persistence failures.

Daily reconciliation is in `books-plaid-production-audit-2026-11-09.json`: for each insertion day, persisted → amount/direction normalized → categorization row exists → processing request exists → posted receipt exists. These are insertion cohorts, including Chase's Oct 8 recovery; they are not transaction-date totals. Every row in the incident cohorts has normalized amount/direction and business/account assignment, but zero categorization rows, processing requests or posted receipts. **Plaid received counts are unknown**: failed runs leave counters at zero, even after committed inserts. Categorization-row existence is not a rule-evaluation count. Auto-post eligibility checks and first evaluation failures lack a complete historical event ledger.

First confirmed orphaned categorization cohorts:

- AMEX: transaction `8c3ffad5-524f-4932-a29c-d87fde807f62`, transaction date Oct 16, inserted **Oct 17 05:13:26.136723**.
- Chase: transaction `3353bb42-a988-46bc-a37e-994c3685a5b5`, transaction date Oct 18, inserted **Oct 20 05:07:12.578832**; multiple rows share that timestamp, so it is not a unique first arrival.
- Truist: transaction `fb135b6d-c93d-48b7-8db6-19d62ee9dbcc`, transaction date Nov 3, inserted **Nov 5 05:00:37.215755**; multiple rows share that timestamp.

These are first missing-categorization rows in current persisted state, not proof of the first transaction ever skipped by rules. No per-rule execution evidence was retrieved that would establish that stronger claim.

Last processing completion: AMEX Oct 16 05:15:11.565; Chase Oct 20 05:12:05.491; Truist Nov 9 16:20:10.087; Discover Oct 16 05:10:14.434. Last local posted receipt: AMEX Oct 17 17:18:22.216; Chase Oct 21 05:12:45.065; Truist Nov 5 05:20:34.487; Discover Oct 17 05:18:21.719. Older queued work can finish after feed failure. Truist processing activity today contradicts a blanket conclusion that all workers stopped.

Additional retained automation defects: four Chase dead-letter jobs report `23502`, `transaction_categorizations.decided_by` null; 123 Chase jobs and one Discover job report `23514`. Sampled `23514` messages name `business_canonical_qbo_account_mappings_source_check`. These historical jobs exhausted five attempts; sampled records date to August. They need separate repair classification, not an indiscriminate retry of every dead-letter row.

QBO has an active production token row; no token was decrypted or refreshed. Local receipts include seven Truist `pending` and one `unknown` record in addition to 56 `posted`; those require receipt/intent reconciliation before any replay. An active token row does not prove a provider call will succeed. Sampled latest `failed` post attempts were October 4 statement/lock timeouts, not the current missing-queue incident.

## Why imports, categorization and posting diverge

Source order in `src/services/plaid/plaidSyncService.js`:

1. Fetch provider pages and normalize rows.
2. Write bank rows in separate HTTP/database requests and chunks: ID upserts, Plaid-ID upserts, sparse posted-review upserts, lifecycle changes.
3. Resolve transaction IDs; call `ensure_plaid_transaction_categorizations`.
4. Commit cursor and Item success fields; update account sync timestamps; mark run completed.
5. Enqueue bookkeeping requests and wake the worker. Enqueue failure is caught and logged without failing the completed sync.

There is no atomic boundary spanning these steps. Failure in step 2 can leave earlier bank writes committed but omit steps 3–5. Current production failures are explicitly step 2, not a failure of the later categorization RPC. The recently added categorization invariant therefore cannot repair these rows until execution reaches it. Even a successful cursor commit still has a separate enqueue-loss window at step 5.

Concrete defect to reproduce: `postedReviewUpdates.push` around line 691 produces an ID-only review patch without business/account/transaction/date/name/amount insert fields; around line 715 it is sent to `upsertRowsInChunks(..., "id")`. That helper uses `.upsert`, not `.update`. PostgreSQL requires a valid insert candidate before conflict handling. A sparse update should use a business-scoped update or an explicit update RPC, with a real database test. Other writes in the broad `transaction_persistence` block must also be examined before naming the exact historical statement.

Source does not register a Plaid webhook URL for new Link sessions and explicitly says this integration uses polling. No verified Plaid webhook ingestion handler was found in the inspected integration routes. Consequently there is no evidence that webhooks succeed while cron fails. Retained failed cron attempts show workers continue running. Cron defaults: poll every 15 minutes, attempt only in hour 05 in the Item timezone (host timezone fallback), at least 20 hours since last success, up to 25 Items per tick, paid-entitlement gate. Retry metadata is not a durable next-retry appointment and ignores those gates.

## Displayed-status audit

| Label | Authority / update path | Clearing and staleness defects |
|---|---|---|
| Books “Reconnect required” / Settings “Attention required” | `isPlaidReauthenticationRequired`: Item `reauth_required` status or known credential error; account projection also respects explicit attention/disconnection | Success clears Item error at cursor commit. No age-based expiry; Item error projects to every attached account. Discover's raw account state remains connected while projected state is attention. |
| Books temporary warning | `projectPlaidSyncAvailability`: any non-reauth Item `error_code` | No provider/internal distinction or freshness comparison. A genuine database error is presented as temporary sync unavailability. Clears only when error is cleared. |
| Settings temporary warning | `deriveRecoverySyncHealth`: latest failed run newer than last success | Any failed layer gets generic copy; returned latest-run failure code is collapsed to `transaction_sync_failed`. History queries are bounded and can omit older successful runs; Item success fallback is used. |
| “Connected” | Institution summary of projected account connection states; overall Settings considers any connected account sufficient | Measures connection eligibility, not healthy import/categorization/posting. Overall four-institution count includes Discover needing attention. No staleness policy. |
| “0 of 0 syncing” | Settings reads `inst.syncing_accounts_count` / `inst.accounts_count` with zero defaults | Backend returns `connection_summary: {syncing,total}` and `accounts`, but omits those per-institution top-level count properties. This is a deterministic API/UI contract mismatch, not zero connected accounts. |
| “Last sync” | Latest completed/successful run timestamp, falling back to Item `last_sync_at` | Describes end-to-end successful sync, not latest insertion or failed attempt. Account timestamp updates only for accounts represented in added/modified events, so unchanged accounts may look older. |
| “Last successful sync” | latest successful run or Item `last_success_at` / `last_sync_at` | Does not advance on partial writes. Correctly remains old, but lacks context that newer rows persisted. |
| “Transactions imported through” | Recovery status computes max active bank date only for `replacement_recovery_account_id` | Ordinary accounts call `deriveRecoverySyncHealth` without `importedThrough`; null becomes “Not available” despite existing rows. Shared Item health is copied to each account. |
| “Imported range” | Books computes min/max active persisted bank transaction date by account | Truthful extent of existing dates, not complete coverage or last successful provider check. Unpaginated API read can truncate on larger businesses; SQL aggregate is preferable. |
| “Auto-posting new activity since” | Business `auto_post_to_quickbooks`, `auto_post_enabled_at`, scope policy | Enabled since Oct 9 18:27:03.686; `new_activity_only`. Copy does not prove queued/eligible work, worker health or QBO auth. |
| “Mapped” | Existence of `plaid_qbo_account_mappings` row | All four have rows (QBO IDs AMEX 20, Chase 19, Truist 10, Discover 17). Existence is not validation that target remains active/usable in QBO. |
| “Posting hold released” | Chosen recovery batch release/status and `posting_hold` | True for the released Chase batch; should explicitly describe that batch, not overall automation health. No current transaction-linked recovery holds exist. |

Chase's Oct 18 success timestamp and Nov 8 transaction date are **a real partial-failure boundary plus different definitions**, not solely stale display. Later inserts commit before a subsequent persistence failure prevents Item success/cursor and downstream queue work. Settings showing a date only for Chase is an additional recovery-specific projection defect. Fresh transaction dates must not conceal a still-failing sync; nor should an old Item error erase account-level import evidence.

## Discover diagnosis and recovery suitability

Exact retained Plaid code: **`ITEM_LOGIN_REQUIRED`**, first observed **2026-10-20T05:07:08.213Z**; latest **Nov 9 05:49:41.690Z**. Local normalized code: `provider_reauthentication_required`. Historical raw `error_type` and request ID were not retained in these records. Plaid documents this code under **`ITEM_ERROR`**; that is a documented classification, not a retrieved raw field. It can reflect credentials/MFA/required user action and does not uniquely identify migration, consent expiration or revocation. [Plaid Item errors](https://plaid.com/docs/errors/item/).

No evidence here proves the Capital One consumer-app transition caused this Item failure. No `INSTITUTION_NO_LONGER_SUPPORTED`, migration event, old→new institution mapping, consent-expiration timestamp or provider revocation reason was retrieved. Review the Plaid Dashboard migration notice/Item debugger or retained provider logs to discriminate those causes.

**Preferred path A: Update Mode for the existing Item.** The deployed `createUpdateLinkToken` supports a business/environment-scoped existing active Item and passes its stored access token to Link token creation. This is the documented recovery for `ITEM_LOGIN_REQUIRED`. No Link token was created, so actual institution-specific completion is not verified. [Plaid Update Mode](https://plaid.com/docs/link/update-mode/).

After repair, compare returned identities, preserve the physical/Bizzi/QBO mapping, resume from the retained cursor, and verify continuity before posting. If Update Mode reports unsupported institution or a provider-confirmed migration demands a new Item, use path B: explicitly confirm the new account is the same physical account and preserve existing ledger identity. Only then use path C if cursor recovery does not cover the proven gap. Plaid documents that some migrations are seamless, some use Update Mode and some require a new connection; the app transition alone does not select a path. [Plaid institution migrations](https://support.plaid.com/hc/en-us/articles/43167565059479-What-are-institution-migrations-and-how-do-they-affect-my-Plaid-integration).

Reusable Chase safeguards: durable staged preview, confirmed identity lineage, bounded admission, existing/represented/pending/ambiguous classifications, posting hold during recovery, idempotent admission, receipt reconciliation, explicit release. **Do not reuse the hard-coded August 27 cutoff**: `inspectUpdatedItemAccounts` currently assigns `2026-08-27`, and recovery status has the same fallback. Discover requires its own continuity boundary. Also do not assume a replacement-card account-ID change is equivalent to an institution migration or that matching masks prove identity. The current post-update inspector writes recovery state even when no new account appears; its zero-new-account path needs review before calling the reconnect experience seamless.

## Gaps and duplicate protection

| Account | Persisted-date tail requiring verification through Nov 9 | Known automation backlog |
|---|---|---|
| AMEX | Nov 9 onward; internal holes before Nov 8 unproven | 48 uncategorized persisted rows, onset Oct 17 insert cohort |
| Chase | Nov 9 onward; internal holes before Nov 8 unproven | 64 uncategorized persisted rows, onset Oct 20 cohort |
| Truist | Nov 6–9; no activity on those dates has not been ruled out | 7 uncategorized persisted rows, onset Nov 5 cohort |
| Discover | Oct 13–Nov 9, after authoritative max date Oct 12 | No missing categorization among 49 existing rows; unseen activity unknown |

These are candidate missing windows, not proof of one missing transaction per day. Max dates cannot establish completeness; bank statements or provider history are required. **Whether transactions are missing: not conclusively established. Whether QBO postings are missing: 119 existing rows lack the ordinary categorization/queue path, but the number actually eligible and absent in the QBO ledger is unknown.** Existing QBO-native entries may need matching instead of new posting.

Verified code protections: `(business_id, plaid_transaction_id)` upsert identity; `pending_transaction_id`/stable local-ID merging; physical-account identity; canonical deterministic fingerprints; probable relink matching by normalized amount/memo/date, requiring review when ambiguous; pending candidate uniqueness; removed-event archive/protection handling; posted material changes marked for accounting review rather than silent ledger replacement. The fallback fingerprint uses provider account/date/amount/memo and cannot alone span a new provider identity. Date/amount/merchant equality can also merge distinct real purchases if treated as proof.

QBO posting checks existing receipt/category identity, posting intent/lock, stable request identity, duplicate preflight and provider-visible recovery markers; local-finalize failure after a successful QBO write has a distinct recovery path. Do not reset request identity or post before reconciling `pending`/`unknown` receipts. Source contains protections, but this audit did not execute their database-backed guarantees or compare live QBO entries.

CSV/manual-import provenance and cross-source uniqueness were **not fully verified**. No dedicated CSV/manual matching branch was found in the inspected Plaid canonical/recovery modules. A future new-Item/history recovery must explicitly compare those sources and preserve imported batch provenance; it is not safe to assume Plaid-ID uniqueness covers manual imports.

## Layer separation and recommended minimal state model

Connection, sync eligibility, business auto-post policy, pending eligibility, QBO mapping, recovery hold and QBO posting worker are represented separately in code. Posting holds do not gate scheduled sync eligibility; the posting worker checks a transaction's recovery batch independently. However, import persistence and the ability to enqueue categorization are operationally coupled by execution order. Error projection then collapses internal persistence into a generic bank warning. QBO failures occurring in the posting worker do not directly update Plaid errors in the inspected paths.

Retain existing schema where possible; expose a derived account status object with four independent dimensions. Add durable retry/error timestamps or queue outbox state only where existing rows cannot express them.

| Dimension | States and authority | Transition/clear rule | Customer copy/action |
|---|---|---|---|
| Bank connection | `connected`, `attention_required`, `institution_unavailable`, `disconnected`; active flags plus provider-specific latest verified error | Explicit disconnect wins; verified reauth wins over healthy connection; provider outage requires provider evidence. Clear provider error after verified recovery, not by age alone. | Connected: no CTA; reconnect: “Reconnect securely”; outage: “Bank temporarily unavailable”, no reconnect CTA. |
| Transaction import | `current`, `delayed`, `backfilling`, `failed`; latest fully persisted feed checkpoint, latest attempt/stage, account max date, active recovery | `current` requires a successful checkpoint, not just a fresh max date. Clear old failure only after the affected stage succeeds. Preserve attempted/completed/imported timestamps separately. | “Latest imported transaction: Nov 8”; “Import needs attention” for internal failure; next retry only from real scheduled state. |
| Categorization | `active`, `processing`, `needs_review`, `failed`; missing-category invariant, request states/errors/leases, review counts | Orphan admission or exhausted retry → failed; pending/processing → processing; valid unresolved decisions → needs_review. Idempotent completion clears related error. | “Automation needs attention” / “Review automation”; ordinary review is not a system failure. |
| QBO posting | `active`, `held`, `QBO_reconnect_required`, `failed`; business policy, row holds/scope, QBO auth failure, intents/receipts/worker | Preserve all block reasons; project auth action if required, then explicit hold, then posting failure. Only remove each block after its own validation. | “Auto-post enabled · 119 awaiting automation”; “Posting held”; “Reconnect QuickBooks” only for verified QBO auth failure. |

Every dimension should carry `last_attempt_at`, `last_success_at`, `error_at`, `reason_code`, scope/account identity and, when real, `next_retry_at`; derive existing timestamps from runs/requests/receipts. Use a configurable freshness SLA based on scheduled cadence and timezone; display delayed status when overdue. Historical errors remain auditable but cease controlling current state after a later authoritative success at the same layer. Account evidence controls account import extent; Item-wide provider credential failures still legitimately affect every account on that Item. A newer account date is not proof that Item credentials are currently healthy.

Recommended current cards: AMEX “Latest imported: Nov 8 · Import needs attention · Automation needs attention”; Chase same plus recovery details in secondary history; Truist “Latest imported: Nov 5 · Import needs attention · Automation needs attention”; Discover “Reconnect required · Last imported transaction: Oct 12 · Reconnect securely”. Do not say the first three are fully current while their checkpoints fail. After continuity is validated, “Transactions current · Automation needs attention” becomes appropriate. Do not label posting globally paused merely because auto-post has no eligible queued work.

## Safe remediation order and implementation packets

**P0 — Capture and reproduce before changing production.** Retain sanitized failing operation/table/column/constraint and provider request ID/type; distinguish provider/internal/automation stages. Reproduce sparse posted-review upsert and all step-2 writes against a disposable database with production-shaped constraints/triggers. Inspect actual installed function bodies/schema contract, not migration filenames alone. Determine the exact current `23502` column before production repair. No fixes were implemented in this audit.

**P0 — Repair persistence and durable downstream admission.** Replace sparse insert-shaped updates with business-scoped updates. Ensure successful admission atomically creates missing categorization and durable processing work, or use a small existing-database outbox with explicit reconciliation; commit cursor only after durable admission. Keep QBO posting asynchronous. Preserve categories, matches, exclusions and existing receipts. A swallowed enqueue exception must leave retriable evidence and cannot mean fully healthy automation.

**P0 — Controlled 119-row repair plan.** Preview exact IDs against live current categories, posting receipts/intents and QBO matches. Repair only missing categorization/queue rows, run idempotently, classify pending/protected transactions and scope, then schedule only eligible unposted transactions. Reconcile Truist unknown/pending receipts first. Do not infer all 119 should post. Do not mass-reset the older 128 dead-letter jobs.

**P1 — Discover connection repair.** After persistence safety is validated, use existing-Item Update Mode first. On cancellation retain Item/mapping/cursor unchanged. Verify identities and consent result. Resume retained cursor and reconcile Oct 13 onward; only use new-Item lineage and controlled gap backfill if provider evidence requires them. Replace the Chase-specific cutoff assumption before any Discover historical recovery. Release only the relevant posting hold after deduplication and ledger validation.

**P1 — Status contract.** Return/use correct institution counts, compute max persisted dates for every account, separate four dimensions, retain actual failure origin, report real retry eligibility/time, paginate or aggregate all transaction stats. Historical recovery success must not imply live automation health. Avoid alarming provider-outage copy for internal or harmless historical conditions.

**P2 — Historical backlog and observability.** Separately inspect decided-by/source-check dead letters, stale processing leases, receipt finalization and import provenance. Add per-batch received/persisted/admitted/evaluated/eligible/queued/posted counters and stage timestamps; retain hashes rather than raw cursors, and redacted provider request metadata. Alert on persisted rows without durable automation admission.

Transient provider failures: bounded automatic backoff with truthful next attempt, entitlement/timezone gates visible internally, and automatic warning clearance after successful provider/import checkpoint. Internal schema failures require engineering action, not indefinite “retrying automatically” reassurance. QBO auth failures should pause QBO writes while import and categorization continue, and show a QuickBooks-specific reconnect action.

## Required later tests and deployment risks

Run database-backed tests in disposable local/staging databases; this audit ran no production write tests and did not invoke application repair helpers. Existing `tests/plaidSyncCategorizationPersistence.test.js` uses mocks/source checks for key paths and does not reproduce sparse database upsert behavior.

1. Real NOT NULL/trigger/index contract: mixed existing/new/posted-material-change batches; later write failure after committed inserts; duplicate retry; no missing durable processing request; no cursor advancement before durable admission.
2. Successful feed recovery clears only its old temporary failure; older failed runs do not override a newer success; provider failures and internal persistence failures render different copy.
3. Imports continue when categorization worker fails; categorization retry produces one durable action; exhausted jobs expose true reason and lease recovery works.
4. QBO timeout/ambiguous success/local-finalize failure: stable request identity and receipts prevent duplicate entries; unknown receipts reconcile before retry; live duplicate match does not become a new posting.
5. Same-Item reconnect preserves mappings/cursor/categories; cancellation changes none; new Item/account requires confirmed physical lineage and environment/business scope.
6. Gap recovery tests dates around Oct 12/13 with overlap, existing QBO/manual/CSV entries, uncertain fingerprints, same-day repeated purchases, bounded admission and explicit hold release. No hard-coded Chase cutoff.
7. Pending→posted identity merge, authorization amount changes, excluded pending replacement, removed events and material changes after QBO posting preserve accounting decisions and flag review appropriately.
8. Provider outage, account-specific failure, Item-wide credentials failure, stale Item errors versus fresh account import evidence, paid-entitlement gate, timezone scheduling and real next-retry reporting.
9. Auto-post On plus row hold/scope/protected workflow/QBO reconnect/disabled posting worker remains truthfully represented; no failure in one layer is relabeled as another.
10. Institution count contract (one of one, partial, attention, no accounts), every account's imported-through max date, unchanged-account sync checkpoints, >1,000-row aggregation, accurate end-to-end versus persistence success timestamps.

Deployment risks: a fix may release weeks of backlog at once; external QBO writes cannot be rolled back with application deployment. Use explicit reviewed cohorts, preserve historical policy and request identities, throttle posting, reconcile receipts, and keep holds scoped. Migration ledger presence does not prove installed schema parity. Broader account identity/dedupe changes can affect already posted rows and require staging replay. Current production-only unknowns—exact sync violating column, full provider history, CSV provenance and live QBO completeness—must be closed before declaring full recovery.


## Daily insertion-cohort appendix

Counts are current state of each insertion cohort; categorization/job rows do not prove rule execution. All dates UTC.

### Account ••1008

| Inserted day | Persisted | Normalized | Category row | Queue request | Posted receipt |
|---|---:|---:|---:|---:|---:|
| 2026-10-01 | 1 | 1 | 1 | 1 | 1 |
| 2026-10-02 | 3 | 3 | 3 | 2 | 2 |
| 2026-10-04 | 1 | 1 | 1 | 1 | 1 |
| 2026-10-07 | 3 | 3 | 3 | 2 | 2 |
| 2026-10-08 | 2 | 2 | 2 | 2 | 1 |
| 2026-10-09 | 1 | 1 | 1 | 1 | 1 |
| 2026-10-11 | 1 | 1 | 1 | 1 | 1 |
| 2026-10-12 | 1 | 1 | 1 | 1 | 1 |
| 2026-10-13 | 3 | 3 | 3 | 3 | 3 |
| 2026-10-14 | 1 | 1 | 1 | 1 | 0 |
| 2026-10-16 | 1 | 1 | 1 | 0 | 1 |
| 2026-10-17 | 1 | 1 | 0 | 0 | 0 |
| 2026-10-20 | 3 | 3 | 0 | 0 | 0 |
| 2026-10-21 | 5 | 5 | 0 | 0 | 0 |
| 2026-10-23 | 3 | 3 | 0 | 0 | 0 |
| 2026-10-25 | 2 | 2 | 0 | 0 | 0 |
| 2026-10-26 | 5 | 5 | 0 | 0 | 0 |
| 2026-10-27 | 4 | 4 | 0 | 0 | 0 |
| 2026-10-29 | 6 | 6 | 0 | 0 | 0 |
| 2026-10-30 | 1 | 1 | 0 | 0 | 0 |
| 2026-10-31 | 1 | 1 | 0 | 0 | 0 |
| 2026-11-02 | 2 | 2 | 0 | 0 | 0 |
| 2026-11-03 | 3 | 3 | 0 | 0 | 0 |
| 2026-11-05 | 3 | 3 | 0 | 0 | 0 |
| 2026-11-06 | 3 | 3 | 0 | 0 | 0 |
| 2026-11-07 | 1 | 1 | 0 | 0 | 0 |
| 2026-11-08 | 1 | 1 | 0 | 0 | 0 |
| 2026-11-09 | 4 | 4 | 0 | 0 | 0 |

### Account ••9734

| Inserted day | Persisted | Normalized | Category row | Queue request | Posted receipt |
|---|---:|---:|---:|---:|---:|
| 2026-10-02 | 1 | 1 | 1 | 1 | 1 |
| 2026-10-03 | 1 | 1 | 1 | 1 | 1 |
| 2026-10-07 | 1 | 1 | 1 | 1 | 1 |
| 2026-10-08 | 1 | 1 | 1 | 1 | 1 |
| 2026-10-10 | 1 | 1 | 1 | 1 | 1 |
| 2026-10-13 | 2 | 2 | 2 | 2 | 2 |
| 2026-10-14 | 1 | 1 | 1 | 1 | 1 |
| 2026-10-16 | 1 | 1 | 1 | 1 | 1 |

### Account ••6735

| Inserted day | Persisted | Normalized | Category row | Queue request | Posted receipt |
|---|---:|---:|---:|---:|---:|
| 2026-10-08 | 114 | 114 | 114 | 114 | 113 |
| 2026-10-09 | 3 | 3 | 3 | 3 | 3 |
| 2026-10-10 | 3 | 3 | 3 | 3 | 3 |
| 2026-10-11 | 3 | 3 | 3 | 3 | 3 |
| 2026-10-12 | 1 | 1 | 1 | 1 | 1 |
| 2026-10-13 | 3 | 3 | 3 | 3 | 3 |
| 2026-10-14 | 2 | 2 | 2 | 2 | 2 |
| 2026-10-15 | 1 | 1 | 1 | 1 | 1 |
| 2026-10-16 | 4 | 4 | 4 | 4 | 3 |
| 2026-10-17 | 6 | 6 | 6 | 6 | 5 |
| 2026-10-18 | 3 | 3 | 3 | 3 | 3 |
| 2026-10-20 | 6 | 6 | 0 | 0 | 0 |
| 2026-10-21 | 3 | 3 | 0 | 0 | 0 |
| 2026-10-22 | 4 | 4 | 0 | 0 | 0 |
| 2026-10-23 | 3 | 3 | 0 | 0 | 0 |
| 2026-10-24 | 2 | 2 | 0 | 0 | 0 |
| 2026-10-25 | 2 | 2 | 0 | 0 | 0 |
| 2026-10-26 | 4 | 4 | 0 | 0 | 0 |
| 2026-10-27 | 5 | 5 | 0 | 0 | 0 |
| 2026-10-28 | 4 | 4 | 0 | 0 | 0 |
| 2026-10-29 | 3 | 3 | 0 | 0 | 0 |
| 2026-10-30 | 4 | 4 | 0 | 0 | 0 |
| 2026-11-01 | 1 | 1 | 0 | 0 | 0 |
| 2026-11-02 | 5 | 5 | 0 | 0 | 0 |
| 2026-11-04 | 3 | 3 | 0 | 0 | 0 |
| 2026-11-05 | 1 | 1 | 0 | 0 | 0 |
| 2026-11-06 | 3 | 3 | 0 | 0 | 0 |
| 2026-11-07 | 5 | 5 | 0 | 0 | 0 |
| 2026-11-08 | 3 | 3 | 0 | 0 | 0 |
| 2026-11-09 | 3 | 3 | 0 | 0 | 0 |

### Account ••8626

| Inserted day | Persisted | Normalized | Category row | Queue request | Posted receipt |
|---|---:|---:|---:|---:|---:|
| 2026-10-01 | 1 | 1 | 1 | 1 | 1 |
| 2026-10-03 | 2 | 2 | 2 | 2 | 2 |
| 2026-10-04 | 1 | 1 | 1 | 1 | 1 |
| 2026-10-08 | 1 | 1 | 1 | 1 | 1 |
| 2026-10-09 | 1 | 1 | 1 | 1 | 0 |
| 2026-10-11 | 1 | 1 | 1 | 1 | 1 |
| 2026-10-16 | 1 | 1 | 1 | 1 | 0 |
| 2026-10-23 | 1 | 1 | 1 | 1 | 0 |
| 2026-10-24 | 1 | 1 | 1 | 1 | 0 |
| 2026-10-25 | 1 | 1 | 1 | 1 | 1 |
| 2026-10-28 | 1 | 1 | 1 | 1 | 0 |
| 2026-10-29 | 1 | 1 | 1 | 1 | 0 |
| 2026-10-31 | 1 | 1 | 1 | 1 | 1 |
| 2026-11-03 | 4 | 4 | 4 | 4 | 1 |
| 2026-11-04 | 4 | 4 | 4 | 4 | 0 |
| 2026-11-05 | 5 | 5 | 0 | 0 | 0 |
| 2026-11-06 | 1 | 1 | 0 | 0 | 0 |
| 2026-11-07 | 1 | 1 | 0 | 0 | 0 |
