import { runMonthlyBriefSchedulerSweepOnce } from "../services/accounting/monthlyBriefSchedulerService.js";

/* global process */

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

export async function runMonthlyFinancialPulseSweepOnce() {
  return runMonthlyBriefSchedulerSweepOnce();
}

export function startMonthlyFinancialPulseCron() {
  if (String(process.env.DISABLE_MONTHLY_FINANCIAL_PULSE_CRON || "").toLowerCase() === "true") {
    console.info("[monthly-financial-pulse-cron] disabled via env");
    return;
  }
  const intervalMs = Number(process.env.MONTHLY_FINANCIAL_PULSE_SWEEP_MS || DEFAULT_INTERVAL_MS);
  console.info("[monthly-financial-pulse-cron] started", { interval_minutes: Math.round(intervalMs / 60000) });
  runMonthlyFinancialPulseSweepOnce()
    .then((result) => console.info("[monthly-financial-pulse-cron] sweep complete", result))
    .catch((err) => console.warn("[monthly-financial-pulse-cron] sweep failed", err?.message || err));
  setInterval(() => {
    runMonthlyFinancialPulseSweepOnce()
      .then((result) => console.info("[monthly-financial-pulse-cron] sweep complete", result))
      .catch((err) => console.warn("[monthly-financial-pulse-cron] sweep failed", err?.message || err));
  }, intervalMs);
}

export default startMonthlyFinancialPulseCron;
