-- Durable, operator-audited resolution for Plaid authorizations that never
-- receive a normal pending-to-posted mutation. No data is backfilled.

alter table public.bank_transactions
  add column if not exists pending_resolution_state text,
  add column if not exists pending_resolution_payload jsonb not null default '{}'::jsonb,
  add column if not exists pending_resolved_at timestamptz,
  add column if not exists pending_resolved_by uuid;

alter table public.bank_transactions drop constraint if exists bank_transactions_pending_resolution_state_check;
alter table public.bank_transactions add constraint bank_transactions_pending_resolution_state_check check (
  pending_resolution_state is null or pending_resolution_state in (
    'recent_pending','stale_pending_check_required','posted_replacement_found',
    'authorization_expired_or_removed','operator_settlement_confirmation_required',
    'promoted_to_settled','excluded_pending_authorization','linked_to_posted_replacement'
  )
);

create table if not exists public.pending_transaction_resolution_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  transaction_id uuid not null references public.bank_transactions(id) on delete cascade,
  action text not null,
  prior_state text,
  resulting_state text not null,
  actor_user_id uuid,
  actor_label text,
  reason text,
  evidence jsonb not null default '{}'::jsonb,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (business_id, idempotency_key)
);

create index if not exists pending_resolution_events_transaction_idx
  on public.pending_transaction_resolution_events (business_id, transaction_id, created_at desc);
alter table public.pending_transaction_resolution_events enable row level security;
revoke all on public.pending_transaction_resolution_events from public, anon, authenticated;
grant select, insert on public.pending_transaction_resolution_events to service_role;

