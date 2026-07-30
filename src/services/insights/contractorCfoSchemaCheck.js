/* global process */
import { supabase as defaultSupabase } from '../supabaseAdmin.js';

export const REQUIRED_CONTRACTOR_CFO_INSIGHTS_COLUMNS = [
  'id',
  'business_id',
  'user_id',
  'module',
  'type',
  'title',
  'body',
  'severity',
  'category',
  'confidence_score',
  'metrics',
  'recommended_actions',
  'primary_cta',
  'primary_cta_label',
  'primary_cta_action',
  'primary_cta_payload',
  'secondary_cta',
  'secondary_cta_label',
  'secondary_cta_action',
  'secondary_cta_payload',
  'tags',
  'source_event_id',
  'dedupe_key',
  'trigger_source',
  'source_refs',
  'expires_at',
  'snoozed_until',
  'dismissed_at',
  'status',
  'is_read',
  'read_at',
  'account_id',
  'created_at',
];

let supabase = defaultSupabase;
let cachedSchemaCheck = null;

export function __setContractorCfoSchemaCheckTestDeps(deps = {}) {
  supabase = deps.supabase || defaultSupabase;
  cachedSchemaCheck = null;
}

export function shouldEnforceContractorCfoSchemaCheck() {
  if (String(process.env.CONTRACTOR_CFO_SCHEMA_CHECK_DISABLED || '').toLowerCase() === 'true') {
    return false;
  }
  return process.env.NODE_ENV === 'production';
}

function parseMissingColumns(error) {
  const text = `${error?.message || ''} ${error?.details || ''} ${error?.hint || ''}`;
  const matches = [
    ...text.matchAll(/column ['"]?([a-zA-Z0-9_]+)['"]?/gi),
    ...text.matchAll(/Could not find the ['"]?([a-zA-Z0-9_]+)['"]? column/gi),
  ].map((match) => match[1]).filter(Boolean);

  const required = new Set(REQUIRED_CONTRACTOR_CFO_INSIGHTS_COLUMNS);
  const missing = [...new Set(matches)].filter((column) => required.has(column));
  return missing.length ? missing : REQUIRED_CONTRACTOR_CFO_INSIGHTS_COLUMNS;
}

export async function verifyContractorCfoInsightsSchema({ force = false } = {}) {
  if (!force && !shouldEnforceContractorCfoSchemaCheck()) {
    return {
      ok: true,
      enforced: false,
      requiredColumns: REQUIRED_CONTRACTOR_CFO_INSIGHTS_COLUMNS,
      missingColumns: [],
    };
  }

  const selectList = REQUIRED_CONTRACTOR_CFO_INSIGHTS_COLUMNS.join(',');
  const { error } = await supabase
    .from('insights')
    .select(selectList)
    .limit(1);

  if (!error) {
    return {
      ok: true,
      enforced: true,
      requiredColumns: REQUIRED_CONTRACTOR_CFO_INSIGHTS_COLUMNS,
      missingColumns: [],
    };
  }

  const message = error?.message || 'insights schema check failed';
  const tableMissing =
    error?.code === '42P01' ||
    /relation .*insights.* does not exist/i.test(message) ||
    /could not find (the )?(table|relation) .*insights/i.test(message);

  return {
    ok: false,
    enforced: true,
    reason: tableMissing ? 'insights_table_missing' : 'insights_schema_incomplete',
    requiredColumns: REQUIRED_CONTRACTOR_CFO_INSIGHTS_COLUMNS,
    missingColumns: tableMissing ? REQUIRED_CONTRACTOR_CFO_INSIGHTS_COLUMNS : parseMissingColumns(error),
    errorCode: error?.code || null,
    message,
  };
}

export async function ensureContractorCfoInsightsSchemaReady(options = {}) {
  if (!options.force && cachedSchemaCheck) return cachedSchemaCheck;
  cachedSchemaCheck = await verifyContractorCfoInsightsSchema(options);
  return cachedSchemaCheck;
}

export default {
  REQUIRED_CONTRACTOR_CFO_INSIGHTS_COLUMNS,
  ensureContractorCfoInsightsSchemaReady,
  shouldEnforceContractorCfoSchemaCheck,
  verifyContractorCfoInsightsSchema,
};
