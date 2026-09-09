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
| NC | sole_proprietor | single | fail | state_rules_failed, deduction_rules_failed |
| NC | sole_proprietor | married_filing_jointly | fail | state_rules_failed, deduction_rules_failed |
| NC | sole_proprietor | married_filing_separately | fail | state_rules_failed, deduction_rules_failed |
| NC | sole_proprietor | head_of_household | fail | state_rules_failed, deduction_rules_failed |
| NC | sole_proprietor | qualifying_surviving_spouse | fail | state_rules_failed, deduction_rules_failed |
| NC | single_member_llc_disregarded | single | fail | state_rules_failed, deduction_rules_failed |
| NC | single_member_llc_disregarded | married_filing_jointly | fail | state_rules_failed, deduction_rules_failed |
| NC | single_member_llc_disregarded | married_filing_separately | fail | state_rules_failed, deduction_rules_failed |
| NC | single_member_llc_disregarded | head_of_household | fail | state_rules_failed, deduction_rules_failed |
| NC | single_member_llc_disregarded | qualifying_surviving_spouse | fail | state_rules_failed, deduction_rules_failed |
| NC | single_member_llc_s_corp | single | fail | state_rules_failed, deduction_rules_failed, s_corp_state_component_unavailable |
| NC | single_member_llc_s_corp | married_filing_jointly | fail | state_rules_failed, deduction_rules_failed, s_corp_state_component_unavailable |
| NC | single_member_llc_s_corp | married_filing_separately | fail | state_rules_failed, deduction_rules_failed, s_corp_state_component_unavailable |
| NC | single_member_llc_s_corp | head_of_household | fail | state_rules_failed, deduction_rules_failed, s_corp_state_component_unavailable |
| NC | single_member_llc_s_corp | qualifying_surviving_spouse | fail | state_rules_failed, deduction_rules_failed, s_corp_state_component_unavailable |
| NC | s_corporation | single | fail | state_rules_failed, deduction_rules_failed, s_corp_state_component_unavailable |
| NC | s_corporation | married_filing_jointly | fail | state_rules_failed, deduction_rules_failed, s_corp_state_component_unavailable |
| NC | s_corporation | married_filing_separately | fail | state_rules_failed, deduction_rules_failed, s_corp_state_component_unavailable |
| NC | s_corporation | head_of_household | fail | state_rules_failed, deduction_rules_failed, s_corp_state_component_unavailable |
| NC | s_corporation | qualifying_surviving_spouse | fail | state_rules_failed, deduction_rules_failed, s_corp_state_component_unavailable |

## Blockers

- missing_or_unready_state_rule: NC  s_corp_minimum_tax
- conflicting_deduction_rule:   
- conflicting_deduction_rule:   
- conflicting_deduction_rule:   
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
