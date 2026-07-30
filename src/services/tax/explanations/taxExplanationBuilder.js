// /src/services/tax/explanations/taxExplanationBuilder.js
import { createTaxExplanationComponent } from "./taxExplanationComponent.js";
import { TAX_EXPLANATION_COMPONENT_GROUPS as GROUPS, TAX_EXPLANATION_DIRECTIONS as DIRECTIONS } from "./taxExplanationDomain.js";
import { aggregateTransactionClassificationRef, compactRefs, profileRef, systemAssumptionRef } from "./taxSourceReferenceBuilder.js";
import { normalizeExplanationAssumptions, normalizeExplanationWarnings } from "./taxExplanationWarnings.js";

export function buildTaxExplanationComponents({ canonicalResult, previousRun = null } = {}) {
  const c = canonicalResult || {};
  const components = [];
  const add = (component) => components.push(component);
  const profile = c.profile?.profile || {};
  const businessId = c.meta?.businessId;
  const taxYear = c.meta?.taxYear;
  let sort = 0;
  const nextSort = () => (sort += 10);

  add(component({
    key: "profile:entity_setup",
    type: "profile_entity_setup",
    group: GROUPS.PROFILE,
    name: "Tax profile setup",
    amount: 0,
    direction: DIRECTIONS.INFORMATIONAL,
    formula: { expression: "entity_type + tax_election + filing_status + primary_tax_state", variables: { entityType: profile.entity_type, taxElection: profile.tax_election, filingStatus: profile.filing_status, state: profile.primary_tax_state }, result: 0 },
    summary: `Profile uses ${profile.entity_type || "unknown entity"} with ${profile.tax_election || "unknown election"}.`,
    refs: compactRefs([profileRef(profile, "entity_type"), profileRef(profile, "tax_election"), profileRef(profile, "filing_status"), profileRef(profile, "primary_tax_state")]),
    sort: nextSort(),
  }));

  const revenue = c.actuals?.taxableIncome?.revenue || {};
  add(component({
    key: "revenue:net_business_revenue",
    type: "net_business_revenue",
    group: GROUPS.REVENUE,
    name: "Net business revenue",
    amount: revenue.netBusinessRevenue,
    direction: DIRECTIONS.INCREASE_TAXABLE_INCOME,
    formula: {
      expression: "gross_receipts + other_business_income - returns_allowances",
      variables: {
        gross_receipts: money(revenue.grossReceipts),
        other_business_income: money(revenue.otherBusinessIncome),
        returns_allowances: money(revenue.returnsAndAllowances),
      },
      result: money(revenue.netBusinessRevenue),
    },
    summary: "Business revenue included in taxable income.",
    refs: [aggregateTransactionClassificationRef({ businessId, taxYear, taxCategory: "income", count: c.actuals?.coverage?.classifiedTransactions || 0 })],
    sort: nextSort(),
  }));

  const expenses = c.actuals?.taxableIncome?.expenses || {};
  add(component({
    key: "expenses:cogs",
    type: "cost_of_goods_sold",
    group: GROUPS.COGS,
    name: "Cost of goods sold",
    amount: money(expenses.costOfGoodsSold),
    direction: DIRECTIONS.DECREASE_TAXABLE_INCOME,
    formula: { expression: "sum(classified_cogs_amounts)", variables: { cost_of_goods_sold: money(expenses.costOfGoodsSold) }, result: money(expenses.costOfGoodsSold) },
    summary: "COGS reduces gross profit before operating expenses.",
    refs: [aggregateTransactionClassificationRef({ businessId, taxYear, taxCategory: "cost_of_goods_sold", count: null })],
    sort: nextSort(),
  }));

  add(component({
    key: "expenses:deductible_operating",
    type: "deductible_operating_expenses",
    group: GROUPS.DEDUCTIONS,
    name: "Deductible operating expenses",
    amount: money(expenses.deductibleOperatingExpenses),
    direction: DIRECTIONS.DECREASE_TAXABLE_INCOME,
    formula: { expression: "sum(confirmed_and_supported_deductible_classification_amounts)", variables: { deductible_operating_expenses: money(expenses.deductibleOperatingExpenses) }, result: money(expenses.deductibleOperatingExpenses) },
    summary: "Operating expenses currently treated as deductible.",
    refs: [aggregateTransactionClassificationRef({ businessId, taxYear, count: c.actuals?.coverage?.classifiedTransactions || 0 })],
    sort: nextSort(),
  }));

  add(component({
    key: "expenses:nondeductible_addbacks",
    type: "nondeductible_addbacks",
    group: GROUPS.NONDEDUCTIBLE_ADDBACKS,
    name: "Nondeductible book expenses",
    amount: money(expenses.nondeductibleBookExpenses),
    direction: DIRECTIONS.INCREASE_TAXABLE_INCOME,
    formula: { expression: "sum(nondeductible_classification_amounts)", variables: { nondeductible_book_expenses: money(expenses.nondeductibleBookExpenses) }, result: money(expenses.nondeductibleBookExpenses) },
    summary: "Book expenses that do not reduce taxable income.",
    sort: nextSort(),
  }));

  add(component({
    key: "expenses:capitalizable_expenditures",
    type: "capitalizable_expenditures",
    group: GROUPS.CAPITAL_ASSETS,
    name: "Capitalizable purchases",
    amount: money(expenses.capitalizableExpenditures),
    direction: DIRECTIONS.NEUTRAL,
    formula: { expression: "sum(capitalizable_classification_amounts)", variables: { capitalizable_expenditures: money(expenses.capitalizableExpenditures) }, result: money(expenses.capitalizableExpenditures) },
    summary: "Capitalizable purchases are tracked separately from current deductions.",
    sort: nextSort(),
  }));

  const taxable = c.actuals?.taxableIncome?.businessTaxableIncome || {};
  const adjustments = c.actuals?.taxableIncome?.adjustments || {};
  add(component({
    key: "taxable_income:business_taxable_income",
    type: "taxable_business_income",
    group: GROUPS.TAXABLE_INCOME,
    name: "Taxable business income",
    amount: money(taxable.finalBusinessTaxableIncome),
    direction: money(taxable.finalBusinessTaxableIncome) >= 0 ? DIRECTIONS.INCREASE_TAXABLE_INCOME : DIRECTIONS.DECREASE_TAXABLE_INCOME,
    formula: {
      expression: "gross_profit - deductible_operating_expenses + increases_to_taxable_income - decreases_to_taxable_income",
      variables: {
        gross_profit: money(expenses.grossProfit),
        deductible_operating_expenses: money(expenses.deductibleOperatingExpenses),
        increases_to_taxable_income: money(adjustments.increasesToTaxableIncome),
        decreases_to_taxable_income: money(adjustments.decreasesToTaxableIncome),
      },
      result: money(taxable.finalBusinessTaxableIncome),
    },
    summary: "Actual YTD taxable business income after book-to-tax adjustments.",
    sort: nextSort(),
  }));

  const projected = c.projection?.projectedAnnual || {};
  add(component({
    key: "projection:annual_taxable_income",
    type: "projected_taxable_income",
    group: GROUPS.PROJECTION,
    name: "Projected annual taxable income",
    amount: money(projected.taxableBusinessIncome),
    direction: DIRECTIONS.INFORMATIONAL,
    formula: {
      expression: "actual_ytd_taxable_income + projected_future_taxable_income",
      variables: {
        actual_ytd_taxable_income: money(c.projection?.actual?.taxableBusinessIncome),
        projected_future_taxable_income: money(c.projection?.projectedFuture?.taxableBusinessIncome),
        method: c.projection?.method,
      },
      result: money(projected.taxableBusinessIncome),
    },
    summary: `Annual projection using ${c.projection?.method || "unknown"} method.`,
    refs: [systemAssumptionRef("Projection method", "method", c.projection?.method)],
    warnings: c.projection?.confidence?.penalties || [],
    sort: nextSort(),
  }));

  add(component({
    key: "entity:routing",
    type: "entity_routing",
    group: GROUPS.ENTITY,
    name: "Entity routing",
    amount: 0,
    direction: DIRECTIONS.INFORMATIONAL,
    formula: { expression: "entity_path determines downstream tax engines", variables: c.entity?.routing || {}, result: 0 },
    summary: `Entity path is ${c.entity?.entityPath || "unknown"}.`,
    warnings: c.entity?.warnings || [],
    sort: nextSort(),
  }));

  const federal = c.federal?.incomeTax;
  if (federal) {
    add(component({
      key: "federal:agi",
      type: "federal_adjusted_gross_income",
      group: GROUPS.FEDERAL_TAX,
      name: "Federal adjusted gross income",
      amount: money(federal.income?.adjustedGrossIncome),
      direction: DIRECTIONS.INFORMATIONAL,
      formula: {
        expression: "business_income + other_income - above_the_line_adjustments",
        variables: {
          business_income: money(federal.income?.annualBusinessTaxableIncome),
          other_income: money(federal.income?.otherIncome),
          above_the_line_adjustments: money(federal.deductions?.aboveTheLineAdjustments),
        },
        result: money(federal.income?.adjustedGrossIncome),
      },
      summary: "Federal AGI input before standard deduction.",
      sort: nextSort(),
    }));
    add(component({
      key: "federal:standard_deduction",
      type: "standard_deduction",
      group: GROUPS.FEDERAL_TAX,
      name: "Standard deduction",
      amount: money(federal.deductions?.standardDeduction),
      direction: DIRECTIONS.DECREASE_TAXABLE_INCOME,
      formula: { expression: "configured_standard_deduction_for_filing_status", variables: { filing_status: federal.meta?.filingStatus || profile.filing_status }, result: money(federal.deductions?.standardDeduction) },
      summary: "Standard deduction applied from federal rule config.",
      ruleRefs: ruleRefsFromVersions(federal.meta?.ruleVersions, "federal"),
      sort: nextSort(),
    }));
    for (const [index, bracket] of (federal.tax?.bracketBreakdown || []).entries()) {
      add(component({
        key: `federal:bracket:${index + 1}`,
        type: "federal_tax_bracket",
        group: GROUPS.FEDERAL_TAX,
        name: `Federal bracket ${index + 1}`,
        taxableBase: money(bracket.taxableInBracket),
        rate: bracket.rate,
        amount: money(bracket.tax),
        direction: DIRECTIONS.INCREASE_TAX,
        formula: {
          expression: "taxable_in_bracket × bracket_rate",
          variables: { lower_bound: bracket.lowerBound, upper_bound: bracket.upperBound, taxable_in_bracket: bracket.taxableInBracket, bracket_rate: bracket.rate },
          result: money(bracket.tax),
        },
        summary: "Federal progressive bracket tax.",
        ruleRefs: ruleRefsFromVersions(federal.meta?.ruleVersions, "federal_income_tax_brackets"),
        sort: nextSort(),
      }));
    }
    add(component({
      key: "federal:regular_income_tax",
      type: "regular_federal_income_tax",
      group: GROUPS.FEDERAL_TAX,
      name: "Regular federal income tax",
      taxableBase: money(federal.income?.taxableIncomeAfterQbi),
      rate: federal.tax?.effectiveRate,
      amount: money(federal.tax?.federalIncomeTax),
      direction: DIRECTIONS.INCREASE_TAX,
      formula: { expression: "sum(federal_bracket_tax)", variables: { bracket_tax_total: money(federal.tax?.federalIncomeTax) }, result: money(federal.tax?.federalIncomeTax) },
      summary: "Regular federal income tax from annual progressive brackets.",
      warnings: federal.warnings || [],
      sort: nextSort(),
    }));
  }

  const se = c.federal?.selfEmploymentTax;
  if (se) {
    add(component({
      key: "self_employment:net_earnings",
      type: "se_net_earnings",
      group: GROUPS.SELF_EMPLOYMENT_TAX,
      name: "SE net earnings",
      taxableBase: money(se.input?.annualNetBusinessIncome),
      rate: se.components?.find((row) => row.componentType === "net_earnings_from_self_employment")?.rate || null,
      amount: money(se.result?.netEarningsFromSelfEmployment),
      direction: DIRECTIONS.INFORMATIONAL,
      formula: { expression: "net_business_income × net_earnings_factor", variables: { net_business_income: money(se.input?.annualNetBusinessIncome), net_earnings_factor: se.components?.find((row) => row.componentType === "net_earnings_from_self_employment")?.rate }, result: money(se.result?.netEarningsFromSelfEmployment) },
      summary: "Net earnings subject to self-employment tax.",
      sort: nextSort(),
    }));
    add(component({
      key: "self_employment:tax_total",
      type: "self_employment_tax",
      group: GROUPS.SELF_EMPLOYMENT_TAX,
      name: "Self-employment tax",
      amount: money(se.result?.totalSelfEmploymentTax),
      direction: DIRECTIONS.INCREASE_TAX,
      formula: {
        expression: "social_security_tax + medicare_tax + additional_medicare_tax",
        variables: { social_security_tax: money(se.result?.socialSecurityTax), medicare_tax: money(se.result?.medicareTax), additional_medicare_tax: money(se.result?.additionalMedicareTax) },
        result: money(se.result?.totalSelfEmploymentTax),
      },
      summary: "Total annual self-employment tax.",
      warnings: se.warnings || [],
      sort: nextSort(),
    }));
    add(component({
      key: "self_employment:deductible_half",
      type: "half_self_employment_tax_adjustment",
      group: GROUPS.SELF_EMPLOYMENT_TAX,
      name: "Deductible half of SE tax",
      amount: money(se.result?.deductibleHalfSelfEmploymentTax),
      direction: DIRECTIONS.DECREASE_TAXABLE_INCOME,
      formula: { expression: "total_self_employment_tax × deductible_portion_rate", variables: { total_self_employment_tax: money(se.result?.totalSelfEmploymentTax), deductible_portion_rate: 0.5 }, result: money(se.result?.deductibleHalfSelfEmploymentTax) },
      summary: "Half-SE-tax adjustment passed to federal income tax.",
      sort: nextSort(),
    }));
  }

  if (c.federal?.payrollTaxContext || c.federal?.incomeTax?.income?.otherIncome) {
    add(component({
      key: "s_corp:owner_wages",
      type: "s_corp_owner_wages",
      group: GROUPS.S_CORP,
      name: "S-Corp owner wages",
      amount: money(c.federal?.incomeTax?.income?.otherIncome),
      direction: DIRECTIONS.INCREASE_TAXABLE_INCOME,
      formula: { expression: "owner_w2_wages_included_as_other_income", variables: { owner_w2_wages: money(c.federal?.incomeTax?.income?.otherIncome) }, result: money(c.federal?.incomeTax?.income?.otherIncome) },
      summary: "Owner W-2 wages are separated from S-Corp pass-through income.",
      warnings: c.federal?.payrollTaxContext?.payrollWarnings || [],
      sort: nextSort(),
    }));
  }

  const state = c.state?.incomeTax;
  const individualState = c.state?.individualIncomeTax || state?.individualIncomeTax || null;
  const entityState = c.state?.entityTaxes?.detail || state?.entityTax || null;
  const provisionalReserve = c.state?.provisionalReserve || state?.provisionalReserve || null;
  add(component({
    key: "state:income_tax",
    type: "state_income_tax",
    group: GROUPS.STATE_TAX,
    name: "State income tax",
    taxableBase: money(state?.income?.stateTaxableIncome),
    amount: nullableMoney(c.state?.totalStateTax),
    direction: DIRECTIONS.INCREASE_TAX,
    formula: { expression: "state_taxable_income × configured_state_rule", variables: { state_taxable_income: money(state?.income?.stateTaxableIncome), state_code: c.state?.stateCode }, result: money(c.state?.totalStateTax) },
    summary: c.state?.totalStateTaxStatus === "partial"
      ? "Total state liability is partial because material state entity/business components are not fully calculated."
      : c.state?.totalStateTax ? "State tax from verified or supported state config." : "State tax unavailable or zero based on state config.",
    warnings: c.state?.incomeTax?.warnings || [],
    sort: nextSort(),
  }));
  if (individualState?.status === "verified_zero") {
    add(component({
      key: "state:individual_verified_zero",
      type: "state_individual_income_tax_zero",
      group: GROUPS.STATE_TAX,
      name: "Individual income-tax component",
      amount: 0,
      direction: DIRECTIONS.INFORMATIONAL,
      formula: { expression: "verified_no_broad_individual_income_tax", variables: { state_code: c.state?.stateCode }, result: 0 },
      summary: individualState.userFacingExplanation || "No broad individual earned-income tax.",
      sort: nextSort(),
    }));
  }
  if (state?.deductions?.standardDeductionDetails?.notApplicable === true) {
    add(component({
      key: "state:standard_deduction",
      type: "state_standard_deduction",
      group: GROUPS.STATE_TAX,
      name: "State standard deduction",
      amount: 0,
      direction: DIRECTIONS.INFORMATIONAL,
      formula: { expression: "state_standard_deduction_not_applicable", variables: { state_code: c.state?.stateCode }, result: 0 },
      summary: "Not applicable.",
      sort: nextSort(),
    }));
  }
  const stateDeductionAdjustment = state?.income?.stateDeductionAdjustment || state?.components?.find?.((row) => row.componentType === "state_deduction_adjustment");
  if (stateDeductionAdjustment?.amount != null || stateDeductionAdjustment?.status === "partial") {
    add(component({
      key: "state:deduction_addback",
      type: "state_deduction_adjustment",
      group: GROUPS.STATE_TAX,
      name: "State deduction addback",
      amount: nullableMoney(stateDeductionAdjustment.amount),
      direction: DIRECTIONS.INCREASE_TAXABLE_INCOME,
      formula: {
        expression: "max(0, federal_standard_or_itemized_deduction - state_retained_limit)",
        variables: {
          federal_deduction: money(stateDeductionAdjustment.federalDeduction),
          state_retained_limit: money(stateDeductionAdjustment.retainedLimit),
        },
        result: nullableMoney(stateDeductionAdjustment.amount),
      },
      summary: stateDeductionAdjustment.status === "partial"
        ? "State deduction addback is partial because AGI, filing status, or federal deduction amount is missing."
        : "State deduction addback applies under the configured state adjustment rule.",
      sort: nextSort(),
    }));
  }
  if (entityState?.franchiseTax?.amount != null || entityState?.franchiseTax?.status === "partial") {
    add(component({
      key: "state:franchise_tax",
      type: "state_franchise_tax",
      group: GROUPS.STATE_TAX,
      name: "State franchise tax",
      amount: nullableMoney(entityState.franchiseTax.amount),
      direction: DIRECTIONS.INCREASE_TAX,
      formula: { expression: "state_net_worth_base × franchise_tax_rate_subject_to_minimum_after_applicability", variables: { tax_base: money(entityState.franchiseTax.taxBase), rate_tax: money(entityState.franchiseTax.rateTax), minimum_tax: money(entityState.franchiseTax.minimumTax) }, result: nullableMoney(entityState.franchiseTax.amount) },
      summary: entityState.franchiseTax.status === "partial" ? "Franchise tax is partial until entity applicability, exemption status, and state net worth are known." : "Franchise tax is calculated separately from individual income tax.",
      sort: nextSort(),
    }));
  }
  const capitalGainsExcise = c.state?.capitalGainsExciseTax || state?.capitalGainsExciseTax;
  if (capitalGainsExcise?.amount != null || capitalGainsExcise?.status === "partial") {
    add(component({
      key: "state:capital_gains_excise",
      type: "state_capital_gains_excise_tax",
      group: GROUPS.STATE_TAX,
      name: "State capital-gains excise",
      amount: nullableMoney(capitalGainsExcise.amount),
      direction: DIRECTIONS.INCREASE_TAX,
      formula: { expression: "taxable_state_long_term_capital_gains × marginal_excise_rates", variables: { taxable_capital_gains: money(capitalGainsExcise.taxableWashingtonCapitalGains) }, result: nullableMoney(capitalGainsExcise.amount) },
      summary: capitalGainsExcise.status === "partial" ? "Capital-gains excise is partial until the current-year deduction and qualifying gain inputs are available." : "Capital-gains excise is separate from conventional individual income tax.",
      sort: nextSort(),
    }));
  }
  const grossReceiptsTax = c.state?.businessExcises?.grossReceiptsTax || state?.businessExcises?.grossReceiptsTax;
  if (grossReceiptsTax?.amount != null || grossReceiptsTax?.status === "partial") {
    add(component({
      key: "state:gross_receipts_tax",
      type: "state_gross_receipts_tax",
      group: GROUPS.STATE_TAX,
      name: "State gross-receipts tax",
      amount: nullableMoney(grossReceiptsTax.amount),
      direction: DIRECTIONS.INCREASE_TAX,
      formula: { expression: "gross_receipts_by_classification × official_classification_rate", variables: { gross_receipts: money(grossReceiptsTax.taxBase), rate: grossReceiptsTax.rate }, result: nullableMoney(grossReceiptsTax.amount) },
      summary: grossReceiptsTax.status === "partial" ? "Gross-receipts tax is partial until nexus, sourcing, classification, and rate inputs are known." : "Gross-receipts tax is calculated separately from individual income tax.",
      sort: nextSort(),
    }));
  }
  const payrollExciseTax = c.state?.businessExcises?.payrollExciseTax || state?.businessExcises?.payrollExciseTax;
  if (payrollExciseTax?.amount != null || payrollExciseTax?.status === "partial") {
    add(component({
      key: "state:payroll_excise_tax",
      type: "state_payroll_excise_tax",
      group: GROUPS.STATE_TAX,
      name: "State payroll excise",
      amount: nullableMoney(payrollExciseTax.amount),
      direction: DIRECTIONS.INCREASE_TAX,
      formula: { expression: "taxable_state_wages × payroll_excise_rate", variables: { taxable_wages: money(payrollExciseTax.taxBase), rate: payrollExciseTax.rate }, result: nullableMoney(payrollExciseTax.amount) },
      summary: payrollExciseTax.status === "partial" ? "Payroll excise is partial until payroll classification and wage inputs are known." : "Payroll excise is separate from individual income tax.",
      sort: nextSort(),
    }));
  }
  const ownerElection = state?.ownerLevelBusinessIncomeElection;
  if (ownerElection?.status === "partial" || ownerElection?.amount != null) {
    add(component({
      key: "state:owner_level_business_income_election",
      type: "owner_level_business_income_election",
      group: GROUPS.STATE_TAX,
      name: "Owner-level business income election",
      amount: nullableMoney(ownerElection.amount),
      direction: DIRECTIONS.INFORMATIONAL,
      formula: { expression: "qualifying_active_trade_or_business_income × owner_level_election_rate", variables: { qualifying_income: money(ownerElection.taxBase), rate: ownerElection.rate }, result: nullableMoney(ownerElection.amount) },
      summary: ownerElection.status === "partial"
        ? "Owner-level elective treatment is partial until qualifying active-trade-or-business income is segmented."
        : "Owner-level elective treatment is separate from PTET and entity tax.",
      sort: nextSort(),
    }));
  }
  if (entityState?.sCorpEntityTax?.replacementTax === true && entityState.sCorpEntityTax.amount != null) {
    add(component({
      key: "state:replacement_tax",
      type: "personal_property_replacement_tax",
      group: GROUPS.STATE_TAX,
      name: "Personal property replacement tax",
      taxableBase: money(entityState.sCorpEntityTax.taxBase),
      rate: entityState.sCorpEntityTax.rate,
      amount: money(entityState.sCorpEntityTax.amount),
      direction: DIRECTIONS.INCREASE_TAX,
      formula: {
        expression: "illinois_net_income × replacement_tax_rate",
        variables: {
          illinois_net_income: money(entityState.sCorpEntityTax.taxBase),
          replacement_tax_rate: entityState.sCorpEntityTax.rate,
        },
        result: money(entityState.sCorpEntityTax.amount),
      },
      summary: "Illinois Personal Property Replacement Tax is separate from elective PTET and does not use minimum-tax logic.",
      sort: nextSort(),
    }));
  }
  if (entityState?.status === "partial") {
    add(component({
      key: "state:entity_caveat",
      type: "state_entity_tax_caveat",
      group: GROUPS.STATE_TAX,
      name: "Business/entity state component",
      amount: null,
      direction: DIRECTIONS.INFORMATIONAL,
      formula: { expression: "entity_tax_component_deferred", variables: { possible_taxes: entityState.possibleTaxes || [] }, result: null },
      summary: "Business/entity taxes may apply and are not fully calculated.",
      sort: nextSort(),
    }));
  }
  if (provisionalReserve?.status === "available") {
    add(component({
      key: "state:provisional_reserve",
      type: "provisional_state_reserve",
      group: GROUPS.RESERVE,
      name: "Suggested provisional state reserve",
      amount: money(provisionalReserve.amount),
      direction: DIRECTIONS.INFORMATIONAL,
      formula: {
        expression: "projected_state_apportionable_income × (base_reserve_rate + uncertainty_buffer_rate)",
        variables: {
          projected_state_apportionable_income: money(provisionalReserve.taxableIncomeBase),
          base_reserve_rate: 0.07,
          uncertainty_buffer_rate: 0.02,
          base_reserve: money(provisionalReserve.baseReserve),
          uncertainty_buffer: money(provisionalReserve.uncertaintyBuffer),
        },
        result: money(provisionalReserve.amount),
      },
      summary: provisionalReserve.disclaimer || "Not a calculated state tax liability.",
      sort: nextSort(),
    }));
  }

  const payments = c.payments || {};
  const paid = money(c.liability?.paymentsAndWithholdingYtd);
  add(component({
    key: "payments:payments_and_withholding",
    type: "payments_and_withholding",
    group: GROUPS.PAYMENTS,
    name: "Payments and withholding",
    amount: paid,
    direction: DIRECTIONS.PAYMENT_CREDIT,
    formula: {
      expression: "estimated_payments + withholding + prior_year_credits + refunds_applied",
      variables: {
        federal_estimated_payments: money(payments.federal?.estimatedPayments),
        state_estimated_payments: money(payments.state?.estimatedPayments),
        federal_withholding: money(payments.federal?.withholding),
        state_withholding: money(payments.state?.withholding),
      },
      result: paid,
    },
    summary: "Known tax payments and withholding applied once against projected liability.",
    warnings: payments.reconciliationWarnings || [],
    sort: nextSort(),
  }));

  add(component({
    key: "withholding:total",
    type: "withholding_total",
    group: GROUPS.WITHHOLDING,
    name: "Federal and state withholding",
    amount: money(payments.federal?.withholding) + money(payments.state?.withholding),
    direction: DIRECTIONS.PAYMENT_CREDIT,
    formula: {
      expression: "federal_withholding + state_withholding",
      variables: { federal_withholding: money(payments.federal?.withholding), state_withholding: money(payments.state?.withholding) },
      result: money(payments.federal?.withholding) + money(payments.state?.withholding),
    },
    summary: "Known withholding included as payment credit.",
    sort: nextSort(),
  }));

  add(component({
    key: "liability:remaining",
    type: "remaining_projected_liability",
    group: GROUPS.PAYMENTS,
    name: "Remaining projected liability",
    amount: money(c.liability?.remainingProjectedLiability),
    direction: DIRECTIONS.INFORMATIONAL,
    formula: {
      expression: "projected_total_tax - payments_and_withholding_ytd",
      variables: { projected_total_tax: money(c.liability?.projectedTotalTax), payments_and_withholding_ytd: paid },
      result: money(c.liability?.remainingProjectedLiability),
    },
    summary: "Projected remaining liability after known payments and withholding.",
    sort: nextSort(),
  }));

  add(component({
    key: "safe_harbor:remaining",
    type: "safe_harbor_remaining",
    group: GROUPS.SAFE_HARBOR,
    name: "Safe harbor remaining",
    amount: money(c.safeHarbor?.combined?.remainingAmount),
    direction: DIRECTIONS.INFORMATIONAL,
    formula: {
      expression: "required_annual_safe_harbor - covered_amount",
      variables: { required_annual_safe_harbor: c.safeHarbor?.combined?.requiredAnnual, covered_amount: c.safeHarbor?.combined?.coveredAmount },
      result: c.safeHarbor?.combined?.remainingAmount,
    },
    summary: c.safeHarbor?.combined?.status === "unavailable" ? "Safe harbor is unavailable because required rules or inputs are missing." : "Remaining amount to satisfy configured safe harbor target.",
    warnings: [...(c.safeHarbor?.federal?.warnings || []), ...(c.safeHarbor?.state?.warnings || [])],
    sort: nextSort(),
  }));

  add(component({
    key: "reserve:recommendation",
    type: "recommended_reserve",
    group: GROUPS.RESERVE,
    name: "Recommended reserve before cash comparison",
    amount: money(c.reserveInput?.recommendedReserveBeforeCashComparison),
    direction: DIRECTIONS.RESERVE_ADJUSTMENT,
    formula: {
      expression: "target_before_buffer + (target_before_buffer × reserve_buffer_percent)",
      variables: { target_before_buffer: c.reserve?.reserve?.targetBeforeBuffer, remaining_liability: money(c.reserveInput?.remainingLiability), safe_harbor_gap: c.reserveInput?.safeHarborGap, reserve_buffer_percent: c.reserveInput?.reserveBufferPercent, strategy_used: c.reserve?.reserve?.strategyUsed },
      result: money(c.reserveInput?.recommendedReserveBeforeCashComparison),
    },
    summary: c.reserve?.status === "setup_incomplete" ? "Reserve target is available, but current reserve balance is unknown until a reserve account is designated." : "Recommended tax reserve after configured buffer.",
    warnings: c.reserve?.warnings || [],
    sort: nextSort(),
  }));

  add(component({
    key: "deadlines:count",
    type: "tax_deadlines",
    group: GROUPS.DEADLINES,
    name: "Tax deadlines",
    amount: c.deadlines?.length || 0,
    direction: DIRECTIONS.INFORMATIONAL,
    formula: { expression: "count(configured_tax_deadlines)", variables: { deadline_count: c.deadlines?.length || 0 }, result: c.deadlines?.length || 0 },
    summary: c.deadlines?.length ? "Configured tax deadlines are available for this calculation." : "No verified deadline schedule is available.",
    refs: (c.deadlines || []).slice(0, 10).map((deadline) => ({ type: "tax_deadline", id: deadline.id || null, label: deadline.name, date: deadline.dueDate || deadline.due_date })),
    sort: nextSort(),
  }));

  add(component({
    key: "confidence:overall",
    type: "calculation_confidence",
    group: GROUPS.CONFIDENCE,
    name: "Calculation confidence",
    amount: money(c.confidence?.score),
    direction: DIRECTIONS.INFORMATIONAL,
    formula: { expression: "aggregate_engine_confidence_score", variables: { level: c.confidence?.level, blockers: c.confidence?.blockers?.length || 0 }, result: money(c.confidence?.score) },
    summary: `Overall confidence is ${c.confidence?.level || "unavailable"}.`,
    warnings: c.confidence?.penalties || [],
    sort: nextSort(),
  }));

  const normalizedWarnings = normalizeExplanationWarnings(c.warnings || []);
  for (const warning of normalizedWarnings) {
    add(component({
      key: `warning:${warning.code}`,
      type: "calculation_warning",
      group: GROUPS.WARNING,
      name: warning.title,
      amount: 0,
      direction: DIRECTIONS.INFORMATIONAL,
      formula: { expression: "warning_disclosure", variables: { severity: warning.severity, code: warning.code }, result: 0 },
      summary: warning.message,
      warnings: [warning],
      sort: nextSort(),
    }));
  }

  const normalizedAssumptions = normalizeExplanationAssumptions(c.assumptions || []);
  for (const assumption of normalizedAssumptions) {
    add(component({
      key: `assumption:${assumption.code}`,
      type: "calculation_assumption",
      group: GROUPS.ASSUMPTION,
      name: assumption.label,
      amount: 0,
      direction: DIRECTIONS.INFORMATIONAL,
      formula: { expression: "assumption_disclosure", variables: { value: assumption.value, source: assumption.source }, result: 0 },
      summary: assumption.label,
      assumptions: [assumption],
      sort: nextSort(),
    }));
  }

  for (const item of c.unsupportedItems || []) {
    add(component({
      key: `unsupported:${String(item).replace(/[^a-zA-Z0-9_:-]+/g, "_")}`,
      type: "unsupported_item",
      group: GROUPS.UNSUPPORTED_ITEM,
      name: `Unsupported item: ${item}`,
      amount: 0,
      direction: DIRECTIONS.INFORMATIONAL,
      formula: { expression: "unsupported_item_disclosure", variables: { item }, result: 0 },
      summary: `${item} is not included in this calculation.`,
      sort: nextSort(),
    }));
  }

  if (previousRun?.id) {
    add(component({
      key: "prior_run:comparison_source",
      type: "prior_calculation_run",
      group: GROUPS.SOURCE_DATA,
      name: "Prior run comparison source",
      amount: money(previousRun.estimated_total_tax),
      direction: DIRECTIONS.INFORMATIONAL,
      formula: { expression: "prior_run_estimated_total_tax", variables: { run_id: previousRun.id }, result: money(previousRun.estimated_total_tax) },
      summary: "Prior run used for change comparison.",
      sort: nextSort(),
    }));
  }

  return dedupeAndSort(components);
}

