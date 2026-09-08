begin;

drop function if exists public.seed_tax_gl_alias_rules_20260930();

create or replace function public.seed_tax_gl_alias_rules_20260930()
returns table (
  scope text,
  business_id uuid,
  rule_code text,
  tax_year integer,
  jurisdiction text,
  entity_type text,
  bookkeeping_category text,
  qbo_account_type text,
  qbo_account_subtype text,
  match_conditions jsonb,
  tax_category text,
  deductibility_status text,
  default_deductible_percent numeric,
  treatment jsonb,
  requires_review boolean,
  priority integer,
  explanation text,
  source_reference text,
  source_url text,
  verified_at timestamptz,
  effective_from date,
  effective_to date,
  is_active boolean,
  version text
)
language sql
stable
as $seed$
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
);
$seed$;

do $$
begin
  if exists (
    select 1
    from public.tax_deduction_rules existing
    join public.seed_tax_gl_alias_rules_20260930() seed
      on existing.rule_code = seed.rule_code
     and existing.tax_year = seed.tax_year
     and existing.version = seed.version
     and existing.business_id is not distinct from seed.business_id
     and existing.scope = seed.scope
     and existing.jurisdiction = seed.jurisdiction
    where existing.entity_type is distinct from seed.entity_type
       or existing.bookkeeping_category is distinct from seed.bookkeeping_category
       or existing.qbo_account_type is distinct from seed.qbo_account_type
       or existing.qbo_account_subtype is distinct from seed.qbo_account_subtype
       or existing.match_conditions is distinct from seed.match_conditions
       or existing.tax_category is distinct from seed.tax_category
       or existing.deductibility_status is distinct from seed.deductibility_status
       or existing.default_deductible_percent is distinct from seed.default_deductible_percent
       or existing.treatment is distinct from seed.treatment
       or existing.requires_review is distinct from seed.requires_review
       or existing.priority is distinct from seed.priority
       or existing.explanation is distinct from seed.explanation
       or existing.source_reference is distinct from seed.source_reference
       or existing.source_url is distinct from seed.source_url
       or existing.verified_at is distinct from seed.verified_at
       or existing.effective_from is distinct from seed.effective_from
       or existing.effective_to is distinct from seed.effective_to
       or existing.is_active is distinct from seed.is_active
  ) then
    raise exception 'tax_gl_alias_rules_v2_same_version_conflict';
  end if;
end $$;

with inserted as (
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
  from public.seed_tax_gl_alias_rules_20260930() seed
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
),
verified_v2 as (
  select count(*)::integer as present_count
  from public.tax_deduction_rules existing
  join public.seed_tax_gl_alias_rules_20260930() seed
    on existing.scope = seed.scope
   and existing.tax_year = seed.tax_year
   and existing.jurisdiction = seed.jurisdiction
   and existing.rule_code = seed.rule_code
   and existing.business_id is not distinct from seed.business_id
   and existing.version = seed.version
  where existing.is_active = true
    and existing.verified_at is not null
    and existing.match_conditions = seed.match_conditions
),
deactivated_v1 as (
  update public.tax_deduction_rules existing
  set is_active = false,
      updated_at = now()
  where (select present_count from verified_v2) = (select count(*) from public.seed_tax_gl_alias_rules_20260930())
    and existing.business_id is null
    and existing.scope = 'global'
    and existing.tax_year = 2026
    and existing.jurisdiction = 'federal'
    and existing.version = 'bizzi-gl-2026-v1'
    and existing.rule_code in (
      'software_subscriptions_gl',
      'merchant_payment_processing_fees_gl',
      'bank_service_charges_gl',
      'contractor_expense_gl',
      'ordinary_business_insurance_gl',
      'ordinary_office_supplies_gl',
      'business_utilities_gl',
      'legal_professional_fees_gl',
      'rent_lease_gl',
      'advertising_marketing_gl',
      'licenses_permits_gl',
      'repairs_maintenance_gl',
      'meals_gl_review',
      'vehicle_gas_gl_review',
      'parking_rideshare_transportation_gl_review',
      'equipment_rental_gl_review'
    )
    and existing.is_active = true
  returning 1
)
select
  (select count(*) from inserted) as inserted_count,
  (select present_count from verified_v2) as verified_v2_count,
  (select count(*) from deactivated_v1) as deactivated_v1_count;

create or replace function public.apply_tax_classification_repair(
  p_business_id uuid,
  p_tax_year integer,
  p_transaction_id uuid,
  p_actor_user_id uuid,
  p_repair_reason text,
  p_expected_updated_at timestamptz,
  p_rule_id uuid,
  p_rule_code text,
  p_rule_version text,
  p_rule_priority integer,
  p_tax_category text,
  p_deductibility_status text,
  p_deductible_percent numeric,
  p_tax_treatment jsonb,
  p_classification_status text,
  p_metadata jsonb,
  p_book_amount numeric,
  p_deductible_amount numeric,
  p_nondeductible_amount numeric,
  p_capitalizable_amount numeric,
  p_confidence_score numeric,
  p_confidence_level text,
  p_source text,
  p_requires_review boolean,
  p_reason text
)
returns public.transaction_tax_classifications
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current public.transaction_tax_classifications%rowtype;
  v_updated public.transaction_tax_classifications%rowtype;
  v_previous_values jsonb;
  v_new_values jsonb;
