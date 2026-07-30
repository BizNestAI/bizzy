/**
 * Frontend Tax API contract notes:
 * - `null` means unknown, unavailable, or not configured.
 * - `0` means a known zero amount.
 * - `[]` means a known empty collection.
 * - Omitted sections may mean the section was not requested via include controls.
 *
 * @typedef {Object} TaxMetaDto
 * @property {string|null} [businessId]
 * @property {number|null} [taxYear]
 * @property {string|null} [asOfDate]
 * @property {string|null} [runId]
 * @property {string|null} [status]
 * @property {string|null} [apiVersion]
 * @property {string|null} [source]
 *
 * @typedef {Object} TaxSetupStateDto
 * @property {string|null} [status]
 * @property {Array<TaxImprovementActionDto>} [actions]
 * @property {Array<TaxWarningDto>} [blockers]
 *
 * @typedef {Object} TaxReadinessDto
 * @property {boolean} [estimateReady]
 * @property {boolean} [reserveReady]
 * @property {boolean} [profileReady]
 * @property {string|null} [status]
 * @property {TaxSetupStateDto|null} [setupState]
 * @property {Array<TaxWarningDto>} [blockers]
 * @property {Array<TaxImprovementActionDto>} [actions]
 *
 * @typedef {Object} TaxSummaryDto
 * @property {number|null} [projectedTotalTax]
 * @property {number|null} [projectedFederalTax]
 * @property {number|null} [projectedStateTax]
 * @property {number|null} [projectedSelfEmploymentTax]
 * @property {number|null} [projectedTaxableIncome]
 * @property {number|null} [taxableIncomeYtd]
 * @property {number|null} [taxPaidAndWithheldYtd]
 * @property {number|null} [remainingProjectedLiability]
 * @property {number|null} [recommendedReserve]
 * @property {number|null} [reserveGap]
 *
 * @typedef {Object} TaxProfileCompletenessDto
 * @property {number|null} [score]
 * @property {Array<string>} [missingFields]
 * @property {Array<TaxImprovementActionDto>} [actions]
 *
 * @typedef {Object} TaxProfileDto
 * @property {string|null} [id]
 * @property {number|null} [taxYear]
 * @property {string|null} [entityType]
 * @property {string|null} [taxElection]
 * @property {string|null} [filingStatus]
 * @property {TaxProfileCompletenessDto|null} [completeness]
 *
 * @typedef {Object} TaxActualsDto
 * @property {number|null} [revenueYtd]
 * @property {number|null} [deductionsYtd]
 * @property {number|null} [taxableIncomeYtd]
 * @property {Object<string, Object>} [monthly]
 *
 * @typedef {Object} TaxProjectionDto
 * @property {string|null} [method]
 * @property {string|null} [scenario]
 * @property {number|null} [projectedAnnualTaxableIncome]
 * @property {Object|null} [projectedAnnual]
 * @property {Array<TaxTrendPoint>} [taxTrend]
 *
 * @typedef {Object} TaxFederalDto
 * @property {string|null} [status]
 * @property {number|null} [tax]
 * @property {number|null} [effectiveRate]
 * @property {number|null} [marginalRate]
 *
 * @typedef {Object} TaxStateDto
 * @property {string|null} [status]
 * @property {string|null} [stateCode]
 * @property {number|null} [tax]
 *
 * @typedef {Object} TaxPaymentsDto
 * @property {string|null} [source]
 * @property {Object|null} [federal]
 * @property {Object|null} [state]
 * @property {Object|null} [totals]
 * @property {Array<Object>} [rows]
 *
 * @typedef {Object} TaxSafeHarborDto
 * @property {string|null} [status]
 * @property {Object|null} [federal]
 * @property {Object|null} [state]
 * @property {Object|null} [combined]
 * @property {Array<TaxWarningDto>} [warnings]
 *
 * @typedef {Object} TaxReserveDto
 * @property {string|null} [status]
 * @property {number|null} [recommendedTransfer]
 * @property {number|null} [reserveBalance]
 * @property {number|null} [reserveGap]
 * @property {Object|null} [primaryAccount]
 * @property {Array<TaxWarningDto>} [warnings]
 *
 * @typedef {Object} TaxImprovementActionDto
 * @property {string|null} [code]
 * @property {string|null} [label]
 * @property {string|null} [route]
 * @property {string|null} [priority]
 *
 * @typedef {Object} TaxConfidenceDto
 * @property {number|null} [score]
 * @property {string|null} [level]
 * @property {string|null} [status]
 * @property {boolean} [estimateReady]
 * @property {boolean} [reserveReady]
 * @property {Array<Object>} [factors]
 * @property {Array<TaxWarningDto>} [blockers]
 * @property {Array<TaxImprovementActionDto>} [improvementActions]
 *
 * @typedef {Object} TaxWarningDto
 * @property {string|null} [code]
 * @property {string|null} [severity]
 * @property {string|null} [message]
 * @property {string|null} [action]
 *
 * @typedef {Object} TaxAssumptionDto
 * @property {string|null} [code]
 * @property {string|null} [message]
 * @property {string|null} [severity]
 *
 * @typedef {Object} TaxExplanationSummaryDto
 * @property {Array<Object>} [topDrivers]
 * @property {Array<TaxWarningDto>} [topWarnings]
 * @property {Object|null} [biggestChange]
 * @property {TaxImprovementActionDto|null} [nextRecommendedAction]
 *
 * @typedef {Object} TaxTrendPoint
 * @property {string} month
 * @property {"actual"|"current_partial"|"projected"|string|null} [periodType]
 * @property {number|null} estTax
 * @property {number|null} actualTax
 * @property {number|null} projectedTax
 * @property {number|null} cumulativeActualTax
 * @property {number|null} projectedYearEndTax
 * @property {number|null} paymentsApplied
 * @property {number|null} reserveTarget
 * @property {boolean} [isCurrent]
 * @property {string|null} [confidenceLevel]
 * @property {Array<TaxWarningDto>} [warnings]
 *
 * @typedef {Object} TaxOverviewDto
 * @property {TaxMetaDto} meta
 * @property {TaxReadinessDto} readiness
 * @property {TaxSummaryDto} summary
 * @property {TaxProfileDto|null} profile
 * @property {TaxActualsDto|null} actuals
 * @property {TaxProjectionDto|null} projection
 * @property {TaxFederalDto|null} federal
 * @property {TaxStateDto|null} state
 * @property {TaxPaymentsDto|null} payments
 * @property {TaxSafeHarborDto|null} safeHarbor
 * @property {TaxReserveDto|null} reserve
 * @property {Array<Object>} deadlines
 * @property {TaxConfidenceDto|null} confidence
 * @property {Array<TaxWarningDto>} warnings
 * @property {Array<TaxAssumptionDto>} assumptions
 * @property {Array<Object>} unsupportedItems
 * @property {Array<Object>} supportedButDeferred
 * @property {TaxExplanationSummaryDto|null} explanationSummary
 * @property {Object<string, string|null>} links
 *
 * @typedef {Object} TaxApiError
 * @property {string} code
 * @property {string} message
 * @property {number|null} status
 * @property {Object|null} details
 * @property {string|null} requestId
 * @property {boolean} retryable
 */

export const TAX_API_TYPES_VERSION = "2026-01";
