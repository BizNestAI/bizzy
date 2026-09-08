-- GL alias Tax classification v3 preflight.
-- Read-only inspection script. Keep this file free of mutation statements.
-- Migration-history rows are intentionally not queried here because PostgreSQL resolves
-- referenced relations at parse time even when a to_regclass branch would not run.

with params as (
  select
    'cffc2183-e77c-4148-a206-d5192e090925'::uuid as target_business_id,
    2026::integer as target_tax_year
),
target_versions(version) as (
  values ('bizzi-gl-2026-v1'::text), ('bizzi-gl-2026-v2'::text), ('bizzi-gl-2026-v3'::text)
),
target_migrations(version) as (
  values ('20260929'::text), ('20260930'::text), ('20261001'::text)
),
target_v1_rule_codes(rule_code) as (
  values
    ('software_subscriptions_gl'),
    ('merchant_payment_processing_fees_gl'),
    ('bank_service_charges_gl'),
    ('contractor_expense_gl'),
    ('ordinary_business_insurance_gl'),
    ('ordinary_office_supplies_gl'),
    ('business_utilities_gl'),
    ('legal_professional_fees_gl'),
    ('rent_lease_gl'),
    ('advertising_marketing_gl'),
    ('licenses_permits_gl'),
    ('repairs_maintenance_gl'),
    ('meals_gl_review'),
    ('vehicle_gas_gl_review'),
    ('parking_rideshare_transportation_gl_review'),
    ('equipment_rental_gl_review')
),
v3_rule_codes(rule_code) as (
  values
    ('generic_supplies_review_gl_v3'),
    ('parking_tolls_transportation_review_gl_v3'),
    ('mixed_utilities_review_gl_v3'),
    ('generic_loan_payment_review_gl_v3')
),
v3_dependency_v2_rule_codes(rule_code) as (
  values
    ('parking_tolls_transportation_review_gl_v2'),
    ('mixed_utilities_review_gl_v2')
),
expected_v2_rules as (
  select
    seed.scope::text as scope,
    seed.business_id::uuid as business_id,
    seed.rule_code::text as rule_code,
    seed.tax_year::integer as tax_year,
    seed.jurisdiction::text as jurisdiction,
    seed.entity_type::text as entity_type,
    seed.bookkeeping_category::text as bookkeeping_category,
    seed.qbo_account_type::text as qbo_account_type,
    seed.qbo_account_subtype::text as qbo_account_subtype,
    jsonb_build_object('qbo_account_name_keys', seed.qbo_account_name_keys::text[])::jsonb as match_conditions,
    seed.tax_category::text as tax_category,
    seed.deductibility_status::text as deductibility_status,
    seed.default_deductible_percent::numeric as default_deductible_percent,
    seed.treatment::jsonb as treatment,
    seed.requires_review::boolean as requires_review,
    seed.priority::integer as priority,
    seed.explanation::text as explanation,
    seed.source_reference::text as source_reference,
    seed.source_url::text as source_url,
    seed.verified_at::timestamptz as verified_at,
    seed.effective_from::date as effective_from,
    seed.effective_to::date as effective_to,
    seed.is_active::boolean as is_active,
    seed.version::text as version
  from (values
  ('global', null::uuid, 'software_subscriptions_gl_v2', 2026, 'federal', null, null, null, null, array['software','software and apps','subscriptions','computer software','saas','software subscriptions','online services']::text[], 'software_subscriptions', 'fully_deductible', 100.0, '{"type":"ordinary_expense","irs_category":"other_business_expense"}'::jsonb, false, 10, 'Approved deterministic GL alias mapping for software_subscriptions.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2'),
  ('global', null::uuid, 'business_insurance_gl_v2', 2026, 'federal', null, null, null, null, array['insurance','business insurance','general liability','general liability insurance','commercial insurance','workers comp','workers compensation','workers compensation insurance','contractor insurance']::text[], 'business_insurance', 'fully_deductible', 100.0, '{"type":"ordinary_expense","irs_category":"insurance"}'::jsonb, false, 12, 'Approved deterministic GL alias mapping for business_insurance.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2'),
  ('global', null::uuid, 'office_supplies_gl_v2', 2026, 'federal', null, null, null, null, array['office supplies','office expense','administrative supplies','office materials']::text[], 'office_supplies', 'fully_deductible', 100.0, '{"type":"ordinary_expense","irs_category":"office_expense"}'::jsonb, false, 20, 'Approved deterministic GL alias mapping for office_supplies.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2'),
  ('global', null::uuid, 'job_materials_gl_v2', 2026, 'federal', null, null, null, null, array['materials','job materials','construction materials','building materials','supplies and materials','materials and supplies','job supplies','project materials','direct materials']::text[], 'job_materials', 'fully_deductible', 100.0, '{"type":"job_cost_materials","irs_category":"supplies"}'::jsonb, false, 18, 'Approved deterministic GL alias mapping for job_materials.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2'),
  ('global', null::uuid, 'contract_labor_gl_v2', 2026, 'federal', null, null, null, null, array['subcontractors','subcontractor','subcontractor expense','contract labor','outside labor','independent contractors','1099 contractors','trade partners']::text[], 'contract_labor', 'fully_deductible', 100.0, '{"type":"ordinary_expense","irs_category":"contract_labor"}'::jsonb, false, 16, 'Approved deterministic GL alias mapping for contract_labor.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2'),
  ('global', null::uuid, 'small_consumable_tools_gl_v2', 2026, 'federal', null, null, null, null, array['small tools','hand tools','consumable tools','tool expense']::text[], 'small_tools', 'fully_deductible', 100.0, '{"type":"ordinary_expense","irs_category":"tools"}'::jsonb, false, 24, 'Approved deterministic GL alias mapping for small_tools.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2'),
  ('global', null::uuid, 'tools_small_equipment_review_gl_v2', 2026, 'federal', null, null, null, null, array['tools','small equipment']::text[], 'small_tools', 'needs_review', 0.0, '{"type":"small_tools_review","capitalization_review_required":true}'::jsonb, true, 26, 'Approved deterministic GL alias mapping for small_tools.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2'),
  ('global', null::uuid, 'equipment_rental_gl_v2', 2026, 'federal', null, null, null, null, array['equipment rental','equipment rentals','tool rental','tool rentals','machinery rental','rental equipment']::text[], 'equipment_rental', 'fully_deductible', 100.0, '{"type":"rental_expense","irs_category":"rent"}'::jsonb, false, 22, 'Approved deterministic GL alias mapping for equipment_rental.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2'),
  ('global', null::uuid, 'vehicle_fuel_review_gl_v2', 2026, 'federal', null, null, null, null, array['fuel','gas','vehicle fuel','auto fuel','fuel expense','gas and fuel','automobile expense','auto expense']::text[], 'vehicle_expense', 'needs_review', 0.0, '{"type":"vehicle_expense","business_use_required":true}'::jsonb, true, 30, 'Approved deterministic GL alias mapping for vehicle_expense.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2'),
  ('global', null::uuid, 'vehicle_repairs_review_gl_v2', 2026, 'federal', null, null, null, null, array['vehicle maintenance','auto maintenance','vehicle repairs','auto repairs','truck repairs','truck maintenance','fleet maintenance','vehicle repairs and maintenance']::text[], 'vehicle_expense', 'needs_review', 0.0, '{"type":"vehicle_expense","business_use_required":true}'::jsonb, true, 30, 'Approved deterministic GL alias mapping for vehicle_expense.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2'),
  ('global', null::uuid, 'parking_tolls_transportation_review_gl_v2', 2026, 'federal', null, null, null, null, array['parking','parking fees','tolls','road tolls','rideshare','uber','lyft','uber and lyft','local transportation','transportation']::text[], 'travel_transportation', 'needs_review', 0.0, '{"type":"travel_transportation","business_purpose_required":true}'::jsonb, true, 34, 'Approved deterministic GL alias mapping for travel_transportation.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2'),
  ('global', null::uuid, 'repairs_maintenance_review_gl_v2', 2026, 'federal', null, null, null, null, array['repairs','repairs and maintenance','equipment repairs','equipment maintenance','machinery repairs','property repairs','maintenance expense']::text[], 'repairs_maintenance', 'fully_deductible', 100.0, '{"type":"ordinary_expense","capitalization_review_required":true}'::jsonb, true, 32, 'Approved deterministic GL alias mapping for repairs_maintenance.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2'),
  ('global', null::uuid, 'licenses_permits_inspections_gl_v2', 2026, 'federal', null, null, null, null, array['permits','business licenses','licenses','licenses and permits','inspection fees','permit fees','building permits','contractor licenses']::text[], 'licenses_permits', 'fully_deductible', 100.0, '{"type":"ordinary_expense","irs_category":"taxes_and_licenses"}'::jsonb, false, 22, 'Approved deterministic GL alias mapping for licenses_permits.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2'),
  ('global', null::uuid, 'waste_disposal_job_costs_gl_v2', 2026, 'federal', null, null, null, null, array['dump fees','waste disposal','debris removal','trash removal','hauling','disposal fees','landfill fees','jobsite cleanup']::text[], 'waste_disposal_job_costs', 'fully_deductible', 100.0, '{"type":"job_cost","irs_category":"disposal_fees"}'::jsonb, false, 22, 'Approved deterministic GL alias mapping for waste_disposal_job_costs.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2'),
  ('global', null::uuid, 'payment_processing_fees_gl_v2', 2026, 'federal', null, null, null, null, array['merchant fees','merchant processing fees','processing fees','credit card fees','credit card processing fees','payment processing fees','stripe fees','square fees']::text[], 'payment_processing_fees', 'fully_deductible', 100.0, '{"type":"ordinary_expense","irs_category":"commissions_and_fees"}'::jsonb, false, 14, 'Approved deterministic GL alias mapping for payment_processing_fees.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2'),
  ('global', null::uuid, 'bank_service_fees_gl_v2', 2026, 'federal', null, null, null, null, array['bank fees','bank charges','service charges','bank service charges','monthly bank fees']::text[], 'bank_fees', 'fully_deductible', 100.0, '{"type":"ordinary_expense","irs_category":"bank_fees"}'::jsonb, false, 14, 'Approved deterministic GL alias mapping for bank_fees.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2'),
  ('global', null::uuid, 'legal_services_gl_v2', 2026, 'federal', null, null, null, null, array['legal','legal fees','attorney fees','legal services']::text[], 'legal_professional', 'fully_deductible', 100.0, '{"type":"ordinary_expense","irs_category":"legal_and_professional_fees"}'::jsonb, false, 18, 'Approved deterministic GL alias mapping for legal_professional.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2'),
  ('global', null::uuid, 'accounting_services_gl_v2', 2026, 'federal', null, null, null, null, array['accounting','accounting fees','bookkeeping','bookkeeping fees','tax preparation','cpa fees']::text[], 'legal_professional', 'fully_deductible', 100.0, '{"type":"ordinary_expense","irs_category":"legal_and_professional_fees"}'::jsonb, false, 18, 'Approved deterministic GL alias mapping for legal_professional.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2'),
  ('global', null::uuid, 'professional_services_review_gl_v2', 2026, 'federal', null, null, null, null, array['professional fees','professional services','consulting fees','consultants']::text[], 'legal_professional', 'fully_deductible', 100.0, '{"type":"ordinary_expense","review_required":true}'::jsonb, true, 28, 'Approved deterministic GL alias mapping for legal_professional.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2'),
  ('global', null::uuid, 'advertising_marketing_gl_v2', 2026, 'federal', null, null, null, null, array['advertising','marketing','advertising and marketing','digital advertising','online advertising','website advertising','lead generation','promotional expense']::text[], 'advertising_marketing', 'fully_deductible', 100.0, '{"type":"ordinary_expense","irs_category":"advertising"}'::jsonb, false, 20, 'Approved deterministic GL alias mapping for advertising_marketing.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2'),
  ('global', null::uuid, 'business_rent_gl_v2', 2026, 'federal', null, null, null, null, array['office rent','shop rent','warehouse rent','business rent','yard rent','storage rent','commercial rent']::text[], 'rent_lease', 'fully_deductible', 100.0, '{"type":"ordinary_expense","irs_category":"rent"}'::jsonb, false, 20, 'Approved deterministic GL alias mapping for rent_lease.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2'),
  ('global', null::uuid, 'generic_rent_review_gl_v2', 2026, 'federal', null, null, null, null, array['rent','rent expense','lease expense']::text[], 'rent_lease', 'needs_review', 0.0, '{"type":"rent_review","business_use_required":true}'::jsonb, true, 34, 'Approved deterministic GL alias mapping for rent_lease.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2'),
  ('global', null::uuid, 'business_premises_utilities_gl_v2', 2026, 'federal', null, null, null, null, array['shop utilities','office utilities','warehouse utilities','jobsite utilities','commercial utilities']::text[], 'utilities', 'fully_deductible', 100.0, '{"type":"ordinary_expense","irs_category":"utilities"}'::jsonb, false, 22, 'Approved deterministic GL alias mapping for utilities.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2'),
  ('global', null::uuid, 'mixed_utilities_review_gl_v2', 2026, 'federal', null, null, null, null, array['utilities','electric','electricity','water','internet','internet expense','phone','telephone','cell phone','mobile phone']::text[], 'utilities', 'needs_review', 0.0, '{"type":"utilities_review","business_use_required":true}'::jsonb, true, 36, 'Approved deterministic GL alias mapping for utilities.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2'),
  ('global', null::uuid, 'safety_supplies_gl_v2', 2026, 'federal', null, null, null, null, array['safety equipment','ppe','personal protective equipment','safety supplies','protective gear','jobsite safety']::text[], 'safety_supplies', 'fully_deductible', 100.0, '{"type":"ordinary_expense","irs_category":"safety_supplies"}'::jsonb, false, 20, 'Approved deterministic GL alias mapping for safety_supplies.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2'),
  ('global', null::uuid, 'uniforms_work_clothing_review_gl_v2', 2026, 'federal', null, null, null, null, array['uniforms','work uniforms','branded apparel','protective clothing','work clothing','workwear']::text[], 'uniforms_work_clothing', 'needs_review', 0.0, '{"type":"uniforms_review","substantiation_required":true}'::jsonb, true, 38, 'Approved deterministic GL alias mapping for uniforms_work_clothing.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2'),
  ('global', null::uuid, 'education_training_review_gl_v2', 2026, 'federal', null, null, null, null, array['training','employee training','continuing education','certifications','professional development','safety training']::text[], 'education_training', 'needs_review', 0.0, '{"type":"education_training_review","business_purpose_required":true}'::jsonb, true, 38, 'Approved deterministic GL alias mapping for education_training.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2'),
  ('global', null::uuid, 'business_travel_review_gl_v2', 2026, 'federal', null, null, null, null, array['travel','business travel','lodging','hotels','hotel','airfare','flights']::text[], 'business_travel', 'needs_review', 0.0, '{"type":"business_travel","business_purpose_required":true}'::jsonb, true, 36, 'Approved deterministic GL alias mapping for business_travel.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2'),
  ('global', null::uuid, 'business_meals_review_gl_v2', 2026, 'federal', null, null, null, null, array['meals','business meals','client meals','travel meals','meals and entertainment']::text[], 'business_meals', 'partially_deductible', 50.0, '{"type":"ordinary_expense","limitation":"50_percent_meals","substantiation_required":true}'::jsonb, true, 32, 'Approved deterministic GL alias mapping for business_meals.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2'),
  ('global', null::uuid, 'depreciation_review_gl_v2', 2026, 'federal', null, null, null, null, array['depreciation expense','accumulated depreciation expense','depreciation']::text[], 'depreciation', 'fully_deductible', 100.0, '{"type":"depreciation_expense","fixed_asset_reconciliation_required":true}'::jsonb, true, 40, 'Approved deterministic GL alias mapping for depreciation.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2'),
  ('global', null::uuid, 'fixed_asset_capitalizable_gl_v2', 2026, 'federal', null, null, null, null, array['equipment purchase','equipment purchases','machinery purchase','machinery','vehicles','vehicle purchase','construction equipment','fixed assets','furniture and equipment']::text[], 'fixed_asset_capitalizable', 'capitalizable', 0.0, '{"type":"capitalizable","depreciation_required":true}'::jsonb, true, 12, 'Approved deterministic GL alias mapping for fixed_asset_capitalizable.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2'),
  ('global', null::uuid, 'loan_interest_review_gl_v2', 2026, 'federal', null, null, null, null, array['interest expense','loan interest','business loan interest','equipment loan interest','vehicle loan interest']::text[], 'interest_expense', 'fully_deductible', 100.0, '{"type":"ordinary_expense","irs_category":"interest","limitations_review_required":true}'::jsonb, true, 34, 'Approved deterministic GL alias mapping for interest_expense.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2'),
  ('global', null::uuid, 'loan_principal_exclusion_gl_v2', 2026, 'federal', null, null, null, null, array['loan principal','principal payment','loan payment principal','debt principal','note payable payment']::text[], 'liability_payment', 'balance_sheet', 0.0, '{"type":"balance_sheet","component":"loan_principal"}'::jsonb, false, 4, 'Approved deterministic GL alias mapping for liability_payment.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2'),
  ('global', null::uuid, 'owner_activity_exclusion_gl_v2', 2026, 'federal', null, null, null, null, array['owner draw','owner draws','owner distribution','owner distributions','partner distribution','shareholder distribution','personal expense','personal expenses','owner contribution','owner contributions']::text[], 'owner_activity', 'balance_sheet', 0.0, '{"type":"balance_sheet","component":"owner_activity"}'::jsonb, false, 4, 'Approved deterministic GL alias mapping for owner_activity.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2'),
  ('global', null::uuid, 'transfer_credit_card_payment_exclusion_gl_v2', 2026, 'federal', null, null, null, null, array['transfer','transfers','bank transfer','account transfer','credit card payment','credit card payments','payment to credit card']::text[], 'transfer', 'balance_sheet', 0.0, '{"type":"balance_sheet","component":"transfer_or_credit_card_payment"}'::jsonb, false, 4, 'Approved deterministic GL alias mapping for transfer.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2'),
  ('global', null::uuid, 'payroll_wages_gl_v2', 2026, 'federal', null, null, null, null, array['wages','payroll','gross wages','employee wages','salaries']::text[], 'wages_payroll', 'fully_deductible', 100.0, '{"type":"ordinary_expense","irs_category":"wages"}'::jsonb, false, 24, 'Approved deterministic GL alias mapping for wages_payroll.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2'),
  ('global', null::uuid, 'employer_payroll_taxes_gl_v2', 2026, 'federal', null, null, null, null, array['payroll taxes','employer payroll taxes']::text[], 'payroll_taxes', 'fully_deductible', 100.0, '{"type":"ordinary_expense","irs_category":"employer_payroll_taxes"}'::jsonb, false, 24, 'Approved deterministic GL alias mapping for payroll_taxes.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2'),
  ('global', null::uuid, 'revenue_exclusion_gl_v2', 2026, 'federal', null, null, null, null, array['income','sales','sales income','service revenue','contract revenue','construction income','job revenue']::text[], 'revenue', 'balance_sheet', 0.0, '{"type":"revenue","ordinaryExpense":false}'::jsonb, false, 2, 'Approved deterministic GL alias mapping for revenue.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2'),
  ('global', null::uuid, 'liability_balance_sheet_exclusion_gl_v2', 2026, 'federal', null, null, null, null, array['sales tax payable','payroll liabilities','credit card payable','accounts payable','loans payable']::text[], 'balance_sheet_movement', 'balance_sheet', 0.0, '{"type":"balance_sheet","component":"liability_movement"}'::jsonb, false, 2, 'Approved deterministic GL alias mapping for balance_sheet_movement.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v2', '2026-09-30T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v2')
  ) as seed (
    scope, business_id, rule_code, tax_year, jurisdiction, entity_type,
    bookkeeping_category, qbo_account_type, qbo_account_subtype, qbo_account_name_keys,
    tax_category, deductibility_status, default_deductible_percent, treatment,
    requires_review, priority, explanation, source_reference, source_url,
    verified_at, effective_from, effective_to, is_active, version
  )
),
expected_v2_fingerprints as (
  select *,
    jsonb_build_object(
      'scope', scope,
      'business_id', business_id,
      'rule_code', rule_code,
      'tax_year', tax_year,
      'jurisdiction', jurisdiction,
      'entity_type', entity_type,
      'bookkeeping_category', bookkeeping_category,
      'qbo_account_type', qbo_account_type,
      'qbo_account_subtype', qbo_account_subtype,
      'match_conditions', match_conditions,
      'tax_category', tax_category,
      'deductibility_status', deductibility_status,
      'default_deductible_percent', default_deductible_percent,
      'treatment', treatment,
      'requires_review', requires_review,
      'priority', priority,
      'explanation', explanation,
      'source_reference', source_reference,
      'source_url', source_url,
      'verified_at', verified_at,
      'effective_from', effective_from,
      'effective_to', effective_to,
      'is_active', is_active,
      'version', version
    ) as full_json,
    jsonb_build_object(
      'scope', scope,
      'business_id', business_id,
      'rule_code', rule_code,
      'tax_year', tax_year,
      'jurisdiction', jurisdiction,
      'entity_type', entity_type,
      'bookkeeping_category', bookkeeping_category,
      'qbo_account_type', qbo_account_type,
      'qbo_account_subtype', qbo_account_subtype,
      'match_conditions', match_conditions,
      'tax_category', tax_category,
      'deductibility_status', deductibility_status,
      'default_deductible_percent', default_deductible_percent,
      'treatment', treatment,
      'requires_review', requires_review,
      'priority', priority,
      'explanation', explanation,
      'source_reference', source_reference,
      'source_url', source_url,
      'effective_from', effective_from,
      'effective_to', effective_to,
      'version', version
    ) as immutable_json,
    jsonb_build_object('verified_at', verified_at) as timestamp_json,
    jsonb_build_object('is_active', is_active) as state_json
  from expected_v2_rules
),
actual_v2_rules as (
  select
    r.scope,
    r.business_id,
    r.rule_code,
    r.tax_year,
    r.jurisdiction,
    r.entity_type,
    r.bookkeeping_category,
    r.qbo_account_type,
    r.qbo_account_subtype,
    r.match_conditions,
    r.tax_category,
    r.deductibility_status,
    r.default_deductible_percent,
    r.treatment,
    r.requires_review,
    r.priority,
    r.explanation,
    r.source_reference,
    r.source_url,
    r.verified_at,
    r.effective_from,
    r.effective_to,
    r.is_active,
    r.version
  from public.tax_deduction_rules r
  where r.version = 'bizzi-gl-2026-v2'
    and r.scope = 'global'
    and r.business_id is null
    and r.tax_year = 2026
    and r.jurisdiction = 'federal'
),
actual_v2_fingerprints as (
  select *,
    jsonb_build_object(
      'scope', scope,
      'business_id', business_id,
      'rule_code', rule_code,
      'tax_year', tax_year,
      'jurisdiction', jurisdiction,
      'entity_type', entity_type,
      'bookkeeping_category', bookkeeping_category,
      'qbo_account_type', qbo_account_type,
      'qbo_account_subtype', qbo_account_subtype,
      'match_conditions', match_conditions,
      'tax_category', tax_category,
      'deductibility_status', deductibility_status,
      'default_deductible_percent', default_deductible_percent,
      'treatment', treatment,
      'requires_review', requires_review,
      'priority', priority,
      'explanation', explanation,
      'source_reference', source_reference,
      'source_url', source_url,
      'verified_at', verified_at,
      'effective_from', effective_from,
      'effective_to', effective_to,
      'is_active', is_active,
      'version', version
    ) as full_json,
    jsonb_build_object(
      'scope', scope,
      'business_id', business_id,
      'rule_code', rule_code,
      'tax_year', tax_year,
      'jurisdiction', jurisdiction,
      'entity_type', entity_type,
      'bookkeeping_category', bookkeeping_category,
      'qbo_account_type', qbo_account_type,
      'qbo_account_subtype', qbo_account_subtype,
      'match_conditions', match_conditions,
      'tax_category', tax_category,
      'deductibility_status', deductibility_status,
      'default_deductible_percent', default_deductible_percent,
      'treatment', treatment,
      'requires_review', requires_review,
      'priority', priority,
      'explanation', explanation,
      'source_reference', source_reference,
      'source_url', source_url,
      'effective_from', effective_from,
      'effective_to', effective_to,
      'version', version
    ) as immutable_json,
    jsonb_build_object('verified_at', verified_at) as timestamp_json,
    jsonb_build_object('is_active', is_active) as state_json
  from actual_v2_rules
),
v2_joined as (
  select
    coalesce(e.rule_code, a.rule_code) as rule_code,
    e.full_json as expected_full_json,
    a.full_json as actual_full_json,
    e.immutable_json as expected_immutable_json,
    a.immutable_json as actual_immutable_json,
    e.timestamp_json as expected_timestamp_json,
    a.timestamp_json as actual_timestamp_json,
    e.state_json as expected_state_json,
    a.state_json as actual_state_json,
    e.match_conditions as expected_match_conditions,
    a.match_conditions as actual_match_conditions,
    e.tax_category as expected_tax_category,
    a.tax_category as actual_tax_category,
    e.default_deductible_percent as expected_percent,
    a.default_deductible_percent as actual_percent,
    e.requires_review as expected_requires_review,
    a.requires_review as actual_requires_review,
    e.priority as expected_priority,
    a.priority as actual_priority,
    e.verified_at as expected_verified_at,
    a.verified_at as actual_verified_at,
    e.is_active as expected_is_active,
    a.is_active as actual_is_active,
    e.rule_code is not null as expected_exists,
    a.rule_code is not null as actual_exists
  from expected_v2_fingerprints e
  full join actual_v2_fingerprints a
    on a.scope = e.scope
   and a.business_id is not distinct from e.business_id
   and a.rule_code = e.rule_code
   and a.tax_year = e.tax_year
   and a.jurisdiction = e.jurisdiction
   and a.version = e.version
),
v2_buckets as (
  select
    rule_code,
    expected_exists,
    actual_exists,
    expected_full_json,
    actual_full_json,
    expected_immutable_json,
    actual_immutable_json,
    expected_timestamp_json,
    actual_timestamp_json,
    expected_state_json,
    actual_state_json,
    expected_match_conditions,
    actual_match_conditions,
    expected_tax_category,
    actual_tax_category,
    expected_percent,
    actual_percent,
    expected_requires_review,
    actual_requires_review,
    expected_priority,
    actual_priority,
    expected_verified_at,
    actual_verified_at,
    expected_is_active,
    actual_is_active,
    case
      when expected_exists and actual_exists and expected_full_json = actual_full_json then 'exact_match'
      when expected_exists and not actual_exists then 'missing_expected'
      when actual_exists and not expected_exists then 'unexpected_additional'
      when expected_immutable_json = actual_immutable_json and expected_timestamp_json = actual_timestamp_json and expected_state_json is distinct from actual_state_json then 'is_active_only'
      when expected_immutable_json = actual_immutable_json and expected_state_json = actual_state_json and expected_timestamp_json is distinct from actual_timestamp_json then 'timestamp_only'
      when expected_immutable_json = actual_immutable_json then 'state_or_timestamp_only'
      else 'material_mismatch'
    end as compatibility_bucket
  from v2_joined
),
function_oids as (
  select
    n.nspname,
    p.proname,
    p.oid,
    pg_get_function_identity_arguments(p.oid) as identity_arguments,
    p.prosecdef,
    p.proconfig
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('apply_tax_classification_repair', 'apply_tax_classification_neutralization')
),
safe_classifications as (
  select
    c.*,
    lower(btrim(coalesce(c.metadata->>'fallback', ''))) in ('true', 't', '1', 'yes', 'y') as metadata_fallback_true
  from public.transaction_tax_classifications c
),
target_classifications as (
  select c.*
  from safe_classifications c
  cross join params p
  where c.business_id = p.target_business_id
    and c.tax_year = p.target_tax_year
),
eligible_posted_transactions as (
  select count(distinct b.id)::integer as eligible_posted_transaction_count
  from public.bank_transactions b
  cross join params p
  where b.business_id = p.target_business_id
    and b.date >= make_date(p.target_tax_year, 1, 1)
    and b.date < make_date(p.target_tax_year + 1, 1, 1)
    and b.pending is not true
    and b.is_archived is not true
    and exists (
      select 1
      from public.qbo_posted_transactions q
      where q.business_id = b.business_id
        and q.transaction_id = b.id
        and q.status = 'posted'
    )
),
v2_duplicate_aliases as (
  select alias, jsonb_agg(rule_code order by rule_code) as rule_codes, count(*)::integer as alias_count
  from (
    select r.rule_code, alias.value::text as alias
    from actual_v2_rules r
    cross join lateral jsonb_array_elements_text(r.match_conditions->'qbo_account_name_keys') alias(value)
    where r.is_active = true
  ) aliases
  group by alias
  having count(*) > 1
)
select 'parameters' as check_name, jsonb_agg(row_to_json(t)) as result
from (
  select target_business_id, target_tax_year from params
) t
union all
select 'migration_history_table_availability' as check_name, jsonb_agg(row_to_json(t)) as result
from (
  select
    to_regclass('supabase_migrations.schema_migrations') is not null as migration_table_exists,
    jsonb_agg(version order by version) as versions_to_check_with_supabase_specific_query,
    case
      when to_regclass('supabase_migrations.schema_migrations') is null
        then 'schema_migrations table is unavailable; run migration-history inspection in a Supabase environment before deployment.'
      else 'schema_migrations table exists; run migration-history inspection separately to avoid parse-time coupling in this portable preflight.'
    end as note
  from target_migrations
) t
union all
select 'v2_compatibility_summary' as check_name, jsonb_agg(row_to_json(t)) as result
from (
  select
    (select count(*)::integer from expected_v2_fingerprints) as expected_v2_rule_count,
    (select count(*)::integer from actual_v2_fingerprints) as actual_v2_rule_count,
    count(*) filter (where compatibility_bucket = 'exact_match')::integer as exact_match_count,
    count(*) filter (where compatibility_bucket = 'missing_expected')::integer as missing_expected_count,
    count(*) filter (where compatibility_bucket = 'unexpected_additional')::integer as unexpected_additional_count,
    count(*) filter (where compatibility_bucket = 'is_active_only')::integer as is_active_only_count,
    count(*) filter (where compatibility_bucket = 'timestamp_only')::integer as timestamp_only_count,
    count(*) filter (where compatibility_bucket = 'state_or_timestamp_only')::integer as state_or_timestamp_only_count,
    count(*) filter (where compatibility_bucket = 'material_mismatch')::integer as materially_different_count,
    md5((select coalesce(jsonb_agg(full_json order by rule_code), '[]'::jsonb)::text from expected_v2_fingerprints)) as expected_aggregate_fingerprint,
    md5((select coalesce(jsonb_agg(full_json order by rule_code), '[]'::jsonb)::text from actual_v2_fingerprints)) as actual_aggregate_fingerprint,
    md5((select coalesce(jsonb_agg(immutable_json order by rule_code), '[]'::jsonb)::text from expected_v2_fingerprints)) as expected_immutable_fingerprint,
    md5((select coalesce(jsonb_agg(immutable_json order by rule_code), '[]'::jsonb)::text from actual_v2_fingerprints)) as actual_immutable_fingerprint,
    case
      when count(*) filter (where compatibility_bucket = 'missing_expected') > 0 then 'missing'
      when count(*) filter (where compatibility_bucket = 'unexpected_additional') > 0 then 'unexpected'
      when count(*) filter (where compatibility_bucket = 'material_mismatch') > 0 then 'mismatch'
      when count(*) filter (where compatibility_bucket in ('is_active_only', 'timestamp_only', 'state_or_timestamp_only')) > 0 then 'compatible_state_change_only'
      when count(*) filter (where compatibility_bucket = 'exact_match') = (select count(*) from expected_v2_fingerprints)
       and (select count(*) from actual_v2_fingerprints) = (select count(*) from expected_v2_fingerprints) then 'exact_match'
      else 'mismatch'
    end as compatibility_status
  from v2_buckets
) t
union all
select 'v2_exact_matches' as check_name, coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) as result
from (
  select rule_code from v2_buckets where compatibility_bucket = 'exact_match' order by rule_code
) t
union all
select 'v2_missing_expected_rows' as check_name, coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) as result
from (
  select rule_code, expected_tax_category, expected_percent, expected_requires_review, expected_priority
  from v2_buckets
  where compatibility_bucket = 'missing_expected'
  order by rule_code
) t
union all
select 'v2_unexpected_additional_rows' as check_name, coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) as result
from (
  select rule_code, actual_tax_category, actual_percent, actual_requires_review, actual_priority, actual_is_active, actual_verified_at
  from v2_buckets
  where compatibility_bucket = 'unexpected_additional'
  order by rule_code
) t
union all
select 'v2_same_key_content_mismatches' as check_name, coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) as result
from (
  select
    rule_code,
    compatibility_bucket,
    md5(coalesce(expected_full_json, '{}'::jsonb)::text) as expected_fingerprint,
    md5(coalesce(actual_full_json, '{}'::jsonb)::text) as actual_fingerprint
  from v2_buckets
  where compatibility_bucket not in ('exact_match', 'missing_expected', 'unexpected_additional')
  order by rule_code
) t
union all
select 'v2_rows_differing_only_in_is_active' as check_name, coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) as result
from (
  select rule_code, expected_is_active, actual_is_active
  from v2_buckets
  where compatibility_bucket = 'is_active_only'
  order by rule_code
) t
union all
select 'v2_rows_differing_only_in_timestamps' as check_name, coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) as result
from (
  select rule_code, expected_verified_at, actual_verified_at
  from v2_buckets
  where compatibility_bucket = 'timestamp_only'
  order by rule_code
) t
union all
select 'v2_materially_different_rule_rows' as check_name, coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) as result
from (
  select
    rule_code,
    expected_tax_category,
    actual_tax_category,
    expected_percent,
    actual_percent,
    expected_requires_review,
    actual_requires_review,
    expected_priority,
    actual_priority,
    md5(coalesce(expected_immutable_json, '{}'::jsonb)::text) as expected_immutable_fingerprint,
    md5(coalesce(actual_immutable_json, '{}'::jsonb)::text) as actual_immutable_fingerprint
  from v2_buckets
  where compatibility_bucket = 'material_mismatch'
  order by rule_code
) t
union all
select 'v2_dependency_rows_for_v3' as check_name, coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) as result
from (
  select
    d.rule_code,
    count(a.rule_code)::integer as actual_row_count,
    count(a.rule_code) = 1 as exists_exactly_once,
    bool_or(a.is_active) as is_active,
    bool_or(a.verified_at is not null) as is_verified,
    (
      select coalesce(jsonb_agg(alias.value order by alias.value), '[]'::jsonb)
      from actual_v2_rules ax
      cross join lateral jsonb_array_elements_text(ax.match_conditions->'qbo_account_name_keys') alias(value)
      where ax.rule_code = d.rule_code
    ) as aliases,
    max(a.tax_category) as tax_category,
    max(a.default_deductible_percent) as default_deductible_percent,
    bool_or(a.requires_review) as requires_review,
    max(a.priority) as priority,
    max(b.compatibility_bucket) as restored_v2_compatibility
  from v3_dependency_v2_rule_codes d
  left join actual_v2_rules a on a.rule_code = d.rule_code
  left join v2_buckets b on b.rule_code = d.rule_code
  group by d.rule_code
  order by d.rule_code
) t
union all
select 'v3_preexisting_rule_codes' as check_name, coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) as result
from (
  select
    v.rule_code,
    count(r.*)::integer as existing_count
  from v3_rule_codes v
  left join public.tax_deduction_rules r
    on r.rule_code = v.rule_code
   and r.version = 'bizzi-gl-2026-v3'
   and r.scope = 'global'
   and r.business_id is null
   and r.tax_year = 2026
   and r.jurisdiction = 'federal'
  group by v.rule_code
  order by v.rule_code
) t
union all
select 'v2_duplicate_active_aliases' as check_name, coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) as result
from (
  select alias, rule_codes, alias_count from v2_duplicate_aliases order by alias
) t
union all
select 'gl_rule_counts_by_version' as check_name, jsonb_agg(row_to_json(t)) as result
from (
  select v.version, count(r.*)::integer as rule_count
  from target_versions v
  left join public.tax_deduction_rules r
    on r.version = v.version
   and r.scope = 'global'
   and r.business_id is null
   and r.tax_year = 2026
   and r.jurisdiction = 'federal'
  group by v.version
  order by v.version
) t
union all
select 'active_verified_rule_counts' as check_name, jsonb_agg(row_to_json(t)) as result
from (
  select
    coalesce(version, '<null>') as version,
    count(*) filter (where is_active = true)::integer as active_count,
    count(*) filter (where is_active = true and verified_at is not null)::integer as active_verified_count
  from public.tax_deduction_rules
  where tax_year = 2026
    and jurisdiction = 'federal'
    and (version in (select version from target_versions) or version = 'irs-2026')
  group by version
  order by version
) t
union all
select 'same_natural_key_conflicts' as check_name, coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) as result
from (
  select
    scope,
    business_id,
    tax_year,
    jurisdiction,
    version,
    rule_code,
    count(*)::integer as row_count,
    count(distinct md5(jsonb_build_object(
      'entity_type', entity_type,
      'bookkeeping_category', bookkeeping_category,
      'qbo_account_type', qbo_account_type,
      'qbo_account_subtype', qbo_account_subtype,
      'match_conditions', match_conditions,
      'tax_category', tax_category,
      'deductibility_status', deductibility_status,
      'default_deductible_percent', default_deductible_percent,
      'treatment', treatment,
      'requires_review', requires_review,
      'priority', priority,
      'explanation', explanation,
      'source_reference', source_reference,
      'source_url', source_url,
      'verified_at', verified_at,
      'effective_from', effective_from,
      'effective_to', effective_to,
      'is_active', is_active
    )::text))::integer as distinct_content_count
  from public.tax_deduction_rules
  where tax_year = 2026
    and jurisdiction = 'federal'
    and version in (select version from target_versions)
  group by scope, business_id, tax_year, jurisdiction, version, rule_code
  having count(*) > 1 or count(distinct md5(jsonb_build_object(
    'entity_type', entity_type,
    'bookkeeping_category', bookkeeping_category,
    'qbo_account_type', qbo_account_type,
    'qbo_account_subtype', qbo_account_subtype,
    'match_conditions', match_conditions,
    'tax_category', tax_category,
    'deductibility_status', deductibility_status,
    'default_deductible_percent', default_deductible_percent,
    'treatment', treatment,
    'requires_review', requires_review,
    'priority', priority,
    'explanation', explanation,
    'source_reference', source_reference,
    'source_url', source_url,
    'verified_at', verified_at,
    'effective_from', effective_from,
    'effective_to', effective_to,
    'is_active', is_active
  )::text)) > 1
  order by version, rule_code
) t
union all
select 'business_overrides_to_preserve' as check_name, jsonb_agg(row_to_json(t)) as result
from (
  select
    count(*)::integer as total_business_override_count,
    count(*) filter (where is_active = true)::integer as active_business_override_count,
    count(*) filter (where match_conditions ? 'qbo_account_name_keys')::integer as gl_alias_business_override_count
  from public.tax_deduction_rules
  where tax_year = 2026
    and jurisdiction = 'federal'
    and (scope = 'business_override' or business_id is not null)
) t
union all
select 'targeted_v1_active_count' as check_name, jsonb_agg(row_to_json(t)) as result
from (
  select count(*)::integer as active_targeted_v1_rules
  from public.tax_deduction_rules
  where version = 'bizzi-gl-2026-v1'
    and business_id is null
    and scope = 'global'
    and tax_year = 2026
    and jurisdiction = 'federal'
    and is_active = true
    and rule_code in (select rule_code from target_v1_rule_codes)
) t
union all
select 'repair_functions' as check_name, coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) as result
from (
  select
    proname,
    identity_arguments,
    case when prosecdef then 'security_definer' else 'security_invoker' end as security_mode,
    proconfig as function_config
  from function_oids
  order by proname, identity_arguments
) t
union all
select 'repair_function_grants' as check_name, coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) as result
from (
  select
    f.proname,
    grants.grantee,
    grants.can_execute
  from function_oids f
  cross join lateral (
    select
      'PUBLIC'::text as grantee,
      exists (
        select 1
        from aclexplode(coalesce(
          (select p.proacl from pg_proc p where p.oid = f.oid),
          acldefault('f', (select p.proowner from pg_proc p where p.oid = f.oid))
        )) acl
        where acl.grantee = 0
          and acl.privilege_type = 'EXECUTE'
      ) as can_execute
    union all
    select r.rolname::text as grantee, has_function_privilege(r.oid, f.oid, 'EXECUTE') as can_execute
    from pg_roles r
    where r.rolname in ('anon', 'authenticated', 'service_role')
  ) grants
  order by f.proname, grants.grantee
) t
union all
select 'target_business_classification_counts' as check_name, jsonb_agg(row_to_json(t)) as result
from (
  select
    (select target_business_id from params) as business_id,
    (select target_tax_year from params) as tax_year,
    count(*)::integer as total,
    count(*) filter (
      where classification_status = 'needs_review'
        and lower(coalesce(tax_category, '')) = 'unclassified'
        and (metadata_fallback_true or rule_id is null or rule_code is null)
    )::integer as unresolved_fallback,
    count(*) filter (
      where classification_status = 'needs_review'
        and lower(coalesce(tax_category, '')) <> 'unclassified'
    )::integer as meaningful_needs_review,
    count(*) filter (where classification_status = 'auto_classified')::integer as auto_classified,
    count(*) filter (where classification_status = 'excluded')::integer as excluded,
    count(*) filter (where classification_status = 'failed')::integer as failed,
    count(*) filter (where classification_status = 'user_confirmed')::integer as user_confirmed,
    count(*) filter (where classification_status = 'cpa_confirmed')::integer as cpa_confirmed,
    count(*) filter (where coalesce(user_override, false))::integer as user_override,
    count(*) filter (where coalesce(cpa_override, false))::integer as cpa_override,
    max(updated_at) as max_updated_at
  from target_classifications
) t
union all
select 'target_business_eligible_posted_transactions' as check_name, jsonb_agg(row_to_json(t)) as result
from (
  select
    (select target_business_id from params) as business_id,
    (select target_tax_year from params) as tax_year,
    eligible_posted_transaction_count
  from eligible_posted_transactions
) t
union all
select 'global_classification_counts' as check_name, jsonb_agg(row_to_json(t)) as result
from (
  select
    count(*)::integer as total_classification_rows,
    count(*) filter (
      where classification_status = 'needs_review'
        and lower(coalesce(tax_category, '')) = 'unclassified'
        and (metadata_fallback_true or rule_id is null or rule_code is null)
    )::integer as unresolved_fallback_count,
    count(*) filter (
      where classification_status in ('user_confirmed', 'accountant_reviewed', 'cpa_confirmed')
         or coalesce(user_override, false)
         or coalesce(cpa_override, false)
    )::integer as confirmed_manual_cpa_authoritative_count,
    max(updated_at) as max_classification_updated_at
  from safe_classifications
) t;
