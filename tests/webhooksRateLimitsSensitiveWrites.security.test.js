import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRateLimiter, __resetRateLimitBucketsForTests } from "../src/api/_shared/rateLimit.js";
import { claimStripeWebhookEventForProcessing } from "../src/api/billing/stripeWebhookIdempotency.js";

const root = process.cwd();
const serverSource = readFileSync(join(root, "src/server.js"), "utf8");
const billingSource = readFileSync(join(root, "src/api/billing/billing.routes.js"), "utf8");
const stripeIdempotencySource = readFileSync(join(root, "src/api/billing/stripeWebhookIdempotency.js"), "utf8");
const qboWebhookSource = readFileSync(join(root, "src/api/qbo/qboJobCostingWebhooks.routes.js"), "utf8");
const qboWebhookServiceSource = readFileSync(join(root, "src/services/jobCosting/qboOngoingSyncService.js"), "utf8");
const stripeIdempotencyMigration = readFileSync(join(root, "supabase/migrations/20260817_add_stripe_webhook_event_idempotency.sql"), "utf8");
const signupSource = readFileSync(join(root, "src/api/auth/signupConfirmation.routes.js"), "utf8");
const gptSource = readFileSync(join(root, "src/api/gpt/brain/gpt.routes.js"), "utf8");
const plaidSource = readFileSync(join(root, "src/api/integrations/plaid.routes.js"), "utf8");
const adminSource = readFileSync(join(root, "src/api/admin/monthlyReview.routes.js"), "utf8");
const gmailAuthSource = readFileSync(join(root, "src/api/email/gmail.auth.js"), "utf8");
const investmentsControllerSource = readFileSync(join(root, "src/api/investments/investments.controller.js"), "utf8");
const jobsSource = readFileSync(join(root, "src/api/Jobs/jobs.routes.js"), "utf8");
const insightsSource = readFileSync(join(root, "src/api/insights/insights.routes.js"), "utf8");
const bidBuilderSource = readFileSync(join(root, "src/api/jobCosting/routes/jobCosting.bidBuilder.routes.js"), "utf8");
const changeOrdersSource = readFileSync(join(root, "src/api/jobCosting/routes/jobCosting.changeOrders.routes.js"), "utf8");

test.afterEach(() => {
  __resetRateLimitBucketsForTests();
});

