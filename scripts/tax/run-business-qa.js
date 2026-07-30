#!/usr/bin/env node
import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { supabase } from "../../src/services/supabaseAdmin.js";
import { runBusinessTaxQa } from "../../src/services/tax/quality/runBusinessTaxQa.js";

const args = parseArgs(process.argv.slice(2));

try {
  const businessId = args.businessId || args["business-id"];
  const taxYear = Number(args.year || args.taxYear);
  const report = await runBusinessTaxQa({
    supabase,
    businessId,
    taxYear,
    asOfDate: args.asOfDate || args["as-of-date"],
    includeTransactionSamples: Boolean(args.includeSamples || args["include-samples"]),
  });
  const output = args.json ? JSON.stringify(report, null, 2) : formatHuman(report);
  if (args.output) await writeFile(args.output, output);
  else console.log(output);
  if (report.passFail === "fail") process.exit(2);
  if (report.passFail === "warning" && (args.failOnWarning || args["fail-on-warning"])) process.exit(1);
  process.exit(0);
} catch (err) {
  console.error(`Tax business QA failed: ${err.message}`);
  process.exit(3);
}

function formatHuman(report) {
  const lines = [];
  lines.push(`Tax QA for ${report.business?.name || report.business?.id}: ${report.passFail.toUpperCase()}`);
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");
  lines.push("Scorecard");
  for (const [key, value] of Object.entries(report.scorecard || {})) {
    lines.push(`${key}: ${value.status}`);
  }
  lines.push("");
  lines.push("Top material issues");
  if (!report.materialIssues.length) lines.push("None");
  for (const item of report.materialIssues.slice(0, 10)) {
    lines.push(`${item.severity.toUpperCase()} ${item.code} ${item.amount != null ? `$${item.amount}` : ""} ${item.message}`);
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  return Object.fromEntries(argv.map((arg) => {
    const clean = arg.replace(/^--/, "");
    const [key, ...parts] = clean.split("=");
    return [key, parts.length ? parts.join("=") : true];
  }));
}
