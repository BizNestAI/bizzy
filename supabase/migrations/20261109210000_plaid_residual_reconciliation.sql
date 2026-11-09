-- Operator reconciliation only. No provider calls, posting or historical repair.
-- Existing recovery summary stores expiring manifests and immutable release results.
do $$ begin
  if not exists(select 1 from pg_roles where rolname='plaid_residual_hold_executor') then
    create role plaid_residual_hold_executor nologin noinherit;
  end if;
end $$;
do $$ begin
  if exists(select 1 from pg_roles where rolname='plaid_residual_hold_executor'
      and (rolcanlogin or rolinherit or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)) then
    raise exception 'plaid_residual_executor_role_attributes_invalid';
  end if;
end $$;
revoke plaid_residual_hold_executor from service_role,anon,authenticated;
grant usage on schema public to plaid_residual_hold_executor;
grant select on public.transaction_categorizations, public.plaid_recovery_batches to plaid_residual_hold_executor;
grant update(posting_hold_batch_id) on public.transaction_categorizations to plaid_residual_hold_executor;
create policy residual_executor_read_categories on public.transaction_categorizations
  for select to plaid_residual_hold_executor using(true);
create policy residual_executor_clear_exact_hold on public.transaction_categorizations
  for update to plaid_residual_hold_executor using(true) with check(true);
create policy residual_executor_read_manifests on public.plaid_recovery_batches
  for select to plaid_residual_hold_executor using(true);

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
    and plaid_env=p_plaid_env and summary->>'workflow_kind'='residual_orphan'
    and summary->'before'->>'account_id'=p_account_id and status='imported_held'
    and posting_hold and summary ? 'applied_at' and summary ? 'applied_count';
  if not found or not exists(select 1 from public.plaid_accounts where business_id=p_business_id
    and plaid_env=p_plaid_env and plaid_account_id=p_account_id and plaid_item_id=b.plaid_item_id) then
    raise exception using errcode='22023',message='plaid_reconciliation_scope_or_admission_invalid';
  end if;
  if (b.summary->>'applied_count')::integer<>(select count(*) from public.plaid_recovery_batch_rows
      where business_id=p_business_id and batch_id=b.id) then
    raise exception using errcode='40001',message='plaid_reconciliation_cohort_invalid';
  end if;
  return b;
end;
$$;

create or replace function public.plaid_residual_reconciliation_rows(p_business_id uuid,p_batch_id uuid)
returns table(transaction_id uuid,classification text,held boolean,releasable boolean,
  requires_live_qbo_attestation boolean,evidence_fingerprint text,non_hold_fingerprint text)
language sql stable security definer set search_path=pg_catalog,public as $$
  with evidence as (
    select (br.payload->>'transaction_id')::uuid tid, tc.posting_hold_batch_id=p_batch_id is_held,
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
    left join public.bank_transactions bt on bt.id=(br.payload->>'transaction_id')::uuid and bt.business_id=br.business_id
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
  )
  select tid,c,coalesce(is_held,false),coalesce(is_held,false) and c in
    ('existing_posted_receipt','matched_existing_qbo','excluded_or_personal','handled_without_posting','safe_for_reviewed_release'),
    c in ('handled_without_posting','safe_for_reviewed_release'),
    encode(sha256(convert_to(jsonb_build_array(br_json,bt_json,tc_json,r_json,q_json,j_json,attempt_json,match_json,pair_json,c)::text,'UTF8')),'hex'),
    encode(sha256(convert_to(jsonb_build_array(br_json,bt_json,tc_json-'posting_hold_batch_id'-'updated_at',r_json,q_json,j_json,attempt_json,match_json,pair_json)::text,'UTF8')),'hex')
  from evidence order by tid;
$$;

create or replace function public.plaid_residual_reconciliation_snapshot(p_business_id uuid,p_plaid_env text,p_account_id text,p_batch_id uuid)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
  with rows as (select * from public.plaid_residual_reconciliation_rows(p_business_id,p_batch_id)),
  scope as (select b.*,bp.auto_post_to_quickbooks,to_jsonb(a) account_json,
      jsonb_build_object('status',i.status,'is_active',i.is_active,'sync_lease_owner',i.sync_lease_owner,
        'sync_in_progress',i.sync_in_progress,'sync_lease_expires_at',i.sync_lease_expires_at,'last_success_at',i.last_success_at,
        'cursor_sha256',encode(sha256(convert_to(coalesce(i.cursor,''),'UTF8')),'hex')) item_json
    from public.plaid_recovery_batches b join public.business_profiles bp on bp.id=b.business_id
    join public.plaid_accounts a on a.business_id=b.business_id and a.plaid_env=b.plaid_env and a.plaid_account_id=p_account_id and a.plaid_item_id=b.plaid_item_id
    join public.plaid_items i on i.business_id=b.business_id and i.plaid_env=b.plaid_env and i.plaid_item_id=b.plaid_item_id
    where b.id=p_batch_id and b.business_id=p_business_id and b.plaid_env=p_plaid_env)
  select jsonb_build_object('observed_at',now(),'batch_id',p_batch_id,'account_id',p_account_id,
    'auto_post_disabled',not s.auto_post_to_quickbooks,'row_count',(select count(*) from rows),
    'held_count',(select count(*) from rows where held),'releasable_count',(select count(*) from rows where releasable),
    'classifications',coalesce((select jsonb_object_agg(classification,n) from (select classification,count(*) n from rows where held group by classification) counts),'{}'),
    'rows',coalesce((select jsonb_agg(to_jsonb(r) order by transaction_id) from rows r),'[]'),
    'fingerprint',encode(sha256(convert_to(jsonb_build_array(s.business_id,s.plaid_env,s.plaid_item_id,s.status,s.posting_hold,
      s.created_by,s.created_at,s.summary-'residual_reconciliations',s.auto_post_to_quickbooks,s.account_json,s.item_json,
      (select string_agg(evidence_fingerprint,',' order by transaction_id) from rows))::text,'UTF8')),'hex'))
  from scope s;
