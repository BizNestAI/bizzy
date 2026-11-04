begin;
-- Additive service-only category-resolution commands. Existing vehicle, mileage
-- and grouped business-use commands are unchanged. No data backfill occurs.
create or replace function public.tax_category_resolution_facts(m jsonb) returns jsonb language plpgsql immutable set search_path=public as $$
declare confidence numeric:=0; suggestion text:=''; raw_confidence text:=m->'tax_category_suggestion'->>'confidence';begin
 if raw_confidence ~ '^[0-9]+(\.[0-9]+)?$' then confidence:=raw_confidence::numeric;if confidence<=1 then confidence:=confidence*100;end if;end if;
 if confidence between 80 and 100 and m->'tax_category_suggestion'->>'taxCategory' in ('supplies','office_expense','advertising','bank_fees','interest_expense','taxes_licenses','legal_professional','business_insurance','software_subscriptions','equipment_rental','rent_lease','personal_expense','entertainment') then suggestion:=m->'tax_category_suggestion'->>'taxCategory';end if;
 return jsonb_build_object('suggestedCategory',suggestion,'reasonCode',coalesce(nullif(m->>'review_reason_code',''),nullif(m->>'reason_code',''),'category_review'));
end $$;
create or replace function public.apply_grouped_tax_category_decision(
  p_business_id uuid,
  p_tax_year integer,
  p_actor_user_id uuid,
  p_override_source text,
  p_override_reason text,
  p_idempotency_key text,
  p_scope jsonb,
  p_scope_fingerprint text,
  p_target_transaction_ids jsonb,
  p_expected_population_transaction_ids jsonb,
  p_items jsonb,
  p_rule jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_existing public.tax_grouped_deduction_decision_operations%rowtype;
  v_rule public.tax_deduction_rules%rowtype;
  v_operation_id uuid := gen_random_uuid();
  v_result jsonb;
  v_classifications jsonb;
  v_target_count integer;
  v_expected_population_count integer;
  v_item_count integer;
  v_population jsonb;
  v_account_id text;
  v_tax_category text;
  v_rule_code text;
begin
  if p_business_id is null
     or p_tax_year is null or p_tax_year < 2000 or p_tax_year > 2100
     or p_idempotency_key is null or length(trim(p_idempotency_key)) < 16
     or p_scope_fingerprint is null or length(trim(p_scope_fingerprint)) = 0
     or jsonb_typeof(p_scope) is distinct from 'object'
     or jsonb_typeof(p_target_transaction_ids) is distinct from 'array'
     or jsonb_typeof(p_expected_population_transaction_ids) is distinct from 'array'
     or jsonb_typeof(p_items) is distinct from 'array'
     or jsonb_typeof(p_rule) is distinct from 'object' then
    raise exception 'invalid_grouped_tax_deduction_decision'
      using errcode = '22023';
  end if;

  v_target_count := jsonb_array_length(p_target_transaction_ids);
  v_expected_population_count := jsonb_array_length(p_expected_population_transaction_ids);
  v_item_count := jsonb_array_length(p_items);
  if v_target_count < 1 or v_target_count > 1000
     or v_expected_population_count < 1 or v_expected_population_count > 1000
     or v_item_count <> v_target_count then
    raise exception 'invalid_grouped_tax_deduction_decision: selected transaction count is invalid'
      using errcode = '22023';
  end if;

  v_tax_category := nullif(trim(p_scope->>'tax_category'), '');
  v_account_id := nullif(trim(p_scope->>'qbo_account_id'), '');
  v_rule_code := nullif(trim(p_rule->>'rule_code'), '');
  if v_tax_category is null or v_account_id is null or v_rule_code is null
     or coalesce(p_scope->>'decision_type','') not in ('category_confirmation','rent_treatment')
     or coalesce(p_rule->>'tax_category','') not in ('supplies','office_expense','advertising','bank_fees','interest_expense','taxes_licenses','legal_professional','business_insurance','software_subscriptions','equipment_rental','rent_lease','personal_expense','entertainment')
     or nullif(trim(p_override_reason), '') is null then
    raise exception 'invalid_grouped_tax_deduction_decision: scope, rule, and reason are required'
      using errcode = '22023';
  end if;

  -- Serialize duplicate/submitted-again commands for this tenant/key without
  -- holding a broad business lock. The unique key is still the final guard.
  perform pg_advisory_xact_lock(hashtextextended(p_business_id::text || ':' || p_idempotency_key, 0));

  -- A different idempotency key can legitimately be used after the prior
  -- command has finished, but two concurrent commands must not both create
  -- competing defaults for the same company/year/GL scope.
  perform pg_advisory_xact_lock(hashtextextended(
    p_business_id::text || ':' || p_tax_year::text || ':' || v_tax_category || ':' || v_account_id,
    0
  ));

  select * into v_existing
  from public.tax_grouped_deduction_decision_operations
  where business_id = p_business_id
    and idempotency_key = p_idempotency_key
  for update;

  if found then
    if v_existing.scope_fingerprint is distinct from p_scope_fingerprint
       or v_existing.scope is distinct from p_scope then
      raise exception 'idempotency_key_reused'
        using errcode = '40001';
    end if;
    return v_existing.result;
  end if;

  -- Validate that the caller supplied one unique item for every selected ID,
  -- and that every selected row remains an active canonical transaction in
  -- this exact business/year/category/GL scope. This is the authoritative
  -- stale-scope check; the client fingerprint is only an early guard.
  if exists (
    with target_ids as (
      select value::text as transaction_id
      from jsonb_array_elements_text(p_target_transaction_ids) value
    ), expected_population_ids as (
      select value::text as transaction_id
      from jsonb_array_elements_text(p_expected_population_transaction_ids) value
    ), item_ids as (
      select nullif(item->>'transaction_id', '') as transaction_id
      from jsonb_array_elements(p_items) item
    )
    select 1
    where (select count(*) from target_ids) <> (select count(distinct transaction_id) from target_ids)
       or (select count(*) from expected_population_ids) <> (select count(distinct transaction_id) from expected_population_ids)
       or (select count(*) from item_ids) <> (select count(distinct transaction_id) from item_ids)
       or exists (select 1 from target_ids t full join item_ids i using (transaction_id) where t.transaction_id is null or i.transaction_id is null)
       or exists (
         select 1
         from target_ids t
         left join expected_population_ids p using (transaction_id)
         where p.transaction_id is null
       )
  ) then
    raise exception 'grouped_decision_scope_changed'
      using errcode = '40001';
  end if;

  -- The browser may choose exceptions (a subset of this set), but it cannot
  -- choose the population. Compare the submitted sorted stable-ID set with
  -- the current canonical active source rows under the same tenant/year/GL
  -- scope while the scope advisory lock is held.
  if exists (
    with expected_population_ids as (
      select value::text as transaction_id
      from jsonb_array_elements_text(p_expected_population_transaction_ids) value
    ), canonical_population_ids as (
      select c.transaction_id::text as transaction_id
      from public.transaction_tax_classifications c
      join public.bank_transactions b
        on b.business_id = c.business_id
       and b.id = c.transaction_id
      where c.business_id = p_business_id
        and c.tax_year = p_tax_year
        and c.tax_category = v_tax_category
        and public.tax_category_resolution_facts(c.metadata) = p_scope->'resolution_facts'
        and coalesce(c.source_qbo_account_id, c.metadata->>'source_qbo_account_id') = v_account_id
        and c.classification_status = 'needs_review'
        and c.requires_review is true
        and coalesce(c.user_override, false) is false
        and coalesce(c.cpa_override, false) is false
        and b.pending is not true
        and b.is_archived is not true
    )
    select 1
    where (select count(*) from expected_population_ids) <> (select count(*) from canonical_population_ids)
       or exists (
         select 1
         from expected_population_ids e
         full join canonical_population_ids c using (transaction_id)
         where e.transaction_id is null or c.transaction_id is null
       )
  ) then
    raise exception 'grouped_decision_population_changed'
      using errcode = '40001';
  end if;

  if exists (
    with item_rows as (
      select
        nullif(item->>'transaction_id', '')::uuid as transaction_id,
        nullif(item->>'classification_id', '')::uuid as classification_id,
        nullif(item->>'expected_updated_at', '')::timestamptz as expected_updated_at,
        nullif(item->>'tax_category', '') as tax_category,
        nullif(item->>'classification_status', '') as classification_status,
        nullif(item->>'requires_review', '')::boolean as requires_review
      from jsonb_array_elements(p_items) item
    )
    select 1
    from item_rows i
    left join public.transaction_tax_classifications c
      on c.business_id = p_business_id
     and c.tax_year = p_tax_year
     and c.transaction_id = i.transaction_id
    left join public.bank_transactions b
      on b.business_id = p_business_id
     and b.id = i.transaction_id
    where i.transaction_id is null
       or i.classification_id is null
       or i.tax_category is distinct from p_rule->>'tax_category'
       or i.classification_status is distinct from 'user_confirmed'
       or i.requires_review is not false
       or c.id is null
       or c.id is distinct from i.classification_id
       or (i.expected_updated_at is not null and c.updated_at is distinct from i.expected_updated_at)
       or c.tax_category is distinct from v_tax_category
       or coalesce(c.source_qbo_account_id, c.metadata->>'source_qbo_account_id') is distinct from v_account_id
       or c.classification_status is distinct from 'needs_review'
       or c.requires_review is not true
       or coalesce(c.user_override, false) is true
       or coalesce(c.cpa_override, false) is true
       or b.id is null
       or b.pending is true
       or b.is_archived is true
  ) then
    raise exception 'grouped_decision_scope_changed'
      using errcode = '40001';
  end if;

  -- Explicit category answers apply only to reviewed members. Never infer a
  -- future GL-wide tax rule from heterogeneous unresolved purchases.
  with items as (
    select
      nullif(item->>'classification_id', '')::uuid as classification_id,
      nullif(item->>'transaction_id', '')::uuid as transaction_id,
      item
    from jsonb_array_elements(p_items) item
  ), locked as (
    select c.*, i.item
    from public.transaction_tax_classifications c
    join items i on i.classification_id = c.id and i.transaction_id = c.transaction_id
    where c.business_id = p_business_id
      and c.tax_year = p_tax_year
      and c.tax_category = v_tax_category
      and coalesce(c.source_qbo_account_id, c.metadata->>'source_qbo_account_id') = v_account_id
      and c.classification_status = 'needs_review'
      and c.requires_review is true
      and coalesce(c.user_override, false) is false
      and coalesce(c.cpa_override, false) is false
      and (
        nullif(i.item->>'expected_updated_at', '') is null
        or c.updated_at = nullif(i.item->>'expected_updated_at', '')::timestamptz
      )
    for update of c
  ), history as (
    insert into public.tax_classification_overrides (
      business_id, tax_year, transaction_id, classification_id, previous_values, new_values,
      override_source, override_reason, overridden_by, created_at
    )
    select
      p_business_id, p_tax_year, l.transaction_id, l.id,
      jsonb_build_object(
        'tax_category', l.tax_category,
        'deductibility_status', l.deductibility_status,
        'deductible_percent', l.deductible_percent,
        'book_amount', l.book_amount,
        'deductible_amount', l.deductible_amount,
        'nondeductible_amount', l.nondeductible_amount,
        'capitalizable_amount', l.capitalizable_amount,
        'tax_treatment', l.tax_treatment,
        'classification_status', l.classification_status,
        'confidence_score', l.confidence_score,
        'confidence_level', l.confidence_level,
        'source', l.source,
        'requires_review', l.requires_review,
        'reason', l.reason,
        'user_override', l.user_override,
        'cpa_override', l.cpa_override,
        'metadata', l.metadata
      ),
      jsonb_build_object(
        'tax_category', l.item->>'tax_category',
        'deductibility_status', l.item->>'deductibility_status',
        'deductible_percent', (l.item->>'deductible_percent')::numeric,
        'book_amount', (l.item->>'book_amount')::numeric,
        'deductible_amount', (l.item->>'deductible_amount')::numeric,
        'nondeductible_amount', (l.item->>'nondeductible_amount')::numeric,
        'capitalizable_amount', (l.item->>'capitalizable_amount')::numeric,
        'tax_treatment', coalesce(l.item->'tax_treatment', 'null'::jsonb),
        'classification_status', l.item->>'classification_status',
        'confidence_score', (l.item->>'confidence_score')::numeric,
        'confidence_level', l.item->>'confidence_level',
        'source', l.item->>'source',
        'requires_review', (l.item->>'requires_review')::boolean,
        'reason', l.item->>'reason',
        'user_override', coalesce((l.item->>'user_override')::boolean, false) or (l.item->>'classification_status') = 'user_confirmed',
        'cpa_override', coalesce((l.item->>'cpa_override')::boolean, false) or coalesce(l.cpa_override, false) or (l.item->>'classification_status') = 'cpa_confirmed',
        'metadata', coalesce(l.metadata, '{}'::jsonb) || coalesce(l.item->'metadata', '{}'::jsonb)
      ),
      p_override_source, p_override_reason, p_actor_user_id, now()
    from locked l
  ), updated as (
    update public.transaction_tax_classifications c
    set
      tax_category = l.item->>'tax_category',
      deductibility_status = l.item->>'deductibility_status',
      deductible_percent = (l.item->>'deductible_percent')::numeric,
      book_amount = (l.item->>'book_amount')::numeric,
      deductible_amount = (l.item->>'deductible_amount')::numeric,
      nondeductible_amount = (l.item->>'nondeductible_amount')::numeric,
      capitalizable_amount = (l.item->>'capitalizable_amount')::numeric,
      tax_treatment = coalesce(l.item->'tax_treatment', 'null'::jsonb),
      classification_status = l.item->>'classification_status',
      confidence_score = (l.item->>'confidence_score')::numeric,
      confidence_level = l.item->>'confidence_level',
      source = l.item->>'source',
      requires_review = (l.item->>'requires_review')::boolean,
      reason = l.item->>'reason',
      user_override = coalesce((l.item->>'user_override')::boolean, false) or (l.item->>'classification_status') = 'user_confirmed',
      cpa_override = coalesce((l.item->>'cpa_override')::boolean, false) or coalesce(c.cpa_override, false) or (l.item->>'classification_status') = 'cpa_confirmed',
      metadata = coalesce(c.metadata, '{}'::jsonb) || coalesce(l.item->'metadata', '{}'::jsonb),
      updated_at = now()
    from locked l
    where c.id = l.id
    returning c.*
  ), resolved_review_tasks as (
    update public.tax_review_tasks t
    set
      status = 'resolved',
      resolved_by = p_actor_user_id,
      resolved_at = now(),
      updated_at = now()
    where t.business_id = p_business_id
      and t.dedupe_key in (
        select 'tax_classification:' || p_tax_year::text || ':' || updated.transaction_id::text
        from updated
      )
    returning t.id
  )
  select coalesce(jsonb_agg(to_jsonb(updated) order by updated.transaction_id), '[]'::jsonb)
  into v_classifications
  from updated;

  if jsonb_array_length(v_classifications) <> v_target_count then
    raise exception 'grouped_decision_scope_changed'
      using errcode = '40001';
  end if;

  select jsonb_build_object(
    'category_transaction_count', count(*)::integer,
    'actionable_transaction_count', count(*) filter (
      where c.classification_status = 'needs_review'
        and c.requires_review is true
        and coalesce(c.user_override, false) is false
        and coalesce(c.cpa_override, false) is false
    )::integer,
    'already_resolved_count', count(*) filter (
      where c.classification_status in ('user_confirmed', 'cpa_confirmed')
        or coalesce(c.user_override, false) is true
        or coalesce(c.cpa_override, false) is true
    )::integer,
    'explicitly_excluded_count', count(*) filter (where c.classification_status = 'excluded')::integer
  )
  into v_population
  from public.transaction_tax_classifications c
  join public.bank_transactions b on b.business_id = c.business_id and b.id = c.transaction_id
  where c.business_id = p_business_id
    and c.tax_year = p_tax_year
    and c.tax_category = v_tax_category
    and coalesce(c.source_qbo_account_id, c.metadata->>'source_qbo_account_id') = v_account_id
    and b.pending is not true
    and b.is_archived is not true;

  v_result := jsonb_build_object(
    'operation_id', v_operation_id,
    'status', 'completed',
    'idempotency_key', p_idempotency_key,
    'scope_fingerprint', p_scope_fingerprint,
    'applied_count', v_target_count,
    'already_matching_count', 0,
    'skipped_count', 0,
    'skipped_reasons', '[]'::jsonb,
    'target_transaction_ids', p_target_transaction_ids,
    'expected_population_transaction_ids', p_expected_population_transaction_ids,
    'classifications', v_classifications,
    'rule', to_jsonb(v_rule),
    'population', v_population
  );

  insert into public.tax_grouped_deduction_decision_operations (
    id, business_id, tax_year, idempotency_key, scope, scope_fingerprint,
    target_transaction_ids, expected_population_transaction_ids, target_count, applied_count, already_matching_count,
    skipped_count, skipped_reasons, resulting_rule_id, status, result, actor_user_id
  ) values (
    v_operation_id, p_business_id, p_tax_year, p_idempotency_key, p_scope, p_scope_fingerprint,
    p_target_transaction_ids, p_expected_population_transaction_ids, v_target_count, v_target_count, 0,
    0, '[]'::jsonb, v_rule.id, 'completed', v_result, p_actor_user_id
  );

  return v_result;
end;
$$;

create or replace function public.apply_grouped_tax_category_decision_from_preview(
  p_preview_id uuid,
  p_business_id uuid,
  p_tax_year integer,
  p_actor_user_id uuid,
  p_override_source text,
  p_override_reason text,
  p_idempotency_key text,
  p_confirmation_fingerprint text,
  p_scope jsonb,
  p_scope_fingerprint text,
  p_target_transaction_ids jsonb,
  p_expected_population_transaction_ids jsonb,
  p_items jsonb,
  p_rule jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_preview public.tax_grouped_deduction_decision_previews%rowtype;
  v_result jsonb;
  v_items jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_business_id::text||':vehicle-election',0));
  select * into v_preview
  from public.tax_grouped_deduction_decision_previews
  where id = p_preview_id and business_id = p_business_id and tax_year = p_tax_year
  for update;

  if not found or v_preview.actor_user_id is distinct from p_actor_user_id then
    raise exception 'preview_owner_mismatch' using errcode = '42501';
  end if;
  if v_preview.consumed_at is not null then
    if v_preview.idempotency_key = p_idempotency_key and v_preview.confirmation_fingerprint = p_confirmation_fingerprint then
      select result into v_result from public.tax_grouped_deduction_decision_operations
      where business_id=p_business_id and tax_year=p_tax_year and idempotency_key=p_idempotency_key;
      if v_result is null then raise exception 'grouped_decision_outcome_unknown' using errcode = '40001'; end if;
      return v_result;
    end if;
    if v_preview.idempotency_key = p_idempotency_key then
      raise exception 'idempotency_payload_conflict' using errcode = '40001';
    end if;
    raise exception 'preview_already_consumed' using errcode = '40001';
  end if;
  if v_preview.expires_at <= now() and v_preview.consumed_at is null then
    raise exception 'preview_expired' using errcode = '40001';
  end if;

  -- Lock the exact preview population. Operational timestamps are deliberately
  -- absent; every comparison below is decision-semantic.
  perform 1
  from public.transaction_tax_classifications c
  where c.business_id = p_business_id and c.tax_year = p_tax_year
    and c.transaction_id::text in (select e->>'transactionId' from jsonb_array_elements(v_preview.semantic_manifest->'entries') e)
  for update;

  if (select count(*) from jsonb_array_elements(v_preview.semantic_manifest->'entries')) is distinct from (
    select count(*) from public.transaction_tax_classifications c
    where c.business_id = p_business_id and c.tax_year = p_tax_year
      and c.transaction_id::text in (select e->>'transactionId' from jsonb_array_elements(v_preview.semantic_manifest->'entries') e)
  ) then raise exception 'scope_membership_changed' using errcode = '40001'; end if;

  if exists (select 1 from jsonb_array_elements(v_preview.semantic_manifest->'entries') e
    join public.transaction_tax_classifications c on c.business_id=p_business_id and c.tax_year=p_tax_year and c.transaction_id::text=e->>'transactionId'
    where abs(round(coalesce(c.book_amount,0)*100)::bigint) is distinct from (e->>'grossAmountCents')::bigint)
  then raise exception 'scope_amount_changed' using errcode = '40001'; end if;

  if exists (select 1 from jsonb_array_elements(v_preview.semantic_manifest->'entries') e
    join public.transaction_tax_classifications c on c.business_id=p_business_id and c.tax_year=p_tax_year and c.transaction_id::text=e->>'transactionId'
    where coalesce(c.source_qbo_account_id,c.metadata->>'source_qbo_account_id','') is distinct from coalesce(e->>'qboAccountId',''))
  then raise exception 'scope_account_changed' using errcode = '40001'; end if;

  if exists (select 1 from jsonb_array_elements(v_preview.semantic_manifest->'entries') e
    join public.transaction_tax_classifications c on c.business_id=p_business_id and c.tax_year=p_tax_year and c.transaction_id::text=e->>'transactionId'
    where c.tax_category is distinct from e->>'taxCategory'
       or coalesce(to_jsonb(c.tax_treatment),'null'::jsonb) is distinct from coalesce(e->'taxTreatment','null'::jsonb)
       or c.deductibility_status is distinct from e->>'deductibilityStatus'
       or c.deductible_percent is distinct from nullif(e->>'deductiblePercent','')::numeric)
  then raise exception 'scope_treatment_changed' using errcode = '40001'; end if;

  if exists (select 1 from jsonb_array_elements(v_preview.semantic_manifest->'entries') e
    join public.transaction_tax_classifications c on c.business_id=p_business_id and c.tax_year=p_tax_year and c.transaction_id::text=e->>'transactionId'
    where case
        when coalesce(c.cpa_override,false) or c.classification_status='cpa_confirmed' then 'cpa'
        when c.classification_status='bizzi_operator_confirmed' then 'bizzi_operator'
        when coalesce(c.user_override,false) or c.classification_status='user_confirmed' then 'customer'
        else coalesce(c.source,'system')
      end is distinct from coalesce(e->>'authority','')
      or (coalesce(c.user_override,false) or coalesce(c.cpa_override,false) or c.classification_status in ('user_confirmed','bizzi_operator_confirmed','cpa_confirmed'))
        is distinct from coalesce((e->>'protected')::boolean,false))
  then raise exception 'protected_authority_changed' using errcode = '40001'; end if;

  if exists (select 1 from jsonb_array_elements(v_preview.semantic_manifest->'entries') e
    join public.transaction_tax_classifications c on c.business_id=p_business_id and c.tax_year=p_tax_year and c.transaction_id::text=e->>'transactionId'
    where coalesce(c.metadata->'customer_facts','{}'::jsonb) is distinct from coalesce(e->'customerFacts','{}'::jsonb))
  then raise exception 'customer_facts_changed' using errcode = '40001'; end if;

  if exists (select 1 from jsonb_array_elements(v_preview.semantic_manifest->'entries') e
    join public.transaction_tax_classifications c on c.business_id=p_business_id and c.tax_year=p_tax_year and c.transaction_id::text=e->>'transactionId'
    where coalesce(c.rule_version,c.metadata->>'rule_version',c.rule_code,'') is distinct from coalesce(e->>'ruleVersion',''))
  then raise exception 'rule_version_changed' using errcode = '40001'; end if;

  select jsonb_agg(i.item || jsonb_build_object('expected_updated_at', c.updated_at) order by i.item->>'transaction_id') into v_items
  from jsonb_array_elements(p_items) i(item)
  join public.transaction_tax_classifications c on c.business_id=p_business_id and c.tax_year=p_tax_year and c.transaction_id::text=i.item->>'transaction_id';

  if not exists(select 1 from public.tax_workspace_projections p where p.id::text=v_preview.scope->>'workspace_projection_id' and p.business_id=p_business_id and p.tax_year=p_tax_year and p.source_fingerprint=v_preview.scope->>'workspace_source_fingerprint' and p.id=(select latest.id from public.tax_workspace_projections latest where latest.business_id=p_business_id and latest.tax_year=p_tax_year and latest.projection_version='tax-workspace-v2' and latest.status='complete' order by latest.generated_at desc limit 1)) then raise exception 'grouped_decision_projection_stale' using errcode='40001';end if;
  if v_preview.decision_type not in ('category_confirmation','rent_treatment') or v_preview.decision_type is distinct from p_scope->>'decision_type' then raise exception 'invalid_category_question' using errcode='22023';end if;
  v_result := public.apply_grouped_tax_category_decision(p_business_id,p_tax_year,p_actor_user_id,p_override_source,p_override_reason,p_idempotency_key,p_scope,p_scope_fingerprint,p_target_transaction_ids,p_expected_population_transaction_ids,v_items,p_rule);
  update public.tax_grouped_deduction_decision_previews set consumed_at=coalesce(consumed_at,now()), idempotency_key=p_idempotency_key,
    confirmation_fingerprint=p_confirmation_fingerprint,
    operation_id=coalesce(operation_id,nullif(v_result->>'operation_id','')::uuid) where id=p_preview_id;
  return v_result;
