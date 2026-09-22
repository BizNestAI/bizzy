-- READ ONLY. Identifies partial, conflicting, or posting-eligible active pairs.
with active_pairs as (
  select * from public.credit_card_payment_pairs where status <> 'voided'
), pair_state as (
  select p.*,
    cc.status as checking_status, cc.post_after as checking_post_after, cc.meta as checking_meta,
    card.status as card_status, card.post_after as card_post_after, card.meta as card_meta
  from active_pairs p
  left join public.transaction_categorizations cc
    on cc.business_id=p.business_id and cc.transaction_id=p.checking_transaction_id
  left join public.transaction_categorizations card
    on card.business_id=p.business_id and card.transaction_id=p.credit_card_transaction_id
), memberships as (
  select business_id, transaction_id, count(*) as active_pair_count
  from (
    select business_id, checking_transaction_id as transaction_id from active_pairs
    union all
    select business_id, credit_card_transaction_id from active_pairs where credit_card_transaction_id is not null
  ) legs group by business_id, transaction_id having count(*) > 1
)
select ps.business_id, ps.id as pair_id, ps.checking_transaction_id, ps.credit_card_transaction_id,
  ps.status as pair_status, ps.checking_status, ps.card_status,
  case
    when (ps.checking_status='matched') <> (ps.card_status='matched') then 'one_leg_matched'
    when ps.credit_card_transaction_id is null or ps.checking_status is null or ps.card_status is null then 'missing_leg'
    when ps.checking_meta->>'cc_payment_pair_txn_id' is distinct from ps.credit_card_transaction_id::text
      or ps.card_meta->>'cc_payment_pair_txn_id' is distinct from ps.checking_transaction_id::text then 'reciprocal_reference_mismatch'
    when ps.checking_meta->>'cc_payment_pair_id' is distinct from ps.id::text
      or ps.card_meta->>'cc_payment_pair_id' is distinct from ps.id::text then 'pair_membership_mismatch'
    when ps.checking_post_after is not null or ps.card_post_after is not null
      or coalesce((ps.checking_meta->>'safe_to_auto_post')::boolean,false)
      or coalesce((ps.card_meta->>'safe_to_auto_post')::boolean,false) then 'leg_still_posting_eligible'
    when exists (select 1 from memberships m where m.business_id=ps.business_id
      and m.transaction_id in (ps.checking_transaction_id,ps.credit_card_transaction_id)) then 'multiple_active_pairs'
  end as anomaly
from pair_state ps
where (ps.checking_status='matched') <> (ps.card_status='matched')
   or ps.credit_card_transaction_id is null or ps.checking_status is null or ps.card_status is null
   or ps.checking_meta->>'cc_payment_pair_txn_id' is distinct from ps.credit_card_transaction_id::text
   or ps.card_meta->>'cc_payment_pair_txn_id' is distinct from ps.checking_transaction_id::text
   or ps.checking_meta->>'cc_payment_pair_id' is distinct from ps.id::text
   or ps.card_meta->>'cc_payment_pair_id' is distinct from ps.id::text
   or ps.checking_post_after is not null or ps.card_post_after is not null
   or coalesce((ps.checking_meta->>'safe_to_auto_post')::boolean,false)
   or coalesce((ps.card_meta->>'safe_to_auto_post')::boolean,false)
   or exists (select 1 from memberships m where m.business_id=ps.business_id
     and m.transaction_id in (ps.checking_transaction_id,ps.credit_card_transaction_id))
order by ps.business_id, ps.updated_at desc;
