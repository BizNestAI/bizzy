#!/usr/bin/env node
import "dotenv/config";
import { runTaxProductionAudit } from "../../src/services/tax/security/taxProductionAudit.js";

const args = parseArgs(process.argv.slice(2));
const report = runTaxProductionAudit({ root: process.cwd(), env: process.env });

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Tax production audit: ${report.status.toUpperCase()}`);
  console.log(`Pass: ${report.summary.pass}  Warning: ${report.summary.warning}  Fail: ${report.summary.fail}`);
  for (const check of report.checks.filter((item) => item.status !== "pass")) {
    console.log(`${check.status.toUpperCase()} ${check.code}: ${check.message}`);
  }
}

if (report.status === "fail") process.exit(2);
if (report.status === "warning" && args.failOnWarning) process.exit(1);
process.exit(0);

function parseArgs(argv) {
  return Object.fromEntries(argv.map((arg) => {
    const clean = arg.replace(/^--/, "");
    const [key, ...parts] = clean.split("=");
    return [key, parts.length ? parts.join("=") : true];
  }));
}
