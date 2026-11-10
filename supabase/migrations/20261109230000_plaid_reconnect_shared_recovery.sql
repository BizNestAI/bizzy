-- Retained Item reauthentication and shared reviewed recovery. No provider calls.
alter table public.plaid_items add column if not exists reconnect_state jsonb not null default '{}'::jsonb;

create or replace function public.assert_plaid_recovery_operator(p_actor_id uuid)
returns void language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
  if not exists(select 1 from public.internal_staff_users where user_id=p_actor_id and active
    and role in ('operator','accountant','owner_admin')) then
    raise exception using errcode='42501',message='plaid_recovery_operator_required';
  end if;
end $$;
revoke all on function public.assert_plaid_recovery_operator(uuid) from public,anon,authenticated;

create or replace function public.record_plaid_reconnect_verification(p_business_id uuid,p_plaid_env text,
  p_plaid_item_id text,p_actor_id uuid,p_expected_cursor text,p_accounts jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare i public.plaid_items%rowtype; actual_ids text[]; known_ids text[]; new_accounts jsonb; s jsonb;
begin
  select * into i from public.plaid_items where business_id=p_business_id and plaid_env=p_plaid_env
    and plaid_item_id=p_plaid_item_id and is_active for update;
  if not found or p_actor_id is null then raise exception 'plaid_reconnect_scope_invalid'; end if;
  if i.cursor is distinct from p_expected_cursor or i.sync_lease_owner is not null or coalesce(i.sync_in_progress,false) then
    raise exception using errcode='40001',message='plaid_reconnect_sync_conflict'; end if;
  if jsonb_typeof(p_accounts)<>'array' or jsonb_array_length(p_accounts)=0 then raise exception 'plaid_reconnect_accounts_required'; end if;
  select array_agg(a->>'plaid_account_id' order by a->>'plaid_account_id') into actual_ids from jsonb_array_elements(p_accounts) a;
  select array_agg(pa.plaid_account_id order by pa.plaid_account_id) into known_ids from public.plaid_accounts pa
    where pa.business_id=p_business_id and pa.plaid_env=p_plaid_env and pa.plaid_item_id=p_plaid_item_id
      and pa.is_active and pa.disconnected_at is null and pa.connection_state not in ('disconnected','closed_historical')
      -- Retained prior IDs do not reopen an explicitly confirmed lineage review.
      -- Keep their history/mappings/state; never infer replacement from a mask.
      and not exists(select 1 from public.plaid_account_lineage_decisions l where l.business_id=p_business_id
        and l.plaid_env=p_plaid_env and l.status='confirmed' and l.prior_plaid_account_id=pa.plaid_account_id
        and l.replacement_plaid_account_id<>pa.plaid_account_id and l.physical_account_id=pa.physical_account_id
        and l.replacement_plaid_account_id=any(actual_ids) and not(pa.plaid_account_id=any(actual_ids)));
  select coalesce(jsonb_agg(a),'[]'::jsonb) into new_accounts from jsonb_array_elements(p_accounts) a
    where not exists(select 1 from public.plaid_accounts pa where pa.business_id=p_business_id and pa.plaid_env=p_plaid_env
      and pa.plaid_item_id=p_plaid_item_id and pa.plaid_account_id=a->>'plaid_account_id');
  if actual_ids is distinct from known_ids then
    -- Candidate discovery never resets prior operator decisions or maps accounts.
    insert into public.plaid_replacement_account_candidates(business_id,plaid_env,plaid_item_id,plaid_account_id,account_snapshot)
      select p_business_id,p_plaid_env,p_plaid_item_id,a->>'plaid_account_id',a from jsonb_array_elements(new_accounts) a
      on conflict(business_id,plaid_env,plaid_item_id,plaid_account_id) do nothing;
    s:=jsonb_build_object('state','identity_review_required','reason','replacement_card','verified_at',clock_timestamp(),
      'actor_id',p_actor_id,'provider_account_ids',actual_ids,'new_accounts',new_accounts);
  elsif i.reconnect_state->>'state'='completed' and i.error_code is null and i.status='connected' then
    return i.reconnect_state;
  elsif i.reconnect_state->>'state'='waiting_for_replay'
    and i.reconnect_state->>'cursor_input_sha256'=encode(sha256(convert_to(coalesce(i.cursor,''),'UTF8')),'hex') then
    return i.reconnect_state;
  else
    s:=jsonb_build_object('state','waiting_for_replay','verified_at',clock_timestamp(),'actor_id',p_actor_id,
      'provider_account_ids',actual_ids,'prior_error_code',i.error_code,
      'cursor_input_sha256',encode(sha256(convert_to(coalesce(i.cursor,''),'UTF8')),'hex'));
  end if;
  update public.plaid_items set reconnect_state=s where id=i.id;
  return s;
end $$;
revoke all on function public.record_plaid_reconnect_verification(uuid,text,text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.record_plaid_reconnect_verification(uuid,text,text,uuid,text,jsonb) to service_role;

-- Both normal scheduled and explicit sync share this lease gate. A changed
-- identity cannot ingest or checkpoint before an operator resolves lineage.
create or replace function public.guard_plaid_reconnect_sync_lease()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
  if new.sync_lease_owner is not null and new.sync_lease_owner is distinct from old.sync_lease_owner
    and old.reconnect_state->>'state' in ('identity_review_required','new_item_identity_required') then return null; end if;
  return new;
end $$;
create trigger guard_plaid_reconnect_sync_lease before update of sync_lease_owner on public.plaid_items
  for each row execute function public.guard_plaid_reconnect_sync_lease();

-- This runs within normal durable admission, AFTER its completed run record.
-- Link success alone never clears an Item error or account attention state.
create or replace function public.finish_plaid_reconnect_checkpoint()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare i public.plaid_items%rowtype;
begin
  if new.status<>'completed' or old.status='completed' or not(new.meta ? 'admitted_count') then return new; end if;
  select * into i from public.plaid_items where business_id=new.business_id and plaid_item_id=new.plaid_item_id for update;
  if i.reconnect_state->>'state'<>'waiting_for_replay' or i.reconnect_state->>'state' is null then return new; end if;
  if new.started_at<(i.reconnect_state->>'verified_at')::timestamptz
    or new.meta->>'cursor_input_sha256' is distinct from i.reconnect_state->>'cursor_input_sha256'
    or new.meta->>'next_cursor_sha256' is distinct from encode(sha256(convert_to(coalesce(i.cursor,''),'UTF8')),'hex') then
    raise exception using errcode='40001',message='plaid_reconnect_checkpoint_evidence_conflict'; end if;
  update public.plaid_accounts set connection_state='connected',connection_state_version=connection_state_version+1,
    last_sync_at=new.finished_at,updated_at=new.finished_at
    where business_id=i.business_id and plaid_env=i.plaid_env and plaid_item_id=i.plaid_item_id
      and is_active and disconnected_at is null and connection_state='attention_required'
      and i.reconnect_state->'provider_account_ids' ? plaid_account_id;
  update public.plaid_items set reconnect_state=reconnect_state||jsonb_build_object('state','completed',
    'checkpoint_run_id',new.id,'checkpoint_at',new.finished_at,'continuity','replay_completed_no_proven_gap') where id=i.id;
  return new;
end $$;
create trigger finish_plaid_reconnect_checkpoint after update of status on public.bank_sync_runs
  for each row execute function public.finish_plaid_reconnect_checkpoint();

-- Preserve saved historical boundaries; new state has no invented cutoff.
create or replace function public.bootstrap_plaid_replacement_recovery(
  p_business_id uuid, p_plaid_env text, p_plaid_item_id text, p_actor_user_id uuid default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_item public.plaid_items%rowtype;
begin
  perform public.assert_plaid_recovery_operator(p_actor_user_id);
  select * into v_item from public.plaid_items where business_id = p_business_id and plaid_env = p_plaid_env
    and plaid_item_id = p_plaid_item_id and is_active is true for update;
  if not found then raise exception 'plaid_item_not_found'; end if;
  if v_item.replacement_recovery_status is null then
    update public.plaid_items set replacement_recovery_status = 'awaiting_account_selection',
      replacement_recovery_bootstrapped_at = now(),
      replacement_recovery_bootstrapped_by = p_actor_user_id, updated_at = now() where id = v_item.id;
    return jsonb_build_object('status','awaiting_account_selection','cutoff_date',v_item.replacement_recovery_cutoff_date,'reused',false);
  end if;
  return jsonb_build_object('status',v_item.replacement_recovery_status,
    'cutoff_date',v_item.replacement_recovery_cutoff_date,'reused',true);
end $$;

create or replace function public.select_plaid_replacement_recovery_account(
  p_business_id uuid, p_plaid_env text, p_plaid_item_id text, p_plaid_account_id text,
  p_actor_user_id uuid default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_item public.plaid_items%rowtype; v_account public.plaid_accounts%rowtype;
  v_mapping public.plaid_qbo_account_mappings%rowtype; v_candidate_id uuid;
begin
  perform public.assert_plaid_recovery_operator(p_actor_user_id);
  select * into v_item from public.plaid_items where business_id = p_business_id and plaid_env = p_plaid_env
    and plaid_item_id = p_plaid_item_id and is_active is true for update;
  if not found then raise exception 'plaid_item_not_found'; end if;
  select * into v_account from public.plaid_accounts where business_id = p_business_id and plaid_env = p_plaid_env
    and plaid_item_id = p_plaid_item_id and plaid_account_id = p_plaid_account_id and is_active is true;
  if not found then raise exception 'replacement_account_not_found'; end if;
  select * into v_mapping from public.plaid_qbo_account_mappings where business_id = p_business_id
    and plaid_account_id = p_plaid_account_id;
  if not found or v_mapping.qbo_account_id is null then raise exception 'replacement_account_qbo_mapping_required'; end if;
  insert into public.plaid_replacement_account_candidates
    (business_id,plaid_env,plaid_item_id,plaid_account_id,account_snapshot,status,decided_at,decided_by)
  values (p_business_id,p_plaid_env,p_plaid_item_id,p_plaid_account_id,
    jsonb_build_object('name',v_account.name,'official_name',v_account.official_name,'mask',v_account.mask,
      'type',v_account.type,'subtype',v_account.subtype,'qbo_account_id',v_mapping.qbo_account_id,
      'qbo_account_name',v_mapping.qbo_account_name,'qbo_account_type',v_mapping.qbo_account_type),
    'pending',null,null)
  on conflict (business_id,plaid_env,plaid_item_id,plaid_account_id) do update set
    account_snapshot = excluded.account_snapshot, status = 'pending', decided_at = null, decided_by = null
  returning id into v_candidate_id;
  update public.plaid_items set replacement_recovery_status = 'lineage_confirmation_required',
    replacement_recovery_account_id = p_plaid_account_id,
    replacement_recovery_selected_at = now(), replacement_recovery_selected_by = p_actor_user_id, updated_at = now()
    where id = v_item.id;
  return jsonb_build_object('status','lineage_confirmation_required','candidate_id',v_candidate_id,
    'plaid_account_id',p_plaid_account_id,'qbo_account_id',v_mapping.qbo_account_id);
end $$;

create or replace function public.confirm_plaid_replacement_lineage_and_advance(
  p_business_id uuid, p_plaid_env text, p_plaid_item_id text, p_candidate_id uuid,
  p_prior_plaid_account_id text, p_actor_user_id uuid default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_result jsonb; affected integer; v_replacement_account_id text;
  v_item public.plaid_items%rowtype;
  v_candidate public.plaid_replacement_account_candidates%rowtype;
  v_prior public.plaid_accounts%rowtype;
  v_physical_account_id uuid;
begin
  perform public.assert_plaid_recovery_operator(p_actor_user_id);
  select * into v_item from public.plaid_items
   where business_id = p_business_id and plaid_env = p_plaid_env
     and plaid_item_id = p_plaid_item_id and is_active is true for update;
  if not found then raise exception 'plaid_item_not_found'; end if;
  select * into v_candidate from public.plaid_replacement_account_candidates
   where id = p_candidate_id and business_id = p_business_id and plaid_env = p_plaid_env
     and plaid_item_id = p_plaid_item_id for update;
  if not found then raise exception 'replacement_candidate_not_found'; end if;
  select * into v_prior from public.plaid_accounts
   where business_id = p_business_id and plaid_env = p_plaid_env
     and plaid_account_id = p_prior_plaid_account_id and is_active is true for update;
  if not found then raise exception 'prior_account_not_found'; end if;

  -- A retained Plaid account ID can legitimately predate canonical physical-account
  -- backfill. Establish that identity only after the operator explicitly confirms
  -- that the selected account represents itself; never infer it from the mask.
  if v_prior.physical_account_id is null
     and v_candidate.plaid_account_id = p_prior_plaid_account_id then
    insert into public.plaid_physical_accounts (
      business_id, plaid_env, institution_name, account_mask, account_type,
      account_subtype, normalized_account_name, current_plaid_item_id,
      current_plaid_account_id, confidence, status, needs_confirmation, metadata
    ) values (
      p_business_id, p_plaid_env, v_item.institution_name, v_prior.mask,
      v_prior.type, v_prior.subtype, lower(trim(coalesce(v_prior.official_name,v_prior.name,'account'))),
      p_plaid_item_id, v_prior.plaid_account_id, 'manual', 'active', false,
      jsonb_build_object('source','settings_replacement_recovery_explicit_retained_identity',
        'candidate_id',p_candidate_id,'confirmed_by',p_actor_user_id)
    ) returning id into v_physical_account_id;
    update public.plaid_accounts set physical_account_id = v_physical_account_id,
      relink_status = 'linked_existing', relink_confidence = 'confirmed', updated_at = now()
     where business_id = p_business_id and plaid_env = p_plaid_env
       and plaid_account_id = p_prior_plaid_account_id;
  end if;

  v_result := public.confirm_plaid_replacement_account_lineage(
    p_business_id, p_plaid_env, p_plaid_item_id, p_candidate_id,
    p_prior_plaid_account_id, p_actor_user_id
  );
  v_replacement_account_id := v_result->>'replacement_plaid_account_id';
  update public.plaid_items set replacement_recovery_status = 'ready_for_preview', replacement_recovery_account_id=v_replacement_account_id, updated_at = now()
   where business_id = p_business_id and plaid_env = p_plaid_env and plaid_item_id = p_plaid_item_id
     and is_active is true;
  get diagnostics affected = row_count;
  if affected <> 1 then raise exception 'lineage_state_persistence_failed'; end if;
  update public.plaid_items set reconnect_state=reconnect_state||jsonb_build_object('state','identity_confirmed',
    'confirmed_by',p_actor_user_id,'confirmed_at',now()) where id=v_item.id;
  return v_result || jsonb_build_object('orchestration_status','ready_for_preview');
end $$;


-- The digest is internal evidence only; customer contracts never return it.
create or replace function public.plaid_bounded_recovery_fingerprint(p_business_id uuid)
returns text language sql stable security definer set search_path=pg_catalog,public as $$
  select encode(sha256(convert_to(jsonb_build_array(
    (select jsonb_agg(to_jsonb(t) order by id) from public.bank_transactions t where business_id=p_business_id),
    (select jsonb_agg(to_jsonb(t) order by id) from public.transaction_categorizations t where business_id=p_business_id),
    (select jsonb_agg(to_jsonb(t) order by id) from public.qbo_posted_transactions t where business_id=p_business_id),
    (select jsonb_agg(to_jsonb(t) order by id) from public.plaid_accounts t where business_id=p_business_id),
    (select jsonb_agg(to_jsonb(t) order by id) from public.plaid_account_lineage_decisions t where business_id=p_business_id),
    (select jsonb_agg(to_jsonb(t) order by id) from public.plaid_qbo_account_mappings t where business_id=p_business_id)
  )::text,'UTF8')),'hex');
$$;
revoke all on function public.plaid_bounded_recovery_fingerprint(uuid) from public,anon,authenticated;

create or replace function public.validate_plaid_bounded_recovery(p_business_id uuid,p_plaid_env text,
 p_plaid_item_id text,p_actor_id uuid,p_context jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare i public.plaid_items%rowtype; a public.plaid_accounts%rowtype; cp public.bank_sync_runs%rowtype;
  start_date date; end_date date;
begin
  perform public.assert_plaid_recovery_operator(p_actor_id);
  if jsonb_typeof(p_context)<>'object' or p_context - array['reason','account_id','start_date','end_date','checkpoint_run_id','gap_evidence'] <> '{}'::jsonb then
    raise exception 'plaid_recovery_safe_context_required'; end if;
  perform 1 from public.business_profiles where id=p_business_id and auto_post_to_quickbooks is false for update;
  if not found then raise exception 'plaid_recovery_disable_posting_required'; end if;
  select * into i from public.plaid_items where business_id=p_business_id and plaid_env=p_plaid_env
    and plaid_item_id=p_plaid_item_id and is_active for update;
  if not found or i.sync_lease_owner is not null or coalesce(i.sync_in_progress,false) then raise exception 'plaid_recovery_sync_conflict'; end if;
  select * into a from public.plaid_accounts where business_id=p_business_id and plaid_env=p_plaid_env
    and plaid_item_id=p_plaid_item_id and plaid_account_id=p_context->>'account_id' and is_active
    and disconnected_at is null and connection_state='connected';
  if not found or a.physical_account_id is null then raise exception 'plaid_recovery_confirmed_account_required'; end if;
  if not exists(select 1 from public.plaid_qbo_account_mappings where business_id=p_business_id
    and plaid_account_id=a.plaid_account_id and qbo_account_id is not null) then raise exception 'plaid_recovery_mapping_required'; end if;
  start_date:=(p_context->>'start_date')::date; end_date:=(p_context->>'end_date')::date;
  if start_date is null or end_date is null or end_date<start_date or end_date-start_date>366 or end_date>current_date then
    raise exception 'plaid_recovery_exact_range_required'; end if;
  -- Evidence is an operator assertion of an authoritative document/history;
  -- the range is explicit. A maximum local transaction date proves nothing.
  if p_context->>'reason' not in ('replacement_card','institution_migration','reconnect_gap') or p_context->>'reason' is null
    or p_context->'gap_evidence'->>'kind' not in ('statement','provider_history','operator_verified_document')
    or p_context->'gap_evidence'->>'kind' is null
    or coalesce(p_context->'gap_evidence'->>'reference_sha256','') !~ '^[a-f0-9]{64}$'
    or (p_context->'gap_evidence') - array['kind','reference_sha256'] <> '{}'::jsonb then
    raise exception 'plaid_recovery_authoritative_evidence_required'; end if;
  if p_context->>'reason'='reconnect_gap' then
    select * into cp from public.bank_sync_runs where business_id=p_business_id and plaid_item_id=p_plaid_item_id
      order by started_at desc,id desc limit 1;
    if i.reconnect_state->>'state' is distinct from 'completed' or cp.status is distinct from 'completed'
      or cp.id::text is distinct from p_context->>'checkpoint_run_id' or not(cp.meta ? 'admitted_count')
      or cp.finished_at<(i.reconnect_state->>'checkpoint_at')::timestamptz then
      raise exception 'plaid_recovery_successful_replay_required'; end if;
  elsif coalesce(i.reconnect_state->>'state','') not in ('identity_confirmed','completed') or not exists(
    select 1 from public.plaid_account_lineage_decisions where business_id=p_business_id and plaid_env=p_plaid_env
      and replacement_plaid_account_id=a.plaid_account_id and physical_account_id=a.physical_account_id and status='confirmed') then
    raise exception 'plaid_recovery_lineage_required';
  end if;
  return jsonb_build_object('physical_account_id',a.physical_account_id,'evidence_fingerprint',public.plaid_bounded_recovery_fingerprint(p_business_id));
end $$;
revoke all on function public.validate_plaid_bounded_recovery(uuid,text,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.validate_plaid_bounded_recovery(uuid,text,text,uuid,jsonb) to service_role;

create or replace function public.stage_plaid_bounded_recovery(p_business_id uuid,p_plaid_env text,p_plaid_item_id text,
 p_actor_id uuid,p_context jsonb,p_fingerprint text,p_rows jsonb,p_summary jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare evidence jsonb; b public.plaid_recovery_batches%rowtype; i public.plaid_items%rowtype; context_hash text;
begin
  evidence:=public.validate_plaid_bounded_recovery(p_business_id,p_plaid_env,p_plaid_item_id,p_actor_id,p_context);
  if evidence->>'evidence_fingerprint' is distinct from p_fingerprint then raise exception 'plaid_recovery_evidence_changed'; end if;
  select * into i from public.plaid_items where business_id=p_business_id and plaid_env=p_plaid_env and plaid_item_id=p_plaid_item_id;
  context_hash:=encode(sha256(convert_to(p_context::text,'UTF8')),'hex');
  select * into b from public.plaid_recovery_batches where business_id=p_business_id and plaid_env=p_plaid_env and plaid_item_id=p_plaid_item_id
    and summary->>'workflow_kind'='reviewed_recovery' and summary->>'context_hash'=context_hash
    and status in ('preview_ready','imported_held') order by created_at desc limit 1;
  if found then
    if b.status='imported_held' or (b.summary->>'evidence_fingerprint'=p_fingerprint
      and (b.summary->>'preview_at')::timestamptz+interval '5 minutes'>clock_timestamp()) then
      return jsonb_build_object('batch_id',b.id,'status',b.status,'summary',b.summary,'posting_hold',true,'reused',true);
    end if;
    update public.plaid_recovery_batches set status='abandoned' where id=b.id;
  end if;
  if exists(select 1 from public.plaid_recovery_batches where business_id=p_business_id and plaid_env=p_plaid_env
    and plaid_item_id=p_plaid_item_id and status in ('preview_ready','imported_held')
    and summary->>'workflow_kind' is distinct from 'residual_orphan' and posting_hold) then
    raise exception 'plaid_recovery_existing_cohort_requires_review'; end if;
  insert into public.plaid_recovery_batches(business_id,plaid_env,plaid_item_id,original_cursor,staged_next_cursor,cutoff_date,status,posting_hold,created_by,summary)
    values(p_business_id,p_plaid_env,p_plaid_item_id,i.cursor,i.cursor,(p_context->>'start_date')::date-1,'preview_ready',true,p_actor_id,
      p_summary||jsonb_build_object('workflow_kind','reviewed_recovery','recovery_reason',p_context->>'reason','context',p_context,
        'context_hash',context_hash,'preview_at',clock_timestamp(),'evidence_fingerprint',p_fingerprint,
        'before',jsonb_build_object('account_id',p_context->>'account_id'))) returning * into b;
  insert into public.plaid_recovery_batch_rows(batch_id,business_id,change_type,disposition,plaid_transaction_id,pending_transaction_id,
    plaid_account_id,physical_account_id,transaction_date,authorized_date,amount,signed_amount,pending,payload)
    select b.id,p_business_id,'added',r->>'disposition',r->>'plaid_transaction_id',r->>'pending_transaction_id',
      p_context->>'account_id',(evidence->>'physical_account_id')::uuid,(r->>'transaction_date')::date,(r->>'authorized_date')::date,
      (r->>'amount')::numeric,(r->>'signed_amount')::numeric,(r->>'pending')::boolean,r->'payload'
    from jsonb_array_elements(p_rows) r;
  update public.plaid_items set replacement_recovery_status='preview_ready',replacement_recovery_account_id=p_context->>'account_id',
    replacement_recovery_cutoff_date=b.cutoff_date where id=i.id;
  return jsonb_build_object('batch_id',b.id,'status',b.status,'summary',b.summary,'posting_hold',true,'reused',false);
end $$;
revoke all on function public.stage_plaid_bounded_recovery(uuid,text,text,uuid,jsonb,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.stage_plaid_bounded_recovery(uuid,text,text,uuid,jsonb,text,jsonb,jsonb) to service_role;

-- Existing admission engine: generic cohorts add durable requests, preserve cursor.
create or replace function public.admit_plaid_recovery_batch(
  p_business_id uuid,
  p_batch_id uuid,
  p_plaid_item_id text,
  p_selected_row_ids uuid[],
  p_actor_user_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_batch public.plaid_recovery_batches%rowtype;
  v_item public.plaid_items%rowtype;
  v_admitted integer := 0;
  v_blocked integer := 0;
  v_selected integer := 0;
begin
  perform public.assert_plaid_recovery_operator(p_actor_user_id);
  if coalesce(cardinality(p_selected_row_ids),0) = 0 then raise exception 'recovery_selection_required'; end if;
  select count(distinct x) into v_selected from unnest(p_selected_row_ids) x;
  if v_selected <> cardinality(p_selected_row_ids) then raise exception 'duplicate_recovery_row_selection'; end if;

  select * into v_batch from public.plaid_recovery_batches
   where id=p_batch_id and business_id=p_business_id and plaid_item_id=p_plaid_item_id for update;
  if not found then raise exception 'recovery_batch_not_found'; end if;
  if v_batch.status='imported_held' then
    if v_batch.summary->>'workflow_kind'='reviewed_recovery' and not(
      v_batch.summary->'selected_row_ids' @> to_jsonb(p_selected_row_ids)
      and to_jsonb(p_selected_row_ids) @> (v_batch.summary->'selected_row_ids')) then
      raise exception 'plaid_recovery_admission_selection_reused'; end if;
    return jsonb_build_object('batch_id',p_batch_id,'status','imported_held','posting_hold',true,
      'admitted',coalesce((v_batch.summary->>'admitted')::integer,0),'reused',true);
  end if;
  if v_batch.status<>'preview_ready' then raise exception 'recovery_batch_not_ready'; end if;

  select * into v_item from public.plaid_items where business_id=p_business_id and plaid_env=v_batch.plaid_env
    and plaid_item_id=p_plaid_item_id and is_active is true for update;
  if not found or v_item.replacement_recovery_status not in ('ready_for_preview','preview_ready')
    or v_item.replacement_recovery_account_id is null then raise exception 'recovery_workflow_not_active'; end if;

  select count(*) into v_blocked from public.plaid_recovery_batch_rows
   where batch_id=p_batch_id and business_id=p_business_id and disposition in ('probable_duplicate','ambiguous');
  if v_blocked>0 then raise exception 'recovery_batch_requires_review'; end if;
  select count(*) into v_blocked from public.plaid_recovery_batch_rows
   where id=any(p_selected_row_ids) and batch_id=p_batch_id and business_id=p_business_id
     and plaid_account_id=v_item.replacement_recovery_account_id and disposition='new_after_cutoff';
  if v_blocked<>v_selected then raise exception 'invalid_recovery_row_selection'; end if;
  select count(*) into v_blocked from public.plaid_recovery_batch_rows r
  join public.bank_transactions bt on bt.business_id=p_business_id
    and bt.plaid_env=v_batch.plaid_env and bt.plaid_transaction_id=r.plaid_transaction_id
  where r.id=any(p_selected_row_ids) and r.batch_id=p_batch_id and r.business_id=p_business_id;
  if v_blocked>0 then raise exception 'recovery_selection_no_longer_eligible'; end if;

  if v_batch.summary->>'workflow_kind'='residual_orphan' then raise exception 'recovery_batch_not_ready'; end if;
  if v_batch.summary->>'workflow_kind'='reviewed_recovery' then
    perform public.validate_plaid_bounded_recovery(p_business_id,v_batch.plaid_env,p_plaid_item_id,p_actor_user_id,v_batch.summary->'context');
    if (v_batch.summary->>'preview_at')::timestamptz+interval '5 minutes'<=clock_timestamp()
      or v_item.cursor is distinct from v_batch.original_cursor
      or public.plaid_bounded_recovery_fingerprint(p_business_id) is distinct from v_batch.summary->>'evidence_fingerprint' then
      raise exception 'plaid_recovery_preview_evidence_changed'; end if;
  end if;

  insert into public.bank_transactions (
    business_id,plaid_item_id,plaid_env,plaid_account_id,physical_account_id,plaid_transaction_id,
    pending_transaction_id,name,merchant_name,plaid_amount_raw,amount,signed_amount,direction,
    iso_currency_code,unofficial_currency_code,date,authorized_date,pending,payment_channel,
    transaction_type,check_number,category_primary,category_detailed,category_confidence,
    personal_finance_category,location,counterparties,plaid_last_modified_at,last_seen_at,
    is_archived,raw,updated_at,plaid_recovery_batch_id,canonical_source
  )
  select r.business_id,v_batch.plaid_item_id,v_batch.plaid_env,r.plaid_account_id,pa.physical_account_id,
    r.plaid_transaction_id,r.pending_transaction_id,
    coalesce(r.payload->'transaction'->>'name',r.payload->'transaction'->>'merchant_name','Transaction'),
    r.payload->'transaction'->>'merchant_name',coalesce((r.payload->'transaction'->>'amount')::numeric,0),
    r.amount,r.signed_amount,case when r.signed_amount>0 then 'INFLOW' when r.signed_amount<0 then 'OUTFLOW' else 'UNKNOWN' end,
    r.payload->'transaction'->>'iso_currency_code',r.payload->'transaction'->>'unofficial_currency_code',r.transaction_date,r.authorized_date,r.pending,
    r.payload->'transaction'->>'payment_channel',r.payload->'transaction'->>'transaction_type',r.payload->'transaction'->>'check_number',
    r.payload->'transaction'->'personal_finance_category'->>'primary',r.payload->'transaction'->'personal_finance_category'->>'detailed',
    r.payload->'transaction'->'personal_finance_category'->>'confidence_level',r.payload->'transaction'->'personal_finance_category',
    r.payload->'transaction'->'location',r.payload->'transaction'->'counterparties',
    nullif(coalesce(r.payload->'transaction'->>'timestamp',r.payload->'transaction'->>'datetime'),'')::timestamptz,
    now(),false,r.payload->'transaction',now(),p_batch_id,'plaid_replacement_recovery'
  from public.plaid_recovery_batch_rows r join public.plaid_accounts pa on pa.business_id=r.business_id
    and pa.plaid_env=v_batch.plaid_env and pa.plaid_account_id=r.plaid_account_id and pa.is_active is true
  where r.id=any(p_selected_row_ids) and r.batch_id=p_batch_id and r.business_id=p_business_id
    and r.plaid_account_id=v_item.replacement_recovery_account_id and r.disposition='new_after_cutoff'
    and not exists (select 1 from public.bank_transactions bt where bt.business_id=p_business_id
      and bt.plaid_env=v_batch.plaid_env and bt.plaid_transaction_id=r.plaid_transaction_id);
  get diagnostics v_admitted=row_count;
  if v_admitted<>v_selected then raise exception 'recovery_admission_count_mismatch'; end if;

  update public.plaid_recovery_batch_rows r set admitted_transaction_id=bt.id from public.bank_transactions bt
   where r.id=any(p_selected_row_ids) and r.batch_id=p_batch_id and r.business_id=p_business_id
    and bt.business_id=p_business_id and bt.plaid_env=v_batch.plaid_env and bt.plaid_transaction_id=r.plaid_transaction_id;
  insert into public.transaction_categorizations (business_id,transaction_id,status,posting_hold_batch_id,meta,updated_at)
  select p_business_id,r.admitted_transaction_id,'needs_review',p_batch_id,
    jsonb_build_object('plaid_recovery_batch_id',p_batch_id,'recovery_admitted_by',p_actor_user_id),now()
  from public.plaid_recovery_batch_rows r where r.id=any(p_selected_row_ids) and r.batch_id=p_batch_id
    and r.business_id=p_business_id and r.admitted_transaction_id is not null
  on conflict (business_id,transaction_id) do update set posting_hold_batch_id=p_batch_id,updated_at=now();

  if v_batch.summary->>'workflow_kind'='reviewed_recovery' then
    perform public.ensure_plaid_transaction_categorizations(p_business_id,
      array(select admitted_transaction_id from public.plaid_recovery_batch_rows where batch_id=p_batch_id and id=any(p_selected_row_ids)));
    insert into public.bookkeeping_processing_requests(business_id,transaction_id,scope,status,priority,metadata)
      select p_business_id,admitted_transaction_id,'transaction','pending',10,
        jsonb_build_object('source','plaid_reviewed_recovery','recovery_batch_id',p_batch_id)
      from public.plaid_recovery_batch_rows where batch_id=p_batch_id and id=any(p_selected_row_ids);
    update public.plaid_recovery_batches set summary=summary||jsonb_build_object('applied_at',now(),'applied_count',v_admitted)
      where id=p_batch_id and business_id=p_business_id;
  end if;
  update public.plaid_items set cursor=case when v_batch.summary->>'workflow_kind'='reviewed_recovery' then cursor else v_batch.staged_next_cursor end,replacement_recovery_status='imported_held',updated_at=now()
   where business_id=p_business_id and plaid_env=v_batch.plaid_env and plaid_item_id=p_plaid_item_id;
  update public.plaid_recovery_batches set status='imported_held',posting_hold=true,
    summary=summary||jsonb_build_object('admitted',v_admitted,'selected',v_selected,'quarantined',
      greatest(coalesce((summary->>'new_after_cutoff')::integer,0)-v_selected,0),'selected_row_ids',to_jsonb(p_selected_row_ids),
      'admitted_at',now(),'admitted_by',p_actor_user_id),updated_at=now()
   where id=p_batch_id and business_id=p_business_id;
  return jsonb_build_object('batch_id',p_batch_id,'status','imported_held','posting_hold',true,
    'admitted',v_admitted,'selected',v_selected,'quarantined',greatest(coalesce((v_batch.summary->>'new_after_cutoff')::integer,0)-v_selected,0));
end $$;

revoke all on function public.admit_plaid_recovery_batch(uuid,uuid,text,uuid[],uuid) from public,anon,authenticated;
grant execute on function public.admit_plaid_recovery_batch(uuid,uuid,text,uuid[],uuid) to service_role;


-- Shared with residual recovery; existing RPC names remain compatible.
create or replace function public.assert_plaid_residual_operator_scope(
  p_business_id uuid,p_plaid_env text,p_account_id text,p_batch_id uuid,p_actor_id uuid
) returns public.plaid_recovery_batches language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare b public.plaid_recovery_batches%rowtype;
begin
  if not exists(select 1 from public.internal_staff_users where user_id=p_actor_id and active
    and role in ('operator','accountant','owner_admin')) then
    raise exception using errcode='42501',message='plaid_reconciliation_operator_required';
  end if;
  select * into b from public.plaid_recovery_batches where id=p_batch_id and business_id=p_business_id
    and plaid_env=p_plaid_env and summary->>'workflow_kind' in ('residual_orphan','reviewed_recovery')
    and summary->'before'->>'account_id'=p_account_id and status='imported_held'
    and posting_hold and summary ? 'applied_at' and summary ? 'applied_count';
  if not found or not exists(select 1 from public.plaid_accounts where business_id=p_business_id
    and plaid_env=p_plaid_env and plaid_account_id=p_account_id and plaid_item_id=b.plaid_item_id) then
    raise exception using errcode='22023',message='plaid_reconciliation_scope_or_admission_invalid';
  end if;
  if (b.summary->>'applied_count')::integer<>(select count(*) from public.plaid_recovery_batch_rows
      where business_id=p_business_id and batch_id=b.id
        and (b.summary->>'workflow_kind'='residual_orphan' or admitted_transaction_id is not null)) then
    raise exception using errcode='40001',message='plaid_reconciliation_cohort_invalid';
  end if;
  return b;
end;
$$;

-- Shared with residual recovery; existing RPC names remain compatible.
create or replace function public.plaid_residual_reconciliation_rows(p_business_id uuid,p_batch_id uuid)
returns table(transaction_id uuid,classification text,held boolean,releasable boolean,
  requires_live_qbo_attestation boolean,evidence_fingerprint text,non_hold_fingerprint text)
language sql stable security definer set search_path=pg_catalog,public as $$
  with evidence as (
    select coalesce(br.admitted_transaction_id,(br.payload->>'transaction_id')::uuid) tid, tc.posting_hold_batch_id=p_batch_id is_held,
      to_jsonb(br) br_json,to_jsonb(bt) bt_json,to_jsonb(tc) tc_json,to_jsonb(r) r_json,to_jsonb(q) q_json,
      to_jsonb(j) j_json, attempts.all_rows attempt_json, matches.all_rows match_json, pairs.all_rows pair_json,
      case
        when bt.id is null or tc.id is null or r.id is null
          or bt.plaid_account_id is distinct from b.summary->'before'->>'account_id'
          or bt.plaid_env is distinct from b.plaid_env
          or (tc.posting_hold_batch_id is not null and tc.posting_hold_batch_id<>p_batch_id) then 'evidence_changed'
        when r.status='processing' and r.locked_at>now()-interval '10 minutes' then 'categorization_lease_active'
        when r.status='processing' then 'categorization_lease_stale'
        when r.status='dead_letter' then 'unresolved_dead_letter'
        when r.status in ('pending','failed') then 'categorization_processing'
        when q.status in ('pending','processing') then 'pending_qbo_receipt'
        when q.status='unknown' then 'unknown_qbo_receipt'
        when q.status='failed' or tc.posting_status='posting_failed' or j.state in ('failed','processing','reconciling')
          or (attempts.latest_status='failed' and coalesce(q.status,'')<>'posted') then 'failed_qbo_attempt'
        when bt.accounting_review_reason ilike '%duplicate%' or tc.meta->>'possible_qbo_duplicate'='true'
          or tc.meta->>'duplicate_risk'='true' or bt.raw->>'possible_qbo_duplicate'='true'
          or matches.ambiguous then 'possible_qbo_duplicate'
        when bt.is_archived or bt.pending or tc.is_archived or bt.accounting_review_required
          or tc.accounting_review_required or tc.post_after is not null
          or coalesce(tc.meta->>'posting_in_progress','false')='true' then 'protected_workflow'
        when q.status='posted' and q.qbo_txn_id is not null then 'existing_posted_receipt'
        when tc.status='posted' and tc.qbo_txn_id is not null and tc.posted_at is not null then 'existing_posted_receipt'
        when tc.status in ('matched','matched_existing_qbo') or tc.reconciled_at is not null
          or matches.confirmed then 'matched_existing_qbo'
        when tc.status in ('excluded','ignored') or (tc.meta->>'is_personal'='true'
          and tc.decided_by='user' and tc.decided_at is not null and tc.review_status='handled') then 'excluded_or_personal'
        when bt.direction is distinct from 'OUTFLOW' or bt.check_number is not null
          or coalesce(bt.transaction_type,'') ~* '(transfer|refund|payroll|tax|loan|payment)'
          or coalesce(bt.name,'') ~* '(\m(transfer|payroll|loan|refund|autopay)\M|DEPOSIT INTUIT|TRAN FEE INTUIT)'
          or coalesce(tc.meta->>'taxonomy_type','') ~* '(transfer|refund|payroll|tax|loan|cc_payment|check)'
          or tc.meta ? 'protected_workflow' or pairs.present then 'protected_workflow'
        when tc.status in ('needs_review','uncategorized') and not (tc.decided_by='user'
          and tc.decided_at is not null and tc.review_status='handled'
          and coalesce(tc.review_reopened_at,'-infinity'::timestamptz)<=tc.decided_at) then 'needs_user_review'
        when nullif(tc.final_qbo_account_id,'') is null then 'needs_user_review'
        when tc.status='handled' and tc.review_status='handled' then 'handled_without_posting'
        when tc.status in ('approved','auto_approved','handled','needs_review') and tc.review_status='handled'
          then 'safe_for_reviewed_release'
        else 'needs_user_review'
      end c
    from public.plaid_recovery_batch_rows br
    join public.plaid_recovery_batches b on b.id=br.batch_id and b.business_id=br.business_id
    left join public.bank_transactions bt on bt.id=coalesce(br.admitted_transaction_id,(br.payload->>'transaction_id')::uuid) and bt.business_id=br.business_id
    left join public.transaction_categorizations tc on tc.transaction_id=bt.id and tc.business_id=bt.business_id
    left join public.bookkeeping_processing_requests r on r.transaction_id=bt.id and r.business_id=bt.business_id
    left join public.qbo_posted_transactions q on q.transaction_id=bt.id and q.business_id=bt.business_id
    left join public.bookkeeping_posting_jobs j on j.transaction_id=bt.id and j.business_id=bt.business_id
    left join lateral (
      select jsonb_agg(to_jsonb(pa) order by pa.id) all_rows,
        (array_agg(pa.status order by pa.attempted_at desc,pa.id desc))[1] latest_status
      from public.bookkeeping_post_attempts pa where pa.business_id=br.business_id and pa.transaction_id=bt.id
    ) attempts on true
    left join lateral (
      select jsonb_agg(jsonb_build_array(to_jsonb(m),
        (select jsonb_agg(to_jsonb(mi) order by mi.id) from public.bank_qbo_match_items mi where mi.business_id=m.business_id and mi.match_id=m.id),
        (select jsonb_agg(to_jsonb(mh) order by mh.id) from public.bank_qbo_match_history mh where mh.business_id=m.business_id and mh.match_id=m.id)) order by m.id) all_rows,
        coalesce(bool_or(m.status='confirmed'),false) confirmed,
        coalesce(bool_or(m.status in ('ambiguous','needs_confirmation','candidate','match_check_unavailable')),false) ambiguous
      from public.bank_qbo_matches m where m.business_id=br.business_id and m.bank_transaction_id=bt.id
    ) matches on true
    left join lateral (
      select jsonb_agg(jsonb_build_array(to_jsonb(p),
        (select jsonb_agg(to_jsonb(pe) order by pe.id) from public.credit_card_payment_pair_events pe where pe.business_id=p.business_id and pe.pair_id=p.id)) order by p.id) all_rows,
        count(*)>0 present
      from public.credit_card_payment_pairs p where p.business_id=br.business_id
        and (p.checking_transaction_id=bt.id or p.credit_card_transaction_id=bt.id)
    ) pairs on true
    where br.business_id=p_business_id and br.batch_id=p_batch_id
      and (b.summary->>'workflow_kind'='residual_orphan' or br.admitted_transaction_id is not null)
  )
  select tid,c,coalesce(is_held,false),coalesce(is_held,false) and c in
    ('existing_posted_receipt','matched_existing_qbo','excluded_or_personal','handled_without_posting','safe_for_reviewed_release'),
    c in ('handled_without_posting','safe_for_reviewed_release'),
    encode(sha256(convert_to(jsonb_build_array(br_json,bt_json,tc_json,r_json,q_json,j_json,attempt_json,match_json,pair_json,c)::text,'UTF8')),'hex'),
    encode(sha256(convert_to(jsonb_build_array(br_json,bt_json,tc_json-'posting_hold_batch_id'-'updated_at',r_json,q_json,j_json,attempt_json,match_json,pair_json)::text,'UTF8')),'hex')
  from evidence order by tid;
$$;

-- Shared with residual recovery; existing RPC names remain compatible.
create or replace function public.protect_plaid_residual_recovery_hold()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare authorized boolean;
begin
  if tg_table_name='transaction_categorizations' then
    if old.posting_hold_batch_id is not null and new.posting_hold_batch_id is distinct from old.posting_hold_batch_id
      and exists(select 1 from public.plaid_recovery_batches where business_id=old.business_id and id=old.posting_hold_batch_id
        and summary->>'workflow_kind' in ('residual_orphan','reviewed_recovery') and posting_hold) then
      select exists(select 1 from public.plaid_recovery_batches b cross join lateral jsonb_each(b.summary->'residual_reconciliations') m
        where b.id=old.posting_hold_batch_id and b.business_id=old.business_id
          and m.value->>'release_txid'=txid_current()::text
          and m.value->'approved_ids' @> jsonb_build_array(old.transaction_id)
          and not(m.value ? 'result')) into authorized;
      if current_user<>'plaid_residual_hold_executor' or not authorized or new.posting_hold_batch_id is not null
        or (to_jsonb(new)-'posting_hold_batch_id'-'updated_at') is distinct from (to_jsonb(old)-'posting_hold_batch_id'-'updated_at') then
        raise exception using errcode='42501',message='plaid_residual_hold_requires_reconciliation';
      end if;
    end if;
  elsif old.summary->>'workflow_kind' in ('residual_orphan','reviewed_recovery') then
    if new.posting_hold is not true or (new.status not in ('preview_ready','imported_held')
      and not(old.summary->>'workflow_kind'='reviewed_recovery' and old.status='preview_ready' and new.status='abandoned' and not(old.summary ? 'applied_at')))
      or new.summary->>'workflow_kind' is distinct from old.summary->>'workflow_kind'
      or new.business_id is distinct from old.business_id or new.plaid_env is distinct from old.plaid_env
      or new.plaid_item_id is distinct from old.plaid_item_id then
      raise exception using errcode='42501',message='plaid_residual_hold_requires_reconciliation';
    end if;
  end if;
  return new;
end;
$$;

-- Shared with residual recovery; existing RPC names remain compatible.
create or replace function public.release_plaid_residual_reconciliation(
  p_business_id uuid,p_plaid_env text,p_account_id text,p_batch_id uuid,p_actor_id uuid,
  p_manifest_id uuid,p_reviewed_ids uuid[],p_attestation jsonb default null,p_execute boolean default false
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  b public.plaid_recovery_batches%rowtype; m jsonb; current_snapshot jsonb; after_snapshot jsonb;
  ids uuid[]; all_ids uuid[]; request_hash text; changed_ids jsonb; result jsonb; n integer; needs_attestation boolean;
begin
  b:=public.assert_plaid_residual_operator_scope(p_business_id,p_plaid_env,p_account_id,p_batch_id,p_actor_id);
  if p_execute is distinct from true then
    return public.preview_plaid_residual_reconciliation(p_business_id,p_plaid_env,p_account_id,p_batch_id,p_actor_id);
  end if;
  select coalesce(array_agg(distinct id order by id),'{}'::uuid[]) into ids from unnest(p_reviewed_ids) id;
  if cardinality(ids)=0 or array_position(ids,null) is not null then
    raise exception using errcode='22023',message='plaid_reconciliation_explicit_rows_required';
  end if;
  if p_attestation is not null and (jsonb_typeof(p_attestation)<>'object'
    or p_attestation - array['performed','ledger','outcome','reviewed_at'] <> '{}'::jsonb
    or p_attestation->'performed' is distinct from 'true'::jsonb or p_attestation->>'ledger' is distinct from 'quickbooks_live'
    or p_attestation->>'outcome' is distinct from 'no_unrepresented_duplicate'
    or nullif(p_attestation->>'reviewed_at','') is null) then
    raise exception using errcode='22023',message='plaid_reconciliation_safe_attestation_required';
  end if;
  request_hash:=encode(sha256(convert_to(jsonb_build_array(ids,p_attestation)::text,'UTF8')),'hex');
  -- Fixed lock order; the Item lock coordinates with sync's owner-scoped lease.
  perform 1 from public.business_profiles where id=p_business_id for update;
  perform 1 from public.plaid_items where business_id=p_business_id and plaid_env=p_plaid_env and plaid_item_id=b.plaid_item_id for update;
  perform 1 from public.plaid_accounts where business_id=p_business_id and plaid_env=p_plaid_env and plaid_account_id=p_account_id for update;
  select * into b from public.plaid_recovery_batches where id=p_batch_id and business_id=p_business_id for update;
  m:=b.summary->'residual_reconciliations'->p_manifest_id::text;
  if m is null or m->>'actor_id' is distinct from p_actor_id::text or m->>'account_id' is distinct from p_account_id
    or m->>'batch_id' is distinct from p_batch_id::text or m->>'business_id' is distinct from p_business_id::text
    or m->>'plaid_env' is distinct from p_plaid_env or m->>'manifest_id' is distinct from p_manifest_id::text
    or m->>'created_at' is null or m->>'expires_at' is null then
    raise exception using errcode='22023',message='plaid_reconciliation_manifest_scope_invalid';
  end if;
  if m ? 'result' then
    if m->>'request_hash' is distinct from request_hash then raise exception using errcode='40001',message='plaid_reconciliation_confirmation_reused'; end if;
    return (m->'result')||jsonb_build_object('idempotent',true,'newly_released_count',0);
  end if;
  if (m->>'expires_at')::timestamptz<=clock_timestamp() or (m->>'created_at')::timestamptz+interval '5 minutes'<=clock_timestamp() then
    raise exception using errcode='40001',message='plaid_reconciliation_manifest_expired';
  end if;
  if exists(select 1 from public.business_profiles where id=p_business_id and auto_post_to_quickbooks is distinct from false) then
    raise exception using errcode='42501',message='plaid_reconciliation_disable_posting_required';
  end if;
  if exists(select 1 from public.plaid_items where business_id=p_business_id and plaid_env=p_plaid_env and plaid_item_id=b.plaid_item_id
    and (coalesce(sync_in_progress,false) or sync_lease_owner is not null)) then
    raise exception using errcode='40001',message='plaid_reconciliation_sync_lease_conflict';
  end if;
  perform 1 from public.plaid_recovery_batch_rows where business_id=p_business_id and batch_id=p_batch_id order by id for update;
  select array_agg(coalesce(admitted_transaction_id,(payload->>'transaction_id')::uuid)) into all_ids from public.plaid_recovery_batch_rows where business_id=p_business_id and batch_id=p_batch_id;
  perform 1 from public.bank_transactions where business_id=p_business_id and id=any(all_ids) order by id for update;
  perform 1 from public.transaction_categorizations where business_id=p_business_id and transaction_id=any(all_ids) order by id for update;
  perform 1 from public.bookkeeping_processing_requests where business_id=p_business_id and transaction_id=any(all_ids) order by id for update;
  perform 1 from public.qbo_posted_transactions where business_id=p_business_id and transaction_id=any(all_ids) order by id for update;
  perform 1 from public.bookkeeping_posting_jobs where business_id=p_business_id and transaction_id=any(all_ids) order by id for update;
  perform 1 from public.bookkeeping_post_attempts where business_id=p_business_id and transaction_id=any(all_ids) order by id for update;
  perform 1 from public.bank_qbo_matches where business_id=p_business_id and bank_transaction_id=any(all_ids) order by id for update;
  perform 1 from public.bank_qbo_match_items where business_id=p_business_id and match_id in
    (select id from public.bank_qbo_matches where business_id=p_business_id and bank_transaction_id=any(all_ids)) order by id for update;
  perform 1 from public.bank_qbo_match_history where business_id=p_business_id and match_id in
    (select id from public.bank_qbo_matches where business_id=p_business_id and bank_transaction_id=any(all_ids)) order by id for update;
  perform 1 from public.credit_card_payment_pairs where business_id=p_business_id and (checking_transaction_id=any(all_ids) or credit_card_transaction_id=any(all_ids)) order by id for update;
  perform 1 from public.credit_card_payment_pair_events where business_id=p_business_id and transaction_id=any(all_ids) order by id for update;
  current_snapshot:=public.plaid_residual_reconciliation_snapshot(p_business_id,p_plaid_env,p_account_id,p_batch_id);
  if current_snapshot->>'fingerprint' is distinct from m->'before'->>'fingerprint' then
    select coalesce(jsonb_agg(c->'transaction_id'),'[]') into changed_ids from jsonb_array_elements(current_snapshot->'rows') c
      where not exists(select 1 from jsonb_array_elements(m->'before'->'rows') old_row
        where old_row->>'transaction_id'=c->>'transaction_id' and old_row->>'evidence_fingerprint'=c->>'evidence_fingerprint');
    raise exception using errcode='40001',message='plaid_reconciliation_evidence_changed',
      detail=jsonb_build_object('classification','evidence_changed','changed_transaction_ids',changed_ids)::text;
  end if;
  if exists(select 1 from unnest(ids) id where not exists(select 1 from jsonb_array_elements(current_snapshot->'rows') row
    where row->>'transaction_id'=id::text and (row->>'releasable')::boolean)) then
    raise exception using errcode='40001',message='plaid_reconciliation_selected_row_blocked';
  end if;
  select coalesce(bool_or((row->>'requires_live_qbo_attestation')::boolean),false) into needs_attestation
    from jsonb_array_elements(current_snapshot->'rows') row where (row->>'transaction_id')::uuid=any(ids);
  if needs_attestation and p_attestation is null then
    raise exception using errcode='42501',message='plaid_reconciliation_live_qbo_attestation_required';
  end if;
  if p_attestation is not null and ((p_attestation->>'reviewed_at')::timestamptz < (m->>'created_at')::timestamptz
    or (p_attestation->>'reviewed_at')::timestamptz>clock_timestamp()) then
    raise exception using errcode='22023',message='plaid_reconciliation_attestation_time_invalid';
  end if;
  m:=m||jsonb_build_object('approved_ids',ids,'release_txid',txid_current()::text,'request_hash',request_hash,
    'attestation',p_attestation,'confirmed_by',p_actor_id,'confirmed_at',clock_timestamp());
  update public.plaid_recovery_batches set summary=jsonb_set(summary,array['residual_reconciliations',p_manifest_id::text],m) where id=p_batch_id;
  n:=public.clear_approved_plaid_residual_holds(p_business_id,p_batch_id,p_manifest_id,ids);
  if n<>cardinality(ids) then raise exception using errcode='40001',message='plaid_reconciliation_exact_hold_required'; end if;
  after_snapshot:=public.plaid_residual_reconciliation_snapshot(p_business_id,p_plaid_env,p_account_id,p_batch_id);
  if (after_snapshot->>'auto_post_disabled')::boolean is distinct from true then raise exception using errcode='40001',message='plaid_reconciliation_unexpected_side_effect'; end if;
  if exists(select 1 from jsonb_array_elements(current_snapshot->'rows') old_row
    join jsonb_array_elements(after_snapshot->'rows') new_row on old_row->>'transaction_id'=new_row->>'transaction_id'
    where old_row->>'non_hold_fingerprint' is distinct from new_row->>'non_hold_fingerprint') then
    raise exception using errcode='40001',message='plaid_reconciliation_unexpected_side_effect';
  end if;
  result:=jsonb_build_object('dry_run',false,'idempotent',false,'newly_released_count',n,'released_transaction_ids',ids,
    'batch_id',p_batch_id,'manifest_id',p_manifest_id,'business_id',p_business_id,'account_id',p_account_id,'actor_id',p_actor_id,
    'released_at',clock_timestamp(),'before',current_snapshot,'after',after_snapshot);
  m:=m||jsonb_build_object('result',result);
  update public.plaid_recovery_batches set summary=jsonb_set(summary,array['residual_reconciliations',p_manifest_id::text],m) where id=p_batch_id;
  return result;
end;
$$;

-- Shared with residual recovery; existing RPC names remain compatible.
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
    -- Ledger reconciliation and held cohorts remain relevant after a bank row
    -- is archived. Imported date/count metrics above remain active-only.
    metrics := metrics || jsonb_build_object(
      'recovery_gap_review_count',(select count(*) from public.plaid_recovery_batches g where g.business_id=p_business_id
        and g.plaid_env=p_plaid_env and g.plaid_item_id=a.plaid_item_id and g.summary->>'workflow_kind'='reviewed_recovery'
        and g.summary->'before'->>'account_id'=a.plaid_account_id and g.status='preview_ready'),
      'posting_hold_count',(select count(*) from public.transaction_categorizations tc
        join public.bank_transactions bt on bt.id=tc.transaction_id and bt.business_id=tc.business_id
        join public.plaid_recovery_batches rb on rb.id=tc.posting_hold_batch_id and rb.business_id=tc.business_id
        where tc.business_id=p_business_id and bt.plaid_env=p_plaid_env and bt.plaid_account_id=a.plaid_account_id and rb.posting_hold),
      'receipt_reconciliation_count',(select count(*) from public.qbo_posted_transactions q
        join public.bank_transactions bt on bt.id=q.transaction_id and bt.business_id=q.business_id
        where q.business_id=p_business_id and bt.plaid_env=p_plaid_env and bt.plaid_account_id=a.plaid_account_id
          and q.qbo_env=p_qbo_env and q.status in ('pending','unknown','processing'))
    );
    accounts := accounts || jsonb_build_array(jsonb_build_object(
      'account',jsonb_build_object('id',a.plaid_account_id,'plaid_item_id',a.plaid_item_id,'name',a.name,'mask',a.mask,
        'connection_state',a.connection_state,'is_active',a.is_active,'disconnected_at',a.disconnected_at,'updated_at',a.updated_at,
        'plaid_env',a.plaid_env,'plaid_account_id',a.plaid_account_id,'official_name',a.official_name,'type',a.type,'subtype',a.subtype,
        'current_balance',a.current_balance,'available_balance',a.available_balance,'iso_currency_code',a.iso_currency_code,
        'connected_at',a.connected_at,'created_at',a.created_at,'last_sync_at',a.last_sync_at,'connection_state_version',a.connection_state_version,
        'reconnected_at',a.reconnected_at,'sync_gap_started_at',a.sync_gap_started_at,'sync_gap_last_event_at',a.sync_gap_last_event_at,'sync_gap_event_count',a.sync_gap_event_count),
      'item',jsonb_build_object('institution_id',i.institution_id,'institution_name',i.institution_name,'reconnect_state',i.reconnect_state,'status',i.status,
        'is_active',i.is_active,'disconnected_at',i.disconnected_at,'error_code',i.error_code,'updated_at',i.updated_at,
        'last_success_at',i.last_success_at),
      'latest_run',latest,'last_checkpoint',successful,'metrics',metrics,
      'mapped_to_qbo',exists(select 1 from public.plaid_qbo_account_mappings where business_id=p_business_id and plaid_account_id=a.plaid_account_id),
      'auto_post_enabled',coalesce(policy,false),'qbo_token_status',token_status,'qbo_token_active',token_active,'qbo_token_status_at',token_at,'qbo_token_connected_at',token_connected_at));
  end loop;
  return jsonb_build_object('observed_at',now(),'accounts',accounts);
end;
$$;

-- Identity mutations remain explicit and operator-only, including the inner RPC.
create or replace function public.confirm_plaid_replacement_account_lineage(
  p_business_id uuid,
  p_plaid_env text,
  p_plaid_item_id text,
  p_candidate_id uuid,
  p_prior_plaid_account_id text,
  p_actor_user_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_candidate public.plaid_replacement_account_candidates%rowtype;
  v_prior public.plaid_accounts%rowtype;
  v_mapping public.plaid_qbo_account_mappings%rowtype;
  v_now timestamptz := now();
begin
  perform public.assert_plaid_recovery_operator(p_actor_user_id);
  select * into v_candidate from public.plaid_replacement_account_candidates
   where id = p_candidate_id and business_id = p_business_id and plaid_env = p_plaid_env
     and plaid_item_id = p_plaid_item_id for update;
  if not found then raise exception 'replacement_candidate_not_found'; end if;

  select * into v_prior from public.plaid_accounts
   where business_id = p_business_id and plaid_env = p_plaid_env
     and plaid_account_id = p_prior_plaid_account_id and is_active is true;
  if not found or v_prior.physical_account_id is null then raise exception 'prior_account_not_found'; end if;

  select * into v_mapping from public.plaid_qbo_account_mappings
   where business_id = p_business_id and plaid_account_id = p_prior_plaid_account_id;
  if not found or v_mapping.qbo_account_id is null then raise exception 'prior_account_qbo_mapping_required'; end if;

  if exists(select 1 from public.plaid_accounts where business_id=p_business_id and plaid_account_id=v_candidate.plaid_account_id
      and (plaid_env is distinct from p_plaid_env or (physical_account_id is not null and physical_account_id<>v_prior.physical_account_id)))
    or exists(select 1 from public.plaid_qbo_account_mappings where business_id=p_business_id and plaid_account_id=v_candidate.plaid_account_id
      and qbo_account_id is distinct from v_mapping.qbo_account_id) then
    raise exception 'plaid_recovery_existing_ledger_identity_conflict'; end if;

  insert into public.plaid_accounts (
    business_id, plaid_item_id, plaid_env, plaid_account_id, physical_account_id,
    name, official_name, mask, type, subtype, is_active, connected_at, updated_at,
    relink_status, relink_confidence, relink_candidate_ids
  ) values (
    p_business_id, p_plaid_item_id, p_plaid_env, v_candidate.plaid_account_id, v_prior.physical_account_id,
    coalesce(v_candidate.account_snapshot->>'name', v_candidate.account_snapshot->>'official_name', 'Replacement account'),
    v_candidate.account_snapshot->>'official_name', v_candidate.account_snapshot->>'mask',
    v_candidate.account_snapshot->>'type', v_candidate.account_snapshot->>'subtype', true, v_now, v_now,
    'linked_existing', 'confirmed', '{}'::uuid[]
  ) on conflict (business_id, plaid_account_id) do update set
    physical_account_id = excluded.physical_account_id, plaid_item_id = excluded.plaid_item_id,
    plaid_env = excluded.plaid_env, is_active = true, relink_status = 'linked_existing',
    relink_confidence = 'confirmed', updated_at = v_now;

  insert into public.plaid_qbo_account_mappings (
    business_id, plaid_account_id, qbo_account_id, qbo_account_name, qbo_account_type, source, confidence
  ) values (
    p_business_id, v_candidate.plaid_account_id, v_mapping.qbo_account_id,
    v_mapping.qbo_account_name, v_mapping.qbo_account_type, 'manual', 'high'
  ) on conflict (business_id, plaid_account_id) do update set
    qbo_account_id = excluded.qbo_account_id, qbo_account_name = excluded.qbo_account_name,
    qbo_account_type = excluded.qbo_account_type, source = excluded.source, confidence = excluded.confidence;

  insert into public.plaid_account_lineage_decisions (
    business_id, plaid_env, physical_account_id, prior_plaid_account_id,
    replacement_plaid_account_id, qbo_account_id, status, source, actor_user_id, metadata
  ) values (
    p_business_id, p_plaid_env, v_prior.physical_account_id, p_prior_plaid_account_id,
    v_candidate.plaid_account_id, v_mapping.qbo_account_id, 'confirmed', 'settings_replacement_recovery',
    p_actor_user_id, jsonb_build_object('candidate_id', p_candidate_id, 'plaid_item_id', p_plaid_item_id)
  ) on conflict (business_id, plaid_env, replacement_plaid_account_id) do nothing;

  update public.plaid_replacement_account_candidates set status = 'confirmed', decided_at = v_now, decided_by = p_actor_user_id
   where id = p_candidate_id and business_id = p_business_id;

  return jsonb_build_object('status','confirmed','candidate_id',p_candidate_id,
    'replacement_plaid_account_id',v_candidate.plaid_account_id,'prior_plaid_account_id',p_prior_plaid_account_id,
    'qbo_account_id',v_mapping.qbo_account_id);
end $$;


notify pgrst, 'reload schema';
