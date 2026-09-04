// /src/server.js
/* global process */
import "dotenv/config";
import express from "express";
import fileUpload from "express-fileupload";
import morgan from "morgan";
import { getBackendBuildInfo } from "./utils/buildInfo.js";

// Accounting routers
import quickbooksAuth from "./api/auth/quickbooksAuth.js";
import socialAuthRouter from "./api/auth/socialAuth.js";
import signupConfirmationRouter from "./api/auth/signupConfirmation.routes.js";
import onboardingRouter from "./api/onboarding/onboarding.routes.js";
import financialMetricsRoute from "./api/accounting/metrics.js";
import pulseRoute from "./api/accounting/pulse.js";
import forecastRouter from "./api/accounting/forecast.js";
import forecastAccuracyRouter from "./api/accounting/forecastAccuracy.js";
import scenariosRouter from "./api/accounting/scenario.js";
import movesRoute from "./api/gpt/suggestedMovesEngine.js";
import revenueSeriesRouter from "./api/accounting/revenue-series.js";
import profitSeriesRouter from "./api/accounting/profit-series.js";
import reportsSyncRouter from "./api/accounting/reports-sync.js";
import pnlPdfRouter from "./api/accounting/pnlPdf.routes.js";
import bookkeepingRouter from "./api/accounting/bookkeeping.routes.js";
import expenseBreakdownRouter from "./api/accounting/expense-breakdown.js";
import healthAccountingRouter from "./api/accounting/health.routes.js";
import qboSyncRouter from "./api/accounting/qbo-sync.js";
import qboBackfillRouter from "./api/accounting/qbo-backfill.routes.js";
import qboJobCostingWebhooksRouter from "./api/qbo/qboJobCostingWebhooks.routes.js";
import arRouter from "./api/ar/ar.routes.js";
import bookkeepingPlaidRouter from "./api/bookkeeping/bookkeeping.routes.js";
import { startBooksPostingCron } from "./jobs/booksPost.cron.js";
import { startPlaidDailySyncCron } from "./cron/plaidSync.cron.js";
import { startBookkeepingProcessingWorker } from "./cron/bookkeepingProcessing.cron.js";
import { startOperatorRequestSummaryCron } from "./cron/operatorRequestSummary.cron.js";
import { startReconciliationCron } from "./cron/reconciliation.cron.js";
import { startQboJobCostingSyncCron } from "./cron/qboJobCostingSync.cron.js";
import { startQboFinancialHealthCron } from "./cron/qboFinancialHealth.cron.js";
import { startMonthlyFinancialPulseCron } from "./cron/monthlyFinancialPulse.cron.js";
import { startContractorCfoInsightsCron } from "./services/insights/contractorCfoTriggerService.js";

// Marketing
import marketingRouter from "./api/marketing/marketing.routes.js";

import jobsRoutes from "./api/Jobs/jobs.routes.js";
import jobCostingChangeOrdersRouter from "./api/jobCosting/routes/jobCosting.changeOrders.routes.js";
import jobCostingBidBuilderRouter from "./api/jobCosting/routes/jobCosting.bidBuilder.routes.js";
import { startForecastCron } from "./jobs/forecast.cron.js";

// GPT & chats
import gptRoutes from "./api/gpt/brain/gpt.routes.js";
import chatsRoutes from "./api/chats/chats.routes.js";
import bizzyFollowupsRouter from "./api/bizzy/followups.routes.js";

// Other modules
import investmentsRouter from "./api/investments/investments.routes.js";
import calendarRoutes from "./api/calendar/calendar.routes.js";
import { reviewsRouter } from "./api/reviews/index.js";
import { billingRouter, billingWebhookHandler } from "./api/billing/billing.routes.js";
import docsRouter from "./api/docs/docs.routes.js";
import insightsRoutes from "./api/insights/insights.routes.js";
import affordabilityCheckHandler from "./api/accounting/affordabilityCheck.js";
import emailRouter from "./api/email/gmail.routes.js";
import { callback as gmailOAuthCallback } from "./api/email/gmail.auth.js";
import { qboEnvName } from "./utils/qboEnv.js";
import { validateTaxEnvironmentSafety } from "./services/tax/taxEnvironmentSafety.js";
import { startTaxRecalculationWorker } from "./services/tax/events/taxRecalculationWorker.service.js";
import { startTaxClassificationWorker } from "./services/tax/taxClassificationWorker.service.js";
import { startTaxScheduler } from "./services/tax/scheduling/taxScheduler.service.js";

