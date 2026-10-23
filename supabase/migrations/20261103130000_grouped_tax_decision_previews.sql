begin;

create table if not exists public.tax_grouped_deduction_decision_previews (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  tax_year integer not null check (tax_year between 2000 and 2100),
  actor_user_id uuid not null,
  group_id text not null,
  decision_type text not null,
  scope jsonb not null,
  semantic_manifest jsonb not null,
  semantic_fingerprint text not null,
  actionable_transaction_ids jsonb not null,
  protected_transaction_ids jsonb not null default '[]'::jsonb,
  expires_at timestamptz not null,
  consumed_at timestamptz null,
  idempotency_key text null,
  confirmation_fingerprint text null,
  operation_id uuid null,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(scope) = 'object'),
  check (jsonb_typeof(semantic_manifest) = 'object'),
  check (jsonb_typeof(actionable_transaction_ids) = 'array'),
  check (jsonb_typeof(protected_transaction_ids) = 'array'),
  unique (business_id, id)
);

create index if not exists tax_grouped_decision_previews_expiry_idx
  on public.tax_grouped_deduction_decision_previews (expires_at)
  where consumed_at is null;

create index if not exists tax_grouped_decision_previews_actor_idx
  on public.tax_grouped_deduction_decision_previews (business_id, actor_user_id, tax_year, created_at desc);

alter table public.tax_grouped_deduction_decision_previews enable row level security;
alter table public.tax_grouped_deduction_decision_previews force row level security;

revoke all on table public.tax_grouped_deduction_decision_previews from public, anon, authenticated;
grant select, insert, update, delete on table public.tax_grouped_deduction_decision_previews to service_role;

comment on table public.tax_grouped_deduction_decision_previews is
  'Short-lived server-owned semantic previews for atomic grouped Tax decisions. No provider payloads.';

create or replace function public.apply_grouped_tax_deduction_decision_from_preview(
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

  v_result := public.apply_grouped_tax_deduction_decision(p_business_id,p_tax_year,p_actor_user_id,p_override_source,p_override_reason,p_idempotency_key,p_scope,p_scope_fingerprint,p_target_transaction_ids,p_expected_population_transaction_ids,v_items,p_rule);
  update public.tax_grouped_deduction_decision_previews set consumed_at=coalesce(consumed_at,now()), idempotency_key=p_idempotency_key,
    confirmation_fingerprint=p_confirmation_fingerprint,
    operation_id=coalesce(operation_id,nullif(v_result->>'operation_id','')::uuid) where id=p_preview_id;
  return v_result;
end;
$$;

revoke all on function public.apply_grouped_tax_deduction_decision_from_preview(uuid,uuid,integer,uuid,text,text,text,text,jsonb,text,jsonb,jsonb,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.apply_grouped_tax_deduction_decision_from_preview(uuid,uuid,integer,uuid,text,text,text,text,jsonb,text,jsonb,jsonb,jsonb,jsonb) to service_role;

commit;
