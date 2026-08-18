-- Canonical Bizzi Chart of Accounts.
-- QBO remains authoritative for customer account state; these tables control
-- Bizzi policy, canonical-to-QBO resolution, account-creation idempotency, and audit history.

create table if not exists public.bizzi_canonical_accounts (
  canonical_account_key text primary key,
  preferred_account_name text not null,
  qbo_account_type text not null,
  qbo_account_subtype text,
  is_active boolean not null default true,
  auto_create_policy text not null default 'ACCOUNTANT_REVIEW_REQUIRED',
  review_required boolean not null default true,
  purpose text not null,
  sort_order integer not null default 1000,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bizzi_canonical_accounts_auto_create_check
    check (auto_create_policy in ('AUTO_CREATE_ALLOWED', 'ACCOUNTANT_REVIEW_REQUIRED', 'DISABLED')),
  constraint bizzi_canonical_accounts_type_check
    check (qbo_account_type in ('Income', 'Other Income', 'Expense', 'Other Expense', 'Cost of Goods Sold', 'Bank', 'CreditCard', 'Accounts Receivable', 'Accounts Payable', 'Fixed Asset', 'Other Current Asset', 'Other Asset', 'Other Current Liability', 'Long Term Liability', 'Equity'))
);

create table if not exists public.bizzi_canonical_account_aliases (
  id uuid primary key default gen_random_uuid(),
  canonical_account_key text not null references public.bizzi_canonical_accounts(canonical_account_key) on delete cascade,
  alias_name text not null,
  alias_kind text not null default 'search_alias',
  is_approved_equivalent boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bizzi_canonical_account_aliases_kind_check
    check (alias_kind in ('search_alias', 'approved_equivalent')),
  unique (canonical_account_key, alias_name)
);

create table if not exists public.bizzi_canonical_intent_mappings (
  intent_key text primary key,
  canonical_account_key text not null references public.bizzi_canonical_accounts(canonical_account_key),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.qbo_accounts_cache (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  realm_id text not null,
  qbo_env text not null default 'production',
  qbo_account_id text not null,
  name text not null,
  fully_qualified_name text,
  account_type text,
  account_subtype text,
  active boolean not null default true,
  sync_token text,
  raw jsonb not null default '{}'::jsonb,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, qbo_env, realm_id, qbo_account_id)
);

create table if not exists public.business_canonical_qbo_account_mappings (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  realm_id text not null,
  qbo_env text not null default 'production',
  canonical_account_key text not null references public.bizzi_canonical_accounts(canonical_account_key),
  qbo_account_id text,
  qbo_account_name text,
  qbo_account_type text,
  qbo_account_subtype text,
  status text not null default 'needs_review',
  mapping_source text not null default 'resolver',
  created_by text not null default 'bizzi',
  mapped_by text,
  mapped_at timestamptz,
  disabled_at timestamptz,
  reviewed_at timestamptz,
  review_reason text,
  first_transaction_id uuid,
  first_intent_key text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint business_canonical_qbo_account_mappings_status_check
    check (status in ('existing_exact', 'existing_approved_equivalent', 'created_by_bizzi', 'needs_review', 'rejected', 'disabled')),
  constraint business_canonical_qbo_account_mappings_source_check
    check (mapping_source in ('resolver', 'manual', 'seed', 'qbo_sync', 'creation_intent', 'monthly_review'))
);

create unique index if not exists business_canonical_qbo_mapping_uq
  on public.business_canonical_qbo_account_mappings (business_id, qbo_env, realm_id, canonical_account_key);

create unique index if not exists business_canonical_qbo_active_mapping_uq
  on public.business_canonical_qbo_account_mappings (business_id, qbo_env, realm_id, canonical_account_key)
  where status in ('existing_exact', 'existing_approved_equivalent', 'created_by_bizzi');