// Tax (router)
import taxRouter from "./api/tax/index.js";

import bizzyInsightRouter from "./api/gpt/brain/bizzyInsight.js";
import { requireAuth } from "./api/gpt/middlewares/requireAuth.js";
import { rejectAdminViewWrites, requireAuthOrAdminView, requireBusinessAccess } from "./api/_shared/tenantAuth.js";
import plaidIntegrationsRouter from "./api/integrations/plaid.routes.js";
import { buildSafeErrorResponse, redactErrorForLog } from "./api/_shared/safeErrorResponse.js";

/* 🔹 NEW: Hero insights router */
import heroInsightsRouter from "./api/hero-insights/router.js";
import adminRouter from "./api/admin/admin.routes.js";
import monthlyReviewAdminRouter from "./api/admin/monthlyReview.routes.js";
import customerViewAdminRouter from "./api/admin/customerView.routes.js";
import adminViewRouter from "./api/adminView/adminView.routes.js";

const app = express();
const PORT = process.env.PORT || 5050;
const MAX_UPLOAD_FILE_SIZE_BYTES = Number(process.env.MAX_UPLOAD_FILE_SIZE_BYTES || 10 * 1024 * 1024);
const MAX_UPLOAD_FILE_COUNT = Number(process.env.MAX_UPLOAD_FILE_COUNT || 5);

app.disable("x-powered-by");

console.info("[QBO] QB_ENVIRONMENT:", qboEnvName);
validateTaxEnvironmentSafety();

/* ----------------------------- Stripe webhook FIRST (raw body) ----------------------------- */
app.post(
  "/api/billing/webhook",
  express.raw({ type: "application/json" }),
  billingWebhookHandler
);
app.use("/api/qbo/webhooks", qboJobCostingWebhooksRouter);
if (process.env.NODE_ENV !== "production") {
  console.log("[billing] webhook mounted", {
    route: "/api/billing/webhook",
    hasStripeWebhookSecret: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
  });
}

/* ---------------------------------------- CORS ---------------------------------------- */
const allowlist = (() => {
  const list = [
    "https://app.bizzios.com",
    "https://admin.bizzios.com",
    "https://bizzios.com",
    "https://www.bizzios.com",
    "https://bizzi-ten.vercel.app",
  ];
  const raw = process.env.CORS_ORIGINS || process.env.CORS_ORIGIN || "";
  raw
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
    .forEach((o) => {
      if (!list.includes(o)) list.push(o);
    });
  if (process.env.NODE_ENV !== "production") {
    const local = "http://localhost:5173";
    if (!list.includes(local)) list.push(local);
    console.log("[CORS] allowed origins (dev):", list);
  }
  return list;
})();
const allowAll = allowlist.length === 0;

console.info("[CORS] Allowlist:", allowAll ? "(all origins)" : allowlist);

const ALLOWED_METHODS = "GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD";

// Explicit preflight guard for /api/* to guarantee headers (before any routes)
app.use((req, res, next) => {
  if (!req.path.startsWith("/api/") && !req.path.startsWith("/auth/")) return next();
  const origin = req.headers.origin;
  const isAllowedOrigin = allowAll || (origin && allowlist.includes(origin));
  if (origin && isAllowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);

  // Reflect requested headers when provided, else fall back to a safe list
  const reqHeaders = req.headers["access-control-request-headers"];
  const headerSet = new Set(
    (reqHeaders && typeof reqHeaders === "string"
      ? reqHeaders.split(",").map((h) => h.trim())
      : ["Content-Type", "Authorization", "x-data-mode", "x-debug", "x-user-id", "x-business-id", "x-bizzi-admin-view"]
    ).filter(Boolean)
  );
  headerSet.add("x-data-mode");
  headerSet.add("x-bizzi-admin-view");
  res.setHeader("Access-Control-Allow-Headers", Array.from(headerSet).join(", "));
  res.setHeader("Vary", "Access-Control-Request-Headers");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  return next();
});

/* --------------------------------------- Logging -------------------------------------- */
if (process.env.NODE_ENV !== "test") app.use(morgan("tiny"));

