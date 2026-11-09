-- Idempotently restore the invariant that every admitted Plaid bank transaction
-- has one bookkeeping categorization before the Item cursor may advance.

create or replace function public.ensure_plaid_transaction_categorizations(
  p_business_id uuid,
  p_transaction_ids uuid[]
) returns table(expected_count integer, categorization_count integer, inserted_count integer)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_expected integer;
  v_before integer;
  v_after integer;
begin
  if p_business_id is null then
    raise exception using errcode = '22023', message = 'plaid_categorization_business_required';
  end if;

  select count(*) into v_expected
  from (select distinct unnest(coalesce(p_transaction_ids, '{}'::uuid[])) id) requested;

  if v_expected = 0 then
    return query select 0, 0, 0;
    return;
  end if;

  if (select count(*) from public.bank_transactions bt
      where bt.business_id = p_business_id and bt.id = any(p_transaction_ids)) <> v_expected then
    raise exception using errcode = '23503', message = 'plaid_categorization_transaction_scope_mismatch';
  end if;

  select count(*) into v_before
  from public.transaction_categorizations tc
  where tc.business_id = p_business_id and tc.transaction_id = any(p_transaction_ids);

  insert into public.transaction_categorizations (
    business_id, transaction_id, status, post_after, post_error,
    accounting_review_required, accounting_review_reason, meta
  )
  select
    bt.business_id,
    bt.id,
    'needs_review',
    null,
    case when bt.accounting_review_required then coalesce(bt.accounting_review_reason, 'plaid_accounting_review_required') else null end,
    coalesce(bt.accounting_review_required, false),
    bt.accounting_review_reason,
    case when bt.accounting_review_required then jsonb_build_object(
      'post_block_reason', coalesce(bt.accounting_review_reason, 'plaid_accounting_review_required'),
      'plaid_duplicate_review_required', true,
      'plaid_duplicate_review_payload', bt.accounting_review_payload
    ) else '{}'::jsonb end
  from public.bank_transactions bt
  where bt.business_id = p_business_id and bt.id = any(p_transaction_ids)
  on conflict (business_id, transaction_id) do nothing;

  -- Existing decisions, exclusions, matches, receipts and recovery holds are
  -- authoritative. Review annotations are written separately by sync; admission
  -- must not reset lifecycle state or resurrect removed transactions.

  select count(*) into v_after
  from public.transaction_categorizations tc
  where tc.business_id = p_business_id and tc.transaction_id = any(p_transaction_ids);

  if v_after <> v_expected then
    raise exception using errcode = 'P0001', message = 'plaid_categorization_persistence_incomplete';
  end if;

  return query select v_expected, v_after, v_after - v_before;
end;
$$;

