begin;

do $$
declare
  v_expected_count integer;
  v_actual_count integer;
  v_active_verified_count integer;
  v_missing_count integer;
  v_unexpected_count integer;
  v_mismatch_count integer;
  v_duplicate_natural_key_count integer;
  v_equal_rank_conflict_count integer;
begin
  with expected_v3_rules as (
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
    seed.match_conditions::jsonb as match_conditions,
    seed.tax_category::text as tax_category,
    seed.deductibility_status::text as deductibility_status,
    seed.default_deductible_percent::numeric as default_deductible_percent,
    seed.treatment::jsonb as treatment,
    seed.requires_review::boolean as requires_review,
    seed.priority::integer as priority,
    seed.explanation::text as explanation,
    seed.source_reference::text as source_reference,
    seed.source_url::text as source_url,
    seed.effective_from::date as effective_from,
    seed.effective_to::date as effective_to,
    seed.version::text as version
  from jsonb_to_recordset($rules$[{"scope":"global","business_id":null,"rule_code":"software_subscriptions_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["software","software and apps","subscriptions","computer software","saas","software subscriptions","online services"]},"tax_category":"software_subscriptions","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"ordinary_expense","irs_category":"other_business_expense"},"requires_review":false,"priority":10,"explanation":"Approved deterministic GL alias mapping for software_subscriptions.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"business_insurance_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["insurance","business insurance","general liability","general liability insurance","commercial insurance","workers comp","workers compensation","workers compensation insurance","contractor insurance"]},"tax_category":"business_insurance","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"ordinary_expense","irs_category":"insurance"},"requires_review":false,"priority":12,"explanation":"Approved deterministic GL alias mapping for business_insurance.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"office_supplies_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["office supplies","office expense","administrative supplies","office materials"]},"tax_category":"office_supplies","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"ordinary_expense","irs_category":"office_expense"},"requires_review":false,"priority":20,"explanation":"Approved deterministic GL alias mapping for office_supplies.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"job_materials_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["materials","job materials","construction materials","building materials","supplies and materials","materials and supplies","job supplies","project materials","direct materials"]},"tax_category":"job_materials","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"job_cost_materials","irs_category":"supplies"},"requires_review":false,"priority":18,"explanation":"Approved deterministic GL alias mapping for job_materials.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"generic_supplies_review_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["supplies"]},"tax_category":"supplies","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"supplies_review","classification_review_required":true},"requires_review":true,"priority":42,"explanation":"Confirm whether these are office supplies, job supplies, or materials.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"contract_labor_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["subcontractors","subcontractor","subcontractor expense","contract labor","outside labor","independent contractors","1099 contractors","trade partners"]},"tax_category":"contract_labor","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"ordinary_expense","irs_category":"contract_labor"},"requires_review":false,"priority":16,"explanation":"Approved deterministic GL alias mapping for contract_labor.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"small_consumable_tools_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["small tools","hand tools","consumable tools","tool expense"]},"tax_category":"small_tools","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"ordinary_expense","irs_category":"tools"},"requires_review":false,"priority":24,"explanation":"Approved deterministic GL alias mapping for small_tools.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"tools_small_equipment_review_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["tools","small equipment"]},"tax_category":"small_tools","deductibility_status":"needs_review","default_deductible_percent":0,"treatment":{"type":"small_tools_review","capitalization_review_required":true},"requires_review":true,"priority":26,"explanation":"Approved deterministic GL alias mapping for small_tools.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"equipment_rental_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["equipment rental","equipment rentals","tool rental","tool rentals","machinery rental","rental equipment"]},"tax_category":"equipment_rental","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"rental_expense","irs_category":"rent"},"requires_review":false,"priority":22,"explanation":"Approved deterministic GL alias mapping for equipment_rental.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"vehicle_fuel_review_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["fuel","gas","vehicle fuel","auto fuel","fuel expense","gas and fuel","automobile expense","auto expense"]},"tax_category":"vehicle_expense","deductibility_status":"needs_review","default_deductible_percent":0,"treatment":{"type":"vehicle_expense","business_use_required":true},"requires_review":true,"priority":30,"explanation":"Approved deterministic GL alias mapping for vehicle_expense.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"vehicle_repairs_review_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["vehicle maintenance","auto maintenance","vehicle repairs","auto repairs","truck repairs","truck maintenance","fleet maintenance","vehicle repairs and maintenance"]},"tax_category":"vehicle_expense","deductibility_status":"needs_review","default_deductible_percent":0,"treatment":{"type":"vehicle_expense","business_use_required":true},"requires_review":true,"priority":30,"explanation":"Approved deterministic GL alias mapping for vehicle_expense.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"parking_tolls_transportation_review_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["parking","parking fees","tolls","road tolls","rideshare","uber","lyft","uber and lyft","lyft uber","local transportation","transportation"]},"tax_category":"travel_transportation","deductibility_status":"needs_review","default_deductible_percent":0,"treatment":{"type":"travel_transportation","business_purpose_required":true},"requires_review":true,"priority":34,"explanation":"Approved deterministic GL alias mapping for travel_transportation.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"repairs_maintenance_review_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["repairs","repairs and maintenance","equipment repairs","equipment maintenance","machinery repairs","property repairs","maintenance expense"]},"tax_category":"repairs_maintenance","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"ordinary_expense","capitalization_review_required":true},"requires_review":true,"priority":32,"explanation":"Approved deterministic GL alias mapping for repairs_maintenance.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"licenses_permits_inspections_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["permits","business licenses","licenses","licenses and permits","inspection fees","permit fees","building permits","contractor licenses"]},"tax_category":"licenses_permits","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"ordinary_expense","irs_category":"taxes_and_licenses"},"requires_review":false,"priority":22,"explanation":"Approved deterministic GL alias mapping for licenses_permits.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"waste_disposal_job_costs_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["dump fees","waste disposal","debris removal","trash removal","hauling","disposal fees","landfill fees","jobsite cleanup"]},"tax_category":"waste_disposal_job_costs","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"job_cost","irs_category":"disposal_fees"},"requires_review":false,"priority":22,"explanation":"Approved deterministic GL alias mapping for waste_disposal_job_costs.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"payment_processing_fees_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["merchant fees","merchant processing fees","processing fees","credit card fees","credit card processing fees","payment processing fees","stripe fees","square fees"]},"tax_category":"payment_processing_fees","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"ordinary_expense","irs_category":"commissions_and_fees"},"requires_review":false,"priority":14,"explanation":"Approved deterministic GL alias mapping for payment_processing_fees.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"bank_service_fees_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["bank fees","bank charges","service charges","bank service charges","monthly bank fees"]},"tax_category":"bank_fees","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"ordinary_expense","irs_category":"bank_fees"},"requires_review":false,"priority":14,"explanation":"Approved deterministic GL alias mapping for bank_fees.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"legal_services_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["legal","legal fees","attorney fees","legal services"]},"tax_category":"legal_professional","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"ordinary_expense","irs_category":"legal_and_professional_fees"},"requires_review":false,"priority":18,"explanation":"Approved deterministic GL alias mapping for legal_professional.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"accounting_services_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["accounting","accounting fees","bookkeeping","bookkeeping fees","tax preparation","cpa fees"]},"tax_category":"legal_professional","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"ordinary_expense","irs_category":"legal_and_professional_fees"},"requires_review":false,"priority":18,"explanation":"Approved deterministic GL alias mapping for legal_professional.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"professional_services_review_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["professional fees","professional services","consulting fees","consultants"]},"tax_category":"legal_professional","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"ordinary_expense","review_required":true},"requires_review":true,"priority":28,"explanation":"Approved deterministic GL alias mapping for legal_professional.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"advertising_marketing_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["advertising","marketing","advertising and marketing","digital advertising","online advertising","website advertising","lead generation","promotional expense"]},"tax_category":"advertising_marketing","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"ordinary_expense","irs_category":"advertising"},"requires_review":false,"priority":20,"explanation":"Approved deterministic GL alias mapping for advertising_marketing.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"business_rent_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["office rent","shop rent","warehouse rent","business rent","yard rent","storage rent","commercial rent"]},"tax_category":"rent_lease","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"ordinary_expense","irs_category":"rent"},"requires_review":false,"priority":20,"explanation":"Approved deterministic GL alias mapping for rent_lease.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"generic_rent_review_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["rent","rent expense","lease expense"]},"tax_category":"rent_lease","deductibility_status":"needs_review","default_deductible_percent":0,"treatment":{"type":"rent_review","business_use_required":true},"requires_review":true,"priority":34,"explanation":"Approved deterministic GL alias mapping for rent_lease.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"business_premises_utilities_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["shop utilities","office utilities","warehouse utilities","jobsite utilities","commercial utilities"]},"tax_category":"utilities","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"ordinary_expense","irs_category":"utilities"},"requires_review":false,"priority":22,"explanation":"Approved deterministic GL alias mapping for utilities.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"mixed_utilities_review_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["utilities","electric","electricity","water","internet","internet expense","phone","phone bill","telephone","cell phone","mobile phone"]},"tax_category":"utilities","deductibility_status":"needs_review","default_deductible_percent":0,"treatment":{"type":"utilities_review","business_use_required":true},"requires_review":true,"priority":36,"explanation":"Approved deterministic GL alias mapping for utilities.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"safety_supplies_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["safety equipment","ppe","personal protective equipment","safety supplies","protective gear","jobsite safety"]},"tax_category":"safety_supplies","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"ordinary_expense","irs_category":"safety_supplies"},"requires_review":false,"priority":20,"explanation":"Approved deterministic GL alias mapping for safety_supplies.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"uniforms_work_clothing_review_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["uniforms","work uniforms","branded apparel","protective clothing","work clothing","workwear"]},"tax_category":"uniforms_work_clothing","deductibility_status":"needs_review","default_deductible_percent":0,"treatment":{"type":"uniforms_review","substantiation_required":true},"requires_review":true,"priority":38,"explanation":"Approved deterministic GL alias mapping for uniforms_work_clothing.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"education_training_review_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["training","employee training","continuing education","certifications","professional development","safety training"]},"tax_category":"education_training","deductibility_status":"needs_review","default_deductible_percent":0,"treatment":{"type":"education_training_review","business_purpose_required":true},"requires_review":true,"priority":38,"explanation":"Approved deterministic GL alias mapping for education_training.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"business_travel_review_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["travel","business travel","lodging","hotels","hotel","airfare","flights"]},"tax_category":"business_travel","deductibility_status":"needs_review","default_deductible_percent":0,"treatment":{"type":"business_travel","business_purpose_required":true},"requires_review":true,"priority":36,"explanation":"Approved deterministic GL alias mapping for business_travel.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"business_meals_review_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["meals","business meals","client meals","travel meals","meals and entertainment"]},"tax_category":"business_meals","deductibility_status":"partially_deductible","default_deductible_percent":50,"treatment":{"type":"ordinary_expense","limitation":"50_percent_meals","substantiation_required":true},"requires_review":true,"priority":32,"explanation":"Approved deterministic GL alias mapping for business_meals.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"depreciation_review_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["depreciation expense","accumulated depreciation expense","depreciation"]},"tax_category":"depreciation","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"depreciation_expense","fixed_asset_reconciliation_required":true},"requires_review":true,"priority":40,"explanation":"Approved deterministic GL alias mapping for depreciation.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"fixed_asset_capitalizable_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["equipment purchase","equipment purchases","machinery purchase","machinery","vehicles","vehicle purchase","construction equipment","fixed assets","furniture and equipment"]},"tax_category":"fixed_asset_capitalizable","deductibility_status":"capitalizable","default_deductible_percent":0,"treatment":{"type":"capitalizable","depreciation_required":true},"requires_review":true,"priority":12,"explanation":"Approved deterministic GL alias mapping for fixed_asset_capitalizable.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"loan_interest_review_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["interest expense","loan interest","business loan interest","equipment loan interest","vehicle loan interest"]},"tax_category":"interest_expense","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"ordinary_expense","irs_category":"interest","limitations_review_required":true},"requires_review":true,"priority":34,"explanation":"Approved deterministic GL alias mapping for interest_expense.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"loan_principal_exclusion_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["loan principal","principal payment","loan payment principal","debt principal","note payable payment"]},"tax_category":"liability_payment","deductibility_status":"balance_sheet","default_deductible_percent":0,"treatment":{"type":"balance_sheet","component":"loan_principal"},"requires_review":false,"priority":4,"explanation":"Approved deterministic GL alias mapping for liability_payment.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"generic_loan_payment_review_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["loan payment","business loan payment","debt payment"]},"tax_category":"debt_payment","deductibility_status":"needs_review","default_deductible_percent":0,"treatment":{"type":"debt_payment_review","principal_interest_split_required":true},"requires_review":true,"priority":44,"explanation":"Separate principal from potentially deductible interest.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"owner_activity_exclusion_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["owner draw","owner draws","owner distribution","owner distributions","partner distribution","shareholder distribution","personal expense","personal expenses","owner contribution","owner contributions"]},"tax_category":"owner_activity","deductibility_status":"balance_sheet","default_deductible_percent":0,"treatment":{"type":"balance_sheet","component":"owner_activity"},"requires_review":false,"priority":4,"explanation":"Approved deterministic GL alias mapping for owner_activity.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"transfer_credit_card_payment_exclusion_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["transfer","transfers","bank transfer","account transfer","credit card payment","credit card payments","payment to credit card"]},"tax_category":"transfer","deductibility_status":"balance_sheet","default_deductible_percent":0,"treatment":{"type":"balance_sheet","component":"transfer_or_credit_card_payment"},"requires_review":false,"priority":4,"explanation":"Approved deterministic GL alias mapping for transfer.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"payroll_wages_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["wages","payroll","gross wages","employee wages","salaries"]},"tax_category":"wages_payroll","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"ordinary_expense","irs_category":"wages"},"requires_review":false,"priority":24,"explanation":"Approved deterministic GL alias mapping for wages_payroll.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"employer_payroll_taxes_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["payroll taxes","employer payroll taxes"]},"tax_category":"payroll_taxes","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"ordinary_expense","irs_category":"employer_payroll_taxes"},"requires_review":false,"priority":24,"explanation":"Approved deterministic GL alias mapping for payroll_taxes.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"revenue_exclusion_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["income","sales","sales income","service revenue","contract revenue","construction income","job revenue"]},"tax_category":"revenue","deductibility_status":"balance_sheet","default_deductible_percent":0,"treatment":{"type":"revenue","ordinaryExpense":false},"requires_review":false,"priority":2,"explanation":"Approved deterministic GL alias mapping for revenue.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"liability_balance_sheet_exclusion_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["sales tax payable","payroll liabilities","credit card payable","accounts payable","loans payable"]},"tax_category":"balance_sheet_movement","deductibility_status":"balance_sheet","default_deductible_percent":0,"treatment":{"type":"balance_sheet","component":"liability_movement"},"requires_review":false,"priority":2,"explanation":"Approved deterministic GL alias mapping for balance_sheet_movement.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"}]$rules$::jsonb) as seed (
    scope text, business_id uuid, rule_code text, tax_year integer, jurisdiction text,
    entity_type text, bookkeeping_category text, qbo_account_type text, qbo_account_subtype text,
    match_conditions jsonb, tax_category text, deductibility_status text,
    default_deductible_percent numeric, treatment jsonb, requires_review boolean,
    priority integer, explanation text, source_reference text, source_url text,
    effective_from date, effective_to date, version text
  )
),
  expected_fingerprints as (
    select rule_code, jsonb_build_object(
      'scope', e.scope,
      'business_id', e.business_id,
      'rule_code', e.rule_code,
      'tax_year', e.tax_year,
      'jurisdiction', e.jurisdiction,
      'entity_type', e.entity_type,
      'bookkeeping_category', e.bookkeeping_category,
      'qbo_account_type', e.qbo_account_type,
      'qbo_account_subtype', e.qbo_account_subtype,
      'match_conditions', e.match_conditions,
      'tax_category', e.tax_category,
      'deductibility_status', e.deductibility_status,
      'default_deductible_percent', e.default_deductible_percent,
      'treatment', e.treatment,
      'requires_review', e.requires_review,
      'priority', e.priority,
      'explanation', e.explanation,
      'source_reference', e.source_reference,
      'source_url', e.source_url,
      'effective_from', e.effective_from,
      'effective_to', e.effective_to,
      'version', e.version
    ) as immutable_json
    from expected_v3_rules e
  ),
  actual_v3_rules as (
  select
    r.scope, r.business_id, r.rule_code, r.tax_year, r.jurisdiction, r.entity_type,
    r.bookkeeping_category, r.qbo_account_type, r.qbo_account_subtype, r.match_conditions,
    r.tax_category, r.deductibility_status, r.default_deductible_percent, r.treatment,
    r.requires_review, r.priority, r.explanation, r.source_reference, r.source_url,
    r.effective_from, r.effective_to, r.version, r.is_active, r.verified_at
  from public.tax_deduction_rules r
  where r.version = 'bizzi-gl-2026-v3'
    and r.scope = 'global'
    and r.business_id is null
    and r.tax_year = 2026
    and r.jurisdiction = 'federal'
),
  actual_fingerprints as (
    select rule_code, jsonb_build_object(
      'scope', a.scope,
      'business_id', a.business_id,
      'rule_code', a.rule_code,
      'tax_year', a.tax_year,
      'jurisdiction', a.jurisdiction,
      'entity_type', a.entity_type,
      'bookkeeping_category', a.bookkeeping_category,
      'qbo_account_type', a.qbo_account_type,
      'qbo_account_subtype', a.qbo_account_subtype,
      'match_conditions', a.match_conditions,
      'tax_category', a.tax_category,
      'deductibility_status', a.deductibility_status,
      'default_deductible_percent', a.default_deductible_percent,
      'treatment', a.treatment,
      'requires_review', a.requires_review,
      'priority', a.priority,
      'explanation', a.explanation,
      'source_reference', a.source_reference,
      'source_url', a.source_url,
      'effective_from', a.effective_from,
      'effective_to', a.effective_to,
      'version', a.version
    ) as immutable_json, is_active, verified_at
    from actual_v3_rules a
  ),
  joined as (
    select
      coalesce(e.rule_code, a.rule_code) as rule_code,
      e.immutable_json as expected_immutable_json,
      a.immutable_json as actual_immutable_json,
      e.rule_code is not null as expected_exists,
      a.rule_code is not null as actual_exists,
      a.is_active,
      a.verified_at
    from expected_fingerprints e
    full join actual_fingerprints a on a.rule_code = e.rule_code
  ),
  active_alias_owners as (
    select
      alias.value::text as alias,
      r.scope, r.business_id, r.version, r.rule_code, r.priority, r.tax_category, r.deductibility_status, r.default_deductible_percent, r.treatment
    from public.tax_deduction_rules r
    cross join lateral jsonb_array_elements_text(r.match_conditions->'qbo_account_name_keys') alias(value)
    where r.tax_year = 2026
      and r.jurisdiction = 'federal'
      and r.is_active = true
      and r.verified_at is not null
      and r.match_conditions ? 'qbo_account_name_keys'
      and (r.version in ('bizzi-gl-2026-v2', 'bizzi-gl-2026-v3', 'irs-2026') or r.scope = 'business_override' or r.business_id is not null)
  ),
  ranked_aliases as (
    select *,
      case
        when business_id is not null or scope = 'business_override' then 1
        when version = 'bizzi-gl-2026-v3' then 2
        when version = 'bizzi-gl-2026-v2' then 3
        when version = 'irs-2026' then 4
        else 5
      end as precedence_rank
    from active_alias_owners
  ),
  alias_winners as (
    select distinct on (alias)
      alias,
      precedence_rank as winning_precedence_rank,
      priority as winning_priority
    from ranked_aliases
    order by alias, precedence_rank asc, priority asc, rule_code asc
  ),
  winner_conflicts as (
    select r.alias, r.precedence_rank, r.priority, count(*) as owner_count
    from ranked_aliases r
    join alias_winners w
      on w.alias = r.alias
     and w.winning_precedence_rank = r.precedence_rank
     and w.winning_priority = r.priority
    group by r.alias, r.precedence_rank, r.priority
    having count(*) > 1
  )
  select
    (select count(*) from expected_v3_rules),
    (select count(*) from actual_v3_rules),
    (select count(*) from actual_v3_rules where is_active = true and verified_at is not null),
    count(*) filter (where expected_exists and not actual_exists),
    count(*) filter (where actual_exists and not expected_exists),
    count(*) filter (where expected_exists and actual_exists and expected_immutable_json is distinct from actual_immutable_json),
    (select count(*) from (
      select scope, business_id, rule_code, tax_year, jurisdiction, version
      from public.tax_deduction_rules
      where version in ('bizzi-gl-2026-v2', 'bizzi-gl-2026-v3')
        and tax_year = 2026
        and jurisdiction = 'federal'
      group by scope, business_id, rule_code, tax_year, jurisdiction, version
      having count(*) > 1
    ) duplicate_keys),
    (select count(*) from winner_conflicts)
  into
    v_expected_count, v_actual_count, v_active_verified_count, v_missing_count, v_unexpected_count,
    v_mismatch_count, v_duplicate_natural_key_count, v_equal_rank_conflict_count
  from joined;

  if v_expected_count <> 41 then
    raise exception 'tax_gl_alias_v4_internal_expected_count_mismatch: %', v_expected_count;
  end if;

  if v_actual_count <> 41 or v_active_verified_count <> 41 or v_missing_count <> 0 or v_unexpected_count <> 0 or v_mismatch_count <> 0 then
    raise exception 'tax_gl_alias_v4_v3_baseline_mismatch actual=% active_verified=% missing=% unexpected=% mismatched=%',
      v_actual_count, v_active_verified_count, v_missing_count, v_unexpected_count, v_mismatch_count;
  end if;

  if v_duplicate_natural_key_count <> 0 then
    raise exception 'tax_gl_alias_v4_duplicate_natural_keys: %', v_duplicate_natural_key_count;
  end if;

  if v_equal_rank_conflict_count <> 0 then
    raise exception 'tax_gl_alias_v4_equal_rank_alias_conflicts: %', v_equal_rank_conflict_count;
  end if;
