-- Apply only after audit_matched_feed_cardinality has reported no unresolved
-- duplicate active pairs or multi-pair legs. This changes constraints only and
-- never changes Plaid transactions, pair lifecycle state, or QuickBooks data.

create unique index if not exists credit_card_payment_pairs_active_normalized_pair_uq
  on public.credit_card_payment_pairs (
    business_id,
    least(checking_transaction_id, credit_card_transaction_id),
    greatest(checking_transaction_id, credit_card_transaction_id)
  )
  where credit_card_transaction_id is not null and status <> 'voided';

create unique index if not exists credit_card_payment_pairs_idempotency_uq
  on public.credit_card_payment_pairs (business_id, idempotency_key)
  where idempotency_key is not null;

-- Cover the cross-role hole left by per-column unique indexes. Advisory locks
-- make concurrent inserts involving either transaction serialize safely.
create or replace function public.enforce_active_credit_card_payment_pair_membership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_left uuid;
  v_right uuid;
begin
  if new.status = 'voided' or new.credit_card_transaction_id is null then
    return new;
  end if;
  v_left := least(new.checking_transaction_id, new.credit_card_transaction_id);
  v_right := greatest(new.checking_transaction_id, new.credit_card_transaction_id);
  perform pg_advisory_xact_lock(hashtextextended(new.business_id::text || ':' || v_left::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(new.business_id::text || ':' || v_right::text, 0));
  if exists (
    select 1 from public.credit_card_payment_pairs p
    where p.business_id = new.business_id and p.status <> 'voided'
      and p.id is distinct from new.id
      and (
        p.checking_transaction_id in (new.checking_transaction_id, new.credit_card_transaction_id)
        or p.credit_card_transaction_id in (new.checking_transaction_id, new.credit_card_transaction_id)
      )
  ) then
    raise exception 'credit_card_payment_pair_leg_already_consumed';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_active_credit_card_payment_pair_membership_trg
  on public.credit_card_payment_pairs;
create trigger enforce_active_credit_card_payment_pair_membership_trg
before insert or update of business_id, checking_transaction_id, credit_card_transaction_id, status
on public.credit_card_payment_pairs
for each row execute function public.enforce_active_credit_card_payment_pair_membership();