create index if not exists business_canonical_qbo_review_idx
  on public.business_canonical_qbo_account_mappings (business_id, status, created_at desc);

create table if not exists public.qbo_account_mapping_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  realm_id text,
  qbo_env text not null default 'production',
  canonical_account_key text,
  qbo_account_id text,
  qbo_account_name text,
  event_type text not null,
  source text not null default 'resolver',
  transaction_id uuid,
  intent_key text,
  actor text not null default 'bizzi',
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint qbo_account_mapping_events_type_check
    check (event_type in ('existing_exact', 'existing_approved_equivalent', 'created_by_bizzi', 'needs_review', 'rejected', 'disabled', 'cache_refreshed', 'creation_claimed', 'creation_unknown', 'creation_failed'))
);

create index if not exists qbo_account_mapping_events_business_idx
  on public.qbo_account_mapping_events (business_id, created_at desc);

create table if not exists public.qbo_account_creation_intents (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  realm_id text not null,
  qbo_env text not null default 'production',
  canonical_account_key text not null references public.bizzi_canonical_accounts(canonical_account_key),
  request_id text not null,
  status text not null default 'processing',
  attempt_count integer not null default 0,
  processing_started_at timestamptz,
  lease_expires_at timestamptz,
  last_attempt_at timestamptz,
  qbo_account_id text,
  qbo_account_name text,
  payload_summary jsonb,
  response_summary jsonb,
  last_error jsonb,
  first_transaction_id uuid,
  first_intent_key text,
  created_by text not null default 'bizzi',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint qbo_account_creation_intents_status_check
    check (status in ('processing', 'unknown', 'created', 'mapped_existing', 'needs_review', 'failed')),
  unique (business_id, qbo_env, realm_id, canonical_account_key),
  unique (business_id, qbo_env, realm_id, request_id)
);

create index if not exists qbo_account_creation_intents_processing_idx
  on public.qbo_account_creation_intents (business_id, status, lease_expires_at)
  where status in ('processing', 'unknown', 'failed');

alter table if exists public.transaction_categorizations
  add column if not exists suggested_canonical_account_key text,
  add column if not exists final_canonical_account_key text;

alter table if exists public.vendor_rules
  add column if not exists canonical_account_key text;

create index if not exists txn_categ_suggested_canonical_idx
  on public.transaction_categorizations (business_id, suggested_canonical_account_key);

create index if not exists txn_categ_final_canonical_idx
  on public.transaction_categorizations (business_id, final_canonical_account_key);

create index if not exists vendor_rules_canonical_account_idx
  on public.vendor_rules (business_id, canonical_account_key);

