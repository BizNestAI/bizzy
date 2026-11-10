/* global process */
export function backgroundWorkerStartupDecision(env = process.env) {
  if (String(env.DISABLE_BACKGROUND_WORKERS).toLowerCase() === "true") {
    return { enabled: false, reason: "DISABLE_BACKGROUND_WORKERS" };
  }
  const override = String(env.BACKGROUND_WORKERS_OVERRIDE || "").trim().toLowerCase();
  if (override) return { enabled: override === "true", reason: override === "true" ? "explicit testing override" : "override disabled or invalid" };
  const railwayProduction = env.NODE_ENV === "production" &&
    env.RAILWAY_ENVIRONMENT_NAME === "production" &&
    Boolean(env.RAILWAY_PROJECT_ID && env.RAILWAY_SERVICE_ID);
  return { enabled: railwayProduction, reason: railwayProduction ? "Railway production environment" : "not Railway production; workers default off" };
}

export function startBackgroundWorkers({ workers, env = process.env, logger = console }) {
  const decision = backgroundWorkerStartupDecision(env);
  logger.info(`[background-workers] ${decision.enabled ? "starting" : "disabled"}: ${decision.reason}`);
  if (decision.enabled) for (const start of workers) start();
  return decision;
}
