# Background worker traffic containment — November 10, 2026

Local code change only. No deployment, variable changes, production SQL, provider invocation, or production workflows were performed.

## Startup and deployment contract

HTTP startup remains unconditional. Automatic background startup now requires all of:

- `NODE_ENV=production`
- `RAILWAY_ENVIRONMENT_NAME=production` (exact name)
- nonempty Railway-injected `RAILWAY_PROJECT_ID` and `RAILWAY_SERVICE_ID`

`RAILWAY_DEPLOYMENT_ID` is optional and its absence does not disable workers.

`BACKGROUND_WORKERS_OVERRIDE=true` explicitly enables controlled test processes outside that environment. `false`, or another nonempty value, disables startup. `DISABLE_BACKGROUND_WORKERS=true` always takes precedence. Do not set the override in routine local development or globally in Railway. No configuration was changed as part of this patch.

All existing worker-specific flags remain in their original start functions; `DISABLE_RECON_CRON` is still checked by the server registration. The override does not bypass any disable flag. One aggregate startup line records the gate's decision and reason; existing worker configuration logs remain.

The audited Railway service combines HTTP and workers (`node src/server.js`, one replica). This preserves that arrangement. Before a future deployment verify the Railway-injected indicators and exact environment name, NODE_ENV, and the aggregate startup line. No new variable is required when these indicators are present. This gate is not distributed leader election: any additional production service/replica running this entry point would also start workers. Keep worker ownership to the intended service/single replica; separate API-only replicas should use the existing global disable flag in a separately reviewed configuration change.

Existing local processes retain the old code until restarted. This change does not stop PID 99993 or change running production traffic. Starting the HTTP server locally can still support intentional API actions; it no longer automatically launches background schedulers.

## Cadences and retained semantics

| Loop | Before | After (default configuration) |
| --- | --- | --- |
| Merchant recovery | 1-second interval; five state reads each sweep | First sweep after 1s; after empty/error: 2, 4, 8, 16, then 30s; work resets to 1s |
| Interactive queue | 1s after empty claims or ordinary errors | Startup claim immediately; empty/error: 2, 4, 8, 16, then 30s; claimed work resets to 1s |
| Missing interactive claim RPC | Existing bounded exponential backoff | Preserved, up to existing default 300s |
| Missing tax bookkeeping outbox RPC | Retried every minute | First failure opens 15-minute cooldown; logs once per outage; recovery clears breaker |

Existing explicit poll settings remain the fast-cadence floor; a configured base longer than 30s is not shortened. Delays are scheduled after completion, not as overlapping interval ticks. Stop/restart invalidates old adaptive-loop generations: their completion cannot change backoff or schedule timers. A restarted loop waits for any old sweep to finish, with at most one pending timer. Merchant's original overlap flag remains. Tax recalculation now waits for all queues to settle before allowing the next tick; a missing outbox does not suppress healthy recalculation or workspace projection queues.

Immediate merchant wakeups, direct interactive wakeups, queue claims/leases, eligibility rules, and provider/posting execution paths are unchanged. Empty periodic merchant timeline messages are removed; targeted wakeup messages remain. Poll-only work discovered after idling can wait up to 30s plus sweep duration. Immediate wakeups continue to bypass this wait. Failed merchant operations also back off instead of hot-looping.

## Expected request reduction (do not add overlapping estimates)

Audit window: Nov 9 17:25–Nov 10 17:25 Eastern; 1,794,410 gateway events.

- Gate: targets 832,948 non-Railway admin-client requests (46.42%) if those callers are unnecessary local/development servers and are restarted with the patch. This is an upper-bound attribution, not a guarantee of caller ownership.
- Polling only, with the caller population otherwise unchanged: 575,399 empty merchant state reads plus 107,734 empty interactive claims. At steady state, moving 1s to 30s removes about 96.7% of the idle poll frequency: approximately 660,362 requests/day (36.8% of all audited requests). Sweep time, restarts, workload and wakeups affect actual savings.
- These polling counts include local traffic. Do not add their savings to the gate's savings. Measure Railway-only traffic after rollout before assigning a combined reduction.
- Tax outbox cooldown reduces missing-function probes from 1,440 to at most about 96/day per continuously running process (93.3%), apart from restarts and recovery. This is also included in the local-caller estimate where applicable.

No merchant query consolidation or tax hydration optimization is included.

## Exact tax follow-up (not implemented)

The audited tax projections accounted for 999,706 reads (55.71%). Not every matching request can be attributed solely to the recovery timer.

Current chain: `startTaxClassificationWorker` (60s) -> `enqueueRecoveryTaxClassificationRuns` -> `getBusinessesEligibleForTaxClassification` -> `evaluateBusinessTaxClassificationEligibility` -> `neutralizeNoLongerEligibleClassifications`. That last function reads the first 100 classifications and calls `getPostedTransactionForTax` individually. Each call rereads bookkeeping scope, bank row, categorization, receipt and account data. Lifecycle/source snapshot readers additionally fetch and hydrate whole-year populations in 50-ID chunks, sometimes before applying pagination.

A separate change should:

1. Track source/classification version or timestamp and recover only changed/stale transaction IDs, with a paginated persisted cursor so later classifications are not starved by repeatedly scanning the first 100.
2. Load bookkeeping scope once per business/year/sweep; batch bank, categorization and receipt reads by those IDs and fetch distinct accounts once.
3. Reuse that snapshot across neutralization, eligibility and lifecycle evaluation within the sweep. Preserve tenant/year boundaries, receipt authority, version checks, and neutralization behavior.
4. Read narrow tax fields. Avoid transmitting bank `raw` and receipt `payload`/`response` unless classification actually needs them; do not remove evidence required by current normalizers without contract tests.
5. Bound full recovery frequency and concurrent sweeps; invalidate from durable data-change events. Avoid running a full-year read for every status poll. Apply source pagination before hydration where semantics permit.
6. Use fixture-based query-count tests for unchanged and changed populations, mixed eligibility, later-page recovery, and same-transaction concurrent changes. Validate request counts, bytes and outcome equivalence locally before a separately approved rollout.

## Verification

`node --test tests/backgroundWorkerContainment.test.js` uses fake timers, isolated worker imports and explicit stubs. Production clients and provider/posting entry points are never imported/executed; network access and dynamic imports in worker harnesses throw. Tests cover startup/overrides, actual server registration, merchant and interactive scheduling, work resets, overlap prevention, stop during an in-flight poll, and the actual tax worker's isolation of the missing-RPC breaker.
