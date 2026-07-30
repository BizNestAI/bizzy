-- Harden Bizzi Jobs/QBO tables with tenant RLS and realm-aware QBO identity keys.
-- This migration is intentionally idempotent and preserves existing data. If legacy
-- rows collide under the new realm-aware keys, those collisions are recorded and the
-- affected uniqueness replacement is skipped until the rows are remediated.

create table if not exists public.job_costing_realm_integrity_conflicts (
  id uuid primary key default gen_random_uuid(),
  migration_name text not null,
  business_id uuid null,
  table_name text not null,
  conflict_key jsonb not null default '{}'::jsonb,
  duplicate_count integer not null default 0,
  sample_ids jsonb not null default '[]'::jsonb,
  detected_at timestamp with time zone not null default now()
);

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

alter table if exists public.customer_external_links add column if not exists qbo_env text;
alter table if exists public.job_external_links add column if not exists qbo_env text;
alter table if exists public.job_revenue_documents add column if not exists qbo_env text;
alter table if exists public.job_payment_records add column if not exists realm_id text;
alter table if exists public.job_payment_records add column if not exists qbo_env text;
alter table if exists public.job_revenue_evidence add column if not exists realm_id text;
alter table if exists public.job_revenue_evidence add column if not exists qbo_env text;
alter table if exists public.job_candidates add column if not exists realm_id text;
alter table if exists public.job_candidates add column if not exists qbo_env text;
alter table if exists public.job_identity_mappings add column if not exists realm_id text;
alter table if exists public.job_identity_mappings add column if not exists qbo_env text;

update public.customer_external_links set qbo_env = 'sandbox'
where qbo_env is null and source_system in ('quickbooks', 'qbo');
update public.job_external_links set qbo_env = 'sandbox'
where qbo_env is null and source_system in ('quickbooks', 'qbo');
update public.job_revenue_documents set qbo_env = 'sandbox'
where qbo_env is null and source_system in ('quickbooks', 'qbo');
update public.job_payment_records set qbo_env = 'sandbox'
where qbo_env is null and source_system in ('quickbooks', 'qbo');
update public.job_candidates set qbo_env = 'sandbox'
where qbo_env is null and source_system in ('quickbooks', 'qbo');
update public.job_identity_mappings set qbo_env = 'sandbox'
where qbo_env is null and source_system in ('quickbooks', 'qbo');

delete from public.job_costing_realm_integrity_conflicts
where migration_name = '20260729_job_costing_rls_realm_integrity';

insert into public.job_costing_realm_integrity_conflicts (migration_name, business_id, table_name, conflict_key, duplicate_count, sample_ids)
select '20260729_job_costing_rls_realm_integrity', business_id, 'customer_external_links',
  jsonb_build_object('realm_id', coalesce(realm_id, '__missing_realm__'), 'source_system', source_system, 'source_entity_type', source_entity_type, 'external_entity_id', external_entity_id),
  count(*), jsonb_agg(id order by created_at desc)
from public.customer_external_links
where source_system in ('quickbooks', 'qbo') and external_entity_id is not null
group by business_id, coalesce(realm_id, '__missing_realm__'), source_system, source_entity_type, external_entity_id
having count(*) > 1;

insert into public.job_costing_realm_integrity_conflicts (migration_name, business_id, table_name, conflict_key, duplicate_count, sample_ids)
select '20260729_job_costing_rls_realm_integrity', business_id, 'job_external_links',
  jsonb_build_object('realm_id', coalesce(realm_id, '__missing_realm__'), 'source_system', source_system, 'source_entity_type', source_entity_type, 'external_entity_id', external_entity_id),
  count(*), jsonb_agg(id order by created_at desc)
from public.job_external_links
where source_system in ('quickbooks', 'qbo') and external_entity_id is not null
group by business_id, coalesce(realm_id, '__missing_realm__'), source_system, source_entity_type, external_entity_id
having count(*) > 1;

insert into public.job_costing_realm_integrity_conflicts (migration_name, business_id, table_name, conflict_key, duplicate_count, sample_ids)
select '20260729_job_costing_rls_realm_integrity', business_id, 'job_revenue_documents',
  jsonb_build_object('realm_id', coalesce(realm_id, '__missing_realm__'), 'source_system', source_system, 'source_document_type', source_document_type, 'external_document_id', external_document_id),
  count(*), jsonb_agg(id order by created_at desc)
