-- Dormant, local replacement of the rejected uncommitted design.
-- ZERO columns, tables, triggers, advisory locks or data backfills.
-- Future schedules are provisional. Only the policy row is locked; technical
-- predicates use a statement snapshot and MUST be rechecked before QBO writes.
-- Updates still acquire their ordinary categorization/job row locks.
create or replace function public.auto_post_technical_block(
  c public.transaction_categorizations, p_env text default 'production', p_context jsonb default null, p_effective_date date default null
) returns text language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare b public.bank_transactions; p public.business_profiles; q public.quickbooks_tokens; m public.plaid_qbo_account_mappings;
  x jsonb := coalesce(c.meta,'{}'::jsonb); stale text[] := array['missing_posting_schedule','pending_transaction_not_postable','weak_memo_evidence','probable_requires_review','low_classifier_confidence','merchant_ambiguous','no_matching_vendor_rule','automatic_posting_safety_not_established','unsafe_auto_post','auto_post_admission_pending','auto_post_admission_retry'];
begin
  select * into b from public.bank_transactions where business_id=c.business_id and id=c.transaction_id;
  select * into p from public.business_profiles where id=c.business_id;
  if p_context is not null and coalesce(p_context->>'manual','false')<>'true' and not coalesce(p.auto_post_to_quickbooks,false) then return 'auto_post_disabled'; end if;
  if b.id is null then return 'bank_transaction_missing'; end if;
  if c.qbo_txn_id is not null or to_jsonb(c)->>'source_qbo_txn_id' is not null or x->>'source_qbo_txn_id' is not null or c.posted_at is not null or c.posting_status='posted' or c.status='posted' then return 'already_posted'; end if;
  if c.excluded_at is not null or c.status='excluded' or coalesce(c.is_archived,false) or coalesce(b.is_archived,false) then return 'excluded_or_archived'; end if;
  if exists(select 1 from public.bank_qbo_matches r where r.business_id=c.business_id and r.bank_transaction_id=c.transaction_id and r.status='confirmed') then return 'matched_transaction'; end if;
  if c.status='matched_existing_qbo' or x->>'matched_existing_qbo'='true' or x->>'incoming_deposit_match_status'='confirmed' or (x->>'cc_payment_pair_id' is not null and x->>'cc_payment_pair_id' is distinct from p_context->>'pair_id') then return 'matched_transaction'; end if;
  -- Failed decisions belong exclusively to the existing posting retry lifecycle.
  -- Caller-writable history, meta and decided_at never authorize admission.
  if p_context is null and c.status='failed' then return 'failed_requires_existing_retry_workflow'; end if;
  if c.status not in ('approved','auto_approved','handled','failed') then return 'not_handled'; end if;
  if b.pending then return 'pending_transaction_not_postable'; end if;
  if b.accounting_review_required then return 'plaid_accounting_review_required'; end if;
  if b.date is null or b.amount is null or b.amount=0 or b.amount::text in ('NaN','Infinity','-Infinity') then return 'required_financial_data_missing'; end if;
  if (p_context is null and (b.direction is distinct from 'OUTFLOW' or coalesce(x->>'taxonomy_type','')<>'' or x->>'is_check'='true'))
    or (p_context is not null and (b.direction not in ('OUTFLOW','INFLOW') or coalesce(x->>'taxonomy_type','') not in ('','loan_payment','split_transaction','statement_credit','cc_payment'))) then return 'unsupported_transaction_type'; end if;
  if x->>'existing_qbo_match_confirmed'='true' or x->>'qbo_duplicate_detection_confidence'='DETERMINISTIC_EXISTING'
     or exists(select 1 from jsonb_array_elements(case when jsonb_typeof(x->'qbo_duplicate_candidates')='array' then x->'qbo_duplicate_candidates' else '[]'::jsonb end) d where d->>'deterministic'='true') then return 'confirmed_duplicate'; end if;
  if x->>'ambiguous_provider_outcome'='true' then return 'provider_outcome_ambiguous'; end if;
  if p_context is null then
    if exists(select 1 from public.qbo_posted_transactions r where r.business_id=c.business_id and r.transaction_id=c.transaction_id) then return 'existing_provider_intent_or_receipt'; end if;
    if c.last_post_attempt_at is not null or x->>'post_intent_id' is not null or x->>'posting_in_progress'='true'
      or exists(select 1 from public.bookkeeping_post_attempts a where a.business_id=c.business_id and a.transaction_id=c.transaction_id) then return 'prior_posting_evidence'; end if;
  else
    if p_context->>'business_id' is distinct from c.business_id::text
      or p_context->>'transaction_id' is distinct from c.transaction_id::text
      or p_context->>'env' is distinct from p_env then return 'posting_execution_identity_changed'; end if;
    if x->>'posting_generation' is distinct from p_context->>'generation'
      or nullif(x->>'posting_cancelled_at','') is not null
      or x->>'posting_cancelled_at' is distinct from p_context->>'cancelled_at'
      or x->>'posting_in_progress' is distinct from 'true'
      or nullif(p_context->>'lock_started_at','') is null
      or (x->>'posting_started_at')::timestamptz is distinct from (p_context->>'lock_started_at')::timestamptz
      or (x->>'posting_started_at')::timestamptz <= statement_timestamp()-interval '10 minutes'
      or x->>'post_idempotency_key' is distinct from p_context->>'lock_key'
      then return 'posting_execution_cancelled_or_replaced'; end if;
    if coalesce(p_context->>'pair_id','')='' and (not exists(select 1 from public.qbo_posted_transactions r where r.business_id=c.business_id and r.transaction_id=c.transaction_id
      and r.status='processing' and r.qbo_txn_id is null and r.request_id=p_context->>'request_id' and r.idempotency_key=p_context->>'idempotency_key'
      and r.realm_id=p_context->>'realm_id' and r.qbo_env=p_env and r.processing_started_at=(p_context->>'claimed_at')::timestamptz
      and r.lease_expires_at=(p_context->>'lease_expires_at')::timestamptz and r.lease_expires_at>statement_timestamp())
      or nullif(p_context->>'owner','') is null or x->>'posting_execution_owner' is distinct from p_context->>'owner'
      or x->>'posting_execution_request_id' is distinct from p_context->>'request_id' ) then return 'foreign_or_stale_posting_lease'; end if;
    if exists(select 1 from public.qbo_posted_transactions r where r.business_id=c.business_id and r.transaction_id=c.transaction_id and (r.request_id is distinct from p_context->>'request_id' or r.idempotency_key is distinct from p_context->>'idempotency_key' or r.qbo_env is distinct from p_env or r.qbo_txn_id is not null or r.status is distinct from 'processing')) then return 'foreign_or_stale_posting_lease'; end if;
    if exists(select 1 from public.bookkeeping_post_attempts a where a.business_id=c.business_id and a.transaction_id=c.transaction_id
      and a.status='attempted' and (
        a.payload_summary->>'posting_execution_owner' is distinct from p_context->>'owner'
        or a.payload_summary->>'posting_request_id' is distinct from p_context->>'request_id'
        or a.payload_summary->>'posting_claimed_at' is distinct from p_context->>'claimed_at'
        or a.payload_summary->>'posting_generation' is distinct from p_context->>'generation'
        or a.attempted_at<(p_context->>'claimed_at')::timestamptz)
      -- A conclusively rejected old attempt belongs to the existing retry
      -- workflow. An unknown outcome or an unresolved older attempt never does.
      and not (a.attempted_at<(p_context->>'claimed_at')::timestamptz
        and exists(select 1 from public.qbo_posted_transactions r where r.business_id=c.business_id and r.transaction_id=c.transaction_id
          and r.request_id=p_context->>'request_id' and r.response_summary->>'qbo_write_may_have_occurred'='false'
          and r.response_summary->>'posting_claimed_at'=a.payload_summary->>'posting_claimed_at'
          and r.response_summary->>'posting_execution_owner'=a.payload_summary->>'posting_execution_owner'
          and r.response_summary->>'posting_request_id'=a.payload_summary->>'posting_request_id'
          and (r.response_summary->>'rejected_at')::timestamptz>=a.attempted_at)
        and exists(select 1 from public.bookkeeping_post_attempts f where f.business_id=c.business_id and f.transaction_id=c.transaction_id
          and f.status='failed' and f.attempted_at>=a.attempted_at and f.attempted_at<(p_context->>'claimed_at')::timestamptz))) then return 'ambiguous_prior_attempt'; end if;
    if c.final_qbo_account_id is distinct from p_context->>'final_account_id' or b.plaid_account_id is distinct from p_context->>'plaid_account_id'
      or b.date::text is distinct from p_context->>'date' or b.amount is distinct from (p_context->>'amount')::numeric
      or c.post_error is distinct from p_context->>'post_error' then return 'posting_payload_changed'; end if;
    if coalesce(p_context->>'manual','false')<>'true' and c.post_after<=p.auto_post_enabled_at then return 'expired_schedule_requires_review'; end if;
  end if;
  if c.posting_hold_batch_id is not null and not exists(select 1 from public.plaid_recovery_batches r where r.business_id=c.business_id and r.id=c.posting_hold_batch_id and r.posting_hold=false)
    or exists(select 1 from public.plaid_recovery_batch_rows r join public.plaid_recovery_batches h on h.id=r.batch_id and h.business_id=r.business_id where r.business_id=c.business_id and r.admitted_transaction_id=c.transaction_id and h.posting_hold) then return 'recovery_posting_hold'; end if;
  if exists(select 1 from public.monthly_review_runs r where r.business_id=c.business_id and r.review_month=date_trunc('month',b.date)::date and r.status='finalized')
    or exists(select 1 from public.financial_monthly_review_stamps r where r.business_id=c.business_id and r.review_month=date_trunc('month',b.date)::date and r.status in ('completed','closed','finalized'))
    or exists(select 1 from public.accounting_period_closes r where r.business_id=c.business_id and r.period_month=date_trunc('month',b.date)::date and r.is_active and r.status in ('approved','close_requested','refreshing_snapshot','ready_for_approval','reopen_required')) then return 'accounting_period_locked'; end if;
  if b.date<greatest(p.bookkeeping_start_date,coalesce(p_effective_date,p.auto_post_effective_date)) then return 'before_active_books_cutoff'; end if;
  select * into q from public.quickbooks_tokens where business_id=c.business_id and qbo_env=p_env and status='active' and is_active order by created_at desc limit 1;
  if q.id is null then return 'qbo_connection_inactive'; end if;
  if p_context is not null and (q.realm_id is distinct from p_context->>'realm_id' or q.qbo_env is distinct from p_env) then return 'qbo_connection_identity_changed'; end if;
  select * into m from public.plaid_qbo_account_mappings where business_id=c.business_id and plaid_account_id=b.plaid_account_id limit 1;
  if p_context is not null and m.qbo_account_id is distinct from p_context->>'source_account_id' then return 'posting_source_changed'; end if;
  if m.qbo_account_id is null then return 'missing_source_qbo_account'; end if;
  if not exists(select 1 from public.qbo_accounts_cache a where a.business_id=c.business_id and a.qbo_env=p_env and a.realm_id=q.realm_id and a.qbo_account_id=m.qbo_account_id and a.active and a.account_type in ('Bank','Credit Card','CreditCard')) then return 'inactive_source_qbo_account'; end if;
  if c.final_qbo_account_id is null or not exists(select 1 from public.qbo_accounts_cache a where a.business_id=c.business_id and a.qbo_env=p_env and a.realm_id=q.realm_id and a.qbo_account_id=c.final_qbo_account_id and a.active and (p_context is not null or regexp_replace(lower(a.account_type),'[^a-z]','','g') in ('expense','otherexpense','costofgoodssold','othercurrentasset','fixedasset','otherasset'))) then return 'invalid_final_qbo_account'; end if;
  if p_context is null and c.post_error is not null and not(c.post_error=any(stale)) then return case when c.post_error ~ '^[a-z0-9_]{1,80}$' then c.post_error else 'retained_posting_error' end; end if;
  if nullif(x->>'post_block_reason','') is not null and not(x->>'post_block_reason'=any(stale)) then return 'retained_posting_blocker'; end if;
  if nullif(x->>'auto_post_block_reason','') is not null and not(x->>'auto_post_block_reason'=any(stale)) then return 'retained_posting_blocker'; end if;
  return null;
