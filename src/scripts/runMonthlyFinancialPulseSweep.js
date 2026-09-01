#!/usr/bin/env node
import "dotenv/config";
import { runMonthlyBriefSchedulerSweepOnce } from "../services/accounting/monthlyBriefSchedulerService.js";

/* global process */

try {
  const result = await runMonthlyBriefSchedulerSweepOnce();
  console.info("[monthly-financial-pulse-sweep] complete", result);
  if (result?.failed > 0) {
    process.exitCode = 1;
  }
} catch (err) {
  console.error("[monthly-financial-pulse-sweep] failed", err?.message || err);
  process.exitCode = 1;
}
