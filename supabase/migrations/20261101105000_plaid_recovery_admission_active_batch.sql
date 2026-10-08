-- Admit a valid rebuilt preview when the item-level marker still says
-- ready_for_preview. The locked preview_ready batch is the admission authority.
-- No data is imported by this migration.

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
  if coalesce(cardinality(p_selected_row_ids),0) = 0 then raise exception 'recovery_selection_required'; end if;
  select count(distinct x) into v_selected from unnest(p_selected_row_ids) x;
  if v_selected <> cardinality(p_selected_row_ids) then raise exception 'duplicate_recovery_row_selection'; end if;

  select * into v_batch from public.plaid_recovery_batches
   where id=p_batch_id and business_id=p_business_id and plaid_item_id=p_plaid_item_id for update;
  if not found then raise exception 'recovery_batch_not_found'; end if;
  if v_batch.status='imported_held' then
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

  update public.plaid_items set cursor=v_batch.staged_next_cursor,replacement_recovery_status='imported_held',updated_at=now()
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

notify pgrst, 'reload schema';
