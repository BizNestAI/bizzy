#!/usr/bin/env node
import "dotenv/config";
import { runQboJobCostingSync } from "../src/services/jobCosting/qboJobCostingSyncService.js";

const args = new Map(
  process.argv
    .slice(2)
    .map((arg) => {
      const [key, ...rest] = arg.replace(/^--/, "").split("=");
      return [key, rest.join("=") || "true"];
    }),
);

const businessId = args.get("business-id") || args.get("business_id") || process.env.BUSINESS_ID;
const mode = args.get("mode") || "full";
const since = args.get("since") || null;

if (!businessId) {
  console.error("Usage: node scripts/qboJobCostingBackfill.js --business-id=<uuid> [--mode=full|incremental] [--since=<iso timestamp>]");
  process.exit(1);
}

try {
  const result = await runQboJobCostingSync({ businessId, mode, since });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
}