from public.job_revenue_documents
where source_system in ('quickbooks', 'qbo') and external_document_id is not null
group by business_id, coalesce(realm_id, '__missing_realm__'), source_system, source_document_type, external_document_id
having count(*) > 1;

insert into public.job_costing_realm_integrity_conflicts (migration_name, business_id, table_name, conflict_key, duplicate_count, sample_ids)
select '20260729_job_costing_rls_realm_integrity', business_id, 'job_payment_records',
  jsonb_build_object('realm_id', coalesce(realm_id, '__missing_realm__'), 'source_system', source_system, 'external_payment_id', external_payment_id),
  count(*), jsonb_agg(id order by created_at desc)
from public.job_payment_records
where source_system in ('quickbooks', 'qbo') and external_payment_id is not null
group by business_id, coalesce(realm_id, '__missing_realm__'), source_system, external_payment_id
having count(*) > 1;

insert into public.job_costing_realm_integrity_conflicts (migration_name, business_id, table_name, conflict_key, duplicate_count, sample_ids)
select '20260729_job_costing_rls_realm_integrity', business_id, 'job_candidates',
  jsonb_build_object('realm_id', coalesce(realm_id, '__missing_realm__'), 'source_system', source_system, 'source_entity_type', source_entity_type, 'source_entity_id', source_entity_id),
  count(*), jsonb_agg(id order by created_at desc)
from public.job_candidates
where source_system in ('quickbooks', 'qbo') and source_entity_id is not null
group by business_id, coalesce(realm_id, '__missing_realm__'), source_system, source_entity_type, source_entity_id
having count(*) > 1;

insert into public.job_costing_realm_integrity_conflicts (migration_name, business_id, table_name, conflict_key, duplicate_count, sample_ids)
select '20260729_job_costing_rls_realm_integrity', business_id, 'job_identity_mappings',
  jsonb_build_object('realm_id', coalesce(realm_id, '__missing_realm__'), 'source_system', source_system, 'mapping_type', mapping_type, 'source_entity_id', source_entity_id),
  count(*), jsonb_agg(id order by created_at desc)
from public.job_identity_mappings
where active = true and source_system in ('quickbooks', 'qbo') and source_entity_id is not null
group by business_id, coalesce(realm_id, '__missing_realm__'), source_system, mapping_type, source_entity_id
having count(*) > 1;

insert into public.job_costing_realm_integrity_conflicts (migration_name, business_id, table_name, conflict_key, duplicate_count, sample_ids)
select '20260729_job_costing_rls_realm_integrity', business_id, 'job_revenue_evidence',
  jsonb_build_object('realm_id', coalesce(realm_id, '__missing_realm__'), 'qbo_txn_type', qbo_txn_type, 'qbo_txn_id', qbo_txn_id, 'job_id', coalesce(job_id, '00000000-0000-0000-0000-000000000000'::uuid)),
  count(*), jsonb_agg(id order by created_at desc)
from public.job_revenue_evidence
where qbo_txn_id is not null
group by business_id, coalesce(realm_id, '__missing_realm__'), qbo_txn_type, qbo_txn_id, coalesce(job_id, '00000000-0000-0000-0000-000000000000'::uuid)
having count(*) > 1;

insert into public.job_costing_realm_integrity_conflicts (migration_name, business_id, table_name, conflict_key, duplicate_count, sample_ids)
select '20260729_job_costing_rls_realm_integrity', business_id, 'qbo_projects',
  jsonb_build_object('realm_id', realm_id, 'qbo_project_id', qbo_project_id),
  count(*), jsonb_agg(id order by created_at desc)
from public.qbo_projects
where qbo_project_id is not null
group by business_id, realm_id, qbo_project_id
having count(*) > 1;

insert into public.job_costing_realm_integrity_conflicts (migration_name, business_id, table_name, conflict_key, duplicate_count, sample_ids)
select '20260729_job_costing_rls_realm_integrity', min(business_id::text)::uuid, 'qbo_webhook_events',
  jsonb_build_object('realm_id', realm_id, 'qbo_env', qbo_env, 'entity_type', entity_type, 'entity_id', entity_id, 'operation', operation, 'event_timestamp', event_timestamp),
  count(*), jsonb_agg(id order by event_received_at desc)
