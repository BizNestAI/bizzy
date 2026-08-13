# Prompt 9A Follow-Up: Webhooks, Upload Limits, Mass Assignment, High-Cost Routes

Date: 2026-08-11

Verdict: READY FOR FINAL SECURITY AUDIT

Scope: unresolved Prompt 9 items only. No production data was accessed or modified. No authentication, tenant authorization, Supabase RLS, webhook signature verification, or service-role boundaries were weakened.

## Fixes Made

| Area | Change |
|---|---|
| Stripe replay/idempotency | Added `public.stripe_webhook_events` migration with unique `event_id`, RLS enabled, browser grants revoked, service-role access retained. |
| Stripe webhook processing | Billing webhook now verifies Stripe signature first, then durably claims `event.id` before side effects. Duplicate event IDs return without applying billing side effects. |
| Multipart uploads | Added explicit global `express-fileupload` size limit, abort-on-limit behavior, safe 413 responses, and max file count. |
| Bid attachments | Added route-level 10MB default attachment size guard before Supabase Storage upload. |
| Mass assignment | Replaced manual investment position body spread with explicit allowlist plus server-derived `user_id`. |
| High-cost routes | Added per-user/business/IP rate limits to QBO/job-costing sync/backfill/process/generation routes, insight generation routes, and change-order price recommendations. |

## Files Changed In This Follow-Up

- `supabase/migrations/20260817_add_stripe_webhook_event_idempotency.sql`
- `src/api/billing/billing.routes.js`
- `src/server.js`
- `src/api/jobCosting/routes/jobCosting.bidBuilder.routes.js`
- `src/api/investments/investments.controller.js`
- `src/api/Jobs/jobs.routes.js`
- `src/api/insights/insights.routes.js`
- `src/api/jobCosting/routes/jobCosting.changeOrders.routes.js`
- `tests/webhooksRateLimitsSensitiveWrites.security.test.js`

## Stripe Replay Protection

Durable identity: Stripe `event.id`.

Mechanism:

1. `stripe.webhooks.constructEvent(...)` verifies the raw-body signature.
2. The handler inserts `event.id` into `public.stripe_webhook_events`.
3. The unique `event_id` constraint prevents concurrent duplicates from both claiming the event.
4. Only a claimed event proceeds to billing side effects.
5. Duplicate valid events return `{ received: true, duplicate: true }`.
6. Successful processing marks the event `processed`; handler failure marks it `failed`.

This is durable across server restarts. A failed row is intentionally not automatically retried by duplicate webhook delivery, because blindly reprocessing could duplicate partial side effects. Failed rows should be reviewed and remediated operationally.

## Upload Limits

Global multipart limits:

- `MAX_UPLOAD_FILE_SIZE_BYTES`, default `10MB`
- `MAX_UPLOAD_FILE_COUNT`, default `5`
- Oversized uploads abort with 413-style response.

Bid attachment route:

- `MAX_BID_ATTACHMENT_BYTES`, default inherited from global `MAX_UPLOAD_FILE_SIZE_BYTES` or `10MB`
- Oversized or truncated attachments fail before storage upload with `attachment_file_too_large`.

## Mass Assignment

Focused scan after the fix found no remaining direct sensitive `req.body` persistence pattern from:

- `.insert(req.body)`
- `.update(req.body)`
- `.upsert(req.body)`
- `{ ...req.body }` into a confirmed sensitive write

Remaining matches are local variables named `body` that are not direct request-body mass assignment.

## High-Cost Routes

New limits were added to:

- Job candidate generation
- Job assignment suggestion generation
- Job natural-language assignment
- QBO job-costing sync/backfill/webhook processing/CDC/reconciliation/project sync
- Insight generation and contractor CFO generation
- Change-order price recommendation

Existing Prompt 9 limits remain in place for GPT generation, marketing generation, Plaid link/exchange/sync, and signup confirmation.

## Tests

Focused and relevant tests:

- `node --test tests/webhooksRateLimitsSensitiveWrites.security.test.js`: PASS, 10/10
- `node --test tests/qboSecurity.test.js`: PASS, 14/14
- `node --test tests/privateRouteMounts.security.test.js`: PASS, 5/5
- `node --test tests/authTenant.middleware.test.js`: PASS, 13/13
- `node --check` on changed route/server files: PASS

Full suite:

- `npm test`: 692 tests, 686 pass, 3 fail, 3 skipped
- The remaining failures are the same unrelated UI/static tests:
  - `tests/sidebarNavigationUi.test.js:5`
  - `tests/taxConfidenceExplanationUi.test.js:72`
  - `tests/taxWorkpaperUi.test.js:52`

## Required Answers

Can a valid Stripe webhook now be replayed to duplicate state? No. A duplicate valid Stripe event ID is skipped before side effects.

Is webhook idempotency durable across server restarts? Yes. Stripe event IDs are persisted in `public.stripe_webhook_events` with a unique constraint.

Are multipart uploads explicitly size/count bounded? Yes. Global file size/count limits are now explicit, and bid attachments have route-level size checks.

Does any confirmed sensitive mass-assignment vulnerability remain? No confirmed sensitive mass-assignment vulnerability remains from the focused scan.

Can users override protected ownership/tenant/role fields? No confirmed path remains from the reviewed and fixed Prompt 9A scope; manual investment writes now use server-derived `user_id` and an explicit field allowlist.

Are major high-cost endpoints reasonably abuse-limited? Yes for the major reviewed endpoints: GPT, marketing, Plaid, job-costing/QBO, insights, and change-order price recommendations.

Did any fix weaken existing auth/RLS/security boundaries? No.

Are there any remaining Prompt 9 launch blockers? No Prompt 9 launch blockers remain. Apply the Stripe idempotency migration before relying on the new Stripe replay guard in deployed environments.

PROMPT 9 FOLLOW-UP: READY FOR FINAL SECURITY AUDIT