insert into public.bizzi_canonical_accounts (
  canonical_account_key,
  preferred_account_name,
  qbo_account_type,
  qbo_account_subtype,
  is_active,
  auto_create_policy,
  review_required,
  purpose,
  sort_order
) values
  ('sales', 'Sales', 'Income', 'ServiceFeeIncome', true, 'ACCOUNTANT_REVIEW_REQUIRED', true, 'Operating sales and service revenue.', 10),
  ('other_income', 'Other Income', 'Other Income', 'OtherMiscellaneousIncome', true, 'ACCOUNTANT_REVIEW_REQUIRED', true, 'Non-operating income such as rewards or miscellaneous credits.', 20),
  ('software', 'Software', 'Expense', 'DuesSubscriptions', true, 'AUTO_CREATE_ALLOWED', false, 'Software, SaaS, cloud tools, and business subscriptions.', 100),
  ('electric', 'Electric', 'Expense', 'Utilities', true, 'AUTO_CREATE_ALLOWED', false, 'Electric utility costs.', 110),
  ('materials_supplies', 'Supplies & Materials', 'Expense', 'SuppliesMaterials', true, 'AUTO_CREATE_ALLOWED', false, 'Business supplies, job materials, hardware, and consumable materials.', 120),
  ('payment_processing_fees', 'Payment Processing Fees', 'Expense', 'BankCharges', true, 'AUTO_CREATE_ALLOWED', false, 'Merchant processing fees from Stripe, Square, PayPal, Intuit, and similar processors.', 130),
  ('advertising_marketing', 'Advertising & Marketing', 'Expense', 'AdvertisingPromotional', true, 'AUTO_CREATE_ALLOWED', false, 'Advertising, marketing, lead generation, and promotional spend.', 140),
  ('parking_tolls', 'Parking & Tolls', 'Expense', 'ParkingAndTolls', true, 'AUTO_CREATE_ALLOWED', false, 'Parking lots, meters, toll roads, and toll passes.', 150),
  ('bank_fees', 'Bank Fees', 'Expense', 'BankCharges', true, 'AUTO_CREATE_ALLOWED', false, 'Bank service charges and account fees.', 160),
  ('internet_services', 'Internet Services', 'Expense', 'Utilities', true, 'AUTO_CREATE_ALLOWED', false, 'Internet, broadband, and telecom utility services.', 170),
  ('office_expenses', 'Office Expenses', 'Expense', 'OfficeGeneralAdministrativeExpenses', true, 'AUTO_CREATE_ALLOWED', false, 'General office and administrative expenses.', 180),
  ('shipping', 'Shipping', 'Expense', 'ShippingFreightDelivery', true, 'AUTO_CREATE_ALLOWED', false, 'Shipping, postage, freight, and delivery costs.', 190),
  ('cleaning', 'Cleaning', 'Expense', 'JanitorialExpenses', true, 'AUTO_CREATE_ALLOWED', false, 'Cleaning and janitorial expenses.', 200),
  ('fuel', 'Fuel', 'Expense', 'Auto', true, 'AUTO_CREATE_ALLOWED', false, 'Fuel, gasoline, diesel, and routine charging costs.', 210),
  ('vehicle_expense', 'Vehicle Expense', 'Expense', 'Auto', true, 'AUTO_CREATE_ALLOWED', false, 'Routine auto and vehicle expenses.', 220),
  ('meals', 'Meals', 'Expense', 'MealsEntertainment', true, 'AUTO_CREATE_ALLOWED', false, 'Business meals and food expenses.', 230),
  ('travel', 'Travel', 'Expense', 'Travel', true, 'AUTO_CREATE_ALLOWED', false, 'Travel and lodging expenses.', 240),
  ('airfare', 'Airfare', 'Expense', 'Travel', true, 'AUTO_CREATE_ALLOWED', false, 'Airline and flight expenses.', 250),
  ('transportation', 'Transportation', 'Expense', 'Travel', true, 'AUTO_CREATE_ALLOWED', false, 'Rideshare, taxi, and local transportation costs.', 260),
  ('insurance', 'Insurance', 'Expense', 'Insurance', true, 'AUTO_CREATE_ALLOWED', false, 'Business insurance expenses.', 270),
  ('equipment_rental', 'Equipment Rental', 'Expense', 'EquipmentRental', true, 'AUTO_CREATE_ALLOWED', false, 'Equipment, tool, and jobsite rentals.', 280),
  ('business_licensing_fees', 'Business Licensing Fees', 'Expense', 'TaxesPaid', true, 'AUTO_CREATE_ALLOWED', false, 'Business licenses, permits, filings, and regulatory fees.', 290),
  ('waste_disposal', 'Waste Disposal', 'Expense', 'DisposalFees', true, 'AUTO_CREATE_ALLOWED', false, 'Dump fees, landfill, hauling, trash, and debris disposal.', 300),
  ('uniforms_laundry', 'Uniforms & Laundry', 'Expense', 'Uniforms', true, 'AUTO_CREATE_ALLOWED', false, 'Uniforms, laundry, and workwear.', 310),
  ('safety_ppe', 'Safety & PPE', 'Expense', 'SuppliesMaterials', true, 'AUTO_CREATE_ALLOWED', false, 'Safety gear and personal protective equipment.', 320),
  ('tools_equipment', 'Tools & Equipment', 'Expense', 'ToolsMachinery', true, 'AUTO_CREATE_ALLOWED', false, 'Small tools and non-capital equipment.', 330),
  ('owner_contributions', 'Owner Contributions', 'Equity', 'OwnerEquity', true, 'ACCOUNTANT_REVIEW_REQUIRED', true, 'Owner capital contributions and equity funding.', 900),
  ('owner_distributions', 'Owner Distributions', 'Equity', 'OwnerEquity', true, 'ACCOUNTANT_REVIEW_REQUIRED', true, 'Owner draws, distributions, and equity withdrawals.', 910),
  ('loans_payable', 'Loans Payable', 'Long Term Liability', 'NotesPayable', true, 'ACCOUNTANT_REVIEW_REQUIRED', true, 'Loan principal and note payable obligations.', 920),
  ('fixed_assets', 'Fixed Assets', 'Fixed Asset', 'FixedAssetComputers', true, 'ACCOUNTANT_REVIEW_REQUIRED', true, 'Capitalized fixed assets.', 930),
  ('accumulated_depreciation', 'Accumulated Depreciation', 'Fixed Asset', 'AccumulatedDepreciation', true, 'ACCOUNTANT_REVIEW_REQUIRED', true, 'Contra-asset accumulated depreciation.', 940),
  ('payroll_liabilities', 'Payroll Liabilities', 'Other Current Liability', 'PayrollClearing', true, 'ACCOUNTANT_REVIEW_REQUIRED', true, 'Payroll liabilities and withholding obligations.', 950),
  ('sales_tax_payable', 'Sales Tax Payable', 'Other Current Liability', 'SalesTaxPayable', true, 'ACCOUNTANT_REVIEW_REQUIRED', true, 'Sales tax collected and payable.', 960)
