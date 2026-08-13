# Final Pre-Launch Security Audit

Date: 2026-08-11

Scope: read-only adversarial audit of the current application code, Supabase schema snapshots/reports, security migrations through 6L plus the Stripe idempotency migration artifact, and accumulated security test reports.

No production connection was made. No SQL was executed. No secrets were printed. No code, migration, configuration, or production data was modified. The only writes made for this prompt are this report and its JSON companion.

## Verdict

**FINAL VERDICT: FAIL - LAUNCH BLOCKERS REMAIN**

The public database/RLS layer is in strong condition based on the production schema verification and the staging two-tenant harness baseline of `570 passed / 0 failed`. The remaining launch blocker is outside the public table/RLS layer: Supabase Storage is used by current product code for customer files but has not been provisioned, policy-hardened, or runtime-certified. A second operational blocker applies if the current Stripe webhook idempotency code is deployed before `20260817_add_stripe_webhook_event_idempotency.sql` is applied in the target environment.

## Reviewed Evidence

- `src/server.js`
- `src/api/gpt/middlewares/requireAuth.js`
- `src/api/_shared/tenantAuth.js`
- `src/services/supabaseAdmin.js`
- `src/services/supabaseClient.js`
- `src/api/billing/billing.routes.js`
- `src/api/billing/stripeWebhookIdempotency.js`
- `src/api/auth/quickbooksAuth.js`
- `src/api/qbo/qboJobCostingWebhooks.routes.js`
- `src/api/integrations/plaid.routes.js`
- `src/services/plaid/plaidIntegrationService.js`
- `src/api/email/gmail.auth.js`
- Storage callers under Bizzy Docs, P&L PDF, and bid attachments
- `supabase/live_schema_snapshot.sql`
- `supabase/migrations/20260811_harden_authorization_foundation_rls.sql` through `20260817_add_stripe_webhook_event_idempotency.sql`
- `reports/supabase-production-final-security-verification.md`
- `reports/supabase-two-tenant-runtime-security-test.md`
- `reports/supabase-storage-hardening.md`
- `reports/webhooks-rate-limits-sensitive-writes-followup.md`
- security regression tests listed under `tests/*security*.test.js`

No runtime tests were executed during this final prompt because the prompt was read-only.

## Findings

### HIGH - STOR-001 - Supabase Storage is used by launch-scope code but is not runtime-certified

Affected files/routes/objects:

- `src/services/bizzyDocs/storageUploads.js`
- `src/pages/Docs/DocDetail.jsx`
- `src/components/BizzyDocs/UploadDocModal.jsx`
- `src/components/Accounting/PNLArchiveViewer.jsx`
- `src/api/accounting/pnlPdfService.js`
- `src/api/jobCosting/routes/jobCosting.bidBuilder.routes.js`
- Storage buckets expected by code: `bizzy-docs`, `financial-reports`, `bid-attachments`

Exploit prerequisites: an authenticated customer account, knowledge or discovery of another business UUID/path, or anonymous access if any future bucket is public.

Realistic attack: User A attempts to list, download, sign, overwrite, upload into, or delete objects under Business B's Storage path. For `bizzy-docs`, the browser directly uploads and downloads object bytes using paths of the form `<business_id>/<hash>.<ext>`. For `financial-reports`, backend signing exists, but `PNLArchiveViewer` still has a browser `createSignedUrl` fallback. For `bid-attachments`, backend upload returns `getPublicUrl`, which is unsafe for private customer/job files unless the product explicitly accepts public attachment access.

Impact: potential customer document, financial report, or job attachment exposure or tampering if buckets are created without strict `storage.objects` policies. This is not proven exploitable because staging previously had `0` Storage buckets and `0` Storage policies, but that also means the feature was not security-certified.

Existing mitigations: document metadata APIs are mounted behind `requireAuth` and `requireBusinessAccess`; object paths encode `business_id`; backend P&L generation uses service-role signing after tenant-scoped API access.