test("Stripe webhook uses raw body and fails closed through constructEvent", () => {
  assert.match(serverSource, /app\.post\(\s*"\/api\/billing\/webhook",\s*express\.raw\(\{ type: "application\/json" \}\),\s*billingWebhookHandler/s);
  assert.match(billingSource, /stripe\.webhooks\.constructEvent\(req\.body, sig, STRIPE_WEBHOOK_SECRET_ACTIVE\)/);
  assert.match(billingSource, /if \(!STRIPE_WEBHOOK_SECRET_ACTIVE\)/);
  assert.match(billingSource, /return res\.status\(400\)\.json\(\{\s*ok: false,\s*error: "invalid_signature"/s);
});

test("Stripe webhook claims durable event id before side effects and skips duplicates", () => {
  assert.match(stripeIdempotencyMigration, /CREATE TABLE IF NOT EXISTS public\.stripe_webhook_events/);
  assert.match(stripeIdempotencyMigration, /CONSTRAINT stripe_webhook_events_event_id_key UNIQUE \(event_id\)/);
  assert.match(stripeIdempotencyMigration, /processing_started_at timestamptz/);
  assert.match(stripeIdempotencyMigration, /attempt_count integer NOT NULL DEFAULT 0/);
  assert.match(stripeIdempotencyMigration, /ALTER TABLE public\.stripe_webhook_events ENABLE ROW LEVEL SECURITY/);
  assert.match(stripeIdempotencyMigration, /REVOKE ALL ON TABLE public\.stripe_webhook_events FROM authenticated/);
  assert.match(billingSource, /claimStripeWebhookEventForProcessing\(\{/);
  assert.match(stripeIdempotencySource, /existing\?\.processing_status === "processed"/);
  assert.match(stripeIdempotencySource, /existing\?\.processing_status === "failed"/);
  assert.match(stripeIdempotencySource, /\.lt\("processing_started_at", staleBeforeIso\)/);
  assert.match(billingSource, /return res\.json\(\{ received: true, duplicate: true \}\)/);
  assert.match(billingSource, /claimStripeWebhookEventForProcessing\(\{[\s\S]*?tableName: STRIPE_WEBHOOK_EVENTS_TABLE,[\s\S]*?\}\)[\s\S]*?const touchBilling = async/);
  assert.match(billingSource, /markStripeWebhookEventProcessed\(event\.id\)/);
  assert.match(billingSource, /markStripeWebhookEventFailed\(event\.id, err\)/);
});

function createStripeEventStore(initialRows = []) {
  const rows = new Map(initialRows.map((row) => [row.event_id, { ...row }]));

  function makeBuilder(operation, payload = null) {
    const filters = [];
    const builder = {
      insert(row) {
        return makeBuilder("insert", row);
      },
      update(row) {
        return makeBuilder("update", row);
      },
      select() {
        if (operation === "insert") {
          if (rows.has(payload.event_id)) {
            return {
              single: async () => ({ data: null, error: { code: "23505", message: "duplicate key" } }),
            };
          }
          const row = { id: `row_${rows.size + 1}`, ...payload };
          rows.set(row.event_id, row);
          return { single: async () => ({ data: { ...row }, error: null }) };
        }
        if (operation === "update") {
          const matches = [...rows.values()].filter((row) => filters.every((filter) => {
            if (filter.op === "eq") return row[filter.column] === filter.value;
            if (filter.op === "lt") return row[filter.column] < filter.value;
            return false;
          }));
          const updated = matches.map((row) => {
            const next = { ...row, ...payload };
            rows.set(row.event_id, next);
            return { ...next };
          });
          return Promise.resolve({ data: updated, error: null });
        }
        return builder;
      },
      eq(column, value) {
        filters.push({ op: "eq", column, value });
        return builder;
      },
      lt(column, value) {
        filters.push({ op: "lt", column, value });
        return builder;
      },
      maybeSingle: async () => {
        const row = [...rows.values()].find((candidate) => filters.every((filter) => {
          if (filter.op === "eq") return candidate[filter.column] === filter.value;
          if (filter.op === "lt") return candidate[filter.column] < filter.value;
          return false;
        }));
        return { data: row ? { ...row } : null, error: null };
      },
    };
    return builder;
  }

  return {
    rows,
    from() {
      return makeBuilder("select");
    },
  };
}

test("Stripe idempotency claim handles new, processed, failed, stale, and active leases", async () => {
  const now = new Date("2026-08-11T12:00:00.000Z");
  const event = { id: "evt_retry_semantics", type: "invoice.paid" };

  const firstStore = createStripeEventStore();
  const first = await claimStripeWebhookEventForProcessing({ supabaseClient: firstStore, event, now, leaseMs: 300_000 });
  assert.equal(first.claimed, true);
  assert.equal(first.status, "new");
  assert.equal(first.row.attempt_count, 1);

  const processedStore = createStripeEventStore([{
    event_id: event.id,
    processing_status: "processed",
    processing_started_at: null,
    attempt_count: 1,
  }]);
  const processed = await claimStripeWebhookEventForProcessing({ supabaseClient: processedStore, event, now, leaseMs: 300_000 });
  assert.equal(processed.claimed, false);
  assert.equal(processed.status, "processed");

  const failedStore = createStripeEventStore([{
    event_id: event.id,
    processing_status: "failed",
    processing_started_at: "2026-08-11T11:58:00.000Z",
    attempt_count: 1,
  }]);
  const failedRetry = await claimStripeWebhookEventForProcessing({ supabaseClient: failedStore, event, now, leaseMs: 300_000 });
  assert.equal(failedRetry.claimed, true);
  assert.equal(failedRetry.status, "reclaimed_failed");
  assert.equal(failedRetry.row.attempt_count, 2);

  const staleStore = createStripeEventStore([{
    event_id: event.id,
    processing_status: "processing",
    processing_started_at: "2026-08-11T11:50:00.000Z",
    attempt_count: 2,
  }]);
  const staleRetry = await claimStripeWebhookEventForProcessing({ supabaseClient: staleStore, event, now, leaseMs: 300_000 });
  assert.equal(staleRetry.claimed, true);
  assert.equal(staleRetry.status, "reclaimed_stale_processing");
  assert.equal(staleRetry.row.attempt_count, 3);

  const activeStore = createStripeEventStore([{
    event_id: event.id,
    processing_status: "processing",
    processing_started_at: "2026-08-11T11:59:00.000Z",
    attempt_count: 1,
  }]);
  const activeRetry = await claimStripeWebhookEventForProcessing({ supabaseClient: activeStore, event, now, leaseMs: 300_000 });
  assert.equal(activeRetry.claimed, false);
  assert.equal(activeRetry.status, "active_processing");
});

test("QuickBooks webhook verifies Intuit signature before storing events", () => {
  assert.match(qboWebhookSource, /express\.raw\(\{ type: "application\/json" \}\)/);
  assert.match(qboWebhookSource, /verifyQuickBooksWebhookSignature\(\{/);
  assert.match(qboWebhookSource, /return res\.status\(401\)\.json\(\{ ok: false, error: "invalid_qbo_webhook_signature" \}\)/);
  assert.match(qboWebhookSource, /storeQuickBooksWebhookEvents\(\{/);
  assert.match(qboWebhookSource, /if \(!verifyQuickBooksWebhookSignature\(\{[\s\S]*?\}\)\) \{[\s\S]*?invalid_qbo_webhook_signature[\s\S]*?\}[\s\S]*?storeQuickBooksWebhookEvents\(\{/);
  assert.match(qboWebhookServiceSource, /crypto\.createHmac\("sha256", verifierToken\)\.update\(body\)\.digest\("base64"\)/);
  assert.match(qboWebhookServiceSource, /crypto\.timingSafeEqual/);
});

test("QuickBooks webhook stores durable duplicate keys", () => {
  assert.match(qboWebhookServiceSource, /buildWebhookEventHash/);
  assert.match(qboWebhookServiceSource, /\.from\("qbo_webhook_events"\)[\s\S]*\.eq\("event_hash", eventHash\)/);
  assert.match(qboWebhookServiceSource, /duplicates \+= 1/);
});

test("high-abuse auth and provider routes have explicit app-side throttles", () => {
  assert.match(signupSource, /createRateLimiter\(\{/);
  assert.match(signupSource, /signup-confirmation", signupConfirmationRateLimit,/);
  assert.match(gptSource, /const aiGenerateRateLimit = createRateLimiter/);
  assert.match(gptSource, /router\.post\('\/generate',\s+\.\.\.privateBusinessRoute, aiGenerateRateLimit,/);
  assert.match(plaidSource, /const plaidMutationRateLimit = createRateLimiter/);
  assert.match(plaidSource, /router\.post\("\/sync", requireAuth, plaidMutationRateLimit,/);
  assert.match(jobsSource, /const highCostJobRouteRateLimit = createRateLimiter/);
  assert.match(jobsSource, /router\.post\("\/qbo\/job-costing\/sync", requireAuth, highCostJobRouteRateLimit,/);
  assert.match(jobsSource, /router\.post\("\/suggestions\/generate", requireAuth, highCostJobRouteRateLimit,/);
  assert.match(insightsSource, /const insightGenerationRateLimit = createRateLimiter/);
  assert.match(insightsSource, /router\.post\('\/generate', \.\.\.privateBusinessRoute, insightGenerationRateLimit,/);
  assert.match(changeOrdersSource, /const changeOrderHighCostRateLimit = createRateLimiter/);
  assert.match(changeOrdersSource, /router\.post\("\/change-orders\/recommend-price", requireRouteAuth, changeOrderHighCostRateLimit,/);
});

test("multipart uploads have explicit global and route-level file limits", () => {
  assert.match(serverSource, /const MAX_UPLOAD_FILE_SIZE_BYTES = Number/);
  assert.match(serverSource, /limits: \{ fileSize: MAX_UPLOAD_FILE_SIZE_BYTES \}/);
  assert.match(serverSource, /abortOnLimit: true/);
  assert.match(serverSource, /const MAX_UPLOAD_FILE_COUNT = Number/);
  assert.match(serverSource, /files\.length > MAX_UPLOAD_FILE_COUNT/);
  assert.match(bidBuilderSource, /const MAX_BID_ATTACHMENT_BYTES = Number/);
  assert.match(bidBuilderSource, /file\.truncated \|\| Number\(file\.size \|\| file\.data\.length \|\| 0\) > MAX_BID_ATTACHMENT_BYTES/);
  assert.match(bidBuilderSource, /attachment_file_too_large/);
});

test("manual investment position write uses an explicit allowlist and server-derived user id", () => {
  assert.doesNotMatch(investmentsControllerSource, /const body = \{ \.\.\.req\.body, user_id \}/);
  assert.match(investmentsControllerSource, /const user_id = getUserId\(req\)/);
  assert.match(investmentsControllerSource, /const body = \{\s*user_id,/s);
  assert.match(investmentsControllerSource, /account_name: req\.body\?\.account_name \|\| req\.body\?\.accountName/);
  assert.match(investmentsControllerSource, /cost_basis_total: req\.body\?\.cost_basis_total \?\? req\.body\?\.costBasisTotal/);
});

test("shared rate limiter rejects requests over the configured bucket limit", () => {
  const limiter = createRateLimiter({
    windowMs: 60_000,
    max: 1,
    key: (req) => req.ip,
    code: "test_limited",
  });
  const req = { ip: "203.0.113.10", headers: {}, socket: {} };
  const responses = [];
  const makeRes = () => ({
    statusCode: 200,
    headers: {},
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      responses.push({ statusCode: this.statusCode, body, headers: this.headers });
      return this;
    },
  });

  let nextCount = 0;
  limiter(req, makeRes(), () => {
    nextCount += 1;
  });
  limiter(req, makeRes(), () => {
    nextCount += 1;
  });

  assert.equal(nextCount, 1);
  assert.equal(responses[0].statusCode, 429);
  assert.equal(responses[0].body.error, "test_limited");
  assert.equal(responses[0].headers["Retry-After"], "60");
});

test("Gmail OAuth state has no production default secret and enforces signed expiry checks", () => {
  assert.match(gmailAuthSource, /process\.env\.NODE_ENV === 'production' \? '' : 'dev-state-secret'/);
  assert.match(gmailAuthSource, /GMAIL_OAUTH_STATE_SECRET_REQUIRED/);
  assert.match(gmailAuthSource, /crypto\.timingSafeEqual/);
  assert.match(gmailAuthSource, /STATE_MAX_AGE_MS = 10 \* 60 \* 1000/);
  assert.match(gmailAuthSource, /Date\.now\(\) - issuedAt > STATE_MAX_AGE_MS/);
});

test("internal monthly review admin does not trust self-editable user profile role", () => {
  assert.match(adminSource, /router\.use\(requireAuth\)/);
  assert.match(adminSource, /router\.use\(requireInternalRole\(MONTHLY_REVIEW_STAFF_ROLES\)\)/);
  assert.match(adminSource, /from\("internal_staff_users"\)/);
  assert.doesNotMatch(adminSource, /router\.use\(requireInternalAdmin\)/);
  assert.doesNotMatch(adminSource, /admin", "internal_admin", "bizzy_admin", "super_admin"/);
  assert.doesNotMatch(adminSource, /const role = String\(data\?\.role/);
  assert.doesNotMatch(adminSource, /\.select\("id,email,role"\)/);
  assert.doesNotMatch(adminSource, /\.select\("role,email"\)/);
  assert.doesNotMatch(adminSource, /allowedEmails\.has\(profileEmail\)/);
});