end;
$$;

revoke all on function public.apply_grouped_tax_category_decision_from_preview(uuid,uuid,integer,uuid,text,text,text,text,jsonb,text,jsonb,jsonb,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.apply_grouped_tax_category_decision_from_preview(uuid,uuid,integer,uuid,text,text,text,text,jsonb,text,jsonb,jsonb,jsonb,jsonb) to service_role;

revoke all on function public.apply_grouped_tax_category_decision(uuid,integer,uuid,text,text,text,jsonb,text,jsonb,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.apply_grouped_tax_category_decision(uuid,integer,uuid,text,text,text,jsonb,text,jsonb,jsonb,jsonb,jsonb) to service_role;
-- Old clients must also be unable to promote a temporary workflow category.
create or replace function public.tax_reject_final_temporary_category() returns trigger language plpgsql set search_path=public as $$ begin
 if new.classification_status in ('user_confirmed','cpa_confirmed','bizzi_operator_confirmed','accountant_reviewed') and lower(trim(coalesce(new.tax_category,''))) in ('','unclassified','unresolved','needs_review','pending','pending_classification','unknown','not_determined') then raise exception 'temporary_tax_category' using errcode='22023';end if;
 return new;
end $$;
drop trigger if exists tax_reject_final_temporary_category on public.transaction_tax_classifications;
create trigger tax_reject_final_temporary_category before insert or update on public.transaction_tax_classifications for each row execute function public.tax_reject_final_temporary_category();
commit;
