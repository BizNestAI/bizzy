-- Tax module RLS and policy hardening.
-- This migration is intentionally defensive: policies are applied only when
-- the table exists, and business-scoped policies require business_id.

create or replace function public.tax_user_owns_business(p_business_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.business_profiles bp
    where bp.id = p_business_id
      and bp.user_id = auth.uid()
  );
$$;

revoke all on function public.tax_user_owns_business(uuid) from public, anon;
grant execute on function public.tax_user_owns_business(uuid) to authenticated, service_role;

do $$
declare
  t text;
  business_tables text[] := array[
    'tax_profiles',
    'tax_profile_memory',
    'transaction_tax_classifications',
    'tax_classification_overrides',
    'tax_adjustments',
    'tax_calculation_runs',
    'tax_calculation_components',
    'tax_calculation_run_links',
    'tax_payments',
    'tax_reserve_accounts',
    'tax_reserve_snapshots',
    'tax_review_tasks',
    'tax_projection_scenarios',
    'tax_recalculation_requests',
    'tax_scheduler_runs',
    'tax_legacy_migration_records',
    'tax_snapshots'
  ];
begin
  foreach t in array business_tables loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('alter table public.%I enable row level security', t);
      execute format('alter table public.%I force row level security', t);

      if exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = t and column_name = 'business_id'
      ) then
        execute format('drop policy if exists %I on public.%I', t || '_select_own_business', t);
        execute format(
          'create policy %I on public.%I for select to authenticated using (public.tax_user_owns_business(business_id))',
          t || '_select_own_business',
          t
        );
      end if;
    end if;
  end loop;
end $$;

do $$
declare
  t text;
  global_rule_tables text[] := array[
    'tax_rule_configs',
    'state_tax_rule_configs',
    'tax_deduction_rules',
    'tax_deadlines'
  ];
begin
  foreach t in array global_rule_tables loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('alter table public.%I enable row level security', t);
      execute format('alter table public.%I force row level security', t);

      execute format('drop policy if exists %I on public.%I', t || '_authenticated_safe_read', t);
      if exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = t and column_name = 'business_id'
      ) then
        execute format(
          'create policy %I on public.%I for select to authenticated using (business_id is null or public.tax_user_owns_business(business_id))',
          t || '_authenticated_safe_read',
          t
        );
      else
        execute format(
          'create policy %I on public.%I for select to authenticated using (true)',
          t || '_authenticated_safe_read',
          t
        );
      end if;
    end if;
  end loop;
end $$;

-- Explicitly leave user DML closed at RLS for immutable/audited Tax tables.
-- Backend service-role routes and audited RPCs perform approved mutations.

do $$
begin
  if to_regclass('public.tax_profiles') is not null then
    create index if not exists tax_profiles_business_year_idx on public.tax_profiles (business_id, tax_year);
  end if;
  if to_regclass('public.tax_profile_memory') is not null then
    create index if not exists tax_profile_memory_business_key_idx on public.tax_profile_memory (business_id, memory_key, effective_from desc);
  end if;
  if to_regclass('public.transaction_tax_classifications') is not null then
    create index if not exists transaction_tax_classifications_business_year_txn_idx on public.transaction_tax_classifications (business_id, tax_year, transaction_id);
  end if;
  if to_regclass('public.tax_classification_overrides') is not null then
    create index if not exists tax_classification_overrides_business_year_txn_idx on public.tax_classification_overrides (business_id, tax_year, transaction_id, created_at desc);
  end if;
  if to_regclass('public.tax_payments') is not null then
    create index if not exists tax_payments_business_year_type_idx on public.tax_payments (business_id, tax_year, payment_type, status);
  end if;
  if to_regclass('public.tax_reserve_accounts') is not null then
    create index if not exists tax_reserve_accounts_business_primary_idx on public.tax_reserve_accounts (business_id, is_primary) where is_primary = true;
  end if;
  if to_regclass('public.tax_reserve_snapshots') is not null then
    create index if not exists tax_reserve_snapshots_business_year_idx on public.tax_reserve_snapshots (business_id, tax_year, created_at desc);
  end if;
  if to_regclass('public.tax_review_tasks') is not null then
    create index if not exists tax_review_tasks_business_status_idx on public.tax_review_tasks (business_id, tax_year, status, severity);
  end if;
  if to_regclass('public.tax_snapshots') is not null then
    create index if not exists tax_snapshots_business_period_idx on public.tax_snapshots (business_id, tax_year, month);
  end if;
end $$;