on conflict (canonical_account_key) do update set
  preferred_account_name = excluded.preferred_account_name,
  qbo_account_type = excluded.qbo_account_type,
  qbo_account_subtype = excluded.qbo_account_subtype,
  is_active = excluded.is_active,
  auto_create_policy = excluded.auto_create_policy,
  review_required = excluded.review_required,
  purpose = excluded.purpose,
  sort_order = excluded.sort_order,
  updated_at = now();

insert into public.bizzi_canonical_intent_mappings (intent_key, canonical_account_key) values
  ('sales', 'sales'),
  ('quickbooks_revenue', 'sales'),
  ('invoice_revenue', 'sales'),
  ('other_income', 'other_income'),
  ('cashback', 'other_income'),
  ('cash_back', 'other_income'),
  ('rewards', 'other_income'),
  ('software', 'software'),
  ('subscriptions', 'software'),
  ('subscription', 'software'),
  ('streaming', 'software'),
  ('productivity', 'software'),
  ('construction_ops', 'software'),
  ('electric', 'electric'),
  ('electricity', 'electric'),
  ('electric_utility', 'electric'),
  ('materials', 'materials_supplies'),
  ('supplies', 'materials_supplies'),
  ('general_supplies', 'materials_supplies'),
  ('food_supplies', 'materials_supplies'),
  ('payment_processing', 'payment_processing_fees'),
  ('bank_fees', 'bank_fees'),
  ('advertising', 'advertising_marketing'),
  ('ads', 'advertising_marketing'),
  ('leads', 'advertising_marketing'),
  ('parking_tolls', 'parking_tolls'),
  ('parking', 'parking_tolls'),
  ('parking_toll', 'parking_tolls'),
  ('tolls', 'parking_tolls'),
  ('internet_services', 'internet_services'),
  ('wifi', 'internet_services'),
  ('internet', 'internet_services'),
  ('telecom', 'internet_services'),
  ('utilities_internet', 'internet_services'),
  ('office_supplies', 'office_expenses'),
  ('medical', 'office_expenses'),
  ('training', 'office_expenses'),
  ('shipping', 'shipping'),
  ('postage', 'shipping'),
  ('cleaning', 'cleaning'),
  ('fuel', 'fuel'),
  ('gas_charging', 'fuel'),
  ('ev_charging', 'fuel'),
  ('vehicle_charging', 'fuel'),
  ('vehicle_expense', 'vehicle_expense'),
  ('vehicle_lease', 'vehicle_expense'),
  ('meals', 'meals'),
  ('travel', 'travel'),
  ('lodging', 'travel'),
  ('airfare', 'airfare'),
  ('transportation', 'transportation'),
  ('car_rental', 'travel'),
  ('insurance', 'insurance'),
  ('equipment_rental', 'equipment_rental'),
  ('rentals', 'equipment_rental'),
  ('business_licensing_fees', 'business_licensing_fees'),
  ('business_license', 'business_licensing_fees'),
  ('business_licensing', 'business_licensing_fees'),
  ('licensing_fees', 'business_licensing_fees'),
  ('permits', 'business_licensing_fees'),
  ('permit_fees', 'business_licensing_fees'),
  ('permits_fees', 'business_licensing_fees'),
  ('waste_disposal', 'waste_disposal'),
  ('uniforms_laundry', 'uniforms_laundry'),
  ('safety_ppe', 'safety_ppe'),
  ('tools', 'tools_equipment'),
  ('equipment', 'tools_equipment')
