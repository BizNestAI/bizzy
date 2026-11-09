-- Derived facts and residual recovery use existing authoritative tables.
-- No historical data repair, provider request, worker or QBO write is executed.
create or replace function public.classify_plaid_account_recovery_rows(
  p_business_id uuid, p_plaid_env text, p_plaid_account_id text
) returns table(transaction_id uuid, initial_target boolean, classification text, evidence_version text)
language sql stable security definer set search_path = pg_catalog, public as $$
  select bt.id,
    not bt.is_archived and tc.id is null and r.id is null,
    case
      when bt.is_archived or bt.archived_reason is not null then 'protected_removed_transaction'
      when r.status = 'processing' and r.locked_at>now()-interval '10 minutes' then 'active_processing_lease'
      when r.status = 'processing' then 'stale_processing_lease'
      when r.status = 'dead_letter' then 'unresolved_dead_letter'
      when tc.status in ('matched','matched_existing_qbo') or tc.reconciled_at is not null then 'existing_match'
      when q.id is not null or tc.qbo_txn_id is not null or tc.posted_at is not null then 'existing_posting_intent_or_receipt'
      when tc.status in ('excluded','ignored','approved','auto_approved','handled','posted') then 'completed_decision'
      when bt.pending then 'pending_transaction'
      when bt.accounting_review_reason ilike '%duplicate%'
        or tc.meta->>'possible_qbo_duplicate' = 'true'
        or bt.raw->>'possible_qbo_duplicate' = 'true' then 'possible_qbo_duplicate'
      when bt.accounting_review_required or tc.accounting_review_required then 'manual_review_required'
      when bt.direction is distinct from 'OUTFLOW' or bt.check_number is not null
        or coalesce(bt.transaction_type,'') ~* '(transfer|refund|payroll|tax|loan|payment)'
        or coalesce(bt.name,'') ~* '(\m(transfer|payroll|loan|refund|autopay)\M|DEPOSIT INTUIT|TRAN FEE INTUIT)'
        or coalesce(bt.raw->>'source','plaid') ~* '(csv|manual)'
        or bt.plaid_transaction_id is null then 'protected_workflow'
      when tc.id is not null then 'existing_categorization'
      when r.id is not null then 'existing_processing_admission'
      else 'eligible_residual_orphan'
    end,
    encode(sha256(convert_to(jsonb_build_array(to_jsonb(bt), to_jsonb(tc), to_jsonb(r), to_jsonb(q))::text, 'UTF8')), 'hex')
  from public.bank_transactions bt
  join public.plaid_accounts a on a.business_id = bt.business_id and a.plaid_env = bt.plaid_env
    and a.plaid_account_id = bt.plaid_account_id
  left join public.transaction_categorizations tc on tc.business_id = bt.business_id and tc.transaction_id = bt.id
  left join public.bookkeeping_processing_requests r on r.business_id = bt.business_id and r.transaction_id = bt.id
  left join public.qbo_posted_transactions q on q.business_id = bt.business_id and q.transaction_id = bt.id
  where bt.business_id = p_business_id and bt.plaid_env = p_plaid_env and bt.plaid_account_id = p_plaid_account_id;
$$;

create or replace function public.get_plaid_account_recovery_facts(p_business_id uuid, p_plaid_env text, p_qbo_env text default 'production')
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
  a record; i public.plaid_items%rowtype; latest jsonb; successful jsonb;
  metrics jsonb; accounts jsonb := '[]';
  token_status text; token_at timestamptz; token_active boolean; token_connected_at timestamptz; policy boolean;
