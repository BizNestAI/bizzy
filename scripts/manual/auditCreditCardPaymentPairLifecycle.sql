-- READ ONLY. Schema/migration facts needed before repairing any payment pair.
select pg_get_constraintdef(c.oid) as transaction_categorizations_status_check
from pg_constraint c
join pg_class t on t.oid = c.conrelid
join pg_namespace n on n.oid = t.relnamespace
where n.nspname = 'public'
  and t.relname = 'transaction_categorizations'
  and c.conname = 'transaction_categorizations_status_check';

select status, count(*) from public.transaction_categorizations group by status order by status;

select to_jsonb(tc)->>'review_status' as review_status, count(*)
from public.transaction_categorizations tc
group by to_jsonb(tc)->>'review_status' order by review_status;

select to_jsonb(tc)->>'posting_status' as posting_status, count(*)
from public.transaction_categorizations tc
group by to_jsonb(tc)->>'posting_status' order by posting_status;

select version, to_jsonb(sm)->>'name' as name
from supabase_migrations.schema_migrations sm
where version in ('20260903', '20260922', '20260922143000', '20261010')
   or lower(coalesce(to_jsonb(sm)->>'name', '')) like '%credit_card_payment%'
   or lower(coalesce(to_jsonb(sm)->>'name', '')) like '%bookkeeping_review_posting%'
order by version;

-- Confirmed pair metadata whose review lifecycle is still open.
select tc.business_id, tc.transaction_id, tc.status,
       to_jsonb(tc)->>'review_status' as review_status,
       to_jsonb(tc)->>'posting_status' as posting_status,
       tc.meta->>'cc_payment_pair_id' as pair_id
from public.transaction_categorizations tc
where tc.meta->>'cc_payment_pair_status' in ('confirmed', 'posting', 'failed')
  and (tc.status in ('needs_review', 'uncategorized') or to_jsonb(tc)->>'review_status' = 'needs_review');

-- READ ONLY. Identifies partial, conflicting, or posting-eligible active pairs.
with active_pairs as (
  select * from public.credit_card_payment_pairs where status <> 'voided'
), pair_state as (
  select p.*,
    cc.status as checking_status, to_jsonb(cc)->>'review_status' as checking_review_status,
    to_jsonb(cc)->>'posting_status' as checking_posting_status, cc.post_after as checking_post_after, cc.meta as checking_meta,
    card.status as card_status, to_jsonb(card)->>'review_status' as card_review_status,
    to_jsonb(card)->>'posting_status' as card_posting_status, card.post_after as card_post_after, card.meta as card_meta
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
    when (ps.checking_review_status='handled') <> (ps.card_review_status='handled') then 'one_leg_handled'
    when ps.credit_card_transaction_id is null or ps.checking_status is null or ps.card_status is null then 'missing_leg'
    when ps.checking_meta->>'cc_payment_pair_txn_id' is distinct from ps.credit_card_transaction_id::text
      or ps.card_meta->>'cc_payment_pair_txn_id' is distinct from ps.checking_transaction_id::text then 'reciprocal_reference_mismatch'
    when ps.checking_meta->>'cc_payment_pair_id' is distinct from ps.id::text
      or ps.card_meta->>'cc_payment_pair_id' is distinct from ps.id::text then 'pair_membership_mismatch'
    when ps.checking_post_after is not null or ps.card_post_after is not null
      or ps.checking_posting_status in ('scheduled','posting')
      or ps.card_posting_status in ('scheduled','posting')
      or coalesce((ps.checking_meta->>'safe_to_auto_post')::boolean,false)
      or coalesce((ps.card_meta->>'safe_to_auto_post')::boolean,false) then 'leg_still_posting_eligible'
    when exists (select 1 from memberships m where m.business_id=ps.business_id
      and m.transaction_id in (ps.checking_transaction_id,ps.credit_card_transaction_id)) then 'multiple_active_pairs'
  end as anomaly
from pair_state ps
where (ps.checking_review_status='handled') <> (ps.card_review_status='handled')
   or ps.credit_card_transaction_id is null or ps.checking_status is null or ps.card_status is null
   or ps.checking_meta->>'cc_payment_pair_txn_id' is distinct from ps.credit_card_transaction_id::text
   or ps.card_meta->>'cc_payment_pair_txn_id' is distinct from ps.checking_transaction_id::text
   or ps.checking_meta->>'cc_payment_pair_id' is distinct from ps.id::text
   or ps.card_meta->>'cc_payment_pair_id' is distinct from ps.id::text
   or ps.checking_post_after is not null or ps.card_post_after is not null
   or ps.checking_posting_status in ('scheduled','posting')
   or ps.card_posting_status in ('scheduled','posting')
   or coalesce((ps.checking_meta->>'safe_to_auto_post')::boolean,false)
   or coalesce((ps.card_meta->>'safe_to_auto_post')::boolean,false)
   or exists (select 1 from memberships m where m.business_id=ps.business_id
     and m.transaction_id in (ps.checking_transaction_id,ps.credit_card_transaction_id))
order by ps.business_id, ps.updated_at desc;
