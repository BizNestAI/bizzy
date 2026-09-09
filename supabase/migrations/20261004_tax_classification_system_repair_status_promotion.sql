begin;

create or replace function public.apply_tax_classification_status_promotion(
  p_business_id uuid,
  p_tax_year integer,
  p_transaction_id uuid,
  p_actor_user_id uuid,
  p_expected_updated_at timestamptz,
  p_reason text,
  p_metadata jsonb
)
returns public.transaction_tax_classifications
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_current public.transaction_tax_classifications%rowtype;
  v_updated public.transaction_tax_classifications%rowtype;
  v_rule public.tax_deduction_rules%rowtype;
  v_previous_values jsonb;
  v_new_metadata jsonb;
  v_new_values jsonb;
begin
  select *
  into v_current
  from public.transaction_tax_classifications
  where business_id = p_business_id
    and tax_year = p_tax_year
    and transaction_id = p_transaction_id
  for update;

  if not found then
    raise exception 'classification_not_found';
  end if;

  if p_expected_updated_at is not null
     and v_current.updated_at is not null
     and v_current.updated_at is distinct from p_expected_updated_at then
    raise exception 'classification_conflict';
  end if;

  if v_current.classification_status in ('user_confirmed', 'accountant_reviewed', 'cpa_confirmed', 'excluded')
     or coalesce(v_current.user_override, false)
     or coalesce(v_current.cpa_override, false)
     or v_current.classification_status is distinct from 'needs_review'
     or lower(coalesce(v_current.tax_category, '')) = 'unclassified'
     or v_current.rule_id is null
     or v_current.rule_code is null
     or v_current.rule_version is null then
    raise exception 'classification_status_promotion_target_invalid';
  end if;

  select *
  into v_rule
  from public.tax_deduction_rules
  where id = v_current.rule_id
    and rule_code = v_current.rule_code
    and version = v_current.rule_version
    and tax_year = p_tax_year
    and jurisdiction = 'federal'
    and is_active = true
    and verified_at is not null;

  if not found
     or coalesce(v_rule.requires_review, false) is distinct from false
     or v_current.tax_category is distinct from v_rule.tax_category
     or v_current.deductibility_status is distinct from v_rule.deductibility_status
     or v_current.deductible_percent is distinct from v_rule.default_deductible_percent then
    raise exception 'classification_status_promotion_rule_mismatch';
  end if;

  if not exists (
    select 1
    from public.tax_classification_overrides h
    where h.business_id = p_business_id
      and h.tax_year = p_tax_year
      and h.transaction_id = p_transaction_id
      and h.classification_id = v_current.id
      and h.override_source = 'system_repair'
      and h.new_values->>'classification_status' = 'needs_review'
      and h.new_values->>'rule_id' = v_current.rule_id::text
      and h.new_values->>'rule_code' = v_current.rule_code
      and h.new_values->>'rule_version' = v_current.rule_version
  ) then
    raise exception 'classification_status_promotion_repair_history_missing';
  end if;

  v_new_metadata := coalesce(v_current.metadata, '{}'::jsonb)
    || coalesce(p_metadata, '{}'::jsonb)
    || jsonb_build_object(
      'status_promoted_at', now()::text,
      'status_promoted_from', v_current.classification_status,
      'status_promotion_reason', p_reason,
      'tax_classification_stale', false
    );

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
    'rule_id', v_current.rule_id,
    'rule_code', v_current.rule_code,
    'rule_version', v_current.rule_version,
    'rule_priority', v_current.rule_priority,
    'source', v_current.source,
    'requires_review', v_current.requires_review,
    'reason', v_current.reason,
    'user_override', v_current.user_override,
    'cpa_override', v_current.cpa_override,
    'metadata', v_current.metadata
  );

  v_new_values := jsonb_build_object(
    'tax_category', v_current.tax_category,
    'deductibility_status', v_current.deductibility_status,
    'deductible_percent', v_current.deductible_percent,
    'book_amount', v_current.book_amount,
    'deductible_amount', v_current.deductible_amount,
    'nondeductible_amount', v_current.nondeductible_amount,
    'capitalizable_amount', v_current.capitalizable_amount,
    'tax_treatment', v_current.tax_treatment,
    'classification_status', 'auto_classified',
    'confidence_score', v_current.confidence_score,
    'confidence_level', v_current.confidence_level,
    'rule_id', v_current.rule_id,
    'rule_code', v_current.rule_code,
    'rule_version', v_current.rule_version,
    'rule_priority', v_current.rule_priority,
    'source', v_current.source,
    'requires_review', false,
    'reason', coalesce(p_reason, 'Promoted deterministic system-repaired classification status.'),
    'user_override', false,
    'cpa_override', false,
    'metadata', v_new_metadata
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
    'system_repair',
    coalesce(p_reason, 'Promoted deterministic system-repaired classification status.'),
    p_actor_user_id,
    now()
  );

  update public.transaction_tax_classifications
  set
    classification_status = 'auto_classified',
    requires_review = false,
    user_override = false,
    cpa_override = false,
    reason = coalesce(p_reason, reason),
    metadata = v_new_metadata,
    updated_at = now()
  where id = v_current.id
  returning * into v_updated;

  return v_updated;
end;
$$;

revoke all on function public.apply_tax_classification_status_promotion(
  uuid, integer, uuid, uuid, timestamptz, text, jsonb
) from public;
revoke all on function public.apply_tax_classification_status_promotion(
  uuid, integer, uuid, uuid, timestamptz, text, jsonb
) from anon;
revoke all on function public.apply_tax_classification_status_promotion(
  uuid, integer, uuid, uuid, timestamptz, text, jsonb
) from authenticated;
grant execute on function public.apply_tax_classification_status_promotion(
  uuid, integer, uuid, uuid, timestamptz, text, jsonb
) to service_role;

commit;