from public.qbo_webhook_events
where entity_id is not null and event_timestamp is not null
group by realm_id, qbo_env, entity_type, entity_id, operation, event_timestamp
having count(*) > 1;

do $$
begin
  if not exists (select 1 from public.job_costing_realm_integrity_conflicts where migration_name = '20260729_job_costing_rls_realm_integrity' and table_name = 'customer_external_links') then
    alter table public.customer_external_links drop constraint if exists customer_external_links_unique;
    if not exists (select 1 from pg_constraint where conname = 'customer_external_links_realm_unique') then
      alter table public.customer_external_links add constraint customer_external_links_realm_unique unique (business_id, realm_id, source_system, source_entity_type, external_entity_id);
    end if;
  end if;

  if not exists (select 1 from public.job_costing_realm_integrity_conflicts where migration_name = '20260729_job_costing_rls_realm_integrity' and table_name = 'job_external_links') then
    alter table public.job_external_links drop constraint if exists job_external_links_unique;
    if not exists (select 1 from pg_constraint where conname = 'job_external_links_realm_unique') then
      alter table public.job_external_links add constraint job_external_links_realm_unique unique (business_id, realm_id, source_system, source_entity_type, external_entity_id);
    end if;
  end if;

  if not exists (select 1 from public.job_costing_realm_integrity_conflicts where migration_name = '20260729_job_costing_rls_realm_integrity' and table_name = 'job_revenue_documents') then
    alter table public.job_revenue_documents drop constraint if exists job_revenue_documents_unique;
    if not exists (select 1 from pg_constraint where conname = 'job_revenue_documents_realm_unique') then
      alter table public.job_revenue_documents add constraint job_revenue_documents_realm_unique unique (business_id, realm_id, source_system, source_document_type, external_document_id);
    end if;
  end if;

  if not exists (select 1 from public.job_costing_realm_integrity_conflicts where migration_name = '20260729_job_costing_rls_realm_integrity' and table_name = 'job_payment_records') then
    alter table public.job_payment_records drop constraint if exists job_payment_records_unique;
    if not exists (select 1 from pg_constraint where conname = 'job_payment_records_realm_unique') then
      alter table public.job_payment_records add constraint job_payment_records_realm_unique unique (business_id, realm_id, source_system, external_payment_id);
    end if;
  end if;

  if not exists (select 1 from public.job_costing_realm_integrity_conflicts where migration_name = '20260729_job_costing_rls_realm_integrity' and table_name = 'job_candidates') then
    alter table public.job_candidates drop constraint if exists job_candidates_source_unique;
    if not exists (select 1 from pg_constraint where conname = 'job_candidates_source_realm_unique') then
      alter table public.job_candidates add constraint job_candidates_source_realm_unique unique (business_id, realm_id, source_system, source_entity_type, source_entity_id);
    end if;
  end if;
end $$;

do $$
begin
  if not exists (select 1 from public.job_costing_realm_integrity_conflicts where migration_name = '20260729_job_costing_rls_realm_integrity' and table_name = 'job_identity_mappings') then
    drop index if exists public.job_identity_mappings_source_entity_unique_idx;
    drop index if exists public.job_identity_mappings_address_unique_idx;
    create unique index if not exists job_identity_mappings_source_entity_realm_unique_idx
      on public.job_identity_mappings (business_id, realm_id, source_system, mapping_type, source_entity_id)
      where active = true and source_entity_id is not null;
    create unique index if not exists job_identity_mappings_address_realm_unique_idx
      on public.job_identity_mappings (business_id, realm_id, source_system, mapping_type, normalized_address_key)
      where active = true and normalized_address_key is not null;
  end if;

  if not exists (select 1 from public.job_costing_realm_integrity_conflicts where migration_name = '20260729_job_costing_rls_realm_integrity' and table_name = 'job_revenue_evidence') then
    drop index if exists public.job_revenue_evidence_qbo_unique_idx;
    create unique index if not exists job_revenue_evidence_qbo_realm_unique_idx
      on public.job_revenue_evidence (business_id, realm_id, qbo_txn_type, qbo_txn_id, coalesce(job_id, '00000000-0000-0000-0000-000000000000'::uuid))
      where qbo_txn_id is not null;
  end if;

  if not exists (select 1 from public.job_costing_realm_integrity_conflicts where migration_name = '20260729_job_costing_rls_realm_integrity' and table_name = 'qbo_webhook_events') then
    create unique index if not exists qbo_webhook_events_realm_entity_event_uidx
      on public.qbo_webhook_events (realm_id, qbo_env, entity_type, entity_id, operation, event_timestamp)
      where event_timestamp is not null;
  end if;
