# Webhooks, Rate Limits, Sensitive Writes Security Audit

Date: 2026-08-11

Verdict: PASS WITH FIXES

Scope: webhook/callback endpoints, machine endpoints, rate limiting, replay/idempotency, sensitive writes, mass assignment, IDOR, destructive operations, billing, AI/provider cost abuse, request sizing, cron/internal routes, CORS/CSRF, and sensitive logging. No production data was accessed or modified.

## Corrections Made

| Severity | Area | Change |
|---|---|---|
| HIGH | Internal admin authorization | `src/api/admin/monthlyReview.routes.js` no longer trusts self-editable `user_profiles.role`; internal admin access now requires configured allowlisted admin email after authentication. |
| MEDIUM | Signup confirmation abuse | Added route-specific app-side rate limiting to `POST /api/auth/signup-confirmation`. |
| MEDIUM | AI/provider cost abuse | Added shared rate limiting to GPT generation routes, marketing generation routes, and Plaid link/exchange/sync routes. |
| MEDIUM | Gmail OAuth state | Removed production hardcoded state-secret fallback, added required state secret, timing-safe HMAC comparison, and 10-minute state expiry. |

## Endpoint Inventory

| Route | Source | Auth | Signature/secret | Writes | Replay/idempotency | Rate limit |
|---|---|---:|---:|---:|---:|---:|
| `POST /api/billing/webhook` | Stripe | No | Stripe signature over raw body | Billing/subscription state | No durable processed-event table found; several updates are idempotent/upsert-like | No app limiter |
| `POST /api/qbo/webhooks/job-costing` | QuickBooks | No | Intuit HMAC over raw body | `qbo_webhook_events`, sync queue | Event hash duplicate check; durable if DB uniqueness exists | No app limiter |
| `GET /auth/quickbooks` | QBO OAuth start | Yes + business access | Server-created OAuth state | OAuth state | State record consumed later | No app limiter |
| `GET /auth/callback` | QBO OAuth callback | Public callback | Persisted server-side state | QBO token records | State consumption protects replay | No app limiter |
| `GET /api/email/callback` | Google/Gmail OAuth callback | Public callback | HMAC state, now timed | Email tokens/account records | OAuth code one-time; state is signed/timed but not server-side single-use | No app limiter |
| `POST /api/auth/signup-confirmation` | Supabase auth preflight | No | None | May resend confirmation | N/A | Added |
| `POST /api/integrations/plaid/link-token` | Plaid | Yes + business context | Server Plaid secret | Link token creation | N/A | Added |
| `POST /api/integrations/plaid/exchange` | Plaid | Yes + business context | Server Plaid secret | Plaid item/token rows | Service path, business-scoped | Added |
| `POST /api/integrations/plaid/sync` | Plaid | Yes + business context | Server Plaid secret | Sync state/financial rows | Service path | Added |
| `POST /api/tax/scheduler/run-daily`, `/run-weekly` | Internal scheduler | Yes + scheduler secret | `TAX_SCHEDULER_INTERNAL_SECRET` | Tax scheduler effects | Scheduler service level | Internal secret |
| `/api/admin/monthly-review/*` | Internal admin | Yes + admin email allowlist | Configured admin email allowlist | Review/admin state | Route-specific logic | No app limiter |
| QBO webhook process routes under jobs | Internal/job processing | Yes + business context | Bearer auth | Sync processing | Queue/event state | No app limiter |
| Health/ping routes | Health checks | Mixed/public | None | No sensitive writes observed | N/A | N/A |

Plaid webhook verification is not currently applicable because no Plaid webhook receiver route was found. If a Plaid webhook endpoint is added, it must verify Plaid’s webhook authentication mechanism before writes.

## Findings

### HIGH - Fixed: Internal Admin Role Self-Promotion Path

Affected file: `src/api/admin/monthlyReview.routes.js`

Attack scenario: if a regular user can update their own `user_profiles.role`, trusting that role for internal admin access can become privilege escalation.

