-- Atomic Bizzi-operator Tax classification decisions.
-- Forward-only; does not execute a decision or modify existing classifications.

begin;

alter table public.tax_grouped_deduction_decision_operations
  add column if not exists actor_authority text,
  add column if not exists request_id text,
  add column if not exists payload_fingerprint text;

alter table public.tax_grouped_deduction_decision_operations
  drop constraint if exists tax_grouped_deduction_decision_operations_actor_authority_check;
alter table public.tax_grouped_deduction_decision_operations
  add constraint tax_grouped_deduction_decision_operations_actor_authority_check
  check (actor_authority is null or actor_authority in ('customer', 'bizzi_operator', 'tax_professional'));

alter table public.transaction_tax_classifications
  drop constraint if exists transaction_tax_classifications_source_check;
alter table public.transaction_tax_classifications
  add constraint transaction_tax_classifications_source_check
  check (source in ('system', 'rule_engine', 'user', 'cpa', 'imported', 'bizzi_operator', 'system_repair'));

alter table public.transaction_tax_classifications
  drop constraint if exists transaction_tax_classifications_status_check,
  drop constraint if exists transaction_tax_classifications_deductibility_check,
  alter column deductible_percent drop not null,
  alter column deductible_amount drop not null,
  alter column nondeductible_amount drop not null,
  alter column capitalizable_amount drop not null;
alter table public.transaction_tax_classifications
  add constraint transaction_tax_classifications_status_check
    check (classification_status in ('needs_review', 'needs_tax_review', 'auto_classified', 'user_confirmed', 'bizzi_operator_confirmed', 'cpa_confirmed', 'accountant_reviewed', 'excluded')),
  add constraint transaction_tax_classifications_deductibility_check
    check (deductibility_status in ('fully_deductible', 'partially_deductible', 'nondeductible', 'capitalizable', 'balance_sheet', 'needs_review', 'not_yet_determined'));

