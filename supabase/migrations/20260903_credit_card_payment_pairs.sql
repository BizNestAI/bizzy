-- Durable canonical credit-card-payment pairs.
-- A checking outflow and card inflow are two Plaid legs of one balance-sheet transfer.

create table if not exists public.credit_card_payment_pairs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  checking_transaction_id uuid not null references public.bank_transactions(id) on delete restrict,
  credit_card_transaction_id uuid references public.bank_transactions(id) on delete restrict,
  checking_plaid_account_id text not null,
  credit_card_plaid_account_id text,
  checking_qbo_account_id text not null,
  checking_qbo_account_name text,
  credit_card_qbo_account_id text not null,
  credit_card_qbo_account_name text,
  amount numeric(14,2) not null check (amount > 0),
  payment_date date,
  matched_date date,
  status text not null default 'needs_review'
    check (status in ('needs_review', 'confirmed', 'posting', 'posted', 'failed', 'voided')),
  match_confidence text not null default 'manual'
    check (match_confidence in ('manual', 'high', 'ambiguous', 'low')),
  match_evidence jsonb not null default '{}'::jsonb,
  request_id text,
  idempotency_key text,
  posting_started_at timestamptz,
  lease_expires_at timestamptz,
  last_post_attempt_at timestamptz,
  post_error text,
  qbo_txn_id text,
  qbo_txn_type text,
  qbo_sync_token text,
  posted_at timestamptz,
  created_by text not null default 'bizzi',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint credit_card_payment_pairs_distinct_legs
    check (credit_card_transaction_id is null or checking_transaction_id <> credit_card_transaction_id),
  constraint credit_card_payment_pairs_qbo_type
    check (qbo_txn_type is null or qbo_txn_type = 'Transfer')
);

create unique index if not exists credit_card_payment_pairs_active_checking_uq
  on public.credit_card_payment_pairs (business_id, checking_transaction_id)
  where status <> 'voided';

create unique index if not exists credit_card_payment_pairs_active_card_uq
  on public.credit_card_payment_pairs (business_id, credit_card_transaction_id)
  where credit_card_transaction_id is not null and status <> 'voided';

create unique index if not exists credit_card_payment_pairs_request_uq
  on public.credit_card_payment_pairs (business_id, request_id)
  where request_id is not null;

create index if not exists credit_card_payment_pairs_business_status_idx
  on public.credit_card_payment_pairs (business_id, status, updated_at);

create or replace function public.validate_credit_card_payment_pair_business()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_checking_business_id uuid;
  v_card_business_id uuid;
begin
  select business_id
    into v_checking_business_id
  from public.bank_transactions
  where id = new.checking_transaction_id;

  if v_checking_business_id is distinct from new.business_id then
    raise exception 'credit_card_payment_pair_checking_business_mismatch';
  end if;

  if new.credit_card_transaction_id is not null then
    select business_id
      into v_card_business_id
    from public.bank_transactions
    where id = new.credit_card_transaction_id;

    if v_card_business_id is distinct from new.business_id then
      raise exception 'credit_card_payment_pair_card_business_mismatch';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists validate_credit_card_payment_pair_business_trg on public.credit_card_payment_pairs;
create trigger validate_credit_card_payment_pair_business_trg
before insert or update of business_id, checking_transaction_id, credit_card_transaction_id
on public.credit_card_payment_pairs
for each row execute function public.validate_credit_card_payment_pair_business();

create or replace function public.claim_credit_card_payment_pair_posting(
  p_business_id uuid,
  p_pair_id uuid,
  p_request_id text,
  p_idempotency_key text,
  p_now timestamptz default now(),
  p_lease_seconds integer default 600
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.credit_card_payment_pairs;
begin
  if p_business_id is null or p_pair_id is null then
    raise exception 'missing_cc_payment_pair_identity';
  end if;
  if p_request_id is null or length(trim(p_request_id)) = 0 or length(p_request_id) > 50 then
    raise exception 'invalid_cc_payment_pair_request_id';
  end if;

  select *
    into v_row
  from public.credit_card_payment_pairs
  where business_id = p_business_id
    and id = p_pair_id
  for update;

  if not found then
    raise exception 'cc_payment_pair_not_found';
  end if;

  if v_row.status = 'posted' and v_row.qbo_txn_id is not null then
    return jsonb_build_object('claimed', false, 'already_posted', true, 'pair', to_jsonb(v_row));
  end if;

  if v_row.status = 'posting'
     and v_row.lease_expires_at is not null
     and v_row.lease_expires_at > p_now
     and coalesce(v_row.request_id, p_request_id) = p_request_id then
    return jsonb_build_object('claimed', false, 'already_posted', false, 'pair', to_jsonb(v_row));
  end if;

  update public.credit_card_payment_pairs
     set status = 'posting',
         request_id = coalesce(request_id, p_request_id),
         idempotency_key = coalesce(idempotency_key, p_idempotency_key),
         posting_started_at = p_now,
         lease_expires_at = p_now + make_interval(secs => greatest(coalesce(p_lease_seconds, 600), 1)),
         last_post_attempt_at = p_now,
         updated_at = p_now
   where business_id = p_business_id
     and id = p_pair_id
     and (request_id is null or request_id = p_request_id)
  returning * into v_row;

  if not found then
    raise exception 'cc_payment_pair_request_id_mismatch';
  end if;

  return jsonb_build_object('claimed', true, 'already_posted', false, 'pair', to_jsonb(v_row));
end;
$$;

revoke all on function public.claim_credit_card_payment_pair_posting(uuid, uuid, text, text, timestamptz, integer) from public;
revoke all on function public.claim_credit_card_payment_pair_posting(uuid, uuid, text, text, timestamptz, integer) from anon;
revoke all on function public.claim_credit_card_payment_pair_posting(uuid, uuid, text, text, timestamptz, integer) from authenticated;
grant execute on function public.claim_credit_card_payment_pair_posting(uuid, uuid, text, text, timestamptz, integer) to service_role;
