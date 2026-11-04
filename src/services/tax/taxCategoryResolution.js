import { validationError } from './taxErrors.js';

export const TEMPORARY_TAX_CATEGORIES = new Set([
  '', 'unresolved', 'unclassified', 'needs_review', 'pending',
  'pending_classification', 'unknown', 'not_determined',
]);

export const CATEGORY_RESOLUTION_OPTIONS = Object.freeze([
  ['supplies', 'Supplies'], ['office_expense', 'Office Expense'],
  ['advertising', 'Advertising'], ['bank_fees', 'Bank Fees'],
  ['interest_expense', 'Interest Expense'], ['taxes_licenses', 'Taxes & Licenses'],
  ['legal_professional', 'Legal & Professional'], ['business_insurance', 'Business Insurance'],
  ['software_subscriptions', 'Software Subscriptions'], ['equipment_rental', 'Equipment Rental'],
  ['rent_lease', 'Rent Lease'], ['personal_expense', 'Personal Expense'],
  ['entertainment', 'Entertainment (not deductible)'],
].map(([value, label]) => ({ value, label })));

// Bookkeeping suggestions are deliberately excluded: they do not establish a
// suggested tax treatment. The same facts participate in preview scope checks.
export function categoryResolutionFacts(row = {}) {
  const metadata = row.metadata || row.raw?.metadata || {};
  const suggestion = metadata.tax_category_suggestion || {};
  const confidence = Number(suggestion.confidence);
  const score = confidence <= 1 ? confidence * 100 : confidence;
  const suggestedCategory = score >= 80 && score <= 100 &&
    CATEGORY_RESOLUTION_OPTIONS.some(option => option.value === suggestion.taxCategory)
    ? suggestion.taxCategory : '';
  return {
    suggestedCategory,
    reasonCode: String(metadata.review_reason_code || metadata.reason_code || 'category_review'),
  };
}

export function categoryResolutionTitle(facts = {}, type = 'category_confirmation') {
  if (type === 'rent_treatment') return 'Confirm Rent Lease treatment';
  const label = CATEGORY_RESOLUTION_OPTIONS.find(option => option.value === facts.suggestedCategory)?.label;
  return label ? `Confirm ${label} classification` : 'Choose a tax category';
}

export function assertFinalTaxCategory(category) {
  if (TEMPORARY_TAX_CATEGORIES.has(String(category || '').trim().toLowerCase())) {
    throw validationError('temporary_tax_category', 'Choose a final tax category. Unresolved is a temporary review state.');
  }
}

export function categoryTreatmentForAnswer(input = {}, decisionType) {
  const category = String(input.taxCategory || '');
  assertFinalTaxCategory(category);
  if (!CATEGORY_RESOLUTION_OPTIONS.some(option => option.value === category)) {
    throw validationError('unsupported_tax_category', 'Choose a supported expense category or use the dedicated review workflow.');
  }
  if (input.businessPurposeConfirmed !== true) {
    throw validationError('business_purpose_required', 'Confirm the business purpose before saving.');
  }
  if (decisionType === 'rent_treatment' || ['rent_lease', 'equipment_rental'].includes(category)) {
    if (!['business_premises', 'equipment_rental'].includes(input.rentUse) || input.currentYearConfirmed !== true) {
      throw validationError('rent_clarification_required', 'Confirm what was rented and that the payment covers this tax year. Vehicle, home-office, prepaid or asset costs need separate review.');
    }
    if (category !== (input.rentUse === 'business_premises' ? 'rent_lease' : 'equipment_rental')) {
      throw validationError('rent_category_mismatch', 'The category must match what was rented.');
    }
  }
  const percent = ['personal_expense', 'entertainment'].includes(category) ? 0 : 100;
  return {
    taxCategory: category,
    deductibilityStatus: percent ? 'fully_deductible' : 'nondeductible',
    deductiblePercent: percent,
    taxTreatment: percent ? 'category_business_purchase_confirmed' : 'category_nondeductible_confirmed',
  };
}
