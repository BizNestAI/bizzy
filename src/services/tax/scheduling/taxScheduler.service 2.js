import { supabase as defaultSupabase } from "../../supabaseAdmin.js";
import {
  isTaxSchedulerEnabled,
  dayWindow,
  weekWindow,
} from "./taxScheduleDomain.js";
import { runDailyTaxScheduler } from "./runDailyTaxScheduler.js";
import { runWeeklyTaxScheduler } from "./runWeeklyTaxScheduler.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

let dailyTimer = null;
let weeklyTimer = null;

export function startTaxScheduler({
  supabase = defaultSupabase,
  env = process.env,
  now = new Date(),
} = {}) {
  if (!isTaxSchedulerEnabled(env)) {
    console.info("[tax-scheduler] disabled", { nodeEnv: env.NODE_ENV || "development" });
    return { started: false, reason: "disabled" };
  }
  if (String(env.DISABLE_TAX_SCHEDULER || "").toLowerCase() === "true") {
    console.info("[tax-scheduler] disabled via DISABLE_TAX_SCHEDULER");
    return { started: false, reason: "disabled_flag" };
  }

  const dailyHour = numberEnv(env.TAX_DAILY_SCHEDULER_HOUR, 5);
  const dailyMinute = numberEnv(env.TAX_DAILY_SCHEDULER_MINUTE, 30);
  const weeklyDay = numberEnv(env.TAX_WEEKLY_SCHEDULER_UTC_DAY, 1);
  const weeklyHour = numberEnv(env.TAX_WEEKLY_SCHEDULER_HOUR, 6);
  const weeklyMinute = numberEnv(env.TAX_WEEKLY_SCHEDULER_MINUTE, 15);

  const dailyDelay = delayUntilUtcTime({ now, hour: dailyHour, minute: dailyMinute });
  const weeklyDelay = delayUntilWeeklyUtcTime({ now, day: weeklyDay, hour: weeklyHour, minute: weeklyMinute });

  dailyTimer = setTimeout(() => {
    runDailyTick({ supabase, scheduledFor: dayWindow(new Date()) });
    dailyTimer = setInterval(() => runDailyTick({ supabase, scheduledFor: dayWindow(new Date()) }), DAY_MS);
  }, dailyDelay);

  weeklyTimer = setTimeout(() => {
    runWeeklyTick({ supabase, scheduledFor: weekWindow(new Date()) });
    weeklyTimer = setInterval(() => runWeeklyTick({ supabase, scheduledFor: weekWindow(new Date()) }), WEEK_MS);
  }, weeklyDelay);

  console.info("[tax-scheduler] started", {
    dailyHour,
    dailyMinute,
    weeklyDay,
    weeklyHour,
    weeklyMinute,
    environment: env.TAX_SCHEDULER_ENV || env.NODE_ENV || "development",
  });
  return { started: true, dailyDelayMs: dailyDelay, weeklyDelayMs: weeklyDelay };
}

export function stopTaxScheduler() {
  if (dailyTimer) clearTimeoutOrInterval(dailyTimer);
  if (weeklyTimer) clearTimeoutOrInterval(weeklyTimer);
  dailyTimer = null;
  weeklyTimer = null;
}

function runDailyTick({ supabase, scheduledFor }) {
  runDailyTaxScheduler({ supabase, scheduledFor })
    .then((result) => console.info("[tax-scheduler] daily complete", summarize(result)))
    .catch((err) => console.warn("[tax-scheduler] daily failed", err?.message || err));
}

function runWeeklyTick({ supabase, scheduledFor }) {
  runWeeklyTaxScheduler({ supabase, scheduledFor })
    .then((result) => console.info("[tax-scheduler] weekly complete", summarize(result)))
    .catch((err) => console.warn("[tax-scheduler] weekly failed", err?.message || err));
}

function delayUntilUtcTime({ now, hour, minute }) {
  const next = new Date(now);
  next.setUTCHours(hour, minute, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return Math.max(0, next.getTime() - now.getTime());
}

function delayUntilWeeklyUtcTime({ now, day, hour, minute }) {
  const next = new Date(now);
  next.setUTCHours(hour, minute, 0, 0);
  const daysAhead = (day - next.getUTCDay() + 7) % 7;
  next.setUTCDate(next.getUTCDate() + daysAhead);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 7);
  return Math.max(0, next.getTime() - now.getTime());
}

function numberEnv(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clearTimeoutOrInterval(id) {
  clearTimeout(id);
  clearInterval(id);
}

function summarize(result) {
  return {
    skipped: result?.skipped || false,
    reason: result?.reason || null,
    businessesScanned: result?.businessesScanned || 0,
    requestsQueued: result?.requestsQueued || 0,
    failures: result?.failures || 0,
  };
}

export default {
  startTaxScheduler,
  stopTaxScheduler,
};
