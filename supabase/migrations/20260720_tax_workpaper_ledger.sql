-- Canonical persisted tax calculation workpaper ledger.
-- Existing calculation runs are preserved and marked legacy-incomplete until a
-- new canonical run persists first-class workpaper lines.

alter table if exists public.tax_calculation_runs
  add column if not exists workpaper_status text not null default 'legacy_incomplete',
  add column if not exists workpaper_version text null,
  add column if not exists workpaper_line_count integer not null default 0,
  add column if not exists workpaper_section_availability jsonb not null default '{}'::jsonb,
  add column if not exists rule_version_map jsonb not null default '{}'::jsonb,
  add column if not exists source_lineage_summary jsonb not null default '{}'::jsonb,
  add column if not exists payment_application_summary jsonb not null default '{}'::jsonb,
  add column if not exists workpaper_reconciliation_status text null,
  add column if not exists workpaper_reconciliation jsonb not null default '{}'::jsonb,
  add column if not exists workpaper_completed_at timestamptz null;

do $$
begin
  if to_regclass('public.tax_calculation_runs') is not null then
    update public.tax_calculation_runs
       set workpaper_status = 'legacy_incomplete'
     where workpaper_status is null;
  end if;
end $$;

create table if not exists public.tax_calculation_workpaper_lines (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.tax_calculation_runs(id),
  business_id uuid not null,
  tax_year integer not null,
  code text not null,
  label text not null,
  section text not null,
  parent_code text null,
  parent_id uuid null references public.tax_calculation_workpaper_lines(id),
  sort_order integer not null default 0,
  amount numeric null,
  quantity numeric null,
  percentage numeric null,
  display_sign text null,
  status text not null default 'calculated',
  support_level text null,
  confidence numeric null,
  formula_code text null,
  formula_description text null,
  rule_refs jsonb not null default '[]'::jsonb,
  rule_versions jsonb not null default '{}'::jsonb,
  explanation text null,
  source_type text null,
  source_refs jsonb not null default '[]'::jsonb,
  is_projection boolean not null default false,
  is_actual boolean not null default false,
  materiality text null,
  drill_down_type text null,
  drill_down_params jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (run_id, code)
);

create index if not exists tax_workpaper_lines_run_section_idx
  on public.tax_calculation_workpaper_lines (run_id, section, sort_order);

create index if not exists tax_workpaper_lines_business_year_idx
  on public.tax_calculation_workpaper_lines (business_id, tax_year);

create index if not exists tax_workpaper_lines_parent_code_idx
  on public.tax_calculation_workpaper_lines (run_id, parent_code);

create index if not exists tax_workpaper_lines_source_refs_gin_idx
  on public.tax_calculation_workpaper_lines using gin (source_refs);

create index if not exists tax_workpaper_lines_rule_versions_gin_idx
  on public.tax_calculation_workpaper_lines using gin (rule_versions);

alter table if exists public.tax_calculation_workpaper_lines enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename = 'tax_calculation_workpaper_lines'
       and policyname = 'tax_workpaper_lines_business_isolation_select'
  ) then
    create policy tax_workpaper_lines_business_isolation_select
      on public.tax_calculation_workpaper_lines
      for select
      using (
        exists (
          select 1
            from public.business_profiles bp
           where bp.id = tax_calculation_workpaper_lines.business_id
             and bp.user_id = auth.uid()
        )
      );
  end if;
end $$;
