-- Atomic batch tax classification override application.
-- Forward-only RPC addition for selected-transaction review confirmations.

begin;

create or replace function public.apply_tax_classification_override_batch(
  p_business_id uuid,
  p_tax_year integer,
  p_actor_user_id uuid,
  p_override_source text,
  p_override_reason text,
  p_items jsonb
)
returns setof public.transaction_tax_classifications
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_item jsonb;
  v_current public.transaction_tax_classifications%rowtype;
  v_updated public.transaction_tax_classifications%rowtype;
  v_previous_values jsonb;
  v_new_values jsonb;
  v_effective_user_override boolean;
  v_effective_cpa_override boolean;
  v_seen uuid[] := array[]::uuid[];
  v_transaction_id uuid;
  v_classification_id uuid;
  v_expected_updated_at timestamptz;
begin
  if p_business_id is null then
    raise exception 'invalid_tax_classification_override_batch: business_id is required'
      using errcode = '22023';
  end if;

  if p_tax_year is null or p_tax_year < 2000 or p_tax_year > 2100 then
    raise exception 'invalid_tax_classification_override_batch: tax_year must be between 2000 and 2100'
      using errcode = '22023';
  end if;

  if p_override_reason is null or length(trim(p_override_reason)) = 0 then
    raise exception 'invalid_tax_classification_override_batch: override_reason is required'
      using errcode = '22023';
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 100 then
    raise exception 'invalid_tax_classification_override_batch: items must contain 1 through 100 selected classifications'
      using errcode = '22023';
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_transaction_id := nullif(v_item->>'transaction_id', '')::uuid;
    v_classification_id := nullif(v_item->>'classification_id', '')::uuid;
    if v_transaction_id is null or v_classification_id is null then
      raise exception 'invalid_tax_classification_override_batch: classification_id and transaction_id are required'
        using errcode = '22023';
    end if;
    if v_transaction_id = any(v_seen) then
      raise exception 'invalid_tax_classification_override_batch: duplicate transaction_id'
        using errcode = '22023';
    end if;
    v_seen := array_append(v_seen, v_transaction_id);

    if nullif(v_item->>'deductible_percent', '')::numeric < 0
       or nullif(v_item->>'deductible_percent', '')::numeric > 100 then
      raise exception 'invalid_tax_classification_override_batch: deductible_percent must be between 0 and 100'
        using errcode = '22023';
    end if;

    if (v_item->>'classification_status') not in ('needs_review', 'auto_classified', 'user_confirmed', 'cpa_confirmed', 'excluded') then
      raise exception 'invalid_tax_classification_override_batch: invalid classification_status'
        using errcode = '22023';
    end if;

    if (v_item->>'deductibility_status') not in (
      'fully_deductible',
      'partially_deductible',
      'nondeductible',
      'capitalizable',
      'balance_sheet',
      'needs_review'
    ) then
      raise exception 'invalid_tax_classification_override_batch: invalid deductibility_status'
        using errcode = '22023';
    end if;

    if (v_item->>'classification_status') = 'cpa_confirmed'
       and coalesce(p_override_source, '') not in ('cpa', 'admin') then
      raise exception 'invalid_tax_classification_override_batch: CPA confirmation requires CPA or admin source'
        using errcode = '22023';
    end if;
  end loop;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_transaction_id := (v_item->>'transaction_id')::uuid;
    v_expected_updated_at := nullif(v_item->>'expected_updated_at', '')::timestamptz;

    select *
      into v_current
    from public.transaction_tax_classifications
    where business_id = p_business_id
      and transaction_id = v_transaction_id
      and tax_year = p_tax_year
    for update;

    if not found then
      raise exception 'classification_not_found'
        using errcode = 'P0002';
    end if;

    if v_current.id is distinct from nullif(v_item->>'classification_id', '')::uuid then
      raise exception 'classification_conflict'
        using errcode = '40001';
    end if;

    if v_expected_updated_at is not null
       and v_current.updated_at is distinct from v_expected_updated_at then
      raise exception 'classification_conflict'
        using errcode = '40001';
    end if;

    v_effective_user_override :=
      coalesce((v_item->>'user_override')::boolean, false)
      or coalesce(v_current.user_override, false)
      or (v_item->>'classification_status') = 'user_confirmed';

    v_effective_cpa_override :=
      coalesce((v_item->>'cpa_override')::boolean, false)
      or coalesce(v_current.cpa_override, false)
      or (v_item->>'classification_status') = 'cpa_confirmed';

    v_previous_values := jsonb_build_object(
      'tax_category', v_current.tax_category,
      'deductibility_status', v_current.deductibility_status,
      'deductible_percent', v_current.deductible_percent,
      'book_amount', v_current.book_amount,
      'deductible_amount', v_current.deductible_amount,
      'nondeductible_amount', v_current.nondeductible_amount,
      'capitalizable_amount', v_current.capitalizable_amount,
      'tax_treatment', v_current.tax_treatment,
      'classification_status', v_current.classification_status,
      'confidence_score', v_current.confidence_score,
      'confidence_level', v_current.confidence_level,
      'source', v_current.source,
      'requires_review', v_current.requires_review,
      'reason', v_current.reason,
      'user_override', v_current.user_override,
      'cpa_override', v_current.cpa_override,
      'metadata', v_current.metadata
    );

    v_new_values := jsonb_build_object(
      'tax_category', v_item->>'tax_category',
      'deductibility_status', v_item->>'deductibility_status',
      'deductible_percent', (v_item->>'deductible_percent')::numeric,
      'book_amount', (v_item->>'book_amount')::numeric,
      'deductible_amount', (v_item->>'deductible_amount')::numeric,
      'nondeductible_amount', (v_item->>'nondeductible_amount')::numeric,
      'capitalizable_amount', (v_item->>'capitalizable_amount')::numeric,
      'tax_treatment', coalesce(v_item->'tax_treatment', 'null'::jsonb),
      'classification_status', v_item->>'classification_status',
      'confidence_score', (v_item->>'confidence_score')::numeric,
      'confidence_level', v_item->>'confidence_level',
      'source', v_item->>'source',
      'requires_review', (v_item->>'requires_review')::boolean,
      'reason', v_item->>'reason',
      'user_override', v_effective_user_override,
      'cpa_override', v_effective_cpa_override,
      'metadata', coalesce(v_current.metadata, '{}'::jsonb) || coalesce(v_item->'metadata', '{}'::jsonb)
    );

    insert into public.tax_classification_overrides (
      business_id,
      tax_year,
      transaction_id,
      classification_id,
      previous_values,
      new_values,
      override_source,
      override_reason,
      overridden_by,
      created_at
    )
    values (
      p_business_id,
      p_tax_year,
      v_transaction_id,
      v_current.id,
      v_previous_values,
      v_new_values,
      p_override_source,
      p_override_reason,
      p_actor_user_id,
      now()
    );

    update public.transaction_tax_classifications
    set
      tax_category = v_item->>'tax_category',
      deductibility_status = v_item->>'deductibility_status',
      deductible_percent = (v_item->>'deductible_percent')::numeric,
      book_amount = (v_item->>'book_amount')::numeric,
      deductible_amount = (v_item->>'deductible_amount')::numeric,
      nondeductible_amount = (v_item->>'nondeductible_amount')::numeric,
      capitalizable_amount = (v_item->>'capitalizable_amount')::numeric,
      tax_treatment = coalesce(v_item->'tax_treatment', 'null'::jsonb),
      classification_status = v_item->>'classification_status',
      confidence_score = (v_item->>'confidence_score')::numeric,
      confidence_level = v_item->>'confidence_level',
      source = v_item->>'source',
      requires_review = (v_item->>'requires_review')::boolean,
      reason = v_item->>'reason',
      user_override = v_effective_user_override,
      cpa_override = v_effective_cpa_override,
      metadata = coalesce(metadata, '{}'::jsonb) || coalesce(v_item->'metadata', '{}'::jsonb),
      updated_at = now()
    where id = v_current.id
    returning * into v_updated;

    return next v_updated;
  end loop;
end;
$$;

revoke all on function public.apply_tax_classification_override_batch(
  uuid, integer, uuid, text, text, jsonb
) from public;
revoke all on function public.apply_tax_classification_override_batch(
  uuid, integer, uuid, text, text, jsonb
) from anon;
revoke all on function public.apply_tax_classification_override_batch(
  uuid, integer, uuid, text, text, jsonb
) from authenticated;
grant execute on function public.apply_tax_classification_override_batch(
  uuid, integer, uuid, text, text, jsonb
) to service_role;

commit;