on conflict (intent_key) do update set
  canonical_account_key = excluded.canonical_account_key,
  is_active = true,
  updated_at = now();

insert into public.bizzi_canonical_account_aliases (canonical_account_key, alias_name, alias_kind, is_approved_equivalent) values
  ('software', 'Software', 'approved_equivalent', true),
  ('software', 'Software Expense', 'approved_equivalent', true),
  ('software', 'Software Subscriptions', 'approved_equivalent', true),
  ('electric', 'Electric', 'approved_equivalent', true),
  ('electric', 'Electricity', 'approved_equivalent', true),
  ('materials_supplies', 'Supplies & Materials', 'approved_equivalent', true),
  ('materials_supplies', 'Materials', 'approved_equivalent', true),
  ('materials_supplies', 'Job Materials', 'approved_equivalent', true),
  ('payment_processing_fees', 'Payment Processing Fees', 'approved_equivalent', true),
  ('payment_processing_fees', 'Merchant Fees', 'approved_equivalent', true),
  ('advertising_marketing', 'Advertising & Marketing', 'approved_equivalent', true),
  ('advertising_marketing', 'Advertising', 'approved_equivalent', true),
  ('advertising_marketing', 'Marketing', 'approved_equivalent', true),
  ('parking_tolls', 'Parking & Tolls', 'approved_equivalent', true),
  ('parking_tolls', 'Parking/Tolls', 'approved_equivalent', true),
  ('bank_fees', 'Bank Fees', 'approved_equivalent', true),
  ('bank_fees', 'Bank Charges', 'approved_equivalent', true),
  ('bank_fees', 'Bank Charges & Fees', 'approved_equivalent', true),
  ('internet_services', 'Internet Services', 'approved_equivalent', true),
  ('office_expenses', 'Office Expenses', 'approved_equivalent', true),
  ('shipping', 'Shipping', 'approved_equivalent', true),
  ('cleaning', 'Cleaning', 'approved_equivalent', true),
  ('fuel', 'Fuel', 'approved_equivalent', true),
  ('fuel', 'Gas', 'approved_equivalent', true),
  ('fuel', 'Gas/Charging', 'approved_equivalent', true),
  ('vehicle_expense', 'Vehicle Expense', 'approved_equivalent', true),
  ('meals', 'Meals', 'approved_equivalent', true),
  ('meals', 'Meals & Entertainment', 'approved_equivalent', true),
  ('travel', 'Travel', 'approved_equivalent', true),
  ('airfare', 'Airfare', 'approved_equivalent', true),
  ('transportation', 'Transportation', 'approved_equivalent', true),
  ('insurance', 'Insurance', 'approved_equivalent', true),
  ('equipment_rental', 'Equipment Rental', 'approved_equivalent', true),
  ('business_licensing_fees', 'Business Licensing Fees', 'approved_equivalent', true),
  ('waste_disposal', 'Waste Disposal', 'approved_equivalent', true),
  ('uniforms_laundry', 'Uniforms & Laundry', 'approved_equivalent', true),
  ('safety_ppe', 'Safety & PPE', 'approved_equivalent', true),
  ('tools_equipment', 'Tools & Equipment', 'approved_equivalent', true)
