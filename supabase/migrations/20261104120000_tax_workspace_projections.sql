-- Versioned, server-owned Tax workspace read model. This migration only
-- creates storage/claim primitives; it performs no backfill or customer work.
create table if not exists public.tax_workspace_projections (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  tax_year integer not null check (tax_year between 2000 and 2200),
  projection_version text not null check (char_length(projection_version) between 1 and 80),
  formula_version text not null check (char_length(formula_version) between 1 and 120),
  source_fingerprint text not null check (source_fingerprint ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('complete')),
  completeness text not null check (completeness in ('complete', 'partial')),
  projection_data jsonb not null,
  generated_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint tax_workspace_data_object check (jsonb_typeof(projection_data) = 'object'),
  constraint tax_workspace_data_bound check (octet_length(projection_data::text) <= 1048576),
  unique (business_id, tax_year, projection_version, source_fingerprint)
);

create index if not exists tax_workspace_projection_latest_idx
  on public.tax_workspace_projections
  (business_id, tax_year, projection_version, generated_at desc, created_at desc)
  where status = 'complete';

create table if not exists public.tax_workspace_projection_requests (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  tax_year integer not null check (tax_year between 2000 and 2200),
  request_key text not null check (char_length(request_key) between 1 and 200),
  reason text not null check (char_length(reason) between 1 and 80),
  status text not null default 'pending' check (status in ('pending','processing','completed','failed','dead_letter')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  process_after timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  completed_at timestamptz,
  projection_id uuid references public.tax_workspace_projections(id),
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (request_key)
);

create index if not exists tax_workspace_projection_requests_due_idx
  on public.tax_workspace_projection_requests(status, process_after);
create index if not exists tax_workspace_projection_requests_scope_idx
  on public.tax_workspace_projection_requests(business_id, tax_year, status);

alter table public.tax_workspace_projections enable row level security;
alter table public.tax_workspace_projections force row level security;
alter table public.tax_workspace_projection_requests enable row level security;
alter table public.tax_workspace_projection_requests force row level security;

revoke all on table public.tax_workspace_projections from public, anon, authenticated;
revoke all on table public.tax_workspace_projection_requests from public, anon, authenticated;
revoke all on table public.tax_workspace_projections from service_role;
revoke all on table public.tax_workspace_projection_requests from service_role;
grant select on table public.tax_workspace_projections to service_role;
grant select, insert, update on table public.tax_workspace_projection_requests to service_role;

alter table public.tax_workspace_projections owner to postgres;
alter table public.tax_workspace_projection_requests owner to postgres;

create or replace function public.persist_tax_workspace_projection(
  p_business_id uuid,
  p_tax_year integer,
  p_projection_version text,
  p_formula_version text,
  p_source_fingerprint text,
  p_completeness text,
  p_payload jsonb,
  p_generated_at timestamptz
) returns public.tax_workspace_projections
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare result public.tax_workspace_projections;
begin
  if jsonb_typeof(p_payload) <> 'object'
    or p_payload->>'canonicalBusinessId' <> p_business_id::text
    or nullif(p_payload->>'taxYear','')::integer is distinct from p_tax_year
    or p_payload->>'projectionVersion' <> p_projection_version
    or p_payload->>'formulaVersion' <> p_formula_version
    or p_payload->>'sourceFingerprint' <> p_source_fingerprint
    or p_payload->>'status' <> 'complete'
    or p_payload->>'completeness' <> p_completeness
    or jsonb_typeof(p_payload->'matrix') <> 'array'
    or jsonb_typeof(p_payload->'questionGroups') <> 'array'
  then
    raise exception using errcode = '23514', message = 'invalid tax workspace projection payload';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_business_id::text || ':' || p_tax_year::text || ':' || p_projection_version, 0));
  insert into public.tax_workspace_projections
    (business_id,tax_year,projection_version,formula_version,source_fingerprint,status,completeness,projection_data,generated_at)
  values
    (p_business_id,p_tax_year,p_projection_version,p_formula_version,p_source_fingerprint,'complete',p_completeness,p_payload,p_generated_at)
  on conflict (business_id,tax_year,projection_version,source_fingerprint) do nothing
  returning * into result;
  if result.id is null then
    select * into result from public.tax_workspace_projections
    where business_id=p_business_id and tax_year=p_tax_year
      and projection_version=p_projection_version and source_fingerprint=p_source_fingerprint;
  end if;
  return result;
end $$;

create or replace function public.claim_tax_workspace_projection_requests(
  p_worker_id text, p_batch_size integer default 5, p_now timestamptz default now()
) returns setof public.tax_workspace_projection_requests
language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  return query with claimable as (
    select id from public.tax_workspace_projection_requests
    where status in ('pending','failed') and process_after <= p_now
      and attempt_count < max_attempts
      and (locked_at is null or locked_at < p_now - interval '30 minutes')
    order by process_after, created_at for update skip locked
    limit greatest(1, least(coalesce(p_batch_size,5),25))
  ) update public.tax_workspace_projection_requests r
    set status='processing', locked_at=p_now, locked_by=p_worker_id,
        attempt_count=r.attempt_count+1, updated_at=p_now
    from claimable where r.id=claimable.id returning r.*;
end $$;

revoke all on function public.persist_tax_workspace_projection(uuid,integer,text,text,text,text,jsonb,timestamptz) from public, anon, authenticated;
revoke all on function public.claim_tax_workspace_projection_requests(text,integer,timestamptz) from public, anon, authenticated;
grant execute on function public.persist_tax_workspace_projection(uuid,integer,text,text,text,text,jsonb,timestamptz) to service_role;
grant execute on function public.claim_tax_workspace_projection_requests(text,integer,timestamptz) to service_role;
alter function public.persist_tax_workspace_projection(uuid,integer,text,text,text,text,jsonb,timestamptz) owner to postgres;
alter function public.claim_tax_workspace_projection_requests(text,integer,timestamptz) owner to postgres;
