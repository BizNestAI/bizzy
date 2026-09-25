-- Durable, exact-transaction exclusion. This migration performs no backfill and
-- changes no existing transaction lifecycle state.

alter table public.transaction_categorizations
  add column if not exists excluded_at timestamptz,
  add column if not exists excluded_by text,
  add column if not exists exclusion_reason text,
  add column if not exists exclusion_source text,
  add column if not exists pre_exclusion_lifecycle text,
  add column if not exists exclusion_version integer not null default 0,
  add column if not exists exclusion_snapshot jsonb;

create table if not exists public.bookkeeping_exclusion_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  transaction_id uuid not null references public.bank_transactions(id) on delete cascade,
  connected_account_id text,
  event_type text not null check (event_type in (
    'exclusion_requested','exclusion_completed','exclusion_rejected_concurrent_processing',
    'restored','pending_transaction_replaced','finalized_replacement_reopened'
  )),
  actor text,
  prior_lifecycle text,
  resulting_lifecycle text,
  reason text,
  correlation_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists bookkeeping_exclusion_events_transaction_idx
  on public.bookkeeping_exclusion_events (business_id, transaction_id, created_at desc);

alter table public.bookkeeping_exclusion_events enable row level security;
revoke all on public.bookkeeping_exclusion_events from anon, authenticated;
grant select, insert on public.bookkeeping_exclusion_events to service_role;

