-- Durable, tenant-scoped orchestration for replacement-card recovery.
-- Provider discovery remains in the application preview service; these RPCs only
-- confirm lineage and admit an already staged batch.

alter table public.plaid_recovery_batch_rows
  add column if not exists amount numeric,
  add column if not exists signed_amount numeric,
  add column if not exists pending boolean not null default false;

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

create or replace function public.admit_plaid_recovery_batch(
  p_business_id uuid,
  p_batch_id uuid,
  p_actor_user_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_batch public.plaid_recovery_batches%rowtype;
  v_admitted integer := 0;
  v_blocked integer := 0;
begin
  select * into v_batch from public.plaid_recovery_batches
   where id = p_batch_id and business_id = p_business_id for update;
  if not found then raise exception 'recovery_batch_not_found'; end if;
  if v_batch.status = 'imported_held' then
    return jsonb_build_object('batch_id',p_batch_id,'status','imported_held','posting_hold',true,
      'admitted',coalesce((v_batch.summary->>'admitted')::integer,0),'reused',true);
  end if;
  if v_batch.status <> 'preview_ready' then raise exception 'recovery_batch_not_ready'; end if;

  select count(*) into v_blocked from public.plaid_recovery_batch_rows
   where batch_id = p_batch_id and business_id = p_business_id
     and disposition in ('probable_duplicate','ambiguous');
  if v_blocked > 0 then raise exception 'recovery_batch_requires_review'; end if;

  insert into public.bank_transactions (
    business_id, plaid_item_id, plaid_env, plaid_account_id, physical_account_id,
    plaid_transaction_id, pending_transaction_id, name, merchant_name,
    plaid_amount_raw, amount, signed_amount, direction, iso_currency_code,
    unofficial_currency_code, date, authorized_date, pending, payment_channel,
    transaction_type, check_number, category_primary, category_detailed,
    category_confidence, personal_finance_category, location, counterparties,
    plaid_last_modified_at, last_seen_at, is_archived, raw, updated_at,
    plaid_recovery_batch_id, canonical_source
  )
  select r.business_id, v_batch.plaid_item_id, v_batch.plaid_env, r.plaid_account_id,
    pa.physical_account_id, r.plaid_transaction_id, r.pending_transaction_id,
    coalesce(r.payload->'transaction'->>'name', r.payload->'transaction'->>'merchant_name', 'Transaction'),
    r.payload->'transaction'->>'merchant_name',
    coalesce((r.payload->'transaction'->>'amount')::numeric,0), r.amount, r.signed_amount,
    case when r.signed_amount > 0 then 'INFLOW' when r.signed_amount < 0 then 'OUTFLOW' else 'UNKNOWN' end,
    r.payload->'transaction'->>'iso_currency_code', r.payload->'transaction'->>'unofficial_currency_code',
    r.transaction_date, r.authorized_date, r.pending,
    r.payload->'transaction'->>'payment_channel', r.payload->'transaction'->>'transaction_type',
    r.payload->'transaction'->>'check_number', r.payload->'transaction'->'personal_finance_category'->>'primary',
    r.payload->'transaction'->'personal_finance_category'->>'detailed',
    r.payload->'transaction'->'personal_finance_category'->>'confidence_level',
    r.payload->'transaction'->'personal_finance_category', r.payload->'transaction'->'location',
    r.payload->'transaction'->'counterparties', nullif(coalesce(r.payload->'transaction'->>'timestamp',r.payload->'transaction'->>'datetime'),'')::timestamptz,
    now(), false, r.payload->'transaction', now(), p_batch_id, 'plaid_replacement_recovery'
  from public.plaid_recovery_batch_rows r
  join public.plaid_accounts pa on pa.business_id = r.business_id and pa.plaid_env = v_batch.plaid_env
    and pa.plaid_account_id = r.plaid_account_id and pa.is_active is true
  where r.batch_id = p_batch_id and r.business_id = p_business_id and r.disposition = 'new_after_cutoff'
    and not exists (select 1 from public.bank_transactions bt where bt.business_id = p_business_id
      and bt.plaid_env = v_batch.plaid_env and bt.plaid_transaction_id = r.plaid_transaction_id);
  get diagnostics v_admitted = row_count;

  update public.plaid_recovery_batch_rows r set admitted_transaction_id = bt.id
    from public.bank_transactions bt where r.batch_id = p_batch_id and r.business_id = p_business_id
      and bt.business_id = p_business_id and bt.plaid_env = v_batch.plaid_env
      and bt.plaid_transaction_id = r.plaid_transaction_id and r.disposition = 'new_after_cutoff';

  insert into public.transaction_categorizations (business_id, transaction_id, status, posting_hold_batch_id, meta, updated_at)
  select p_business_id, r.admitted_transaction_id, 'needs_review', p_batch_id,
    jsonb_build_object('plaid_recovery_batch_id',p_batch_id,'recovery_admitted_by',p_actor_user_id), now()
  from public.plaid_recovery_batch_rows r where r.batch_id = p_batch_id and r.business_id = p_business_id
    and r.admitted_transaction_id is not null
  on conflict (business_id, transaction_id) do update set posting_hold_batch_id = p_batch_id, updated_at = now();

  update public.plaid_items set cursor = v_batch.staged_next_cursor, updated_at = now()
   where business_id = p_business_id and plaid_env = v_batch.plaid_env and plaid_item_id = v_batch.plaid_item_id;
  update public.plaid_recovery_batches set status = 'imported_held', posting_hold = true,
    summary = summary || jsonb_build_object('admitted',v_admitted,'admitted_at',now(),'admitted_by',p_actor_user_id), updated_at = now()
   where id = p_batch_id and business_id = p_business_id;
  return jsonb_build_object('batch_id',p_batch_id,'status','imported_held','posting_hold',true,'admitted',v_admitted);
end $$;

revoke all on function public.confirm_plaid_replacement_account_lineage(uuid,text,text,uuid,text,uuid) from public, anon, authenticated;
revoke all on function public.admit_plaid_recovery_batch(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.confirm_plaid_replacement_account_lineage(uuid,text,text,uuid,text,uuid) to service_role;
grant execute on function public.admit_plaid_recovery_batch(uuid,uuid,uuid) to service_role;