end $$;

alter table if exists public.customer_external_links
  drop constraint if exists customer_external_links_qbo_realm_required,
  add constraint customer_external_links_qbo_realm_required
  check (source_system not in ('quickbooks', 'qbo') or realm_id is not null) not valid;
alter table if exists public.job_external_links
  drop constraint if exists job_external_links_qbo_realm_required,
  add constraint job_external_links_qbo_realm_required
  check (source_system not in ('quickbooks', 'qbo') or realm_id is not null) not valid;
alter table if exists public.job_revenue_documents
  drop constraint if exists job_revenue_documents_qbo_realm_required,
  add constraint job_revenue_documents_qbo_realm_required
  check (source_system not in ('quickbooks', 'qbo') or realm_id is not null) not valid;
alter table if exists public.job_payment_records
  drop constraint if exists job_payment_records_qbo_realm_required,
  add constraint job_payment_records_qbo_realm_required
  check (source_system not in ('quickbooks', 'qbo') or realm_id is not null) not valid;
alter table if exists public.job_candidates
  drop constraint if exists job_candidates_qbo_realm_required,
  add constraint job_candidates_qbo_realm_required
  check (source_system not in ('quickbooks', 'qbo') or realm_id is not null) not valid;
alter table if exists public.job_identity_mappings
  drop constraint if exists job_identity_mappings_qbo_realm_required,
  add constraint job_identity_mappings_qbo_realm_required
  check (source_system not in ('quickbooks', 'qbo') or realm_id is not null) not valid;
alter table if exists public.job_revenue_evidence
  drop constraint if exists job_revenue_evidence_qbo_realm_required,
  add constraint job_revenue_evidence_qbo_realm_required
  check (qbo_txn_id is null or realm_id is not null) not valid;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'customers',
    'customer_external_links',
    'qbo_customers',
    'job_external_links',
    'job_revenue_documents',
    'job_payment_records',
    'job_payment_allocations',
    'job_revenue_evidence',
    'job_candidates',
    'job_identity_mappings',
    'qbo_projects',
    'qbo_projects_capabilities',
    'qbo_webhook_events',
    'qbo_entity_sync_runs',
    'qbo_cdc_cursors',
    'qbo_job_costing_backfill_runs',
    'qbo_job_costing_daily_sync_state',
    'job_transaction_assignments',
    'assignment_history',
    'job_assignment_suggestions',
    'job_assignment_instruction_history',
    'job_costing_realm_integrity_conflicts'
  ] loop
    if to_regclass(format('public.%I', table_name)) is not null then
      execute format('alter table public.%I enable row level security', table_name);

      execute format('drop policy if exists jc_tenant_select on public.%I', table_name);
      execute format(
        'create policy jc_tenant_select on public.%I for select to authenticated using (business_id is not null and public.tax_user_owns_business(business_id))',
        table_name
      );

      execute format('drop policy if exists jc_tenant_insert on public.%I', table_name);
      execute format(
        'create policy jc_tenant_insert on public.%I for insert to authenticated with check (business_id is not null and public.tax_user_owns_business(business_id))',
        table_name
      );

      execute format('drop policy if exists jc_tenant_update on public.%I', table_name);
      execute format(
        'create policy jc_tenant_update on public.%I for update to authenticated using (business_id is not null and public.tax_user_owns_business(business_id)) with check (business_id is not null and public.tax_user_owns_business(business_id))',
        table_name
      );

      execute format('drop policy if exists jc_tenant_delete on public.%I', table_name);
      execute format(
        'create policy jc_tenant_delete on public.%I for delete to authenticated using (business_id is not null and public.tax_user_owns_business(business_id))',
        table_name
      );
    end if;
  end loop;
end $$;