function component({ key, type, group, name, amount, direction, formula, summary, refs = [], ruleRefs = [], warnings = [], assumptions = [], sort, taxableBase = null, rate = null }) {
  return createTaxExplanationComponent({
    componentKey: key,
    componentType: type,
    componentGroup: group,
    componentName: name,
    amount: money(amount),
    taxableBase,
    rate,
    direction,
    formula,
    summary,
    explanation: summary,
    detailedExplanation: summary,
    sourceRefs: refs,
    ruleRefs,
    warnings: normalizeExplanationWarnings(warnings, [key]),
    assumptions: normalizeExplanationAssumptions(assumptions, [key]),
    display: { section: group, sortOrder: sort, severity: warnings?.[0]?.severity || "info", expandable: true },
    metadata: { generatedBy: "taxExplanationBuilder" },
  });
}

function ruleRefsFromVersions(ruleVersions = {}, ruleType = "tax_rule") {
  return Object.entries(ruleVersions || {}).map(([name, version]) => ({
    id: null,
    ruleType: name || ruleType,
    version,
    sourceName: null,
    verifiedAt: null,
    supportLevel: null,
  }));
}

function dedupeAndSort(components) {
  const seen = new Set();
  const out = [];
  for (const component of components) {
    if (seen.has(component.componentKey)) continue;
    seen.add(component.componentKey);
    out.push(component);
  }
  return out.sort((a, b) => (a.display?.sortOrder || 0) - (b.display?.sortOrder || 0) || a.componentKey.localeCompare(b.componentKey));
}

function money(value) {
  if (value == null || value === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : 0;
}

function nullableMoney(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : null;
}