Actual weakness: no real Storage bucket or policy state has been runtime-tested. Current code includes direct browser Storage access that depends on bucket policies that do not yet exist in the certified staging state.

Correction recommended: before enabling file workflows for production customers, create private buckets, add path-scoped Storage RLS policies using the established business membership helper, remove or backend-proxy direct browser signing for `financial-reports`, replace `bid-attachments` public URLs with tenant-authorized signed URLs, and run two-tenant Storage attack tests.

Confidence: HIGH.

Launch blocker: YES if Bizzy Docs, P&L archive PDFs, or bid attachments are included in launch.

### HIGH - STRIPE-001 - Stripe idempotency table migration is an operational prerequisite for the current webhook handler

Affected files/routes/objects:

- `POST /api/billing/webhook`
- `src/api/billing/billing.routes.js`
- `src/api/billing/stripeWebhookIdempotency.js`
- `supabase/migrations/20260817_add_stripe_webhook_event_idempotency.sql`
- table expected by code: `public.stripe_webhook_events`

Exploit prerequisites: none for the operational failure mode; Stripe can deliver a valid signed webhook.

Realistic attack/failure: if the code containing durable idempotency is deployed before the `stripe_webhook_events` table exists, the webhook verifies the Stripe signature, then fails while claiming the event. That fails closed and does not grant attacker access, but billing/subscription state will not update from valid Stripe events.

Impact: billing state drift, failed subscription activation/cancellation updates, and operational launch failure for billing. It is not a cross-tenant data exposure.

Existing mitigations: Stripe signatures are verified with the raw body before idempotency claim. The migration creates a unique `event_id`, status fields, RLS enabled, no browser grants, and service-role access only. Current code supports retry of failed events and stale processing lease reclamation.

Actual weakness: this final read-only audit did not connect to production and cannot prove `20260817_add_stripe_webhook_event_idempotency.sql` has been applied to the target launch database.

Correction recommended: apply and verify the migration in staging and production before deploying the current webhook code, then rerun the Stripe idempotency tests or a signed Stripe CLI replay test in staging.

Confidence: MEDIUM, because this is deployment-state dependent.

Launch blocker: YES until the migration is confirmed applied where the current code will run.

### MEDIUM - RATE-001 - Application rate limits are in-memory and per-process

Affected files/routes/objects:

- `src/api/_shared/rateLimit.js`
- `src/api/tax/taxSecurity.js`
- high-cost routes under GPT, insights, marketing, Plaid, QBO/job-costing, docs summarization, and tax

Exploit prerequisites: anonymous access for public/auth flows or a valid authenticated account for private high-cost routes.

Realistic attack: a malicious customer distributes requests across IPs, server instances, or restarts to exceed the intended per-minute limits and create OpenAI/provider/database cost.

Impact: provider cost abuse, external API quota pressure, and local resource exhaustion. Tenant isolation remains protected.

Existing mitigations: major high-cost routes are authenticated, tenant-scoped, and rate-limited; GPT usage accounting exists; file upload limits are explicit.

Actual weakness: limits are not durable or shared across horizontally scaled instances.

Correction recommended: move high-cost and auth-flow limits to a shared store such as Redis/Upstash or a managed gateway/WAF before broad public traffic.

Confidence: HIGH.

Launch blocker: NO for a controlled initial customer launch; YES for open self-serve/high-volume launch.

### MEDIUM - GMAIL-001 - Gmail OAuth state is signed and time-limited but not durable or single-use

Affected files/routes/objects:

- `GET /api/email/connect`
- `GET /api/email/callback`
- `src/api/email/gmail.auth.js`

Exploit prerequisites: attacker obtains a valid Gmail OAuth callback URL or state value within the 10 minute validity window.

Realistic attack: replay of the same signed state is attempted. Google authorization codes are normally one-time use, so a replay using the same code should fail at Google, but Bizzi itself does not record and consume a nonce.

Impact: defense-in-depth gap around OAuth replay; no confirmed token theft or tenant confusion was found in static review.

