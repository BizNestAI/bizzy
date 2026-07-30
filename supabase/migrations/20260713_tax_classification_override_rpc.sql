-- Atomic tax classification override application.
-- The API authorizes business access before calling this RPC. The function
-- still scopes and locks by business_id + transaction_id + tax_year so audit
-- history and classification changes commit or roll back together.

create or replace function public.apply_tax_classification_override(
  p_business_id uuid,
  p_tax_year integer,
  p_transaction_id uuid,
  p_actor_user_id uuid,
  p_override_source text,
  p_override_reason text,
  p_tax_category text,
  p_deductibility_status text,
  p_deductible_percent numeric,
  p_tax_treatment jsonb,
  p_classification_status text,
  p_book_amount numeric,
  p_deductible_amount numeric,
  p_nondeductible_amount numeric,
  p_capitalizable_amount numeric,
  p_confidence_score numeric,
  p_confidence_level text,
  p_source text,
  p_requires_review boolean,
  p_reason text,
  p_user_override boolean,
  p_cpa_override boolean,
  p_expected_updated_at timestamptz default null,
  p_metadata jsonb default '{}'::jsonb
)
returns public.transaction_tax_classifications
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_current public.transaction_tax_classifications%rowtype;
  v_updated public.transaction_tax_classifications%rowtype;
  v_previous_values jsonb;
  v_new_values jsonb;
  v_effective_user_override boolean;
  v_effective_cpa_override boolean;
begin
  if p_business_id is null or p_transaction_id is null then
    raise exception 'invalid_tax_classification_override: business_id and transaction_id are required'
      using errcode = '22023';
  end if;

  if p_tax_year is null or p_tax_year < 2000 or p_tax_year > 2100 then
    raise exception 'invalid_tax_classification_override: tax_year must be between 2000 and 2100'
      using errcode = '22023';
  end if;

  if p_override_reason is null or length(trim(p_override_reason)) = 0 then
    raise exception 'invalid_tax_classification_override: override_reason is required'
      using errcode = '22023';
  end if;

  if p_deductible_percent is null or p_deductible_percent < 0 or p_deductible_percent > 100 then
    raise exception 'invalid_tax_classification_override: deductible_percent must be between 0 and 100'
      using errcode = '22023';
  end if;

  if p_deductible_amount is null or p_deductible_amount < 0
     or p_nondeductible_amount is null or p_nondeductible_amount < 0
     or p_capitalizable_amount is null or p_capitalizable_amount < 0 then
    raise exception 'invalid_tax_classification_override: tax amount components must be nonnegative'
      using errcode = '22023';
  end if;

  if p_deductibility_status not in (
    'fully_deductible',
    'partially_deductible',
    'nondeductible',
    'capitalizable',
    'balance_sheet',
    'needs_review'
  ) then
    raise exception 'invalid_tax_classification_override: invalid deductibility_status'
      using errcode = '22023';
  end if;

  if p_classification_status not in (
    'needs_review',
    'auto_classified',
    'user_confirmed',
    'cpa_confirmed',
    'excluded'
  ) then
    raise exception 'invalid_tax_classification_override: invalid classification_status'
      using errcode = '22023';
  end if;

  if p_classification_status = 'cpa_confirmed'
     and coalesce(p_override_source, '') not in ('cpa', 'admin') then
    raise exception 'invalid_tax_classification_override: CPA confirmation requires CPA or admin source'
      using errcode = '22023';
  end if;

  select *
    into v_current
  from public.transaction_tax_classifications
  where business_id = p_business_id
    and transaction_id = p_transaction_id
    and tax_year = p_tax_year
  for update;

  if not found then
    raise exception 'classification_not_found'
      using errcode = 'P0002';
  end if;

  if p_expected_updated_at is not null
     and v_current.updated_at is distinct from p_expected_updated_at then
    raise exception 'classification_conflict'
      using errcode = '40001';
  end if;

  v_effective_user_override :=
    coalesce(p_user_override, false)
    or coalesce(v_current.user_override, false)
    or p_classification_status = 'user_confirmed';

  v_effective_cpa_override :=
    coalesce(p_cpa_override, false)
    or coalesce(v_current.cpa_override, false)
    or p_classification_status = 'cpa_confirmed';

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
    'tax_category', p_tax_category,
    'deductibility_status', p_deductibility_status,
    'deductible_percent', p_deductible_percent,
    'book_amount', p_book_amount,
    'deductible_amount', p_deductible_amount,
    'nondeductible_amount', p_nondeductible_amount,
    'capitalizable_amount', p_capitalizable_amount,
    'tax_treatment', p_tax_treatment,
    'classification_status', p_classification_status,
    'confidence_score', p_confidence_score,
    'confidence_level', p_confidence_level,
    'source', p_source,
    'requires_review', p_requires_review,
    'reason', p_reason,
    'user_override', v_effective_user_override,
    'cpa_override', v_effective_cpa_override,
    'metadata', coalesce(v_current.metadata, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb)
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
    p_transaction_id,
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
    tax_category = p_tax_category,
    deductibility_status = p_deductibility_status,
    deductible_percent = p_deductible_percent,
    book_amount = p_book_amount,
    deductible_amount = p_deductible_amount,
    nondeductible_amount = p_nondeductible_amount,
    capitalizable_amount = p_capitalizable_amount,
    tax_treatment = p_tax_treatment,
    classification_status = p_classification_status,
    confidence_score = p_confidence_score,
    confidence_level = p_confidence_level,
    source = p_source,
    requires_review = p_requires_review,
    reason = p_reason,
    user_override = v_effective_user_override,
    cpa_override = v_effective_cpa_override,
    metadata = coalesce(metadata, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb),
    updated_at = now()
  where id = v_current.id
  returning * into v_updated;

  return v_updated;
end;
$$;

revoke all on function public.apply_tax_classification_override(
  uuid,
  integer,
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  numeric,
  jsonb,
  text,
  numeric,
  numeric,
  numeric,
  numeric,
  numeric,
  text,
  text,
  boolean,
  text,
  boolean,
  boolean,
  timestamptz,
  jsonb
) from public;

grant execute on function public.apply_tax_classification_override(
  uuid,
  integer,
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  numeric,
  jsonb,
  text,
  numeric,
  numeric,
  numeric,
  numeric,
  numeric,
  text,
  text,
  boolean,
  text,
  boolean,
  boolean,
  timestamptz,
  jsonb
) to authenticated, service_role;
