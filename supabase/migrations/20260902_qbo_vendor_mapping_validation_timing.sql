-- Track recent QBO Vendor mapping validation so posting can avoid repeated
-- full Vendor/Customer/Employee list refreshes for already-verified mappings.

alter table public.business_qbo_vendor_mappings
  add column if not exists last_validated_at timestamptz;

create index if not exists business_qbo_vendor_mappings_validation_idx
  on public.business_qbo_vendor_mappings (business_id, qbo_env, realm_id, status, last_validated_at desc);

create or replace function public.upsert_active_qbo_vendor_mapping(
  p_business_id uuid,
  p_realm_id text,
  p_qbo_env text,
  p_canonical_vendor_id uuid,
  p_qbo_vendor_id text,
  p_qbo_display_name text,
  p_mapping_source text default 'resolver',
  p_created_by text default 'bizzi',
  p_mapped_by text default null,
  p_first_transaction_id uuid default null,
  p_metadata jsonb default '{}'::jsonb,
  p_now timestamptz default now()
) returns public.business_qbo_vendor_mappings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.business_qbo_vendor_mappings;
begin
  if p_business_id is null or p_canonical_vendor_id is null then
    raise exception 'missing_vendor_mapping_identity';
  end if;
  if p_realm_id is null or length(trim(p_realm_id)) = 0 then
    raise exception 'missing_qbo_realm_id';
  end if;
  if p_qbo_vendor_id is null or length(trim(p_qbo_vendor_id)) = 0 then
    raise exception 'missing_qbo_vendor_id';
  end if;
  if p_qbo_display_name is null or length(trim(p_qbo_display_name)) = 0 then
    raise exception 'missing_qbo_vendor_display_name';
  end if;

  perform 1
  from public.bizzi_vendors v
  where v.business_id = p_business_id
    and v.id = p_canonical_vendor_id
    and v.status in ('active', 'needs_review');

  if not found then
    raise exception 'canonical_vendor_not_found';
  end if;

  insert into public.business_qbo_vendor_mappings (
    business_id,
    realm_id,
    qbo_env,
    canonical_vendor_id,
    qbo_vendor_id,
    qbo_display_name,
    status,
    mapping_source,
    created_by,
    mapped_by,
    mapped_at,
    last_validated_at,
    first_transaction_id,
    metadata,
    created_at,
    updated_at
  )
  values (
    p_business_id,
    p_realm_id,
    coalesce(p_qbo_env, 'production'),
    p_canonical_vendor_id,
    p_qbo_vendor_id,
    p_qbo_display_name,
    'active',
    coalesce(p_mapping_source, 'resolver'),
    coalesce(p_created_by, 'bizzi'),
    p_mapped_by,
    p_now,
    p_now,
    p_first_transaction_id,
    coalesce(p_metadata, '{}'::jsonb),
    p_now,
    p_now
  )
  on conflict (business_id, qbo_env, realm_id, canonical_vendor_id)
    where status = 'active'
  do update set
    qbo_vendor_id = excluded.qbo_vendor_id,
    qbo_display_name = excluded.qbo_display_name,
    mapping_source = excluded.mapping_source,
    mapped_by = excluded.mapped_by,
    mapped_at = excluded.mapped_at,
    last_validated_at = excluded.last_validated_at,
    first_transaction_id = coalesce(
      public.business_qbo_vendor_mappings.first_transaction_id,
      excluded.first_transaction_id
    ),
    metadata = coalesce(public.business_qbo_vendor_mappings.metadata, '{}'::jsonb) ||
      coalesce(excluded.metadata, '{}'::jsonb),
    updated_at = excluded.updated_at
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.upsert_active_qbo_vendor_mapping(uuid, text, text, uuid, text, text, text, text, text, uuid, jsonb, timestamptz) from public;
revoke all on function public.upsert_active_qbo_vendor_mapping(uuid, text, text, uuid, text, text, text, text, text, uuid, jsonb, timestamptz) from anon;
revoke all on function public.upsert_active_qbo_vendor_mapping(uuid, text, text, uuid, text, text, text, text, text, uuid, jsonb, timestamptz) from authenticated;
grant execute on function public.upsert_active_qbo_vendor_mapping(uuid, text, text, uuid, text, text, text, text, text, uuid, jsonb, timestamptz) to service_role;
