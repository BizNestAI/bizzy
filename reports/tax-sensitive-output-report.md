# Tax Sensitive Output Report

Status: **skipped**
Runtime executed: **no**
Generated at: 2026-08-23T17:18:36.915Z
Target: test

## Static Companion Scan

Status: **pass**
Findings: 9

| File | Line | Severity | Category | Preview |
| --- | ---: | --- | --- | --- |
| src/api/tax/calculateTaxLiability.js | 23 | medium | error_details_rendering | const details = (err?.details \|\| "").toLowerCase(); |
| src/api/tax/taxHttp.js | 34 | medium | error_details_rendering | action: safe ? err?.details?.action \|\| err?.action \|\| null : null, |
| src/api/tax/taxHttp.js | 39 | medium | error_details_rendering | if (safe && err?.details && isSafeDetails(err.details)) { |
| src/services/tax/security/taxResponseSafetyScanner.js | 71 | medium | error_details_rendering | details: error?.details, |
| src/services/tax/state/stateTaxEngine 2.js | 54 | medium | error_details_rendering | configSet = { stateCode: state, configs: {}, missing: [{ code: err.code, details: err.details }], warnings: [], supportLevel: TAX_RULE_SUPPO |
| src/services/tax/state/stateTaxEngine.js | 54 | medium | error_details_rendering | configSet = { stateCode: state, configs: {}, missing: [{ code: err.code, details: err.details }], warnings: [], supportLevel: TAX_RULE_SUPPO |
| src/services/tax/stateTaxRule.repository.js | 94 | medium | error_details_rendering | missing.push({ ruleType, code: err.code \|\| "unsupported_state_tax_rule", details: err.details }); |
| src/services/tax/taxRuleConfig.repository.js | 95 | medium | error_details_rendering | missing.push({ ruleType, code: err.code \|\| "tax_rule_config_missing", details: err.details }); |
| src/components/Tax/Setup/TaxSetupWorkflow.jsx | 482 | medium | error_details_rendering | const details = err?.details \|\| {}; |

## Runtime Scan

Runtime scan skipped: TAX_OUTPUT_SAFETY_ENABLED is not true.
Missing env: TEST_SUPABASE_URL, TEST_SUPABASE_ANON_KEY, TEST_SUPABASE_SERVICE_ROLE_KEY, TEST_API_BASE_URL

Runtime safety is proven only when `Runtime executed` is `yes` and `Unsafe responses` is `0`.