create or replace function public.confirm_pending_transaction_settled(
  p_business_id uuid, p_transaction_id uuid, p_actor_user_id uuid,
  p_actor_label text, p_statement_date date, p_statement_amount numeric,
  p_reason text, p_idempotency_key text, p_decision_version integer default 1
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_bank public.bank_transactions%rowtype; v_cat public.transaction_categorizations%rowtype; v_now timestamptz:=now(); v_existing jsonb;
begin
  select * into v_bank from public.bank_transactions where business_id=p_business_id and id=p_transaction_id for update;
  if not found then raise exception 'transaction_not_found'; end if;
  select * into v_cat from public.transaction_categorizations where business_id=p_business_id and transaction_id=p_transaction_id for update;
  if v_bank.pending is not true and v_bank.pending_resolution_state <> 'promoted_to_settled' then raise exception 'transaction_not_pending'; end if;
  if v_cat.qbo_txn_id is not null or v_cat.posted_at is not null or v_cat.reconciled_at is not null or v_cat.status in ('posted','matched','matched_existing_qbo') then raise exception 'transaction_already_accounted'; end if;
  if v_cat.posting_status='posting' or coalesce((v_cat.meta->>'posting_in_progress')::boolean,false) then raise exception 'posting_in_progress'; end if;
  if p_actor_user_id is null or p_statement_date is null or p_statement_amount is null or nullif(trim(p_reason),'') is null then raise exception 'settlement_attestation_incomplete'; end if;
  if round(abs(p_statement_amount)::numeric,2) <> round(abs(v_bank.amount)::numeric,2) then raise exception 'statement_amount_mismatch'; end if;
  if exists (select 1 from public.bank_transactions r where r.business_id=p_business_id and r.is_archived=false and r.pending is not true and r.pending_transaction_id=v_bank.plaid_transaction_id and r.id<>v_bank.id) then raise exception 'posted_replacement_exists'; end if;
  select jsonb_build_object('state',resulting_state,'created_at',created_at) into v_existing from public.pending_transaction_resolution_events where business_id=p_business_id and idempotency_key=p_idempotency_key;
  if v_existing is not null then return v_existing || jsonb_build_object('idempotent',true); end if;
  update public.bank_transactions set pending=false, pending_resolution_state='promoted_to_settled', pending_resolved_at=v_now,
    pending_resolved_by=p_actor_user_id, pending_resolution_payload=jsonb_build_object(
      'original_pending',true,'original_plaid_transaction_id',v_bank.plaid_transaction_id,'original_pending_transaction_id',v_bank.pending_transaction_id,
      'statement_confirmed_date',p_statement_date,'statement_confirmed_amount',p_statement_amount,'reason',p_reason,
      'decision_version',p_decision_version,'confirmed_at',v_now,'confirmed_by',p_actor_user_id
    ), accounting_review_required=true, accounting_review_reason='operator_confirmed_settlement'
    where business_id=p_business_id and id=p_transaction_id;
  insert into public.transaction_categorizations (business_id,transaction_id,status,review_status,posting_status,meta,post_after,updated_at)
    values (p_business_id,p_transaction_id,'needs_review','needs_review','not_scheduled',jsonb_build_object('pending_resolution_state','promoted_to_settled','operator_settlement_confirmation',jsonb_build_object('actor_user_id',p_actor_user_id,'actor_label',p_actor_label,'statement_date',p_statement_date,'statement_amount',p_statement_amount,'reason',p_reason,'decision_version',p_decision_version,'confirmed_at',v_now)),null,v_now)
    on conflict (business_id,transaction_id) do update set status='needs_review',review_status='needs_review',posting_status='not_scheduled',post_after=null,
      meta=coalesce(public.transaction_categorizations.meta,'{}'::jsonb)||excluded.meta,updated_at=v_now;
  insert into public.pending_transaction_resolution_events (business_id,transaction_id,action,prior_state,resulting_state,actor_user_id,actor_label,reason,evidence,idempotency_key)
    values (p_business_id,p_transaction_id,'confirm_settled_from_statement',coalesce(v_bank.pending_resolution_state,'stale_pending_check_required'),'promoted_to_settled',p_actor_user_id,p_actor_label,p_reason,
      jsonb_build_object('statement_date',p_statement_date,'statement_amount',p_statement_amount,'provider_write',false,'qbo_write',false,'decision_version',p_decision_version),p_idempotency_key);
  return jsonb_build_object('idempotent',false,'state','promoted_to_settled','transaction_id',p_transaction_id);
end $$;

create or replace function public.link_pending_transaction_replacement(
  p_business_id uuid, p_transaction_id uuid, p_replacement_transaction_id uuid,
  p_actor_user_id uuid, p_actor_label text, p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_pending public.bank_transactions%rowtype; v_replacement public.bank_transactions%rowtype; v_existing jsonb;
begin
  select * into v_pending from public.bank_transactions where business_id=p_business_id and id=p_transaction_id for update;
  select * into v_replacement from public.bank_transactions where business_id=p_business_id and id=p_replacement_transaction_id for update;
  if v_pending.id is null or v_replacement.id is null then raise exception 'transaction_not_found'; end if;
  if v_pending.pending is not true or v_replacement.pending is true or v_replacement.pending_transaction_id is distinct from v_pending.plaid_transaction_id then raise exception 'replacement_not_verified'; end if;
  select jsonb_build_object('state',resulting_state,'created_at',created_at) into v_existing from public.pending_transaction_resolution_events where business_id=p_business_id and idempotency_key=p_idempotency_key;
  if v_existing is not null then return v_existing || jsonb_build_object('idempotent',true); end if;
  update public.bank_transactions set is_archived=true,archived_at=now(),archived_reason='linked_to_posted_replacement',pending_resolution_state='linked_to_posted_replacement',pending_resolved_at=now(),pending_resolved_by=p_actor_user_id,
    pending_resolution_payload=coalesce(pending_resolution_payload,'{}'::jsonb)||jsonb_build_object('replacement_transaction_id',v_replacement.id,'replacement_plaid_transaction_id',v_replacement.plaid_transaction_id)
    where id=v_pending.id and business_id=p_business_id;
  insert into public.pending_transaction_resolution_events (business_id,transaction_id,action,prior_state,resulting_state,actor_user_id,actor_label,evidence,idempotency_key)
    values (p_business_id,v_pending.id,'use_posted_replacement',coalesce(v_pending.pending_resolution_state,'posted_replacement_found'),'linked_to_posted_replacement',p_actor_user_id,p_actor_label,jsonb_build_object('replacement_transaction_id',v_replacement.id),p_idempotency_key);
  return jsonb_build_object('idempotent',false,'state','linked_to_posted_replacement','replacement_transaction_id',v_replacement.id);
end $$;

revoke all on function public.confirm_pending_transaction_settled(uuid,uuid,uuid,text,date,numeric,text,text,integer) from public,anon,authenticated;
revoke all on function public.link_pending_transaction_replacement(uuid,uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.confirm_pending_transaction_settled(uuid,uuid,uuid,text,date,numeric,text,text,integer) to service_role;
grant execute on function public.link_pending_transaction_replacement(uuid,uuid,uuid,uuid,text,text) to service_role;
notify pgrst, 'reload schema';
