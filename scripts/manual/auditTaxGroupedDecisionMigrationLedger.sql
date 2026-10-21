BEGIN READ ONLY;

-- READ-ONLY MIGRATION-LEDGER AND LIVE-SCHEMA AUDIT
--
-- Supabase SQL Editor displays one final result grid. This script packages each
-- bounded catalog/rule-library result as an ordered JSONB array in that grid.
-- No application routine is invoked and no customer data is returned.

with
-- migration_ledger_versions
-- Interpretation: this is the remote ledger, not a conclusion about every
-- local file. A missing per-file version requires the live-object checks below.
migration_ledger_versions as (
  select
    'migration_ledger_versions'::text as result_set,
    version,
    name,
    pg_column_size(statements)::integer as statement_payload_bytes,
    left(md5(statements::text), 16) as statement_payload_fingerprint
  from supabase_migrations.schema_migrations
  order by version
  limit 500
),

-- tax_rule_library_versions
-- Interpretation: these data-only rule-library milestones cannot be proved by
-- catalog shape alone. Compare the reported version counts to the local seed
-- files; do not treat zero for an old version as evidence of data loss.
tax_rule_library_versions as (
  select
    'tax_rule_library_versions'::text as result_set,
    version,
    is_active,
    count(*)::integer as global_rule_count
  from public.tax_deduction_rules
  where scope = 'global'
    and business_id is null
    and tax_year = 2026
  group by version, is_active
  order by version, is_active desc
  limit 100
),

