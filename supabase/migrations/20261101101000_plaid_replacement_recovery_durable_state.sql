-- Durable orchestration marker for retained-Item replacement-card repairs.
-- No provider data is fetched and no transaction/cursor/posting state is changed.

alter table public.plaid_items
  add column if not exists replacement_recovery_status text,
  add column if not exists replacement_recovery_account_id text,
  add column if not exists replacement_recovery_cutoff_date date,
  add column if not exists replacement_repair_completed_at timestamptz,
  add column if not exists replacement_recovery_bootstrapped_at timestamptz,
  add column if not exists replacement_recovery_bootstrapped_by uuid,
  add column if not exists replacement_recovery_selected_at timestamptz,
  add column if not exists replacement_recovery_selected_by uuid;

alter table public.plaid_items drop constraint if exists plaid_items_replacement_recovery_status_check;
alter table public.plaid_items add constraint plaid_items_replacement_recovery_status_check check (
  replacement_recovery_status is null or replacement_recovery_status in
    ('awaiting_account_selection','lineage_confirmation_required','ready_for_preview','preview_ready','imported_held','released','failed')
);

create or replace function public.bootstrap_plaid_replacement_recovery(
  p_business_id uuid, p_plaid_env text, p_plaid_item_id text, p_actor_user_id uuid default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_item public.plaid_items%rowtype;
begin
  select * into v_item from public.plaid_items where business_id = p_business_id and plaid_env = p_plaid_env
    and plaid_item_id = p_plaid_item_id and is_active is true for update;
  if not found then raise exception 'plaid_item_not_found'; end if;
  if v_item.replacement_recovery_status is null then
    update public.plaid_items set replacement_recovery_status = 'awaiting_account_selection',
      replacement_recovery_cutoff_date = date '2026-08-27', replacement_recovery_bootstrapped_at = now(),
      replacement_recovery_bootstrapped_by = p_actor_user_id, updated_at = now() where id = v_item.id;
    return jsonb_build_object('status','awaiting_account_selection','cutoff_date','2026-08-27','reused',false);
  end if;
  return jsonb_build_object('status',v_item.replacement_recovery_status,
    'cutoff_date',coalesce(v_item.replacement_recovery_cutoff_date,date '2026-08-27'),'reused',true);
end $$;

create or replace function public.select_plaid_replacement_recovery_account(
  p_business_id uuid, p_plaid_env text, p_plaid_item_id text, p_plaid_account_id text,
  p_actor_user_id uuid default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_item public.plaid_items%rowtype; v_account public.plaid_accounts%rowtype;
  v_mapping public.plaid_qbo_account_mappings%rowtype; v_candidate_id uuid;
begin
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
    replacement_recovery_account_id = p_plaid_account_id, replacement_recovery_cutoff_date = date '2026-08-27',
    replacement_recovery_selected_at = now(), replacement_recovery_selected_by = p_actor_user_id, updated_at = now()
    where id = v_item.id;
  return jsonb_build_object('status','lineage_confirmation_required','candidate_id',v_candidate_id,
    'plaid_account_id',p_plaid_account_id,'qbo_account_id',v_mapping.qbo_account_id);
end $$;

-- Wrap the existing confirmation and durable state transition in one database transaction.
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
  update public.plaid_items set replacement_recovery_status = 'ready_for_preview', updated_at = now()
   where business_id = p_business_id and plaid_env = p_plaid_env and plaid_item_id = p_plaid_item_id
     and replacement_recovery_account_id = v_replacement_account_id and is_active is true;
  get diagnostics affected = row_count;
  if affected <> 1 then raise exception 'lineage_state_persistence_failed'; end if;
  return v_result || jsonb_build_object('orchestration_status','ready_for_preview');
end $$;

revoke all on function public.bootstrap_plaid_replacement_recovery(uuid,text,text,uuid) from public, anon, authenticated;
revoke all on function public.select_plaid_replacement_recovery_account(uuid,text,text,text,uuid) from public, anon, authenticated;
revoke all on function public.confirm_plaid_replacement_lineage_and_advance(uuid,text,text,uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.bootstrap_plaid_replacement_recovery(uuid,text,text,uuid) to service_role;
grant execute on function public.select_plaid_replacement_recovery_account(uuid,text,text,text,uuid) to service_role;
grant execute on function public.confirm_plaid_replacement_lineage_and_advance(uuid,text,text,uuid,text,uuid) to service_role;

notify pgrst, 'reload schema';