revoke all on function public.ensure_plaid_transaction_categorizations(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.ensure_plaid_transaction_categorizations(uuid, uuid[]) to service_role;

-- No data backfill, provider calls or QBO writes. Admission, Item checkpoint,
-- account timestamps and successful run evidence commit or roll back together.
create or replace function public.complete_plaid_sync_admission(
  p_business_id uuid, p_item_id uuid, p_run_id uuid, p_worker_id text,
  p_original_cursor text, p_next_cursor text, p_transaction_ids uuid[],
  p_completed_at timestamptz, p_added_count integer, p_modified_count integer,
  p_removed_count integer, p_mutation_restarts integer
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_item public.plaid_items%rowtype;
  v_ids uuid[];
  v_admitted integer;
  v_table text; v_column text; v_constraint text; v_message text;
  v_stage text := 'checkpoint_scope';
begin
  select * into v_item from public.plaid_items
   where id = p_item_id and business_id = p_business_id for update;
  if not found or v_item.is_active is false
     or v_item.sync_lease_owner is distinct from p_worker_id
     or v_item.sync_lease_expires_at is null
     or v_item.sync_lease_expires_at <= clock_timestamp()
     or v_item.cursor is distinct from p_original_cursor then
    raise exception using errcode = '40001', message = 'plaid_checkpoint_scope_or_lease_conflict';
  end if;
  perform 1 from public.bank_sync_runs where id = p_run_id
    and business_id = p_business_id and plaid_item_id = v_item.plaid_item_id
    and worker_id = p_worker_id and status = 'running' for update;
  if not found then
    raise exception using errcode = '40001', message = 'plaid_running_attempt_required';
  end if;
  select coalesce(array_agg(distinct id), '{}'::uuid[]) into v_ids
    from unnest(coalesce(p_transaction_ids, '{}'::uuid[])) id;
  if exists (select 1 from unnest(v_ids) requested(id)
    left join public.bank_transactions bt on bt.id = requested.id
      and bt.business_id = p_business_id and bt.plaid_item_id = v_item.plaid_item_id
      and bt.plaid_env = v_item.plaid_env
    where bt.id is null) then
    raise exception using errcode = '23503', message = 'plaid_admission_transaction_scope_mismatch';
  end if;

  v_stage := 'categorization_persistence';
  perform public.ensure_plaid_transaction_categorizations(p_business_id, v_ids);
  v_stage := 'processing_admission';
  -- A worker may already have read an older generation. Merely finding its
  -- request is not admission of the new evidence. Retain the cursor for replay
  -- after that lease completes; never steal/reset its request or lose the wake.
  if exists (select 1 from public.bookkeeping_processing_requests r
    join public.transaction_categorizations tc
      on tc.business_id = r.business_id and tc.transaction_id = r.transaction_id
    where r.business_id = p_business_id and r.transaction_id = any(v_ids)
      and (r.status = 'dead_letter' or (r.status = 'processing'
        and r.metadata->>'plaid_sync_input_cursor_sha256' is distinct from
          encode(sha256(convert_to(coalesce(p_original_cursor, ''), 'UTF8')), 'hex')))
      and tc.status not in ('posted', 'matched', 'matched_existing_qbo', 'excluded', 'ignored')
      and tc.qbo_txn_id is null) then
    raise exception using errcode = '40001', message = 'plaid_processing_request_requires_replay';
  end if;
  insert into public.bookkeeping_processing_requests as existing
    (business_id, transaction_id, scope, status, priority, metadata)
  select p_business_id, bt.id, 'transaction', 'pending', 10,
    jsonb_build_object('source', 'plaid_sync', 'plaid_sync_run_id', p_run_id,
      'plaid_sync_input_cursor_sha256', encode(sha256(convert_to(coalesce(p_original_cursor, ''), 'UTF8')), 'hex'))
    from public.bank_transactions bt where bt.business_id = p_business_id
      and bt.id = any(v_ids) and not bt.is_archived
  on conflict (business_id, transaction_id) do update
    set status = 'pending', process_after = now(), updated_at = now(),
        metadata = coalesce(existing.metadata, '{}'::jsonb) || excluded.metadata
    -- Preserve request identity and historical error evidence. Do not steal
    -- an active lease or reset exhausted retries during duplicate replay.
    where existing.status in ('completed', 'skipped')
      and existing.metadata->>'plaid_sync_input_cursor_sha256'
        is distinct from excluded.metadata->>'plaid_sync_input_cursor_sha256';

  select count(*) into v_admitted from public.bookkeeping_processing_requests r
    join public.bank_transactions bt on bt.id = r.transaction_id and bt.business_id = r.business_id
    where r.business_id = p_business_id and bt.id = any(v_ids) and not bt.is_archived;
  if v_admitted <> (select count(*) from public.bank_transactions where business_id = p_business_id
      and id = any(v_ids) and not is_archived) then
    raise exception using errcode = 'P0001', message = 'plaid_processing_admission_incomplete';
  end if;

  v_stage := 'cursor_commit';
  update public.plaid_accounts set last_sync_at = p_completed_at, updated_at = p_completed_at
    where business_id = p_business_id and plaid_env = v_item.plaid_env
      and plaid_item_id = v_item.plaid_item_id and is_active is true
      and connection_state = 'connected' and disconnected_at is null;
  update public.plaid_items set cursor = p_next_cursor, last_sync_at = p_completed_at,
    last_success_at = p_completed_at, status = 'connected', error_code = null,
    error_message = null, updated_at = p_completed_at
    where id = p_item_id and business_id = p_business_id;
  update public.bank_sync_runs set status = 'completed', finished_at = p_completed_at,
    added_count = p_added_count, modified_count = p_modified_count, removed_count = p_removed_count,
    failure_code = null, error_message = null,
    meta = jsonb_build_object('admitted_count', v_admitted, 'mutation_restarts', p_mutation_restarts,
      'cursor_input_sha256', encode(sha256(convert_to(coalesce(p_original_cursor, ''), 'UTF8')), 'hex'),
      'next_cursor_sha256', encode(sha256(convert_to(coalesce(p_next_cursor, ''), 'UTF8')), 'hex'))
    where id = p_run_id and business_id = p_business_id and worker_id = p_worker_id;
  return jsonb_build_object('admitted_count', v_admitted);
exception when others then
  get stacked diagnostics v_table = table_name, v_column = column_name, v_constraint = constraint_name, v_message = message_text;
  -- Never propagate row values, descriptions or provider payloads in DETAIL.
  raise exception using errcode = sqlstate, message = 'plaid_admission_database_failure',
    detail = jsonb_build_object('table', v_table, 'column', v_column, 'constraint', v_constraint, 'stage', v_stage,
      'reason', case when v_message ~ '^plaid_[a-z_]+$' then v_message else null end)::text;
end;
$$;

revoke all on function public.complete_plaid_sync_admission(uuid,uuid,uuid,text,text,text,uuid[],timestamptz,integer,integer,integer,integer) from public, anon, authenticated;
grant execute on function public.complete_plaid_sync_admission(uuid,uuid,uuid,text,text,text,uuid[],timestamptz,integer,integer,integer,integer) to service_role;

notify pgrst, 'reload schema';
