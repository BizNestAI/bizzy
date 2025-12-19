// File: /src/api/gpt/registry/intentRegistry.js
// -----------------------------------------------------------------------------
// Intent registry: aggregates all intent modules and provides a simple resolver.
// Each intent module exports: { key, test(text), recipe?(ctx), postProcess?(ctx) }.
// Resolution is cheap (regex/predicate). Token cost is unaffected.
//
// Order matters: we list specific/intentioned intents first, then broader helpers,
// and finally navigation/help. Default falls back to 'general'.
// -----------------------------------------------------------------------------

// A) Cross-App / Core
import * as CALENDAR_SCHEDULE   from '../intents/calendar_schedule.intent.js';
import * as AFFORDABILITY_CHECK from '../intents/affordability_check.intent.js';
import * as DOC_SAVE            from '../intents/doc_save.intent.js';
import * as DOCS_FIND           from '../intents/docs_find.intent.js';
import * as INTEGRATIONS_CONNECT from '../intents/integrations_connect.intent.js';
import * as BILLING_MANAGE      from '../intents/billing_manage.intent.js';
import * as SETTINGS_UPDATE     from '../intents/settings_update.intent.js';
import * as AGENDA_RANGE        from '../intents/agenda_range.intent.js';
import * as NAVIGATE            from '../intents/navigate.intent.js';
import * as APP_HELP            from '../intents/app_help.intent.js';

// ✉️ Email
import * as EMAIL_SUMMARIZE from '../intents/email/emailSummarize.intent.js';
import * as EMAIL_REPLY     from '../intents/email/emailReply.intent.js';
import * as EMAIL_TEMPLATE  from '../intents/email/emailTemplate.intent.js';
import * as EMAIL_SEARCH        from '../intents/email/emailSearch.intent.js';
import * as EMAIL_EXTRACT_TASKS from '../intents/email/emailExtractTasks.intent.js';
import * as EMAIL_FOLLOWUP      from '../intents/email/emailFollowup.intent.js';
import * as EMAIL_FIND_CONTACT  from '../intents/email/emailFindContact.intent.js';

// B) Financials
import * as FIN_VARIANCE_EXPLAIN from '../intents/fin_variance_explain.intent.js';
import * as FORECAST_GENERATE     from '../intents/forecast_generate.intent.js';
import * as CASH_RUNWAY           from '../intents/cash_runway.intent.js';
import * as INVOICE_STATUS        from '../intents/invoice_status.intent.js';
import * as EXPENSE_SPIKE         from '../intents/expense_spike.intent.js';
import * as JOB_PROFITABILITY     from '../intents/job_profitability.intent.js';
import * as PRICING_STRATEGY      from '../intents/pricing_strategy.intent.js';
import * as FIN_OVERVIEW          from '../intents/fin_overview.intent.js';

// C) Tax
import * as TAX_LIABILITY_ESTIMATE from '../intents/tax_liability_estimate.intent.js';
import * as TAX_DEADLINES          from '../intents/tax_deadlines.intent.js';
import * as TAX_DEDUCTIONS_FIND    from '../intents/tax_deductions_find.intent.js';
import * as TAX_MOVE_EXPLAIN       from '../intents/tax_move_explain.intent.js';
import * as TAX_OVERVIEW           from '../intents/tax_overview.intent.js';

// D) Marketing
import * as CONTENT_GENERATE     from '../intents/content_generate.intent.js';
import * as REVIEWS_INSIGHTS     from '../intents/reviews_insights.intent.js';
import * as REVIEW_REQUEST_FLOW  from '../intents/review_request_flow.intent.js';
import * as MKT_OVERVIEW         from '../intents/mkt_overview.intent.js';

// E) Investments
import * as RETIREMENT_PROJECTION from '../intents/retirement_projection.intent.js';
import * as CONTRIBUTION_LIMIT    from '../intents/contribution_limit.intent.js';
import * as REBALANCE_ADVICE      from '../intents/rebalance_advice.intent.js';
import * as INV_OVERVIEW          from '../intents/inv_overview.intent.js';

// F) Ops / Calendar
import * as JOB_STATUS     from '../intents/job_status.intent.js';
import * as LEAD_FOLLOWUP  from '../intents/lead_followup.intent.js';

// -----------------------------------------------------------------------------
// Ordered list: specific → general. Keep most precise first to avoid collisions.
// -----------------------------------------------------------------------------
const INTENTS = [

// Email first (specific comms)
  EMAIL_SUMMARIZE,
  EMAIL_REPLY,
  EMAIL_TEMPLATE,
  EMAIL_SEARCH,
  EMAIL_EXTRACT_TASKS,
  EMAIL_FOLLOWUP,
  EMAIL_FIND_CONTACT,

  // Scheduling / money
  CALENDAR_SCHEDULE,
  AFFORDABILITY_CHECK,

  // Docs
  DOC_SAVE,
  DOCS_FIND,

  // Integrations / billing / settings
  INTEGRATIONS_CONNECT,
  BILLING_MANAGE,
  SETTINGS_UPDATE,

  // Financials (specific → broader)
  FIN_VARIANCE_EXPLAIN,
  FORECAST_GENERATE,
  CASH_RUNWAY,
  INVOICE_STATUS,
  EXPENSE_SPIKE,
  JOB_PROFITABILITY,
  PRICING_STRATEGY,
  FIN_OVERVIEW,

  // Tax
  TAX_LIABILITY_ESTIMATE,
  TAX_DEADLINES,
  TAX_DEDUCTIONS_FIND,
  TAX_MOVE_EXPLAIN,
  TAX_OVERVIEW,

  // Marketing
  CONTENT_GENERATE,
  REVIEWS_INSIGHTS,
  REVIEW_REQUEST_FLOW,
  MKT_OVERVIEW,

  // Investments
  RETIREMENT_PROJECTION,
  CONTRIBUTION_LIMIT,
  REBALANCE_ADVICE,
  INV_OVERVIEW,

  // Ops / Calendar queries
  JOB_STATUS,
  LEAD_FOLLOWUP,
  AGENDA_RANGE,

  // Navigation / help (broadest last)
  NAVIGATE,
  APP_HELP,
];

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Return the first matching intent key, or 'general' if none match.
 * @param {string} message
 */
export function resolveIntent(message) {
  const t = String(message || '');
  for (const mod of INTENTS) {
    try {
      if (typeof mod.test === 'function' && mod.test(t)) return mod.key;
    } catch (_e) { /* fail-soft */ }
  }
  return 'general';
}

/**
 * Get the module for a specific key (for recipe/postProcess).
 * @param {string} key
 * @returns {object|null}
 */
export function getIntentModule(key) {
  return INTENTS.find(m => m && m.key === key) || null;
}

/**
 * Export list for diagnostics or admin UI.
 */
export const ALL_INTENTS = INTENTS.map(m => m.key);
