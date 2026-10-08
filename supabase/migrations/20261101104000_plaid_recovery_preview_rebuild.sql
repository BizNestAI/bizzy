alter table public.plaid_recovery_batches
  add column if not exists rebuild_source_batch_id uuid references public.plaid_recovery_batches(id),
  add column if not exists rebuild_idempotency_key text,
  add column if not exists abandoned_at timestamptz,
  add column if not exists abandoned_by uuid;

create unique index if not exists plaid_recovery_rebuild_idempotency_idx
  on public.plaid_recovery_batches (business_id, rebuild_idempotency_key)
  where rebuild_idempotency_key is not null;

create unique index if not exists plaid_recovery_one_active_rebuild_idx
  on public.plaid_recovery_batches (business_id, rebuild_source_batch_id)
  where rebuild_source_batch_id is not null
    and status in ('staging','preview_ready','lineage_confirmation_required','imported_held');

create or replace function public.begin_plaid_recovery_preview_rebuild(
  p_business_id uuid, p_plaid_env text, p_plaid_item_id text, p_batch_id uuid,
  p_actor_user_id uuid, p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_item public.plaid_items%rowtype;
  v_old public.plaid_recovery_batches%rowtype;
  v_existing public.plaid_recovery_batches%rowtype;
  v_expected integer;
  v_staged integer;
  v_admitted integer;
  v_imported integer;
  v_attempts integer;
  v_candidate public.plaid_replacement_account_candidates%rowtype;
  v_lineage public.plaid_account_lineage_decisions%rowtype;
  v_mapping public.plaid_qbo_account_mappings%rowtype;
  v_new_id uuid := gen_random_uuid();
begin
  if nullif(trim(p_idempotency_key), '') is null then raise exception 'recovery_rebuild_idempotency_required'; end if;
  if p_batch_id <> 'b551bd2e-8921-4440-a151-cc70721beb31'::uuid then
    raise exception 'recovery_rebuild_unrelated_batch';
  end if;
  select * into v_item from public.plaid_items
   where business_id=p_business_id and plaid_env=p_plaid_env and plaid_item_id=p_plaid_item_id and is_active=true for update;
  if not found then raise exception 'plaid_item_not_found'; end if;
  if p_business_id <> 'cffc2183-e77c-4148-a206-d5192e090925'::uuid
     or p_plaid_item_id <> '4KNZYd1xn4fZeBMob4RYTwZvwO9ezVSAEwrXe' then
    raise exception 'recovery_rebuild_scope_mismatch';
  end if;
  if v_item.replacement_recovery_status <> 'ready_for_preview'
     or v_item.replacement_recovery_account_id is null
     or v_item.replacement_recovery_cutoff_date <> date '2026-08-27' then
    raise exception 'recovery_rebuild_lineage_not_ready';
  end if;
  select * into v_candidate from public.plaid_replacement_account_candidates
   where business_id=p_business_id and plaid_env=p_plaid_env and plaid_item_id=p_plaid_item_id
     and plaid_account_id=v_item.replacement_recovery_account_id and status='confirmed';
  if not found then raise exception 'recovery_rebuild_lineage_not_confirmed'; end if;
  select * into v_lineage from public.plaid_account_lineage_decisions
   where business_id=p_business_id and plaid_env=p_plaid_env
     and replacement_plaid_account_id=v_item.replacement_recovery_account_id and status='confirmed';
  if not found then raise exception 'recovery_rebuild_lineage_not_confirmed'; end if;
  select * into v_mapping from public.plaid_qbo_account_mappings
   where business_id=p_business_id and plaid_account_id=v_item.replacement_recovery_account_id;
  if not found or v_mapping.qbo_account_id <> v_lineage.qbo_account_id then
    raise exception 'recovery_rebuild_mapping_changed';
  end if;

  select * into v_existing from public.plaid_recovery_batches
   where business_id=p_business_id and rebuild_idempotency_key=p_idempotency_key limit 1;
  if found then return jsonb_build_object('batch_id',v_existing.id,'status',v_existing.status,'created',false,'source_batch_id',v_existing.rebuild_source_batch_id); end if;

  select * into v_old from public.plaid_recovery_batches
   where id=p_batch_id and business_id=p_business_id and plaid_env=p_plaid_env and plaid_item_id=p_plaid_item_id for update;
  if not found then raise exception 'recovery_rebuild_batch_not_found'; end if;
  if v_old.status not in ('preview_ready','failed','abandoned') then raise exception 'recovery_rebuild_batch_not_incomplete'; end if;
  v_expected := coalesce((v_old.summary->>'new_after_cutoff')::integer,(v_old.summary->>'genuinely_new')::integer,0);
  if v_expected <> 113 then raise exception 'recovery_rebuild_expected_count_changed'; end if;
  select count(*) into v_staged from public.plaid_recovery_batch_rows where batch_id=v_old.id and disposition='new_after_cutoff';
  select count(*) into v_admitted from public.plaid_recovery_batch_rows where batch_id=v_old.id and admitted_transaction_id is not null;
  select count(*) into v_imported from public.bank_transactions where business_id=p_business_id and plaid_recovery_batch_id=v_old.id;
  if v_staged <> 0 or v_admitted <> 0 or v_imported <> 0 then raise exception 'recovery_rebuild_batch_has_admission'; end if;
  if v_item.cursor is distinct from v_old.original_cursor then raise exception 'recovery_rebuild_cursor_committed'; end if;
  if exists (select 1 from public.plaid_recovery_batches b where b.business_id=p_business_id and b.plaid_env=p_plaid_env
    and b.plaid_item_id=p_plaid_item_id and b.created_at>v_old.created_at and b.status in ('preview_ready','lineage_confirmation_required','imported_held','released'))
  then raise exception 'recovery_rebuild_newer_batch_exists'; end if;

  if v_old.status <> 'abandoned' then
    update public.plaid_recovery_batches set status='abandoned', abandoned_at=now(), abandoned_by=p_actor_user_id,
      failure_code='eligible_rows_not_staged', failure_detail='Preview summary had 113 eligible rows but no durable transaction details.', updated_at=now()
    where id=v_old.id and status in ('preview_ready','failed');
    if not found then raise exception 'recovery_rebuild_compare_and_swap_failed'; end if;
  end if;

  select * into v_existing from public.plaid_recovery_batches where business_id=p_business_id and rebuild_source_batch_id=v_old.id
    and status in ('staging','preview_ready','lineage_confirmation_required','imported_held') order by created_at desc limit 1;
  if found then return jsonb_build_object('batch_id',v_existing.id,'status',v_existing.status,'created',false,'source_batch_id',v_old.id); end if;

  select count(*) into v_attempts from public.plaid_recovery_batches
   where business_id=p_business_id and rebuild_source_batch_id=v_old.id;
  if v_attempts >= 3 then raise exception 'recovery_rebuild_retry_limit_reached'; end if;

  insert into public.plaid_recovery_batches(id,business_id,plaid_env,plaid_item_id,original_cursor,cutoff_date,status,posting_hold,summary,created_by,rebuild_source_batch_id,rebuild_idempotency_key)
  values(v_new_id,p_business_id,p_plaid_env,p_plaid_item_id,v_old.original_cursor,v_old.cutoff_date,'staging',true,
    jsonb_build_object('rebuild_previous_expected_count',v_expected),p_actor_user_id,v_old.id,p_idempotency_key);
  return jsonb_build_object('batch_id',v_new_id,'status','staging','created',true,'source_batch_id',v_old.id,'previous_expected_count',v_expected);
end $$;

revoke all on function public.begin_plaid_recovery_preview_rebuild(uuid,text,text,uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.begin_plaid_recovery_preview_rebuild(uuid,text,text,uuid,uuid,text) to service_role;