begin
  select auto_post_to_quickbooks into policy from public.business_profiles where id = p_business_id;
  select status, disconnected_at,is_active,coalesce(last_connected_at,created_at) into token_status, token_at,token_active,token_connected_at
    from public.quickbooks_tokens where business_id = p_business_id and qbo_env = p_qbo_env
    order by created_at desc limit 1;
  for a in select * from public.plaid_accounts where business_id = p_business_id and plaid_env = p_plaid_env order by id loop
    select * into i from public.plaid_items where business_id = p_business_id and plaid_env = p_plaid_env
      and plaid_item_id = a.plaid_item_id;
    select jsonb_build_object('id',id,'status',status,'started_at',started_at,'finished_at',finished_at,
      'failure_code',failure_code,'stage',meta->>'failure_stage','database_stage',meta->>'database_stage',
      'source_error_code',meta->>'source_error_code','reason',meta->>'reason') into latest
      from public.bank_sync_runs where business_id = p_business_id and plaid_item_id = a.plaid_item_id
      order by started_at desc, id desc limit 1;
    select jsonb_build_object('id',id,'started_at',started_at,'finished_at',finished_at) into successful
      from public.bank_sync_runs where business_id = p_business_id and plaid_item_id = a.plaid_item_id
        and status = 'completed' order by finished_at desc, id desc limit 1;
    select jsonb_build_object(
      'active_count', count(*), 'first_transaction_date', min(bt.date), 'latest_transaction_date', max(bt.date),
      'last_persisted_at', max(bt.created_at), 'last_mutation_at',max(bt.updated_at), 'last_observed_at',max(bt.last_seen_at),
      'missing_categorization',count(*) filter(where tc.id is null),
      'missing_processing_admission',count(*) filter(where r.id is null),
      'missing_both',count(*) filter(where tc.id is null and r.id is null),
      'required_processing_admission_missing',count(*) filter(where r.id is null and (tc.id is null or tc.status in ('needs_review','uncategorized','failed'))),
      'processing_count',count(*) filter(where r.status in ('pending','processing','failed') and (tc.id is null or tc.status in ('needs_review','uncategorized','failed'))),
      'active_lease_count',count(*) filter(where r.status = 'processing' and r.locked_at>now()-interval '10 minutes' and (tc.id is null or tc.status in ('needs_review','uncategorized','failed'))),
      'stale_lease_count',count(*) filter(where r.status='processing' and (r.locked_at is null or r.locked_at<=now()-interval '10 minutes') and (tc.id is null or tc.status in ('needs_review','uncategorized','failed'))),
      'dead_letter_count',count(*) filter(where r.status = 'dead_letter' and (tc.id is null or tc.status in ('needs_review','uncategorized','failed'))),
      'automation_failed_count',count(*) filter(where r.status in ('failed','dead_letter') and (tc.id is null or tc.status in ('needs_review','uncategorized','failed'))),
      'automation_due_count',count(*) filter(where r.status in ('pending','failed') and r.attempt_count<r.max_attempts and greatest(r.process_after,coalesce(r.blocked_until,r.process_after))<=now()),
      'review_count',count(*) filter(where (tc.status in ('needs_review','uncategorized') or (bt.accounting_review_required and coalesce(tc.status,'') not in ('excluded','ignored'))) and not bt.pending),
      'automation_last_attempt_at',max(coalesce(r.locked_at,r.processed_at,case when r.attempt_count>0 then r.updated_at end)),
      'automation_last_success_at',max(r.processed_at) filter(where r.status in ('completed','skipped')),
      'automation_error_at',max(r.updated_at) filter(where r.status in ('failed','dead_letter')),
      'automation_retry_candidate_at',min(greatest(r.process_after,coalesce(r.blocked_until,r.process_after)))
        filter(where r.status='failed' and r.attempt_count>0 and r.attempt_count < r.max_attempts
          and greatest(r.process_after,coalesce(r.blocked_until,r.process_after)) > now()),
      'posting_hold_count',count(*) filter(where tc.posting_hold_batch_id is not null and coalesce(b.posting_hold,true)),
      'receipt_reconciliation_count',count(*) filter(where q.status in ('pending','unknown','processing')),
      'posting_failed_count',count(*) filter(where q.status = 'failed' or tc.posting_status = 'posting_failed'),
      'posting_last_attempt_at',max(coalesce(q.last_attempt_at,tc.last_post_attempt_at)),
      'posting_last_success_at',max(q.posted_at) filter(where q.status = 'posted'),
      'posting_error_at',max(coalesce(q.last_attempt_at,q.updated_at,tc.updated_at))
        filter(where q.status = 'failed' or tc.posting_status = 'posting_failed'),
      'qbo_auth_error_at',max(coalesce(q.last_attempt_at,q.updated_at,tc.updated_at)) filter(where
        coalesce(q.last_error->>'code',tc.post_error,'') in
          ('invalid_grant','qbo_reconnect_required','qbo_auth_required','vendor_qbo_auth_required','AuthenticationFailed')
        and coalesce(q.status,'')<>'posted' and coalesce(tc.status,'')<>'posted')
    ) into metrics
    from public.bank_transactions bt
    left join public.transaction_categorizations tc on tc.business_id = bt.business_id and tc.transaction_id = bt.id
    left join public.bookkeeping_processing_requests r on r.business_id = bt.business_id and r.transaction_id = bt.id
    left join public.qbo_posted_transactions q on q.business_id = bt.business_id and q.transaction_id = bt.id and q.qbo_env = p_qbo_env
    left join public.plaid_recovery_batches b on b.id = tc.posting_hold_batch_id and b.business_id = bt.business_id
    where bt.business_id = p_business_id and bt.plaid_env = p_plaid_env
      and bt.plaid_account_id = a.plaid_account_id and not bt.is_archived;
    accounts := accounts || jsonb_build_array(jsonb_build_object(
      'account',jsonb_build_object('id',a.plaid_account_id,'plaid_item_id',a.plaid_item_id,'name',a.name,'mask',a.mask,
        'connection_state',a.connection_state,'is_active',a.is_active,'disconnected_at',a.disconnected_at,'updated_at',a.updated_at,
        'plaid_env',a.plaid_env,'plaid_account_id',a.plaid_account_id,'official_name',a.official_name,'type',a.type,'subtype',a.subtype,
        'current_balance',a.current_balance,'available_balance',a.available_balance,'iso_currency_code',a.iso_currency_code,
        'connected_at',a.connected_at,'created_at',a.created_at,'last_sync_at',a.last_sync_at,'connection_state_version',a.connection_state_version,
        'reconnected_at',a.reconnected_at,'sync_gap_started_at',a.sync_gap_started_at,'sync_gap_last_event_at',a.sync_gap_last_event_at,'sync_gap_event_count',a.sync_gap_event_count),
      'item',jsonb_build_object('institution_id',i.institution_id,'institution_name',i.institution_name,'status',i.status,
        'is_active',i.is_active,'disconnected_at',i.disconnected_at,'error_code',i.error_code,'updated_at',i.updated_at,
        'last_success_at',i.last_success_at),
      'latest_run',latest,'last_checkpoint',successful,'metrics',metrics,
      'mapped_to_qbo',exists(select 1 from public.plaid_qbo_account_mappings where business_id=p_business_id and plaid_account_id=a.plaid_account_id),
      'auto_post_enabled',coalesce(policy,false),'qbo_token_status',token_status,'qbo_token_active',token_active,'qbo_token_status_at',token_at,'qbo_token_connected_at',token_connected_at));
  end loop;
  return jsonb_build_object('observed_at',now(),'accounts',accounts);
