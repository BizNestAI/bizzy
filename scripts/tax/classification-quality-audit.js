#!/usr/bin/env node
import "dotenv/config";
import process from "node:process";
import { createClient } from "@supabase/supabase-js";
import {
  auditTaxClassificationQuality,
  formatTaxClassificationQualityAuditMarkdown,
} from "../../src/services/tax/taxClassificationQualityAudit.service.js";

const args = parseArgs(process.argv.slice(2));
const businessId = args.businessId || args.business_id || process.env.TAX_AUDIT_BUSINESS_ID;
const taxYear = args.taxYear || args.year || process.env.TAX_AUDIT_YEAR;

if (!businessId || !taxYear) {
  console.error("Usage: node scripts/tax/classification-quality-audit.js --businessId=<uuid> --taxYear=2026 [--json]");
  process.exit(1);
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/SUPABASE_SERVICE_KEY.");
  process.exit(1);
}

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const report = await auditTaxClassificationQuality({ supabase, businessId, taxYear });
console.log(args.json ? JSON.stringify(report, null, 2) : formatTaxClassificationQualityAuditMarkdown(report));

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const clean = arg.replace(/^--/, "");
    const [keyName, ...parts] = clean.split("=");
    out[keyName] = parts.length ? parts.join("=") : true;
  }
  return out;
}
