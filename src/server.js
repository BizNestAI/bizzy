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
import bookkeepingRouter from "./api/accounting/bookkeeping.routes.js";

// Marketing
import marketingRouter from "./api/marketing/marketing.routes.js";

import jobsRoutes from "./api/Jobs/jobs.routes.js";
import { startForecastCron } from "./jobs/forecast.cron.js";

// GPT & chats
import gptRoutes from "./api/gpt/brain/gpt.routes.js";
import chatsRoutes from "./api/chats/chats.routes.js";

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

// Tax (router)
import taxRouter from "./api/tax/index.js";
import taxRoutes from "./api/tax/tax.routes.js";
import taxDeductionsRouter from "./api/tax/deductions.routes.js";

import bizzyInsightRouter from "./api/gpt/brain/bizzyInsight.js";
import { requireAuth } from "./api/gpt/middlewares/requireAuth.js";

/* 🔹 NEW: Hero insights router */
import heroInsightsRouter from "./api/hero-insights/router.js";

const app = express();
const PORT = process.env.PORT || 5050;

app.disable("x-powered-by");

/* ----------------------------- Stripe webhook FIRST (raw body) ----------------------------- */
app.post(
  "/api/billing/webhook",
  express.raw({ type: "application/json" }),
  billingWebhookHandler
);

/* ---------------------------------------- CORS ---------------------------------------- */
const rawCorsOrigins = process.env.CORS_ORIGINS || process.env.CORS_ORIGIN || "";
const allowlist = rawCorsOrigins
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const allowAll = allowlist.length === 0 && !process.env.CORS_ORIGINS;

console.info("[CORS] Allowlist:", allowAll ? "(all origins)" : allowlist);

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // server-to-server or health checks
    if (allowAll || allowlist.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS: Origin ${origin} not allowed`), false);
  },
  credentials: true,
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization", "x-user-id", "x-business-id"],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

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

/* ------------------------------------ Accounting ----------------------------------- */
app.use("/auth", quickbooksAuth);
app.use("/auth", socialAuthRouter);
app.use("/api/accounting/metrics", financialMetricsRoute);
app.use("/api/accounting/pulse", pulseRoute);
app.use("/api/accounting/moves", movesRoute);
app.use("/api/accounting/revenue-series", revenueSeriesRouter);
app.use("/api/accounting/profit-series", profitSeriesRouter);
app.use("/api/accounting/reports-sync", reportsSyncRouter);
app.use("/api/accounting/forecast", forecastRouter);
app.use("/api/accounting/forecast-accuracy", forecastAccuracyRouter);
app.use("/api/accounting/scenarios", scenariosRouter);
app.use("/api/accounting", bookkeepingRouter);
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

export default app;