end;
$$;

-- Replay proof must come from the new atomic admission architecture. A recent
-- successful poll alone is not proof that a previously retained cursor replayed.
create or replace function public.plaid_residual_recovery_snapshot(
  p_business_id uuid, p_plaid_env text, p_plaid_account_id text
) returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
  a public.plaid_accounts%rowtype; i public.plaid_items%rowtype;
  replay_id uuid; checkpoint_id uuid; attempt_id uuid; checkpoint_at timestamptz; newest_target_at timestamptz;
  classifications jsonb; target_rows jsonb; target_count bigint; eligible_count bigint; fingerprint text;
begin
  select * into a from public.plaid_accounts where business_id=p_business_id and plaid_env=p_plaid_env
    and plaid_account_id=p_plaid_account_id;
  if not found then raise exception using errcode='22023', message='plaid_residual_account_not_found'; end if;
  select * into i from public.plaid_items where business_id=p_business_id and plaid_env=p_plaid_env and plaid_item_id=a.plaid_item_id;
  if not found then raise exception using errcode='22023', message='plaid_residual_item_not_found'; end if;
  select id into attempt_id from public.bank_sync_runs where business_id=p_business_id and plaid_item_id=a.plaid_item_id
    order by started_at desc,id desc limit 1;
  select id into checkpoint_id from public.bank_sync_runs where business_id=p_business_id and plaid_item_id=a.plaid_item_id
    and status='completed' order by started_at desc,id desc limit 1;
  select finished_at into checkpoint_at from public.bank_sync_runs where id=checkpoint_id;
  select max(bt.created_at) into newest_target_at from public.classify_plaid_account_recovery_rows(p_business_id,p_plaid_env,p_plaid_account_id) r
    join public.bank_transactions bt on bt.business_id=p_business_id and bt.id=r.transaction_id where r.initial_target;
  select s.id into replay_id from public.bank_sync_runs s where s.business_id=p_business_id and s.plaid_item_id=a.plaid_item_id
    and s.status='completed' and s.finished_at>=a.connected_at and s.meta ? 'admitted_count' and s.meta->>'cursor_input_sha256' is not null
    and exists(select 1 from public.bank_sync_runs f where f.business_id=s.business_id and f.plaid_item_id=s.plaid_item_id
      and f.status='failed' and f.started_at<s.started_at
      and f.meta->>'failure_stage' in ('transaction_persistence','downstream_admission')
      and f.meta->>'cursor_input_sha256'=s.meta->>'cursor_input_sha256')
    order by s.started_at desc,s.id desc limit 1;
  select coalesce(jsonb_object_agg(classification,n),'{}') into classifications from (
    select classification,count(*) n from public.classify_plaid_account_recovery_rows(p_business_id,p_plaid_env,p_plaid_account_id)
      group by classification) grouped;
  select coalesce(jsonb_agg(jsonb_build_object('transaction_id',transaction_id,'classification',classification)
      order by transaction_id),'[]'::jsonb) into target_rows
    from public.classify_plaid_account_recovery_rows(p_business_id,p_plaid_env,p_plaid_account_id) where initial_target;
  select count(*) filter(where initial_target),count(*) filter(where initial_target and classification='eligible_residual_orphan'),
    encode(sha256(convert_to(coalesce(string_agg(transaction_id::text || evidence_version || classification,',' order by transaction_id),'')
      || coalesce(replay_id::text,'') || coalesce(checkpoint_id::text,'') || to_jsonb(a)::text || coalesce(i.status,''),'UTF8')),'hex')
    into target_count,eligible_count,fingerprint
    from public.classify_plaid_account_recovery_rows(p_business_id,p_plaid_env,p_plaid_account_id);
  return jsonb_build_object('account_id',p_plaid_account_id,'plaid_item_id',a.plaid_item_id,
    'replay_run_id',replay_id,'checkpoint_run_id',checkpoint_id,'latest_attempt_id',attempt_id,
    'replay_completed',replay_id is not null and attempt_id=checkpoint_id and coalesce(newest_target_at<=checkpoint_at,true),
    'connection_eligible',a.is_active and a.connection_state='connected' and a.disconnected_at is null
      and i.is_active and i.status in ('connected','active') and i.error_code is null,
    'initial_target_count',target_count,'eligible_count',eligible_count,'classifications',classifications,
    'initial_targets',target_rows,'fingerprint',fingerprint);