end $$;
-- This namespace has a hard 4096-byte UTF8 budget, four recent whitelisted
-- entries, and saturating summary counters. Unrelated transaction meta is kept.
create or replace function public.auto_post_admission_meta(p_meta jsonb,p_entry jsonb)
returns jsonb language plpgsql immutable set search_path=pg_catalog,public as $$
declare m jsonb:=coalesce(p_meta,'{}'); old jsonb:=coalesce(p_meta->'auto_post_admission','{}'); recent jsonb; e jsonb; n bigint;
begin
  e:=jsonb_build_object('state',case when p_entry->>'state' in ('pending','retry','blocked','scheduled') then p_entry->>'state' else 'blocked' end,
    'source',left(coalesce(p_entry->>'source','handled'),24),'at',left(p_entry->>'at',40),'anchor',left(p_entry->>'anchor',40),
    'reason',case when p_entry->>'reason' ~ '^[a-z0-9_]{1,80}$' then p_entry->>'reason' else null end,
    'previous_safe',case when jsonb_typeof(p_entry->'previous_safe')='boolean' then p_entry->'previous_safe' else 'null'::jsonb end,
    'previous_status',left(p_entry->>'previous_status',24),'previous_error',case when p_entry->>'previous_error' ~ '^[a-z0-9_]{1,80}$' then p_entry->>'previous_error' else null end,
    'actor',left(p_entry->>'actor',36),'manifest',left(p_entry->>'manifest',64));
  -- Re-whitelist even retained entries; malformed/oversize old data cannot grow
  -- this owned namespace. Summaries are counts, never arbitrary reason maps.
  select coalesce(jsonb_agg(v order by ord),'[]') into recent from (
    select v,ord from jsonb_array_elements(case when jsonb_typeof(old->'recent')='array' then old->'recent' else '[]'::jsonb end || jsonb_build_array(e)) with ordinality a(v,ord)
    where octet_length(v::text)<=768 order by ord desc limit 4
  ) r;
  n:=case when old->>'total' ~ '^[0-9]{1,10}$' then least((old->>'total')::bigint,2147483646) else 0 end + 1;
  old:=e||jsonb_build_object('version',2,'recent',recent,'total',n,'older_compacted',greatest(0,n-jsonb_array_length(recent)));
  if octet_length(old::text)>4096 then old:=e||jsonb_build_object('version',2,'recent',jsonb_build_array(e),'total',n,'older_compacted',n-1); end if;
  if octet_length(old::text)>4096 then raise exception 'admission_evidence_budget_exceeded'; end if;
  return jsonb_set(m,'{auto_post_admission}',old,true);
