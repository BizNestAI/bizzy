# Tax Rule Certification 2026 NC

Environment: staging
Overall status: **FAIL**

## Requested Scope

- Tax year: 2026
- States: NC
- Entities: sole_proprietor, single_member_llc_disregarded, single_member_llc_s_corp, s_corporation
- Filing statuses: single, married_filing_jointly, married_filing_separately, head_of_household, qualifying_surviving_spouse

## Certification Matrix

| State | Entity | Filing status | Status | Blockers |
| --- | --- | --- | --- | --- |
| NC | sole_proprietor | single | fail | federal_rules_failed, state_rules_failed, deduction_rules_failed |
| NC | sole_proprietor | married_filing_jointly | fail | federal_rules_failed, state_rules_failed, deduction_rules_failed |
| NC | sole_proprietor | married_filing_separately | fail | federal_rules_failed, state_rules_failed, deduction_rules_failed |
| NC | sole_proprietor | head_of_household | fail | federal_rules_failed, state_rules_failed, deduction_rules_failed |
| NC | sole_proprietor | qualifying_surviving_spouse | fail | federal_rules_failed, state_rules_failed, deduction_rules_failed |
| NC | single_member_llc_disregarded | single | fail | federal_rules_failed, state_rules_failed, deduction_rules_failed |
| NC | single_member_llc_disregarded | married_filing_jointly | fail | federal_rules_failed, state_rules_failed, deduction_rules_failed |
| NC | single_member_llc_disregarded | married_filing_separately | fail | federal_rules_failed, state_rules_failed, deduction_rules_failed |
| NC | single_member_llc_disregarded | head_of_household | fail | federal_rules_failed, state_rules_failed, deduction_rules_failed |
| NC | single_member_llc_disregarded | qualifying_surviving_spouse | fail | federal_rules_failed, state_rules_failed, deduction_rules_failed |
| NC | single_member_llc_s_corp | single | fail | federal_rules_failed, state_rules_failed, deduction_rules_failed, s_corp_state_component_unavailable |
| NC | single_member_llc_s_corp | married_filing_jointly | fail | federal_rules_failed, state_rules_failed, deduction_rules_failed, s_corp_state_component_unavailable |
| NC | single_member_llc_s_corp | married_filing_separately | fail | federal_rules_failed, state_rules_failed, deduction_rules_failed, s_corp_state_component_unavailable |
| NC | single_member_llc_s_corp | head_of_household | fail | federal_rules_failed, state_rules_failed, deduction_rules_failed, s_corp_state_component_unavailable |
| NC | single_member_llc_s_corp | qualifying_surviving_spouse | fail | federal_rules_failed, state_rules_failed, deduction_rules_failed, s_corp_state_component_unavailable |
| NC | s_corporation | single | fail | federal_rules_failed, state_rules_failed, deduction_rules_failed, s_corp_state_component_unavailable |
| NC | s_corporation | married_filing_jointly | fail | federal_rules_failed, state_rules_failed, deduction_rules_failed, s_corp_state_component_unavailable |
| NC | s_corporation | married_filing_separately | fail | federal_rules_failed, state_rules_failed, deduction_rules_failed, s_corp_state_component_unavailable |
| NC | s_corporation | head_of_household | fail | federal_rules_failed, state_rules_failed, deduction_rules_failed, s_corp_state_component_unavailable |
| NC | s_corporation | qualifying_surviving_spouse | fail | federal_rules_failed, state_rules_failed, deduction_rules_failed, s_corp_state_component_unavailable |

## Blockers

