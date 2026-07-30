-- Canonical tax calculation run persistence hardening.

alter table if exists public.tax_calculation_runs
  add column if not exists calculation_fingerprint text,
  add column if not exists supersedes_run_id uuid null,
  add column if not exists superseded_by_run_id uuid null,
  add column if not exists superseded_at timestamptz null,
  add column if not exists supersession_reason text null,
  add column if not exists completion_type text null,
  add column if not exists request_id text null,
  add column if not exists persisted_component_count integer default 0,
  add column if not exists expected_component_count integer default 0,
  add column if not exists calculation_payload_version text null,
  add column if not exists confidence_level text null,
  add column if not exists confidence_status text null,
  add column if not exists confidence_factors jsonb default '[]'::jsonb,
  add column if not exists confidence_penalties jsonb default '[]'::jsonb,
  add column if not exists confidence_blockers jsonb default '[]'::jsonb,
  add column if not exists confidence_methodology_version text null,
  add column if not exists estimate_ready boolean default false,
  add column if not exists reserve_ready boolean default false;

create index if not exists tax_calc_runs_business_year_fingerprint_idx
  on public.tax_calculation_runs (business_id, tax_year, calculation_fingerprint);

create index if not exists tax_calc_runs_business_year_completed_idx
  on public.tax_calculation_runs (business_id, tax_year, completed_at desc);

create index if not exists tax_calc_runs_supersedes_idx
  on public.tax_calculation_runs (supersedes_run_id);

create index if not exists tax_calc_runs_superseded_by_idx
  on public.tax_calculation_runs (superseded_by_run_id);

create table if not exists public.tax_calculation_run_links (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  older_run_id uuid not null references public.tax_calculation_runs(id),
  newer_run_id uuid not null references public.tax_calculation_runs(id),
  relation_type text not null default 'supersedes',
  reason text,
  created_at timestamptz not null default now(),
  unique (business_id, older_run_id, newer_run_id, relation_type)
);

create index if not exists tax_calc_run_links_business_older_idx
  on public.tax_calculation_run_links (business_id, older_run_id);

create index if not exists tax_calc_run_links_business_newer_idx
  on public.tax_calculation_run_links (business_id, newer_run_id);

create or replace function public.finalize_tax_calculation_run(
  p_run_id uuid,
  p_business_id uuid,
  p_status text,
  p_completion_type text,
  p_summary jsonb,
  p_components jsonb,
  p_assumptions jsonb default '[]'::jsonb,
  p_warnings jsonb default '[]'::jsonb,
  p_missing_inputs jsonb default '[]'::jsonb,
  p_source_freshness jsonb default '{}'::jsonb,
  p_confidence_score numeric default null,
  p_supersedes_run_id uuid default null,
  p_supersession_reason text default null
)
returns public.tax_calculation_runs
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_run public.tax_calculation_runs%rowtype;
  v_component_count integer;
  v_inserted_count integer;
  v_component jsonb;
  v_final public.tax_calculation_runs%rowtype;