-- prerequisite_schema_markers
-- Interpretation: each row is one concrete object expected by a Tax migration
-- that the atomic grouped-decision command depends on. present = false means
-- the live schema lacks that contract. A data-only seed is represented by the
-- rule-library result rather than a fabricated schema marker.
prerequisite_schema_markers as (
  with markers as (
    select '20260923_tax_phase1_contract_repair'::text as migration, 'column'::text as object_kind, 'public.transaction_tax_classifications.requires_review'::text as object_name, exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'transaction_tax_classifications' and column_name = 'requires_review') as present
    union all select '20260923_tax_phase1_contract_repair', 'column_contract', 'requires_review is not null with default true', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'transaction_tax_classifications' and column_name = 'requires_review' and is_nullable = 'NO' and column_default is not null)
    union all select '20260925_tax_classification_lifecycle', 'relation', 'public.tax_classification_runs', to_regclass('public.tax_classification_runs') is not null
    union all select '20260925_tax_classification_lifecycle', 'function', 'public.claim_tax_classification_runs(text,integer,timestamptz)', to_regprocedure('public.claim_tax_classification_runs(text,integer,timestamptz)') is not null
    union all select '20260925_tax_classification_lifecycle', 'function', 'public.touch_tax_classification_runs()', to_regprocedure('public.touch_tax_classification_runs()') is not null
    union all select '20260925_tax_classification_lifecycle', 'index', 'public.tax_classification_runs_active_uidx', to_regclass('public.tax_classification_runs_active_uidx') is not null
    union all select '20260925_tax_classification_lifecycle', 'index', 'public.tax_classification_runs_business_year_idx', to_regclass('public.tax_classification_runs_business_year_idx') is not null
    union all select '20260925_tax_classification_lifecycle', 'index', 'public.tax_classification_runs_due_idx', to_regclass('public.tax_classification_runs_due_idx') is not null
    union all select '20260925_tax_classification_lifecycle', 'constraint', 'tax_classification_runs_status_check', exists (select 1 from pg_constraint where conrelid = to_regclass('public.tax_classification_runs') and conname = 'tax_classification_runs_status_check')
    union all select '20260925_tax_classification_lifecycle', 'constraint', 'tax_classification_runs_trigger_source_check', exists (select 1 from pg_constraint where conrelid = to_regclass('public.tax_classification_runs') and conname = 'tax_classification_runs_trigger_source_check')
    union all select '20260925_tax_classification_lifecycle', 'trigger', 'tax_classification_runs_touch_updated_at', exists (select 1 from pg_trigger where tgrelid = to_regclass('public.tax_classification_runs') and tgname = 'tax_classification_runs_touch_updated_at' and not tgisinternal)
    union all select '20260925_tax_classification_lifecycle', 'policy', 'tax_classification_runs_authenticated_select', exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'tax_classification_runs' and policyname = 'tax_classification_runs_authenticated_select')
    union all select '20260925_tax_classification_lifecycle', 'policy', 'tax_classification_runs_service_role_all', exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'tax_classification_runs' and policyname = 'tax_classification_runs_service_role_all')
    union all select '20260925_tax_classification_lifecycle', 'access', 'service_role table access contract', coalesce(has_table_privilege('service_role', to_regclass('public.tax_classification_runs'), 'select') and has_table_privilege('service_role', to_regclass('public.tax_classification_runs'), 'insert') and has_table_privilege('service_role', to_regclass('public.tax_classification_runs'), 'update'), false)
    union all select '20260925_tax_classification_lifecycle', 'access', 'service_role claim function access contract', coalesce(has_function_privilege('service_role', to_regprocedure('public.claim_tax_classification_runs(text,integer,timestamptz)'), 'execute'), false)
    union all select '20261005_tax_classification_bulk_override_rpc', 'function', 'public.apply_tax_classification_override_batch(uuid,integer,uuid,text,text,jsonb)', to_regprocedure('public.apply_tax_classification_override_batch(uuid,integer,uuid,text,text,jsonb)') is not null
    union all select '20261005_tax_classification_bulk_override_rpc', 'access', 'service_role batch function access contract', coalesce(has_function_privilege('service_role', to_regprocedure('public.apply_tax_classification_override_batch(uuid,integer,uuid,text,text,jsonb)'), 'execute'), false)
    union all select '20261005_tax_classification_bulk_override_rpc', 'access', 'authenticated batch function denied', not coalesce(has_function_privilege('authenticated', to_regprocedure('public.apply_tax_classification_override_batch(uuid,integer,uuid,text,text,jsonb)'), 'execute'), false)
    union all select '20261006_tax_vehicle_mileage_inputs', 'relation', 'public.tax_vehicle_mileage_inputs', to_regclass('public.tax_vehicle_mileage_inputs') is not null
    union all select '20261006_tax_vehicle_mileage_inputs', 'index', 'public.tax_vehicle_mileage_inputs_business_year_idx', to_regclass('public.tax_vehicle_mileage_inputs_business_year_idx') is not null
    union all select '20261006_tax_vehicle_mileage_inputs', 'constraint', 'tax_vehicle_mileage_inputs_tax_year_check', exists (select 1 from pg_constraint where conrelid = to_regclass('public.tax_vehicle_mileage_inputs') and conname = 'tax_vehicle_mileage_inputs_tax_year_check')
    union all select '20261006_tax_vehicle_mileage_inputs', 'constraint', 'tax_vehicle_mileage_inputs_period_check', exists (select 1 from pg_constraint where conrelid = to_regclass('public.tax_vehicle_mileage_inputs') and conname = 'tax_vehicle_mileage_inputs_period_check')
    union all select '20261006_tax_vehicle_mileage_inputs', 'constraint', 'tax_vehicle_mileage_inputs_business_miles_check', exists (select 1 from pg_constraint where conrelid = to_regclass('public.tax_vehicle_mileage_inputs') and conname = 'tax_vehicle_mileage_inputs_business_miles_check')
    union all select '20261006_tax_vehicle_mileage_inputs', 'constraint', 'tax_vehicle_mileage_inputs_mileage_basis_check', exists (select 1 from pg_constraint where conrelid = to_regclass('public.tax_vehicle_mileage_inputs') and conname = 'tax_vehicle_mileage_inputs_mileage_basis_check')
    union all select '20261006_tax_vehicle_mileage_inputs', 'constraint', 'tax_vehicle_mileage_inputs_source_check', exists (select 1 from pg_constraint where conrelid = to_regclass('public.tax_vehicle_mileage_inputs') and conname = 'tax_vehicle_mileage_inputs_source_check')
    union all select '20261006_tax_vehicle_mileage_inputs', 'policy', 'tax_vehicle_mileage_inputs_service_role_all', exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'tax_vehicle_mileage_inputs' and policyname = 'tax_vehicle_mileage_inputs_service_role_all')
    union all select '20261006_tax_vehicle_mileage_inputs', 'access', 'service_role vehicle table access contract', coalesce(has_table_privilege('service_role', to_regclass('public.tax_vehicle_mileage_inputs'), 'select') and has_table_privilege('service_role', to_regclass('public.tax_vehicle_mileage_inputs'), 'insert') and has_table_privilege('service_role', to_regclass('public.tax_vehicle_mileage_inputs'), 'update') and has_table_privilege('service_role', to_regclass('public.tax_vehicle_mileage_inputs'), 'delete'), false)
    union all select '20261006_tax_vehicle_mileage_inputs', 'access', 'authenticated vehicle table read denied', not coalesce(has_table_privilege('authenticated', to_regclass('public.tax_vehicle_mileage_inputs'), 'select'), false)
    union all select '20261008_tax_review_holding_state', 'function_behavior', 'batch override accepts holding state', exists (select 1 from pg_proc where oid = to_regprocedure('public.apply_tax_classification_override_batch(uuid,integer,uuid,text,text,jsonb)') and pg_get_functiondef(oid) like '%needs_tax_review%')
    union all select '20261008_tax_review_holding_state', 'function_behavior', 'batch override accepts not-yet-determined', exists (select 1 from pg_proc where oid = to_regprocedure('public.apply_tax_classification_override_batch(uuid,integer,uuid,text,text,jsonb)') and pg_get_functiondef(oid) like '%not_yet_determined%')
    union all select '20261101121000_atomic_grouped_tax_deduction_decision', 'relation', 'public.tax_grouped_deduction_decision_operations', to_regclass('public.tax_grouped_deduction_decision_operations') is not null
    union all select '20261101121000_atomic_grouped_tax_deduction_decision', 'column', 'grouped operations core idempotency columns', (select count(*) = 4 from information_schema.columns where table_schema = 'public' and table_name = 'tax_grouped_deduction_decision_operations' and column_name in ('business_id', 'tax_year', 'idempotency_key', 'scope_fingerprint'))
    union all select '20261101121000_atomic_grouped_tax_deduction_decision', 'constraint', 'grouped operations unique business_id/idempotency_key', exists (select 1 from pg_constraint where conrelid = to_regclass('public.tax_grouped_deduction_decision_operations') and contype = 'u' and pg_get_constraintdef(oid) = 'UNIQUE (business_id, idempotency_key)')
    union all select '20261101121000_atomic_grouped_tax_deduction_decision', 'function', 'public.apply_grouped_tax_deduction_decision(uuid,integer,uuid,text,text,text,jsonb,text,jsonb,jsonb,jsonb,jsonb)', to_regprocedure('public.apply_grouped_tax_deduction_decision(uuid,integer,uuid,text,text,text,jsonb,text,jsonb,jsonb,jsonb,jsonb)') is not null
    union all select '20261101121000_atomic_grouped_tax_deduction_decision', 'index', 'public.tax_grouped_deduction_decision_operations_lookup_idx', to_regclass('public.tax_grouped_deduction_decision_operations_lookup_idx') is not null
    union all select '20261101121000_atomic_grouped_tax_deduction_decision', 'access', 'service_role grouped table access contract', coalesce(has_table_privilege('service_role', to_regclass('public.tax_grouped_deduction_decision_operations'), 'select') and has_table_privilege('service_role', to_regclass('public.tax_grouped_deduction_decision_operations'), 'insert') and has_table_privilege('service_role', to_regclass('public.tax_grouped_deduction_decision_operations'), 'update'), false)
    union all select '20261101121000_atomic_grouped_tax_deduction_decision', 'access', 'authenticated grouped table read denied', not coalesce(has_table_privilege('authenticated', to_regclass('public.tax_grouped_deduction_decision_operations'), 'select'), false)
    union all select '20261101121000_atomic_grouped_tax_deduction_decision', 'access', 'service_role grouped command access contract', coalesce(has_function_privilege('service_role', to_regprocedure('public.apply_grouped_tax_deduction_decision(uuid,integer,uuid,text,text,text,jsonb,text,jsonb,jsonb,jsonb,jsonb)'), 'execute'), false)
    union all select '20261101121000_atomic_grouped_tax_deduction_decision', 'access', 'authenticated grouped command denied', not coalesce(has_function_privilege('authenticated', to_regprocedure('public.apply_grouped_tax_deduction_decision(uuid,integer,uuid,text,text,text,jsonb,text,jsonb,jsonb,jsonb,jsonb)'), 'execute'), false)
  )
  select
    'prerequisite_schema_markers'::text as result_set,
    migration,
    object_kind,
    object_name,
    present
  from markers
  order by migration, object_kind, object_name
),

