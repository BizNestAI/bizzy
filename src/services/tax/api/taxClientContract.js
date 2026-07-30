// /src/services/tax/api/taxClientContract.js

/**
 * @typedef {Object} TaxWarning
 * @property {string} code
 * @property {"low"|"medium"|"high"|"critical"|string} severity
 * @property {string} message
 * @property {string=} action
 */

/**
 * @typedef {Object} TaxAction
 * @property {string} code
 * @property {"high"|"medium"|"low"|string} priority
 * @property {string} title
 * @property {string=} description
 * @property {string=} route
 * @property {Object=} payload
 */

/**
 * @typedef {Object} TaxSetupState
 * @property {string} state
 * @property {string} severity
 * @property {string} title
 * @property {string} message
 * @property {boolean} blocking
 * @property {string[]} completedSteps
 * @property {string[]} missingSteps
 * @property {TaxAction[]} actions
 */

/**
 * @typedef {Object} TaxConfidenceDto
 * @property {number} score
 * @property {"high"|"medium"|"low"|"unavailable"|string} level
 * @property {string} status
 * @property {boolean} estimateReady
 * @property {boolean} reserveReady
 * @property {Object} confidenceBySection
 * @property {Object[]} blockers
 * @property {TaxAction[]} improvementActions
 * @property {Object} materialUncertainty
 */

/**
 * @typedef {Object} TaxReserveDto
 * @property {string} status
 * @property {string} strategy
 * @property {?number} currentReserve
 * @property {?number} recommendedReserve
 * @property {?number} reserveGap
 * @property {?number} immediateTransferRecommended
 * @property {?number} weeklySetAside
 * @property {?number} monthlySetAside
 * @property {?number} nextPaymentAmount
 * @property {?string} nextPaymentDate
 * @property {TaxConfidenceDto|Object} confidence
 */

/**
 * @typedef {Object} TaxTrendPoint
 * @property {string} month
 * @property {?number} estTax
 * @property {?number} actualTax
 * @property {?number} projectedTax
 * @property {"actual"|"projected"|"current_partial"|string} periodType
 * @property {boolean} isCurrent
 */

/**
 * Stable canonical calculation payload returned by /api/tax/calculations and /api/tax/overview.
 * Large component, source, transaction, and export payloads remain separate endpoints unless explicitly included.
 *
 * @typedef {Object} TaxCalculationDto
 * @property {Object} meta
 * @property {Object} readiness
 * @property {Object} summary
 * @property {Object} profile
 * @property {Object} actuals
 * @property {Object} projection
 * @property {Object} federal
 * @property {Object} state
 * @property {Object} payments
 * @property {Object} safeHarbor
 * @property {TaxReserveDto} reserve
 * @property {Array} deadlines
 * @property {TaxConfidenceDto} confidence
 * @property {TaxWarning[]} warnings
 * @property {Array} assumptions
 * @property {Array} unsupportedItems
 * @property {Array} supportedButDeferred
 * @property {Object} explanationSummary
 * @property {Object} links
 */

export const TAX_CLIENT_CONTRACT = Object.freeze({
  dto: "TaxCalculationDto",
  setupState: "TaxSetupState",
  confidence: "TaxConfidenceDto",
  reserve: "TaxReserveDto",
});