- missing_federal_filing_status_rule:  single federal_income_tax_brackets
- missing_federal_filing_status_rule:  single standard_deduction
- missing_federal_filing_status_rule:  single self_employment_tax
- missing_federal_filing_status_rule:  single self_employment_tax
- missing_federal_filing_status_rule:  single self_employment_tax
- missing_federal_filing_status_rule:  single additional_medicare_tax
- missing_federal_filing_status_rule:  single estimated_tax_safe_harbor
- missing_federal_filing_status_rule:  single estimated_tax_due_dates
- missing_federal_filing_status_rule:  married_filing_jointly federal_income_tax_brackets
- missing_federal_filing_status_rule:  married_filing_jointly standard_deduction
- missing_federal_filing_status_rule:  married_filing_jointly self_employment_tax
- missing_federal_filing_status_rule:  married_filing_jointly self_employment_tax
- missing_federal_filing_status_rule:  married_filing_jointly self_employment_tax
- missing_federal_filing_status_rule:  married_filing_jointly additional_medicare_tax
- missing_federal_filing_status_rule:  married_filing_jointly estimated_tax_safe_harbor
- missing_federal_filing_status_rule:  married_filing_jointly estimated_tax_due_dates
- missing_federal_filing_status_rule:  married_filing_separately federal_income_tax_brackets
- missing_federal_filing_status_rule:  married_filing_separately standard_deduction
- missing_federal_filing_status_rule:  married_filing_separately self_employment_tax
- missing_federal_filing_status_rule:  married_filing_separately self_employment_tax
- missing_federal_filing_status_rule:  married_filing_separately self_employment_tax
- missing_federal_filing_status_rule:  married_filing_separately additional_medicare_tax
- missing_federal_filing_status_rule:  married_filing_separately estimated_tax_safe_harbor
- missing_federal_filing_status_rule:  married_filing_separately estimated_tax_due_dates
- missing_federal_filing_status_rule:  head_of_household federal_income_tax_brackets
- missing_federal_filing_status_rule:  head_of_household standard_deduction
- missing_federal_filing_status_rule:  head_of_household self_employment_tax
- missing_federal_filing_status_rule:  head_of_household self_employment_tax
- missing_federal_filing_status_rule:  head_of_household self_employment_tax
- missing_federal_filing_status_rule:  head_of_household additional_medicare_tax
- missing_federal_filing_status_rule:  head_of_household estimated_tax_safe_harbor
- missing_federal_filing_status_rule:  head_of_household estimated_tax_due_dates
- missing_federal_filing_status_rule:  qualifying_surviving_spouse federal_income_tax_brackets
- missing_federal_filing_status_rule:  qualifying_surviving_spouse standard_deduction
- missing_federal_filing_status_rule:  qualifying_surviving_spouse self_employment_tax
- missing_federal_filing_status_rule:  qualifying_surviving_spouse self_employment_tax
- missing_federal_filing_status_rule:  qualifying_surviving_spouse self_employment_tax
- missing_federal_filing_status_rule:  qualifying_surviving_spouse additional_medicare_tax
- missing_federal_filing_status_rule:  qualifying_surviving_spouse estimated_tax_safe_harbor
- missing_federal_filing_status_rule:  qualifying_surviving_spouse estimated_tax_due_dates
- missing_or_unready_state_rule: NC  individual_income_tax
- missing_or_unready_state_rule: NC  standard_deduction
- missing_or_unready_state_rule: NC  estimated_tax_due_dates
- missing_or_unready_state_rule: NC  estimated_tax_safe_harbor
- missing_or_unready_state_rule: NC  s_corp_minimum_tax
- missing_certification_deduction_rule:   materials_and_supplies
- missing_certification_deduction_rule:   subcontractors_contract_labor
- missing_certification_deduction_rule:   meals
- missing_certification_deduction_rule:   vehicle_fuel
- missing_certification_deduction_rule:   insurance
- missing_certification_deduction_rule:   office_expense
- missing_certification_deduction_rule:   tools_small_equipment
- missing_certification_deduction_rule:   capitalizable_equipment
- missing_certification_deduction_rule:   loan_principal
- missing_certification_deduction_rule:   loan_interest
- missing_certification_deduction_rule:   owner_draws_contributions
- missing_certification_deduction_rule:   transfers
- missing_certification_deduction_rule:   credit_card_payments
- missing_certification_deduction_rule:   refunds_reversals
- missing_certification_deduction_rule:   payroll_payroll_taxes
- missing_certification_deduction_rule:   personal_nondeductible
- unsupported_tax_scope_combination: NC single 
- unsupported_tax_scope_combination: NC married_filing_jointly 
- unsupported_tax_scope_combination: NC married_filing_separately 
- unsupported_tax_scope_combination: NC head_of_household 
- unsupported_tax_scope_combination: NC qualifying_surviving_spouse 
- unsupported_tax_scope_combination: NC single 
- unsupported_tax_scope_combination: NC married_filing_jointly 
- unsupported_tax_scope_combination: NC married_filing_separately 
- unsupported_tax_scope_combination: NC head_of_household 
- unsupported_tax_scope_combination: NC qualifying_surviving_spouse 
- unsupported_tax_scope_combination: NC single 
- unsupported_tax_scope_combination: NC married_filing_jointly 
- unsupported_tax_scope_combination: NC married_filing_separately 
- unsupported_tax_scope_combination: NC head_of_household 
- unsupported_tax_scope_combination: NC qualifying_surviving_spouse 
- unsupported_tax_scope_combination: NC single 
- unsupported_tax_scope_combination: NC married_filing_jointly 
- unsupported_tax_scope_combination: NC married_filing_separately 
- unsupported_tax_scope_combination: NC head_of_household 
- unsupported_tax_scope_combination: NC qualifying_surviving_spouse 

## Deferred / Unsupported

- qbi_calculation
- complex_credits
- multi_state_allocation
- local_taxes_where_unverified
- capital_gains
- partnership_income
- spouse_income_integration
- advanced_depreciation_unless_configured