end $$;
-- One transaction, one explicit policy-row lock, no predicate fences or continuation
-- state. Explicit operations evaluate <=2000 rows, otherwise fail before writes.
create or replace function public.admit_handled_auto_post(
 p_business_id uuid,p_enabled boolean default null,p_grace_hours numeric default 24,p_limit integer default 2000,
 p_preview boolean default false,p_ids uuid[] default null,p_preview_hash text default null,p_repair_anchor timestamptz default null,
 p_env text default 'production',p_preview_at timestamptz default null,p_actor uuid default null,p_effective_date date default null,
 p_source text default 'enable'
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare p public.business_profiles; plan jsonb; anchor timestamptz; due timestamptz; fingerprint text; n integer; eligible integer; blocked integer; existing integer; changed integer; expected integer; reasons jsonb; corrected integer;
begin
 if p_business_id is null or p_limit is null or p_limit not between 1 and 2000 or p_grace_hours is null or p_grace_hours<=0 or p_grace_hours>168
   or p_env is null or p_env not in ('production','sandbox') or p_source is null or p_source not in ('enable','handled','settled','repair') or p_preview is null then raise exception 'invalid_admission_parameters'; end if;
 if p_preview then select * into strict p from public.business_profiles where id=p_business_id;
 else select * into strict p from public.business_profiles where id=p_business_id for update; end if;
 if p_ids is not null and (cardinality(p_ids)=0 or cardinality(p_ids)>p_limit or cardinality(p_ids)<>(select count(distinct id) from unnest(p_ids) id)) then raise exception 'invalid_admission_ids'; end if;
 if p_ids is not null and (select count(*) from public.transaction_categorizations where business_id=p_business_id and transaction_id=any(p_ids))<>cardinality(p_ids) then raise exception 'cross_business_or_unknown_ids'; end if;
 if not p_preview and p_enabled=false then
  update public.business_profiles set auto_post_to_quickbooks=false where id=p_business_id returning * into p;
  return jsonb_build_object('ok',true,'enabled',false,'auto_post_to_quickbooks',false,'auto_post_effective_date',p.auto_post_effective_date,'auto_post_scope_mode',p.auto_post_scope_mode,'auto_post_enabled_at',p.auto_post_enabled_at,'state','complete','scheduled',0,'evaluated',0,'already_scheduled',0,'technically_blocked',0,'retryable_failure_count',0);
 end if;
 if p_source in ('handled','settled','repair') and p_ids is null then raise exception 'bounded_ids_required'; end if;
 if p_source='repair' and (p_actor is null or p_repair_anchor is null) then raise exception 'approved_repair_anchor_required'; end if;
 if p_source<>'enable' and not coalesce(p.auto_post_to_quickbooks,false) then
  return jsonb_build_object('ok',true,'enabled',false,'auto_post_to_quickbooks',false,'state','paused','scheduled',0,'evaluated',0,'retryable_failure_count',0);
 end if;
 if p_repair_anchor is not null and (p_repair_anchor<statement_timestamp()-interval '5 minutes' or p_repair_anchor>statement_timestamp()) then raise exception 'repair_anchor_requires_fresh_approval'; end if;
 anchor:=case when p_source='repair' then p_repair_anchor when p_source in ('handled','settled') then statement_timestamp()
   when not coalesce(p.auto_post_to_quickbooks,false) then statement_timestamp() else p.auto_post_enabled_at end;
 due:=anchor+p_grace_hours*interval '1 hour';
 -- Materialize the entire bounded plan against ONE statement snapshot. Later
 -- mapping/hold/period changes are allowed; execution validation is mandatory.
 with candidates as materialized (
  select c.*,public.auto_post_technical_block(c,p_env,null,p_effective_date) as gate_reason,
   encode(sha256(convert_to(to_jsonb(c)::text||coalesce(to_jsonb(b)::text,''),'UTF8')),'hex') as row_hash
  from public.transaction_categorizations c join public.bank_transactions b on b.business_id=c.business_id and b.id=c.transaction_id
  where c.business_id=p_business_id and (p_ids is null or c.transaction_id=any(p_ids))
   and (p_ids is not null or (c.status in ('approved','auto_approved','handled') and c.qbo_txn_id is null and c.posted_at is null))
  order by c.transaction_id limit p_limit+1
 ) select coalesce(jsonb_agg(jsonb_build_object('transaction_id',transaction_id,'updated_at',updated_at,'status',status,'row_hash',row_hash,
   'reason',case when status='failed' then 'failed_requires_existing_retry_workflow' when post_after is not null then 'already_scheduled' else gate_reason end,'post_after',post_after,'previous_safe',meta->'safe_to_auto_post','previous_error',post_error) order by transaction_id),'[]') into plan from candidates;
 n:=jsonb_array_length(plan);
 if n>p_limit then return jsonb_build_object('ok',false,'enabled',p.auto_post_to_quickbooks,'auto_post_to_quickbooks',p.auto_post_to_quickbooks,'state','terminal','error','backlog_limit_exceeded','evaluated',0,'scheduled',0,'retryable_failure_count',0,'limit',p_limit); end if;
 select count(*) filter(where r->>'reason' is null),count(*) filter(where r->>'reason'='already_scheduled'),count(*) filter(where r->>'reason' is not null and r->>'reason'<>'already_scheduled'),
 count(*) filter(where r->>'reason' is null and (r->>'previous_safe' is distinct from 'true' or r->>'previous_error' is not null))
 into eligible,existing,blocked,corrected from jsonb_array_elements(plan) r;
 select coalesce(jsonb_object_agg(reason,count),'{}') into reasons from (select r->>'reason' reason,count(*) from jsonb_array_elements(plan) r where r->>'reason' is not null and r->>'reason'<>'already_scheduled' group by 1) a;
 if p_preview then p_preview_at:=statement_timestamp(); end if;
 fingerprint:=encode(sha256(convert_to(jsonb_build_object('business',p_business_id,'rows',plan,'source',p_source,'anchor',case when p_source='repair' then anchor end,'grace',p_grace_hours,'effective_date',p_effective_date,'env',p_env,'at',p_preview_at,'actor',p_actor)::text,'UTF8')),'hex');
 if p_preview then return jsonb_build_object('ok',true,'state','preview','rows',plan,'preview_hash',fingerprint,'preview_at',p_preview_at,'evaluated',n,'eligible',eligible,'already_scheduled',existing,'technically_blocked',blocked,'reason_counts',reasons,'post_after',due); end if;
 -- Idempotent replay must be the SAME approved manifest, not arbitrary IDs that
 -- happen to have schedules. It never changes an existing deadline.
 if p_source='repair' and existing=n and n>0 and not exists(select 1 from public.transaction_categorizations c where c.business_id=p_business_id and c.transaction_id=any(p_ids) and c.meta#>>'{auto_post_admission,manifest}' is distinct from p_preview_hash) then
  return jsonb_build_object('ok',true,'enabled',true,'auto_post_to_quickbooks',true,'state','complete','evaluated',n,'scheduled',0,'already_scheduled',existing,'technically_blocked',0,'retryable_failure_count',0);
 end if;
 if p_source='repair' or p_effective_date is not null then
  if p_preview_hash is null or p_preview_at is null or p_preview_at<statement_timestamp()-interval '5 minutes' or p_preview_at>statement_timestamp()
    or p_preview_hash is distinct from fingerprint then raise exception 'stale_or_changed_admission_preview'; end if;
 end if;
 if eligible>0 and (anchor is null or due<=statement_timestamp()) then return jsonb_build_object('ok',false,'enabled',p.auto_post_to_quickbooks,'auto_post_to_quickbooks',p.auto_post_to_quickbooks,'state','terminal','error','approved_fresh_repair_anchor_required','scheduled',0,'evaluated',n,'retryable_failure_count',0); end if;
 -- Policy and every evaluated row commit or roll back together. A concurrent
 -- categorization edit causes 40001; only this narrow caller retries the RPC.
 if p_source='enable' then
  update public.business_profiles set auto_post_to_quickbooks=true,auto_post_enabled_at=anchor,
   auto_post_effective_date=coalesce(p_effective_date,case when p.auto_post_to_quickbooks then p.auto_post_effective_date end),auto_post_scope_mode=case when coalesce(p_effective_date,case when p.auto_post_to_quickbooks then p.auto_post_effective_date end) is null then 'new_activity_only' else 'effective_date' end,
   historical_backlog_status='none' where id=p_business_id returning * into p;
 end if;
 select count(*) into expected from jsonb_array_elements(plan) r where r->>'post_after' is null and r->>'status' in ('approved','auto_approved','handled');
 with updates as (
  update public.transaction_categorizations c set
   post_after=case when r->>'reason' is null then due else c.post_after end,
   post_error=case when r->>'reason' is null then null else c.post_error end,
   status=case when r->>'reason' is null and c.status='handled' then 'approved' else c.status end,
   meta=public.auto_post_admission_meta(
    case when r->>'reason' is null then (coalesce(c.meta,'{}')-'post_block_reason'-'auto_post_block_reason'-'pending')||'{"safe_to_auto_post":true}'::jsonb else c.meta end,
    jsonb_build_object('state',case when r->>'reason' is null then 'scheduled' else 'blocked' end,'source',p_source,'at',statement_timestamp(),'anchor',anchor,
      'reason',r->>'reason','previous_safe',c.meta->'safe_to_auto_post','previous_status',c.status,'previous_error',c.post_error,'actor',p_actor,'manifest',p_preview_hash)),
   updated_at=statement_timestamp()
  from jsonb_array_elements(plan) r where c.business_id=p_business_id and c.transaction_id=(r->>'transaction_id')::uuid
   and c.updated_at=(r->>'updated_at')::timestamptz and c.status=r->>'status' and c.post_after is null and c.status in ('approved','auto_approved','handled')
  returning c.transaction_id
 ) select count(*) into changed from updates;
 if changed<>expected then raise exception using errcode='40001',message='admission_snapshot_changed'; end if;
 if exists(select 1 from jsonb_array_elements(plan) r where r->>'reason' is null and not exists(select 1 from public.bookkeeping_posting_jobs j where j.business_id=p_business_id and j.transaction_id=(r->>'transaction_id')::uuid and j.state='scheduled' and j.scheduled_at=due)) then raise exception 'durable_posting_job_missing'; end if;
 return jsonb_build_object('ok',true,'enabled',true,'auto_post_to_quickbooks',true,'auto_post_effective_date',p.auto_post_effective_date,'auto_post_scope_mode',p.auto_post_scope_mode,'auto_post_enabled_at',p.auto_post_enabled_at,'state','complete','event_at',anchor,'post_after',case when eligible>0 then due end,'posting_grace_hours',p_grace_hours,
  'evaluated',n,'scheduled',eligible,'scheduled_backlog_count',eligible,'handled_backlog_count',n,'already_scheduled',existing,'technically_blocked',blocked,'reason_counts',reasons,'stale_state_corrected',corrected,'retryable_failure_count',0);
end $$;
-- Canonical new-decision adapter. Preserve an existing durable deadline under
-- the SAME bank/categorization row locks already used by atomic approval. The
-- old approval RPC stays unchanged and the adapter is dormant until called.
create or replace function public.approve_bookkeeping_with_admission(
 p_business_id uuid,p_actor_id uuid,p_actor_type text,p_approvals jsonb,p_require_needs_review boolean default true
) returns setof public.transaction_categorizations language plpgsql security definer set search_path=pg_catalog,public as $$
declare a jsonb; approvals jsonb:='[]'; current_row public.transaction_categorizations;
begin
 if jsonb_typeof(p_approvals) is distinct from 'array' or jsonb_array_length(p_approvals) not between 1 and 2000 then raise exception 'bounded_approvals_required'; end if;
 for a in select value from jsonb_array_elements(p_approvals) order by value->>'transaction_id' loop
  perform 1 from public.bank_transactions where business_id=p_business_id and id=(a->>'transaction_id')::uuid for update;
  if not found then raise exception 'approval_transaction_not_found'; end if;
  select * into current_row from public.transaction_categorizations where business_id=p_business_id and transaction_id=(a->>'transaction_id')::uuid for update;
  if a->>'status'='failed' then
   a:=jsonb_set(a,'{post_after}',coalesce(to_jsonb(current_row.post_after),'null'::jsonb));
   a:=jsonb_set(a,'{meta}',(coalesce(a->'meta','{}')-'auto_post_admission')||case when current_row.meta ? 'auto_post_admission' then jsonb_build_object('auto_post_admission',current_row.meta->'auto_post_admission') else '{}'::jsonb end);
  end if;
  if current_row.post_after is not null then
   a:=jsonb_set(a,'{post_after}',to_jsonb(current_row.post_after));
   a:=jsonb_set(a,'{meta}',(coalesce(a->'meta','{}')-'auto_post_admission')||case when current_row.meta ? 'auto_post_admission' then jsonb_build_object('auto_post_admission',current_row.meta->'auto_post_admission') else '{}'::jsonb end);
  end if;
  approvals:=approvals||jsonb_build_array(a);
 end loop;
 return query select * from public.approve_bookkeeping_transactions_atomic(p_business_id,p_actor_id,p_actor_type,approvals,p_require_needs_review);
end $$;
create or replace function public.check_auto_post_technical_integrity(p_business_id uuid,p_transaction_id uuid,p_env text default 'production',p_context jsonb default null)
returns text language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare c public.transaction_categorizations; pair public.credit_card_payment_pairs; leg uuid; b public.bank_transactions; ctx jsonb; reason text;
begin
 if p_context is null then return 'posting_execution_identity_required'; end if;
 if p_context->>'business_id' is distinct from p_business_id::text
   or p_context->>'transaction_id' is distinct from p_transaction_id::text
   or p_context->>'env' is distinct from p_env then return 'posting_execution_identity_changed'; end if;
 if nullif(p_context->>'pair_id','') is not null then
  select * into pair from public.credit_card_payment_pairs where business_id=p_business_id and id=(p_context->>'pair_id')::uuid;
  if pair.id is null or pair.status<>'posting' or pair.qbo_txn_id is not null or pair.request_id is distinct from p_context->>'request_id'
   or pair.idempotency_key is distinct from p_context->>'idempotency_key' or pair.posting_started_at is distinct from (p_context->>'claimed_at')::timestamptz
   or pair.lease_expires_at is distinct from (p_context->>'lease_expires_at')::timestamptz or not(pair.lease_expires_at>statement_timestamp())
   or p_transaction_id not in (pair.checking_transaction_id,pair.credit_card_transaction_id) then return 'foreign_or_stale_posting_lease'; end if;
  if pair.checking_qbo_account_id is distinct from p_context->>'from_account_id' or pair.credit_card_qbo_account_id is distinct from p_context->>'to_account_id'
   or pair.amount is distinct from (p_context->>'pair_amount')::numeric or pair.payment_date::text is distinct from p_context->>'pair_date' then return 'posting_payload_changed'; end if;
  foreach leg in array array[pair.checking_transaction_id,pair.credit_card_transaction_id] loop
   select * into c from public.transaction_categorizations where business_id=p_business_id and transaction_id=leg;
   select * into b from public.bank_transactions where business_id=p_business_id and id=leg;
   if c.transaction_id is null or b.id is null then return 'bank_transaction_missing'; end if;
   if abs(b.amount) is distinct from pair.amount or (leg=pair.checking_transaction_id and b.date is distinct from pair.payment_date) then return 'posting_payload_changed'; end if;
   if c.meta->>'posting_execution_owner' is distinct from p_context->>'owner' or c.meta->>'posting_execution_request_id' is distinct from p_context->>'request_id' or nullif(p_context->>'owner','') is null then return 'foreign_or_stale_posting_lease'; end if;
   if exists(select 1 from public.qbo_posted_transactions r where r.business_id=p_business_id and r.transaction_id=leg) then return 'existing_provider_intent_or_receipt'; end if;
   select p_context||v||jsonb_build_object('business_id',p_business_id,'transaction_id',leg,'final_account_id',c.final_qbo_account_id,'source_account_id',case when leg=pair.checking_transaction_id then pair.checking_qbo_account_id else pair.credit_card_qbo_account_id end) into ctx from jsonb_array_elements(p_context->'legs') v where v->>'id'=leg::text;
   if ctx is null then return 'posting_payload_changed'; end if;
   reason:=public.auto_post_technical_block(c,p_env,ctx,null);
   if reason is not null then return reason; end if;
  end loop;
  return null;
 end if;
 select * into c from public.transaction_categorizations where business_id=p_business_id and transaction_id=p_transaction_id;
 if c.transaction_id is null then return 'bank_transaction_missing'; end if;
 return public.auto_post_technical_block(c,p_env,p_context,null);
end $$;
do $$ declare f regprocedure; begin
 for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('auto_post_technical_block','auto_post_admission_meta','admit_handled_auto_post','check_auto_post_technical_integrity','approve_bookkeeping_with_admission') loop
  execute format('alter function %s owner to postgres',f);
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
  if f::text like '%approve_bookkeeping_with_admission(%' or f::text like '%admit_handled_auto_post(%' or f::text like '%check_auto_post_technical_integrity(%' then execute format('grant execute on function %s to service_role',f); end if;
 end loop;
end $$;
notify pgrst,'reload schema';