/* ------------------------------------ Body parsers ------------------------------------ */
app.use(express.json({ limit: "5mb" }));
app.use(fileUpload({
  useTempFiles: false,
  limits: { fileSize: MAX_UPLOAD_FILE_SIZE_BYTES },
  abortOnLimit: true,
  responseOnLimit: "Uploaded file is too large.",
}));
app.use((req, res, next) => {
  if (!req.files) return next();
  const files = Object.values(req.files).flatMap((item) => Array.isArray(item) ? item : [item]);
  if (files.length > MAX_UPLOAD_FILE_COUNT) {
    return res.status(413).json({
      ok: false,
      error: "too_many_files",
      message: `Upload at most ${MAX_UPLOAD_FILE_COUNT} files at a time.`,
    });
  }
  return next();
});

/* ------------------------------------ Healthcheck ------------------------------------- */
app.get("/healthz", (_req, res) => res.status(200).json({
  ok: true,
  build: getBackendBuildInfo(),
}));

/* ------------------------ Dev bypass for Investments (no token) ------------------------ */
const PROD_AUTH_BYPASS_FLAGS = [
  ["ALLOW_DEV_NO_TOKEN", process.env.ALLOW_DEV_NO_TOKEN],
  ["MOCK_INVESTMENTS", process.env.MOCK_INVESTMENTS],
].filter(([, value]) => value === "true");
if (process.env.NODE_ENV === "production" && PROD_AUTH_BYPASS_FLAGS.length) {
  throw new Error(
    `[server] Auth bypass flags cannot be enabled in production: ${PROD_AUTH_BYPASS_FLAGS
      .map(([key]) => key)
      .join(", ")}`
  );
}
const DEV_BYPASS =
  process.env.NODE_ENV !== "production" &&
  (process.env.ALLOW_DEV_NO_TOKEN === "true" ||
    process.env.MOCK_INVESTMENTS === "true");

const requireBusinessContext = requireBusinessAccess();
const requireCustomerOrAdminView = [requireAuthOrAdminView, requireBusinessContext, rejectAdminViewWrites()];
app.use((req, _res, next) => {
  if (DEV_BYPASS && req.path.startsWith("/api/investments")) {
    if (!req.headers["x-user-id"])
      req.headers["x-user-id"] = process.env.DEV_USER_ID || "dev-user";
    if (!req.headers["x-business-id"])
      req.headers["x-business-id"] = process.env.DEV_BUSINESS_ID || "dev-biz";
    if (!req.user) req.user = { id: req.headers["x-user-id"] };
  }
  next();
});

/* ---------------------------------- GPT & Chats ---------------------------------- */
app.use("/api/gpt", gptRoutes);
app.use("/api/chats", ...requireCustomerOrAdminView, chatsRoutes);
app.use("/api/bizzy", requireAuth, bizzyFollowupsRouter);

/* ------------------------------------ Accounting ----------------------------------- */
app.use("/api/auth", signupConfirmationRouter);
app.use("/api/onboarding", onboardingRouter);
app.use("/auth", quickbooksAuth);
app.use("/auth", socialAuthRouter);
app.use("/api/accounting/metrics", ...requireCustomerOrAdminView, financialMetricsRoute);
app.use("/api/accounting/pulse", ...requireCustomerOrAdminView, pulseRoute);
app.use("/api/accounting/moves", ...requireCustomerOrAdminView, movesRoute);
app.use("/api/accounting/expense-breakdown", ...requireCustomerOrAdminView, expenseBreakdownRouter);
app.use("/api/accounting/health", ...requireCustomerOrAdminView, healthAccountingRouter);
app.use("/api/accounting/revenue-series", ...requireCustomerOrAdminView, revenueSeriesRouter);
app.use("/api/accounting/profit-series", ...requireCustomerOrAdminView, profitSeriesRouter);
app.use("/api/accounting/reports-sync", ...requireCustomerOrAdminView, reportsSyncRouter);
app.use("/api/accounting/pnl", ...requireCustomerOrAdminView, pnlPdfRouter);
app.use("/api/accounting/forecast", ...requireCustomerOrAdminView, forecastRouter);
app.use("/api/accounting/forecast-accuracy", ...requireCustomerOrAdminView, forecastAccuracyRouter);
app.use("/api/accounting/scenarios", ...requireCustomerOrAdminView, scenariosRouter);
app.use("/api/accounting", ...requireCustomerOrAdminView, bookkeepingRouter);
app.use("/api/qbo", ...requireCustomerOrAdminView, qboSyncRouter);
app.use("/api/qbo/backfill", ...requireCustomerOrAdminView, qboBackfillRouter);
app.use("/api/ar", ...requireCustomerOrAdminView, arRouter);
app.use("/api/bookkeeping", ...requireCustomerOrAdminView, bookkeepingPlaidRouter);
app.post("/api/accounting/affordabilityCheck", ...requireCustomerOrAdminView, affordabilityCheckHandler);