-- live_tax_contract_details
-- Interpretation: compare the reported integrity/security markers with the
-- local migrations. This deliberately reports only booleans and fingerprints,
-- never a function body or customer data.
live_tax_contract_details as (
  with objects as (
    select 'tax_classification_runs'::text as object_name, to_regclass('public.tax_classification_runs') as relation_oid, null::regprocedure as procedure_oid
    union all select 'tax_vehicle_mileage_inputs', to_regclass('public.tax_vehicle_mileage_inputs'), null::regprocedure
    union all select 'apply_tax_classification_override_batch', null::regclass, to_regprocedure('public.apply_tax_classification_override_batch(uuid,integer,uuid,text,text,jsonb)')
    union all select 'apply_grouped_tax_deduction_decision', null::regclass, to_regprocedure('public.apply_grouped_tax_deduction_decision(uuid,integer,uuid,text,text,text,jsonb,text,jsonb,jsonb,jsonb,jsonb)')
  )
  select
    'live_tax_contract_details'::text as result_set,
    object_name,
    relation_oid is not null as relation_present,
    coalesce((select c.relrowsecurity from pg_class c where c.oid = relation_oid), false) as rls_enabled,
    coalesce((select c.relforcerowsecurity from pg_class c where c.oid = relation_oid), false) as force_rls_enabled,
    procedure_oid is not null as function_present,
    coalesce((select p.prosecdef from pg_proc p where p.oid = procedure_oid), false) as security_definer,
    case when procedure_oid is not null then left(md5(pg_get_functiondef(procedure_oid)), 16) else null end as function_definition_fingerprint
  from objects
  order by object_name
),