end $$;

with expected_v3_rules as (
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
    seed.match_conditions::jsonb as match_conditions,
    seed.tax_category::text as tax_category,
    seed.deductibility_status::text as deductibility_status,
    seed.default_deductible_percent::numeric as default_deductible_percent,
    seed.treatment::jsonb as treatment,
    seed.requires_review::boolean as requires_review,
    seed.priority::integer as priority,
    seed.explanation::text as explanation,
    seed.source_reference::text as source_reference,
    seed.source_url::text as source_url,
    seed.effective_from::date as effective_from,
    seed.effective_to::date as effective_to,
    seed.version::text as version
  from jsonb_to_recordset($rules$[{"scope":"global","business_id":null,"rule_code":"software_subscriptions_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["software","software and apps","subscriptions","computer software","saas","software subscriptions","online services"]},"tax_category":"software_subscriptions","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"ordinary_expense","irs_category":"other_business_expense"},"requires_review":false,"priority":10,"explanation":"Approved deterministic GL alias mapping for software_subscriptions.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"business_insurance_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["insurance","business insurance","general liability","general liability insurance","commercial insurance","workers comp","workers compensation","workers compensation insurance","contractor insurance"]},"tax_category":"business_insurance","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"ordinary_expense","irs_category":"insurance"},"requires_review":false,"priority":12,"explanation":"Approved deterministic GL alias mapping for business_insurance.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"office_supplies_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["office supplies","office expense","administrative supplies","office materials"]},"tax_category":"office_supplies","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"ordinary_expense","irs_category":"office_expense"},"requires_review":false,"priority":20,"explanation":"Approved deterministic GL alias mapping for office_supplies.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"job_materials_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["materials","job materials","construction materials","building materials","supplies and materials","materials and supplies","job supplies","project materials","direct materials"]},"tax_category":"job_materials","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"job_cost_materials","irs_category":"supplies"},"requires_review":false,"priority":18,"explanation":"Approved deterministic GL alias mapping for job_materials.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"generic_supplies_review_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["supplies"]},"tax_category":"supplies","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"supplies_review","classification_review_required":true},"requires_review":true,"priority":42,"explanation":"Confirm whether these are office supplies, job supplies, or materials.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"contract_labor_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["subcontractors","subcontractor","subcontractor expense","contract labor","outside labor","independent contractors","1099 contractors","trade partners"]},"tax_category":"contract_labor","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"ordinary_expense","irs_category":"contract_labor"},"requires_review":false,"priority":16,"explanation":"Approved deterministic GL alias mapping for contract_labor.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"small_consumable_tools_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["small tools","hand tools","consumable tools","tool expense"]},"tax_category":"small_tools","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"ordinary_expense","irs_category":"tools"},"requires_review":false,"priority":24,"explanation":"Approved deterministic GL alias mapping for small_tools.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"tools_small_equipment_review_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["tools","small equipment"]},"tax_category":"small_tools","deductibility_status":"needs_review","default_deductible_percent":0,"treatment":{"type":"small_tools_review","capitalization_review_required":true},"requires_review":true,"priority":26,"explanation":"Approved deterministic GL alias mapping for small_tools.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"equipment_rental_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["equipment rental","equipment rentals","tool rental","tool rentals","machinery rental","rental equipment"]},"tax_category":"equipment_rental","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"rental_expense","irs_category":"rent"},"requires_review":false,"priority":22,"explanation":"Approved deterministic GL alias mapping for equipment_rental.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"vehicle_fuel_review_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["fuel","gas","vehicle fuel","auto fuel","fuel expense","gas and fuel","automobile expense","auto expense"]},"tax_category":"vehicle_expense","deductibility_status":"needs_review","default_deductible_percent":0,"treatment":{"type":"vehicle_expense","business_use_required":true},"requires_review":true,"priority":30,"explanation":"Approved deterministic GL alias mapping for vehicle_expense.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"vehicle_repairs_review_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["vehicle maintenance","auto maintenance","vehicle repairs","auto repairs","truck repairs","truck maintenance","fleet maintenance","vehicle repairs and maintenance"]},"tax_category":"vehicle_expense","deductibility_status":"needs_review","default_deductible_percent":0,"treatment":{"type":"vehicle_expense","business_use_required":true},"requires_review":true,"priority":30,"explanation":"Approved deterministic GL alias mapping for vehicle_expense.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"parking_tolls_transportation_review_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["parking","parking fees","tolls","road tolls","rideshare","uber","lyft","uber and lyft","lyft uber","local transportation","transportation"]},"tax_category":"travel_transportation","deductibility_status":"needs_review","default_deductible_percent":0,"treatment":{"type":"travel_transportation","business_purpose_required":true},"requires_review":true,"priority":34,"explanation":"Approved deterministic GL alias mapping for travel_transportation.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"repairs_maintenance_review_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["repairs","repairs and maintenance","equipment repairs","equipment maintenance","machinery repairs","property repairs","maintenance expense"]},"tax_category":"repairs_maintenance","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"ordinary_expense","capitalization_review_required":true},"requires_review":true,"priority":32,"explanation":"Approved deterministic GL alias mapping for repairs_maintenance.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"licenses_permits_inspections_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["permits","business licenses","licenses","licenses and permits","inspection fees","permit fees","building permits","contractor licenses"]},"tax_category":"licenses_permits","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"ordinary_expense","irs_category":"taxes_and_licenses"},"requires_review":false,"priority":22,"explanation":"Approved deterministic GL alias mapping for licenses_permits.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"waste_disposal_job_costs_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["dump fees","waste disposal","debris removal","trash removal","hauling","disposal fees","landfill fees","jobsite cleanup"]},"tax_category":"waste_disposal_job_costs","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"job_cost","irs_category":"disposal_fees"},"requires_review":false,"priority":22,"explanation":"Approved deterministic GL alias mapping for waste_disposal_job_costs.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"payment_processing_fees_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["merchant fees","merchant processing fees","processing fees","credit card fees","credit card processing fees","payment processing fees","stripe fees","square fees"]},"tax_category":"payment_processing_fees","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"ordinary_expense","irs_category":"commissions_and_fees"},"requires_review":false,"priority":14,"explanation":"Approved deterministic GL alias mapping for payment_processing_fees.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"bank_service_fees_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["bank fees","bank charges","service charges","bank service charges","monthly bank fees"]},"tax_category":"bank_fees","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"ordinary_expense","irs_category":"bank_fees"},"requires_review":false,"priority":14,"explanation":"Approved deterministic GL alias mapping for bank_fees.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"legal_services_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["legal","legal fees","attorney fees","legal services"]},"tax_category":"legal_professional","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"ordinary_expense","irs_category":"legal_and_professional_fees"},"requires_review":false,"priority":18,"explanation":"Approved deterministic GL alias mapping for legal_professional.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"accounting_services_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["accounting","accounting fees","bookkeeping","bookkeeping fees","tax preparation","cpa fees"]},"tax_category":"legal_professional","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"ordinary_expense","irs_category":"legal_and_professional_fees"},"requires_review":false,"priority":18,"explanation":"Approved deterministic GL alias mapping for legal_professional.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"professional_services_review_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["professional fees","professional services","consulting fees","consultants"]},"tax_category":"legal_professional","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"ordinary_expense","review_required":true},"requires_review":true,"priority":28,"explanation":"Approved deterministic GL alias mapping for legal_professional.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"advertising_marketing_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["advertising","marketing","advertising and marketing","digital advertising","online advertising","website advertising","lead generation","promotional expense"]},"tax_category":"advertising_marketing","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"ordinary_expense","irs_category":"advertising"},"requires_review":false,"priority":20,"explanation":"Approved deterministic GL alias mapping for advertising_marketing.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"business_rent_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["office rent","shop rent","warehouse rent","business rent","yard rent","storage rent","commercial rent"]},"tax_category":"rent_lease","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"ordinary_expense","irs_category":"rent"},"requires_review":false,"priority":20,"explanation":"Approved deterministic GL alias mapping for rent_lease.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"generic_rent_review_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["rent","rent expense","lease expense"]},"tax_category":"rent_lease","deductibility_status":"needs_review","default_deductible_percent":0,"treatment":{"type":"rent_review","business_use_required":true},"requires_review":true,"priority":34,"explanation":"Approved deterministic GL alias mapping for rent_lease.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"business_premises_utilities_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["shop utilities","office utilities","warehouse utilities","jobsite utilities","commercial utilities"]},"tax_category":"utilities","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"ordinary_expense","irs_category":"utilities"},"requires_review":false,"priority":22,"explanation":"Approved deterministic GL alias mapping for utilities.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"mixed_utilities_review_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["utilities","electric","electricity","water","internet","internet expense","phone","phone bill","telephone","cell phone","mobile phone"]},"tax_category":"utilities","deductibility_status":"needs_review","default_deductible_percent":0,"treatment":{"type":"utilities_review","business_use_required":true},"requires_review":true,"priority":36,"explanation":"Approved deterministic GL alias mapping for utilities.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"safety_supplies_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["safety equipment","ppe","personal protective equipment","safety supplies","protective gear","jobsite safety"]},"tax_category":"safety_supplies","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"ordinary_expense","irs_category":"safety_supplies"},"requires_review":false,"priority":20,"explanation":"Approved deterministic GL alias mapping for safety_supplies.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"uniforms_work_clothing_review_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["uniforms","work uniforms","branded apparel","protective clothing","work clothing","workwear"]},"tax_category":"uniforms_work_clothing","deductibility_status":"needs_review","default_deductible_percent":0,"treatment":{"type":"uniforms_review","substantiation_required":true},"requires_review":true,"priority":38,"explanation":"Approved deterministic GL alias mapping for uniforms_work_clothing.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"education_training_review_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["training","employee training","continuing education","certifications","professional development","safety training"]},"tax_category":"education_training","deductibility_status":"needs_review","default_deductible_percent":0,"treatment":{"type":"education_training_review","business_purpose_required":true},"requires_review":true,"priority":38,"explanation":"Approved deterministic GL alias mapping for education_training.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"business_travel_review_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["travel","business travel","lodging","hotels","hotel","airfare","flights"]},"tax_category":"business_travel","deductibility_status":"needs_review","default_deductible_percent":0,"treatment":{"type":"business_travel","business_purpose_required":true},"requires_review":true,"priority":36,"explanation":"Approved deterministic GL alias mapping for business_travel.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"business_meals_review_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["meals","business meals","client meals","travel meals","meals and entertainment"]},"tax_category":"business_meals","deductibility_status":"partially_deductible","default_deductible_percent":50,"treatment":{"type":"ordinary_expense","limitation":"50_percent_meals","substantiation_required":true},"requires_review":true,"priority":32,"explanation":"Approved deterministic GL alias mapping for business_meals.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"depreciation_review_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["depreciation expense","accumulated depreciation expense","depreciation"]},"tax_category":"depreciation","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"depreciation_expense","fixed_asset_reconciliation_required":true},"requires_review":true,"priority":40,"explanation":"Approved deterministic GL alias mapping for depreciation.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"fixed_asset_capitalizable_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["equipment purchase","equipment purchases","machinery purchase","machinery","vehicles","vehicle purchase","construction equipment","fixed assets","furniture and equipment"]},"tax_category":"fixed_asset_capitalizable","deductibility_status":"capitalizable","default_deductible_percent":0,"treatment":{"type":"capitalizable","depreciation_required":true},"requires_review":true,"priority":12,"explanation":"Approved deterministic GL alias mapping for fixed_asset_capitalizable.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"loan_interest_review_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["interest expense","loan interest","business loan interest","equipment loan interest","vehicle loan interest"]},"tax_category":"interest_expense","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"ordinary_expense","irs_category":"interest","limitations_review_required":true},"requires_review":true,"priority":34,"explanation":"Approved deterministic GL alias mapping for interest_expense.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"loan_principal_exclusion_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["loan principal","principal payment","loan payment principal","debt principal","note payable payment"]},"tax_category":"liability_payment","deductibility_status":"balance_sheet","default_deductible_percent":0,"treatment":{"type":"balance_sheet","component":"loan_principal"},"requires_review":false,"priority":4,"explanation":"Approved deterministic GL alias mapping for liability_payment.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"generic_loan_payment_review_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["loan payment","business loan payment","debt payment"]},"tax_category":"debt_payment","deductibility_status":"needs_review","default_deductible_percent":0,"treatment":{"type":"debt_payment_review","principal_interest_split_required":true},"requires_review":true,"priority":44,"explanation":"Separate principal from potentially deductible interest.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"owner_activity_exclusion_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["owner draw","owner draws","owner distribution","owner distributions","partner distribution","shareholder distribution","personal expense","personal expenses","owner contribution","owner contributions"]},"tax_category":"owner_activity","deductibility_status":"balance_sheet","default_deductible_percent":0,"treatment":{"type":"balance_sheet","component":"owner_activity"},"requires_review":false,"priority":4,"explanation":"Approved deterministic GL alias mapping for owner_activity.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"transfer_credit_card_payment_exclusion_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["transfer","transfers","bank transfer","account transfer","credit card payment","credit card payments","payment to credit card"]},"tax_category":"transfer","deductibility_status":"balance_sheet","default_deductible_percent":0,"treatment":{"type":"balance_sheet","component":"transfer_or_credit_card_payment"},"requires_review":false,"priority":4,"explanation":"Approved deterministic GL alias mapping for transfer.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"payroll_wages_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["wages","payroll","gross wages","employee wages","salaries"]},"tax_category":"wages_payroll","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"ordinary_expense","irs_category":"wages"},"requires_review":false,"priority":24,"explanation":"Approved deterministic GL alias mapping for wages_payroll.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"employer_payroll_taxes_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["payroll taxes","employer payroll taxes"]},"tax_category":"payroll_taxes","deductibility_status":"fully_deductible","default_deductible_percent":100,"treatment":{"type":"ordinary_expense","irs_category":"employer_payroll_taxes"},"requires_review":false,"priority":24,"explanation":"Approved deterministic GL alias mapping for payroll_taxes.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"revenue_exclusion_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["income","sales","sales income","service revenue","contract revenue","construction income","job revenue"]},"tax_category":"revenue","deductibility_status":"balance_sheet","default_deductible_percent":0,"treatment":{"type":"revenue","ordinaryExpense":false},"requires_review":false,"priority":2,"explanation":"Approved deterministic GL alias mapping for revenue.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"},{"scope":"global","business_id":null,"rule_code":"liability_balance_sheet_exclusion_gl_v3","tax_year":2026,"jurisdiction":"federal","entity_type":null,"bookkeeping_category":null,"qbo_account_type":null,"qbo_account_subtype":null,"match_conditions":{"qbo_account_name_keys":["sales tax payable","payroll liabilities","credit card payable","accounts payable","loans payable"]},"tax_category":"balance_sheet_movement","deductibility_status":"balance_sheet","default_deductible_percent":0,"treatment":{"type":"balance_sheet","component":"liability_movement"},"requires_review":false,"priority":2,"explanation":"Approved deterministic GL alias mapping for balance_sheet_movement.","source_reference":"Bizzi approved deterministic GL-to-tax mapping policy 2026","source_url":"internal://bizzi/tax/gl-alias-rules/2026-v3","effective_from":"2026-01-01","effective_to":"2026-12-31","version":"bizzi-gl-2026-v3"}]$rules$::jsonb) as seed (
    scope text, business_id uuid, rule_code text, tax_year integer, jurisdiction text,
    entity_type text, bookkeeping_category text, qbo_account_type text, qbo_account_subtype text,
    match_conditions jsonb, tax_category text, deductibility_status text,
    default_deductible_percent numeric, treatment jsonb, requires_review boolean,
    priority integer, explanation text, source_reference text, source_url text,
    effective_from date, effective_to date, version text
  )
),
expected_aliases as (
  select distinct alias.value::text as alias
  from expected_v3_rules e
  cross join lateral jsonb_array_elements_text(e.match_conditions->'qbo_account_name_keys') alias(value)
),
deactivated_v2 as (
  update public.tax_deduction_rules r
  set is_active = false,
      updated_at = '2026-09-08T00:00:00Z'::timestamptz
  where r.version = 'bizzi-gl-2026-v2'
    and r.scope = 'global'
    and r.business_id is null
    and r.tax_year = 2026
    and r.jurisdiction = 'federal'
    and r.is_active = true
    and exists (
      select 1
      from jsonb_array_elements_text(r.match_conditions->'qbo_account_name_keys') alias(value)
      join expected_aliases e on e.alias = alias.value
    )
  returning 1
)
select count(*) as deactivated_v2_gl_alias_rule_count from deactivated_v2;

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
security invoker
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
         lower(btrim(coalesce(v_current.metadata->>'fallback', ''))) in ('true', 't', '1', 'yes', 'y')
         or v_current.rule_id is null
         or v_current.rule_code is null
       )
     ) then
    raise exception 'classification_repair_target_invalid';
  end if;

  if p_deductible_percent is null or p_deductible_percent < 0 or p_deductible_percent > 100 then
    raise exception 'invalid_tax_classification_repair';
  end if;

  if p_classification_status not in ('auto_classified', 'needs_review', 'excluded') then
    raise exception 'invalid_tax_classification_repair_status';
  end if;

  if p_source is distinct from 'rule_engine' then
    raise exception 'invalid_tax_classification_repair_source';
  end if;

  if p_classification_status in ('auto_classified', 'needs_review')
     and btrim(coalesce(p_tax_category, '')) = '' then
    raise exception 'invalid_tax_classification_repair_tax_category';
  end if;

  if p_classification_status = 'needs_review'
     and lower(btrim(coalesce(p_tax_category, ''))) = 'unclassified' then
    raise exception 'invalid_tax_classification_repair_unresolved_fallback';
  end if;

  if p_classification_status in ('auto_classified', 'needs_review')
     and (p_rule_id is null or p_rule_code is null or p_rule_version is null) then
    raise exception 'invalid_tax_classification_repair_rule_identity';
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
revoke all on function public.apply_tax_classification_repair(
  uuid, integer, uuid, uuid, text, timestamptz, uuid, text, text, integer,
  text, text, numeric, jsonb, text, jsonb, numeric, numeric, numeric, numeric,
  numeric, text, text, boolean, text
) from anon;
revoke all on function public.apply_tax_classification_repair(
  uuid, integer, uuid, uuid, text, timestamptz, uuid, text, text, integer,
  text, text, numeric, jsonb, text, jsonb, numeric, numeric, numeric, numeric,
  numeric, text, text, boolean, text
) from authenticated;
grant execute on function public.apply_tax_classification_repair(
  uuid, integer, uuid, uuid, text, timestamptz, uuid, text, text, integer,
  text, text, numeric, jsonb, text, jsonb, numeric, numeric, numeric, numeric,
  numeric, text, text, boolean, text
) to service_role;

commit;
