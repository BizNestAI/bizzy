// /src/services/tax/taxLiabilityEngine.js

/**
 * -------- Overview ----------------------------------------------------------
 * - computeTaxFromBrackets(amount, brackets, opts?)
 *     Computes progressive tax using bracket tiers.
 *     Your calculateTaxLiability() passes a *monthly* taxable amount and
 *     the config contains *annual* federal brackets. We detect this and,
 *     by default, annualize the amount (×12), compute annual tax, then
 *     de-annualize (÷12) to return a monthly figure.
 *
 * - computeSETax(annualProfit, fica, opts?)
 *     Computes annual self-employment tax (SS + Medicare) using the
 *     given FICA parameters and then returns the total annual SE tax.
 *     Your calculateTaxLiability() already calls this with annualized
 *     profit (profit * 12) and then divides by 12.
 * ---------------------------------------------------------------------------
 */

/**
 * Compute progressive tax for a value using a bracket table.
 *
 * @param {number} amount - The taxable amount for the *period* you’re passing.
 * @param {Array<{upTo:number|null, rate:number}>} brackets
 *   - May be either:
 *     (A) cumulative endpoints (e.g., 11k, 44,725, 95,375, ... , null)
 *     (B) segment widths (e.g., 11k, (44,725-11k), (95,375-44,725), ...)
 *   - We’ll normalize either style to cumulative endpoints internally.
 * @param {Object} [opts]
 * @param {boolean} [opts.isAnnualAmount=false]
 *   - If false (default), we assume `amount` is monthly and brackets are annual:
 *     we compute annual tax on (amount*12) then divide by 12.
 *     Set true if you pass an annual number and want annual tax returned.
 * @param {number} [opts.periodsPerYear=12] - Used when isAnnualAmount=false.
 * @returns {number} tax for the same period as `amount` (monthly by default)
 */
export function computeTaxFromBrackets(amount = 0, brackets = [], opts = {}) {
  const isAnnualAmount = opts.isAnnualAmount ?? false;
  const periodsPerYear = Math.max(1, Number(opts.periodsPerYear ?? 12));
  if (!Array.isArray(brackets) || brackets.length === 0) return 0;

  const tiers = normalizeToCumulative(brackets);
  const annualTaxable = isAnnualAmount ? toNumber(amount) : toNumber(amount) * periodsPerYear;
  const annualTax = marginalTax(annualTaxable, tiers);
  return isAnnualAmount ? round2(annualTax) : round2(annualTax / periodsPerYear);
}

export function computeSETax(
  annualProfit = 0,
  fica = { ssWageBase: 0, ssRate: 0.062, medicareRate: 0.0145 },
  opts = {}
) {
  const income = Math.max(0, Number(annualProfit) || 0);
  const multiplier = Number(opts.multiplier ?? 2);

  const ssBase = Number(fica.ssWageBase) || 0;
  const ssRate = Number(fica.ssRate) || 0.062;
  const medicareRate = Number(fica.medicareRate) || 0.0145;

  const ssTaxable = Math.min(income, ssBase);
  const ss = ssTaxable * ssRate * multiplier;

  let medicare = income * medicareRate * multiplier;

  const addRate = Number(opts.additionalMedicareRate ?? 0);
  const addThresh = Number(opts.additionalMedicareThreshold ?? Infinity);
  if (addRate > 0 && isFinite(addThresh) && income > addThresh) {
    medicare += (income - addThresh) * addRate;
  }

  return round2(ss + medicare);
}

function normalizeToCumulative(brackets) {
  const out = [];
  let running = 0;
  let looksLikeCumulative = true;

  for (let i = 1; i < brackets.length; i++) {
    const prev = brackets[i - 1]?.upTo;
    const cur = brackets[i]?.upTo;
    if (prev != null && cur != null && cur < prev) {
      looksLikeCumulative = false;
      break;
    }
  }

  if (looksLikeCumulative) {
    for (const b of brackets) {
      out.push({ upTo: b.upTo == null ? null : Number(b.upTo), rate: Number(b.rate) || 0 });
    }
  } else {
    for (const b of brackets) {
      if (b.upTo == null) {
        out.push({ upTo: null, rate: Number(b.rate) || 0 });
      } else {
        running += Number(b.upTo) || 0;
        out.push({ upTo: running, rate: Number(b.rate) || 0 });
      }
    }
  }

  const last = out[out.length - 1];
  if (last && last.upTo != null) out[out.length - 1] = { ...last, upTo: null };

  return out;
}

function marginalTax(annualAmount, tiers) {
  let remaining = Math.max(0, Number(annualAmount) || 0);
  let tax = 0;
  let lowerBound = 0;

  for (const t of tiers) {
    const limit = t.upTo == null ? Infinity : Number(t.upTo) || 0;
    const width = Math.max(0, Math.min(remaining, limit - lowerBound));
    if (width <= 0) {
      lowerBound = limit;
      continue;
    }
    tax += width * (Number(t.rate) || 0);
    remaining -= width;
    lowerBound = limit;
    if (remaining <= 0) break;
  }

  return tax;
}

function toNumber(n) { return typeof n === "number" ? n : Number(n || 0); }
function round2(n) { return Math.round((toNumber(n) + Number.EPSILON) * 100) / 100; }