on conflict (canonical_account_key, alias_name) do update set
  alias_kind = excluded.alias_kind,
  is_approved_equivalent = excluded.is_approved_equivalent,
  is_active = true,
  updated_at = now();

create or replace function public.claim_qbo_account_creation_intent(
  p_business_id uuid,
  p_realm_id text,
  p_qbo_env text,
  p_canonical_account_key text,
  p_request_id text,
  p_payload_summary jsonb default null,
  p_transaction_id uuid default null,
  p_intent_key text default null,
  p_now timestamptz default now(),
  p_lease_seconds integer default 600
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.qbo_account_creation_intents;
  v_inserted integer := 0;
begin
  if p_business_id is null or p_canonical_account_key is null then
    raise exception 'missing_account_creation_identity';
  end if;
  if p_realm_id is null or length(trim(p_realm_id)) = 0 then
    raise exception 'missing_qbo_realm_id';
  end if;
  if p_request_id is null or length(trim(p_request_id)) = 0 or length(p_request_id) > 50 then
    raise exception 'invalid_qbo_account_request_id';
  end if;

  insert into public.qbo_account_creation_intents (
    business_id,
    realm_id,
    qbo_env,
    canonical_account_key,
    request_id,
    status,
    attempt_count,
    processing_started_at,
    lease_expires_at,
    last_attempt_at,
    payload_summary,
    first_transaction_id,
    first_intent_key,
    created_at,
    updated_at
  )
  values (
    p_business_id,
    p_realm_id,
    coalesce(p_qbo_env, 'production'),
    p_canonical_account_key,
    p_request_id,
    'processing',
    1,
    p_now,
    p_now + make_interval(secs => p_lease_seconds),
    p_now,
    p_payload_summary,
    p_transaction_id,
    p_intent_key,
    p_now,
    p_now
  )
  on conflict (business_id, qbo_env, realm_id, canonical_account_key) do nothing;
  get diagnostics v_inserted = row_count;

  select *
    into v_row
  from public.qbo_account_creation_intents
  where business_id = p_business_id
    and qbo_env = coalesce(p_qbo_env, 'production')
    and realm_id = p_realm_id
    and canonical_account_key = p_canonical_account_key
  for update;

  if not found then
    raise exception 'account_creation_intent_claim_failed';
  end if;

  if v_row.status in ('created', 'mapped_existing') and v_row.qbo_account_id is not null then
    return jsonb_build_object('claimed', false, 'already_resolved', true, 'intent', to_jsonb(v_row));
  end if;

  if v_inserted > 0 then
    return jsonb_build_object('claimed', true, 'already_resolved', false, 'intent', to_jsonb(v_row));
  end if;

  if v_row.status = 'processing'
     and v_row.lease_expires_at is not null
     and v_row.lease_expires_at > p_now
     and v_row.last_attempt_at is not null
     and v_row.last_attempt_at <> p_now then
    return jsonb_build_object('claimed', false, 'already_resolved', false, 'intent', to_jsonb(v_row));
  end if;

  update public.qbo_account_creation_intents
     set status = 'processing',
         request_id = coalesce(request_id, p_request_id),
         attempt_count = coalesce(attempt_count, 0) + 1,
         processing_started_at = p_now,
         lease_expires_at = p_now + make_interval(secs => p_lease_seconds),
         last_attempt_at = p_now,
         payload_summary = coalesce(payload_summary, p_payload_summary),
         first_transaction_id = coalesce(first_transaction_id, p_transaction_id),
         first_intent_key = coalesce(first_intent_key, p_intent_key),
         updated_at = p_now
   where business_id = p_business_id
     and qbo_env = coalesce(p_qbo_env, 'production')
     and realm_id = p_realm_id
     and canonical_account_key = p_canonical_account_key
     and (request_id is null or request_id = p_request_id)
  returning * into v_row;

  if not found then
    raise exception 'account_creation_request_id_mismatch';
  end if;

  return jsonb_build_object('claimed', true, 'already_resolved', false, 'intent', to_jsonb(v_row));
end;
$$;

revoke all on function public.claim_qbo_account_creation_intent(uuid, text, text, text, text, jsonb, uuid, text, timestamptz, integer) from public;
revoke all on function public.claim_qbo_account_creation_intent(uuid, text, text, text, text, jsonb, uuid, text, timestamptz, integer) from anon;
revoke all on function public.claim_qbo_account_creation_intent(uuid, text, text, text, text, jsonb, uuid, text, timestamptz, integer) from authenticated;
grant execute on function public.claim_qbo_account_creation_intent(uuid, text, text, text, text, jsonb, uuid, text, timestamptz, integer) to service_role;

alter table public.bizzi_canonical_accounts enable row level security;
alter table public.bizzi_canonical_account_aliases enable row level security;
alter table public.bizzi_canonical_intent_mappings enable row level security;
alter table public.qbo_accounts_cache enable row level security;
alter table public.business_canonical_qbo_account_mappings enable row level security;
alter table public.qbo_account_mapping_events enable row level security;
alter table public.qbo_account_creation_intents enable row level security;

revoke all on table public.bizzi_canonical_accounts from public, anon, authenticated;
revoke all on table public.bizzi_canonical_account_aliases from public, anon, authenticated;
revoke all on table public.bizzi_canonical_intent_mappings from public, anon, authenticated;
revoke all on table public.qbo_accounts_cache from public, anon, authenticated;
revoke all on table public.business_canonical_qbo_account_mappings from public, anon, authenticated;
revoke all on table public.qbo_account_mapping_events from public, anon, authenticated;
revoke all on table public.qbo_account_creation_intents from public, anon, authenticated;

grant all on table public.bizzi_canonical_accounts to service_role;
grant all on table public.bizzi_canonical_account_aliases to service_role;
grant all on table public.bizzi_canonical_intent_mappings to service_role;
grant all on table public.qbo_accounts_cache to service_role;
grant all on table public.business_canonical_qbo_account_mappings to service_role;
grant all on table public.qbo_account_mapping_events to service_role;
grant all on table public.qbo_account_creation_intents to service_role;

drop policy if exists "Users can view canonical qbo mappings for their business" on public.business_canonical_qbo_account_mappings;
create policy "Users can view canonical qbo mappings for their business"
on public.business_canonical_qbo_account_mappings
for select
using (
  exists (
    select 1
    from public.user_business_link ubl
    where ubl.business_id = business_canonical_qbo_account_mappings.business_id
      and ubl.user_id = auth.uid()
  )
);

drop policy if exists "Users can view qbo account mapping events for their business" on public.qbo_account_mapping_events;
create policy "Users can view qbo account mapping events for their business"
on public.qbo_account_mapping_events
for select
using (
  exists (
    select 1
    from public.user_business_link ubl
    where ubl.business_id = qbo_account_mapping_events.business_id
      and ubl.user_id = auth.uid()
  )
);