Existing protection: `requireAuth` was present.

Weakness: the internal admin guard also trusted profile role values.

Correction made: admin authorization now depends on authenticated identity plus configured email allowlist, not database role text.

Remaining risk: keep operational admin email allowlists restricted and audited.

### MEDIUM - Fixed: High-Abuse Public Signup Confirmation Preflight

Affected file: `src/api/auth/signupConfirmation.routes.js`

Attack scenario: unauthenticated callers could repeatedly probe/resend confirmation behavior.

Existing protection: Supabase provider behavior.

Weakness: no app-side throttle.

Correction made: added per-IP/email rate limiting.

Remaining risk: response semantics still distinguish some states; consider generic responses if user enumeration risk needs to be reduced further.

### MEDIUM - Fixed: AI and Provider Cost Routes Lacked App-Side Throttles

Affected files: `src/api/gpt/brain/gpt.routes.js`, `src/api/marketing/marketing.routes.js`, `src/api/integrations/plaid.routes.js`

Attack scenario: one authenticated user could repeatedly invoke costly AI or provider operations.

Existing protection: authentication/business middleware and provider-side controls.

Weakness: no consistent application rate limiter on several high-cost routes.

Correction made: added shared app-side rate limiter and applied it to GPT generation, marketing generation, and Plaid link/exchange/sync.

Remaining risk: additional expensive routes such as report generation, uploads, QBO sync/backfill, and tax calculations should receive route-specific limits in a later pass.

### MEDIUM - Fixed: Gmail OAuth State Had Weak Fallback and No Expiry

Affected file: `src/api/email/gmail.auth.js`

Attack scenario: a missing production state secret could fall back to a predictable value, and old signed state could remain valid.

Existing protection: HMAC-signed state.

Weakness: hardcoded fallback and no max-age check.

Correction made: production now requires a state secret, HMAC comparison is timing-safe, and state expires after 10 minutes.

Remaining risk: Gmail OAuth state is not yet persisted and consumed single-use like QBO OAuth state.

### MEDIUM - Open: Stripe Webhook Replay Idempotency

Affected file: `src/api/billing/billing.routes.js`

Attack scenario: a valid Stripe event can be resent. Signature verification proves authenticity, not single processing.

Existing protection: cryptographic signature and idempotent/upsert-style billing writes.

Weakness: no durable processed Stripe event ID table was found.

Recommended correction: store Stripe `event.id` in a processed-events table inside the same transaction/operation that applies side effects.

### MEDIUM - Open: Upload Size Limits Need Explicit Hardening

Affected file: `src/server.js`

Attack scenario: multipart uploads can exhaust memory/disk if not explicitly bounded.

Existing protection: JSON body limit is `5mb`; file upload middleware is configured.

Weakness: no explicit `express-fileupload` `limits.fileSize` found.

Recommended correction: define file-size and file-count limits per upload route.

### LOW/MEDIUM - Open: Legacy/High-Cost Routes Need Per-Route Limits

Routes include QBO OAuth initiation/sync/backfill, some report/export/tax/job generation routes, and disconnect/destructive routes.

Existing protection: most are authenticated and business-scoped.

Weakness: several do not have route-specific throttles or stronger authorization beyond business access.

Recommended correction: add per-user/business/IP limits based on route cost and blast radius.

## Sensitive Write Review

Most business-scoped APIs are mounted behind canonical `requireAuth` and `requireBusinessContext`, and prior RLS/service-role hardening prevents direct browser bypass for covered tables. QBO and Plaid server operations derive business identity from server middleware instead of trusting browser `business_id`.

Mass-assignment patterns requiring continued review remain, especially legacy investment/controller code that spreads request bodies before persistence. Existing code overwrites some protected IDs server-side, but protected field allowlists should be completed in a future focused pass.

## Abuse Surface Summary

