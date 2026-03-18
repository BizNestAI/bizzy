// /src/server.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import fileUpload from "express-fileupload";
import morgan from "morgan";

// Accounting routers
import quickbooksAuth from "./api/auth/quickbooksAuth.js";
import socialAuthRouter from "./api/auth/socialAuth.js";
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
import qboSyncRouter from "./api/accounting/qbo-sync.js";
import qboBackfillRouter from "./api/accounting/qbo-backfill.routes.js";
import arRouter from "./api/ar/ar.routes.js";
import bookkeepingPlaidRouter from "./api/bookkeeping/bookkeeping.routes.js";
import { startBooksPostingCron } from "./jobs/booksPost.cron.js";
import { startPlaidDailySyncCron } from "./cron/plaidSync.cron.js";
import { startReconciliationCron } from "./cron/reconciliation.cron.js";

// Marketing
import marketingRouter from "./api/marketing/marketing.routes.js";

import jobsRoutes from "./api/Jobs/jobs.routes.js";
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

// Tax (router)
import taxRouter from "./api/tax/index.js";
import taxRoutes from "./api/tax/tax.routes.js";
import taxDeductionsRouter from "./api/tax/deductions.routes.js";

import bizzyInsightRouter from "./api/gpt/brain/bizzyInsight.js";
import { requireAuth } from "./api/gpt/middlewares/requireAuth.js";
import plaidIntegrationsRouter from "./api/integrations/plaid.routes.js";

/* 🔹 NEW: Hero insights router */
import heroInsightsRouter from "./api/hero-insights/router.js";

const app = express();
const PORT = process.env.PORT || 5050;

app.disable("x-powered-by");

console.info("[QBO] QB_ENVIRONMENT:", qboEnvName);

/* ----------------------------- Stripe webhook FIRST (raw body) ----------------------------- */
app.post(
  "/api/billing/webhook",
  express.raw({ type: "application/json" }),
  billingWebhookHandler
);
if (process.env.NODE_ENV !== "production") {
  console.log("[billing] webhook mounted", {
    route: "/api/billing/webhook",
    hasStripeWebhookSecret: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
  });
}

/* ---------------------------------------- CORS ---------------------------------------- */
const allowlist = (() => {
  const list = ["https://bizzi-ten.vercel.app"];
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
      : ["Content-Type", "Authorization", "x-data-mode", "x-debug", "x-user-id", "x-business-id"]
    ).filter(Boolean)
  );
  headerSet.add("x-data-mode");
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
app.use(fileUpload({ useTempFiles: false }));

/* ------------------------------------ Healthcheck ------------------------------------- */
app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));

/* ------------------------ Dev bypass for Investments (no token) ------------------------ */
const DEV_BYPASS =
  process.env.ALLOW_DEV_NO_TOKEN === "true" ||
  process.env.MOCK_INVESTMENTS === "true";
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
app.use("/api/chats", chatsRoutes);
app.use("/api/bizzy", bizzyFollowupsRouter);

/* ------------------------------------ Accounting ----------------------------------- */
app.use("/auth", quickbooksAuth);
app.use("/auth", socialAuthRouter);
app.use("/api/accounting/metrics", financialMetricsRoute);
app.use("/api/accounting/pulse", pulseRoute);
app.use("/api/accounting/moves", movesRoute);
app.use("/api/accounting/expense-breakdown", expenseBreakdownRouter);
app.use("/api/accounting/revenue-series", revenueSeriesRouter);
app.use("/api/accounting/profit-series", profitSeriesRouter);
app.use("/api/accounting/reports-sync", reportsSyncRouter);
app.use("/api/accounting/pnl", pnlPdfRouter);
app.use("/api/accounting/forecast", forecastRouter);
app.use("/api/accounting/forecast-accuracy", forecastAccuracyRouter);
app.use("/api/accounting/scenarios", scenariosRouter);
app.use("/api/accounting", bookkeepingRouter);
app.use("/api/qbo", qboSyncRouter);
app.use("/api/qbo/backfill", qboBackfillRouter);
app.use("/api/ar", arRouter);
app.use("/api/bookkeeping", bookkeepingPlaidRouter);
app.post("/api/accounting/affordabilityCheck", affordabilityCheckHandler);

/* ----------------------- Bizzy Insight (requires auth) ----------------------- */
app.use("/api/gpt/brain/bizzyInsight", requireAuth, bizzyInsightRouter);

/* ------------------------------ Email ------------------------------ */
/** 🔓 PUBLIC: Google OAuth callback must NOT require your JWT */
app.get("/api/email/callback", gmailOAuthCallback);

/** 🔐 2) All other email routes require auth. */
app.use("/api/email", requireAuth, emailRouter);

/* ------------------------------------ Marketing ------------------------------------ */
app.use("/api/marketing", marketingRouter);

app.use("/api/jobs", jobsRoutes);

/* --------------------------- Investments & Calendar --------------------------- */
app.use("/api/investments", requireAuth, investmentsRouter);
app.use("/api/calendar", calendarRoutes);
app.use("/api/integrations/plaid", plaidIntegrationsRouter);
app.get("/api/integrations/plaid/_ping", (_req, res) =>
  res.json({ ok: true, at: "plaid_routes_ping" })
);

/* -------------------------------- Reviews, Docs, Insights ------------------------------- */
app.use("/api/reviews", reviewsRouter);
app.use("/api/docs", docsRouter);
app.use("/api/insights", insightsRoutes);

/* -------------------------------- Tax (some behind auth) -------------------------------- */
app.use("/api/tax", requireAuth, taxRouter);
app.use("/api/tax", taxRoutes);
app.use("/api/tax/deductions", requireAuth, taxDeductionsRouter);

/* 🔹 NEW: Hero Insights API
   - Public by default so we can show curated mock hero before sync
   - If you want auth, change to: app.use("/api/hero-insights", requireAuth, heroInsightsRouter);
*/
app.use("/api/hero-insights", heroInsightsRouter);

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
app.use((err, _req, res, _next) => {
  console.error("[server] unhandled error:", err);
  const status = err.status || 500;
  const message = err.message || "Internal Server Error";
  const meta = err.meta || null;
  res.status(status).json({ ok: false, error: message, meta });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

startForecastCron();
startBooksPostingCron();
startPlaidDailySyncCron();
if (String(process.env.DISABLE_RECON_CRON || "").toLowerCase() !== "true") {
  startReconciliationCron();
} else {
  console.info("[recon-cron] disabled via env");
}

export default app;