$$;

create or replace function public.preview_plaid_residual_reconciliation(
  p_business_id uuid,p_plaid_env text,p_account_id text,p_batch_id uuid,p_actor_id uuid
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare b public.plaid_recovery_batches%rowtype; snapshot jsonb; manifests jsonb; m jsonb; manifest_id uuid;
begin
  b:=public.assert_plaid_residual_operator_scope(p_business_id,p_plaid_env,p_account_id,p_batch_id,p_actor_id);
  select * into b from public.plaid_recovery_batches where id=b.id and business_id=p_business_id for update;
  snapshot:=public.plaid_residual_reconciliation_snapshot(p_business_id,p_plaid_env,p_account_id,p_batch_id);
  manifests:=coalesce(b.summary->'residual_reconciliations','{}');
  select value into m from jsonb_each(manifests) where value->>'actor_id'=p_actor_id::text
    and value->'before'->>'fingerprint'=snapshot->>'fingerprint' and not(value ? 'result')
    and (value->>'expires_at')::timestamptz>clock_timestamp() order by value->>'created_at' desc limit 1;
  if m is not null then return m||jsonb_build_object('dry_run',true,'idempotent',true); end if;
  manifest_id:=gen_random_uuid();
  m:=jsonb_build_object('manifest_id',manifest_id,'batch_id',p_batch_id,'business_id',p_business_id,
    'plaid_env',p_plaid_env,'account_id',p_account_id,'actor_id',p_actor_id,'created_at',clock_timestamp(),
    'expires_at',clock_timestamp()+interval '5 minutes','before',snapshot);
  update public.plaid_recovery_batches set summary=summary||jsonb_build_object('residual_reconciliations',
    manifests||jsonb_build_object(manifest_id::text,m)) where id=p_batch_id and business_id=p_business_id;
  return m||jsonb_build_object('dry_run',true,'idempotent',false);
end;
$$;

-- The helper is NOT executable by service_role, browser roles or PUBLIC.
-- Only the outer vetted reconciliation RPC (owned by postgres) can invoke it.
-- Temporary migration-owner membership permits safe ownership transfer even
-- on managed Postgres. Application roles are never members.
grant plaid_residual_hold_executor to postgres with inherit true, set true;
grant create on schema public to plaid_residual_hold_executor;
create or replace function public.clear_approved_plaid_residual_holds(p_business_id uuid,p_batch_id uuid,p_manifest_id uuid,p_ids uuid[])
returns integer language plpgsql security definer set search_path=pg_catalog,public as $$
declare n integer;
begin
  update public.transaction_categorizations set posting_hold_batch_id=null
    where business_id=p_business_id and posting_hold_batch_id=p_batch_id and transaction_id=any(p_ids)
      and exists(select 1 from public.plaid_recovery_batches b where b.id=p_batch_id and b.business_id=p_business_id
        and b.summary->'residual_reconciliations'->p_manifest_id::text->>'release_txid'=txid_current()::text
        and b.summary->'residual_reconciliations'->p_manifest_id::text->'approved_ids' @> to_jsonb(p_ids));
  get diagnostics n=row_count;
  return n;
end;
$$;
alter function public.clear_approved_plaid_residual_holds(uuid,uuid,uuid,uuid[]) owner to plaid_residual_hold_executor;
revoke create on schema public from plaid_residual_hold_executor;
-- Retain only role-management authority for future reviewed migrations;
-- Never regrant ADMIN to the creator: managed Postgres already grants ADMIN
-- through the bootstrap role. Only adjust this migration's SET/INHERIT grant.
-- Perform function ACL changes before giving up inherited owner privileges.
revoke all on function public.clear_approved_plaid_residual_holds(uuid,uuid,uuid,uuid[]) from public,anon,authenticated,service_role;
grant execute on function public.clear_approved_plaid_residual_holds(uuid,uuid,uuid,uuid[]) to postgres;
grant plaid_residual_hold_executor to postgres with inherit false, set false;


create or replace function public.protect_plaid_residual_recovery_hold()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare authorized boolean;
begin
  if tg_table_name='transaction_categorizations' then
    if old.posting_hold_batch_id is not null and new.posting_hold_batch_id is distinct from old.posting_hold_batch_id
      and exists(select 1 from public.plaid_recovery_batches where business_id=old.business_id and id=old.posting_hold_batch_id
        and summary->>'workflow_kind'='residual_orphan' and posting_hold) then
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
  select array_agg((payload->>'transaction_id')::uuid) into all_ids from public.plaid_recovery_batch_rows where business_id=p_business_id and batch_id=p_batch_id;
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

create or replace function public.enforce_bookkeeping_review_posting_state()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_explicit_undo boolean := false;
  v_documented_reopen boolean :=
    coalesce((new.meta ->> 'review_reopen_authorized')::boolean, false)
    and nullif(new.meta ->> 'review_reopen_reason', '') is not null;
begin
  -- A reviewed hold-only release must not recalculate review/posting decisions.
  -- This non-login owner is reachable only through the private vetted helper.
  if current_user = 'plaid_residual_hold_executor' and tg_op = 'UPDATE'
     and old.posting_hold_batch_id is not null and new.posting_hold_batch_id is null
     and (to_jsonb(new)-'posting_hold_batch_id'-'updated_at') = (to_jsonb(old)-'posting_hold_batch_id'-'updated_at') then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    v_explicit_undo :=
      new.decided_by = 'user'
      and new.final_qbo_account_id is null
      and new.final_qbo_account_name is null
      and new.post_error is null
      and new.decided_at is distinct from old.decided_at;
  end if;

  if tg_op = 'UPDATE'
     and (old.status = 'posted' or old.qbo_txn_id is not null or old.posted_at is not null)
     and new.status in ('needs_review', 'uncategorized') then
    -- Undo never voids a QBO entity. A posted row cannot become reviewable or
    -- post-eligible again while durable posting evidence remains.
    new.status := old.status;
    new.review_status := 'handled';
    new.reviewed_at := old.reviewed_at;
    new.final_qbo_account_id := old.final_qbo_account_id;
    new.final_qbo_account_name := old.final_qbo_account_name;
    new.final_canonical_account_key := old.final_canonical_account_key;
    new.decided_by := old.decided_by;
    new.decided_at := old.decided_at;
  elsif tg_op = 'UPDATE'
     and old.review_status = 'handled'
     and new.status in ('needs_review', 'uncategorized')
     and not v_explicit_undo
     and not v_documented_reopen then
    -- Stale suggestion/sync/worker writes may update operational metadata, but
    -- they may not erase a completed human review decision.
    new.status := old.status;
    new.review_status := 'handled';
    new.reviewed_at := old.reviewed_at;
    new.final_qbo_account_id := old.final_qbo_account_id;
    new.final_qbo_account_name := old.final_qbo_account_name;
    new.final_canonical_account_key := old.final_canonical_account_key;
    new.decided_by := old.decided_by;
    new.decided_at := old.decided_at;
  elsif new.status in ('approved', 'auto_approved', 'handled', 'failed', 'posted', 'matched', 'matched_existing_qbo', 'ignored') then
    new.review_status := 'handled';
    new.reviewed_at := coalesce(old.reviewed_at, new.decided_at, new.posted_at, now());
  else
    new.review_status := 'needs_review';
    if tg_op = 'UPDATE' and old.review_status = 'handled' then
      new.review_reopened_at := now();
      new.review_reopen_reason := coalesce(new.meta ->> 'review_reopen_reason', 'user_undo');
    end if;
  end if;

  new.posting_status := case
    when new.status = 'posted' or new.qbo_txn_id is not null then 'posted'
    when new.status in ('matched', 'matched_existing_qbo') then 'not_scheduled'
    when new.status = 'failed' or new.post_error is not null then 'posting_failed'
    when coalesce((new.meta ->> 'posting_in_progress')::boolean, false) then 'posting'
    when new.post_after is not null then 'scheduled'
    else 'not_scheduled'
  end;
  return new;
end;
$$;

revoke all on function public.assert_plaid_residual_operator_scope(uuid,text,text,uuid,uuid) from public,anon,authenticated;
revoke all on function public.plaid_residual_reconciliation_rows(uuid,uuid) from public,anon,authenticated;
revoke all on function public.plaid_residual_reconciliation_snapshot(uuid,text,text,uuid) from public,anon,authenticated;
revoke all on function public.preview_plaid_residual_reconciliation(uuid,text,text,uuid,uuid) from public,anon,authenticated;
revoke all on function public.release_plaid_residual_reconciliation(uuid,text,text,uuid,uuid,uuid,uuid[],jsonb,boolean) from public,anon,authenticated;
grant execute on function public.preview_plaid_residual_reconciliation(uuid,text,text,uuid,uuid) to service_role;
grant execute on function public.release_plaid_residual_reconciliation(uuid,text,text,uuid,uuid,uuid,uuid[],jsonb,boolean) to service_role;
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
notify pgrst,'reload schema';
