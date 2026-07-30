// /src/services/tax/api/taxSetupState.js

export const TAX_SETUP_STATES = Object.freeze({
  READY: "ready",
  PARTIAL: "partial",
  PROFILE_INCOMPLETE: "profile_incomplete",
  ENTITY_UNKNOWN: "entity_unknown",
  CLASSIFICATIONS_MISSING: "classifications_missing",
  CLASSIFICATIONS_NEED_REVIEW: "classifications_need_review",
  FEDERAL_RULES_MISSING: "federal_rules_missing",
  STATE_RULES_MISSING: "state_rules_missing",
  PAYMENTS_INCOMPLETE: "payments_incomplete",
  RESERVE_SETUP_INCOMPLETE: "reserve_setup_incomplete",
  NO_POSTED_TRANSACTIONS: "no_posted_transactions",
  UNAVAILABLE: "unavailable",
});

export function buildTaxSetupState({ canonicalResult = null, run = null } = {}) {
  const c = canonicalResult || {};
  const warnings = c.warnings || run?.warnings || [];
  const missing = c.missingInputs || run?.missing_inputs || [];
  const confidence = c.confidence || confidenceFromRun(run);
  const coverage = c.actuals?.coverage || c.actuals?.deductions?.coverage || {};
  const completedSteps = [];
  const missingSteps = [];
  const actions = [];

  if (c.profile?.completeness?.isCompleteForEstimate || run?.tax_profile_id) completedSteps.push("tax_profile");
  else missingSteps.push("tax_profile");
  if (c.entity?.entityPath || run?.entity_type) completedSteps.push("entity");
  if (coverage.classifiedCount > 0 || coverage.classificationCoveragePercent > 0) completedSteps.push("classifications");
  if (c.federal?.totalFederalTax != null || run?.estimated_federal_tax != null) completedSteps.push("federal_tax");
  if (c.payments || run?.payments_ytd != null || run?.withholding_ytd != null) completedSteps.push("payments");
  if (c.reserve?.status && c.reserve.status !== "setup_incomplete") completedSteps.push("reserve");

  let state = TAX_SETUP_STATES.READY;
  let severity = "info";
  let title = "Tax estimate ready";
  let message = "Bizzi has enough tax setup to return the current estimate.";
  let blocking = false;

  const hasWarning = (...codes) => warnings.some((warning) => codes.includes(warning.code));
  const hasMissing = (...fields) => missing.some((field) => fields.includes(field));

  if (confidence?.level === "unavailable" || run?.status === "failed") {
    state = TAX_SETUP_STATES.UNAVAILABLE;
    severity = "high";
    title = "Tax estimate unavailable";
    message = "Required tax inputs or rule configuration are unavailable.";
    blocking = true;
    actions.push(action("review_tax_inputs", "Review tax setup", "/tax/profile"));
  } else if (hasWarning("missing_brackets", "missing_standard_deduction_rule", "federal_rules_unusable")) {
    state = TAX_SETUP_STATES.FEDERAL_RULES_MISSING;
    severity = "high";
    title = "Federal tax rules missing";
    message = "Verified federal rule configuration is required before this estimate can be trusted.";
    blocking = true;
    actions.push(action("verify_tax_rule_config", "Verify federal tax rules", "/tax/rule-support"));
  } else if (hasWarning("state_rule_missing", "unsupported_state", "state_tax_unavailable")) {
    state = TAX_SETUP_STATES.STATE_RULES_MISSING;
    severity = "medium";
    title = "State tax support incomplete";
    message = "Federal results may be available, but state tax is partial or unavailable.";
    actions.push(action("verify_state_rules", "Verify state tax rules", "/tax/state/rule-support"));
  } else if (hasWarning("entity_type_unknown", "llc_tax_election_missing") || hasMissing("entity_type", "tax_election")) {
    state = TAX_SETUP_STATES.ENTITY_UNKNOWN;
    severity = "high";
    title = "Entity setup incomplete";
    message = "Bizzi needs the entity type and tax election before authoritative routing.";
    blocking = true;
    actions.push(action("complete_tax_profile", "Complete tax profile", "/tax/profile"));
  } else if (c.profile?.completeness?.isCompleteForEstimate === false || hasMissing("filing_status", "primary_tax_state", "accounting_method")) {
    state = TAX_SETUP_STATES.PROFILE_INCOMPLETE;
    severity = "medium";
    title = "Tax profile incomplete";
    message = "Some profile fields are missing and reduce confidence.";
    actions.push(action("complete_tax_profile", "Complete tax profile", "/tax/profile"));
  } else if (coverage.eligiblePostedCount === 0 || hasWarning("no_posted_transactions")) {
    state = TAX_SETUP_STATES.NO_POSTED_TRANSACTIONS;
    severity = "medium";
    title = "No posted transactions";
    message = "No eligible posted transactions are available for tax classification.";
    actions.push(action("refresh_books", "Refresh books", "/accounting/bookkeeping"));
  } else if ((coverage.classificationCoveragePercent || 0) < 80 || hasWarning("classifications_not_run")) {
    state = TAX_SETUP_STATES.CLASSIFICATIONS_MISSING;
    severity = "medium";
    title = "Classifications incomplete";
    message = "More posted transactions need annual tax classifications.";
    actions.push(action("classify_transactions", "Run tax classification", "/tax"));
  } else if ((coverage.needsReviewBookAmount || coverage.needsReviewAmount || 0) > 0 || hasWarning("high_needs_review_amount")) {
    state = TAX_SETUP_STATES.CLASSIFICATIONS_NEED_REVIEW;
    severity = "medium";
    title = "Transactions need review";
    message = "Some material tax classifications need user or CPA review.";
    actions.push(action("review_transactions", "Review tax classifications", "/tax"));
  } else if (c.reserve?.status === "setup_incomplete" || run?.reserve_ready === false) {
    state = TAX_SETUP_STATES.RESERVE_SETUP_INCOMPLETE;
    severity = "low";
    title = "Reserve setup incomplete";
    message = "The estimate is available, but reserve readiness needs a designated reserve account.";
    actions.push(action("connect_reserve_account", "Connect reserve account", "/tax/reserve"));
  } else if (confidence?.status === "partial" || run?.status === "partial") {
    state = TAX_SETUP_STATES.PARTIAL;
    severity = "medium";
    title = "Partial tax estimate";
    message = "Bizzi returned a partial estimate with warnings.";
  }

  return {
    state,
    severity,
    title,
    message,
    blocking,
    completedSteps,
    missingSteps,
    actions,
  };
}

function action(code, title, route) {
  return { code, priority: "medium", title, route };
}

function confidenceFromRun(run) {
  if (!run) return null;
  return { level: run.confidence_level, status: run.confidence_status };
}