/* ----------------------- Bizzy Insight (requires auth) ----------------------- */
app.use("/api/gpt/brain/bizzyInsight", requireAuth, bizzyInsightRouter);

/* ------------------------------ Email ------------------------------ */
/** 🔓 PUBLIC: Google OAuth callback must NOT require your JWT */
app.get("/api/email/callback", gmailOAuthCallback);

/** 🔐 2) All other email routes require auth. */
app.use("/api/email", requireAuth, emailRouter);

/* ------------------------------------ Marketing ------------------------------------ */
app.use("/api/marketing", ...requireCustomerOrAdminView, marketingRouter);

app.use("/api/jobs", ...requireCustomerOrAdminView, jobsRoutes);
app.use("/api/job-costing", ...requireCustomerOrAdminView, jobCostingChangeOrdersRouter);
app.use("/api/job-costing", ...requireCustomerOrAdminView, jobCostingBidBuilderRouter);
app.use("/api/job-costing", ...requireCustomerOrAdminView, jobsRoutes);

/* --------------------------- Investments & Calendar --------------------------- */
app.use("/api/investments", requireAuth, investmentsRouter);
app.use("/api/calendar", calendarRoutes);
app.get("/api/integrations/plaid/_ping", (_req, res) =>
  res.json({ ok: true, at: "plaid_routes_ping" })
);
app.use("/api/integrations/plaid", ...requireCustomerOrAdminView, plaidIntegrationsRouter);

/* -------------------------------- Reviews, Docs, Insights ------------------------------- */
app.use("/api/reviews", ...requireCustomerOrAdminView, reviewsRouter);
app.use("/api/docs", ...requireCustomerOrAdminView, docsRouter);
app.use("/api/insights", insightsRoutes);

/* -------------------------------- Tax (authenticated) -------------------------------- */
app.use("/api/tax", ...requireCustomerOrAdminView, taxRouter);

/* 🔹 NEW: Hero Insights API
   - Public by default so we can show curated mock hero before sync
   - If you want auth, change to: app.use("/api/hero-insights", requireAuth, heroInsightsRouter);
*/
app.use("/api/hero-insights", heroInsightsRouter);

/* -------------------------------- Internal Admin -------------------------------- */
app.use("/api/admin", adminRouter);
app.use("/api/admin/monthly-review", monthlyReviewAdminRouter);
app.use("/api/admin/customer-view", customerViewAdminRouter);
app.use("/api/admin-view", adminViewRouter);

/* ------------------------------- Billing REST (non-webhook) ------------------------------ */
app.use("/api/billing", express.json(), billingRouter);
if (process.env.NODE_ENV !== "production") {
  console.log("[billing] rest mounted", {
    route: "/api/billing",
    port: PORT,
    hasStripeWebhookSecret: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
  });
}

/* ----------------------------------------- Root ----------------------------------------- */
app.get("/", (_req, res) => res.send("Bizzy API is running"));

/* ---------------------------------------- API 404 --------------------------------------- */
app.use("/api", (req, res, next) => {
  if (res.headersSent) return next();
  return res
    .status(404)
    .json({ ok: false, error: `Not found: ${req.method} ${req.originalUrl}` });
});

/* ------------------------------------ Error handler ------------------------------------- */
app.use((err, _req, res, next) => {
  void next;
  console.error("[server] unhandled error:", redactErrorForLog({
    message: err?.message || err,
    code: err?.code || err?.errorCode || null,
    status: err?.status || err?.statusCode || null,
    meta: err?.meta || null,
  }));
  const { status, body } = buildSafeErrorResponse(err);
  res.status(status).json(body);
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

startForecastCron();
startBooksPostingCron();
startBookkeepingProcessingWorker();
startOperatorRequestSummaryCron();
startPlaidDailySyncCron();
startContractorCfoInsightsCron();
startTaxClassificationWorker();
startTaxRecalculationWorker();
startTaxScheduler();
startQboJobCostingSyncCron();
startQboFinancialHealthCron();
startMonthlyFinancialPulseCron();
if (String(process.env.DISABLE_RECON_CRON || "").toLowerCase() !== "true") {
  startReconciliationCron();
} else {
  console.info("[recon-cron] disabled via env");
}

export default app;
