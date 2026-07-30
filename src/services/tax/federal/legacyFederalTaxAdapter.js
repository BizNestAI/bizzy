// /src/services/tax/federal/legacyFederalTaxAdapter.js

export function toLegacyFederalTaxFields(canonical) {
  if (!canonical) return null;
  return {
    federal: canonical.tax?.federalIncomeTax ?? 0,
    taxableBase: canonical.income?.taxableIncomeAfterQbi ?? 0,
    marginalRate: canonical.tax?.marginalRate ?? 0,
    bracketBreakdown: canonical.tax?.bracketBreakdown || [],
    federalIncomeTax: canonical.tax?.federalIncomeTax ?? 0,
    canonicalFederal: canonical,
  };
}
