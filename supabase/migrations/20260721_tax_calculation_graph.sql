-- Canonical recursive tax calculation graph.
-- Historical runs are preserved. Existing runs are graph-legacy-incomplete until
-- a new canonical calculation persists graph nodes and an immutable input snapshot.

alter table if exists public.tax_calculation_runs
  add column if not exists calculation_graph_version text null,
  add column if not exists calculation_graph_status text not null default 'legacy_incomplete',
  add column if not exists calculation_graph_node_count integer not null default 0,
  add column if not exists calculation_graph_validation jsonb not null default '{}'::jsonb,
  add column if not exists calculation_input_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists calculation_graph_completed_at timestamptz null;

do $$
begin
  if to_regclass('public.tax_calculation_runs') is not null then
    update public.tax_calculation_runs
       set calculation_graph_status = 'legacy_incomplete'
     where calculation_graph_status is null;
  end if;
end $$;

create table if not exists public.tax_calculation_nodes (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.tax_calculation_runs(id),
  business_id uuid not null,
  tax_year integer not null,
  node_code text not null,
  node_type text not null,
  section_code text not null,
  parent_node_code text null,
  parent_node_id uuid null references public.tax_calculation_nodes(id),
  sort_order integer not null default 0,

  label text not null,
  description text null,

  amount numeric null,
  unit text null default 'money',
  display_sign text null,
  currency text not null default 'USD',

  status text not null default 'calculated',
  actual_or_projected text null,
  support_level text null,
  confidence numeric null,

  formula_code text null,
  formula_operator text null,
  formula_expression text null,
  formula_description text null,

  input_values jsonb not null default '[]'::jsonb,
  child_node_codes jsonb not null default '[]'::jsonb,
  child_node_ids jsonb not null default '[]'::jsonb,

  source_refs jsonb not null default '[]'::jsonb,
  rule_refs jsonb not null default '[]'::jsonb,
  assumption_refs jsonb not null default '[]'::jsonb,

  drilldown_type text null,
  drilldown_params jsonb not null default '{}'::jsonb,

  reconciliation_expected_amount numeric null,
  reconciliation_actual_amount numeric null,
  reconciliation_difference numeric null,
  reconciliation_status text null,

  calculation_engine text null,
  calculation_engine_path text null,
  calculation_version text null,

  traceability_status text not null default 'incomplete_lineage',
  traceability_reasons jsonb not null default '[]'::jsonb,
  reproducibility_status text not null default 'incomplete_lineage',

  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (run_id, node_code)
);

create index if not exists tax_calculation_nodes_run_section_idx
  on public.tax_calculation_nodes (run_id, section_code, sort_order);

create index if not exists tax_calculation_nodes_business_year_idx
  on public.tax_calculation_nodes (business_id, tax_year);

create index if not exists tax_calculation_nodes_parent_code_idx
  on public.tax_calculation_nodes (run_id, parent_node_code);

create index if not exists tax_calculation_nodes_traceability_idx
  on public.tax_calculation_nodes (run_id, traceability_status);

create index if not exists tax_calculation_nodes_source_refs_gin_idx
  on public.tax_calculation_nodes using gin (source_refs);

create index if not exists tax_calculation_nodes_rule_refs_gin_idx
  on public.tax_calculation_nodes using gin (rule_refs);

alter table if exists public.tax_calculation_nodes enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename = 'tax_calculation_nodes'
       and policyname = 'tax_calculation_nodes_business_isolation_select'
  ) then
    create policy tax_calculation_nodes_business_isolation_select
      on public.tax_calculation_nodes
      for select
      using (
        exists (
          select 1
            from public.business_profiles bp
           where bp.id = tax_calculation_nodes.business_id
             and bp.user_id = auth.uid()
        )
      );
  end if;
end $$;