end;
$$;

create or replace function public.preview_plaid_residual_orphan_recovery(
  p_business_id uuid,p_plaid_env text,p_plaid_account_id text,p_actor_user_id uuid
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare snapshot jsonb; batch_id uuid;
begin
  if p_actor_user_id is null then raise exception using errcode='22023',message='plaid_residual_actor_required'; end if;
  snapshot := public.plaid_residual_recovery_snapshot(p_business_id,p_plaid_env,p_plaid_account_id);
  -- An ineligible dry-run is read-only and still reports current classifications.
  if not (snapshot->>'replay_completed')::boolean or not (snapshot->>'connection_eligible')::boolean then
    return jsonb_build_object('dry_run',true,'ready',false,'reason_code','successful_replay_required','before',snapshot);
  end if;
  insert into public.plaid_recovery_batches(business_id,plaid_env,plaid_item_id,cutoff_date,status,posting_hold,created_by,summary)
    values(p_business_id,p_plaid_env,snapshot->>'plaid_item_id',current_date,'preview_ready',true,p_actor_user_id,
      jsonb_build_object('workflow_kind','residual_orphan','preview_at',clock_timestamp(),'before',snapshot)) returning id into batch_id;
  insert into public.plaid_recovery_batch_rows(batch_id,business_id,change_type,disposition,plaid_transaction_id,plaid_account_id,payload)
    select batch_id,p_business_id,'modified','new_after_cutoff',bt.plaid_transaction_id,bt.plaid_account_id,
      jsonb_build_object('transaction_id',r.transaction_id,'evidence_version',r.evidence_version,'classification',r.classification)
    from public.classify_plaid_account_recovery_rows(p_business_id,p_plaid_env,p_plaid_account_id) r
    join public.bank_transactions bt on bt.business_id=p_business_id and bt.id=r.transaction_id
    where r.initial_target and r.classification='eligible_residual_orphan';
  return jsonb_build_object('dry_run',true,'ready',true,'batch_id',batch_id,'expires_at',clock_timestamp()+interval '5 minutes',
    'posting_protection','recovery_batch_hold','before',snapshot);
end;
$$;

create or replace function public.apply_plaid_residual_orphan_recovery(
  p_business_id uuid,p_plaid_env text,p_plaid_account_id text,p_actor_user_id uuid,p_batch_id uuid
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  batch public.plaid_recovery_batches%rowtype; current_snapshot jsonb; after_snapshot jsonb;
  ids uuid[]; posting_enabled boolean; n integer;
begin
  select * into batch from public.plaid_recovery_batches where id=p_batch_id and business_id=p_business_id
    and plaid_env=p_plaid_env and summary->>'workflow_kind'='residual_orphan' for update;
  if not found or batch.created_by is distinct from p_actor_user_id
    or batch.summary->'before'->>'account_id' is distinct from p_plaid_account_id then
    raise exception using errcode='22023',message='plaid_residual_preview_scope_mismatch';
  end if;
  if batch.status='imported_held' then
    return jsonb_build_object('dry_run',false,'idempotent',true,'newly_applied_count',0,'batch_id',batch.id,
      'before',batch.summary->'before','after',public.plaid_residual_recovery_snapshot(p_business_id,p_plaid_env,p_plaid_account_id));
  end if;
  if batch.status<>'preview_ready' or batch.posting_hold is not true
    or (batch.summary->>'preview_at')::timestamptz<clock_timestamp()-interval '5 minutes' then
    raise exception using errcode='40001',message='plaid_residual_fresh_preview_required';
  end if;
  select auto_post_to_quickbooks into posting_enabled from public.business_profiles where id=p_business_id for update;
  if posting_enabled is distinct from false then
    raise exception using errcode='42501',message='plaid_residual_disable_posting_required';
  end if;
  -- Coordinate with ordinary sync's Item lease; repair never advances its cursor.
  perform 1 from public.plaid_items where business_id=p_business_id and plaid_env=p_plaid_env
    and plaid_item_id=batch.plaid_item_id and not coalesce(sync_in_progress,false)
    and sync_lease_owner is null for update;
  if not found then raise exception using errcode='40001',message='plaid_residual_sync_lease_active'; end if;
  perform 1 from public.plaid_accounts where business_id=p_business_id and plaid_env=p_plaid_env
    and plaid_account_id=p_plaid_account_id for update;
  -- Lock the exact preview cohort; worker/receipt/categorization ownership FKs
  -- cannot admit conflicting work on these bank rows during this transaction.
  select coalesce(array_agg((payload->>'transaction_id')::uuid),'{}'::uuid[]) into ids
    from public.plaid_recovery_batch_rows where batch_id=batch.id and business_id=p_business_id;
  perform 1 from public.bank_transactions where business_id=p_business_id and id=any(ids) order by id for update;
  current_snapshot := public.plaid_residual_recovery_snapshot(p_business_id,p_plaid_env,p_plaid_account_id);
  if not coalesce((current_snapshot->>'replay_completed')::boolean,false)
    or not coalesce((current_snapshot->>'connection_eligible')::boolean,false)
    or current_snapshot->>'fingerprint' is distinct from batch.summary->'before'->>'fingerprint' then
    raise exception using errcode='40001',message='plaid_residual_preview_stale';
  end if;
  if cardinality(ids)<>(current_snapshot->>'eligible_count')::integer then
    raise exception using errcode='40001',message='plaid_residual_preview_manifest_incomplete';
  end if;
  insert into public.transaction_categorizations(business_id,transaction_id,status,posting_hold_batch_id,post_after,meta)
    select p_business_id,id,'needs_review',batch.id,null,
      jsonb_build_object('residual_recovery_batch_id',batch.id,'safe_to_auto_post',false,'post_block_reason','residual_recovery_hold')
    from unnest(ids) id;
  insert into public.bookkeeping_processing_requests(business_id,transaction_id,scope,status,priority,metadata)
    select p_business_id,id,'transaction','pending',10,
      jsonb_build_object('source','plaid_residual_recovery','residual_recovery_batch_id',batch.id) from unnest(ids) id;
  get diagnostics n=row_count;
  after_snapshot := public.plaid_residual_recovery_snapshot(p_business_id,p_plaid_env,p_plaid_account_id);
  update public.plaid_recovery_batches set status='imported_held',updated_at=now(),
    summary=summary || jsonb_build_object('applied_count',n,'applied_at',clock_timestamp(),'after',after_snapshot)
    where id=batch.id and business_id=p_business_id;
  return jsonb_build_object('dry_run',false,'idempotent',false,'newly_applied_count',n,'batch_id',batch.id,
    'posting_protection','recovery_batch_hold','before',batch.summary->'before','after',after_snapshot);
end;
$$;

revoke all on function public.classify_plaid_account_recovery_rows(uuid,text,text) from public,anon,authenticated;
revoke all on function public.get_plaid_account_recovery_facts(uuid,text,text) from public,anon,authenticated;
revoke all on function public.plaid_residual_recovery_snapshot(uuid,text,text) from public,anon,authenticated;
revoke all on function public.preview_plaid_residual_orphan_recovery(uuid,text,text,uuid) from public,anon,authenticated;
revoke all on function public.apply_plaid_residual_orphan_recovery(uuid,text,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.classify_plaid_account_recovery_rows(uuid,text,text) to service_role;
grant execute on function public.get_plaid_account_recovery_facts(uuid,text,text) to service_role;
grant execute on function public.plaid_residual_recovery_snapshot(uuid,text,text) to service_role;
grant execute on function public.preview_plaid_residual_orphan_recovery(uuid,text,text,uuid) to service_role;
grant execute on function public.apply_plaid_residual_orphan_recovery(uuid,text,text,uuid,uuid) to service_role;

-- Residual cohorts cannot be released through the replacement-card workflow,
-- an older backend, or an ordinary categorization upsert. A future reviewed
-- reconciliation/release workflow must explicitly replace these protections.
create or replace function public.protect_plaid_residual_recovery_hold()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if tg_table_name='transaction_categorizations' then
    if old.posting_hold_batch_id is not null and new.posting_hold_batch_id is distinct from old.posting_hold_batch_id
      and exists(select 1 from public.plaid_recovery_batches where business_id=old.business_id and id=old.posting_hold_batch_id
        and summary->>'workflow_kind'='residual_orphan' and posting_hold) then
      raise exception using errcode='42501',message='plaid_residual_hold_requires_reconciliation';
    end if;
  elsif old.summary->>'workflow_kind'='residual_orphan' then
    if new.posting_hold is not true or new.status not in ('preview_ready','imported_held')
      or new.summary->>'workflow_kind' is distinct from 'residual_orphan'
      or new.business_id is distinct from old.business_id or new.plaid_env is distinct from old.plaid_env
      or new.plaid_item_id is distinct from old.plaid_item_id then
      raise exception using errcode='42501',message='plaid_residual_hold_requires_reconciliation';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.protect_plaid_residual_recovery_hold() from public,anon,authenticated;
drop trigger if exists protect_residual_category_hold on public.transaction_categorizations;
create trigger protect_residual_category_hold before update on public.transaction_categorizations
  for each row execute function public.protect_plaid_residual_recovery_hold();
drop trigger if exists protect_residual_batch_hold on public.plaid_recovery_batches;
create trigger protect_residual_batch_hold before update on public.plaid_recovery_batches
  for each row execute function public.protect_plaid_residual_recovery_hold();
notify pgrst,'reload schema';
