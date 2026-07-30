export const CONTRACTOR_TAX_QA_FIXTURES = Object.freeze([
  fixture("sole_proprietor_cash_basis", "Sole proprietor, cash basis", { entityPath: "sole_proprietor", state: "NC" }),
  fixture("single_member_llc_disregarded", "Single-member LLC disregarded entity", { entityPath: "single_member_llc_disregarded", state: "SC" }),
  fixture("single_member_llc_s_corp", "Single-member LLC with S-Corp election", { entityPath: "single_member_llc_s_corp", state: "NC" }),
  fixture("s_corp_owner_wages_distributions", "S-Corp owner wages and distributions", { entityPath: "s_corporation", includesOwnerWages: true }),
  fixture("no_income_tax_state", "No-income-tax state", { state: "FL", expectedStateRule: "no_individual_income_tax" }),
  fixture("progressive_tax_state", "Progressive-tax state", { state: "NC", expectedStateRule: "individual_income_tax" }),
  fixture("missing_state_support", "Missing state support", { state: "CA", expectUnsupported: true }),
  fixture("tax_loss_year", "Tax loss year", { expectedTaxableIncomeSign: "negative" }),
  fixture("current_partial_month_forecast", "Current partial month with forecast", { includesProjection: true }),
  fixture("high_equipment_capitalizable", "High equipment and capitalizable purchases", { materialCategory: "equipment" }),
  fixture("loan_principal_interest", "Loan principal and interest", { materialCategory: "loan" }),
  fixture("transfers_credit_card_payments", "Transfers and credit-card payments", { materialCategory: "balance_sheet" }),
  fixture("owner_draws_contributions", "Owner draws and contributions", { materialCategory: "owner_activity" }),
  fixture("refunds_reversals", "Refunds and reversals", { materialCategory: "refund" }),
  fixture("payroll_heavy_contractor", "Payroll-heavy contractor", { materialCategory: "payroll" }),
  fixture("meals_partially_deductible", "Meals partially deductible", { materialCategory: "meals", expectedDeductiblePercent: 0.5 }),
  fixture("vehicle_actual_expense_uncertainty", "Vehicle actual-expense uncertainty", { materialCategory: "vehicle", expectedStatus: "needs_review" }),
  fixture("large_needs_review_exposure", "Large needs-review exposure", { expectedIssue: "material_needs_review_exposure" }),
  fixture("missing_filing_status", "Missing filing status", { profileGap: "filing_status" }),
  fixture("missing_llc_election", "Missing LLC election", { profileGap: "tax_election" }),
  fixture("missing_safe_harbor_rule", "Missing safe-harbor rule", { expectedRuleGap: "estimated_tax_safe_harbor" }),
  fixture("missing_reserve_account", "Missing reserve account", { expectedReserveStatus: "setup_incomplete" }),
  fixture("payment_types_mixed", "Payment types mixed", { includesMixedPayments: true }),
  fixture("duplicate_payment_candidate", "Duplicate payment candidate", { expectedIssue: "duplicate_payment_candidate" }),
  fixture("stale_qbo_data", "Stale QBO data", { expectedFreshness: "stale" }),
]);

export function getContractorTaxQaFixtures() {
  return CONTRACTOR_TAX_QA_FIXTURES.map((item) => ({ ...item, tags: [...item.tags] }));
}

function fixture(id, name, expectations = {}) {
  return {
    id,
    name,
    tags: ["contractor", "tax_qa", expectations.entityPath || expectations.materialCategory || "coverage"],
    expectations,
  };
}
