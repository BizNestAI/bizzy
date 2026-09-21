-- Realm-aware, concurrency-safe ownership for locally confirmed QBO matches.
drop index if exists public.bank_qbo_match_items_one_active_one_to_one_target;

create unique index bank_qbo_match_items_one_active_one_to_one_target
  on public.bank_qbo_match_items (business_id, qbo_realm_id, qbo_entity_type, qbo_entity_id)
  where evidence_role = 'primary'
    and active_confirmed = true
    and qbo_realm_id is not null
    and qbo_entity_type in ('Deposit','Payment','SalesReceipt','Purchase','Expense','Check','CreditCardCharge','Bill');

create or replace function public.claim_bank_qbo_match(
  p_business_id uuid,
  p_bank_transaction_id uuid,
  p_match_id uuid,
  p_item_id uuid,
  p_confirmed_at timestamptz,
  p_actor_role text,
  p_meta jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.bank_qbo_match_items%rowtype;
begin
  select * into v_item
  from public.bank_qbo_match_items
  where id = p_item_id and match_id = p_match_id and business_id = p_business_id
  for update;

  if not found then raise exception using errcode = 'P0002', message = 'primary_match_item_missing'; end if;
  if v_item.qbo_realm_id is null then raise exception using errcode = '23502', message = 'qbo_match_realm_required'; end if;

  update public.bank_qbo_match_items
  set active_confirmed = false
  where business_id = p_business_id and match_id = p_match_id;

  begin
    update public.bank_qbo_match_items set active_confirmed = true where id = v_item.id;
  exception when unique_violation then
    raise exception using errcode = '23505', message = 'qbo_entity_already_matched';
  end;

  update public.bank_qbo_matches
  set status = 'confirmed', confirmed_at = p_confirmed_at, updated_at = p_confirmed_at,
      actor_role = p_actor_role, meta = p_meta
  where id = p_match_id and business_id = p_business_id
    and bank_transaction_id = p_bank_transaction_id
    and status in ('needs_confirmation','ambiguous');

  if not found then raise exception using errcode = 'P0001', message = 'match_not_confirmable'; end if;
  return jsonb_build_object('ok', true, 'match_id', p_match_id, 'item_id', v_item.id);
end;
$$;

revoke all on function public.claim_bank_qbo_match(uuid,uuid,uuid,uuid,timestamptz,text,jsonb) from public, anon, authenticated;
grant execute on function public.claim_bank_qbo_match(uuid,uuid,uuid,uuid,timestamptz,text,jsonb) to service_role;
