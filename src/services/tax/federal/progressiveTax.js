// /src/services/tax/federal/progressiveTax.js
import { validationError } from "../taxErrors.js";
import { round2 } from "./federalTaxDomain.js";

export function validateProgressiveBrackets(brackets) {
  if (!Array.isArray(brackets) || !brackets.length) {
    throw validationError("invalid_progressive_brackets", "Progressive brackets must be a non-empty array.", { field: "brackets" });
  }
  let previousUpTo = 0;
  return brackets.map((bracket, index) => {
    if (!bracket || typeof bracket !== "object") {
      throw validationError("invalid_progressive_brackets", "Each bracket must be an object.", { index });
    }
    const upTo = bracket.upTo ?? bracket.up_to ?? null;
    const rate = Number(bracket.rate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
      throw validationError("invalid_progressive_brackets", "Bracket rate must be between 0 and 1.", { index });
    }
    const normalizedUpTo = upTo == null ? null : Number(upTo);
    if (normalizedUpTo != null && (!Number.isFinite(normalizedUpTo) || normalizedUpTo < 0)) {
      throw validationError("invalid_progressive_brackets", "Bracket upTo must be nonnegative or null.", { index });
    }
    if (index < brackets.length - 1 && normalizedUpTo == null) {
      throw validationError("invalid_progressive_brackets", "Only the final bracket may have null upTo.", { index });
    }
    if (normalizedUpTo != null && normalizedUpTo <= previousUpTo) {
      throw validationError("invalid_progressive_brackets", "Bracket endpoints must be cumulative and ordered.", { index });
    }
    if (normalizedUpTo != null) previousUpTo = normalizedUpTo;
    return { upTo: normalizedUpTo, rate };
  });
}

export function computeProgressiveTax({ taxableIncome, brackets } = {}) {
  const income = Math.max(0, Number(taxableIncome || 0));
  if (!Number.isFinite(income)) {
    throw validationError("invalid_taxable_income", "taxableIncome must be a finite number.", { field: "taxableIncome" });
  }
  const validBrackets = validateProgressiveBrackets(brackets);
  let lowerBound = 0;
  let totalTax = 0;
  let marginalRate = 0;
  const bracketBreakdown = [];

  for (const bracket of validBrackets) {
    const upperBound = bracket.upTo;
    const bracketCeiling = upperBound == null ? Infinity : upperBound;
    const taxableInBracket = Math.max(0, Math.min(income, bracketCeiling) - lowerBound);
    const tax = taxableInBracket * bracket.rate;
    if (taxableInBracket > 0 || income >= lowerBound) marginalRate = bracket.rate;
    totalTax += tax;
    bracketBreakdown.push({
      lowerBound: round2(lowerBound),
      upperBound: upperBound == null ? null : round2(upperBound),
      taxableInBracket: round2(taxableInBracket),
      rate: bracket.rate,
      tax: round2(tax),
    });
    if (income <= bracketCeiling) break;
    lowerBound = bracketCeiling;
  }

  return {
    taxableIncome: round2(income),
    totalTax: round2(totalTax),
    marginalRate,
    effectiveRate: income > 0 ? round2(totalTax / income) : 0,
    bracketBreakdown,
  };
}