create or replace function public.apply_bizzi_operator_tax_decision(
  p_business_id uuid,
  p_tax_year integer,
  p_actor_user_id uuid,
  p_actor_authority text,
  p_request_id text,
  p_idempotency_key text,
  p_scope jsonb,
  p_scope_fingerprint text,
  p_payload_fingerprint text,
  p_expected_population_transaction_ids jsonb,
  p_items jsonb,
  p_rule jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.tax_grouped_deduction_decision_operations%rowtype;
  v_operation_id uuid := gen_random_uuid();
  v_account_id text;
  v_scope_type text;
  v_decision_mode text;
  v_target_status text;
  v_reason text;
  v_rule_id uuid;
  v_target_count integer;
  v_gross_amount numeric := 0;
  v_deduction_effect numeric := 0;
  v_result jsonb;
begin
  if p_business_id is null or p_tax_year not between 2000 and 2100
     or p_actor_user_id is null
     or p_actor_authority is distinct from 'bizzi_operator'
     or nullif(trim(p_request_id), '') is null
     or nullif(trim(p_idempotency_key), '') is null
     or length(p_idempotency_key) < 16
     or nullif(trim(p_scope_fingerprint), '') is null
     or nullif(trim(p_payload_fingerprint), '') is null
     or jsonb_typeof(p_scope) is distinct from 'object'
     or jsonb_typeof(p_expected_population_transaction_ids) is distinct from 'array'
     or jsonb_typeof(p_items) is distinct from 'array'
     or jsonb_typeof(p_rule) is distinct from 'object' then
    raise exception 'invalid_operator_tax_decision' using errcode = '22023';
  end if;

  v_account_id := nullif(trim(p_scope->>'qbo_account_id'), '');
  v_scope_type := nullif(trim(p_scope->>'scope_type'), '');
  v_decision_mode := coalesce(nullif(trim(p_scope->>'decision_mode'), ''), 'tax_mapping');
  v_target_status := case when v_decision_mode = 'professional_hold' then 'needs_tax_review' else 'bizzi_operator_confirmed' end;
  v_reason := nullif(trim(p_scope->>'reason'), '');
  if v_account_id is null or v_reason is null or length(v_reason) > 1000
     or v_scope_type not in ('exact_transactions', 'business_gl_tax_year', 'future_business_gl_tax_year')
     or v_decision_mode not in ('tax_mapping', 'professional_hold') then
    raise exception 'invalid_operator_tax_decision_scope' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_business_id::text || ':' || p_idempotency_key, 0));
  perform pg_advisory_xact_lock(hashtextextended(p_business_id::text || ':' || p_tax_year::text || ':' || v_account_id, 0));

  select * into v_existing
  from public.tax_grouped_deduction_decision_operations
  where business_id = p_business_id and idempotency_key = p_idempotency_key
  for update;
  if found then
    if v_existing.payload_fingerprint is distinct from p_payload_fingerprint
       or v_existing.scope_fingerprint is distinct from p_scope_fingerprint
       or v_existing.actor_authority is distinct from 'bizzi_operator'
       or v_existing.actor_user_id is distinct from p_actor_user_id then
      raise exception 'idempotency_key_reused' using errcode = '40001';
    end if;
    return v_existing.result;
  end if;

  if jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 1000
     or jsonb_array_length(p_items) <> jsonb_array_length(p_expected_population_transaction_ids) then
    raise exception 'operator_decision_population_changed' using errcode = '40001';
  end if;

  -- Exact IDs, classification versions, tenant/year and stable GL are all
  -- revalidated under the GL advisory lock. CPA/professional rows never enter
  -- the mutable population.
  if exists (
    with expected as (
      select value::uuid as transaction_id from jsonb_array_elements_text(p_expected_population_transaction_ids)
    ), item_rows as (
      select
        nullif(item->>'transaction_id', '')::uuid as transaction_id,
        nullif(item->>'classification_id', '')::uuid as classification_id,
        nullif(item->>'expected_updated_at', '')::timestamptz as expected_updated_at,
        item
      from jsonb_array_elements(p_items) item
    )
    select 1
    where (select count(*) from expected) <> (select count(distinct transaction_id) from expected)
       or (select count(*) from item_rows) <> (select count(distinct transaction_id) from item_rows)
       or exists (select 1 from expected e full join item_rows i using (transaction_id) where e.transaction_id is null or i.transaction_id is null)
       or exists (
         select 1 from item_rows i
         left join public.transaction_tax_classifications c
           on c.id = i.classification_id and c.transaction_id = i.transaction_id
          and c.business_id = p_business_id and c.tax_year = p_tax_year
         left join public.bank_transactions b
           on b.id = i.transaction_id and b.business_id = p_business_id
         where c.id is null or b.id is null or b.pending is true or b.is_archived is true
            or coalesce(c.source_qbo_account_id, c.metadata->>'source_qbo_account_id') is distinct from v_account_id
            or (i.expected_updated_at is not null and c.updated_at is distinct from i.expected_updated_at)
            or c.classification_status in ('cpa_confirmed', 'accountant_reviewed')
            or coalesce(c.cpa_override, false) is true
            or nullif(i.item->>'classification_status', '') is distinct from v_target_status
            or nullif(i.item->>'source', '') is distinct from 'bizzi_operator'
       )
  ) then
    raise exception 'operator_decision_scope_changed' using errcode = '40001';
  end if;

  -- GL/year scopes must cover the complete current mutable population. Exact
  -- scope is permitted only for the server-returned preview population.
  if v_scope_type <> 'exact_transactions' and exists (
    with expected as (
      select value::text as transaction_id from jsonb_array_elements_text(p_expected_population_transaction_ids)
    ), canonical as (
      select c.transaction_id::text as transaction_id
      from public.transaction_tax_classifications c
      join public.bank_transactions b on b.id = c.transaction_id and b.business_id = c.business_id
      where c.business_id = p_business_id and c.tax_year = p_tax_year
        and coalesce(c.source_qbo_account_id, c.metadata->>'source_qbo_account_id') = v_account_id
        and c.classification_status not in ('cpa_confirmed', 'accountant_reviewed', 'excluded')
        and coalesce(c.cpa_override, false) is false
        and (c.classification_status in ('needs_review', 'needs_tax_review', 'user_confirmed', 'bizzi_operator_confirmed')
          or coalesce(c.user_override, false) is true)
        and b.pending is not true and b.is_archived is not true
    )
    select 1 where exists (
      select 1 from expected e full join canonical c using (transaction_id)
      where e.transaction_id is null or c.transaction_id is null
    ) or (select count(*) from expected) <> (select count(*) from canonical)
  ) then
    raise exception 'operator_decision_population_changed' using errcode = '40001';
  end if;

  -- A future default is always business/year/stable-GL scoped. This function
  -- cannot create or modify global rules.
  if v_decision_mode = 'tax_mapping' and v_scope_type in ('business_gl_tax_year', 'future_business_gl_tax_year') then
    if nullif(p_rule->>'rule_code', '') is null
       or nullif(p_rule->>'tax_category', '') is null
       or coalesce(p_rule->>'scope', 'business_override') <> 'business_override'
       or coalesce(p_rule->>'qbo_account_id', '') <> v_account_id then
      raise exception 'invalid_operator_business_rule' using errcode = '22023';
    end if;
    select id into v_rule_id from public.tax_deduction_rules
    where business_id = p_business_id and tax_year = p_tax_year
      and scope = 'business_override' and rule_code = p_rule->>'rule_code'
    for update;
    if found then
      update public.tax_deduction_rules set
        bookkeeping_category = p_rule->>'bookkeeping_category',
        qbo_account_type = nullif(p_rule->>'qbo_account_type', ''),
        qbo_account_subtype = nullif(p_rule->>'qbo_account_subtype', ''),
        tax_category = p_rule->>'tax_category',
        deductibility_status = p_rule->>'deductibility_status',
        default_deductible_percent = (p_rule->>'default_deductible_percent')::numeric,
        treatment = coalesce(p_rule->'treatment', '{}'::jsonb),
        requires_review = coalesce((p_rule->>'requires_review')::boolean, false),
        match_conditions = jsonb_build_object('qbo_account_id', v_account_id),
        explanation = p_rule->>'explanation', source_reference = p_rule->>'source_reference',
        source_url = nullif(p_rule->>'source_url', ''), verified_at = nullif(p_rule->>'verified_at', '')::timestamptz,
        effective_from = (p_rule->>'effective_from')::date,
        effective_to = nullif(p_rule->>'effective_to', '')::date,
        version = p_rule->>'version', updated_at = now()
      where id = v_rule_id;
    else
      insert into public.tax_deduction_rules (
        business_id, scope, rule_code, tax_year, jurisdiction, entity_type,
        bookkeeping_category, qbo_account_type, qbo_account_subtype, match_conditions,
        tax_category, deductibility_status, default_deductible_percent, treatment,
        requires_review, priority, explanation, source_reference, source_url,
        verified_at, effective_from, effective_to, is_active, version
      ) values (
        p_business_id, 'business_override', p_rule->>'rule_code', p_tax_year,
        coalesce(p_rule->>'jurisdiction', 'federal'), nullif(p_rule->>'entity_type', ''),
        p_rule->>'bookkeeping_category', nullif(p_rule->>'qbo_account_type', ''), nullif(p_rule->>'qbo_account_subtype', ''),
        jsonb_build_object('qbo_account_id', v_account_id),
        p_rule->>'tax_category', p_rule->>'deductibility_status',
        (p_rule->>'default_deductible_percent')::numeric, coalesce(p_rule->'treatment', '{}'::jsonb),
        coalesce((p_rule->>'requires_review')::boolean, false), 5,
        p_rule->>'explanation', p_rule->>'source_reference', nullif(p_rule->>'source_url', ''),
        nullif(p_rule->>'verified_at', '')::timestamptz, (p_rule->>'effective_from')::date,
        nullif(p_rule->>'effective_to', '')::date, true, p_rule->>'version'
      ) returning id into v_rule_id;
    end if;
  end if;

  insert into public.tax_grouped_deduction_decision_operations (
    id, business_id, tax_year, idempotency_key, command_type, scope, scope_fingerprint,
    target_transaction_ids, expected_population_transaction_ids, target_count,
    status, actor_user_id, actor_authority, request_id, payload_fingerprint
  ) values (
    v_operation_id, p_business_id, p_tax_year, p_idempotency_key, 'bizzi_operator_tax_decision',
    p_scope, p_scope_fingerprint, p_expected_population_transaction_ids,
    p_expected_population_transaction_ids, jsonb_array_length(p_items), 'completed',
    p_actor_user_id, 'bizzi_operator', p_request_id, p_payload_fingerprint
  );

  with item_rows as (
    select nullif(item->>'classification_id', '')::uuid classification_id,
           nullif(item->>'transaction_id', '')::uuid transaction_id, item
    from jsonb_array_elements(p_items) item
  ), locked as (
    select c.*, i.item from public.transaction_tax_classifications c
    join item_rows i on i.classification_id = c.id and i.transaction_id = c.transaction_id
    where c.business_id = p_business_id and c.tax_year = p_tax_year
    for update of c
  ), history as (
    insert into public.tax_classification_overrides (
      business_id, tax_year, transaction_id, classification_id, previous_values, new_values,
      override_source, override_reason, overridden_by, created_at
    ) select
      p_business_id, p_tax_year, l.transaction_id, l.id,
      jsonb_build_object(
        'tax_category', l.tax_category, 'deductibility_status', l.deductibility_status,
        'deductible_percent', l.deductible_percent, 'deductible_amount', l.deductible_amount,
        'classification_status', l.classification_status, 'source', l.source,
        'user_override', l.user_override, 'cpa_override', l.cpa_override, 'metadata', l.metadata
      ),
      jsonb_build_object(
        'tax_category', l.item->>'tax_category', 'deductibility_status', l.item->>'deductibility_status',
        'deductible_percent', (l.item->>'deductible_percent')::numeric,
        'deductible_amount', (l.item->>'deductible_amount')::numeric,
        'classification_status', v_target_status, 'source', 'bizzi_operator',
        'user_override', l.user_override, 'cpa_override', l.cpa_override,
        'metadata', coalesce(l.metadata, '{}'::jsonb) || coalesce(l.item->'metadata', '{}'::jsonb)
      ),
      'bizzi_operator', v_reason, p_actor_user_id, now()
    from locked l returning id
  ), updated as (
    update public.transaction_tax_classifications c set
      tax_category = l.item->>'tax_category',
      deductibility_status = l.item->>'deductibility_status',
      deductible_percent = (l.item->>'deductible_percent')::numeric,
      deductible_amount = (l.item->>'deductible_amount')::numeric,
      nondeductible_amount = (l.item->>'nondeductible_amount')::numeric,
      capitalizable_amount = (l.item->>'capitalizable_amount')::numeric,
      tax_treatment = coalesce(l.item->'tax_treatment', 'null'::jsonb),
      classification_status = v_target_status, source = 'bizzi_operator',
      confidence_score = case when v_target_status = 'needs_tax_review' then least(coalesce(c.confidence_score, 0), 60) else 100 end,
      confidence_level = case when v_target_status = 'needs_tax_review' then 'medium' else 'high' end,
      requires_review = (v_target_status = 'needs_tax_review'),
      reason = v_reason,
      metadata = coalesce(c.metadata, '{}'::jsonb) || coalesce(l.item->'metadata', '{}'::jsonb)
        || jsonb_build_object('operator_request_id', p_request_id, 'operator_operation_id', v_operation_id),
      updated_at = now()
    from locked l where c.id = l.id returning c.*
  ), resolved as (
    update public.tax_review_tasks t set status = 'resolved', resolved_by = p_actor_user_id,
      resolved_at = now(), updated_at = now()
    where v_decision_mode = 'tax_mapping'
      and t.business_id = p_business_id and t.dedupe_key in (
      select 'tax_classification:' || p_tax_year::text || ':' || u.transaction_id::text from updated u
    ) returning t.id
  )
  select count(*)::integer, coalesce(sum(abs(book_amount)), 0),
         coalesce(sum(deductible_amount), 0)
    into v_target_count, v_gross_amount, v_deduction_effect
  from updated;

  if v_target_count <> jsonb_array_length(p_items) then
    raise exception 'operator_decision_scope_changed' using errcode = '40001';
  end if;

  v_result := jsonb_build_object(
    'operation_id', v_operation_id, 'status', 'completed',
    'idempotency_key', p_idempotency_key, 'request_id', p_request_id,
    'actor_authority', 'bizzi_operator', 'scope_fingerprint', p_scope_fingerprint,
    'applied_count', v_target_count, 'gross_amount', v_gross_amount,
    'estimated_deduction_effect', v_deduction_effect,
    'target_transaction_ids', p_expected_population_transaction_ids,
    'resulting_rule_id', v_rule_id
  );
  update public.tax_grouped_deduction_decision_operations set
    applied_count = v_target_count, resulting_rule_id = v_rule_id,
    result = v_result, updated_at = now()
  where id = v_operation_id;
  return v_result;
end;
$$;

revoke all on function public.apply_bizzi_operator_tax_decision(uuid, integer, uuid, text, text, text, jsonb, text, text, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.apply_bizzi_operator_tax_decision(uuid, integer, uuid, text, text, text, jsonb, text, text, jsonb, jsonb, jsonb) to service_role;

-- The schema baseline may carry broad service-role default privileges. Narrow
-- these two launch-sensitive relations to the operations the server actually
-- performs; browser roles remain fully revoked and RLS remains forced.
revoke all on table public.tax_classification_run_items from service_role;
grant select, insert, update on table public.tax_classification_run_items to service_role;
revoke all on table public.tax_grouped_deduction_decision_operations from service_role;
grant select, insert, update on table public.tax_grouped_deduction_decision_operations to service_role;

commit;