Existing mitigations: HMAC state, timing-safe comparison, timestamp expiry, production requires a state secret, token exchange happens server-side, tokens are encrypted server-side.

Actual weakness: no persisted nonce/consume-once table equivalent to the QuickBooks OAuth state flow.

Correction recommended: move Gmail OAuth state to a durable one-time table with expiry and consume semantics, matching the QBO state pattern.

Confidence: MEDIUM.

Launch blocker: NO unless Gmail integration is a critical launch feature with high abuse exposure.

### MEDIUM - TEST-001 - Storage attack paths are not covered by the runtime security harness

Affected files/routes/objects:

- `scripts/runStagingTwoTenantRlsAttackTest.js`
- Storage buckets: `bizzy-docs`, `financial-reports`, `bid-attachments`

Exploit prerequisites: staging buckets and policies exist.

Realistic attack: User A attempts Business B object list/download/upload/overwrite/delete and anonymous attempts private object access.

Impact: lack of regression coverage for the customer-file boundary.

Existing mitigations: no staging buckets existed during the 6L-A audit, so no false pass was claimed.

Actual weakness: the current `570 passed / 0 failed` harness certifies database/RLS, view/RPC/function, grant, and sequence behavior, but not Storage objects.

Correction recommended: extend the harness after staging buckets are created with real two-tenant Storage object tests.

Confidence: HIGH.

Launch blocker: YES if customer file workflows are enabled.

### LOW - BILLING-001 - Stripe mark-processed failure after successful side effects can cause later retry of an already-applied event

Affected files/routes/objects:

- `src/api/billing/billing.routes.js`
- `src/api/billing/stripeWebhookIdempotency.js`

Exploit prerequisites: a rare database/network failure after billing side effects succeed but before `processing_status` is marked `processed`.

Realistic attack/failure: the event remains `processing`, then a stale lease can later be reclaimed and the event can run again.

Impact: most reviewed billing writes are idempotent updates/upserts against Stripe-derived state, so this is primarily operational noise. If future webhook cases add non-idempotent side effects, risk increases.

Existing mitigations: unique event ID prevents concurrent duplicates; failed attempts are retryable; processed events are skipped; Stripe is authoritative.

Actual weakness: no outbox/transactionally coupled side-effect marker exists across Stripe API calls and database updates.

Correction recommended: keep webhook side effects idempotent and add tests for each new webhook event type.

Confidence: MEDIUM.

Launch blocker: NO.

### INFO - DB-001 - Production public database/RLS layer is certified by prior runtime and snapshot review

Affected files/routes/objects:

- `supabase/live_schema_snapshot.sql`
- `reports/supabase-production-final-security-verification.md`
- `reports/supabase-two-tenant-runtime-security-test.md`

Result: production public database/RLS verification passed. The staging two-tenant runtime harness reported `570 passed / 0 failed`. The production snapshot review found no unsafe `USING (true)`, no unsafe `WITH CHECK (true)`, no `business_id = auth.uid()` tenant confusion, no unsafe public views, and no browser-callable internal RPCs.

Launch blocker: NO.

### INFO - SECRET-001 - No browser-visible server credential path was found in the reviewed frontend graph

Affected files/routes/objects:

- `src/services/supabaseClient.js`
- `src/services/supabaseAdmin.js`
- frontend env usage under `src`

