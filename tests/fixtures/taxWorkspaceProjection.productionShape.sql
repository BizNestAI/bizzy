-- Deterministic, synthetic Tax workspace fixture. Disposable test databases only.
-- No production descriptions, provider payloads, tokens, or customer data.
begin;

insert into auth.users(id) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
on conflict do nothing;

insert into public.user_profiles(id,email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','fixture-a@example.invalid'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','fixture-b@example.invalid')
on conflict do nothing;

insert into public.business_profiles(id,user_id,business_name,industry,team_size,state,services_offered) values
  ('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Synthetic Tax Fixture A','trades',5,'NC','synthetic validation'),
  ('22222222-2222-4222-8222-222222222222','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Synthetic Tax Fixture B','trades',3,'TX','synthetic validation')
on conflict do nothing;

insert into public.user_business_link(user_id,business_id,role) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','owner'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','22222222-2222-4222-8222-222222222222','owner')
on conflict do nothing;

insert into public.business_billing(business_id,subscription_status,subscription_status_test) values
  ('11111111-1111-4111-8111-111111111111','active','active'),
  ('22222222-2222-4222-8222-222222222222','active','active')
on conflict (business_id) do update set subscription_status_test='active';

insert into public.qbo_accounts_cache(business_id,realm_id,qbo_env,qbo_account_id,name,account_type,account_subtype,active,raw)
values
  ('11111111-1111-4111-8111-111111111111','fixture-realm-a','production','expense-main','Software','Expense','DuesSubscriptions',true,'{}'),
  ('11111111-1111-4111-8111-111111111111','fixture-realm-a','production','meal-1','Meals Team','Expense','MealsEntertainment',true,'{}'),
  ('11111111-1111-4111-8111-111111111111','fixture-realm-a','production','meal-2','Meals Travel','Expense','MealsEntertainment',true,'{}'),
  ('11111111-1111-4111-8111-111111111111','fixture-realm-a','production','meal-3','Meals Clients','Expense','MealsEntertainment',true,'{}'),
  ('11111111-1111-4111-8111-111111111111','fixture-realm-a','production','meal-4','Meals Field','Expense','MealsEntertainment',true,'{}'),
  ('11111111-1111-4111-8111-111111111111','fixture-realm-a','production','utility-1','Electric','Expense','Utilities',true,'{}'),
  ('11111111-1111-4111-8111-111111111111','fixture-realm-a','production','utility-2','Internet','Expense','Utilities',true,'{}'),
  ('11111111-1111-4111-8111-111111111111','fixture-realm-a','production','utility-3','Mobile Phone','Expense','Utilities',true,'{}'),
  ('11111111-1111-4111-8111-111111111111','fixture-realm-a','production','vehicle-1','Vehicle Fuel','Expense','Auto',true,'{}'),
  ('11111111-1111-4111-8111-111111111111','fixture-realm-a','production','income-1','Service Income','Income','ServiceFeeIncome',true,'{}'),
  ('11111111-1111-4111-8111-111111111111','fixture-realm-a','production','bank-1','Operating Bank','Bank','Checking',true,'{}'),
  ('11111111-1111-4111-8111-111111111111','fixture-realm-a','production','equity-1','Owner Draw','Equity','OwnerEquity',true,'{}'),
  ('11111111-1111-4111-8111-111111111111','fixture-realm-a','production','asset-1','Equipment Asset','Fixed Asset','FixedAssetComputers',true,'{}'),
  ('11111111-1111-4111-8111-111111111111','fixture-realm-a','production','refund-1','Supplies Refund','Expense','SuppliesMaterials',true,'{}')
on conflict do nothing;

with source as (
  select g,
    ('00000000-0000-4000-8000-' || lpad(g::text,12,'0'))::uuid transaction_id,
    make_date(2026,((g-1)%12)+1,least(28,((g-1)%27)+1)) transaction_date,
    case when g between 690 and 694 then 'income-1'
         when g between 695 and 698 then 'bank-1'
         when g between 699 and 702 then 'equity-1'
         when g between 703 and 706 then 'asset-1'
         when g between 707 and 710 then 'refund-1'
         when g between 711 and 713 then 'missing-account'
         when g=1 then 'meal-1' when g=2 then 'meal-2' when g=3 then 'meal-3' when g=4 then 'meal-4'
         when g=5 then 'utility-1' when g=6 then 'utility-2' when g=7 then 'utility-3'
         when g=8 then 'vehicle-1' else 'expense-main' end account_id,
    case when g between 690 and 694 or g between 707 and 710 then 100::numeric else -100::numeric end signed_amount
  from generate_series(1,713) g
)
insert into public.bank_transactions(
  id,business_id,plaid_item_id,plaid_account_id,plaid_transaction_id,pending,date,name,merchant_name,
  amount,signed_amount,direction,is_archived,raw
)
select transaction_id,'11111111-1111-4111-8111-111111111111','synthetic-item','synthetic-account',
  'synthetic-'||g,false,transaction_date,'Synthetic transaction '||g,'Synthetic merchant '||((g-1)%20+1),
  abs(signed_amount),signed_amount,case when signed_amount>0 then 'INFLOW' else 'OUTFLOW' end,false,null
from source;

