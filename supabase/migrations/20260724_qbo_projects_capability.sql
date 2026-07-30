create table if not exists public.qbo_projects_capabilities (
  id uuid not null default gen_random_uuid(),
  business_id uuid not null,
  realm_id text not null,
  qbo_env text not null default 'sandbox',
  status text not null default 'unknown',
  checked_at timestamp with time zone null,
  accounting_scope_present boolean not null default false,
  project_scope_present boolean not null default false,
  projects_enabled_preference boolean null,
  entitlement_response jsonb not null default '{}'::jsonb,
  error_response jsonb not null default '{}'::jsonb,
  last_successful_project_sync timestamp with time zone null,
  source_of_truth text not null default 'manual_link_only',
  auto_import_enabled boolean not null default false,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint qbo_projects_capabilities_pkey primary key (id),
  constraint qbo_projects_capabilities_business_fkey foreign key (business_id) references public.business_profiles (id),
  constraint qbo_projects_capabilities_status_check check (
    status in (
      'available_and_enabled',
      'available_but_projects_disabled',
      'scope_not_authorized',
      'partner_entitlement_missing',
      'unsupported_qbo_plan',
      'graphql_unavailable',
      'unknown',
      'error'
    )
  ),
  constraint qbo_projects_capabilities_source_of_truth_check check (
    source_of_truth in (
      'qbo_project_authoritative',
      'bizzi_authoritative',
      'manual_link_only',
      'external_system_authoritative'
    )
  ),
  constraint qbo_projects_capabilities_unique unique (business_id, realm_id, qbo_env)
);

create index if not exists idx_qbo_projects_capabilities_business
  on public.qbo_projects_capabilities using btree (business_id);

create table if not exists public.qbo_projects (
  id uuid not null default gen_random_uuid(),
  business_id uuid not null,
  job_id uuid null,
  customer_id uuid null,
  realm_id text not null,
  qbo_env text not null default 'sandbox',
  qbo_project_id text not null,
  qbo_parent_customer_id text null,
  display_name text null,
  fully_qualified_name text null,
  project_name text null,
  status text null,
  active boolean null,
  start_date date null,
  end_date date null,
  billing_address jsonb not null default '{}'::jsonb,
  shipping_address jsonb not null default '{}'::jsonb,
  sync_token text null,
  source_updated_at timestamp with time zone null,
  last_synced_at timestamp with time zone null,
  sync_status text not null default 'synced',
  source_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint qbo_projects_pkey primary key (id),
  constraint qbo_projects_business_fkey foreign key (business_id) references public.business_profiles (id),
  constraint qbo_projects_job_fkey foreign key (job_id) references public.jobs (id),
  constraint qbo_projects_customer_fkey foreign key (customer_id) references public.customers (id),
  constraint qbo_projects_unique unique (business_id, realm_id, qbo_project_id)
);

create index if not exists idx_qbo_projects_business
  on public.qbo_projects using btree (business_id);

create index if not exists idx_qbo_projects_job
  on public.qbo_projects using btree (job_id);

create index if not exists idx_qbo_projects_parent_customer
  on public.qbo_projects using btree (business_id, realm_id, qbo_parent_customer_id);

alter table public.jobs
  add column if not exists source_of_truth text not null default 'manual_link_only';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'jobs_source_of_truth_check'
      and conrelid = 'public.jobs'::regclass
  ) then
    alter table public.jobs
      add constraint jobs_source_of_truth_check check (
        source_of_truth in (
          'qbo_project_authoritative',
          'bizzi_authoritative',
          'manual_link_only',
          'external_system_authoritative'
        )
      );
  end if;
end $$;