| Area | Status |
|---|---|
| Stripe webhook signature | Verified safe: raw body + Stripe constructEvent, fail closed |
| QBO webhook signature | Verified safe: raw body + HMAC/timingSafeEqual, fail closed |
| Plaid webhook | No receiver route found |
| Webhook replay | QBO has event hash duplicate logic; Stripe needs durable processed-event table |
| Auth abuse | Signup-confirmation app throttle added; direct Supabase auth still relies on Supabase limits |
| AI cost abuse | GPT/marketing limits added; additional high-cost routes need route-specific follow-up |
| Sensitive admin writes | Internal admin self-promotion path fixed |
| Request size | JSON bounded; multipart upload limits need explicit hardening |
| Internal scheduler routes | Require auth plus internal scheduler secret |
| CORS/CSRF | CORS allowlist is restrictive; bearer-token model predominates |
| Sensitive logging | Webhook/provider code generally avoids token/secret logging; continue redaction discipline |

## Tests

Focused tests added:

- `tests/webhooksRateLimitsSensitiveWrites.security.test.js`

Focused test results:

- `node --test tests/webhooksRateLimitsSensitiveWrites.security.test.js`: PASS, 7/7
- `node --test tests/qboSecurity.test.js`: PASS, 14/14
- `node --test tests/privateRouteMounts.security.test.js`: PASS, 5/5
- `node --test tests/authTenant.middleware.test.js`: PASS, 13/13

Full suite result from this phase:

- `npm test`: 689 tests, 683 pass, 3 fail, 3 skipped
- Failing tests observed: `sidebarNavigationUi.test.js`, `taxConfidenceExplanationUi.test.js`, `taxWorkpaperUi.test.js`
- These are unrelated UI/static test failures outside the files changed for this webhook/rate-limit/security pass.

## Required Answers

Can an attacker forge any provider webhook? No confirmed forge path found for Stripe or QBO. Plaid has no receiver route.

Can a valid webhook be replayed to duplicate side effects? Possible for Stripe due no durable processed-event table found. QBO has duplicate event-hash handling.

Are Stripe webhooks cryptographically verified? Yes.

Are QuickBooks webhooks cryptographically verified where applicable? Yes.

Are Plaid webhooks appropriately authenticated/verified? Not applicable currently; no Plaid webhook receiver route was found.

Are sensitive public endpoints rate limited? Partially. Signup confirmation is now rate-limited; Stripe/QBO webhooks are signature-protected but not app-rate-limited.

Can login/reset/signup flows be trivially abused at high volume? Direct Supabase auth flows still rely primarily on Supabase provider protections; signup confirmation now has app throttling.

Can one authenticated user create disproportionate AI/provider cost? Reduced, but not eliminated. GPT/marketing/Plaid routes now have limits; other expensive routes need follow-up limits.

Can a user modify protected ownership/role/tenant fields through request payloads? No confirmed critical path found in audited canonical routes; legacy body-spread paths need continued allowlist review.

Can User A mutate an object belonging to Business B by guessing its ID? No confirmed route-level bypass found in this pass; canonical business middleware and prior RLS hardening mitigate the main paths.

Can browser users execute internal cron/admin routes? Scheduler routes require internal secret; monthly review admin now requires configured admin email allowlist.

Are destructive writes adequately authenticated and authorized? Mostly, with follow-up recommended for route-specific limits and stronger authorization on high-impact deletes/disconnects.

Are billing/subscription writes trusted only from authoritative server/provider state? Yes for Stripe webhook-driven billing state; replay idempotency should be strengthened.

Are request sizes bounded sufficiently? JSON is bounded; multipart upload limits need explicit hardening.

Were any new security regressions introduced by fixes? None found by focused tests.

Is this phase ready for launch? PASS WITH FIXES, with follow-up items for Stripe event idempotency, upload limits, and expanded route-specific throttles.

WEBHOOK / RATE LIMIT / SENSITIVE WRITE SECURITY: PASS WITH FIXES
