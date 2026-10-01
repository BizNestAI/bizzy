-- READ ONLY. Run before the entitlement/provider integrity migrations.
-- No repair is attempted because provider ownership cannot be inferred safely.
begin transaction read only;

select 'duplicate_live_subscription' as finding, stripe_subscription_id_live as provider_id,
       count(*) as row_count, array_agg(business_id order by business_id) as business_ids
from public.business_billing where stripe_subscription_id_live is not null
group by stripe_subscription_id_live having count(*) > 1;

select 'duplicate_test_subscription' as finding, stripe_subscription_id_test as provider_id,
       count(*) as row_count, array_agg(business_id order by business_id) as business_ids
from public.business_billing where stripe_subscription_id_test is not null
group by stripe_subscription_id_test having count(*) > 1;

select 'duplicate_legacy_subscription' as finding, stripe_subscription_id as provider_id,
       count(*) as row_count, array_agg(business_id order by business_id) as business_ids
from public.business_billing where stripe_subscription_id is not null
group by stripe_subscription_id having count(*) > 1;

select 'legacy_live_cross_business_subscription' as finding,
       legacy.stripe_subscription_id as provider_id,
       legacy.business_id as legacy_business_id,
       canonical.business_id as canonical_business_id
from public.business_billing legacy
join public.business_billing canonical
  on canonical.stripe_subscription_id_live = legacy.stripe_subscription_id
 and canonical.business_id <> legacy.business_id
where legacy.stripe_subscription_id is not null;

select 'legacy_test_cross_business_subscription' as finding,
       legacy.stripe_subscription_id as provider_id,
       legacy.business_id as legacy_business_id,
       canonical.business_id as canonical_business_id
from public.business_billing legacy
join public.business_billing canonical
  on canonical.stripe_subscription_id_test = legacy.stripe_subscription_id
 and canonical.business_id <> legacy.business_id
where legacy.stripe_subscription_id is not null;

select 'legacy_canonical_identity_mismatch' as finding, business_id,
       stripe_subscription_id, stripe_subscription_id_live, stripe_subscription_id_test
from public.business_billing
where stripe_subscription_id is not null
  and ((stripe_subscription_id_live is not null and stripe_subscription_id_live <> stripe_subscription_id)
    or (stripe_subscription_id_test is not null and stripe_subscription_id_test <> stripe_subscription_id));

select 'malformed_status' as finding, business_id, subscription_status,
       subscription_status_live, subscription_status_test
from public.business_billing
where coalesce(subscription_status, 'free') not in ('free','trialing','active','past_due','canceled','unpaid','incomplete','incomplete_expired')
   or (subscription_status_live is not null and subscription_status_live not in ('free','trialing','active','past_due','canceled','unpaid','incomplete','incomplete_expired'))
   or (subscription_status_test is not null and subscription_status_test not in ('free','trialing','active','past_due','canceled','unpaid','incomplete','incomplete_expired'));

select 'multiple_owned_businesses' as finding, user_id, count(*) as business_count,
       array_agg(id order by id) as business_ids
from public.business_profiles where user_id is not null
group by user_id having count(*) > 1;

select 'orphaned_billing_row' as finding, bb.business_id
from public.business_billing bb
left join public.business_profiles bp on bp.id = bb.business_id
where bp.id is null;

select 'duplicate_membership' as finding, user_id, business_id, count(*) as row_count
from public.user_business_link
where user_id is not null and business_id is not null
group by user_id, business_id having count(*) > 1;

select 'plaid_item_cross_business' as finding, coalesce(plaid_env, 'production') as plaid_env,
       plaid_item_id, count(distinct business_id) as business_count,
       array_agg(distinct business_id order by business_id) as business_ids
from public.plaid_items where is_active is true and plaid_item_id is not null
group by coalesce(plaid_env, 'production'), plaid_item_id
having count(distinct business_id) > 1;

select 'plaid_environment_missing' as finding, 'plaid_items' as table_name, id,
       business_id, plaid_item_id
from public.plaid_items where plaid_env is null
union all
select 'plaid_environment_missing', 'plaid_accounts', id, business_id, plaid_item_id
from public.plaid_accounts where plaid_env is null;

select 'plaid_account_without_matching_item' as finding, pa.id, pa.business_id,
       pa.plaid_env, pa.plaid_item_id, pa.plaid_account_id
from public.plaid_accounts pa
left join public.plaid_items pi
  on pi.business_id = pa.business_id
 and coalesce(pi.plaid_env, 'production') = coalesce(pa.plaid_env, 'production')
 and pi.plaid_item_id = pa.plaid_item_id
where pi.id is null;

rollback;
