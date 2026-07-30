begin;

alter table public.tax_deduction_rules
  add column if not exists business_id uuid null;

alter table public.transaction_tax_classifications
  add column if not exists confidence_level text null,
  add column if not exists rule_code text null,
  add column if not exists rule_version text null,
  add column if not exists rule_priority integer null;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'tax_deduction_rules'
      and column_name = 'treatment'
      and data_type <> 'jsonb'
  ) then
    execute $sql$
      alter table public.tax_deduction_rules
        alter column treatment type jsonb
        using case
          when treatment is null then '{}'::jsonb
          when btrim(treatment) = '' then '{}'::jsonb
          when left(btrim(treatment), 1) in ('{', '[') then treatment::jsonb
          else jsonb_build_object('type', treatment)
        end
    $sql$;
  end if;
end $$;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'transaction_tax_classifications'
      and column_name = 'tax_treatment'
      and data_type <> 'jsonb'
  ) then
    execute $sql$
      alter table public.transaction_tax_classifications
        alter column tax_treatment type jsonb
        using case
          when tax_treatment is null then null
          when btrim(tax_treatment) = '' then null
          when left(btrim(tax_treatment), 1) in ('{', '[') then tax_treatment::jsonb
          else jsonb_build_object('type', tax_treatment)
        end
    $sql$;
  end if;
end $$;

create index if not exists tax_deduction_rules_engine_idx
  on public.tax_deduction_rules (tax_year, jurisdiction, scope, business_id, is_active, priority, rule_code);

create index if not exists transaction_tax_classifications_rule_idx
  on public.transaction_tax_classifications (business_id, tax_year, rule_code, rule_version);