Result: browser Supabase uses `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. Server secrets such as OpenAI, Plaid, QBO, Stripe, Google/Gmail, SMTP, webhook, encryption, and Supabase service-role variables are referenced in server modules. `supabaseAdmin.js` returns a non-secret browser stub if mistakenly imported client-side.

Launch blocker: NO.

### INFO - AUTH-001 - Canonical API authentication and tenant middleware are present on major private mounts

Affected files/routes/objects:

- `src/server.js`
- `src/api/gpt/middlewares/requireAuth.js`
- `src/api/_shared/tenantAuth.js`
- `tests/privateRouteMounts.security.test.js`

Result: `requireAuth` verifies Supabase access tokens through Supabase admin or JWKS and derives identity from the token. `requireBusinessAccess` independently resolves the requested business through `business_profiles.user_id` or `user_business_link`. Major business-scoped API mounts use `requireAuth` plus `requireBusinessAccess`. Production refuses startup if investment auth-bypass flags are enabled.

Launch blocker: NO.

## Area Assessment

| Area | Assessment |
| --- | --- |
| Authentication | No private-operation auth bypass found in reviewed major mounts; identity is derived from verified Supabase auth. |
| Tenant authorization | API and direct Supabase database paths are protected by canonical middleware and hardened RLS. |
| IDOR | Major object routes are behind tenant context or query by authorized business; possession of Business B UUID is insufficient for reviewed major API and database paths. |
| Frontend secrets | No server secret in browser env/code path found. |
| Server secrets | Error handler and provider-specific redaction reduce leakage; no intentional secret-returning API found. |
| Service role | Broad service-role usage exists, but major browser entrypoints establish auth/tenant context before service-role operations; RLS bypass is understood. |
| Supabase RLS | Production public DB/RLS layer previously verified as pass; Storage excluded. |
| OAuth/providers | QBO state is durable/single-use; Plaid token exchange is backend tenant-scoped; Gmail state is signed but not durable/single-use. |
| Webhooks/replay | Stripe and QBO webhook signatures are verified before mutation; Stripe durable idempotency now exists in code/migration but migration application must be confirmed. |
| Rate limits/abuse | Meaningful route limits exist for high-cost paths, but are in-memory/per-process. |
| Mass assignment | No obvious direct request-body database write pattern found in backend API/service search. |
| Billing | Client cannot set paid state directly; billing state comes from server/Stripe flows. |
| Error/logging | Production global errors are sanitized; some route-level logs include provider metadata in non-production. |
| CORS/CSRF | CORS uses an allowlist with localhost only outside production; bearer-token auth limits CSRF exposure. Cookie token fallback exists, so continue avoiding broad credentialed origins. |
| Input validation | Zod and explicit parsing exist in many sensitive routes; file upload size/count limits exist. No command injection path found. |
| File/Storage | Not launch-certified; this is the primary blocker. |
| Dependencies | No dependency audit was run in this read-only prompt. High-risk packages include file upload, PDF/HTML rendering, and Markdown/HTML handling; app-level guards exist but dependency audit should be run in CI. |
| Production config | Production startup blocks dev auth bypass flags; QBO production mode is enforced in production. Verify all production envs before launch. |
| Test coverage | Strong auth/tenant/RLS/webhook/provider regression coverage exists; Storage runtime tests are missing. |

## Attacker Walkthrough

### Attacker 1 - Anonymous Internet User

Anonymous users can reach health/ping endpoints, provider callbacks, Stripe/QBO webhooks, and public hero/insights health surfaces. Stripe and QBO webhooks verify signatures before mutation. The public database/RLS snapshot denies anonymous private row access. Anonymous Storage access cannot be certified until buckets and policies exist.

### Attacker 2 - Legitimate Customer A

For reviewed API/database paths, User A cannot use Business B's UUID to read or mutate Business B data. `requireBusinessAccess` verifies ownership/membership, and the staging two-tenant runtime harness passed cross-tenant database attacks. Storage remains unknown until bucket policies are tested.

### Attacker 3 - Malicious Customer

Mass assignment of core protected fields was not found in direct backend write patterns. High-cost routes require auth and have limits, but the limits are per-process. Billing state cannot be forged through client payloads because checkout/portal/status flows verify ownership and Stripe relationships server-side.

### Attacker 4 - Browser Bundle Inspector

No Supabase service-role key, OpenAI key, Plaid secret, QBO secret, Stripe secret, webhook secret, SMTP credential, Google secret, or encryption key was found in reviewed browser-importable env/code paths. Browser-visible Supabase configuration is limited to project URL and anon key.

### Attacker 5 - Replayer

Stripe duplicate events are guarded by durable `event.id` idempotency when the migration is applied. QBO OAuth state is consumed from a server-side table. Gmail OAuth state has HMAC/TTL but not single-use server persistence. Sensitive writes generally rely on auth/tenant middleware rather than replay tokens; rate limits reduce but do not eliminate replay of allowed actions.

## Required Final Questions

- Can a logged-in customer access only businesses they are authorized for? **YES for reviewed API/database paths; UNKNOWN for Storage until bucket policies are created and tested.**
- Can any browser obtain a third-party secret or server credential? **NO known path found.**
- Can User A read or mutate User B / Business B private data? **NO through reviewed public database/RLS and major API paths; UNKNOWN through Storage until certified.**
- Can User A elevate their tenant role or ownership? **NO known path found; database policies and immutable triggers block this.**
- Can anonymous users obtain private customer information? **NO through reviewed API/database paths; UNKNOWN for future Storage bucket configuration.**
- Can provider tokens be retrieved from frontend/API/database browser access? **NO known path found.**
- Can service-role usage be abused cross-tenant? **NO confirmed abuse path found, but service role remains high-impact and depends on route-level auth/tenant checks.**
- Can any private API route be invoked without valid authentication? **NO confirmed private-route bypass found in reviewed major mounts.**
- Can any sensitive write be performed without tenant authorization? **NO confirmed path found.**
- Can webhooks be forged or replayed dangerously? **NO for Stripe/QBO forgery. Stripe replay is protected after the idempotency migration is applied; Gmail OAuth state replay has a non-blocking durable-state gap.**
- Are high-cost endpoints protected against obvious abuse? **PARTIAL. They are authenticated and rate-limited, but limits are in-memory and per-process.**
- Can billing/subscription state be forged by the client? **NO known path found.**
- Do production errors disclose sensitive implementation details? **NO confirmed production path; global error handling sanitizes 500s.**
- Is CORS/CSRF configuration safe for the actual auth model? **YES for bearer-token API usage with the current allowlist; keep credentialed origins narrow because cookie token fallback exists.**
- Does any unresolved Storage issue expose customer files? **UNKNOWN, and therefore not launch-certified. Current code uses customer-file Storage paths, so this is a launch blocker if those features are enabled.**
- Are there any CRITICAL findings? **NO.**
- Are there any HIGH findings? **YES: Storage is not certified for customer-file workflows; Stripe idempotency migration application is an operational prerequisite.**
- Is there any known security issue that should block first customer onboarding? **YES if Storage-backed customer file features are enabled for onboarding customers. Otherwise, Storage must be explicitly disabled/deferred.**
- Is the application reasonably secure for initial production customers? **PARTIAL. The database/API core is strong; Storage must be locked down or disabled before launch.**
- Is it safe to launch from a security perspective? **NO, unless Storage-backed features are disabled or Storage policies/tests are completed first and the Stripe idempotency migration is confirmed applied.**

## Launch Requirements Before PASS

1. Create/copy staging Storage buckets for `bizzy-docs`, `financial-reports`, and `bid-attachments`.
2. Make buckets private unless a documented product decision says otherwise.
3. Add `storage.objects` policies scoped by bucket and first path segment `business_id`, using the canonical business membership model.
4. Replace `bid-attachments` `getPublicUrl` behavior with backend-issued signed URLs or explicitly remove it from launch.
5. Remove or backend-proxy browser `financial-reports.createSignedUrl` fallback, or prove Storage policies safely constrain it.
6. Extend and run the two-tenant runtime harness for Storage list/download/upload/overwrite/delete and anonymous access.
7. Confirm `20260817_add_stripe_webhook_event_idempotency.sql` is applied before deploying current Stripe webhook code.

FINAL PRE-LAUNCH SECURITY AUDIT: FAIL - LAUNCH BLOCKERS REMAIN
