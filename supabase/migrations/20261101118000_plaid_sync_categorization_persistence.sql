-- Idempotently restore the invariant that every admitted Plaid bank transaction
-- has one bookkeeping categorization before the Item cursor may advance.

create or replace function public.ensure_plaid_transaction_categorizations(
  p_business_id uuid,
  p_transaction_ids uuid[]
) returns table(expected_count integer, categorization_count integer, inserted_count integer)
language plpgsql
security definer
set search_path = public, pg_temp
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

  -- Preserve the established retry semantics without replacing any existing
  -- category, review decision, posting receipt, or audit identity.
  update public.transaction_categorizations tc
     set is_archived = false,
         archived_at = null,
         updated_at = now()
   where tc.business_id = p_business_id
     and tc.transaction_id = any(p_transaction_ids)
     and (tc.is_archived = true or tc.archived_at is not null);

  update public.transaction_categorizations tc
     set status = 'needs_review',
         post_after = null,
         post_error = 'plaid_accounting_review_required',
         accounting_review_required = true,
         accounting_review_reason = 'plaid_relink_duplicate_review_required',
         updated_at = now()
    from public.bank_transactions bt
   where tc.business_id = p_business_id
     and tc.transaction_id = bt.id
     and bt.business_id = p_business_id
     and bt.id = any(p_transaction_ids)
     and bt.accounting_review_required = true;

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