with seed (
  scope, business_id, rule_code, tax_year, jurisdiction, entity_type,
  bookkeeping_category, qbo_account_type, qbo_account_subtype, match_conditions,
  tax_category, deductibility_status, default_deductible_percent, treatment,
  requires_review, priority, explanation, source_reference, source_url,
  verified_at, effective_from, effective_to, is_active, version
) as (
  values
  ('global', null::uuid, 'materials_and_supplies', 2026, 'federal', null, 'materials_and_supplies', 'Expense', null,
    '{"vendor_names":["Home Depot","Lowe''s","ABC Supply","Roofing Supply","Sherwin-Williams"],"state_adjustment_hook":"materials","high_confidence":{"requires":["vendor_material_supplier","job_materials_gl","assigned_job"]},"medium_confidence":{"requires":["bookkeeping_category_or_qbo_expense"]},"needs_review":{"when":["personal_use_possible","inventory_resale_possible"]}}'::jsonb,
    'supplies', 'fully_deductible', 100.0, '{"type":"ordinary_expense","irs_category":"supplies"}'::jsonb, false, 40,
    'Materials and supplies used in the business are generally deductible when consumed or used.',
    'IRS Publication 334 (2025), Tax Guide for Small Business: Business expenses and supplies',
    'https://www.irs.gov/publications/p334', now(), date '2026-01-01', date '2026-12-31', true, 'irs-2026'),

  ('global', null::uuid, 'subcontractors_contract_labor', 2026, 'federal', null, 'subcontractors_contract_labor', 'Expense', null,
    '{"vendor_names":["Subcontractor","Contract Labor"],"requires_employee":false,"state_adjustment_hook":"contract_labor","high_confidence":{"requires":["contract_labor_gl","vendor_is_1099_contractor","assigned_job"]},"medium_confidence":{"requires":["contractor_vendor_or_job_cost_tag"]},"needs_review":{"when":["employee_payroll_possible","missing_w9_or_1099_context"]}}'::jsonb,
    'contract_labor', 'fully_deductible', 100.0, '{"type":"ordinary_expense","irs_category":"contract_labor"}'::jsonb, false, 35,
    'Payments to independent contractors for business services are generally deductible business expenses.',
    'IRS Publication 334 (2025), Tax Guide for Small Business: Business expenses and contract labor',
    'https://www.irs.gov/publications/p334', now(), date '2026-01-01', date '2026-12-31', true, 'irs-2026'),

  ('global', null::uuid, 'meals', 2026, 'federal', null, 'meals', 'Expense', 'Meals',
    '{"merchant_regex":"restaurant|cafe|grill|pizza|diner|coffee|doordash|ubereats","state_adjustment_hook":"meals","high_confidence":{"requires":["restaurant_merchant","business_purpose","non_lavish"]},"medium_confidence":{"requires":["meals_gl","merchant_food_service"]},"needs_review":{"when":["missing_business_purpose","travel_or_entertainment_ambiguity"]}}'::jsonb,
    'meals', 'partially_deductible', 50.0, '{"type":"ordinary_expense","limitation":"50_percent_meals"}'::jsonb, true, 45,
    'Most business meals are limited to 50% deductibility and need business-purpose support.',
    'IRS Publication 463 (2025), Travel, Gift, and Car Expenses: 50% limit on meals',
    'https://www.irs.gov/publications/p463', now(), date '2026-01-01', date '2026-12-31', true, 'irs-2026'),

  ('global', null::uuid, 'vehicle_fuel', 2026, 'federal', null, 'vehicle_fuel', 'Expense', 'Auto',
    '{"vendor_names":["Shell","Exxon","Chevron","BP","Marathon","Sunoco"],"merchant_regex":"fuel|gas|shell|exxon|chevron|bp|marathon|sunoco","state_adjustment_hook":"vehicle","high_confidence":{"requires":["vehicle_expense_gl","business_vehicle_memory","mileage_or_business_use_percent"]},"medium_confidence":{"requires":["fuel_merchant","auto_gl"]},"needs_review":{"when":["commuting_possible","personal_vehicle_allocation_missing"]}}'::jsonb,
    'auto', 'needs_review', 0.0, '{"type":"allocation_required","allocation":"business_use_percent"}'::jsonb, true, 45,
    'Vehicle costs require business-use allocation; commuting and personal use are not deductible.',
    'IRS Publication 463 (2025), Car Expenses',
    'https://www.irs.gov/publications/p463', now(), date '2026-01-01', date '2026-12-31', true, 'irs-2026'),

  ('global', null::uuid, 'insurance', 2026, 'federal', null, 'insurance', 'Expense', 'Insurance',
    '{"state_adjustment_hook":"insurance","high_confidence":{"requires":["business_policy_vendor","insurance_gl"]},"medium_confidence":{"requires":["insurance_gl"]},"needs_review":{"when":["personal_policy_possible","owner_health_insurance_possible"]}}'::jsonb,
    'insurance', 'fully_deductible', 100.0, '{"type":"ordinary_expense","irs_category":"insurance"}'::jsonb, false, 40,
    'Ordinary and necessary business insurance premiums are generally deductible.',
    'IRS Publication 334 (2025), Tax Guide for Small Business: Insurance',
    'https://www.irs.gov/publications/p334', now(), date '2026-01-01', date '2026-12-31', true, 'irs-2026'),

  ('global', null::uuid, 'office_expense', 2026, 'federal', null, 'office_expense', 'Expense', 'Office/General Administrative Expenses',
    '{"vendor_names":["Staples","Office Depot","Amazon"],"state_adjustment_hook":"office","high_confidence":{"requires":["office_vendor","office_expense_gl"]},"medium_confidence":{"requires":["office_expense_gl"]},"needs_review":{"when":["mixed_personal_items","capital_asset_possible"]}}'::jsonb,
    'office', 'fully_deductible', 100.0, '{"type":"ordinary_expense","irs_category":"office_expense"}'::jsonb, false, 40,
    'Ordinary office expenses used in the business are generally deductible.',
    'IRS Publication 334 (2025), Tax Guide for Small Business: Business expenses',
    'https://www.irs.gov/publications/p334', now(), date '2026-01-01', date '2026-12-31', true, 'irs-2026'),

  ('global', null::uuid, 'tools_small_equipment', 2026, 'federal', null, 'tools_small_equipment', 'Expense', 'Tools',
    '{"maximum_amount":2500,"state_adjustment_hook":"de_minimis_depreciation","high_confidence":{"requires":["business_tax_memory_confirms_qualifying_book_expense_policy","annual_de_minimis_election_intended_or_supported","invoice_or_item_threshold_applies","business_use","not_inventory","not_part_of_larger_improvement","no_capitalization_blocker"]},"medium_confidence":{"requires":["tools_gl","small_amount","business_use_indicated"]},"needs_review":{"when":["book_expense_policy_unknown","annual_election_unknown","inventory_possible","larger_improvement_possible","personal_use_possible","capitalization_blocker_possible","asset_useful_life_over_one_year","amount_over_threshold"]}}'::jsonb,
    'equipment', 'needs_review', 0.0, '{"type":"de_minimis_safe_harbor_possible","safe_harbor":"de_minimis","depreciation_review_required":true}'::jsonb, true, 35,
    'Small tools and equipment require review unless the de minimis safe-harbor policy, election, threshold, business-use, non-inventory, and non-improvement facts are established.',
    'IRS Tangible Property Regulations FAQs and Treas. Reg. 1.263(a)-1(f), De minimis safe harbor',
    'https://www.irs.gov/businesses/small-businesses-self-employed/tangible-property-final-regulations', now(), date '2026-01-01', date '2026-12-31', true, 'irs-2026'),

  ('global', null::uuid, 'capitalizable_equipment', 2026, 'federal', null, 'capitalizable_equipment', 'Fixed Asset', 'Equipment',
    '{"minimum_amount":2500.01,"state_adjustment_hook":"depreciation","high_confidence":{"requires":["fixed_asset_gl","amount_over_de_minimis_threshold"]},"medium_confidence":{"requires":["equipment_vendor","large_amount"]},"needs_review":{"when":["repair_vs_improvement_unclear","section_179_or_bonus_depreciation_election_needed"]}}'::jsonb,
    'capitalizable_equipment', 'capitalizable', 0.0, '{"type":"capitalizable","depreciation_required":true}'::jsonb, true, 30,
    'Equipment with a useful life beyond one year is generally capitalized unless a valid expensing election applies.',
    'IRS Publication 946 (2025), How To Depreciate Property',
    'https://www.irs.gov/publications/p946', now(), date '2026-01-01', date '2026-12-31', true, 'irs-2026'),

  ('global', null::uuid, 'loan_principal', 2026, 'federal', null, 'loan_principal', 'Liability', 'Loan Payable',
    '{"taxonomy_types":["loan_principal"],"description_regex":"principal|loan payment","state_adjustment_hook":"debt","high_confidence":{"requires":["loan_liability_account","principal_label"]},"medium_confidence":{"requires":["liability_account"]},"needs_review":{"when":["principal_interest_split_missing"]}}'::jsonb,
    'loan_principal', 'balance_sheet', 0.0, '{"type":"balance_sheet","component":"principal"}'::jsonb, false, 10,
    'Loan principal repayments are balance-sheet payments and are not deductible business expenses.',
    'IRS Publication 334 (2025), Tax Guide for Small Business: Business expenses and interest',
    'https://www.irs.gov/publications/p334', now(), date '2026-01-01', date '2026-12-31', true, 'irs-2026'),

  ('global', null::uuid, 'loan_interest', 2026, 'federal', null, 'loan_interest', 'Expense', 'Interest Paid',
    '{"description_regex":"interest|finance charge","state_adjustment_hook":"interest","high_confidence":{"requires":["interest_expense_gl","loan_vendor"]},"medium_confidence":{"requires":["interest_label"]},"needs_review":{"when":["principal_interest_split_missing","personal_debt_possible"]}}'::jsonb,
    'loan_interest', 'fully_deductible', 100.0, '{"type":"ordinary_expense","irs_category":"interest"}'::jsonb, false, 25,
    'Business loan interest is generally deductible when the debt is for business purposes.',
    'IRS Publication 334 (2025), Tax Guide for Small Business: Interest',
    'https://www.irs.gov/publications/p334', now(), date '2026-01-01', date '2026-12-31', true, 'irs-2026'),

  ('global', null::uuid, 'owner_draws_contributions', 2026, 'federal', null, 'owner_draws_contributions', 'Equity', null,
    '{"taxonomy_types":["owner_draw","owner_contribution"],"description_regex":"owner draw|owner contribution|distribution|capital contribution","state_adjustment_hook":"equity","high_confidence":{"requires":["equity_account","owner_transfer_label"]},"medium_confidence":{"requires":["equity_account"]},"needs_review":{"when":["payroll_or_reimbursement_possible"]}}'::jsonb,
    'owner_draw', 'balance_sheet', 0.0, '{"type":"balance_sheet","component":"equity"}'::jsonb, false, 5,
    'Owner draws and capital contributions are equity transactions, not deductible expenses.',
    'IRS Publication 334, Tax Guide for Small Business: business expenses and owner transactions',
    'https://www.irs.gov/publications/p334', now(), date '2026-01-01', date '2026-12-31', true, 'irs-2026'),

  ('global', null::uuid, 'transfers', 2026, 'federal', null, 'transfers', 'Bank', null,
    '{"taxonomy_types":["transfer_internal"],"description_regex":"transfer|xfer","state_adjustment_hook":"transfer","high_confidence":{"requires":["bank_or_credit_card_account","internal_transfer_match"]},"medium_confidence":{"requires":["transfer_label"]},"needs_review":{"when":["external_payee_unclear"]}}'::jsonb,
    'transfer', 'balance_sheet', 0.0, '{"type":"balance_sheet","component":"internal_transfer"}'::jsonb, false, 5,
    'Transfers between business accounts do not create deductible expenses.',
    'IRS Publication 334 (2025), Tax Guide for Small Business: Business expenses must be ordinary and necessary',
    'https://www.irs.gov/publications/p334', now(), date '2026-01-01', date '2026-12-31', true, 'irs-2026'),

  ('global', null::uuid, 'credit_card_payments', 2026, 'federal', null, 'credit_card_payments', 'Credit Card', null,
    '{"taxonomy_types":["cc_payment"],"description_regex":"credit card payment|cc payment|payment thank you","state_adjustment_hook":"credit_card_payment","high_confidence":{"requires":["credit_card_liability_account","payment_label"]},"medium_confidence":{"requires":["credit_card_account_type"]},"needs_review":{"when":["merchant_purchase_possible"]}}'::jsonb,
    'credit_card_payment', 'balance_sheet', 0.0, '{"type":"balance_sheet","component":"credit_card_payment"}'::jsonb, false, 5,
    'Credit card payments pay a liability; the underlying card charges determine deductibility.',
    'IRS Publication 334 (2025), Tax Guide for Small Business: Business expenses and recordkeeping',
    'https://www.irs.gov/publications/p334', now(), date '2026-01-01', date '2026-12-31', true, 'irs-2026'),

  ('global', null::uuid, 'refunds_reversals', 2026, 'federal', null, 'refunds_reversals', 'Income', null,
    '{"taxonomy_types":["refund"],"description_regex":"refund|reversal|return|credit memo","state_adjustment_hook":"refund","high_confidence":{"requires":["refund_label","linked_original_expense"]},"medium_confidence":{"requires":["refund_label"]},"needs_review":{"when":["original_expense_unknown","customer_refund_or_revenue_reversal_possible"]}}'::jsonb,
    'refund', 'needs_review', 0.0, '{"type":"reversal","inherits_original_treatment":true}'::jsonb, true, 20,
    'Refunds and reversals should inherit or offset the original transaction treatment when identifiable.',
    'IRS Publication 334 (2025), Tax Guide for Small Business: Business expenses and records',
    'https://www.irs.gov/publications/p334', now(), date '2026-01-01', date '2026-12-31', true, 'irs-2026'),

  ('global', null::uuid, 'payroll_payroll_taxes', 2026, 'federal', null, 'payroll_payroll_taxes', 'Expense', 'Payroll Expenses',
    '{"requires_employee":true,"state_adjustment_hook":"payroll","high_confidence":{"requires":["payroll_provider","employee_wages_or_employer_taxes"]},"medium_confidence":{"requires":["payroll_gl"]},"needs_review":{"when":["owner_draw_misclassified_as_payroll","employee_vs_contractor_unclear"]}}'::jsonb,
    'payroll', 'fully_deductible', 100.0, '{"type":"ordinary_expense","irs_category":"wages_and_payroll_taxes"}'::jsonb, false, 35,
    'Employee wages and employer payroll taxes are generally deductible business expenses.',
    'IRS Publication 15 (2026), Employer''s Tax Guide: Wages and employer payroll taxes',
    'https://www.irs.gov/publications/p15', now(), date '2026-01-01', date '2026-12-31', true, 'irs-2026'),

  ('global', null::uuid, 'personal_nondeductible', 2026, 'federal', null, 'personal_nondeductible', 'Expense', null,
    '{"description_regex":"personal|groceries|school|family|clothing","state_adjustment_hook":"personal","high_confidence":{"requires":["explicit_personal_category"]},"medium_confidence":{"requires":["personal_keyword"]},"needs_review":{"when":["mixed_business_personal_possible"]}}'::jsonb,
    'personal', 'nondeductible', 0.0, '{"type":"nondeductible","reason":"personal_expense"}'::jsonb, true, 15,
    'Personal, living, or family expenses are not deductible as business expenses.',
    'IRS Publication 334 (2025), Tax Guide for Small Business: Personal versus business expenses',
    'https://www.irs.gov/publications/p334', now(), date '2026-01-01', date '2026-12-31', true, 'irs-2026')
),
deactivated_conflicts as (
  update public.tax_deduction_rules existing
  set is_active = false,
      updated_at = now()
  from seed
  where existing.scope = seed.scope
    and existing.tax_year = seed.tax_year
    and existing.jurisdiction = seed.jurisdiction
    and existing.rule_code = seed.rule_code
    and existing.business_id is not distinct from seed.business_id
    and existing.version <> seed.version
    and existing.is_active = true
  returning 1
),
updated as (
  update public.tax_deduction_rules existing
  set
    entity_type = seed.entity_type,
    bookkeeping_category = seed.bookkeeping_category,
    qbo_account_type = seed.qbo_account_type,
    qbo_account_subtype = seed.qbo_account_subtype,
    match_conditions = seed.match_conditions,
    tax_category = seed.tax_category,
    deductibility_status = seed.deductibility_status,
    default_deductible_percent = seed.default_deductible_percent,
    treatment = seed.treatment,
    requires_review = seed.requires_review,
    priority = seed.priority,
    explanation = seed.explanation,
    source_reference = seed.source_reference,
    source_url = seed.source_url,
    verified_at = seed.verified_at,
    effective_from = seed.effective_from,
    effective_to = seed.effective_to,
    is_active = seed.is_active,
    updated_at = now()
  from seed
  where existing.scope = seed.scope
    and existing.tax_year = seed.tax_year
    and existing.jurisdiction = seed.jurisdiction
    and existing.rule_code = seed.rule_code
    and existing.business_id is not distinct from seed.business_id
    and existing.version = seed.version
  returning 1
),
inserted as (
  insert into public.tax_deduction_rules (
    scope, business_id, rule_code, tax_year, jurisdiction, entity_type,
    bookkeeping_category, qbo_account_type, qbo_account_subtype, match_conditions,
    tax_category, deductibility_status, default_deductible_percent, treatment,
    requires_review, priority, explanation, source_reference, source_url,
    verified_at, effective_from, effective_to, is_active, version
  )
  select
    seed.scope, seed.business_id, seed.rule_code, seed.tax_year, seed.jurisdiction, seed.entity_type,
    seed.bookkeeping_category, seed.qbo_account_type, seed.qbo_account_subtype, seed.match_conditions,
    seed.tax_category, seed.deductibility_status, seed.default_deductible_percent, seed.treatment,
    seed.requires_review, seed.priority, seed.explanation, seed.source_reference, seed.source_url,
    seed.verified_at, seed.effective_from, seed.effective_to, seed.is_active, seed.version
  from seed
  where not exists (
    select 1
    from public.tax_deduction_rules existing
    where existing.scope = seed.scope
      and existing.tax_year = seed.tax_year
      and existing.jurisdiction = seed.jurisdiction
      and existing.rule_code = seed.rule_code
      and existing.business_id is not distinct from seed.business_id
      and existing.version = seed.version
  )
  returning 1
)
select
  (select count(*) from deactivated_conflicts) as deactivated_conflicts_count,
  (select count(*) from updated) as updated_count,
  (select count(*) from inserted) as inserted_count;

do $$
declare
  bad_count integer;
begin
  select count(*)
  into bad_count
  from public.tax_deduction_rules
  where tax_year = 2026
    and jurisdiction = 'federal'
    and scope = 'global'
    and business_id is null
    and version = 'irs-2026'
    and is_active = true
    and (
      (deductibility_status = 'fully_deductible' and default_deductible_percent <> 100)
      or (rule_code = 'meals' and default_deductible_percent <> 50)
      or (deductibility_status in ('nondeductible', 'capitalizable', 'balance_sheet', 'needs_review') and default_deductible_percent <> 0)
      or (rule_code = 'tools_small_equipment' and (
        deductibility_status <> 'needs_review'
        or default_deductible_percent <> 0
        or requires_review is not true
        or treatment->>'type' <> 'de_minimis_safe_harbor_possible'
      ))
    );

  if bad_count <> 0 then
    raise exception 'Pack 2 deduction rule percent/treatment assertion failed for % row(s)', bad_count;
  end if;
end $$;

commit;