begin
  select *
  into v_current
  from public.transaction_tax_classifications
  where business_id = p_business_id
    and tax_year = p_tax_year
    and transaction_id = p_transaction_id
  for update;

  if not found then
    raise exception 'classification_not_found';
  end if;

  if p_expected_updated_at is not null
     and v_current.updated_at is not null
     and v_current.updated_at is distinct from p_expected_updated_at then
    raise exception 'classification_conflict';
  end if;

  if v_current.classification_status in ('user_confirmed', 'cpa_confirmed', 'excluded')
     or coalesce(v_current.user_override, false)
     or coalesce(v_current.cpa_override, false)
     or not (
       v_current.classification_status = 'needs_review'
       and lower(coalesce(v_current.tax_category, '')) = 'unclassified'
       and (
         coalesce((v_current.metadata->>'fallback')::boolean, false)
         or v_current.rule_id is null
         or v_current.rule_code is null
       )
     ) then
    raise exception 'classification_repair_target_invalid';
  end if;

  if p_deductible_percent is null or p_deductible_percent < 0 or p_deductible_percent > 100 then
    raise exception 'invalid_tax_classification_repair';
  end if;

  v_previous_values := jsonb_build_object(
    'tax_category', v_current.tax_category,
    'deductibility_status', v_current.deductibility_status,
    'deductible_percent', v_current.deductible_percent,
    'book_amount', v_current.book_amount,
    'deductible_amount', v_current.deductible_amount,
    'nondeductible_amount', v_current.nondeductible_amount,
    'capitalizable_amount', v_current.capitalizable_amount,
    'tax_treatment', v_current.tax_treatment,
    'classification_status', v_current.classification_status,
    'confidence_score', v_current.confidence_score,
    'confidence_level', v_current.confidence_level,
    'rule_id', v_current.rule_id,
    'rule_code', v_current.rule_code,
    'rule_version', v_current.rule_version,
    'rule_priority', v_current.rule_priority,
    'source', v_current.source,
    'requires_review', v_current.requires_review,
    'reason', v_current.reason
  );

  v_new_values := jsonb_build_object(
    'tax_category', p_tax_category,
    'deductibility_status', p_deductibility_status,
    'deductible_percent', p_deductible_percent,
    'book_amount', p_book_amount,
    'deductible_amount', p_deductible_amount,
    'nondeductible_amount', p_nondeductible_amount,
    'capitalizable_amount', p_capitalizable_amount,
    'tax_treatment', p_tax_treatment,
    'classification_status', p_classification_status,
    'confidence_score', p_confidence_score,
    'confidence_level', p_confidence_level,
    'rule_id', p_rule_id,
    'rule_code', p_rule_code,
    'rule_version', p_rule_version,
    'rule_priority', p_rule_priority,
    'source', p_source,
    'requires_review', p_requires_review,
    'reason', p_reason,
    'metadata', coalesce(v_current.metadata, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb)
  );

  insert into public.tax_classification_overrides (
    business_id,
    tax_year,
    transaction_id,
    classification_id,
    previous_values,
    new_values,
    override_source,
    override_reason,
    overridden_by,
    created_at
  )
  values (
    p_business_id,
    p_tax_year,
    p_transaction_id,
    v_current.id,
    v_previous_values,
    v_new_values,
    'system_repair',
    p_repair_reason,
    p_actor_user_id,
    now()
  );

  update public.transaction_tax_classifications
  set
    tax_category = p_tax_category,
    deductibility_status = p_deductibility_status,
    deductible_percent = p_deductible_percent,
    book_amount = p_book_amount,
    deductible_amount = p_deductible_amount,
    nondeductible_amount = p_nondeductible_amount,
    capitalizable_amount = p_capitalizable_amount,
    tax_treatment = p_tax_treatment,
    classification_status = p_classification_status,
    confidence_score = p_confidence_score,
    confidence_level = p_confidence_level,
    rule_id = p_rule_id,
    rule_code = p_rule_code,
    rule_version = p_rule_version,
    rule_priority = p_rule_priority,
    source = p_source,
    requires_review = p_requires_review,
    reason = p_reason,
    user_override = false,
    cpa_override = false,
    metadata = coalesce(metadata, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb),
    updated_at = now()
  where id = v_current.id
  returning * into v_updated;

  return v_updated;
end;
$$;

revoke all on function public.apply_tax_classification_repair(
  uuid, integer, uuid, uuid, text, timestamptz, uuid, text, text, integer,
  text, text, numeric, jsonb, text, jsonb, numeric, numeric, numeric, numeric,
  numeric, text, text, boolean, text
) from public;
grant execute on function public.apply_tax_classification_repair(
  uuid, integer, uuid, uuid, text, timestamptz, uuid, text, text, integer,
  text, text, numeric, jsonb, text, jsonb, numeric, numeric, numeric, numeric,
  numeric, text, text, boolean, text
) to service_role;

drop function if exists public.seed_tax_gl_alias_rules_20260930();

commit;