with source as (
  select g,('00000000-0000-4000-8000-' || lpad(g::text,12,'0'))::uuid transaction_id,
    make_date(2026,((g-1)%12)+1,least(28,((g-1)%27)+1)) transaction_date,
    case when g between 690 and 694 then 'income-1' when g between 695 and 698 then 'bank-1'
         when g between 699 and 702 then 'equity-1' when g between 703 and 706 then 'asset-1'
         when g between 707 and 710 then 'refund-1' when g between 711 and 713 then 'missing-account'
         when g=1 then 'meal-1' when g=2 then 'meal-2' when g=3 then 'meal-3' when g=4 then 'meal-4'
         when g=5 then 'utility-1' when g=6 then 'utility-2' when g=7 then 'utility-3'
         when g=8 then 'vehicle-1' else 'expense-main' end account_id,
    case when g between 690 and 694 then 'Service Income' when g between 695 and 698 then 'Operating Bank'
         when g between 699 and 702 then 'Owner Draw' when g between 703 and 706 then 'Equipment Asset'
         when g between 707 and 710 then 'Supplies Refund' when g between 711 and 713 then 'Missing Account'
         when g between 1 and 4 then 'Meals '||g when g=5 then 'Electric' when g=6 then 'Internet'
         when g=7 then 'Mobile Phone' when g=8 then 'Vehicle Fuel' else 'Software' end account_name,
    case when g between 690 and 694 or g between 707 and 710 then 100::numeric else -100::numeric end signed_amount
  from generate_series(1,713) g
)
insert into public.transaction_categorizations(
  business_id,transaction_id,status,final_qbo_account_id,final_qbo_account_name,decided_by,decided_at,
  qbo_txn_id,qbo_txn_type,posted_at,txn_date,txn_name,signed_amount,is_archived,meta
)
select '11111111-1111-4111-8111-111111111111',transaction_id,'posted',account_id,account_name,'bizzi',now(),
  'qbo-'||g,case when g between 695 and 698 then 'Transfer' when g between 707 and 710 then 'RefundReceipt' else 'Purchase' end,
  now(),transaction_date,'Synthetic transaction '||g,signed_amount,false,'{}'
from source;

insert into public.qbo_posted_transactions(
  business_id,transaction_id,qbo_env,realm_id,qbo_txn_type,qbo_txn_id,status,posted_at,payload,response
)
select '11111111-1111-4111-8111-111111111111',
  ('00000000-0000-4000-8000-' || lpad(g::text,12,'0'))::uuid,'production','fixture-realm-a',
  case when g between 695 and 698 then 'Transfer' when g between 707 and 710 then 'RefundReceipt' else 'Purchase' end,
  'qbo-'||g,'posted',now(),null,null
from generate_series(1,713) g;

with source as (
  select g,('00000000-0000-4000-8000-' || lpad(g::text,12,'0'))::uuid transaction_id,
    make_date(2026,((g-1)%12)+1,least(28,((g-1)%27)+1)) transaction_date,
    case when g between 690 and 713 then 'outside_deductions'
         when g between 1 and 4 then 'business_meals'
         when g between 5 and 7 then 'utilities'
         when g=8 then 'vehicle_expenses'
         else 'software_subscriptions' end tax_category,
    case when g between 690 and 694 then 'income-1' when g between 695 and 698 then 'bank-1'
         when g between 699 and 702 then 'equity-1' when g between 703 and 706 then 'asset-1'
         when g between 707 and 710 then 'refund-1' when g between 711 and 713 then 'missing-account'
         when g=1 then 'meal-1' when g=2 then 'meal-2' when g=3 then 'meal-3' when g=4 then 'meal-4'
         when g=5 then 'utility-1' when g=6 then 'utility-2' when g=7 then 'utility-3'
         when g=8 then 'vehicle-1' else 'expense-main' end account_id
  from generate_series(1,713) g
)
insert into public.transaction_tax_classifications(
  business_id,transaction_id,tax_year,transaction_date,source_qbo_txn_id,source_qbo_txn_type,
  source_qbo_account_id,source_qbo_account_name,tax_category,deductibility_status,deductible_percent,
  book_amount,deductible_amount,nondeductible_amount,capitalizable_amount,tax_treatment,
  classification_status,confidence_score,reason,source,user_override,cpa_override,metadata,
  confidence_level,rule_code,rule_version,rule_priority,requires_review
)
select '11111111-1111-4111-8111-111111111111',transaction_id,2026,transaction_date,'qbo-'||g,
  case when g between 695 and 698 then 'Transfer' when g between 707 and 710 then 'RefundReceipt' else 'Purchase' end,
  account_id,case when g between 1 and 4 then 'Meals '||g when g=5 then 'Electric' when g=6 then 'Internet'
    when g=7 then 'Mobile Phone' when g=8 then 'Vehicle Fuel' else account_id end,
  tax_category,case when g between 1 and 8 then 'needs_review' when g between 690 and 713 then 'nondeductible' else 'fully_deductible' end,
  case when g between 1 and 8 or g between 690 and 713 then 0 else 100 end,
  case when g between 690 and 694 or g between 707 and 710 then 100 else -100 end,
  case when g between 9 and 689 then 100 else 0 end,
  case when g between 690 and 713 then 100 else 0 end,0,
  jsonb_build_object('type',case when g=8 then 'vehicle_review' when g between 5 and 7 then 'utilities_review' when g between 1 and 4 then 'meals_review' else 'standard' end),
  case when g between 1 and 8 then 'needs_review' when g between 9 and 50 then 'user_confirmed'
       when g between 51 and 689 then 'auto_classified' else 'excluded' end,
  case when g between 1 and 8 then 70 else 95 end,'Synthetic deterministic classification',
  case when g between 9 and 50 then 'user' else 'rule_engine' end,g between 9 and 50,false,
  jsonb_build_object('fixture',true,'requires_review',g between 1 and 8),
  case when g between 1 and 8 then 'medium' else 'high' end,
  case when g=8 then 'vehicle_review' when g between 5 and 7 then 'utilities_review'
       when g between 1 and 4 then 'meals_review' else 'synthetic_standard_rule' end,
  'fixture-rule-v1',100,g between 1 and 8
from source;

commit;