begin
  if p_status not in ('completed', 'partial') then
    raise exception 'invalid_run_status';
  end if;

  if jsonb_typeof(coalesce(p_components, '[]'::jsonb)) <> 'array' then
    raise exception 'components_must_be_array';
  end if;

  v_component_count := jsonb_array_length(coalesce(p_components, '[]'::jsonb));
  if v_component_count <= 0 then
    raise exception 'incomplete_component_set';
  end if;

  select *
    into v_run
    from public.tax_calculation_runs
   where id = p_run_id
     and business_id = p_business_id
   for update;

  if not found then
    raise exception 'run_not_found';
  end if;

  if v_run.status <> 'running' then
    raise exception 'run_not_running';
  end if;

  for v_component in select * from jsonb_array_elements(p_components)
  loop
    insert into public.tax_calculation_components (
      run_id,
      business_id,
      component_key,
      component_type,
      component_name,
      taxable_base,
      rate,
      amount,
      direction,
      explanation,
      source_refs,
      sort_order,
      metadata,
      created_at
    )
    values (
      p_run_id,
      p_business_id,
      v_component->>'component_key',
      v_component->>'component_type',
      v_component->>'component_name',
      nullif(v_component->>'taxable_base', '')::numeric,
      nullif(v_component->>'rate', '')::numeric,
      coalesce(nullif(v_component->>'amount', '')::numeric, 0),
      v_component->>'direction',
      v_component->>'explanation',
      coalesce(v_component->'source_refs', '{}'::jsonb),
      coalesce(nullif(v_component->>'sort_order', '')::integer, 0),
      coalesce(v_component->'metadata', '{}'::jsonb),
      now()
    );
  end loop;

  get diagnostics v_inserted_count = row_count;
  -- row_count from the loop only reflects the last insert, so verify against the table.
  select count(*) into v_inserted_count
    from public.tax_calculation_components
   where run_id = p_run_id
     and business_id = p_business_id;

  if v_inserted_count <> v_component_count then
    raise exception 'component_count_mismatch';
  end if;

  update public.tax_calculation_runs
     set status = p_status,
         completion_type = p_completion_type,
         tax_profile_id = nullif(p_summary->>'tax_profile_id', '')::uuid,
         entity_type = p_summary->>'entity_type',
         filing_status = p_summary->>'filing_status',
         state_code = p_summary->>'state_code',
         book_revenue_ytd = nullif(p_summary->>'book_revenue_ytd', '')::numeric,
         book_expenses_ytd = nullif(p_summary->>'book_expenses_ytd', '')::numeric,
         book_profit_ytd = nullif(p_summary->>'book_profit_ytd', '')::numeric,
         deductible_expenses_ytd = nullif(p_summary->>'deductible_expenses_ytd', '')::numeric,
         nondeductible_addbacks_ytd = nullif(p_summary->>'nondeductible_addbacks_ytd', '')::numeric,
         tax_adjustments_ytd = nullif(p_summary->>'tax_adjustments_ytd', '')::numeric,
         taxable_income_ytd = nullif(p_summary->>'taxable_income_ytd', '')::numeric,
         projected_taxable_income = nullif(p_summary->>'projected_taxable_income', '')::numeric,
         estimated_federal_tax = nullif(p_summary->>'estimated_federal_tax', '')::numeric,
         estimated_state_tax = nullif(p_summary->>'estimated_state_tax', '')::numeric,
         estimated_se_tax = nullif(p_summary->>'estimated_se_tax', '')::numeric,
         estimated_payroll_tax_effect = nullif(p_summary->>'estimated_payroll_tax_effect', '')::numeric,
         estimated_other_tax = nullif(p_summary->>'estimated_other_tax', '')::numeric,
         qbi_deduction_estimate = nullif(p_summary->>'qbi_deduction_estimate', '')::numeric,
         estimated_total_tax = nullif(p_summary->>'estimated_total_tax', '')::numeric,
         payments_ytd = nullif(p_summary->>'payments_ytd', '')::numeric,
         withholding_ytd = nullif(p_summary->>'withholding_ytd', '')::numeric,
         remaining_projected_liability = nullif(p_summary->>'remaining_projected_liability', '')::numeric,
         safe_harbor_target = nullif(p_summary->>'safe_harbor_target', '')::numeric,
         safe_harbor_covered = nullif(p_summary->>'safe_harbor_covered', '')::numeric,
         safe_harbor_gap = nullif(p_summary->>'safe_harbor_gap', '')::numeric,
         recommended_reserve = nullif(p_summary->>'recommended_reserve', '')::numeric,
         current_reserve = nullif(p_summary->>'current_reserve', '')::numeric,
         reserve_gap = nullif(p_summary->>'reserve_gap', '')::numeric,
         confidence_score = p_confidence_score,
         confidence_level = p_summary->>'confidence_level',
         confidence_status = p_summary->>'confidence_status',
         confidence_factors = coalesce(p_summary->'confidence_factors', '[]'::jsonb),
         confidence_penalties = coalesce(p_summary->'confidence_penalties', '[]'::jsonb),
         confidence_blockers = coalesce(p_summary->'confidence_blockers', '[]'::jsonb),
         confidence_methodology_version = p_summary->>'confidence_methodology_version',
         estimate_ready = coalesce((p_summary->>'estimate_ready')::boolean, false),
         reserve_ready = coalesce((p_summary->>'reserve_ready')::boolean, false),
         assumptions = p_assumptions,
         warnings = p_warnings,
         missing_inputs = p_missing_inputs,
         source_freshness = p_source_freshness,
         expected_component_count = v_component_count,
         persisted_component_count = v_inserted_count,
         completed_at = now()
   where id = p_run_id
     and business_id = p_business_id
   returning * into v_final;

  if p_supersedes_run_id is not null then
    insert into public.tax_calculation_run_links (
      business_id,
      older_run_id,
      newer_run_id,
      relation_type,
      reason,
      created_at
    )
    values (
      p_business_id,
      p_supersedes_run_id,
      p_run_id,
      'supersedes',
      p_supersession_reason,
      now()
    )
    on conflict do nothing;
  end if;

  return v_final;
end;
$$;

revoke all on function public.finalize_tax_calculation_run(
  uuid,
  uuid,
  text,
  text,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  numeric,
  uuid,
  text
) from public, anon, authenticated;

grant execute on function public.finalize_tax_calculation_run(
  uuid,
  uuid,
  text,
  text,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  numeric,
  uuid,
  text
) to service_role;
