# Bizzi Tax API Contract

Canonical API version: `2026-01`

Canonical payload version: `tax-calculation-v1`

Bizzi Tax APIs return estimates based on available source data, verified rule configuration, and user/CPA-confirmed inputs. They are planning outputs, not tax filing software.

## Versioning

Clients may request a version with either:

- `X-Bizzi-Tax-Version: 2026-01`
- `apiVersion=2026-01`

Unsupported versions return `unsupported_tax_api_version`.

## Canonical Endpoints

- `POST /api/tax/calculations`
- `GET /api/tax/calculations/latest`
- `GET /api/tax/calculations/:runId`
- `GET /api/tax/calculations/:runId/components`
- `GET /api/tax/calculations/:runId/explanation`
- `GET /api/tax/calculations/:runId/confidence`
- `GET /api/tax/calculations/:runId/changes`
- `GET /api/tax/overview`

`GET /api/tax/overview` returns the latest persisted canonical DTO. Add `refresh=true` to run a new calculation.

## Includes

Default payloads are bounded and exclude large details. Supported `include` values:

- `components`
- `explanations`
- `confidenceFactors`
- `deductions`
- `reserveHistory`
- `paymentDetails`
- `deadlines`
- `runChanges`
- `ruleSupport`

Unknown include values are rejected. Large transaction and export data remain separate endpoints.

## Canonical Response

```json
{
  "ok": true,
  "data": {
    "meta": {
      "apiVersion": "2026-01",
      "payloadVersion": "tax-calculation-v1",
      "runId": "uuid",
      "businessId": "uuid",
      "taxYear": 2026,
      "asOfDate": "2026-07-14",
      "calculationType": "full_estimate",
      "status": "completed|partial|failed",
      "generatedAt": "ISO timestamp",
      "engineVersions": {},
      "ruleVersions": {},
      "reusedExistingRun": false,
      "persistenceStatus": "persisted"
    },
    "readiness": {
      "estimateReady": true,
      "reserveReady": false,
      "profileStatus": "active",
      "setupState": {
        "state": "ready|partial|profile_incomplete|entity_unknown|classifications_missing|classifications_need_review|federal_rules_missing|state_rules_missing|payments_incomplete|reserve_setup_incomplete|no_posted_transactions|unavailable",
        "severity": "info|low|medium|high",
        "blocking": false,
        "actions": []
      }
    },
    "summary": {
      "projectedTotalTax": 31400,
      "projectedFederalTax": 25000,
      "projectedStateTax": 6400,
      "projectedSelfEmploymentTax": 9000,
      "taxableIncomeYtd": 70000,
      "projectedTaxableIncome": 120000,
      "taxPaidAndWithheldYtd": 8000,
      "remainingProjectedLiability": 23400,
      "recommendedReserve": 25740,
      "currentReserve": null,
      "reserveGap": null,
      "confidenceScore": 72,
      "confidenceLevel": "medium"
    }
  }
}
```

## Null vs Zero

- `0` means a known amount is zero.
- `null` means unknown, unavailable, or not configured.
- Missing safe-harbor rules return `safeHarbor.status = "unavailable"` and do not create fake quarterly payments.
- Missing reserve account returns `reserve.status = "setup_incomplete"` and `currentReserve = null`.

## Error Contract

Errors preserve the legacy shape and add structured details:

```json
{
  "ok": false,
  "error": "tax_profile_incomplete",
  "message": "Tax profile is incomplete.",
  "errorDetail": {
    "code": "tax_profile_incomplete",
    "message": "Tax profile is incomplete.",
    "status": 400,
    "details": {},
    "action": "complete_tax_profile",
    "requestId": "request-id"
  }
}
```

Stack traces, raw Plaid payloads, QBO responses, tokens, and private notes are never included.

## Legacy Compatibility

`POST /api/tax/calculate-tax-liability` remains available and is backed by the canonical orchestrator. It returns:

- `meta`
- `summary`
- `safeHarbor`
- `quarterly`
- `trend`
- `cashFlowOverlay`
- `monthlySnapshot`
- `confidence`
- `warnings`
- `setupState`

Legacy unknown values use `null`, not misleading zero. `meta.deprecation.canonicalEndpoint` points to `/api/tax/overview`.

## Setup States

Setup states are deterministic and intended for frontend banners:

- `ready`
- `partial`
- `profile_incomplete`
- `entity_unknown`
- `classifications_missing`
- `classifications_need_review`
- `federal_rules_missing`
- `state_rules_missing`
- `payments_incomplete`
- `reserve_setup_incomplete`
- `no_posted_transactions`
- `unavailable`

Each state includes severity, message, blocking flag, completed steps, missing steps, and actions.

## Partial Results

A calculation can be partial when a section is unavailable but other sections are valid. Examples:

- Federal result available, state config missing.
- Liability available, safe harbor unavailable.
- Estimate ready, reserve not ready because no reserve account is connected.

Consumers should use `readiness`, `confidence`, `warnings`, and `unsupportedItems` instead of inferring semantics from missing fields.