-- grouped_command_access_contract
-- Interpretation: all values must become true only after the atomic migration
-- is intentionally deployed. Before deployment, false is expected and is not
-- an invitation to run any history-reconciliation command.
grouped_command_access_contract as (
  with target as (
    select
      to_regclass('public.tax_grouped_deduction_decision_operations') as relation_oid,
      to_regprocedure('public.apply_grouped_tax_deduction_decision(uuid,integer,uuid,text,text,text,jsonb,text,jsonb,jsonb,jsonb,jsonb)') as procedure_oid
  )
  select
    'grouped_command_access_contract'::text as result_set,
    relation_oid is not null as relation_present,
    coalesce((select c.relrowsecurity from pg_class c where c.oid = relation_oid), false) as rls_enabled,
    coalesce((select c.relforcerowsecurity from pg_class c where c.oid = relation_oid), false) as force_rls_enabled,
    procedure_oid is not null as function_present,
    case when relation_oid is null then false else has_table_privilege('service_role', relation_oid, 'select') end as service_role_can_select_relation,
    case when procedure_oid is null then false else has_function_privilege('service_role', procedure_oid, 'execute') end as service_role_can_execute_function
  from target
),

-- ledger_schema_assessment
-- Interpretation: one early ledger record plus later live Tax contracts is
-- schema-ahead-of-ledger evidence. It is consistent with an out-of-band
-- bootstrap or manual schema application, but database metadata alone cannot
-- attribute the mechanism to a particular operator interface.
ledger_schema_assessment as (
  with ledger as (
    select count(*)::integer as ledger_row_count, min(version) as earliest_version, max(version) as latest_version
    from supabase_migrations.schema_migrations
  ), contracts as (
    select
      to_regclass('public.tax_classification_runs') is not null as lifecycle_relation_present,
      to_regclass('public.tax_vehicle_mileage_inputs') is not null as vehicle_relation_present,
      to_regprocedure('public.apply_tax_classification_override_batch(uuid,integer,uuid,text,text,jsonb)') is not null as batch_function_present,
      to_regclass('public.tax_grouped_deduction_decision_operations') is not null as grouped_relation_present,
      to_regprocedure('public.apply_grouped_tax_deduction_decision(uuid,integer,uuid,text,text,text,jsonb,text,jsonb,jsonb,jsonb,jsonb)') is not null as grouped_function_present
  )
  select
    'ledger_schema_assessment'::text as result_set,
    ledger_row_count,
    earliest_version,
    latest_version,
    lifecycle_relation_present,
    vehicle_relation_present,
    batch_function_present,
    grouped_relation_present,
    grouped_function_present,
    (lifecycle_relation_present and vehicle_relation_present and batch_function_present and latest_version < '20260925') as schema_ahead_of_versioned_ledger,
    (not grouped_relation_present and not grouped_function_present) as atomic_grouped_migration_not_present
  from ledger
  cross join contracts
),

sections as (
  select 1::integer as result_order, 'migration_ledger_versions'::text as result_set, x.payload
  from lateral (select coalesce(jsonb_agg(to_jsonb(r) order by r.version), '[]'::jsonb) as payload from migration_ledger_versions r) x
  union all
  select 2, 'tax_rule_library_versions', x.payload
  from lateral (select coalesce(jsonb_agg(to_jsonb(r) order by r.version, r.is_active desc), '[]'::jsonb) as payload from tax_rule_library_versions r) x
  union all
  select 3, 'prerequisite_schema_markers', x.payload
  from lateral (select coalesce(jsonb_agg(to_jsonb(r) order by r.migration, r.object_kind, r.object_name), '[]'::jsonb) as payload from prerequisite_schema_markers r) x
  union all
  select 4, 'live_tax_contract_details', x.payload
  from lateral (select coalesce(jsonb_agg(to_jsonb(r) order by r.object_name), '[]'::jsonb) as payload from live_tax_contract_details r) x
  union all
  select 5, 'grouped_command_access_contract', x.payload
  from lateral (select coalesce(jsonb_agg(to_jsonb(r) order by r.result_set), '[]'::jsonb) as payload from grouped_command_access_contract r) x
  union all
  select 6, 'ledger_schema_assessment', x.payload
  from lateral (select coalesce(jsonb_agg(to_jsonb(r) order by r.result_set), '[]'::jsonb) as payload from ledger_schema_assessment r) x
)
select
  result_order,
  result_set,
  jsonb_array_length(payload)::integer as row_count,
  payload
from sections
order by result_order;

COMMIT;