create or replace function public.exclude_bookkeeping_transaction(
  p_business_id uuid,
  p_transaction_id uuid,
  p_actor text,
  p_reason text default null,
  p_source text default 'books_review',
  p_correlation_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bank public.bank_transactions%rowtype;
  v_cat public.transaction_categorizations%rowtype;
  v_prior text;
  v_now timestamptz := now();
  v_meta jsonb;
begin
  select * into v_bank from public.bank_transactions
   where business_id = p_business_id and id = p_transaction_id and is_archived is false
   for update;
  if not found then raise exception 'transaction_not_found'; end if;

  insert into public.bookkeeping_exclusion_events (
    business_id, transaction_id, connected_account_id, event_type, actor, reason, correlation_id
  ) values (p_business_id, p_transaction_id, v_bank.plaid_account_id, 'exclusion_requested', p_actor, p_reason, p_correlation_id);

  select * into v_cat from public.transaction_categorizations
   where business_id = p_business_id and transaction_id = p_transaction_id
   for update;

  if v_cat.status = 'excluded' and v_cat.excluded_at is not null then
    return jsonb_build_object('idempotent', true, 'primary_feed', 'excluded', 'excluded_at', v_cat.excluded_at);
  end if;

  if v_cat.qbo_txn_id is not null or v_cat.posted_at is not null or v_cat.status = 'posted' then
    insert into public.bookkeeping_exclusion_events (business_id,transaction_id,connected_account_id,event_type,actor,prior_lifecycle,resulting_lifecycle,reason,correlation_id)
    values (p_business_id,p_transaction_id,v_bank.plaid_account_id,'exclusion_rejected_concurrent_processing',p_actor,'posted','posted','authoritative_qbo_receipt',p_correlation_id);
    raise exception 'transaction_already_posted';
  end if;
  if coalesce((v_cat.meta ->> 'posting_in_progress')::boolean, false) or v_cat.posting_status = 'posting' then
    insert into public.bookkeeping_exclusion_events (business_id,transaction_id,connected_account_id,event_type,actor,prior_lifecycle,resulting_lifecycle,reason,correlation_id)
    values (p_business_id,p_transaction_id,v_bank.plaid_account_id,'exclusion_rejected_concurrent_processing',p_actor,v_cat.status,v_cat.status,'posting_in_progress',p_correlation_id);
    raise exception 'posting_in_progress';
  end if;
  if v_cat.status in ('matched','matched_existing_qbo')
     or v_cat.meta ->> 'incoming_deposit_match_status' = 'confirmed'
     or (v_cat.meta ->> 'cc_payment_pair_id' is not null and v_cat.meta ->> 'cc_payment_pair_status' in ('confirmed','matched','posted')) then
    raise exception 'transaction_already_matched';
  end if;

  v_prior := case when v_bank.pending then 'pending' else coalesce(v_cat.status, 'needs_review') end;
  v_meta := coalesce(v_cat.meta, '{}'::jsonb) || jsonb_build_object(
    'excluded_at', v_now, 'excluded_by', p_actor, 'exclusion_reason', p_reason,
    'exclusion_source', p_source, 'pre_exclusion_lifecycle', v_prior,
    'exclusion_correlation_id', p_correlation_id,
    'exclusion_snapshot', jsonb_build_object('pending',v_bank.pending,'amount',v_bank.amount,'date',v_bank.date,'memo',v_bank.name,'provider_transaction_id',v_bank.plaid_transaction_id,'prior_status',v_cat.status,'prior_posting_status',v_cat.posting_status)
  );

  insert into public.transaction_categorizations (
    business_id, transaction_id, status, review_status, posting_status, meta,
    excluded_at, excluded_by, exclusion_reason, exclusion_source,
    pre_exclusion_lifecycle, exclusion_version, exclusion_snapshot,
    post_after, updated_at
  ) values (
    p_business_id, p_transaction_id, 'excluded', 'handled', 'not_scheduled', v_meta,
    v_now, p_actor, p_reason, p_source, v_prior, 1,
    jsonb_build_object('pending',v_bank.pending,'amount',v_bank.amount,'date',v_bank.date,'memo',v_bank.name,'provider_transaction_id',v_bank.plaid_transaction_id,'prior_status',v_cat.status,'prior_posting_status',v_cat.posting_status),
    null, v_now
  ) on conflict (business_id, transaction_id) do update set
    status='excluded', review_status='handled', posting_status='not_scheduled', meta=excluded.meta,
    excluded_at=excluded.excluded_at, excluded_by=excluded.excluded_by,
    exclusion_reason=excluded.exclusion_reason, exclusion_source=excluded.exclusion_source,
    pre_exclusion_lifecycle=excluded.pre_exclusion_lifecycle,
    exclusion_version=public.transaction_categorizations.exclusion_version + 1,
    exclusion_snapshot=excluded.exclusion_snapshot, post_after=null, updated_at=v_now;

  insert into public.bookkeeping_exclusion_events (business_id,transaction_id,connected_account_id,event_type,actor,prior_lifecycle,resulting_lifecycle,reason,correlation_id)
  values (p_business_id,p_transaction_id,v_bank.plaid_account_id,'exclusion_completed',p_actor,v_prior,'excluded',p_reason,p_correlation_id);
  return jsonb_build_object('idempotent',false,'primary_feed','excluded','excluded_at',v_now,'previous_feed',v_prior);
end;
$$;

create or replace function public.restore_bookkeeping_transaction(
  p_business_id uuid,
  p_transaction_id uuid,
  p_actor text,
  p_source text default 'books_review',
  p_correlation_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bank public.bank_transactions%rowtype;
  v_cat public.transaction_categorizations%rowtype;
  v_destination text;
  v_status text;
  v_meta jsonb;
begin
  select * into v_bank from public.bank_transactions where business_id=p_business_id and id=p_transaction_id and is_archived is false for update;
  if not found then raise exception 'transaction_not_found'; end if;
  select * into v_cat from public.transaction_categorizations where business_id=p_business_id and transaction_id=p_transaction_id for update;
  if not found or v_cat.excluded_at is null then
    return jsonb_build_object('idempotent',true,'primary_feed',case when v_bank.pending then 'pending' else 'needs_review' end);
  end if;

  v_destination := case
    when v_bank.pending then 'pending'
    when v_cat.qbo_txn_id is not null or v_cat.posted_at is not null then 'posted'
    when v_cat.meta ->> 'incoming_deposit_match_status'='confirmed' then 'matched'
    when v_cat.pre_exclusion_lifecycle in ('approved','auto_approved','handled','failed') and v_cat.final_qbo_account_id is not null then 'handled'
    else 'needs_review' end;
  v_status := case v_destination when 'posted' then 'posted' when 'matched' then 'matched_existing_qbo' when 'handled' then coalesce(nullif(v_cat.exclusion_snapshot->>'prior_status',''),'approved') else 'needs_review' end;
  v_meta := coalesce(v_cat.meta,'{}'::jsonb) - 'excluded_at' - 'excluded_by' - 'exclusion_reason' - 'exclusion_source' - 'pre_exclusion_lifecycle' - 'exclusion_correlation_id';

  update public.transaction_categorizations set status=v_status,
    review_status=case when v_destination in ('handled','posted','matched') then 'handled' else 'needs_review' end,
    posting_status=case when v_destination='posted' then 'posted' else 'not_scheduled' end,
    meta=v_meta, excluded_at=null, excluded_by=null, exclusion_reason=null,
    exclusion_source=null, pre_exclusion_lifecycle=null, post_after=null, updated_at=now()
  where business_id=p_business_id and transaction_id=p_transaction_id;

  insert into public.bookkeeping_exclusion_events (business_id,transaction_id,connected_account_id,event_type,actor,prior_lifecycle,resulting_lifecycle,reason,correlation_id)
  values (p_business_id,p_transaction_id,v_bank.plaid_account_id,'restored',p_actor,'excluded',v_destination,p_source,p_correlation_id);
  return jsonb_build_object('idempotent',false,'primary_feed',v_destination);
end;
$$;

-- Extend the canonical predicate without changing its public signature.
create or replace function public.bookkeeping_transaction_matches_status(p_status_filter text,p_status text,p_meta jsonb,p_qbo_txn_id text)
returns boolean language sql stable set search_path=public as $$
  select case lower(coalesce(p_status_filter, 'needs_review'))
    when 'approved' then public.classify_bookkeeping_primary_feed(false,p_status,null,null,p_meta,p_qbo_txn_id,null,null)='handled'
    when 'handled' then public.classify_bookkeeping_primary_feed(false,p_status,null,null,p_meta,p_qbo_txn_id,null,null)='handled'
    when 'reconciled' then public.classify_bookkeeping_primary_feed(false,p_status,null,null,p_meta,p_qbo_txn_id,null,null) in ('matched','posted')
    when 'matched' then public.classify_bookkeeping_primary_feed(false,p_status,null,null,p_meta,p_qbo_txn_id,null,null)='matched'
    when 'posted' then public.classify_bookkeeping_primary_feed(false,p_status,null,null,p_meta,p_qbo_txn_id,null,null)='posted'
    when 'excluded' then public.classify_bookkeeping_primary_feed(false,p_status,null,null,p_meta,p_qbo_txn_id,null,null)='excluded'
    when 'pending' then false
    else public.classify_bookkeeping_primary_feed(false,p_status,null,null,p_meta,p_qbo_txn_id,null,null)='needs_review'
  end;
$$;

-- Patch both bounded RPC definitions in place so pending exclusions are removed
-- before count/offset/limit and Excluded may include an originally pending row.
do $$
declare v_oid oid; v_def text;
begin
  for v_oid in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('get_bookkeeping_transactions_bounded','count_bookkeeping_transactions_bounded')
  loop
    v_def := pg_get_functiondef(v_oid);
    v_def := replace(v_def, 'and cr.pending is true', 'and cr.pending is true and coalesce(cr.cat_status, '''') <> ''excluded'' and cr.cat_meta ->> ''excluded_at'' is null');
    v_def := replace(v_def, 'and cr.pending is not true', 'and (cr.pending is not true or lower(coalesce(p_status_filter, '''')) = ''excluded'')');
    execute v_def;
  end loop;
end $$;

revoke all on function public.exclude_bookkeeping_transaction(uuid,uuid,text,text,text,text) from public,anon,authenticated;
revoke all on function public.restore_bookkeeping_transaction(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.exclude_bookkeeping_transaction(uuid,uuid,text,text,text,text) to service_role;
grant execute on function public.restore_bookkeeping_transaction(uuid,uuid,text,text,text) to service_role;
notify pgrst, 'reload schema';
