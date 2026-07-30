#!/usr/bin/env node
/* global process */
import "dotenv/config";
import { supabase } from "../../src/services/supabaseAdmin.js";
import {
  auditLegacyTaxData,
  migrateLegacyPayments,
  migrateLegacySnapshots,
  rollbackLegacyPaymentMigration,
} from "../../src/services/tax/migrations/auditLegacyTaxData.js";

const args = parseArgs(process.argv.slice(2));
const command = args._[0] || "audit";

const common = {
  supabase,
  businessId: args.businessId || args.business_id || null,
  taxYear: args.taxYear || args.year || null,
  batchSize: Number(args.batchSize || args.batch_size || 1000),
  apply: args.apply === true,
  migrationVersion: args.migrationVersion || args.migration_version,
};

let result;
if (command === "audit") {
  result = await auditLegacyTaxData(common);
} else if (command === "migrate-snapshots") {
  result = await migrateLegacySnapshots(common);
} else if (command === "migrate-payments") {
  result = await migrateLegacyPayments(common);
} else if (command === "rollback-payments") {
  result = await rollbackLegacyPaymentMigration(common);
} else {
  console.error(JSON.stringify({ ok: false, error: `Unknown command: ${command}` }, null, 2));
  process.exitCode = 1;
}

if (result) {
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) {
      out._.push(item);
      continue;
    }
    const key = item.slice(2);
    if (key === "apply" || key === "resume") {
      out[key] = true;
      continue;
    }
    out[key] = argv[i + 1];
    i += 1;
  }
  return out;
}
