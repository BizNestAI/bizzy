begin;

-- Forward-only seed for Bizzi GL alias tax deduction rules v4.
-- This creates a new rule-library version, then retires v3 only after the
-- complete v4 inventory is present. It does not classify transactions, repair
-- history, enqueue jobs, calculate tax, or call any external provider.

do $$
declare
  v_active_v3_count integer;
begin
  select count(*)::integer
  into v_active_v3_count
  from public.tax_deduction_rules
  where scope = 'global'
    and business_id is null
    and tax_year = 2026
    and jurisdiction = 'federal'
    and version = 'bizzi-gl-2026-v3'
    and is_active = true
    and verified_at is not null;

  if v_active_v3_count <> 41 then
    raise exception 'tax_gl_alias_v4_requires_active_verified_v3_count_41: %', v_active_v3_count;
  end if;
end $$;

with seed_tax_gl_alias_v4_new_rules as (
  select *
  from (values
  ('cogs_parent_account_gl_v4', '{"qbo_account_name_keys":["cost of goods sold","costs of goods sold","cogs","cost of sales","costs of sales","direct costs","direct job costs","job costs","construction costs","project costs","service costs","cost of revenue"],"qbo_account_type_keys":["cost of goods sold"]}'::jsonb, 'cost_of_goods_sold', 'fully_deductible', 100::numeric, '{"type":"cogs_candidate","reporting_destination":"schedule_c_part_iii_or_form_1125_a_candidate","ordinaryExpense":false,"allowed_qbo_account_type_keys":["cost of goods sold"],"negative_aliases":["Gross Profit","Gross Margin","Cost Estimate","Cost Reimbursement","Reimbursed Costs","Customer Reimbursement","Cost Allocation","Other Income","Cost of Goods Sold Adjustment","Inventory Asset","Opening Inventory","Closing Inventory","Equipment Purchase","Fixed Assets","Loan Costs","Startup Costs"]}'::jsonb, false, 11, 'Costs posted to a verified QuickBooks cost-of-goods-sold account.'),
  ('inventory_purchases_review_gl_v4', '{"qbo_account_name_keys":["inventory purchases","purchases inventory","purchases for resale","merchandise purchases","materials inventory","job materials inventory","construction materials inventory","raw materials","raw materials purchases","parts inventory","parts purchases","stock purchases","resale inventory","inventory materials","inventory clearing"]}'::jsonb, 'inventory_purchases', 'needs_review', 0::numeric, '{"type":"inventory_cogs_review","reporting_destination":"inventory_or_cogs_destination_not_determined","allowed_qbo_account_type_keys":["cost of goods sold","other current asset","expense"],"review_question":"Were these materials used on completed jobs this year, or are they still held for future jobs?","negative_aliases":["Office Supplies","General Supplies","Safety Supplies","Small Tools","Fixed Assets","Equipment","Inventory Sale","Inventory Income","Customer Deposit","Owner Contribution","Inventory Loan","Inventory Reimbursement"]}'::jsonb, true, 17, 'Purchases that may need to remain in inventory until the related materials or goods are used or sold.'),
  ('inventory_variance_review_gl_v4', '{"qbo_account_name_keys":["inventory variance","purchase returns and allowances"]}'::jsonb, 'inventory_purchases', 'needs_review', 0::numeric, '{"type":"inventory_contra_or_variance_review","reporting_destination":"inventory_or_cogs_destination_not_determined","allowed_qbo_account_type_keys":["cost of goods sold","other current asset","expense"],"signed_contra_review_required":true}'::jsonb, true, 13, 'Inventory variances or purchase returns need review before tax treatment is confirmed.'),
  ('equipment_fuel_gl_v4', '{"qbo_account_name_keys":["equipment fuel","machinery fuel","jobsite fuel","job site fuel","generator fuel","diesel equipment","equipment diesel","off road fuel","fuel machinery","fuel equipment","heavy equipment fuel","small equipment fuel","landscaping equipment fuel","mower fuel","fuel and lubricants equipment","equipment gas and oil"]}'::jsonb, 'equipment_fuel', 'fully_deductible', 100::numeric, '{"type":"equipment_fuel","reporting_destination":"schedule_c_operating_or_direct_job_cost_candidate","allowed_qbo_account_type_keys":["expense","cost of goods sold"],"excludes_vehicle_method":true,"negative_aliases":["Gas","Gasoline","Fuel","Auto Fuel","Vehicle Fuel","Fleet Fuel","Car Fuel","Truck Fuel","Mileage","Fuel Reimbursement","Fuel Surcharge Income","Customer Fuel Reimbursement","Heating Fuel","Natural Gas Utility","Oil and Gas Revenue"]}'::jsonb, false, 19, 'Fuel for business equipment rather than a road vehicle.'),
  ('shipping_postage_operating_gl_v4', '{"qbo_account_name_keys":["shipping","shipping expense","shipping and delivery","delivery expense","delivery fees","courier expense","courier and delivery","postage","postage and delivery","postage and shipping","freight out","outbound freight"]}'::jsonb, 'shipping_freight_delivery', 'fully_deductible', 100::numeric, '{"type":"postage_operating","reporting_destination":"schedule_c_operating_expense_candidate","allowed_qbo_account_type_keys":["expense"],"negative_aliases":["Shipping Income","Delivery Income","Freight Income","Shipping Reimbursement","Customer Delivery Reimbursement","Freight Surcharge Income","Delivery Driver Wages","Vehicle Expense","Inventory Asset","Equipment Freight Income","Sales"]}'::jsonb, false, 21, 'Shipping and delivery costs. Inbound freight may need to be included with inventory or job costs.'),
  ('shipping_inbound_freight_review_gl_v4', '{"qbo_account_name_keys":["freight in","inbound freight","materials delivery","job materials delivery"]}'::jsonb, 'shipping_freight_delivery', 'needs_review', 0::numeric, '{"type":"inbound_freight_cogs","reporting_destination":"inventory_or_cogs_destination_not_determined","allowed_qbo_account_type_keys":["expense","cost of goods sold","other current asset"],"review_question":"Was this inbound freight tied to inventory, job materials, or ordinary delivery?"}'::jsonb, true, 18, 'Shipping and delivery costs. Inbound freight may need to be included with inventory or job costs.'),
  ('shipping_equipment_delivery_review_gl_v4', '{"qbo_account_name_keys":["equipment delivery"]}'::jsonb, 'shipping_freight_delivery', 'capitalizable', 0::numeric, '{"type":"equipment_delivery_capitalization_review","reporting_destination":"form_4562_candidate","allowed_qbo_account_type_keys":["expense","fixed asset"],"capitalization_review_required":true}'::jsonb, true, 13, 'Equipment delivery may need to be included in the cost of equipment placed in service.'),
  ('shipping_generic_freight_review_gl_v4', '{"qbo_account_name_keys":["freight","freight expense","trucking and freight"]}'::jsonb, 'shipping_freight_delivery', 'needs_review', 0::numeric, '{"type":"ambiguous_freight_review","reporting_destination":"not_yet_determined","allowed_qbo_account_type_keys":["expense","cost of goods sold"]}'::jsonb, true, 37, 'Shipping and delivery costs. Inbound freight may need to be included with inventory or job costs.'),
  ('other_business_taxes_review_gl_v4', '{"qbo_account_name_keys":["business taxes","state business taxes","local business taxes","franchise tax","franchise taxes","gross receipts tax","business property tax","personal property tax business","tangible personal property tax","excise tax expense","occupational tax","privilege tax","local business tax","county business tax","city business tax","use tax expense","non payroll taxes","other business taxes"]}'::jsonb, 'other_business_taxes', 'needs_review', 0::numeric, '{"type":"business_tax_review","reporting_destination":"entity_specific_destination_not_determined","allowed_qbo_account_type_keys":["expense"],"review_question":"What type of tax was this payment for?","negative_aliases":["Federal Income Tax","Personal Income Tax","Estimated Income Tax","State Income Tax Payment","Owner Tax Payment","Sales Tax Payable","Sales Tax Collected","Payroll Tax Payable","Employee Withholding","Federal Withholding","State Withholding","FICA Payable","Medicare Payable","FUTA Payable","SUTA Payable","Tax Refund","Tax Reimbursement","Tax Penalty","IRS Penalty","Late Filing Penalty","Interest and Penalties","Property Tax Escrow","Customer Sales Tax","Payroll Taxes","Licenses and Permits"]}'::jsonb, true, 29, 'Business tax payments that require the tax type to be identified before treatment is confirmed.'),
  ('commissions_referral_fees_gl_v4', '{"qbo_account_name_keys":["commissions","commission expense","sales commissions","sales commission expense","referral fees","referral fee expense","finders fees","finder fees","lead referral fees","broker commissions","agent commissions","sales agent fees","dealer commissions","subcontractor commissions","performance commissions","affiliate commissions","affiliate fees"]}'::jsonb, 'commissions_referral_fees', 'fully_deductible', 100::numeric, '{"type":"ordinary_expense","irs_category":"commissions_and_fees","allowed_qbo_account_type_keys":["expense"],"information_reporting_review_supported":true,"negative_aliases":["Commission Income","Sales Commission Income","Referral Income","Affiliate Income","Broker Income","Employee Commission Wages","Payroll","Bonuses","Merchant Fees","Bank Fees","Loan Origination Fees","Real Estate Purchase Commission","Asset Acquisition Commission","Customer Refund","Owner Draw","Fees"]}'::jsonb, false, 23, 'Business commissions or referral fees paid to generate work or sales.'),
  ('employee_benefits_gl_v4', '{"qbo_account_name_keys":["employee benefits","employee benefit programs","employee health insurance","group health insurance","employee medical insurance","employee dental insurance","employee vision insurance","group term life insurance","employee life insurance","employee disability insurance","employee assistance program","dependent care assistance","employee welfare benefits","employee wellness benefits","employer hsa contributions","employer benefit contributions","workers benefits"]}'::jsonb, 'employee_benefits', 'fully_deductible', 100::numeric, '{"type":"employee_benefits","reporting_destination":"entity_specific_employee_benefit_candidate","allowed_qbo_account_type_keys":["expense"],"owner_employee_distinction_required_when_ambiguous":true,"negative_aliases":["Owner Health Insurance","Shareholder Health Insurance","Partner Health Insurance","Self-Employed Health Insurance","Member Health Insurance","Owner Life Insurance","Key Person Life Insurance","Workers Compensation","Retirement Contributions","Pension Expense","Profit Sharing","Employee Loans","Employee Advances","Payroll Liabilities","Employee Withholding","Employee Reimbursement","Customer Benefits","Government Benefits Income"]}'::jsonb, false, 25, 'Employer-paid employee benefits, excluding owner-only benefits and retirement-plan contributions.'),
  ('employee_benefits_review_gl_v4', '{"qbo_account_name_keys":["fringe benefits","employee reimbursements benefits","benefits"]}'::jsonb, 'employee_benefits', 'needs_review', 0::numeric, '{"type":"employee_benefits_review","reporting_destination":"entity_specific_employee_benefit_candidate","allowed_qbo_account_type_keys":["expense"],"review_question":"Was this benefit for employees, an owner/shareholder, or both?"}'::jsonb, true, 39, 'Employer-paid employee benefits, excluding owner-only benefits and retirement-plan contributions.'),
  ('retirement_contributions_review_gl_v4', '{"qbo_account_name_keys":["employer retirement contributions","employer 401 k contributions","employer 401k contributions","employer pension contributions","pension expense","profit sharing contributions","employer profit sharing","employee pension plan expense","retirement plan expense","employer sep contributions","employer simple contributions","employer matching contributions","401 k match","401k match","pension and profit sharing","qualified plan contributions"]}'::jsonb, 'retirement_contributions', 'needs_review', 0::numeric, '{"type":"retirement_contribution_review","reporting_destination":"schedule_1_or_entity_specific_destination_not_determined","allowed_qbo_account_type_keys":["expense"],"beneficiary_scope":"unknown","contribution_type":"unknown","review_question":"Was this an employer contribution for employees, a contribution for an owner, or an employee amount withheld through payroll?","negative_aliases":["401(k) Payable","401k Payable","Employee 401(k) Withholding","Employee Retirement Withholding","Retirement Plan Liability","Pension Payable","Owner Contribution","Partner Contribution","Member Contribution","IRA Transfer","Retirement Transfer","Retirement Distribution","Pension Income","401(k) Loan","401k Loan","Employee Loan","Payroll Clearing","Benefit Payable","Plan Administration Fees"]}'::jsonb, true, 27, 'Retirement-plan contributions requiring confirmation of whether they were for employees, owners, or payroll withholding.')
  ) as seed(rule_code, match_conditions, tax_category, deductibility_status, default_deductible_percent, treatment, requires_review, priority, explanation)
),
same_version_conflicts as (
  select existing.rule_code
  from public.tax_deduction_rules existing
  join seed_tax_gl_alias_v4_new_rules seed
    on existing.rule_code = seed.rule_code
   and existing.tax_year = 2026
   and existing.version = 'bizzi-gl-2026-v4'
   and existing.business_id is null
   and existing.scope = 'global'
   and existing.jurisdiction = 'federal'
  where existing.match_conditions is distinct from seed.match_conditions
     or existing.tax_category is distinct from seed.tax_category
     or existing.deductibility_status is distinct from seed.deductibility_status
     or existing.default_deductible_percent is distinct from seed.default_deductible_percent
     or existing.treatment is distinct from seed.treatment
     or existing.requires_review is distinct from seed.requires_review
     or existing.priority is distinct from seed.priority
     or existing.explanation is distinct from seed.explanation
     or existing.source_reference is distinct from 'Bizzi approved deterministic GL-to-tax mapping policy 2026'
     or existing.source_url is distinct from 'internal://bizzi/tax/gl-alias-rules/2026-v4'
     or existing.effective_from is distinct from date '2026-01-01'
     or existing.effective_to is distinct from date '2026-12-31'
),
conflict_guard as (
  select 1 / case when exists (select 1 from same_version_conflicts) then 0 else 1 end as ok
),
copied_v3 as (
  insert into public.tax_deduction_rules (
    scope, business_id, rule_code, tax_year, jurisdiction, entity_type,
    bookkeeping_category, qbo_account_type, qbo_account_subtype, match_conditions,
    tax_category, deductibility_status, default_deductible_percent, treatment,
    requires_review, priority, explanation, source_reference, source_url,
    verified_at, effective_from, effective_to, is_active, version
  )
  select
    r.scope, r.business_id, r.rule_code, r.tax_year, r.jurisdiction, r.entity_type,
    r.bookkeeping_category, r.qbo_account_type, r.qbo_account_subtype, r.match_conditions,
    r.tax_category, r.deductibility_status, r.default_deductible_percent, r.treatment,
    r.requires_review, r.priority, r.explanation,
    'Bizzi approved deterministic GL-to-tax mapping policy 2026',
    'internal://bizzi/tax/gl-alias-rules/2026-v4',
    '2026-09-10T00:00:00Z'::timestamptz,
    r.effective_from, r.effective_to, true, 'bizzi-gl-2026-v4'
  from public.tax_deduction_rules r
  cross join conflict_guard
  where r.scope = 'global'
    and r.business_id is null
    and r.tax_year = 2026
    and r.jurisdiction = 'federal'
    and r.version = 'bizzi-gl-2026-v3'
    and r.is_active = true
    and not exists (
      select 1
      from public.tax_deduction_rules existing
      where existing.scope = r.scope
        and existing.business_id is not distinct from r.business_id
        and existing.tax_year = r.tax_year
        and existing.jurisdiction = r.jurisdiction
        and existing.rule_code = r.rule_code
        and existing.version = 'bizzi-gl-2026-v4'
    )
  returning 1
),
inserted_new as (
  insert into public.tax_deduction_rules (
    scope, business_id, rule_code, tax_year, jurisdiction, entity_type,
    bookkeeping_category, qbo_account_type, qbo_account_subtype, match_conditions,
    tax_category, deductibility_status, default_deductible_percent, treatment,
    requires_review, priority, explanation, source_reference, source_url,
    verified_at, effective_from, effective_to, is_active, version
  )
  select
    'global', null::uuid, seed.rule_code, 2026, 'federal', null,
    null, null, null, seed.match_conditions,
    seed.tax_category, seed.deductibility_status, seed.default_deductible_percent, seed.treatment,
    seed.requires_review, seed.priority, seed.explanation,
    'Bizzi approved deterministic GL-to-tax mapping policy 2026',
    'internal://bizzi/tax/gl-alias-rules/2026-v4',
    '2026-09-10T00:00:00Z'::timestamptz,
    date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v4'
  from seed_tax_gl_alias_v4_new_rules seed
  where not exists (
    select 1
    from public.tax_deduction_rules existing
    where existing.scope = 'global'
      and existing.business_id is null
      and existing.tax_year = 2026
      and existing.jurisdiction = 'federal'
      and existing.rule_code = seed.rule_code
      and existing.version = 'bizzi-gl-2026-v4'
  )
  returning 1
),
verified_v4 as (
  select count(*)::integer as present_count
  from public.tax_deduction_rules
  where scope = 'global'
    and business_id is null
    and tax_year = 2026
    and jurisdiction = 'federal'
    and version = 'bizzi-gl-2026-v4'
    and is_active = true
    and verified_at is not null
),
duplicate_aliases as (
  select alias.value::text as alias, count(*)::integer as owner_count
  from public.tax_deduction_rules r
  cross join lateral jsonb_array_elements_text(r.match_conditions->'qbo_account_name_keys') alias(value)
  where r.scope = 'global'
    and r.business_id is null
    and r.tax_year = 2026
    and r.jurisdiction = 'federal'
    and r.version = 'bizzi-gl-2026-v4'
    and r.is_active = true
  group by alias.value
  having count(*) > 1
),
deactivated_v3 as (
  update public.tax_deduction_rules r
  set is_active = false,
      updated_at = now()
  where (select present_count from verified_v4) = 54
    and not exists (select 1 from duplicate_aliases)
    and r.scope = 'global'
    and r.business_id is null
    and r.tax_year = 2026
    and r.jurisdiction = 'federal'
    and r.version = 'bizzi-gl-2026-v3'
    and r.is_active = true
  returning 1
)
select
  (select count(*) from copied_v3) as copied_v3_count,
  (select count(*) from inserted_new) as inserted_new_count,
  (select present_count from verified_v4) as verified_v4_count,
  (select count(*) from duplicate_aliases) as duplicate_v4_alias_count,
  (select count(*) from deactivated_v3) as deactivated_v3_count;

commit;
